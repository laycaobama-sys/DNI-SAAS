import { describe, expect, it } from "vitest";
import { publicAuditMaintenance } from "../src/jobs/public-audit";
import { sendLifecycleEmails, unsubscribeToken } from "../src/lib/lifecycle";
import { createHarness, html } from "./helpers";

/**
 * Phase 2 (activation): free audit without an account → teaser → signup → claim → guided set-up → first
 * article, plus the limits, cache, comparison, help emails and opt-out around it.
 */
const page = (title: string, h1: string, links: string[] = []) => ({ body: html({ title, desc: `${title}. Información real del negocio, precios orientativos y contacto en Valencia.`, h1, links }) });
const SITE: Record<string, { body?: string; type?: string; status?: number }> = {
  "https://taller-sol.es/": {
    body: html({
      title: "Taller Sol | Reparación de bicicletas en Valencia",
      h1: "Reparamos tu bici en 24 horas",
      // Untrusted crawled text: must never come out as HTML on /auditoria/{id}.
      desc: 'Taller de bicis <script>alert("x")</script> en Valencia',
      links: ["/servicios", "/precios", "/contacto", "/blog", "/equipo", "/opiniones", "/faq"],
    }),
  },
  "https://taller-sol.es/servicios": page("Servicios | Taller Sol", "Servicios"),
  "https://taller-sol.es/precios": page("Precios | Taller Sol", "Precios"),
  "https://taller-sol.es/contacto": page("Contacto | Taller Sol", "Contacto"),
  "https://taller-sol.es/blog": page("Blog | Taller Sol", "Blog"),
  "https://taller-sol.es/equipo": page("Equipo | Taller Sol", "Equipo"),
  "https://taller-sol.es/opiniones": page("Opiniones | Taller Sol", "Opiniones"),
  "https://taller-sol.es/faq": page("Preguntas | Taller Sol", "Preguntas"),
  "https://taller-sol.es/robots.txt": { body: "User-agent: *\nAllow: /", type: "text/plain" },
  "https://bicis-rival.es/": { body: html({ title: "Bicis Rival | Tienda de bicicletas", desc: "Tienda y taller de bicicletas en Valencia con recogida a domicilio y garantía de 6 meses.", h1: "Bicis Rival", extraHead: '<link rel="canonical" href="https://bicis-rival.es/">' }) },
};

const harness = (dns?: Record<string, string[]>) => createHarness({ site: SITE, dns });
type H = ReturnType<typeof harness>;
const PUBLIC = "/api/v1/public/audits";

async function startAudit(h: H, url = "taller-sol.es", ip = "198.51.100.10") {
  const c = new h.Client();
  const r = await c.post(PUBLIC, { url }, { "cf-connecting-ip": ip });
  await h.drain();
  return { c, r };
}

describe("E2E Fase 2: URL → adelanto → registro → bienvenida → primer artículo", () => {
  it("runs the whole activation flow with real data", async () => {
    const h = harness();
    // 1. Anonymous visitor: free audit of at most 5 pages, no AI, no credits.
    const { c: visitor, r } = await startAudit(h);
    expect(r.status).toBe(201);
    expect(r.json.page).toBe(`/auditoria/${r.json.id}`);
    const id = r.json.id as string;
    const htmlPages = h.fetchLog.filter((u) => u.startsWith("https://taller-sol.es/") && !/robots\.txt|sitemap|llms\.txt/.test(u));
    expect(new Set(htmlPages).size).toBeLessThanOrEqual(5);

    // 2. Teaser: scores, top 3 with evidence and the fix, the rest hidden until signup.
    const t = (await visitor.get(`${PUBLIC}/${id}`)).json;
    expect(t.status).toBe("completed");
    expect(t.findings).toBeNull();
    expect(t.teaser.measurement).toBe("derived");
    expect(t.teaser.pagesAnalyzed).toBeLessThanOrEqual(5);
    for (const k of ["global", "technical", "seo", "geo"]) {
      expect(t.teaser.scores[k]).toBeGreaterThanOrEqual(0);
      expect(t.teaser.scores[k]).toBeLessThanOrEqual(100);
    }
    expect(t.teaser.top.length).toBeGreaterThan(0);
    expect(t.teaser.top.length).toBeLessThanOrEqual(3);
    for (const f of t.teaser.top) expect(f).toMatchObject({ title: expect.any(String), evidence: expect.any(String), fix: expect.any(String) });
    expect(t.teaser.method).toMatch(/no predicen posiciones/);
    const stored = await h.db.prepare("SELECT ip_hash, result_json FROM public_audits WHERE id = ?").bind(id).first<{ ip_hash: string; result_json: string }>();
    expect(stored!.ip_hash).toMatch(/^[0-9a-f]{32}$/);
    expect(stored!.ip_hash).not.toContain("198.51");
    const all = JSON.parse(stored!.result_json).findings as unknown[];
    expect(t.teaser.othersCount).toBe(Math.max(0, all.length - t.teaser.top.length));

    // The page renders without JS, escapes crawled text, is noindex and carries the site CSP.
    const pageRes = await h.app.request(`/auditoria/${id}`, {}, h.env, h.ctx);
    expect(pageRes.status).toBe(200);
    expect(pageRes.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    expect(pageRes.headers.get("content-security-policy")).toContain("script-src 'self'");
    const body = await pageRes.text();
    expect(body).toContain("taller-sol.es");
    expect(body).toContain(`${t.teaser.scores.global}<small>/100</small>`);
    expect(body).toContain(`/app/register?audit=${id}`);
    expect(body).toContain("wa.me");
    expect(body).not.toContain('<script>alert("x")</script>');

    // 3. Signup + organisation + claim (the visitor's free audit becomes the organisation's).
    const owner = await h.signup("ana@taller-sol.es", "Ana Sol");
    const orgId = await h.createOrg(owner, "Taller Sol SL", "starter");
    const O = `/api/v1/orgs/${orgId}`;
    const claim = await owner.post(`${O}/public-audits/${id}/claim`);
    expect(claim.status).toBe(200);
    expect(claim.json.analyzeUrl).toBe("https://taller-sol.es/");
    expect(claim.json.findings.length).toBe(all.length);
    const after = await h.db.prepare("SELECT ip_hash, claimed_org_id FROM public_audits WHERE id = ?").bind(id).first<{ ip_hash: string | null; claimed_org_id: string }>();
    expect(after).toEqual({ ip_hash: null, claimed_org_id: orgId });
    // Full report for the organisation only; the anonymous link still shows just the teaser.
    expect((await owner.get(`${PUBLIC}/${id}`)).json.findings.length).toBe(all.length);
    expect((await visitor.get(`${PUBLIC}/${id}`)).json.findings).toBeNull();
    const fullPage = await h.app.request(`/auditoria/${id}`, { headers: { cookie: owner.cookie } }, h.env, h.ctx);
    expect(await fullPage.text()).toContain("Ir a mi cuenta");
    const audit = await h.db.prepare("SELECT action FROM audit_logs WHERE organization_id = ? AND action = 'public_audit.claimed'").bind(orgId).first();
    expect(audit).toBeTruthy();

    // 4. Guided set-up: six steps read from real data.
    let a = (await owner.get(`${O}/activation`)).json;
    expect(a.steps.map((s: { key: string }) => s.key)).toEqual(["brand", "competitors", "analytics", "cms", "mode", "article"]);
    expect(a).toMatchObject({ done: 0, total: 6, next: "brand", publicAudit: { id, host: "taller-sol.es" } });
    expect(a.steps.find((s: { key: string }) => s.key === "cms")).toMatchObject({ status: "pending", cta: "Conectar WordPress" });

    // Step 1 + 2: full analysis → brand profile → competitors → confirm.
    const start = await owner.post(`${O}/sites/analyze`, { url: claim.json.analyzeUrl }, { "idempotency-key": "fase2-e2e-analysis" });
    expect(start.status).toBe(202);
    await h.drain();
    const brandId = (await owner.get(`${O}/brands`)).json.items[0].id as string;
    const prof = (await owner.get(`${O}/brands/${brandId}/profile`)).json.profile;
    const facts = prof.facts.some((f: { key: string }) => f.key === "name") ? prof.facts : [...prof.facts, { key: "name", value: "Taller Sol", status: "confirmed", source: "user" }];
    expect((await owner.put(`${O}/brands/${brandId}/profile`, { facts, audience: "Ciclistas urbanos de Valencia", tone: "cercano", objective: "leads", prohibitedClaims: [], competitors: ["bicis-rival.es"] })).status).toBe(200);
    expect((await owner.post(`${O}/brands/${brandId}/profile/confirm`)).status).toBe(200);

    // Step 3 skipped on purpose, step 5 chosen.
    a = (await owner.put(`${O}/onboarding`, { skip: "analytics" })).json;
    expect(a.steps.find((s: { key: string }) => s.key === "analytics").status).toBe("skipped");
    a = (await owner.put(`${O}/onboarding`, { skip: "cms" })).json;
    expect(a.steps.find((s: { key: string }) => s.key === "cms").status).toBe("skipped");
    a = (await owner.put(`${O}/onboarding`, { publishingMode: "approval", articlesPerWeek: 2 })).json;
    expect(a).toMatchObject({ publishingMode: "approval", articlesPerWeek: 2 });

    // Step 6: first article (a draft; nothing is published).
    expect(a.next).toBe("article");
    const art = await owner.post(`${O}/content/manual`, { kind: "blog_article", title: "Cómo preparar tu bici para el invierno" });
    expect(art.status).toBe(201);
    a = (await owner.get(`${O}/activation`)).json;
    const status = Object.fromEntries(a.steps.map((s: { key: string; status: string }) => [s.key, s.status]));
    expect(status).toEqual({ brand: "done", competitors: "done", analytics: "skipped", cms: "skipped", mode: "done", article: "done" });
    expect(a).toMatchObject({ done: 4, next: null, percent: 67 });
  });

  it("on the Free plan the article step is open (1 AI article a month, as /precios says)", async () => {
    const h = harness();
    const owner = await h.signup("free@taller-sol.es");
    const orgId = await h.createOrg(owner, "Free SL");
    const a = (await owner.get(`/api/v1/orgs/${orgId}/activation`)).json;
    expect(a.steps.find((s: { key: string }) => s.key === "article")).toMatchObject({ status: "pending", href: `/o/${orgId}/content`, cta: "Crear artículo" });
    // Autopilot is stored as a preference and said to be in development.
    const m = (await owner.put(`/api/v1/orgs/${orgId}/onboarding`, { publishingMode: "autopilot" })).json;
    expect(m.steps.find((s: { key: string }) => s.key === "mode").note).toMatch(/en desarrollo/);
    expect((await owner.put(`/api/v1/orgs/${orgId}/onboarding`, { skip: "brand" })).status).toBe(422);
  });
});

describe("free audit: safety, limits and cache", () => {
  it("rejects private targets, other origins and private DNS answers", async () => {
    const h = harness({ "intranet-sol.es": ["10.0.0.8"] });
    const c = new h.Client();
    for (const url of ["http://127.0.0.1", "localhost", "http://169.254.169.254/latest", "file:///etc/passwd"]) {
      const r = await c.post(PUBLIC, { url });
      expect(r.status, url).toBe(422);
    }
    expect((await c.post(PUBLIC, { url: "taller-sol.es" }, { origin: "https://evil.example" })).status).toBe(403);
    const r = await c.post(PUBLIC, { url: "intranet-sol.es" });
    expect(r.status).toBe(201);
    await h.drain();
    const v = (await c.get(`${PUBLIC}/${r.json.id}`)).json;
    expect(v).toMatchObject({ status: "failed", error: { code: "url_blocked" } });
    expect(h.fetchLog.some((u) => u.includes("intranet-sol.es"))).toBe(false);
    const failedPage = await (await h.app.request(`/auditoria/${r.json.id}`, {}, h.env, h.ctx)).text();
    expect(failedPage).toContain("No hemos podido revisar intranet-sol.es");
  });

  it("reuses a recent audit of the same host as a separate copy and limits each visitor", async () => {
    const h = harness();
    const { r: first } = await startAudit(h, "taller-sol.es", "198.51.100.20");
    const fetchedBefore = h.fetchLog.length;
    const c = new h.Client();
    const again = await c.post(PUBLIC, { url: "https://www.taller-sol.es/" }, { "cf-connecting-ip": "198.51.100.21" });
    expect(again.status).toBe(200);
    expect(again.json).toMatchObject({ cached: true, status: "completed" });
    expect(again.json.id).not.toBe(first.json.id);
    expect(h.fetchLog.length).toBe(fetchedBefore);
    const [a, b] = await Promise.all([c.get(`${PUBLIC}/${first.json.id}`), c.get(`${PUBLIC}/${again.json.id}`)]);
    expect(b.json.teaser.scores).toEqual(a.json.teaser.scores);

    // 6 per hour per (hashed) IP.
    const v = new h.Client();
    const codes: number[] = [];
    for (let i = 0; i < 7; i++) codes.push((await v.post(PUBLIC, { url: `web-${i}.es` }, { "cf-connecting-ip": "198.51.100.30" })).status);
    expect(codes.slice(0, 6).every((s) => s === 201)).toBe(true);
    expect(codes[6]).toBe(429);
  });

  it("stops new crawls at the platform daily cap with a clear message", async () => {
    const h = harness();
    const win = Math.floor(Date.now() / 1000 / 86400) * 86400;
    await h.db.prepare("INSERT INTO rate_limits (key, window_start, count) VALUES ('paudit:global', ?, 400)").bind(win).run();
    const r = await new h.Client().post(PUBLIC, { url: "taller-sol.es" }, { "cf-connecting-ip": "198.51.100.40" });
    expect(r.status).toBe(429);
    expect(r.json.code).toBe("public_audit_daily_cap");
    expect(r.json.title).toMatch(/Crea tu cuenta gratis/);
  });

  it("compares with a competitor through a link, without changing the shared audit", async () => {
    const h = harness();
    const { c, r } = await startAudit(h);
    const id = r.json.id as string;
    expect((await c.post(`${PUBLIC}/${id}/compare`, { url: "taller-sol.es" })).status).toBe(422);
    const vs = await c.post(`${PUBLIC}/${id}/compare`, { url: "bicis-rival.es" });
    expect(vs.status).toBe(201);
    expect(vs.json.page).toBe(`/auditoria/${id}?vs=${vs.json.id}`);
    await h.drain();
    const v = (await c.get(`${PUBLIC}/${id}?vs=${vs.json.id}`)).json;
    expect(v.competitor).toMatchObject({ host: "bicis-rival.es", status: "completed", scores: { global: expect.any(Number) } });
    // Without ?vs the shared link shows no comparison, and a competitor audit cannot be compared again.
    expect((await c.get(`${PUBLIC}/${id}`)).json.competitor).toBeNull();
    expect((await c.post(`${PUBLIC}/${vs.json.id}/compare`, { url: "otra.es" })).status).toBe(404);
    // A ?vs that belongs to another audit is ignored.
    const other = (await startAudit(h, "otro-taller.es", "198.51.100.50")).r.json.id as string;
    expect((await c.get(`${PUBLIC}/${other}?vs=${vs.json.id}`)).json.competitor).toBeNull();
    const html = await (await h.app.request(`/auditoria/${id}?vs=${vs.json.id}`, {}, h.env, h.ctx)).text();
    expect(html).toContain("Tu web frente a bicis-rival.es");
  });

  it("a second organisation that claims an already claimed audit gets its own copy", async () => {
    const h = harness();
    const { r } = await startAudit(h);
    const id = r.json.id as string;
    const ana = await h.signup("ana@a.es");
    const orgA = await h.createOrg(ana, "Ana SL");
    const bea = await h.signup("bea@b.es");
    const orgB = await h.createOrg(bea, "Bea SL");
    expect((await ana.post(`/api/v1/orgs/${orgA}/public-audits/${id}/claim`)).json.id).toBe(id);
    const copy = (await bea.post(`/api/v1/orgs/${orgB}/public-audits/${id}/claim`)).json;
    expect(copy.id).not.toBe(id);
    const rows = (await h.db.prepare("SELECT id, claimed_org_id FROM public_audits WHERE id IN (?, ?)").bind(id, copy.id).all<{ id: string; claimed_org_id: string }>()).results;
    expect(Object.fromEntries(rows.map((x) => [x.id, x.claimed_org_id]))).toEqual({ [id]: orgA, [copy.id]: orgB });
    // Bea cannot read Ana's full list through the original link, nor claim into Ana's organisation.
    expect((await bea.get(`${PUBLIC}/${id}`)).json.findings).toBeNull();
    expect((await bea.post(`/api/v1/orgs/${orgA}/public-audits/${id}/claim`)).status).toBe(404);
  });

  it("maintenance re-sends lost audits and deletes anonymous ones after 30 days, never claimed ones", async () => {
    const h = harness();
    const old = new Date(Date.now() - 10 * 60_000).toISOString();
    const expired = new Date(Date.now() - 1000).toISOString();
    const future = new Date(Date.now() + 86400_000).toISOString();
    const owner = await h.signup("o@o.es");
    const orgId = await h.createOrg(owner, "Org SL");
    await h.db.batch([
      h.db.prepare("INSERT INTO public_audits (id, url, host, status, created_at, expires_at) VALUES ('00000000-0000-4000-8000-000000000001', 'https://taller-sol.es/', 'taller-sol.es', 'queued', ?, ?)").bind(old, future),
      h.db.prepare("INSERT INTO public_audits (id, url, host, status, created_at, expires_at) VALUES ('00000000-0000-4000-8000-000000000002', 'https://x.es/', 'x.es', 'completed', ?, ?)").bind(old, expired),
      h.db.prepare("INSERT INTO public_audits (id, url, host, status, claimed_org_id, created_at, expires_at) VALUES ('00000000-0000-4000-8000-000000000003', 'https://y.es/', 'y.es', 'completed', ?, ?, ?)").bind(orgId, old, expired),
    ]);
    const pending: Promise<unknown>[] = [];
    const out = await publicAuditMaintenance(h.env, h.deps, (p) => void pending.push(p));
    await Promise.all(pending);
    expect(out).toMatchObject({ resent: 1, purged: 1 });
    const left = (await h.db.prepare("SELECT id, status FROM public_audits ORDER BY id").all<{ id: string; status: string }>()).results;
    expect(left).toEqual([
      { id: "00000000-0000-4000-8000-000000000001", status: "completed" },
      { id: "00000000-0000-4000-8000-000000000003", status: "completed" },
    ]);
  });
});

describe("help emails at 24 h and 72 h", () => {
  const mails = (h: H, to: string) => h.db.prepare("SELECT subject, body FROM dev_mailbox WHERE to_email = ? ORDER BY created_at, rowid").bind(to).all<{ subject: string; body: string }>();

  it("sends each once with the next real step, skips old accounts and honours the opt-out", async () => {
    const h = harness();
    const legacy = await h.signup("antiguo@x.es", "Antiguo");
    await h.createOrg(legacy, "Antigua");
    // First run: fixes the start date, so accounts that existed before the feature never get these emails.
    await sendLifecycleEmails(h.env, new Date(Date.now() + 1000));
    const ana = await h.signup("ana@help.es", "Ana María");
    await h.db.prepare("UPDATE users SET created_at = ? WHERE email = ?").bind(new Date(Date.now() + 2000).toISOString(), "ana@help.es").run();
    const orgId = await h.createOrg(ana, "Ana SL", "starter");
    const at = (hours: number) => new Date(Date.now() + 3000 + hours * 3600_000);

    expect(await sendLifecycleEmails(h.env, at(23))).toEqual({ sent: 0, skipped: 0 });
    expect(await sendLifecycleEmails(h.env, at(25))).toEqual({ sent: 1, skipped: 0 });
    expect(await sendLifecycleEmails(h.env, at(26))).toEqual({ sent: 0, skipped: 0 });
    let box = (await mails(h, "ana@help.es")).results.filter((m) => m.subject.includes("siguiente paso"));
    expect(box).toHaveLength(1);
    expect(box[0]!.body).toContain("Hola, Ana:");
    expect(box[0]!.body).toContain("Confirma tu marca");
    expect(box[0]!.body).toContain(`/app/o/${orgId}/analyze`);
    expect(box[0]!.body).toContain("/api/v1/public/lifecycle/unsubscribe?u=");
    expect((await mails(h, "antiguo@x.es")).results.some((m) => m.subject.includes("siguiente paso"))).toBe(false);

    // One-click opt-out: GET only shows a confirmation (link scanners do not unsubscribe), POST does it.
    const user = await h.db.prepare("SELECT id FROM users WHERE email = ?").bind("ana@help.es").first<{ id: string }>();
    const token = await unsubscribeToken(h.env, user!.id);
    const bad = await h.app.request(`/api/v1/public/lifecycle/unsubscribe?u=${user!.id}&t=${"0".repeat(32)}`, {}, h.env, h.ctx);
    expect(bad.status).toBe(400);
    const confirm = await h.app.request(`/api/v1/public/lifecycle/unsubscribe?u=${user!.id}&t=${token}`, {}, h.env, h.ctx);
    expect(confirm.status).toBe(200);
    expect(await confirm.text()).toContain("Sí, darme de baja");
    expect((await h.db.prepare("SELECT lifecycle_emails_opt_out_at AS v FROM users WHERE id = ?").bind(user!.id).first<{ v: string | null }>())!.v).toBeNull();
    const done = await h.app.request(
      "/api/v1/public/lifecycle/unsubscribe",
      { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: `u=${user!.id}&t=${token}` },
      h.env,
      h.ctx,
    );
    expect(done.status).toBe(200);
    expect(await sendLifecycleEmails(h.env, at(73))).toEqual({ sent: 0, skipped: 0 });
    box = (await mails(h, "ana@help.es")).results;
    expect(box.some((m) => m.subject.includes("terminar la configuración"))).toBe(false);
  });

  it("the 72 h email goes out while a step is left, nothing is sent once everything is done or too late", async () => {
    const h = harness();
    await sendLifecycleEmails(h.env, new Date(Date.now() - 1000));
    const bea = await h.signup("bea@help.es", "Bea");
    await h.createOrg(bea, "Bea SL");
    const cid = await h.signup("cid@help.es", "Cid");
    const cOrg = await h.createOrg(cid, "Cid SL");
    // Cid has everything done or skipped (CMS is not available yet): no help email for him.
    await h.db.prepare("INSERT INTO organization_onboarding (organization_id, publishing_mode, articles_per_week, skipped_json, updated_at) VALUES (?, 'approval', 1, '[\"competitors\",\"analytics\"]', ?)").bind(cOrg, new Date().toISOString()).run();
    await h.db.prepare("INSERT INTO brands (id, organization_id, name) VALUES ('00000000-0000-4000-8000-0000000000b1', ?, 'Cid')").bind(cOrg).run();
    await h.db.prepare("INSERT INTO brand_profiles (id, organization_id, brand_id, confirmed_at) VALUES ('00000000-0000-4000-8000-0000000000b2', ?, '00000000-0000-4000-8000-0000000000b1', ?)").bind(cOrg, new Date().toISOString()).run();
    await h.db.prepare("INSERT INTO content_items (id, organization_id, kind, title, created_by) VALUES ('00000000-0000-4000-8000-0000000000b3', ?, 'blog_article', 'Primer artículo', 'test')").bind(cOrg).run();
    const at = (hours: number) => new Date(Date.now() + 1000 + hours * 3600_000);
    expect(await sendLifecycleEmails(h.env, at(25))).toEqual({ sent: 1, skipped: 1 });
    expect(await sendLifecycleEmails(h.env, at(73))).toEqual({ sent: 1, skipped: 1 });
    const box = (await mails(h, "bea@help.es")).results.map((m) => m.subject);
    expect(box).toEqual(expect.arrayContaining(["Tu siguiente paso en DNI Growth", "¿Te ayudamos a terminar la configuración?"]));
    expect((await mails(h, "cid@help.es")).results.some((m) => /siguiente paso|terminar/.test(m.subject))).toBe(false);
    const rows = (await h.db.prepare("SELECT kind, status, reason FROM lifecycle_emails WHERE user_id = (SELECT id FROM users WHERE email = 'cid@help.es') ORDER BY kind").all()).results;
    expect(rows).toEqual([
      { kind: "onboarding_24h", status: "skipped", reason: "nothing_pending" },
      { kind: "onboarding_72h", status: "skipped", reason: "nothing_pending" },
    ]);

    // An email more than 48 h late (e.g. the cron was stopped) is not sent any more.
    const dan = await h.signup("dan@help.es", "Dan");
    await h.createOrg(dan, "Dan SL");
    expect(await sendLifecycleEmails(h.env, at(73.5))).toEqual({ sent: 1, skipped: 0 });
    expect((await mails(h, "dan@help.es")).results.map((m) => m.subject)).toContain("¿Te ayudamos a terminar la configuración?");
    expect((await mails(h, "dan@help.es")).results.map((m) => m.subject)).not.toContain("Tu siguiente paso en DNI Growth");
  });
});
