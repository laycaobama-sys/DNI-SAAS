import { describe, expect, it } from "vitest";
import { createHarness, html } from "./helpers";

/**
 * Increment 1 — domain → audit with evidence → reviewable draft → export, with NO AI binding and no
 * external connector: everything here must work with the AI quota spent and every integration off.
 */
const SITE = {
  "https://estudio-norte.es/": {
    body: html({
      title: "Estudio Norte | Arquitectura sostenible en Bilbao",
      desc: "Estudio de arquitectura en Bilbao especializado en rehabilitación sostenible y vivienda pasiva. Primera consulta sin compromiso.",
      h1: "Arquitectura que cuida",
      extraHead: `<link rel="canonical" href="https://estudio-norte.es/"><meta property="og:title" content="Estudio Norte"><meta property="og:image" content="/og.svg"><script type="application/ld+json">{"@context":"https://schema.org","@type":"Organization","name":"Estudio Norte"}</script>`,
      links: ["/aviso-legal", "/privacidad", "/llms.txt", "/feed"],
    }),
  },
  "https://estudio-norte.es/aviso-legal": { body: html({ title: "Aviso legal | Estudio Norte", h1: "Aviso legal" }) },
  "https://estudio-norte.es/privacidad": { body: html({ title: "Privacidad | Estudio Norte", h1: "Privacidad" }) },
  "https://estudio-norte.es/llms.txt": { body: "# Estudio Norte\n> Arquitectura sostenible.", type: "text/plain" },
  "https://estudio-norte.es/feed": { body: "<rss></rss>", type: "application/rss+xml" },
  "https://estudio-norte.es/og.svg": { body: '<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630"></svg>', type: "image/svg+xml" },
  "https://estudio-norte.es/robots.txt": { body: "User-agent: *\nAllow: /", type: "text/plain" },
};

async function audited(plan = "starter") {
  const h = createHarness({ site: SITE });
  const owner = await h.signup("owner@norte.es", "Nerea");
  const orgId = await h.createOrg(owner, "Estudio Norte SL", plan);
  const start = await owner.post(`/api/v1/orgs/${orgId}/sites/analyze`, { url: "https://estudio-norte.es" }, { "idempotency-key": "journey-analysis-01" });
  expect(start.status).toBe(202);
  await h.drain();
  const job = (await owner.get(`/api/v1/orgs/${orgId}/jobs/${start.json.jobId}`)).json.job;
  expect(job.state).toBe("completed");
  const O = `/api/v1/orgs/${orgId}`;
  return { h, owner, orgId, O, crawlId: job.output.crawlId as string, planId: job.output.planId as string };
}
const balance = async (owner: { get: (p: string) => Promise<{ json: { balance: number } }> }, O: string) => (await owner.get(`${O}/billing`)).json.balance;

describe("Increment 1: domain → audit with evidence → draft → export (no AI, no connectors)", () => {
  it("the audit has evidence, page types, potential and no non-HTML pages", async () => {
    const { h, owner, O, crawlId } = await audited();
    const v = (await owner.get(`${O}/crawls/${crawlId}`)).json;
    // B5: llms.txt is checked apart and non-HTML responses (a feed) are skipped, never listed as pages.
    expect(v.pages.map((p: { final_url: string }) => p.final_url)).not.toContain("https://estudio-norte.es/llms.txt");
    expect(v.crawl.llms_txt_found).toBe(1);
    expect(v.crawl.skipped).toEqual(expect.arrayContaining([expect.objectContaining({ url: "https://estudio-norte.es/feed", reason: "not_html" })]));
    expect(h.fetchLog.filter((u) => u === "https://estudio-norte.es/llms.txt")).toHaveLength(1);
    // B6: the SVG og:image is a home-page finding with its evidence.
    const og = v.issues.find((i: { rule_key: string }) => i.rule_key === "og_image_format");
    expect(og).toMatchObject({ url: "https://estudio-norte.es/", page_type: "home" });
    expect(og.evidence).toMatchObject({ format: "svg", ogImage: "https://estudio-norte.es/og.svg" });
    expect(h.fetchLog).toContain("https://estudio-norte.es/og.svg");
    // B7/B8: second indicator; legal-only findings sink below everything else.
    expect(v.potential).toMatchObject({ measurement: "derived", level: "bajo" });
    const opps = v.crawl.opportunities as Array<{ ruleKey: string; legalOnly: boolean; estimateHours: number }>;
    const firstLegal = opps.findIndex((o) => o.legalOnly);
    if (firstLegal >= 0) expect(opps.slice(firstLegal).every((o) => o.legalOnly)).toBe(true);
    expect(opps.every((o) => typeof o.estimateHours === "number" && o.estimateHours <= 40)).toBe(true);
    // B15: brand profile and plan creation are in the audit log.
    const actions = (await h.db.prepare("SELECT action FROM audit_logs WHERE organization_id = (SELECT organization_id FROM web_crawls WHERE id = ?)").bind(crawlId).all<{ action: string }>()).results.map((r) => r.action);
    expect(actions).toEqual(expect.arrayContaining(["brand.profile_created", "plan.created"]));
  });

  it("exports the audit report and a finding brief on any plan, Free included", async () => {
    const { owner, O, crawlId } = await audited("free");
    const md = await owner.get(`${O}/crawls/${crawlId}/export?format=md`);
    expect(md.status).toBe(200);
    expect(md.headers.get("content-disposition")).toContain("attachment");
    expect(md.json).toContain("# Informe de auditoría · estudio-norte.es");
    expect(md.json).toContain("Potencial orgánico");
    expect(md.json).toContain("| derivada |");
    expect(md.json).toContain("Evidencia: https://estudio-norte.es/");
    const page = await owner.get(`${O}/crawls/${crawlId}/export?format=html`);
    expect(page.headers.get("content-type")).toContain("text/html");
    expect(page.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(page.json).toContain("<table>");
    const brief = await owner.get(`${O}/crawls/${crawlId}/findings/og_image_format/brief?format=md`);
    expect(brief.status).toBe(200);
    expect(brief.json).toContain("BORRADOR NO APROBADO");
    expect(brief.json).toContain("## Evidencia (anexo)");
    expect(brief.json).toContain("https://estudio-norte.es/og.svg");
    expect((await owner.get(`${O}/crawls/${crawlId}/findings/not_a_rule/brief`)).status).toBe(404);
    // Saving an editable draft is Content Studio (Starter+): Free gets a clear 402, not a broken button.
    expect((await owner.post(`${O}/content/from-finding`, { crawlId, ruleKey: "og_image_format" })).status).toBe(402);
  });

  it("creates the draft without AI or credits, blocks approval until it is complete, and exports it with evidence", async () => {
    const { h, owner, O, crawlId } = await audited();
    const before = await balance(owner, O);
    const r = await owner.post(`${O}/content/from-finding`, { crawlId, ruleKey: "og_image_format" });
    expect(r.status).toBe(201);
    expect(r.json).toMatchObject({ status: "draft", version: 1, credits: 0, provider: null, kind: "meta_tags" });
    expect(r.json.brief).toMatchObject({ origin: "audit_finding", finding: { ruleKey: "og_image_format", crawlId, measurement: "observed" } });
    expect(r.json.measurement).toMatch(/sin IA/);
    expect(r.json.bodyMd).toContain("https://estudio-norte.es/og.svg");
    expect(await balance(owner, O)).toBe(before);
    // Idempotent: the same finding opens the same draft.
    const again = await owner.post(`${O}/content/from-finding`, { crawlId, ruleKey: "og_image_format" });
    expect(again.status).toBe(200);
    expect(again.json).toMatchObject({ id: r.json.id, reused: true });

    const C = `${O}/content/${r.json.id}`;
    const detail = (await owner.get(C)).json;
    expect(detail.checks.find((x: { key: string }) => x.key === "placeholders").level).toBe("blocking");
    expect((await owner.post(`${C}/submit`)).status).toBe(200);
    const blocked = await owner.post(`${C}/approve`, { note: "" });
    expect(blocked.status).toBe(422);
    expect(blocked.json.code).toBe("draft_checks_failed");

    // The editor completes it (and mentions an unverified price and an unsourced figure).
    const filled = detail.bodyMd.replace(/\[(COMPLETAR|VERIFICAR)[^\]]*\]/g, "https://estudio-norte.es/og.png") + "\nEl rediseño cuesta 90 € y mejora un 30 % la vista previa.\n";
    expect((await owner.patch(C, { bodyMd: filled, expectedVersion: 1 })).status).toBe(200);
    expect((await owner.post(`${C}/submit`)).status).toBe(200);
    const needsAck = await owner.post(`${C}/approve`, { note: "" });
    expect(needsAck.status).toBe(422);
    expect(needsAck.json.code).toBe("draft_checks_ack_required");
    expect(needsAck.json.checks.map((x: { key: string }) => x.key).sort()).toEqual(["figures", "prices"]);
    const ok = await owner.post(`${C}/approve`, { note: "Revisado", acknowledgeChecks: true });
    expect(ok.status).toBe(200);
    expect(ok.json.status).toBe("approved");
    const log = await h.db.prepare("SELECT after_redacted FROM audit_logs WHERE action = 'content.approve' AND entity_id = ?").bind(r.json.id).first<{ after_redacted: string }>();
    expect(JSON.parse(log!.after_redacted).acknowledgedChecks).toEqual(["figures", "prices"]);

    const exp = await owner.get(`${C}/export?format=html`);
    expect(exp.json).not.toContain("BORRADOR NO APROBADO");
    expect(exp.json).toContain("<table>");
    expect(exp.json).toContain("Evidencia (anexo)");
    expect(exp.json).toContain("Origen: hallazgo de la auditoría");
    expect(exp.json).not.toMatch(/<script/i);
    const expMd = await owner.get(`${C}/export?format=md`);
    expect(expMd.json).toContain("## Evidencia (anexo)");
  });

  it("writes a manual draft with no AI binding at all, and never crosses tenants", async () => {
    const { h, owner, O, crawlId } = await audited();
    const before = await balance(owner, O);
    const m = await owner.post(`${O}/content/manual`, { kind: "faq_aeo", title: "Preguntas sobre rehabilitación" });
    expect(m.status).toBe(201);
    expect(m.json).toMatchObject({ credits: 0, provider: null, status: "draft" });
    expect(m.json.bodyMd).toContain("[COMPLETAR");
    expect(await balance(owner, O)).toBe(before);
    // Another organisation cannot turn our audit into its draft.
    const eve = await h.signup("eve@x.es", "Eve");
    const evil = await h.createOrg(eve, "Evil", "starter");
    expect((await eve.post(`/api/v1/orgs/${evil}/content/from-finding`, { crawlId, ruleKey: "og_image_format" })).status).toBe(404);
    expect((await eve.get(`/api/v1/orgs/${evil}/crawls/${crawlId}/export`)).status).toBe(404);
    expect((await eve.get(`/api/v1/orgs/${evil}/crawls/${crawlId}/findings/og_image_format/brief`)).status).toBe(404);
  });

  it("heals plans stored with internal phase codes (B3)", async () => {
    const { h, owner, O, planId } = await audited();
    await h.db
      .prepare("UPDATE growth_tasks SET status = 'blocked', blocked_reason = 'Integración disponible en la fase F3 (aún no conectada).' WHERE plan_id = ? AND channel = 'measurement'")
      .bind(planId)
      .run();
    const plan = (await owner.get(`${O}/plans/${planId}`)).json;
    const m = plan.tasks.find((t: { channel: string }) => t.channel === "measurement");
    expect(m).toMatchObject({ status: "todo", blocked_reason: null });
    expect(JSON.stringify(plan)).not.toMatch(/\bF\d\b/);
  });
});
