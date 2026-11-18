import { describe, expect, it } from "vitest";
import { buildGeoRecommendations, matchPage, wilsonInterval, type GeoRecSample } from "../src/geo-recs";

const sample = (over: Partial<GeoRecSample>): GeoRecSample => ({
  promptId: "p1",
  question: "¿Qué empresas de auditoría SEO se recomiendan en Madrid?",
  intent: "comparative",
  category: "sector",
  sampleId: "s1",
  sampledAt: "2026-11-18T10:00:00.000Z",
  model: "gemini-3.5-flash-lite",
  grounded: false,
  mentioned: false,
  cited: false,
  competitorsMentioned: [],
  ...over,
});

describe("wilsonInterval", () => {
  it("matches the textbook values and stays inside [0, 1]", () => {
    expect(wilsonInterval(2, 7)).toEqual({ low: 0.082, high: 0.641 });
    expect(wilsonInterval(0, 5)!.low).toBe(0);
    expect(wilsonInterval(5, 5)!.high).toBe(1);
    expect(wilsonInterval(50, 100)).toEqual({ low: 0.404, high: 0.596 });
  });
  it("returns null for impossible inputs", () => {
    expect(wilsonInterval(0, 0)).toBeNull();
    expect(wilsonInterval(3, 2)).toBeNull();
    expect(wilsonInterval(-1, 2)).toBeNull();
  });
});

describe("matchPage", () => {
  const pages = [
    { url: "https://x.es/", title: "Inicio", h1: "Crecimiento" },
    { url: "https://x.es/auditoria-seo-madrid", title: "Auditoría SEO en Madrid", h1: null },
    { url: "https://x.es/precios", title: "Precios", h1: "Planes" },
  ];
  it("picks the page that shares the most keywords (accent-insensitive)", () => {
    expect(matchPage("¿Qué empresas de auditoría SEO se recomiendan en Madrid?", pages, "X")!.page.url).toBe("https://x.es/auditoria-seo-madrid");
  });
  it("returns null when no page is about the topic", () => {
    expect(matchPage("¿Cómo hacer pan de masa madre en casa?", pages, "X")).toBeNull();
  });
});

describe("buildGeoRecommendations", () => {
  const site = { origin: "https://x.es", llmsTxt: true, organizationJsonLd: true, crawledAt: "2026-11-17T00:00:00.000Z" };
  it("maps each observed gap to an action, a target page, evidence and limitations", () => {
    const recs = buildGeoRecommendations({
      brandName: "X Growth",
      samples: [
        sample({ promptId: "c", competitorsMentioned: ["Rival"] }),
        sample({ promptId: "e", intent: "educational", question: "¿Qué es el GEO?", category: "sector" }),
        sample({ promptId: "t", intent: "transactional", question: "¿Dónde contratar una auditoría SEO?", category: "geography" }),
        sample({ promptId: "b", category: "brand", intent: "educational", question: "¿Qué es X Growth?" }),
        sample({ promptId: "ok", mentioned: true }),
      ],
      pages: [{ url: "https://x.es/auditoria-seo-madrid", title: "Auditoría SEO en Madrid", h1: null }],
      site,
    });
    const ids = recs.map((r) => r.id);
    expect(ids).toEqual(["brand-unknown:b", "comparative:c", "transactional:t", "educational:e"]); // rivals present → comparative ranks higher
    expect(ids).not.toContain("comparative:ok"); // mentioned → no gap
    const comp = recs.find((r) => r.id === "comparative:c")!;
    expect(comp).toMatchObject({ priority: "alta", target: { type: "existing_page", url: "https://x.es/auditoria-seo-madrid" }, draft: { kind: "blog_article" }, measurement: "derived" });
    expect(comp.gap).toContain("Rival");
    expect(comp.evidence[0]).toMatchObject({ sampleId: "s1", model: "gemini-3.5-flash-lite", grounded: false });
    expect(comp.limitations.join(" ")).toMatch(/SIN búsqueda web/);
    expect(comp.limitations.join(" ")).toMatch(/no una relación causa-efecto/);
    const edu = recs.find((r) => r.id === "educational:e")!;
    expect(edu).toMatchObject({ priority: "baja", target: { type: "new_page" }, draft: { kind: "faq_aeo" } });
    expect(edu.target.url).toMatch(/^https:\/\/x\.es\/[a-z0-9-]+$/);
    expect(recs.find((r) => r.id === "transactional:t")!.action).toMatch(/LocalBusiness/);
    expect(recs.find((r) => r.id === "brand-unknown:b")!.draft).toMatchObject({ kind: "entity_summary", keyword: "X Growth" });
  });

  it("flags ungrounded brand answers for human fact-checking", () => {
    const recs = buildGeoRecommendations({ brandName: "X", samples: [sample({ category: "brand", mentioned: true })], pages: [], site });
    expect(recs).toHaveLength(1);
    expect(recs[0]).toMatchObject({ id: "brand-verify:p1", priority: "media", draft: null });
    const withHome = buildGeoRecommendations({ brandName: "X", samples: [sample({ category: "brand", mentioned: true, question: "¿X es de fiar?" })], pages: [{ url: "https://x.es/", title: "X", h1: null }], site });
    expect(withHome[0]!.target).toMatchObject({ type: "existing_page", url: "https://x.es/" });
  });

  it("adds site signals only when the crawl proves they are missing (unknown → nothing)", () => {
    const missing = buildGeoRecommendations({ brandName: "X", samples: [], pages: [], site: { ...site, llmsTxt: false, organizationJsonLd: false } });
    expect(missing.map((r) => r.id)).toEqual(["site:organization-jsonld", "site:llms-txt"]);
    const unknown = buildGeoRecommendations({ brandName: "X", samples: [], pages: [], site: { origin: null, llmsTxt: null, organizationJsonLd: null, crawledAt: null } });
    expect(unknown).toEqual([]);
  });

  it("never promises results", () => {
    const recs = buildGeoRecommendations({ brandName: "X", samples: [sample({}), sample({ promptId: "t", intent: "transactional" })], pages: [], site: { ...site, llmsTxt: false } });
    const text = JSON.stringify(recs).toLowerCase();
    expect(text).not.toMatch(/garantizamos|te garantiza|asegura(mos)? (la|el|que)|seguro que/);
    expect(recs.every((r) => r.limitations.length > 0)).toBe(true);
  });
});
