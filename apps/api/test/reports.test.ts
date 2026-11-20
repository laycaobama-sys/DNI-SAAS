/**
 * F3 — explainable GEO recommendations, comparable visibility (Wilson intervals) and the exportable
 * performance report (JSON/CSV) with sources, measurement types and disclaimers.
 */
import { describe, expect, it } from "vitest";
import { createHarness } from "./helpers";

async function setup() {
  const h = createHarness();
  const alice = await h.signup("alice@a.es", "Alice");
  const orgA = await h.createOrg(alice, "Org A", "starter");
  const brandA = (await alice.post(`/api/v1/orgs/${orgA}/brands`, { name: "Tienda A", domain: "tienda-a.es" })).json.id as string;
  const now = Date.now();
  let i = 0;
  // Real-shaped data inserted directly (the sampling path itself is covered by geomonitor.test.ts).
  const sample = async (question: string, intent: string, category: string, mentioned: boolean, competitors: string[] = [], text = "Respuesta.") => {
    const pid = crypto.randomUUID();
    await h.db
      .prepare("INSERT INTO tracked_prompts (id, organization_id, brand_id, question, question_norm, intent, category, engine, locale, region_country) VALUES (?, ?, ?, ?, ?, ?, ?, 'gemini_api', 'es-ES', 'ES')")
      .bind(pid, orgA, brandA, question, `${question.toLowerCase()}-${i}`, intent, category)
      .run();
    await h.db
      .prepare(
        `INSERT INTO ai_response_samples (id, organization_id, brand_id, prompt_id, engine, model, grounded, method, question, locale, region_country, status, answer_text, brand_mentioned, brand_cited, competitors_json, sampled_at)
         VALUES (?, ?, ?, ?, 'gemini_api', 'gemini-3.5-flash-lite', 0, 'gemini-api:generateContent:v1', ?, 'es-ES', 'ES', 'ok', ?, ?, 0, ?, ?)`,
      )
      .bind(crypto.randomUUID(), orgA, brandA, pid, question, text, mentioned ? 1 : 0, JSON.stringify(competitors.map((name) => ({ name, domain: null, mentioned: true, cited: false }))), new Date(now - ++i * 60_000).toISOString())
      .run();
  };
  await sample("¿Qué es Tienda A?", "educational", "brand", true);
  await sample("¿Cuál es la mejor tienda de zapatillas de trail?", "comparative", "product", false, ["Rival"]);
  await sample("=HYPERLINK(\"http://evil\") comprar zapatillas", "transactional", "product", false);
  await sample("¿Cómo elegir zapatillas de trail?", "educational", "sector", true);
  // A crawl of the brand's site with a page about trail shoes, no llms.txt and no Organization JSON-LD.
  const siteId = crypto.randomUUID();
  const jobId = crypto.randomUUID();
  const crawlId = crypto.randomUUID();
  await h.db.prepare("INSERT INTO sites (id, organization_id, brand_id, url, origin) VALUES (?, ?, ?, 'https://tienda-a.es/', 'https://tienda-a.es')").bind(siteId, orgA, brandA).run();
  await h.db.prepare("INSERT INTO jobs (id, organization_id, kind, state, idempotency_key) VALUES (?, ?, 'analyze_url', 'completed', ?)").bind(jobId, orgA, jobId).run();
  await h.db
    .prepare("INSERT INTO web_crawls (id, organization_id, site_id, job_id, status, pages_limit, llms_txt_found, completed_at) VALUES (?, ?, ?, ?, 'completed', 10, 0, ?)")
    .bind(crawlId, orgA, siteId, jobId, new Date().toISOString())
    .run();
  for (const [url, title, ld] of [["https://tienda-a.es/", "Tienda A", ["WebSite"]], ["https://tienda-a.es/zapatillas-trail", "Zapatillas de trail", []]] as const)
    await h.db
      .prepare("INSERT INTO crawl_pages (id, organization_id, crawl_id, url, final_url, status_code, title, metadata_json) VALUES (?, ?, ?, ?, ?, 200, ?, ?)")
      .bind(crypto.randomUUID(), orgA, crawlId, url, url, title, JSON.stringify({ jsonLdTypes: ld }))
      .run();
  return { h, alice, orgA, brandA };
}

describe("GEO comparable visibility", () => {
  it("adds 95 % Wilson intervals to the overall rate, per intent and per competitor", async () => {
    const { alice, orgA, brandA } = await setup();
    const v = (await alice.get(`/api/v1/orgs/${orgA}/brands/${brandA}/geo/visibility`)).json;
    expect(v).toMatchObject({ sampledPrompts: 4, mentioned: 2, mentionRate: 0.5, mentionRateInterval: { low: 0.15, high: 0.85 }, measurement: "observed_sample" });
    expect(v.intervalMethod).toMatch(/Wilson/);
    expect(v.byIntent.find((x: { intent: string }) => x.intent === "comparative")).toMatchObject({ sampled: 1, mentioned: 0, interval: { low: 0 } });
    expect(v.competitors[0]).toMatchObject({ name: "Rival", mentioned: 1, mentionRate: 0.25 });
  });
});

describe("GEO explainable recommendations", () => {
  it("maps gaps to pages/actions with evidence, method and limitations (no AI call)", async () => {
    const { h, alice, orgA, brandA } = await setup();
    let calls = 0;
    const real = h.deps.fetchImpl;
    h.deps.fetchImpl = ((...a: Parameters<typeof fetch>) => (calls++, real(...a))) as typeof fetch;
    const r = (await alice.get(`/api/v1/orgs/${orgA}/brands/${brandA}/geo/recommendations`)).json;
    expect(calls).toBe(0);
    expect(r.measurement).toBe("derived");
    expect(r.method).toMatch(/Reglas deterministas/);
    const ids = r.items.map((x: { id: string }) => x.id.split(":")[0]);
    expect(ids).toEqual(expect.arrayContaining(["brand-verify", "transactional", "comparative", "site"]));
    const comp = r.items.find((x: { id: string }) => x.id.startsWith("comparative:"));
    expect(comp.target).toMatchObject({ type: "existing_page", url: "https://tienda-a.es/zapatillas-trail" });
    expect(comp.evidence[0]).toMatchObject({ grounded: false, mentioned: false, competitorsMentioned: ["Rival"] });
    expect(JSON.stringify(r)).not.toMatch(/flash-lite|gemini-\d/i); // engine kept, model id hidden
    expect(r.items.some((x: { id: string }) => x.id === "site:organization-jsonld")).toBe(true);
    expect(r.items.some((x: { id: string }) => x.id === "site:llms-txt")).toBe(true);
    expect(r.basedOn).toMatchObject({ sampledPrompts: 4, crawledPages: 2 });
    expect(r.caveats.join(" ")).toMatch(/no son una predicción ni una garantía/);
  });

  it("is tenant-isolated", async () => {
    const { h, orgA, brandA } = await setup();
    const mallory = await h.signup("mallory@b.es");
    await h.createOrg(mallory, "Org B", "starter");
    expect((await mallory.get(`/api/v1/orgs/${orgA}/brands/${brandA}/geo/recommendations`)).status).toBe(404);
  });
});

describe("Exportable performance report", () => {
  it("JSON states source, measurement and caveats per section; unconnected sections say so", async () => {
    const { alice, orgA, brandA } = await setup();
    const r = await alice.get(`/api/v1/orgs/${orgA}/reports/performance?brandId=${brandA}`);
    expect(r.status).toBe(200);
    expect(r.json.sections.searchConsole).toMatchObject({ status: "not_connected" });
    expect(r.json.sections.analytics).toMatchObject({ status: "not_connected" });
    expect(r.json.sections.geo.status).toBe("ok");
    expect(r.json.sections.geo.visibility).toMatchObject({ measurement: "observed_sample", mentionRateInterval: { low: 0.15, high: 0.85 } });
    expect(r.json.disclaimers.join(" ")).toMatch(/No incluye datos estimados ni de demostración/);
  });

  it("CSV download: one metric per row with source/period/measurement, formula injection neutralised, export audited", async () => {
    const { h, alice, orgA, brandA } = await setup();
    const res = await alice.get(`/api/v1/orgs/${orgA}/reports/performance?brandId=${brandA}&format=csv`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/csv/);
    expect(res.headers.get("content-disposition")).toMatch(/attachment; filename="informe-tienda-a\.es-\d{4}-\d{2}-\d{2}\.csv"/);
    const csv = res.json as string;
    // Response.text() strips the UTF-8 BOM that makes Excel read the file as UTF-8.
    const lines = csv.replace(String.fromCharCode(0xfeff), "").split("\r\n");
    expect(lines[0]).toBe("seccion,metrica,valor,desde,hasta,fuente,tipo_de_medida,observado_en,nota");
    expect(csv).toContain("Search Console,estado,not_connected");
    expect(csv).toMatch(/Visibilidad en IA,Tasa de mención,0\.5,.*derived/);
    expect(csv).toContain("IC95% 0.15–0.85");
    expect(csv).toContain(`"'=HYPERLINK(""http://evil"") comprar zapatillas"`);
    expect(csv).not.toMatch(/(^|,)=HYPERLINK/m);
    const audit = await h.db.prepare("SELECT action, after_redacted FROM audit_logs WHERE organization_id = ? AND action = 'report.export'").bind(orgA).first<{ action: string; after_redacted: string }>();
    expect(audit).toMatchObject({ action: "report.export" });
    expect(JSON.parse(audit!.after_redacted)).toMatchObject({ format: "csv" });
  });

  it("another tenant cannot export my report or name my brand", async () => {
    const { h, orgA, brandA } = await setup();
    const mallory = await h.signup("mallory@b.es");
    const orgB = await h.createOrg(mallory, "Org B", "starter");
    expect((await mallory.get(`/api/v1/orgs/${orgA}/reports/performance?format=json`)).status).toBe(404);
    expect((await mallory.get(`/api/v1/orgs/${orgB}/reports/performance?brandId=${brandA}`)).status).toBe(404);
  });
});
