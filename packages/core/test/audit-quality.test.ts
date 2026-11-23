import { describe, expect, it } from "vitest";
import { extractPage } from "../src/extract";
import { estimateHours, healthScore, prioritize, runSeoRules, type CrawledPage, type SiteContext } from "../src/seo-rules";
import { imageInfo, ogImageProblems } from "../src/image-meta";
import { classifyPage, organicPotential } from "../src/organic";
import { generateGrowthPlan, isLegacyPhaseBlock } from "../src/plan";
import { buildAdvisorMessages, validateAdvisorAnswer, type AdvisorContext } from "../src/ai";
import { brandColorsFromCss, emailRole, extractBrand, isNeutralColor, isTopicHeading } from "../src/brand";

/** Audit quality fixes from the external review: B5–B8 and B3 (plan honesty). */

const HOME = `<!doctype html><html lang="es"><head><title>Estudio Norte | Arquitectura sostenible en Bilbao</title>
<meta name="description" content="Estudio de arquitectura en Bilbao especializado en rehabilitación sostenible y vivienda pasiva. Primera consulta sin compromiso.">
<meta name="viewport" content="width=device-width, initial-scale=1"><link rel="canonical" href="https://norte.es/">
<meta property="og:title" content="Estudio Norte"><meta property="og:image" content="https://norte.es/og.svg">
<script type="application/ld+json">{"@context":"https://schema.org","@type":"Organization","name":"Estudio Norte"}</script>
</head><body><h1>Arquitectura que cuida</h1><h2>Rehabilitación</h2><h2>Vivienda pasiva</h2><h2>Preguntas frecuentes</h2>
<p>${"Proyectos de rehabilitación energética con seguimiento de obra. ".repeat(45)}</p>
<a href="/aviso-legal">Aviso legal</a><a href="/privacidad">Privacidad</a></body></html>`;
const LEGAL = (t: string) => `<html lang="es"><head><title>${t} | Estudio Norte</title><meta name="viewport" content="width=device-width"></head><body><h1>${t}</h1><p>Texto legal.</p></body></html>`;

const page = (url: string, html: string, extra: Partial<CrawledPage> = {}): CrawledPage => ({
  url, finalUrl: url, status: 200, contentType: "text/html", durationMs: 120, truncated: false, redirects: [], extraction: extractPage(html, url), ...extra,
});
const site = (pages: CrawledPage[], over: Partial<SiteContext> = {}): SiteContext => ({
  origin: "https://norte.es", homepageUrl: "https://norte.es/", servedOverHttps: true, robotsFound: true, robotsBlocksAll: false,
  sitemapFound: true, sitemapUrlCount: 3, llmsTxtFound: true, pages, ...over,
});

const png = (w: number, h: number) => {
  const b = new Uint8Array(24);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  new DataView(b.buffer).setUint32(16, w);
  new DataView(b.buffer).setUint32(20, h);
  return b;
};
const jpeg = (w: number, h: number) => new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, ...new Array(14).fill(0), 0xff, 0xc0, 0, 17, 8, h >> 8, h & 255, w >> 8, w & 255, 3, 0, 0, 0]);

describe("og:image format and size (B6)", () => {
  it("reads PNG, JPEG, WebP and SVG headers without decoding", () => {
    expect(imageInfo(png(1200, 630))).toEqual({ format: "png", width: 1200, height: 630 });
    expect(imageInfo(jpeg(1600, 900))).toEqual({ format: "jpeg", width: 1600, height: 900 });
    const webp = new Uint8Array(30);
    webp.set([...new TextEncoder().encode("RIFF"), 0, 0, 0, 0, ...new TextEncoder().encode("WEBPVP8X")]);
    webp.set([0x7f, 0x07, 0x00, 0x75, 0x02, 0x00], 24); // 1920×630 stored minus one
    expect(imageInfo(webp)).toEqual({ format: "webp", width: 1920, height: 630 });
    expect(imageInfo(new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"/>'), "image/svg+xml").format).toBe("svg");
  });

  it("flags SVG, small, broken and heavy images; accepts a 1200×630 PNG", () => {
    const base = { url: "https://norte.es/og", status: 200, contentType: "image/png", contentLength: 80_000 };
    expect(ogImageProblems({ ...base, info: imageInfo(png(1200, 630)) })).toEqual([]);
    expect(ogImageProblems({ ...base, contentType: "image/svg+xml", info: { format: "svg", width: null, height: null } })[0]).toMatch(/SVG/);
    expect(ogImageProblems({ ...base, info: imageInfo(png(600, 315)) })[0]).toMatch(/600×315/);
    expect(ogImageProblems({ ...base, status: 404, info: null })[0]).toMatch(/404/);
    expect(ogImageProblems({ ...base, contentLength: 6_000_000, info: imageInfo(png(1200, 630)) })[0]).toMatch(/5 MB/);
  });

  it("becomes a home-page finding with the observed evidence", () => {
    const issues = runSeoRules(site([page("https://norte.es/", HOME)], { ogImage: { url: "https://norte.es/og.svg", status: 200, contentType: "image/svg+xml", contentLength: 900, info: { format: "svg", width: null, height: null } } }));
    const og = issues.find((i) => i.ruleKey === "og_image_format")!;
    expect(og.url).toBe("https://norte.es/");
    expect(og.evidence).toMatchObject({ ogImage: "https://norte.es/og.svg", format: "svg", pageType: "home" });
  });
});

describe("page types and legal weighting (B8)", () => {
  it("classifies home, legal, contact, blog and articles", () => {
    expect(classifyPage("https://norte.es/", "https://norte.es/")).toBe("home");
    expect(classifyPage("https://norte.es/aviso-legal", null)).toBe("legal");
    expect(classifyPage("https://norte.es/legal/privacidad", null)).toBe("legal");
    expect(classifyPage("https://norte.es/politica-de-cookies", null)).toBe("legal");
    expect(classifyPage("https://norte.es/contacto", null)).toBe("contact");
    expect(classifyPage("https://norte.es/blog/", null)).toBe("blog_index");
    expect(classifyPage("https://norte.es/blog/casa-pasiva", null)).toBe("article");
    expect(classifyPage("https://norte.es/proyectos/torre", null, ["BlogPosting"])).toBe("article");
    expect(classifyPage("https://norte.es/servicios", null)).toBe("other");
  });

  it("legal-only findings never top the list, cost little time and do not lower technical health", () => {
    const pages = [page("https://norte.es/", HOME), page("https://norte.es/aviso-legal", LEGAL("Aviso legal")), page("https://norte.es/privacidad", LEGAL("Privacidad")), page("https://norte.es/cookies", LEGAL("Cookies"))];
    const issues = runSeoRules(site(pages));
    const sd = issues.filter((i) => i.ruleKey === "structured_data_missing");
    expect(sd.length).toBe(3);
    expect(sd.every((i) => i.pageType === "legal" && i.evidence["pageType"] === "legal")).toBe(true);
    const opps = prioritize(issues, 20);
    const sdOpp = opps.find((o) => o.ruleKey === "structured_data_missing")!;
    expect(sdOpp.legalOnly).toBe(true);
    expect(sdOpp.pageTypes).toEqual({ legal: 3 });
    expect(sdOpp.estimateHours!).toBeLessThanOrEqual(2);
    // Every non-legal opportunity ranks above every legal-only one.
    const firstLegal = opps.findIndex((o) => o.legalOnly);
    expect(opps.slice(firstLegal).every((o) => o.legalOnly)).toBe(true);
    expect(firstLegal).toBe(opps.filter((o) => !o.legalOnly).length);
    const healthWithLegal = healthScore(issues).score;
    const healthHomeOnly = healthScore(runSeoRules(site([pages[0]!]))).score;
    expect(healthWithLegal).toBe(healthHomeOnly);
  });

  it("template fixes are estimated once, per-page fixes scale with real pages", () => {
    const urls = Array.from({ length: 8 }, (_, i) => ({ url: `https://norte.es/p${i}`, pageType: "other" as const }));
    expect(estimateHours("lang_missing", urls)).toBe(0.5);
    expect(estimateHours("images_missing_alt", urls)).toBe(8);
    expect(estimateHours("images_missing_alt", urls.map((u) => ({ ...u, pageType: "legal" as const })))).toBe(2);
    expect(estimateHours("site_sparse", [{ url: null }])).toBe(16);
  });
});

describe("organic potential and sparse sites (B7)", () => {
  it("a technically clean one-page site gets a low potential and content findings outside technical health", () => {
    const pages = [page("https://norte.es/", HOME), page("https://norte.es/aviso-legal", LEGAL("Aviso legal"))];
    const issues = runSeoRules(site(pages));
    expect(issues.some((i) => i.ruleKey === "site_sparse")).toBe(true);
    expect(issues.some((i) => i.ruleKey === "no_content_section")).toBe(true);
    const withoutContentRules = issues.filter((i) => i.ruleKey !== "site_sparse" && i.ruleKey !== "no_content_section");
    expect(healthScore(issues).score).toBe(healthScore(withoutContentRules).score);

    const pot = organicPotential(
      pages.map((p) => ({ url: p.finalUrl, status: p.status, wordCount: p.extraction!.wordCount, h2: p.extraction!.h2, jsonLdTypes: p.extraction!.jsonLdTypes, internalLinks: 2 })),
      { homepageUrl: "https://norte.es/", sitemapUrlCount: 2 },
    );
    expect(pot.level).toBe("bajo");
    expect(pot.measurement).toBe("derived");
    expect(pot.contentPages).toBe(1);
    expect(pot.hasContentSection).toBe(false);
    expect(pot.signals.find((s) => s.key === "faq")!.points).toBe(10);
    expect(pot.signals.reduce((a, s) => a + s.max, 0)).toBe(100);
  });

  it("a site with a blog and enough content pages scores higher and has no sparse findings", () => {
    const article = (slug: string) => page(`https://norte.es/blog/${slug}`, HOME.replace("<h2>Rehabilitación</h2>", `<h2>Tema ${slug}</h2><h2>Coste ${slug}</h2>`));
    const pages = [page("https://norte.es/", HOME), page("https://norte.es/blog/", HOME), ...["a", "b", "c", "d", "e"].map(article)];
    const issues = runSeoRules(site(pages, { sitemapUrlCount: 12 }));
    expect(issues.some((i) => i.ruleKey === "site_sparse" || i.ruleKey === "no_content_section")).toBe(false);
    const pot = organicPotential(
      pages.map((p) => ({ url: p.finalUrl, status: 200, wordCount: p.extraction!.wordCount, h2: p.extraction!.h2, jsonLdTypes: [], internalLinks: 12 })),
      { homepageUrl: "https://norte.es/", sitemapUrlCount: 12 },
    );
    expect(pot.score).toBeGreaterThanOrEqual(65);
    expect(pot.level).toBe("alto");
  });
});

describe("growth plan honesty (B3)", () => {
  const base = { opportunities: [], brandConfirmed: true };
  it("Search Console/GA4 and content are actionable; only the paid task waits for Meta, without internal codes", () => {
    const tasks = generateGrowthPlan({ ...base, integrations: { searchConsole: false, ga4: true, meta: false, cms: false } });
    const m = tasks.find((t) => t.channel === "measurement")!;
    expect(m.status).toBe("todo");
    expect(m.description).toMatch(/Pendiente de conectar Search Console/);
    expect(tasks.find((t) => t.channel === "content")!.status).toBe("todo");
    const paid = tasks.find((t) => t.channel === "paid")!;
    expect(paid.status).toBe("blocked");
    for (const t of tasks) expect(`${t.title} ${t.description} ${t.blockedReason ?? ""}`).not.toMatch(/\bF\d\b|fase/i);
    const connected = generateGrowthPlan({ ...base, integrations: { searchConsole: true, ga4: true, meta: true, cms: false } });
    expect(connected.find((t) => t.channel === "measurement")!.status).toBe("done");
    expect(connected.find((t) => t.channel === "paid")!.status).toBe("todo");
  });

  it("recognises legacy phase-code blocks only", () => {
    expect(isLegacyPhaseBlock({ status: "blocked", blocked_reason: "Integración disponible en la fase F3 (aún no conectada)." })).toBe(true);
    expect(isLegacyPhaseBlock({ status: "blocked", blocked_reason: "Pendiente de conectar Meta Ads." })).toBe(false);
    expect(isLegacyPhaseBlock({ status: "todo", blocked_reason: "fase F2" })).toBe(false);
  });
});

describe("brand suggestions with their source (B10)", () => {
  const html = `<!doctype html><html lang="es"><head><title>Inicio | Norte</title><meta name="theme-color" content="#0b0b0c">
<style>:root{--bg:#0b0b0c;--ink:#f4f4f0;--accent:#c6f432}.btn{background:var(--accent)}a{color:#c6f432}</style></head>
<body><h1>Arquitectura que cuida</h1><h2>Respuestas claras.</h2><h2>Audita tu web hoy →</h2><h2>Rehabilitación energética de viviendas</h2><h2>Preguntas frecuentes</h2><h2>¿Cuánto cuesta?</h2>
<a href="mailto:privacy@norte.es">Privacidad</a><a href="mailto:hola@norte.es">Escríbenos</a></body></html>`;
  const b = extractBrand([extractPage(html, "https://norte.es/")]);
  const values = (k: string) => b.facts.filter((f) => f.key === k).map((f) => f.value);

  it("takes the accent from the CSS, not the theme-color background", () => {
    expect(values("brand_color")[0]).toMatch(/^#c6f432 · variable CSS --accent/);
    expect(b.facts.find((f) => f.key === "brand_color")).toMatchObject({ method: "css", sourceUrl: "https://norte.es/" });
    expect(b.facts.find((f) => f.key === "theme_color")).toMatchObject({ label: "Color de la barra del navegador (theme-color)", confidence: "low" });
    expect(brandColorsFromCss("body{color:#333;background:#fff;border-color:#e11d48;outline-color:#e11d48}")[0]).toMatchObject({ hex: "#e11d48" });
    expect(isNeutralColor("#0b0b0c")).toBe(true);
  });

  it("does not take calls to action or slogans as services", () => {
    expect(values("topic_candidate")).toEqual(["Rehabilitación energética de viviendas"]);
    expect(isTopicHeading("Audita tu web hoy →")).toBe(false);
    expect(isTopicHeading("Respuestas claras.")).toBe(false);
    expect(isTopicHeading("SEO técnico para clínicas")).toBe(true);
  });

  it("the privacy address is never the contact e-mail", () => {
    expect(values("email")).toEqual(["hola@norte.es"]);
    expect(values("email_privacy")).toEqual(["privacy@norte.es"]);
    expect(emailRole("dpo@norte.es")).toBe("privacy");
  });
});

describe("advisor grounded in the audit (B9)", () => {
  const ctx: AdvisorContext = {
    orgName: "Norte",
    brand: { name: "Estudio Norte" },
    audit: {
      origin: "https://norte.es",
      healthScore: 92,
      completedAt: "2026-11-20T10:00:00Z",
      home: { url: "https://norte.es/", jsonLdTypes: ["Organization"], ogImage: "https://norte.es/og.svg" },
      potential: { score: 22, level: "bajo" },
      opportunities: [
        { title: "La imagen para compartir (og:image) no se mostrará bien", severity: "medium", fix: "PNG 1200×630", affectedCount: 1, urls: ["https://norte.es/"], pageTypes: { home: 1 } },
        { title: "Sin datos estructurados (JSON-LD)", severity: "low", fix: "JSON-LD", affectedCount: 2, urls: ["https://norte.es/aviso-legal", "https://norte.es/privacidad"], pageTypes: { legal: 2 }, legalOnly: true },
      ],
    },
  };

  it("gives the model the evidence URLs, page types and what the home already has", () => {
    const msgs = buildAdvisorMessages(ctx, [], "¿Qué arreglo primero?");
    const data = msgs[1]!.content;
    expect(data).toContain("Evidencia: https://norte.es/aviso-legal ; https://norte.es/privacidad");
    expect(data).toContain("[solo páginas legales]");
    expect(data).toContain("datos estructurados Organization");
    expect(data).toContain("Potencial orgánico");
    const system = msgs[0]!.content;
    expect(system).toMatch(/Evidencia: URL/);
    expect(system).toMatch(/resultados enriquecidos/);
    expect(system).not.toMatch(/requiere aprobación humana en DNI Growth; recuérdalo/);
  });

  it("flags uncited advice, invented URLs, restricted rich-result promises and false JSON-LD claims", () => {
    const bad = validateAdvisorAnswer("Te recomiendo implementar JSON-LD porque tu web no tiene datos estructurados; así conseguirás estrellas en Google. Revisa https://norte.es/servicios.", ctx);
    expect(bad.ok).toBe(false);
    const all = bad.warnings.join(" ");
    expect(all).toMatch(/no aparecen en la auditoría/);
    expect(all).toMatch(/no cita ninguna URL de evidencia/);
    expect(all).toMatch(/resultados enriquecidos/);
    expect(all).toMatch(/La home ya tiene datos estructurados/);
    const good = validateAdvisorAnswer("Prioridad 1: sustituye la og:image SVG por un PNG de 1200×630 (Evidencia: https://norte.es/).", ctx);
    expect(good).toMatchObject({ ok: true, warnings: [] });
    expect(good.citedUrls).toEqual(["https://norte.es/"]);
  });
});
