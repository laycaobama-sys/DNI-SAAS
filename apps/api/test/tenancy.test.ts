import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createHarness, html } from "./helpers";

const SITE = {
  "https://tienda-a.es/": { body: html({ title: "Tienda A | Zapatillas", desc: "Tienda A vende zapatillas de running con envío en 24 horas a toda España.", h1: "Zapatillas" }) },
  "https://tienda-a.es/robots.txt": { body: "User-agent: *\nAllow: /", type: "text/plain" },
};

async function twoTenants() {
  const h = createHarness({ site: SITE });
  const alice = await h.signup("alice@a.es", "Alice");
  const bob = await h.signup("bob@b.es", "Bob");
  const orgA = await h.createOrg(alice, "Org A");
  const orgB = await h.createOrg(bob, "Org B");
  const a = await alice.post(`/api/v1/orgs/${orgA}/sites/analyze`, { url: "https://tienda-a.es" });
  expect(a.status).toBe(202);
  await h.drain();
  const job = (await alice.get(`/api/v1/orgs/${orgA}/jobs/${a.json.jobId}`)).json.job;
  expect(job.state).toBe("completed");
  return { h, alice, bob, orgA, orgB, jobA: a.json.jobId as string, brandA: a.json.brandId as string, crawlA: job.output.crawlId as string, planA: job.output.planId as string };
}

describe("Tenant isolation (IDOR)", () => {
  it("Bob cannot read or mutate anything of Org A — through his own org path or Org A's", async () => {
    const { h, bob, alice, orgA, orgB, jobA, brandA, crawlA, planA } = await twoTenants();
    const taskA = (await alice.get(`/api/v1/orgs/${orgA}/plans/${planA}`)).json.tasks[0].id;
    const memberA = (await alice.get(`/api/v1/orgs/${orgA}/members`)).json.members[0].id;

    // 1) Direct access to Org A paths → 404 (no existence leak).
    const direct = [
      ["GET", `/api/v1/orgs/${orgA}`],
      ["GET", `/api/v1/orgs/${orgA}/dashboard`],
      ["GET", `/api/v1/orgs/${orgA}/members`],
      ["GET", `/api/v1/orgs/${orgA}/jobs/${jobA}`],
      ["GET", `/api/v1/orgs/${orgA}/crawls/${crawlA}`],
      ["GET", `/api/v1/orgs/${orgA}/brands/${brandA}/profile`],
      ["GET", `/api/v1/orgs/${orgA}/plans/${planA}`],
      ["GET", `/api/v1/orgs/${orgA}/plans/${planA}/export`],
      ["GET", `/api/v1/orgs/${orgA}/billing`],
      ["GET", `/api/v1/orgs/${orgA}/audit-logs`],
      ["POST", `/api/v1/orgs/${orgA}/sites/analyze`],
      ["POST", `/api/v1/orgs/${orgA}/invitations`],
      ["PATCH", `/api/v1/orgs/${orgA}/members/${memberA}`],
    ] as const;
    for (const [m, p] of direct) {
      const r = await bob.req(m, p, m === "GET" ? undefined : { url: "https://x.es", email: "z@z.es", role: "owner" });
      expect(r.status, `${m} ${p}`).toBe(404);
    }

    // 2) Org A object IDs through Bob's own org path → 404 (queries are scoped by organization_id).
    const viaOwn = [
      `/api/v1/orgs/${orgB}/jobs/${jobA}`,
      `/api/v1/orgs/${orgB}/crawls/${crawlA}`,
      `/api/v1/orgs/${orgB}/brands/${brandA}/profile`,
      `/api/v1/orgs/${orgB}/plans/${planA}`,
      `/api/v1/orgs/${orgB}/plans/${planA}/export`,
    ];
    for (const p of viaOwn) expect((await bob.get(p)).status, p).toBe(404);
    expect((await bob.patch(`/api/v1/orgs/${orgB}/plans/${planA}/tasks/${taskA}`, { status: "done" })).status).toBe(404);
    expect((await bob.post(`/api/v1/orgs/${orgB}/jobs/${jobA}/cancel`)).status).toBe(404);
    expect((await bob.put(`/api/v1/orgs/${orgB}/brands/${brandA}/profile`, { facts: [] })).status).toBe(404);
    expect((await bob.patch(`/api/v1/orgs/${orgB}/members/${memberA}`, { role: "client_viewer" })).status).toBe(404);
    // Using Org A's brand when starting an analysis in Org B is rejected.
    expect((await bob.post(`/api/v1/orgs/${orgB}/sites/analyze`, { url: "https://tienda-a.es", brandId: brandA })).status).toBe(404);

    // 3) Bob's lists never contain Org A data.
    expect((await bob.get(`/api/v1/orgs/${orgB}/jobs`)).json.items).toEqual([]);
    expect((await bob.get(`/api/v1/orgs/${orgB}/crawls`)).json.items).toEqual([]);
    expect((await bob.get(`/api/v1/orgs/${orgB}/brands`)).json.items).toEqual([]);
    expect((await bob.get("/api/v1/auth/me")).json.memberships.map((m: { id: string }) => m.id)).toEqual([orgB]);

    // Nothing in Org A changed.
    const task = (await alice.get(`/api/v1/orgs/${orgA}/plans/${planA}`)).json.tasks[0];
    expect(task.status).not.toBe("done");
    void h;
  });

  it("malformed / guessed IDs are 404, unauthenticated is 401", async () => {
    const { h, bob, orgA } = await twoTenants();
    expect((await bob.get(`/api/v1/orgs/not-a-uuid`)).status).toBe(404);
    expect((await bob.get(`/api/v1/orgs/${crypto.randomUUID()}/dashboard`)).status).toBe(404);
    expect((await new h.Client().get(`/api/v1/orgs/${orgA}/dashboard`)).status).toBe(401);
  });

  it("the DATABASE rejects cross-tenant foreign keys even if the app layer were bypassed", async () => {
    const { h, orgB, brandA } = await twoTenants();
    expect(() =>
      h.db.raw.prepare("INSERT INTO sites (id, organization_id, brand_id, url, origin) VALUES (?, ?, ?, ?, ?)").run(crypto.randomUUID(), orgB, brandA, "https://x.es/", "https://x.es"),
    ).toThrow(/FOREIGN KEY/);
    expect(() =>
      h.db.raw.prepare("INSERT INTO brand_profiles (id, organization_id, brand_id) VALUES (?, ?, ?)").run(crypto.randomUUID(), orgB, brandA),
    ).toThrow(/FOREIGN KEY/);
  });

  it("audit log and credit ledger are append-only", async () => {
    const { h, orgA } = await twoTenants();
    expect(() => h.db.raw.exec(`UPDATE audit_logs SET action = 'x' WHERE organization_id = '${orgA}'`)).toThrow(/append-only/);
    expect(() => h.db.raw.exec(`DELETE FROM audit_logs WHERE organization_id = '${orgA}'`)).toThrow(/append-only/);
    expect(() => h.db.raw.exec(`UPDATE credit_ledger SET amount = 999999 WHERE organization_id = '${orgA}'`)).toThrow(/append-only/);
    expect(() => h.db.raw.exec(`DELETE FROM credit_ledger WHERE organization_id = '${orgA}'`)).toThrow(/append-only/);
  });
});

describe("RBAC", () => {
  it("a client viewer can read but cannot analyze, invite, edit brand, confirm, change tasks or manage billing", async () => {
    const { h, alice, orgA, brandA, planA } = await twoTenants();
    await alice.post(`/api/v1/orgs/${orgA}/invitations`, { email: "viewer@a.es", role: "client_viewer" }).catch(() => null);
    // Free plan has 1 seat: upgrade the org directly to allow a second member for this test.
    await h.db.prepare("UPDATE organizations SET plan_code = 'growth' WHERE id = ?").bind(orgA).run();
    const viewer = await h.invite(alice, orgA, "viewer2@a.es", "client_viewer");
    const taskId = (await viewer.get(`/api/v1/orgs/${orgA}/plans/${planA}`)).json.tasks[0].id;
    expect((await viewer.get(`/api/v1/orgs/${orgA}/dashboard`)).status).toBe(200);
    const denied = [
      viewer.post(`/api/v1/orgs/${orgA}/sites/analyze`, { url: "https://tienda-a.es" }),
      viewer.post(`/api/v1/orgs/${orgA}/invitations`, { email: "z@a.es", role: "client_viewer" }),
      viewer.put(`/api/v1/orgs/${orgA}/brands/${brandA}/profile`, { facts: [] }),
      viewer.post(`/api/v1/orgs/${orgA}/brands/${brandA}/profile/confirm`),
      viewer.patch(`/api/v1/orgs/${orgA}/plans/${planA}/tasks/${taskId}`, { status: "done" }),
      viewer.post(`/api/v1/orgs/${orgA}/billing/checkout`, { planCode: "pro" }),
      viewer.get(`/api/v1/orgs/${orgA}/billing`),
      viewer.get(`/api/v1/orgs/${orgA}/audit-logs`),
    ];
    for (const r of await Promise.all(denied)) expect(r.status).toBe(403);
  });

  it("prevents privilege escalation and removing the last owner", async () => {
    const { h, alice, orgA } = await twoTenants();
    await h.db.prepare("UPDATE organizations SET plan_code = 'growth' WHERE id = ?").bind(orgA).run();
    const admin = await h.invite(alice, orgA, "admin@a.es", "admin");
    expect((await admin.post(`/api/v1/orgs/${orgA}/invitations`, { email: "o@a.es", role: "owner" })).status).toBe(403);
    expect((await admin.post(`/api/v1/orgs/${orgA}/invitations`, { email: "o@a.es", role: "admin" })).status).toBe(403);
    const members = (await alice.get(`/api/v1/orgs/${orgA}/members`)).json.members;
    const ownerM = members.find((m: { role: string }) => m.role === "owner");
    expect((await admin.del(`/api/v1/orgs/${orgA}/members/${ownerM.id}`)).status).toBe(403);
    expect((await alice.patch(`/api/v1/orgs/${orgA}/members/${ownerM.id}`, { role: "admin" })).json.code).toBe("last_owner");
  });

  it("an invitation link cannot be redeemed by a different account", async () => {
    const { h, alice, orgA } = await twoTenants();
    await h.db.prepare("UPDATE organizations SET plan_code = 'growth' WHERE id = ?").bind(orgA).run();
    await alice.post(`/api/v1/orgs/${orgA}/invitations`, { email: "invited@a.es", role: "editor" });
    const token = await h.latestToken("invited@a.es", "invite");
    const mallory = await h.signup("mallory@evil.es");
    expect((await mallory.post("/api/v1/invitations/accept", { token })).status).toBe(403);
  });
});

describe("Static SQL guard", () => {
  it("every query touching a tenant table filters or writes organization_id", () => {
    const tenantTables = ["brands", "brand_profiles", "sites", "integrations", "jobs", "job_events", "web_crawls", "crawl_pages", "seo_issues", "growth_plans", "growth_tasks", "invitations", "credit_ledger", "ai_conversations", "ai_messages", "ai_images"];
    const srcDir = join(import.meta.dirname, "..", "src");
    const files: string[] = [];
    const walk = (d: string) => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        if (e.isDirectory()) walk(join(d, e.name));
        else if (e.name.endsWith(".ts")) files.push(join(d, e.name));
      }
    };
    walk(srcDir);
    const offenders: string[] = [];
    // Justified exceptions: background recovery scans every tenant by design (no user input).
    const allow = [/FROM jobs WHERE state = 'running' AND started_at < \?/];
    for (const f of files) {
      const src = readFileSync(f, "utf8");
      const sqls = src.match(/`[^`]*`|"(?:SELECT|INSERT|UPDATE|DELETE)[^"]*"/g) ?? [];
      for (const s of sqls) {
        if (!/\b(SELECT|INSERT|UPDATE|DELETE)\b/.test(s)) continue;
        const touches = tenantTables.some((t) => new RegExp(`\\b(FROM|JOIN|INTO|UPDATE)\\s+${t}\\b`).test(s));
        if (touches && !/organization_id/.test(s) && !allow.some((a) => a.test(s))) offenders.push(`${f.split("src")[1]}: ${s.slice(0, 120)}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
