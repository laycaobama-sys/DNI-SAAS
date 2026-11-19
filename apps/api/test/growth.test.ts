/**
 * F2 SEO técnico / keywords / backlinks · F5 rule engine + signed webhooks · F7 attribution ·
 * F6 ads drafts + Spend Guardian · F4 video projects + media · F8 agency, white label, entitlements.
 */
import { describe, expect, it } from "vitest";
import { deliverWebhooks, scanOverdueTasks, WEBHOOK_BACKOFF_SECONDS } from "../src/lib/rules";
import { createHarness, html, type FakeRoute } from "./helpers";

async function setup(site: Record<string, FakeRoute> = {}, plan = "growth") {
  const h = createHarness({ site, dns: { "intranet.example": ["10.0.0.5"] } });
  const owner = await h.signup("owner@luna.es", "Olga");
  const orgId = await h.createOrg(owner, "Panadería Luna");
  await h.db.prepare("UPDATE organizations SET plan_code = ? WHERE id = ?").bind(plan, orgId).run();
  const O = `/api/v1/orgs/${orgId}`;
  return { h, owner, orgId, O };
}

async function crawl(h: ReturnType<typeof createHarness>, orgId: string, health: number, issues: Array<[string, string]>, siteId?: string, started = new Date().toISOString()) {
  let sid = siteId;
  if (!sid) {
    const brandId = crypto.randomUUID();
    await h.db.prepare("INSERT INTO brands (id, organization_id, name) VALUES (?, ?, 'Luna')").bind(brandId, orgId).run();
    sid = crypto.randomUUID();
    await h.db.prepare("INSERT INTO sites (id, organization_id, brand_id, url, origin) VALUES (?, ?, ?, 'https://luna.es/', 'https://luna.es')").bind(sid, orgId, brandId).run();
  }
  const jobId = crypto.randomUUID();
  const id = crypto.randomUUID();
  await h.db.prepare("INSERT INTO jobs (id, organization_id, kind, state, idempotency_key) VALUES (?, ?, 'analyze_url', 'completed', ?)").bind(jobId, orgId, jobId).run();
  await h.db.prepare("INSERT INTO web_crawls (id, organization_id, site_id, job_id, status, pages_limit, health_score, started_at, completed_at) VALUES (?, ?, ?, ?, 'completed', 10, ?, ?, ?)").bind(id, orgId, sid, jobId, health, started, started).run();
  for (const [rule, url] of issues)
    await h.db.prepare("INSERT INTO seo_issues (id, organization_id, crawl_id, url, rule_key, severity, category, priority_score) VALUES (?, ?, ?, ?, ?, 'high', 'onpage', 50)").bind(crypto.randomUUID(), orgId, id, url, rule).run();
  await h.db.prepare("INSERT INTO crawl_pages (id, organization_id, crawl_id, url, final_url, status_code, title, description, h1) VALUES (?, ?, ?, 'https://luna.es/', 'https://luna.es/', 200, 'Pan de masa madre en Madrid', 'Panadería artesana', 'Pan artesano')").bind(crypto.randomUUID(), orgId, id).run();
  return { id, siteId: sid };
}

describe("SEO técnico", () => {
  it("compares two audits (new / resolved / health delta), updates issue status and exports CSV", async () => {
    const { h, owner, orgId, O } = await setup();
    const a = await crawl(h, orgId, 60, [["missing_title", "https://luna.es/a"], ["missing_h1", "https://luna.es/b"]], undefined, "2026-11-01T00:00:00.000Z");
    const b = await crawl(h, orgId, 75, [["missing_h1", "https://luna.es/b"], ["thin_content", "https://luna.es/c"]], a.siteId);
    const ov = (await owner.get(`${O}/seo/overview`)).json;
    expect(ov.sites[0].crawls).toHaveLength(2);
    const cmp = (await owner.get(`${O}/seo/compare?crawlId=${b.id}&baseId=${a.id}`)).json;
    expect(cmp.healthDelta).toBe(15);
    expect(cmp.newIssues.map((i: any) => i.rule_key)).toEqual(["thin_content"]);
    expect(cmp.resolved.map((i: any) => i.rule_key)).toEqual(["missing_title"]);
    expect(cmp.persisting).toBe(1);
    const issue = await h.db.prepare("SELECT id FROM seo_issues WHERE organization_id = ? AND crawl_id = ? AND rule_key = 'thin_content'").bind(orgId, b.id).first<{ id: string }>();
    expect((await owner.patch(`${O}/seo/issues/${issue!.id}`, { status: "fixed" })).status).toBe(200);
    const csv = await owner.get(`${O}/seo/issues.csv?crawlId=${b.id}`);
    expect(csv.headers.get("content-type")).toContain("text/csv");
    expect(String(csv.json)).toMatch(/thin_content.*fixed/);
    // Another tenant cannot read or modify it.
    const eve = await h.signup("eve@x.es", "Eve");
    const evil = await h.createOrg(eve, "Evil");
    expect((await eve.patch(`/api/v1/orgs/${evil}/seo/issues/${issue!.id}`, { status: "ignored" })).status).toBe(404);
    expect((await eve.get(`/api/v1/orgs/${evil}/seo/compare?crawlId=${b.id}&baseId=${a.id}`)).status).toBe(404);
  });
});

describe("Keywords y competencia", () => {
  const competitor = "https://rival.es/pan";
  const site = {
    "https://rival.es/robots.txt": { body: "User-agent: *\nDisallow: /privado", type: "text/plain" },
    [competitor]: { body: html({ title: "Pan sin gluten y bollería vegana", h1: "Pan sin gluten", body: "<h2>Bollería vegana</h2><h2>Pan sin gluten artesanal</h2><p>pan sin gluten pan sin gluten bollería vegana</p>" }) },
  };
  it("never invents volumes, saves keywords once and analyses a public competitor page with content gap", async () => {
    const { h, owner, orgId, O } = await setup(site);
    await crawl(h, orgId, 70, []);
    const ov = (await owner.get(`${O}/keywords/overview`)).json;
    expect(ov.gsc.connected).toBe(false);
    expect(ov.unavailable).toContain("Volumen de búsqueda");
    expect(ov.site.terms.map((t: any) => t.term)).toContain("pan");
    expect((await owner.post(`${O}/keywords`, { keyword: "Comprar pan de masa madre" })).status).toBe(201);
    expect((await owner.post(`${O}/keywords`, { keyword: "comprar  pan de masa madre " })).status).toBe(409);
    const list = (await owner.get(`${O}/keywords/overview`)).json.saved;
    expect(list[0]).toMatchObject({ intent: "transactional", status: "idea" });
    const comp = await owner.post(`${O}/keywords/competitors`, { url: competitor });
    expect(comp.status).toBe(201);
    expect(comp.json.gap.map((t: any) => t.term)).toEqual(expect.arrayContaining(["gluten", "pan gluten", "bolleria vegana"]));
    expect(comp.json.gap.map((t: any) => t.term)).not.toContain("pan");
    expect((await owner.post(`${O}/keywords/competitors`, { url: "https://rival.es/privado/x" })).json.code).toBe("robots_disallow");
    expect((await owner.post(`${O}/keywords/competitors`, { url: "https://intranet.example/" })).status).toBe(422);
    const csv = await owner.get(`${O}/keywords.csv`);
    expect(String(csv.json)).toMatch(/no disponible/);
  });
});

describe("Backlinks", () => {
  it("imports CSV, verifies links by reading the source page (live / nofollow / lost / robots-blocked)", async () => {
    const site = {
      "https://blog.es/robots.txt": { body: "User-agent: *\nDisallow: /bloqueado", type: "text/plain" },
      "https://blog.es/a": { body: html({ body: '<p>Recomendado: <a href="https://luna.es/" rel="nofollow">Panadería Luna</a></p>' }) },
      "https://blog.es/b": { body: html({ body: "<p>Sin enlaces</p>" }) },
    };
    const { owner, O } = await setup(site, "free");
    const imp = await owner.post(`${O}/backlinks`, { csv: "origen,destino\nhttps://blog.es/a,https://luna.es/\nhttps://blog.es/b,https://luna.es/\nhttps://blog.es/bloqueado/x,https://luna.es/\nno-es-url,https://luna.es/" });
    expect(imp.status).toBe(201);
    expect(imp.json).toMatchObject({ added: 3, errors: [{ line: 5 }] });
    expect((await owner.post(`${O}/backlinks`, { csv: "https://blog.es/a,https://luna.es/" })).json).toMatchObject({ added: 0, duplicates: 1 });
    const chk = await owner.post(`${O}/backlinks/check`, {});
    expect(chk.json.checked).toBe(3);
    const r = (await owner.get(`${O}/backlinks`)).json;
    const by = (u: string) => r.items.find((i: any) => i.source_url === u);
    expect(by("https://blog.es/a")).toMatchObject({ status: "live", rel: "nofollow", anchor_found: "Panadería Luna" });
    expect(by("https://blog.es/b").status).toBe("lost");
    expect(by("https://blog.es/bloqueado/x").status).toBe("blocked");
    expect(r.summary).toMatchObject({ total: 3, live: 1, nofollow: 1 });
    expect(r.usage).toEqual({ used: 3, limit: 50 });
  });
});

describe("Automation rules", () => {
  it("runs lead_created / stage_changed rules once, with conditions, dry-run, logs and plan limits", async () => {
    const { h, owner, orgId, O } = await setup({}, "free");
    const r1 = await owner.post(`${O}/automations/rules`, { name: "Tarea al entrar", trigger: "lead_created", actions: [{ type: "create_task", title: "Llamar en 1 hora", dueHours: 1 }], enabled: true });
    expect(r1.status).toBe(201);
    const r2 = await owner.post(`${O}/automations/rules`, {
      name: "Ganado grande",
      trigger: "stage_changed",
      conditions: [{ field: "stage", op: "eq", value: "won" }, { field: "value_eur", op: "gte", value: 1000 }],
      actions: [{ type: "notify_team", message: "Hemos ganado una venta grande" }, { type: "webhook", url: "https://hooks.luna.es/dni" }],
      enabled: true,
    });
    expect(r2.status).toBe(201);
    expect(r2.json.webhookSecret).toMatch(/^whsec_[0-9a-f]{48}$/);
    expect((await owner.post(`${O}/automations/rules`, { name: "Tercera", trigger: "lead_created", actions: [{ type: "set_stage", stage: "contacted" }] })).status).toBe(402);
    expect((await owner.post(`${O}/automations/rules`, { name: "Insegura", trigger: "lead_created", actions: [{ type: "webhook", url: "http://x.es" }] })).status).toBe(422);

    const lead = await owner.post(`${O}/crm/leads`, { name: "Ana Pérez", email: "ana@example.com", valueEur: 500 });
    expect(lead.status).toBe(201);
    const leadId = lead.json.id as string;
    const tasks = await h.db.prepare("SELECT title FROM crm_tasks WHERE organization_id = ? AND lead_id = ?").bind(orgId, leadId).all<{ title: string }>();
    expect(tasks.results.map((t) => t.title)).toEqual(["Llamar en 1 hora"]);
    // Value below the condition → stage change does not match.
    await owner.patch(`${O}/crm/leads/${leadId}`, { stage: "won" });
    expect((await h.db.prepare("SELECT COUNT(*) AS n FROM webhook_deliveries WHERE organization_id = ?").bind(orgId).first<{ n: number }>())!.n).toBe(0);
    await owner.patch(`${O}/crm/leads/${leadId}`, { stage: "proposal", valueEur: 2500 });
    await owner.patch(`${O}/crm/leads/${leadId}`, { stage: "won" });
    const dl = await h.db.prepare("SELECT payload_json FROM webhook_deliveries WHERE organization_id = ?").bind(orgId).all<{ payload_json: string }>();
    expect(dl.results).toHaveLength(1);
    expect(dl.results[0]!.payload_json).not.toMatch(/ana@example|Pérez/);
    const mail = await h.db.prepare("SELECT body FROM dev_mailbox WHERE subject LIKE 'Automatización%'").all<{ body: string }>();
    expect(mail.results).toHaveLength(1);
    expect(mail.results[0]!.body).not.toMatch(/ana@example|Pérez/);

    const dry = await owner.post(`${O}/automations/rules/${r2.json.rule.id}/dry-run`, { leadId });
    expect(dry.json).toMatchObject({ matches: true, wouldDo: [expect.stringMatching(/Avisar/), expect.stringMatching(/hooks\.luna\.es/)] });
    const overview = (await owner.get(`${O}/automations/rules`)).json;
    expect(overview.runs.map((r: any) => r.status).sort()).toEqual(["done", "done", "dry_run"]);
    expect(overview.usage).toEqual({ used: 2, limit: 2 });
    // A read-only client cannot manage rules.
    await h.db.prepare("UPDATE organizations SET plan_code = 'pro' WHERE id = ?").bind(orgId).run();
    const viewer = await h.invite(owner, orgId, "cliente@luna.es", "client_viewer");
    expect((await viewer.get(`${O}/automations/rules`)).status).toBe(403);
  });

  it("delivers signed webhooks without following redirects, backs off and dead-letters; overdue tasks fire once", async () => {
    const { h, owner, orgId, O } = await setup({}, "growth");
    const created = await owner.post(`${O}/automations/rules`, { name: "Aviso", trigger: "task_overdue", actions: [{ type: "webhook", url: "https://hooks.luna.es/dni" }], enabled: true });
    const secret = created.json.webhookSecret as string;
    const lead = (await owner.post(`${O}/crm/leads`, { name: "Luis", email: "luis@example.com" })).json.id as string;
    await owner.post(`${O}/crm/leads/${lead}/tasks`, { title: "Enviar presupuesto", dueAt: new Date(Date.now() - 3600_000).toISOString() });
    expect(await scanOverdueTasks(h.env)).toBe(1);
    expect(await scanOverdueTasks(h.env)).toBe(0);
    const calls: Array<{ url: string; init: RequestInit }> = [];
    let status = 500;
    const deps = { resolve: h.deps.resolve, fetchImpl: (async (url: string, init: RequestInit) => (calls.push({ url, init }), new Response(status === 204 ? null : "x", { status }))) as unknown as typeof fetch };
    await deliverWebhooks(h.env, deps);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.init.redirect).toBe("manual");
    const sig = (calls[0]!.init.headers as Record<string, string>)["x-dni-signature"]!;
    const [, t, v1] = sig.match(/^t=(\d+),v1=([0-9a-f]{64})$/)!;
    const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${t}.${calls[0]!.init.body}`));
    expect([...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("")).toBe(v1);
    let d = await h.db.prepare("SELECT status, attempts, next_attempt_at FROM webhook_deliveries WHERE organization_id = ?").bind(orgId).first<{ status: string; attempts: number; next_attempt_at: string }>();
    expect(d).toMatchObject({ status: "failed", attempts: 1 });
    // Not due yet → no call; then every retry fails until dead.
    await deliverWebhooks(h.env, deps);
    expect(calls).toHaveLength(1);
    let now = Date.now();
    for (const s of WEBHOOK_BACKOFF_SECONDS) {
      now += (s + 1) * 1000;
      await deliverWebhooks(h.env, deps, new Date(now));
    }
    d = await h.db.prepare("SELECT status, attempts, next_attempt_at FROM webhook_deliveries WHERE organization_id = ?").bind(orgId).first();
    expect(d).toMatchObject({ status: "dead", attempts: WEBHOOK_BACKOFF_SECONDS.length + 1 });
    // Manual retry from the UI → delivered.
    const id = (await owner.get(`${O}/automations/rules`)).json.deliveries[0].id;
    expect((await owner.post(`${O}/automations/deliveries/${id}/retry`, {})).status).toBe(200);
    status = 204;
    await deliverWebhooks(h.env, deps, new Date(now + 1000));
    expect((await h.db.prepare("SELECT status FROM webhook_deliveries WHERE organization_id = ?").bind(orgId).first<{ status: string }>())!.status).toBe("delivered");
  });
});

describe("Attribution", () => {
  it("groups real leads by first-touch UTM with declared won value; test leads excluded; CSV export", async () => {
    const { h, owner, orgId, O } = await setup();
    const ins = (utm: string | null, stage: string, cents: number | null, test = 0) =>
      h.db
        .prepare("INSERT INTO leads (id, organization_id, name, email, email_norm, source, utm_source, utm_medium, stage, value_cents, is_test, created_at, updated_at) VALUES (?, ?, 'X', ?, ?, 'form', ?, 'cpc', ?, ?, ?, ?, ?)")
        .bind(crypto.randomUUID(), orgId, `${crypto.randomUUID()}@e.es`, `${crypto.randomUUID()}@e.es`, utm, stage, cents, test, new Date().toISOString(), new Date().toISOString())
        .run();
    await ins("google", "won", 100000);
    await ins("google", "lost", null);
    await ins("meta", "new", 5000);
    await ins(null, "won", 20000);
    await ins("google", "won", 999999, 1);
    const r = (await owner.get(`${O}/crm/attribution?days=30`)).json;
    expect(r.measurement).toBe("derived");
    expect(r.rows[0]).toMatchObject({ channel: "google / cpc", leads: 2, won: 1, wonValue: 1000, winRate: 0.5 });
    expect(r.rows.find((x: any) => x.channel === "directo / sin UTM")).toMatchObject({ won: 1, wonValue: 200 });
    expect(r.total).toEqual({ leads: 4, won: 2, wonValue: 1200 });
    expect(r.caveats.join(" ")).toMatch(/ROAS/);
    expect(String((await owner.get(`${O}/crm/attribution?format=csv`)).json)).toMatch(/google \/ cpc,2,1,1,1,1000/);
  });
});

describe("Ads Manager (drafts only)", () => {
  it("drafts → submit → review with separation of duties and Spend Guardian; export only when approved", async () => {
    const { h, owner, orgId, O } = await setup({}, "pro");
    const mm = await h.invite(owner, orgId, "mm@luna.es", "marketing_manager");
    const approver = await h.invite(owner, orgId, "aprueba@luna.es", "ads_approver");
    const analyst = await h.invite(owner, orgId, "analista@luna.es", "analyst");
    const body = { name: "Navidad Madrid", platform: "meta", objective: "leads", dailyBudgetEur: 20, destinationUrl: "https://luna.es/navidad" };
    expect((await analyst.post(`${O}/ads/campaigns`, body)).status).toBe(403);
    const c = await mm.post(`${O}/ads/campaigns`, body);
    expect(c.status).toBe(201);
    const id = c.json.id as string;
    expect((await mm.post(`${O}/ads/campaigns/${id}/submit`, {})).json.code).toBe("no_creatives");
    expect((await mm.post(`${O}/ads/campaigns/${id}/creatives`, { format: "1:1", headline: "Roscón artesano", primaryText: "Reserva tu roscón.", cta: "Reservar" })).status).toBe(201);
    expect((await mm.post(`${O}/ads/campaigns/${id}/submit`, {})).status).toBe(200);
    expect((await mm.post(`${O}/ads/campaigns/${id}/review`, { decision: "approve" })).status).toBe(403);
    // Kill switch is ON by default and there is no daily cap → blocked.
    const blocked = await approver.post(`${O}/ads/campaigns/${id}/review`, { decision: "approve" });
    expect(blocked.json.code).toBe("spend_guardian");
    expect(blocked.json.problems.join(" ")).toMatch(/interruptor/);
    expect((await approver.put(`${O}/ads/guardian`, { maxDailyEur: 50, maxCampaignDailyEur: 15, killSwitch: false })).status).toBe(200);
    expect((await approver.post(`${O}/ads/campaigns/${id}/review`, { decision: "approve" })).json.problems[0]).toMatch(/por campaña/);
    await approver.put(`${O}/ads/guardian`, { maxDailyEur: 50, maxCampaignDailyEur: 30, killSwitch: false });
    expect((await approver.post(`${O}/ads/campaigns/${id}/review`, { decision: "approve" })).status).toBe(200);
    const ex = await mm.get(`${O}/ads/campaigns/${id}/export`);
    expect(ex.json.campaign.final_url).toBe("https://luna.es/navidad?utm_source=meta&utm_medium=paid_social&utm_campaign=navidad-madrid");
    expect(ex.json.disclaimer).toMatch(/no ha publicado ni gastado/);
    const ov = (await mm.get(`${O}/ads/overview`)).json;
    expect(ov.connectors.every((x: any) => x.status === "blocked_external")).toBe(true);
    expect(ov.guardian.approvedDailyCents).toBe(2000);
    // Emergency stop is always allowed for whoever holds it.
    expect((await approver.put(`${O}/ads/guardian`, { maxDailyEur: 50, maxCampaignDailyEur: 30, killSwitch: true })).status).toBe(200);
    const audit = await h.db.prepare("SELECT action FROM audit_logs WHERE organization_id = ? AND action LIKE 'ads.%' ORDER BY created_at").bind(orgId).all<{ action: string }>();
    expect(audit.results.map((a) => a.action)).toEqual(expect.arrayContaining(["ads.campaign_draft", "ads.campaign_submit", "ads.campaign_approve", "ads.spend_guardian_update"]));
  });
});

describe("Video Studio", () => {
  it("creates projects within the plan, guards concurrent edits and exports SRT", async () => {
    const { owner, O } = await setup({}, "free");
    const p = await owner.post(`${O}/video/projects`, { name: "Roscón de Reyes", aspect: "9:16" });
    expect(p.status).toBe(201);
    const id = p.json.id as string;
    const d = (await owner.get(`${O}/video/projects/${id}`)).json.project;
    expect(d.project.scenes).toHaveLength(3);
    const scenes = d.project.scenes.map((s: any, i: number) => ({ ...s, caption: i === 1 ? "Hecho a mano cada mañana" : s.caption }));
    const ok = await owner.put(`${O}/video/projects/${id}`, { name: d.name, aspect: "1:1", project: { ...d.project, scenes }, version: 1 });
    expect(ok.json.version).toBe(2);
    expect((await owner.put(`${O}/video/projects/${id}`, { name: d.name, aspect: "1:1", project: d.project, version: 1 })).status).toBe(409);
    expect((await owner.put(`${O}/video/projects/${id}`, { name: d.name, aspect: "1:1", project: { ...d.project, scenes: [{ ...scenes[0], mediaId: crypto.randomUUID() }] }, version: 2 })).json.code).toBe("invalid_media");
    const srt = await owner.get(`${O}/video/projects/${id}/srt`);
    expect(String(srt.json)).toContain("00:00:03,000 --> 00:00:07,000\nHecho a mano cada mañana");
    expect((await owner.post(`${O}/video/projects/${id}/exported`, { mimeType: "video/webm", bytes: 1000, durationMs: 10000, width: 1080, height: 1080 })).status).toBe(200);
    expect((await owner.post(`${O}/video/projects/${id}/duplicate`, {})).status).toBe(201);
    expect((await owner.post(`${O}/video/projects`, { name: "Tercero" })).status).toBe(402);
  });

  it("uploads media only with rights confirmed, allowed type and matching magic bytes", async () => {
    const { h, owner, O } = await setup();
    const up = (bytes: Uint8Array, type: string, rights = "true") => {
      const fd = new FormData();
      fd.set("file", new File([bytes], "foto.png", { type }));
      fd.set("rightsConfirmed", rights);
      return h.app.request(`${O}/media`, { method: "POST", headers: { cookie: owner.cookie, "x-dni-csrf": "1", "cf-connecting-ip": "203.0.113.7" }, body: fd }, h.env, h.ctx);
    };
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
    expect((await up(png, "image/png")).status).toBe(503);
    const store = new Map<string, Uint8Array>();
    h.env.MEDIA = { put: async (k: string, v: Uint8Array) => void store.set(k, v), get: async (k: string) => (store.has(k) ? { body: store.get(k) } : null), delete: async (k: string) => void store.delete(k) } as unknown as R2Bucket;
    expect((await up(png, "image/png", "false")).status).toBe(422);
    expect((await up(png, "image/svg+xml")).status).toBe(415);
    expect((await up(new TextEncoder().encode("<html>"), "image/png")).status).toBe(415);
    const ok = await up(png, "image/png");
    expect(ok.status).toBe(201);
    const { id, url } = (await ok.json()) as { id: string; url: string };
    const file = await owner.get(url);
    expect(file.status).toBe(200);
    expect(file.headers.get("x-content-type-options")).toBe("nosniff");
    expect([...store.keys()][0]).toMatch(/^media\/[0-9a-f-]{36}\/uploads\//);
    expect((await owner.del(`${O}/media/${id}`)).status).toBe(200);
    expect(store.size).toBe(0);
  });
});

describe("Agency, white label and entitlements", () => {
  it("only Pro/Agency create client orgs; clients inherit limits and cannot nest; white label falls back to the agency", async () => {
    const { h, owner, orgId, O } = await setup({}, "growth");
    expect((await owner.post(`${O}/agency/clients`, { name: "Cliente Uno" })).status).toBe(402);
    expect((await owner.put(`${O}/branding`, { displayName: "Agencia Luna" })).status).toBe(402);
    await h.db.prepare("UPDATE organizations SET plan_code = 'agency' WHERE id = ?").bind(orgId).run();
    const cl = await owner.post(`${O}/agency/clients`, { name: "Cliente Uno" });
    expect(cl.status).toBe(201);
    const C = `/api/v1/orgs/${cl.json.id}`;
    expect((await owner.put(`${O}/branding`, { displayName: "Agencia Luna", accent: "#3f6212", logoUrl: "https://luna.es/logo.png" })).status).toBe(200);
    expect((await owner.get(`${C}/branding`)).json).toMatchObject({ inherited: true, displayName: "Agencia Luna" });
    const ent = (await owner.get(`${C}/entitlements`)).json;
    expect(ent).toMatchObject({ plan: { code: "agency" }, ownPlan: "free", inheritedFromAgency: true });
    expect(ent.rows.find((r: any) => r.key === "clientOrgs").limit).toBe(0);
    expect((await owner.post(`${C}/agency/clients`, { name: "Nieto" })).status).toBe(403);
    const list = (await owner.get(`${O}/agency/clients`)).json;
    expect(list.clients).toHaveLength(1);
    expect(list.usage).toEqual({ used: 1, limit: 50 });
    // Someone else's agency never lists our clients.
    const eve = await h.signup("eve@x.es", "Eve");
    const evil = await h.createOrg(eve, "Evil");
    await h.db.prepare("UPDATE organizations SET plan_code = 'agency' WHERE id = ?").bind(evil).run();
    expect((await eve.get(`/api/v1/orgs/${evil}/agency/clients`)).json.clients).toHaveLength(0);
    expect((await eve.get(`${C}/branding`)).status).toBe(404);
  });

  it("entitlements change with the plan and the dashboard shows actionable KPIs instead of locked cards", async () => {
    const { h, owner, orgId, O } = await setup({}, "free");
    const limit = async (k: string) => (await owner.get(`${O}/entitlements`)).json.rows.find((r: any) => r.key === k).limit;
    const expected: Record<string, [number, number, number]> = { free: [1, 2, 0], starter: [5, 10, 0], growth: [20, 30, 0], pro: [50, 100, 5], agency: [200, 300, 50] };
    for (const [plan, [landings, rules, clients]] of Object.entries(expected)) {
      await h.db.prepare("UPDATE organizations SET plan_code = ? WHERE id = ?").bind(plan, orgId).run();
      expect([await limit("landingPages"), await limit("automationRules"), await limit("clientOrgs")]).toEqual([landings, rules, clients]);
    }
    const dash = (await owner.get(`${O}/dashboard`)).json;
    expect(dash.kpis.map((k: any) => k.cta?.to)).toEqual(["search-console", "ai-visibility", "crm", "ads"]);
    await owner.post(`${O}/crm/leads`, { name: "Ana", email: "ana@e.es", valueEur: 300 });
    const lead = await h.db.prepare("SELECT id FROM leads WHERE organization_id = ?").bind(orgId).first<{ id: string }>();
    await owner.patch(`${O}/crm/leads/${lead!.id}`, { stage: "won" });
    const k = (await owner.get(`${O}/dashboard`)).json.kpis.find((x: any) => x.key === "attributed_revenue");
    expect(k.metric).toMatchObject({ value: 300, measurement: "derived" });
  });
});
