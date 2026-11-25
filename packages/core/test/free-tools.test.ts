import { describe, expect, it } from "vitest";
import { buildFaq, buildLlmsFile, buildOgTags, buildSchema, jsonLdScript, robotsAllows, robotsAiReport, schemaProblems, sitemapReport, trafficValue, truncateToWidth } from "../src/free-tools";

describe("robots.txt (RFC 9309)", () => {
  const txt = `# comentario
User-agent: GPTBot
Disallow: /

User-agent: OAI-SearchBot
User-agent: PerplexityBot
Allow: /

User-agent: *
Disallow: /wp-admin/
Allow: /wp-admin/admin-ajax.php
Disallow: /privado$

Sitemap: https://tuweb.com/sitemap.xml`;

  it("uses the most specific group and the longest matching rule", () => {
    expect(robotsAllows(txt, "GPTBot")).toEqual({ allowed: false, group: "GPTBot" });
    expect(robotsAllows(txt, "gptbot").allowed).toBe(false); // case-insensitive
    expect(robotsAllows(txt, "PerplexityBot")).toEqual({ allowed: true, group: "PerplexityBot" });
    expect(robotsAllows(txt, "ClaudeBot")).toEqual({ allowed: true, group: "*" });
    expect(robotsAllows(txt, "ClaudeBot", "/wp-admin/x").allowed).toBe(false);
    expect(robotsAllows(txt, "ClaudeBot", "/wp-admin/admin-ajax.php").allowed).toBe(true);
    expect(robotsAllows(txt, "ClaudeBot", "/privado").allowed).toBe(false);
    expect(robotsAllows(txt, "ClaudeBot", "/privado/otra").allowed).toBe(true); // $ anchors the end
    expect(robotsAllows("", "Googlebot")).toEqual({ allowed: true, group: "ninguno" });
    expect(robotsAllows("User-agent: *\nDisallow:", "Googlebot").allowed).toBe(true);
  });

  it("reports every documented AI bot and the declared sitemaps", () => {
    const r = robotsAiReport(txt);
    expect(r.bots.find((b) => b.ua === "GPTBot")!.allowed).toBe(false);
    expect(r.bots.find((b) => b.ua === "OAI-SearchBot")!.allowed).toBe(true);
    expect(r.sitemaps).toEqual(["https://tuweb.com/sitemap.xml"]);
    expect(r.bots.length).toBeGreaterThanOrEqual(10);
  });
});

describe("generators", () => {
  it("llms.txt follows the llmstxt.org layout and drops invalid links", () => {
    const f = buildLlmsFile({ name: "Panadería Luna", summary: "Pan de masa madre en Valencia.", sections: [{ title: "Páginas", links: [{ title: "Precios", url: "https://luna.es/precios", note: "con IVA" }, { title: "Rota", url: "javascript:alert(1)" }] }] });
    expect(f).toBe("# Panadería Luna\n\n> Pan de masa madre en Valencia.\n\n## Páginas\n\n- [Precios](https://luna.es/precios): con IVA\n");
  });

  it("JSON-LD: only filled fields, https sameAs, escaped for <script> and checked before pasting", () => {
    const ld = buildSchema({ type: "LocalBusiness", name: "Luna", url: "https://luna.es", city: "Valencia", sameAs: ["https://instagram.com/luna", "http://inseguro.es"], description: "" });
    expect(ld).toEqual({ "@context": "https://schema.org", "@type": "LocalBusiness", name: "Luna", url: "https://luna.es", sameAs: ["https://instagram.com/luna"], address: { "@type": "PostalAddress", addressLocality: "Valencia", addressCountry: "ES" } });
    expect(jsonLdScript({ x: "</script><script>" })).not.toContain("</script><script>");
    expect(schemaProblems({ type: "LocalBusiness", name: "", url: "http://a.es" })).toHaveLength(3);
    expect(buildSchema({ type: "Article", name: "Guía", url: "https://a.es/g", author: "Ana" })).toMatchObject({ "@type": "Article", headline: "Guía", author: { "@type": "Person", name: "Ana" } });
  });

  it("FAQ: escaped HTML and a FAQPage with only complete pairs", () => {
    const r = buildFaq([{ q: "¿Envíos <b>?", a: "Sí." }, { q: "Sin respuesta", a: "" }]);
    expect(r.count).toBe(1);
    expect(r.html).toContain("¿Envíos &lt;b&gt;?");
    expect(r.jsonLd).toMatchObject({ "@type": "FAQPage", mainEntity: [{ name: "¿Envíos <b>?", acceptedAnswer: { text: "Sí." } }] });
  });

  it("Open Graph tags escape quotes", () => {
    const t = buildOgTags({ title: 'Pan "rico"', description: "", url: "https://a.es", image: "" });
    expect(t).toContain('content="Pan &quot;rico&quot;"');
    expect(t).not.toContain("og:description");
    expect(t).toContain('name="twitter:card" content="summary"');
  });
});

describe("checks and estimates", () => {
  it("sitemap: duplicates, http, other hosts and bad dates", () => {
    const xml = `<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
<url><loc>https://a.es/</loc><lastmod>2026-11-01</lastmod></url>
<url><loc>https://a.es/</loc></url>
<url><loc>http://a.es/x</loc><lastmod>01/11/2026</lastmod></url>
<url><loc>https://otro.es/y</loc></url></urlset>`;
    const r = sitemapReport(xml);
    expect(r).toMatchObject({ kind: "urlset", urls: 4, withLastmod: 2, duplicates: ["https://a.es/"], notHttps: ["http://a.es/x"], badDates: ["01/11/2026"] });
    expect(r.problems).toHaveLength(4);
    expect(sitemapReport("<html></html>").problems[0]).toMatch(/No es un sitemap/);
  });

  it("SERP truncation by measured width cuts at a word", () => {
    const m = (s: string) => s.length * 10;
    expect(truncateToWidth("Corto", 100, m)).toEqual({ text: "Corto", cut: false });
    const r = truncateToWidth("Panadería artesana en Valencia con envío", 200, m);
    expect(r.cut).toBe(true);
    expect(m(r.text)).toBeLessThanOrEqual(200);
    expect(r.text.endsWith(" …")).toBe(true);
  });

  it("traffic value is visits × CPC and rejects nonsense", () => {
    expect(trafficValue(1000, 0.85)).toEqual({ monthly: 850, yearly: 10200 });
    expect(trafficValue(-1, 1)).toBeNull();
    expect(trafficValue(Number.NaN, 1)).toBeNull();
  });
});
