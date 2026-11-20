/**
 * Test harness: a D1-compatible adapter over Node's built-in SQLite (same engine as D1),
 * real migrations, the real Hono app, and injectable network fakes (fetch + DNS).
 */
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createApp } from "../src/app";
import type { Deps, Env } from "../src/env";

type Row = Record<string, unknown>;

function norm(params: unknown[]): SQLInputValue[] {
  return params.map((p) => {
    if (p === undefined) throw new Error("D1_TYPE_ERROR: undefined bound");
    if (typeof p === "boolean") return p ? 1 : 0;
    return p as SQLInputValue;
  });
}

class Stmt {
  constructor(
    private readonly db: DatabaseSync,
    readonly sql: string,
    private readonly params: unknown[] = [],
  ) {}
  bind(...params: unknown[]) {
    return new Stmt(this.db, this.sql, params);
  }
  private exec(): { rows: Row[]; changes: number; lastId: number } {
    const st = this.db.prepare(this.sql);
    if (/\breturning\b/i.test(this.sql) || /^\s*(select|with|pragma)/i.test(this.sql)) {
      const before = (this.db.prepare("SELECT total_changes() AS t").get() as { t: number }).t;
      const rows = st.all(...norm(this.params)) as Row[];
      const after = (this.db.prepare("SELECT total_changes() AS t").get() as { t: number }).t;
      return { rows: rows.map((r) => ({ ...r })), changes: after - before, lastId: 0 };
    }
    const r = st.run(...norm(this.params));
    return { rows: [], changes: Number(r.changes), lastId: Number(r.lastInsertRowid) };
  }
  async first<T = Row>(col?: string): Promise<T | null> {
    const row = this.exec().rows[0];
    if (!row) return null;
    return (col ? row[col] : row) as T;
  }
  async all<T = Row>() {
    const r = this.exec();
    return { results: r.rows as T[], success: true, meta: { changes: r.changes, last_row_id: r.lastId } };
  }
  async run() {
    const r = this.exec();
    return { results: r.rows, success: true, meta: { changes: r.changes, last_row_id: r.lastId } };
  }
  runSync() {
    return this.exec();
  }
}

export class TestD1 {
  readonly raw: DatabaseSync;
  constructor() {
    this.raw = new DatabaseSync(":memory:");
    this.raw.exec("PRAGMA foreign_keys = ON;");
    const dir = join(import.meta.dirname, "..", "migrations");
    for (const f of readdirSync(dir).filter((x) => x.endsWith(".sql")).sort()) this.raw.exec(readFileSync(join(dir, f), "utf8"));
  }
  prepare(sql: string) {
    return new Stmt(this.raw, sql);
  }
  async batch(stmts: Stmt[]) {
    this.raw.exec("BEGIN");
    try {
      const out = stmts.map((s) => {
        const r = s.runSync();
        return { results: r.rows, success: true, meta: { changes: r.changes, last_row_id: r.lastId } };
      });
      this.raw.exec("COMMIT");
      return out;
    } catch (e) {
      this.raw.exec("ROLLBACK");
      throw e;
    }
  }
  async exec(sql: string) {
    this.raw.exec(sql);
    return { count: 0, duration: 0 };
  }
}

export type FakeRoute = { status?: number; body?: string; type?: string; location?: string; delayMs?: number; throws?: boolean };

export function createHarness(opts: { site?: Record<string, FakeRoute>; dns?: Record<string, string[]> } = {}) {
  const db = new TestD1();
  const site = opts.site ?? {};
  const dns = opts.dns ?? {};
  const fetchLog: string[] = [];
  const deps: Deps = {
    fetchImpl: (async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      fetchLog.push(url);
      const r = site[url];
      if (!r) return new Response("not found", { status: 404, headers: { "content-type": "text/html" } });
      if (r.throws) throw new Error("ECONNRESET simulated");
      return new Response(r.body ?? "", {
        status: r.status ?? 200,
        headers: { "content-type": r.type ?? "text/html; charset=utf-8", ...(r.location ? { location: r.location } : {}) },
      });
    }) as typeof fetch,
    resolve: async (host) => dns[host] ?? ["93.184.216.34"],
    sleep: async () => {},
  };
  const env: Env = { DB: db as unknown as D1Database, ENVIRONMENT: "test", APP_ORIGIN: "http://localhost:8787" };
  const app = createApp(deps);
  const pending: Promise<unknown>[] = [];
  const ctx = { waitUntil: (p: Promise<unknown>) => void pending.push(p), passThroughOnException: () => {}, props: {} } as unknown as ExecutionContext;

  async function drain() {
    while (pending.length) await pending.shift();
  }

  class Client {
    cookie = "";
    async req(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
      const res = await app.request(
        path,
        {
          method,
          headers: {
            ...(body !== undefined ? { "content-type": "application/json" } : {}),
            ...(method !== "GET" ? { "x-dni-csrf": "1" } : {}),
            ...(this.cookie ? { cookie: this.cookie } : {}),
            "cf-connecting-ip": "203.0.113.7",
            ...headers,
          },
          body: body !== undefined ? JSON.stringify(body) : undefined,
        },
        env,
        ctx,
      );
      const set = res.headers.get("set-cookie");
      if (set) {
        const m = set.match(/dni_session=([^;]*)/);
        if (m) this.cookie = m[1] ? `dni_session=${m[1]}` : "";
      }
      const text = await res.text();
      let json: any;
      try {
        json = JSON.parse(text);
      } catch {
        json = text;
      }
      return { status: res.status, json, headers: res.headers };
    }
    get = (p: string) => this.req("GET", p);
    post = (p: string, b?: unknown, h?: Record<string, string>) => this.req("POST", p, b ?? {}, h);
    put = (p: string, b?: unknown) => this.req("PUT", p, b ?? {});
    patch = (p: string, b?: unknown) => this.req("PATCH", p, b ?? {});
    del = (p: string) => this.req("DELETE", p);
  }

  /** Registers + verifies (through the dev mailbox) + logs in a user. */
  async function signup(email: string, name = "Test User", password = "Sup3rSecretPass") {
    const c = new Client();
    const r = await c.post("/api/v1/auth/register", { email, password, name });
    if (r.status !== 202) throw new Error(`register failed ${r.status} ${JSON.stringify(r.json)}`);
    const token = await latestToken(email, "verify");
    const v = await c.post("/api/v1/auth/verify-email", { token });
    if (v.status !== 200) throw new Error(`verify failed ${v.status}`);
    const l = await c.post("/api/v1/auth/login", { email, password });
    if (l.status !== 200) throw new Error(`login failed ${l.status} ${JSON.stringify(l.json)}`);
    return c;
  }

  async function latestToken(email: string, kind: "verify" | "reset" | "invite") {
    const row = await db.prepare("SELECT body FROM dev_mailbox WHERE to_email = ? ORDER BY created_at DESC, rowid DESC LIMIT 1").bind(email.toLowerCase()).first<{ body: string }>();
    const re = kind === "verify" ? /verify\?token=([0-9a-f]{64})/ : kind === "reset" ? /reset\?token=([0-9a-f]{64})/ : /invite\?token=([0-9a-f]{64})/;
    const m = row?.body.match(re);
    if (!m) throw new Error(`no ${kind} token for ${email}`);
    return m[1]!;
  }

  /** New organisation (plan «free» unless a plan is given, e.g. to reach a module that a paid plan unlocks). */
  async function createOrg(c: Client, name: string, plan?: string): Promise<string> {
    const r = await c.post("/api/v1/orgs", { name });
    if (r.status !== 201) throw new Error(`org create failed ${r.status} ${JSON.stringify(r.json)}`);
    if (plan) await db.prepare("UPDATE organizations SET plan_code = ? WHERE id = ?").bind(plan, r.json.id).run();
    return r.json.id as string;
  }

  async function invite(owner: Client, orgId: string, email: string, role: string) {
    const r = await owner.post(`/api/v1/orgs/${orgId}/invitations`, { email, role });
    if (r.status !== 201) throw new Error(`invite failed ${r.status} ${JSON.stringify(r.json)}`);
    const token = await latestToken(email, "invite");
    const member = await signup(email);
    const a = await member.post("/api/v1/invitations/accept", { token });
    if (a.status !== 200) throw new Error(`accept failed ${a.status}`);
    return member;
  }

  return { db, env, app, deps, ctx, drain, Client, signup, latestToken, createOrg, invite, fetchLog };
}

export const html = (o: { title?: string; desc?: string; h1?: string; links?: string[]; extraHead?: string; body?: string; lang?: string }) =>
  `<!doctype html><html${o.lang === undefined ? ' lang="es"' : o.lang ? ` lang="${o.lang}"` : ""}><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
${o.title ? `<title>${o.title}</title>` : ""}${o.desc ? `<meta name="description" content="${o.desc}">` : ""}${o.extraHead ?? ""}</head>
<body>${o.h1 ? `<h1>${o.h1}</h1>` : ""}${(o.links ?? []).map((l) => `<a href="${l}">${l}</a>`).join("")}${o.body ?? `<p>${"Contenido real del negocio con información útil. ".repeat(30)}</p>`}</body></html>`;

// ── Platform owner (Control Center) test helpers ─────────────────────────────────────────────────────
export const TEST_ENC_KEY = "a".repeat(64);
type Harness = ReturnType<typeof createHarness>;
type Cl = InstanceType<Harness["Client"]>;

/** Current TOTP code for a base32 secret, `offset` steps from now (+1 = next 30 s window). */
export async function totpNow(secret: string, offset = 0): Promise<string> {
  const { base32Decode, hotp, totpStep } = await import("@dni/core");
  return hotp(base32Decode(secret), totpStep(Date.now()) + offset);
}

/** Inserts a one-time claim code like scripts/platform-claim.mjs does (only its hash is stored). */
export async function insertClaimCode(h: Harness, code: string, role = "platform_owner", expiresInMs = 30 * 60_000) {
  const { sha256Hex } = await import("@dni/core");
  await h.db.prepare("INSERT INTO platform_claim_codes (code_hash, role, expires_at) VALUES (?, ?, ?)").bind(await sha256Hex(code), role, new Date(Date.now() + expiresInMs).toISOString()).run();
}

/** Claims the platform owner role for `c` and enrols TOTP. Returns the secret and recovery codes. */
export async function claimPlatformOwner(h: Harness, c: Cl, code = "TEST1-CLAIM-CODE2-ABCDE") {
  h.env.DATA_ENC_KEY ??= TEST_ENC_KEY;
  await insertClaimCode(h, code);
  const claim = await c.post("/api/v1/platform/claim", { code });
  if (claim.status !== 200) throw new Error(`claim failed ${claim.status} ${JSON.stringify(claim.json)}`);
  const secret = claim.json.secret as string;
  const conf = await c.post("/api/v1/platform/mfa/confirm", { code: await totpNow(secret) });
  if (conf.status !== 200) throw new Error(`mfa confirm failed ${conf.status} ${JSON.stringify(conf.json)}`);
  return { secret, recoveryCodes: conf.json.recoveryCodes as string[] };
}
