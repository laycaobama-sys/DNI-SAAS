import { DatabaseSync } from "node:sqlite";
import { gunzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { canonicalRedirect } from "../src/app";
import { dailyBackup } from "../src/lib/backup";
import { runStatusChecks } from "../src/lib/status";
import { createHarness } from "./helpers";

function fakeR2() {
  const store = new Map<string, Uint8Array>();
  const bucket = {
    put: async (k: string, v: Uint8Array) => void store.set(k, v),
    get: async (k: string) => (store.has(k) ? { body: store.get(k) } : null),
    delete: async (k: string) => void store.delete(k),
  } as unknown as R2Bucket;
  return { store, bucket };
}

describe("daily database backup (B2.7)", () => {
  it("writes a gzip SQL dump to R2 that restores into an empty database with the same rows", async () => {
    const h = createHarness();
    await h.signup("owner@dnigrowth.test", "Titular");
    await h.db.prepare("INSERT INTO platform_settings (k, v, updated_at) VALUES ('nota', 'con ''comillas'' y ñ', '2026-01-01')").run();
    const { store, bucket } = fakeR2();
    h.env.MEDIA = bucket;
    const r = await dailyBackup(h.env, { force: true, now: new Date("2026-11-25T03:00:00Z") });
    expect(r.created).toBe("backups/db/2026-11-25.sql.gz");
    const sql = gunzipSync(store.get(r.created!)!).toString("utf8");
    expect(sql).toContain("PRAGMA defer_foreign_keys = TRUE;");

    // Restore test: the dump alone rebuilds the schema and the data.
    const restored = new DatabaseSync(":memory:");
    // Same as `wrangler d1 execute --file`: one transaction, so deferred foreign keys are checked at the end.
    restored.exec(`BEGIN;
${sql}COMMIT;`);
    const count = (db: { prepare(s: string): { get(): unknown } }, t: string) => (db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n;
    for (const t of ["users", "platform_settings", "organizations"]) {
      expect(count(restored, t)).toBe(Number(await h.db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).first("n")));
    }
    expect((restored.prepare("SELECT v FROM platform_settings WHERE k = 'nota'").get() as { v: string }).v).toBe("con 'comillas' y ñ");
    const row = await h.db.prepare("SELECT tables, rows_total, sha256 FROM db_backups WHERE r2_key = ?").bind(r.created).first<{ tables: number; rows_total: number; sha256: string }>();
    expect(row!.tables).toBeGreaterThan(20);
    expect(row!.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("runs once a day from 02:00 UTC and deletes copies older than 30 days", async () => {
    const h = createHarness();
    const { store, bucket } = fakeR2();
    h.env.MEDIA = bucket;
    expect((await dailyBackup(h.env, { now: new Date("2026-11-25T01:30:00Z") })).created).toBeNull();
    expect((await dailyBackup(h.env, { now: new Date("2026-11-25T02:01:00Z") })).created).toBe("backups/db/2026-11-25.sql.gz");
    expect((await dailyBackup(h.env, { now: new Date("2026-11-25T09:00:00Z") })).created).toBeNull();
    // An old copy (40 days) is removed from R2 and marked deleted; foreign keys outside the prefix are never touched.
    store.set("backups/db/2026-10-16.sql.gz", new Uint8Array([1]));
    await h.db.prepare("INSERT INTO db_backups (id, r2_key, tables, rows_total, bytes, sha256, created_at) VALUES ('old', 'backups/db/2026-10-16.sql.gz', 1, 1, 1, 'x', '2026-10-16T03:00:00.000Z')").run();
    store.set("media/otro/archivo.png", new Uint8Array([1]));
    await h.db.prepare("INSERT INTO db_backups (id, r2_key, tables, rows_total, bytes, sha256, created_at) VALUES ('raro', 'media/otro/archivo.png', 1, 1, 1, 'x', '2026-10-01T03:00:00.000Z')").run();
    const r = await dailyBackup(h.env, { now: new Date("2026-11-26T02:05:00Z") });
    expect(r.created).toBe("backups/db/2026-11-26.sql.gz");
    expect(store.has("backups/db/2026-10-16.sql.gz")).toBe(false);
    expect(store.has("media/otro/archivo.png")).toBe(true);
    expect(await h.db.prepare("SELECT deleted_at IS NOT NULL AS d FROM db_backups WHERE id = 'old'").first("d")).toBe(1);
  });

  it("does nothing without the R2 bucket", async () => {
    const h = createHarness();
    expect(await dailyBackup(h.env, { force: true })).toEqual({ created: null, deleted: 0 });
  });
});

describe("/estado (B2.6)", () => {
  it("records real checks, throttles to every 5 minutes and serves the public page and JSON", async () => {
    const h = createHarness();
    expect(await runStatusChecks(h.env, h.deps, { force: true })).toBe(8);
    expect(await runStatusChecks(h.env, h.deps)).toBe(0);
    const rows = await h.db.prepare("SELECT check_key, ok FROM status_checks").all<{ check_key: string; ok: number }>();
    const by = Object.fromEntries(rows.results.map((r) => [r.check_key, r.ok]));
    expect(by.api).toBe(1);
    expect(by.jobs).toBe(1);
    expect(by.payments).toBe(1);
    expect(by.email).toBe(1);
    expect(by.backup).toBe(0); // no backup exists yet: reported honestly as a failure

    const anon = new h.Client();
    const page = await anon.get("/estado");
    expect(page.status).toBe(200);
    expect(String(page.json)).toContain("Estado del servicio");
    expect(String(page.json)).toContain("Copias de seguridad");
    expect(String(page.json)).not.toMatch(/@dnigrowth\.test/);
    const api = await anon.get("/api/v1/public/status");
    expect(api.status).toBe(200);
    expect(api.json.checks).toHaveLength(9); // «meta» shows without data where Meta is not set up
    expect(api.json.measurement.type).toBe("observed");
    expect(api.json.allOk).toBe(false);
    const canon = new URL("https://dnigrowth.com");
    expect(canonicalRedirect(new URL("https://dnigrowth.com/estado/"), canon)).toBe("https://dnigrowth.com/estado");
    expect(canonicalRedirect(new URL("https://dnigrowth.com/estado"), canon)).toBeNull();
  });

  it("checks with Meta that the app credentials are valid, without storing the token", async () => {
    const h = createHarness();
    const env = { ...h.env, META_APP_ID: "123", META_APP_SECRET: "s3cret-for-test" };
    let reply = { access_token: "123|app-token-value" } as Record<string, unknown>;
    let sent = "";
    const site = h.deps.fetchImpl;
    h.deps.fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("graph.facebook.com") && url.endsWith("/oauth/access_token")) {
        sent = String(init?.body ?? "");
        return new Response(JSON.stringify(reply), { status: "access_token" in reply ? 200 : 400, headers: { "content-type": "application/json" } });
      }
      return site(input, init);
    }) as typeof fetch;
    await runStatusChecks(env, h.deps, { force: true });
    expect(sent).toContain("grant_type=client_credentials");
    let row = await h.db.prepare("SELECT ok, detail FROM status_checks WHERE check_key = 'meta'").first<{ ok: number; detail: string }>();
    expect(row).toMatchObject({ ok: 1 });
    expect(row!.detail).not.toContain("app-token-value");
    reply = { error: { code: 101, message: "Error validating client secret." } };
    await h.db.prepare("DELETE FROM status_checks").run();
    await runStatusChecks(env, h.deps, { force: true });
    row = await h.db.prepare("SELECT ok, detail FROM status_checks WHERE check_key = 'meta'").first<{ ok: number; detail: string }>();
    expect(row).toMatchObject({ ok: 0 });
    expect(row!.detail).toContain("101");
  });

  it("alerts the platform owners after two failures in a row and once on recovery", async () => {
    const h = createHarness();
    await h.signup("admin@dnigrowth.test", "Admin");
    await h.signup("cliente@dnigrowth.test", "Cliente");
    await h.db.prepare("INSERT INTO platform_members (user_id, role, status) SELECT id, 'platform_owner', 'active' FROM users WHERE email = 'admin@dnigrowth.test'").run();
    const alerts = async () => (await h.db.prepare("SELECT COUNT(*) AS n FROM email_outbox WHERE kind = 'notification'").first<number>("n")) ?? 0;
    await runStatusChecks(h.env, h.deps, { force: true });
    expect(await alerts()).toBe(0); // one failure is not an incident yet
    await runStatusChecks(h.env, h.deps, { force: true });
    const afterDown = await alerts();
    expect(afterDown).toBeGreaterThanOrEqual(1);
    // Only the platform owner is alerted, never a customer.
    expect(await h.db.prepare("SELECT COUNT(*) AS n FROM email_outbox WHERE kind = 'notification' AND to_masked NOT LIKE 'a%'").first("n")).toBe(0);
    await runStatusChecks(h.env, h.deps, { force: true });
    expect(await alerts()).toBe(afterDown); // no repeated emails while it stays down
    // The backup appears: the check recovers and one "resuelto" email goes out.
    await h.db.prepare("INSERT INTO db_backups (id, r2_key, tables, rows_total, bytes, sha256, created_at) VALUES ('b', 'backups/db/x.sql.gz', 1, 1, 1, 'x', ?)").bind(new Date().toISOString()).run();
    await runStatusChecks(h.env, h.deps, { force: true });
    expect(await alerts()).toBe(afterDown + 1);
  });
});
