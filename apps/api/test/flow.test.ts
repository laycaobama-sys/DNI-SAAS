import { describe, expect, it } from "vitest";
import { hmacSha256Hex } from "@dni/core";
import { processJobMessage } from "../src/jobs/consumer";
import { createHarness, html } from "./helpers";

const ORG_LD = `<script type="application/ld+json">{"@context":"https://schema.org","@type":"LocalBusiness","name":"Panadería Luna","telephone":"+34 911 000 000","sameAs":["https://instagram.com/panaderialuna"]}</script>`;

const BENIGN_SITE = {
  "http://panaderia-luna.es/": { status: 301, location: "https://panaderia-luna.es/" },
  "https://panaderia-luna.es/": {
    body: html({
      title: "Panadería Luna | Pan artesano en Madrid",
      desc: "Panadería artesana en Madrid con masa madre, bollería de mantequilla y encargos para eventos.",
      h1: "Pan de masa madre cada mañana",
      extraHead: `<link rel="canonical" href="https://panaderia-luna.es/"><meta property="og:title" content="Panadería Luna"><meta property="og:image" content="https://panaderia-luna.es/og.jpg">${ORG_LD}`,
      links: ["/productos", "/contacto", "/privado/area", "https://instagram.com/panaderialuna", "/catalogo.pdf"],
    }),
  },
  "https://panaderia-luna.es/productos": { body: html({ title: "Productos", h1: "Productos", body: `<img src="/a.jpg"><p>Pan</p><p>${"Hogazas y bollería. ".repeat(5)}</p>` }) },
  "https://panaderia-luna.es/contacto": { body: html({ title: "Contacto | Panadería Luna", desc: "Contacta con Panadería Luna en Madrid para encargos y pedidos especiales de pan artesano.", h1: "Contacto", lang: "" }) },
  "https://panaderia-luna.es/privado/area": { body: html({ title: "Privado", h1: "No deberías ver esto" }) },
  "https://panaderia-luna.es/robots.txt": { body: "User-agent: *\nDisallow: /privado/\nSitemap: https://panaderia-luna.es/sitemap.xml", type: "text/plain" },
  "https://panaderia-luna.es/sitemap.xml": { body: `<urlset><url><loc>https://panaderia-luna.es/</loc></url><url><loc>https://panaderia-luna.es/productos</loc></url><url><loc>https://otro-dominio.com/x</loc></url></urlset>`, type: "application/xml" },
};

async function setup(site: Record<string, unknown> = BENIGN_SITE, dns: Record<string, string[]> = {}) {
  const h = createHarness({ site: site as never, dns });
  const owner = await h.signup("owner@luna.es", "Lucía");
  const orgId = await h.createOrg(owner, "Panadería Luna SL");
  return { h, owner, orgId };
}

describe("E2E F1: URL → job → audit → brand → plan", () => {
  it("analyses a benign public site end to end with evidence, honouring robots.txt", async () => {
    const { h, owner, orgId } = await setup();
    const start = await owner.post(`/api/v1/orgs/${orgId}/sites/analyze`, { url: "http://panaderia-luna.es" }, { "idempotency-key": "first-analysis-001" });
    expect(start.status).toBe(202);
    expect(start.json.creditsReserved).toBe(10);
    await h.drain();

    const { job, events } = (await owner.get(`/api/v1/orgs/${orgId}/jobs/${start.json.jobId}`)).json;
    expect(job.state).toBe("completed");
    expect(job.progress).toBe(100);
    expect(events.map((e: { kind: string }) => e.kind)).toEqual(expect.arrayContaining(["queued", "started", "validating", "homepage", "discovery", "crawled", "completed"]));

    // robots.txt respected: /privado/ never fetched; off-site and PDF links never fetched.
    expect(h.fetchLog).not.toContain("https://panaderia-luna.es/privado/area");
    expect(h.fetchLog.some((u) => u.includes("otro-dominio.com") || u.endsWith(".pdf") || u.includes("instagram.com"))).toBe(false);

    const crawl = (await owner.get(`/api/v1/orgs/${orgId}/crawls/${job.output.crawlId}`)).json;
    expect(crawl.crawl.status).toBe("completed");
    expect(crawl.crawl.origin).toBe("http://panaderia-luna.es");
    expect(crawl.crawl.served_over_https).toBe(1);
    expect(crawl.pages.map((p: { final_url: string }) => p.final_url).sort()).toEqual([
      "https://panaderia-luna.es/",
      "https://panaderia-luna.es/contacto",
      "https://panaderia-luna.es/productos",
    ]);
    const keys = crawl.issues.map((i: { rule_key: string }) => i.rule_key);
    expect(keys).toContain("meta_description_missing"); // /productos
    expect(keys).toContain("images_missing_alt");
    expect(keys).toContain("lang_missing"); // /contacto
    expect(keys).toContain("llms_txt_missing");
    const alt = crawl.issues.find((i: { rule_key: string }) => i.rule_key === "images_missing_alt");
    expect(alt.url).toBe("https://panaderia-luna.es/productos");
    expect(alt.evidence.count).toBe(1);
    expect(crawl.crawl.opportunities.length).toBeGreaterThan(0);
    expect(crawl.crawl.health_score).toBeGreaterThan(0);
    expect(crawl.methodology.limitations.length).toBeGreaterThan(0);
    expect(crawl.crawl.skipped).toEqual(expect.arrayContaining([{ url: "https://panaderia-luna.es/privado/area", reason: "robots_disallow" }]));

    // Brand profile: facts with sources; audience never invented.
    const prof = (await owner.get(`/api/v1/orgs/${orgId}/brands/${start.json.brandId}/profile`)).json.profile;
    const name = prof.facts.find((f: { key: string }) => f.key === "name");
    expect(name).toMatchObject({ value: "Panadería Luna", method: "json-ld", sourceUrl: "https://panaderia-luna.es/" });
    expect(prof.missing.map((m: { key: string }) => m.key)).toContain("audience");
    expect(prof.confirmedAt).toBeNull();

    // Confirmation requires the human to complete audience + objective.
    const conf1 = await owner.post(`/api/v1/orgs/${orgId}/brands/${start.json.brandId}/profile/confirm`);
    expect(conf1.status).toBe(422);
    expect(conf1.json.missing).toEqual(["público objetivo", "objetivo comercial"]);
    const put = await owner.put(`/api/v1/orgs/${orgId}/brands/${start.json.brandId}/profile`, {
      facts: prof.facts,
      audience: "Vecinos de Chamberí y empresas que encargan catering",
      tone: "Cercano y artesano",
      objective: "leads",
      prohibitedClaims: ["el mejor pan de España"],
      competitors: ["otra-panaderia.es"],
    });
    expect(put.status).toBe(200);
    expect((await owner.post(`/api/v1/orgs/${orgId}/brands/${start.json.brandId}/profile/confirm`)).status).toBe(200);

    // Growth plan: editable, brand task auto-completed after confirmation, blocked tasks honest.
    const plan = (await owner.get(`/api/v1/orgs/${orgId}/plans/${job.output.planId}`)).json;
    expect(plan.tasks.find((t: { channel: string }) => t.channel === "brand").status).toBe("done");
    const paid = plan.tasks.find((t: { channel: string }) => t.channel === "paid");
    expect(paid.status).toBe("blocked");
    expect(paid.requires_approval).toBe(true);
    // B3/B4: no internal phase codes; available modules/integrations are actionable, not "blocked".
    expect(paid.blocked_reason).not.toMatch(/\bF\d\b/);
    expect(plan.tasks.find((t: { channel: string }) => t.channel === "measurement").status).toBe("todo");
    expect(plan.tasks.find((t: { channel: string }) => t.channel === "content").status).toBe("todo");
    expect(plan.disclaimer).not.toMatch(/measurement/);
    const tech = plan.tasks.find((t: { channel: string; status: string }) => t.channel === "technical" && t.status === "todo");
    expect((await owner.patch(`/api/v1/orgs/${orgId}/plans/${job.output.planId}/tasks/${tech.id}`, { status: "doing", week: 2 })).status).toBe(200);
    expect((await owner.patch(`/api/v1/orgs/${orgId}/plans/${job.output.planId}/tasks/${paid.id}`, { status: "done" })).json.code).toBe("task_blocked");

    const md = await owner.get(`/api/v1/orgs/${orgId}/plans/${job.output.planId}/export?format=md`);
    expect(md.headers.get("content-disposition")).toContain("attachment");
    expect(md.json).toContain("# Plan de crecimiento 30 días");
    const js = await owner.get(`/api/v1/orgs/${orgId}/plans/${job.output.planId}/export?format=json`);
    expect(js.json.measurement).toBe("estimated");

    // Credits: reserve 10 → release 10 → settle actual pages (3). Balance = 50 - 3.
    const bill = (await owner.get(`/api/v1/orgs/${orgId}/billing`)).json;
    expect(bill.balance).toBe(47);
    expect(bill.ledger.map((l: { entry_kind: string }) => l.entry_kind).sort()).toEqual(["grant", "release", "reserve", "settle"]);

    // Audit trail recorded.
    const logs = (await owner.get(`/api/v1/orgs/${orgId}/audit-logs`)).json.items.map((l: { action: string }) => l.action);
    expect(logs).toEqual(expect.arrayContaining(["org.create", "site.analyze", "brand_profile.update", "brand_profile.confirm", "plan_task.update"]));

    // Dashboard reports real counts with source + measurement type, and lists unavailable modules honestly.
    const dash = (await owner.get(`/api/v1/orgs/${orgId}/dashboard`)).json;
    for (const m of dash.metrics) expect(m).toMatchObject({ measurement: expect.stringMatching(/observed|derived/), source: expect.any(String), observedAt: expect.any(String) });
    expect(dash.metrics.find((m: { metric: string }) => m.metric === "completed_audits").value).toBe(1);
    // Free plan: no card pointing at Ads (Pro). The plan-modules test covers each plan.
    expect(dash.unavailable.map((u: { key: string }) => u.key)).not.toContain("ad_spend");

    // Re-analysis does not overwrite a confirmed brand profile.
    await owner.post(`/api/v1/orgs/${orgId}/sites/analyze`, { url: "https://panaderia-luna.es" });
    await h.drain();
    const prof2 = (await owner.get(`/api/v1/orgs/${orgId}/brands/${start.json.brandId}/profile`)).json.profile;
    expect(prof2.confirmedAt).not.toBeNull();
    expect(prof2.audience).toBe("Vecinos de Chamberí y empresas que encargan catering");
  });

  it("idempotency key: replays return the same job, never a second one", async () => {
    const { h, owner, orgId } = await setup();
    const a = await owner.post(`/api/v1/orgs/${orgId}/sites/analyze`, { url: "panaderia-luna.es" }, { "idempotency-key": "same-key-123456" });
    const b = await owner.post(`/api/v1/orgs/${orgId}/sites/analyze`, { url: "panaderia-luna.es" }, { "idempotency-key": "same-key-123456" });
    expect(b.status).toBe(200);
    expect(b.json.idempotentReplay).toBe(true);
    expect(b.json.jobId).toBe(a.json.jobId);
    await h.drain();
    expect(await h.db.prepare("SELECT COUNT(*) AS n FROM jobs").first("n")).toBe(1);
  });

  it("duplicate queue deliveries never execute a job twice", async () => {
    const { h, owner, orgId } = await setup();
    const a = await owner.post(`/api/v1/orgs/${orgId}/sites/analyze`, { url: "panaderia-luna.es" });
    await h.drain();
    const before = h.fetchLog.length;
    const outcome = await processJobMessage(h.env, { jobId: a.json.jobId, organizationId: orgId, outboxId: "dup" }, h.deps);
    expect(outcome).toEqual({ action: "ack" });
    expect(h.fetchLog.length).toBe(before);
    expect(await h.db.prepare("SELECT COUNT(*) AS n FROM web_crawls").first("n")).toBe(1);
    expect(await h.db.prepare("SELECT COUNT(*) AS n FROM credit_ledger WHERE entry_kind = 'settle'").first("n")).toBe(1);
  });

  it("blocks malicious URLs synchronously (no job, no credits)", async () => {
    const { h, owner, orgId } = await setup();
    for (const url of ["http://127.0.0.1/admin", "http://169.254.169.254/latest/meta-data", "file:///etc/passwd", "http://localhost:8787", "http://[::1]/", "http://intranet/"]) {
      const r = await owner.post(`/api/v1/orgs/${orgId}/sites/analyze`, { url });
      expect(r.status, url).toBe(422);
      expect(r.json.code).toBe("url_blocked");
    }
    expect(await h.db.prepare("SELECT COUNT(*) AS n FROM jobs").first("n")).toBe(0);
  });

  it("DNS that resolves to a private IP fails the job permanently and releases credits", async () => {
    const { h, owner, orgId } = await setup({}, { "rebind.attacker.com": ["10.0.0.7"] });
    const r = await owner.post(`/api/v1/orgs/${orgId}/sites/analyze`, { url: "https://rebind.attacker.com/" });
    expect(r.status).toBe(202);
    await h.drain();
    const job = (await owner.get(`/api/v1/orgs/${orgId}/jobs/${r.json.jobId}`)).json.job;
    expect(job.state).toBe("failed");
    expect(job.failure_code).toBe("url_blocked:private_address");
    expect(job.attempts).toBe(1);
    expect(h.fetchLog.length).toBe(0);
    expect((await owner.get(`/api/v1/orgs/${orgId}/billing`)).json.balance).toBe(50);
  });

  it("redirect to an internal address is blocked mid-crawl", async () => {
    const { h, owner, orgId } = await setup({ "https://redir.es/": { status: 302, location: "http://169.254.169.254/latest/meta-data/" } });
    const r = await owner.post(`/api/v1/orgs/${orgId}/sites/analyze`, { url: "https://redir.es/" });
    await h.drain();
    const job = (await owner.get(`/api/v1/orgs/${orgId}/jobs/${r.json.jobId}`)).json.job;
    expect(job.state).toBe("failed");
    expect(job.failure_code).toBe("url_blocked:ip_literal_blocked");
  });

  it("transient errors retry with backoff and end in the dead-letter state after max attempts", async () => {
    const { h, owner, orgId } = await setup({ "https://caido.es/": { throws: true } });
    const r = await owner.post(`/api/v1/orgs/${orgId}/sites/analyze`, { url: "https://caido.es/" });
    await h.drain();
    let job = (await owner.get(`/api/v1/orgs/${orgId}/jobs/${r.json.jobId}`)).json.job;
    expect(job.state).toBe("queued");
    expect(job.attempts).toBe(1);
    expect(job.retry_after).toBeTruthy();
    const msg = { jobId: r.json.jobId, organizationId: orgId, outboxId: "x" };
    expect((await processJobMessage(h.env, msg, h.deps)).action).toBe("retry");
    expect(await processJobMessage(h.env, msg, h.deps)).toEqual({ action: "ack" });
    job = (await owner.get(`/api/v1/orgs/${orgId}/jobs/${r.json.jobId}`)).json.job;
    expect(job.state).toBe("failed");
    expect(job.attempts).toBe(3);
    expect(job.dead_lettered_at).toBeTruthy();
    expect((await owner.get(`/api/v1/orgs/${orgId}/billing`)).json.balance).toBe(50);
  });

  it("cancelling a queued job prevents execution and releases the reservation", async () => {
    const { h, owner, orgId } = await setup();
    // Simulate Cloudflare Queues: messages are captured and delivered later.
    const sent: Array<{ jobId: string; organizationId: string; outboxId: string }> = [];
    h.env.JOBS_QUEUE = { send: async (m: (typeof sent)[number]) => void sent.push(m) } as unknown as Queue<(typeof sent)[number]>;
    const r = await owner.post(`/api/v1/orgs/${orgId}/sites/analyze`, { url: "panaderia-luna.es" });
    expect(sent).toHaveLength(1);
    expect(await h.db.prepare("SELECT status FROM outbox_events").first("status")).toBe("dispatched");
    expect((await owner.post(`/api/v1/orgs/${orgId}/jobs/${r.json.jobId}/cancel`)).status).toBe(200);
    expect(await processJobMessage(h.env, sent[0]!, h.deps)).toEqual({ action: "ack" });
    const job = (await owner.get(`/api/v1/orgs/${orgId}/jobs/${r.json.jobId}`)).json.job;
    expect(job.state).toBe("cancelled");
    expect(h.fetchLog.length).toBe(0);
    expect((await owner.get(`/api/v1/orgs/${orgId}/billing`)).json.balance).toBe(50);
  });

  it("enforces plan quotas (analyses/month and credits)", async () => {
    const { h, owner, orgId } = await setup();
    for (let i = 0; i < 3; i++) {
      expect((await owner.post(`/api/v1/orgs/${orgId}/sites/analyze`, { url: "panaderia-luna.es" })).status).toBe(202);
      await h.drain();
    }
    const fourth = await owner.post(`/api/v1/orgs/${orgId}/sites/analyze`, { url: "panaderia-luna.es" });
    expect(fourth.status).toBe(402);
    expect(fourth.json.code).toBe("plan_limit");
  });
});

describe("Tenant fairness limits", () => {
  it("at most 2 concurrent analyses per organization", async () => {
    const { owner, orgId, h } = await setup();
    await h.db.prepare("UPDATE organizations SET plan_code = 'growth' WHERE id = ?").bind(orgId).run();
    expect((await owner.post(`/api/v1/orgs/${orgId}/sites/analyze`, { url: "panaderia-luna.es" })).status).toBe(202);
    expect((await owner.post(`/api/v1/orgs/${orgId}/sites/analyze`, { url: "panaderia-luna.es" })).status).toBe(202);
    await h.drain();
    // Simulate two analyses still in progress (a real crawl takes seconds to minutes).
    await h.db.prepare("UPDATE jobs SET state = 'running', started_at = ? WHERE organization_id = ?").bind(new Date().toISOString(), orgId).run();
    const third = await owner.post(`/api/v1/orgs/${orgId}/sites/analyze`, { url: "panaderia-luna.es" });
    expect(third.status).toBe(429);
    expect(third.json.code).toBe("too_many_active_jobs");
    await h.db.prepare("UPDATE jobs SET state = 'completed' WHERE organization_id = ?").bind(orgId).run();
    expect((await owner.post(`/api/v1/orgs/${orgId}/sites/analyze`, { url: "panaderia-luna.es" })).status).toBe(202);
  });
});

describe("Billing (Stripe sandbox contract)", () => {
  const secret = "whsec_fixture_secret";
  async function signed(body: object, t = Math.floor(Date.now() / 1000)) {
    const raw = JSON.stringify(body);
    return { raw, header: `t=${t},v1=${await hmacSha256Hex(secret, `${t}.${raw}`)}` };
  }
  async function postWebhook(h: ReturnType<typeof createHarness>, raw: string, header: string) {
    const res = await h.app.request("/api/v1/webhooks/stripe", { method: "POST", headers: { "stripe-signature": header, "content-type": "application/json" }, body: raw }, h.env, h.ctx);
    return { status: res.status, json: (await res.json()) as Record<string, unknown> };
  }

  it("billing is off by default (BILLING_ENABLED unset): checkout and webhook refuse", async () => {
    const { h, owner, orgId } = await setup();
    h.env.STRIPE_WEBHOOK_SECRET = secret;
    const r = await owner.post(`/api/v1/orgs/${orgId}/billing/checkout`, { planCode: "pro" });
    expect(r.status).toBe(503);
    expect(r.json.code).toBe("billing_disabled");
    const { raw, header } = await signed({ id: "evt_off", type: "checkout.session.completed", data: { object: {} } });
    expect((await postWebhook(h, raw, header)).json.code).toBe("billing_disabled");
    expect(await h.db.prepare("SELECT COUNT(*) AS n FROM webhook_events").first("n")).toBe(0);
  });

  it("checkout is honestly unavailable without Stripe credentials", async () => {
    const { h, owner, orgId } = await setup();
    h.env.BILLING_ENABLED = "true";
    const r = await owner.post(`/api/v1/orgs/${orgId}/billing/checkout`, { planCode: "pro" });
    expect(r.status).toBe(503);
    expect(r.json.code).toBe("provider_not_configured");
  });

  it("verifies signatures and processes each event exactly once", async () => {
    const { h, owner, orgId } = await setup();
    h.env.STRIPE_WEBHOOK_SECRET = secret;
    h.env.BILLING_ENABLED = "true";
    const event = { id: "evt_test_001", type: "checkout.session.completed", data: { object: { subscription: "sub_123", metadata: { organization_id: orgId, plan_code: "growth" } } } };
    const { raw, header } = await signed(event);

    // Flip the first hex digit to a DIFFERENT one (replacing it with a fixed digit was a no-op 1/16 of the time).
    const tampered = header.replace(/v1=(.)/, (_m, d: string) => `v1=${d === "0" ? "1" : "0"}`);
    expect((await postWebhook(h, raw, tampered)).status).toBe(400);
    expect((await postWebhook(h, raw, `t=1,v1=${header.split("v1=")[1]}`)).status).toBe(400);

    const first = await postWebhook(h, raw, header);
    expect(first.status).toBe(200);
    const dup = await postWebhook(h, raw, header);
    expect(dup.json.duplicate).toBe(true);

    const bill = (await owner.get(`/api/v1/orgs/${orgId}/billing`)).json;
    expect(bill.plan.code).toBe("growth");
    expect(bill.subscription).toMatchObject({ plan_code: "growth", provider: "stripe", status: "active" });
    expect(bill.ledger.filter((l: { category: string }) => l.category === "plan_upgrade").length).toBe(1);
    expect(bill.balance).toBe(50 + 1500);

    const cancel = await signed({ id: "evt_test_002", type: "customer.subscription.deleted", data: { object: { id: "sub_123", metadata: { organization_id: orgId } } } });
    expect((await postWebhook(h, cancel.raw, cancel.header)).status).toBe(200);
    expect((await owner.get(`/api/v1/orgs/${orgId}/billing`)).json.plan.code).toBe("free");
  });

  it("a billing admin manages billing but cannot analyze sites", async () => {
    const { h, owner, orgId } = await setup();
    await h.db.prepare("UPDATE organizations SET plan_code = 'growth' WHERE id = ?").bind(orgId).run();
    const ba = await h.invite(owner, orgId, "billing@luna.es", "billing_admin");
    expect((await ba.get(`/api/v1/orgs/${orgId}/billing`)).status).toBe(200);
    expect((await ba.post(`/api/v1/orgs/${orgId}/billing/checkout`, { planCode: "pro" })).status).toBe(503);
    expect((await ba.post(`/api/v1/orgs/${orgId}/sites/analyze`, { url: "panaderia-luna.es" })).status).toBe(403);
  });
});
