import type { PageExtraction } from "./extract";
import { ENTITY_TYPE_RE } from "./brand";

/**
 * Deterministic SEO / GEO technical rules. Every issue carries rule key, URL, severity and evidence.
 * Weights are transparent (see RULES table) — the AI layer may only *explain*, never invent findings.
 */
export type Severity = "critical" | "high" | "medium" | "low" | "info";
export type Category = "indexability" | "metadata" | "content" | "structure" | "performance" | "security" | "geo" | "social";

export interface CrawledPage {
  url: string;
  finalUrl: string;
  status: number;
  contentType: string;
  durationMs: number;
  truncated: boolean;
  redirects: string[];
  extraction: PageExtraction | null;
}

export interface SiteContext {
  origin: string;
  homepageUrl: string;
  servedOverHttps: boolean;
  robotsFound: boolean;
  robotsBlocksAll: boolean;
  sitemapFound: boolean;
  sitemapUrlCount: number;
  llmsTxtFound: boolean;
  pages: CrawledPage[];
}

export interface SeoIssue {
  ruleKey: string;
  severity: Severity;
  category: Category;
  url: string | null;
  evidence: Record<string, unknown>;
}

export interface RuleMeta {
  title: string;
  category: Category;
  severity: Severity;
  impact: 1 | 2 | 3 | 4 | 5;
  effort: 1 | 2 | 3 | 4 | 5;
  certainty: number; // 0..1 — how sure we are this is a real problem
  fix: string;
}

export const RULES: Record<string, RuleMeta> = {
  http_error: { title: "Página con error HTTP", category: "indexability", severity: "high", impact: 4, effort: 2, certainty: 0.95, fix: "Corrige la URL, redirígela (301) a una equivalente o elimina los enlaces internos que apuntan a ella." },
  title_missing: { title: "Falta la etiqueta <title>", category: "metadata", severity: "high", impact: 4, effort: 1, certainty: 0.95, fix: "Añade un título único y descriptivo (≈30–60 caracteres) con el término principal de la página." },
  title_multiple: { title: "Varias etiquetas <title>", category: "metadata", severity: "medium", impact: 2, effort: 1, certainty: 0.9, fix: "Deja un único <title> por página." },
  title_too_long: { title: "Título demasiado largo", category: "metadata", severity: "low", impact: 2, effort: 1, certainty: 0.6, fix: "Acorta el título para que no se trunque en resultados (≈60 caracteres orientativos)." },
  title_too_short: { title: "Título demasiado corto", category: "metadata", severity: "low", impact: 2, effort: 1, certainty: 0.6, fix: "Amplía el título con el beneficio o la categoría del negocio." },
  meta_description_missing: { title: "Falta meta description", category: "metadata", severity: "medium", impact: 3, effort: 1, certainty: 0.85, fix: "Redacta una meta description única (≈70–160 caracteres) con propuesta de valor y llamada a la acción." },
  meta_description_too_long: { title: "Meta description demasiado larga", category: "metadata", severity: "low", impact: 1, effort: 1, certainty: 0.5, fix: "Resume la descripción a ≈160 caracteres." },
  meta_description_too_short: { title: "Meta description demasiado corta", category: "metadata", severity: "low", impact: 1, effort: 1, certainty: 0.5, fix: "Amplía la descripción explicando qué ofreces y para quién." },
  h1_missing: { title: "Falta encabezado H1", category: "structure", severity: "medium", impact: 3, effort: 1, certainty: 0.8, fix: "Añade un H1 visible que resuma el tema principal de la página." },
  h1_multiple: { title: "Varios H1 en la página", category: "structure", severity: "low", impact: 1, effort: 1, certainty: 0.5, fix: "Usa un H1 principal y jerarquiza el resto con H2/H3." },
  canonical_missing: { title: "Falta URL canónica", category: "indexability", severity: "low", impact: 2, effort: 1, certainty: 0.6, fix: "Declara <link rel=\"canonical\"> apuntando a la versión preferida de la URL." },
  canonical_multiple: { title: "Varias canónicas declaradas", category: "indexability", severity: "medium", impact: 3, effort: 1, certainty: 0.9, fix: "Deja una sola etiqueta canonical por página." },
  canonical_cross_domain: { title: "Canónica apunta a otro dominio", category: "indexability", severity: "medium", impact: 4, effort: 2, certainty: 0.6, fix: "Verifica que la canónica a otro dominio es intencionada; si no, apúntala a esta URL." },
  noindex: { title: "Página marcada como noindex", category: "indexability", severity: "high", impact: 5, effort: 1, certainty: 0.6, fix: "Si la página debe aparecer en buscadores, elimina 'noindex' de meta robots." },
  lang_missing: { title: "Falta atributo lang en <html>", category: "structure", severity: "low", impact: 2, effort: 1, certainty: 0.8, fix: "Declara el idioma del documento, p. ej. <html lang=\"es\">." },
  viewport_missing: { title: "Falta meta viewport (móvil)", category: "structure", severity: "high", impact: 4, effort: 1, certainty: 0.9, fix: "Añade <meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">." },
  images_missing_alt: { title: "Imágenes sin texto alternativo", category: "content", severity: "medium", impact: 2, effort: 2, certainty: 0.85, fix: "Describe cada imagen informativa con alt; usa alt=\"\" solo en decorativas." },
  og_missing: { title: "Faltan etiquetas Open Graph", category: "social", severity: "low", impact: 2, effort: 1, certainty: 0.7, fix: "Añade og:title, og:description y og:image para compartir en redes y apps de mensajería." },
  structured_data_missing: { title: "Sin datos estructurados (JSON-LD)", category: "geo", severity: "low", impact: 3, effort: 2, certainty: 0.6, fix: "Añade JSON-LD válido (Organization, LocalBusiness, Product, FAQPage…) que refleje contenido visible y real." },
  jsonld_invalid: { title: "JSON-LD con errores de sintaxis", category: "geo", severity: "medium", impact: 3, effort: 1, certainty: 0.95, fix: "Corrige el JSON del bloque application/ld+json (no es parseable)." },
  thin_content: { title: "Contenido escaso", category: "content", severity: "low", impact: 3, effort: 3, certainty: 0.4, fix: "Valora ampliar el contenido con información útil y original para el usuario (no relleno)." },
  slow_response: { title: "Respuesta lenta del servidor", category: "performance", severity: "medium", impact: 3, effort: 3, certainty: 0.5, fix: "Revisa caché, hosting y tamaño de la página. Medición puntual desde nuestro rastreador: confírmala con PageSpeed/CrUX." },
  page_truncated: { title: "HTML muy pesado (truncado)", category: "performance", severity: "info", impact: 2, effort: 3, certainty: 0.7, fix: "El documento supera el límite de 2 MB del rastreador; reduce HTML inline." },
  https_missing: { title: "El sitio no se sirve por HTTPS", category: "security", severity: "critical", impact: 5, effort: 2, certainty: 0.95, fix: "Instala un certificado TLS y redirige HTTP→HTTPS con 301." },
  robots_missing: { title: "No hay robots.txt", category: "indexability", severity: "low", impact: 1, effort: 1, certainty: 0.7, fix: "Publica /robots.txt indicando la ubicación del sitemap." },
  robots_blocks_all: { title: "robots.txt bloquea todo el sitio", category: "indexability", severity: "critical", impact: 5, effort: 1, certainty: 0.85, fix: "Elimina 'Disallow: /' para buscadores si el sitio debe ser público." },
  sitemap_missing: { title: "No se encontró sitemap XML", category: "indexability", severity: "medium", impact: 2, effort: 1, certainty: 0.7, fix: "Genera /sitemap.xml y decláralo en robots.txt y Search Console. Ojo: un sitemap no garantiza indexación." },
  llms_txt_missing: { title: "No hay /llms.txt (GEO, opcional)", category: "geo", severity: "info", impact: 1, effort: 1, certainty: 0.3, fix: "Convención emergente y no estándar: opcionalmente publica /llms.txt con un resumen de tu negocio y enlaces clave." },
  duplicate_titles: { title: "Títulos duplicados entre páginas", category: "metadata", severity: "medium", impact: 3, effort: 2, certainty: 0.85, fix: "Haz único el título de cada página según su contenido." },
  duplicate_descriptions: { title: "Meta descriptions duplicadas", category: "metadata", severity: "low", impact: 2, effort: 2, certainty: 0.8, fix: "Escribe una descripción distinta por página." },
  organization_schema_missing: { title: "Home sin entidad Organization/LocalBusiness", category: "geo", severity: "low", impact: 3, effort: 1, certainty: 0.5, fix: "Declara la entidad de tu marca (nombre, logo, sameAs) con JSON-LD en la home para ayudar a buscadores y motores de IA a identificarla." },
};


function pageRules(p: CrawledPage, site: SiteContext): SeoIssue[] {
  const out: SeoIssue[] = [];
  const add = (ruleKey: string, evidence: Record<string, unknown>) => {
    const r = RULES[ruleKey]!;
    out.push({ ruleKey, severity: r.severity, category: r.category, url: p.finalUrl, evidence });
  };
  if (p.status >= 400) {
    add("http_error", { status: p.status });
    return out;
  }
  if (p.durationMs > 3000) add("slow_response", { durationMs: p.durationMs, measuredFrom: "DNI crawler (edge)", sample: 1 });
  if (p.truncated) add("page_truncated", { limitBytes: 2_000_000 });
  const e = p.extraction;
  if (!e) return out;
  if (!e.title) add("title_missing", {});
  else {
    if (e.title.length > 65) add("title_too_long", { title: e.title, length: e.title.length });
    if (e.title.length < 15) add("title_too_short", { title: e.title, length: e.title.length });
  }
  if (e.titleCount > 1) add("title_multiple", { count: e.titleCount });
  if (!e.metaDescription) add("meta_description_missing", {});
  else {
    if (e.metaDescription.length > 170) add("meta_description_too_long", { length: e.metaDescription.length });
    if (e.metaDescription.length < 50) add("meta_description_too_short", { description: e.metaDescription, length: e.metaDescription.length });
  }
  if (e.h1.length === 0) add("h1_missing", {});
  if (e.h1.length > 1) add("h1_multiple", { h1: e.h1.slice(0, 5), count: e.h1.length });
  if (e.canonicalCount === 0) add("canonical_missing", {});
  if (e.canonicalCount > 1) add("canonical_multiple", { count: e.canonicalCount });
  if (e.canonical) {
    try {
      if (new URL(e.canonical).host !== new URL(p.finalUrl).host) add("canonical_cross_domain", { canonical: e.canonical });
    } catch {
      /* ignore malformed canonical */
    }
  }
  if (e.metaRobots && /noindex/.test(e.metaRobots)) add("noindex", { metaRobots: e.metaRobots, isHomepage: p.finalUrl === site.homepageUrl });
  if (!e.lang) add("lang_missing", {});
  if (!e.viewport) add("viewport_missing", {});
  const noAlt = e.images.filter((i) => i.alt === null && i.src);
  if (noAlt.length > 0) add("images_missing_alt", { count: noAlt.length, total: e.images.length, examples: noAlt.slice(0, 5).map((i) => i.src) });
  if (!e.og["title"] || !e.og["image"]) add("og_missing", { present: Object.keys(e.og) });
  if (e.jsonLdErrors > 0) add("jsonld_invalid", { invalidBlocks: e.jsonLdErrors });
  if (e.jsonLd.length === 0 && e.jsonLdErrors === 0) add("structured_data_missing", {});
  if (e.wordCount < 150 && p.status === 200) add("thin_content", { wordCount: e.wordCount, caveat: "Recuento sobre HTML inicial; el contenido renderizado por JavaScript no se mide." });
  if (p.finalUrl === site.homepageUrl && !e.jsonLdTypes.some((t) => ENTITY_TYPE_RE.test(t))) {
    add("organization_schema_missing", { jsonLdTypes: e.jsonLdTypes });
  }
  return out;
}

export function runSeoRules(site: SiteContext): SeoIssue[] {
  const issues: SeoIssue[] = [];
  const siteIssue = (ruleKey: string, evidence: Record<string, unknown>) => {
    const r = RULES[ruleKey]!;
    issues.push({ ruleKey, severity: r.severity, category: r.category, url: null, evidence });
  };
  if (!site.servedOverHttps) siteIssue("https_missing", { origin: site.origin });
  if (!site.robotsFound) siteIssue("robots_missing", { checked: `${site.origin}/robots.txt` });
  if (site.robotsBlocksAll) siteIssue("robots_blocks_all", {});
  if (!site.sitemapFound) siteIssue("sitemap_missing", { checked: [`${site.origin}/sitemap.xml`, "robots.txt Sitemap:"] });
  if (!site.llmsTxtFound) siteIssue("llms_txt_missing", { checked: `${site.origin}/llms.txt` });

  for (const p of site.pages) issues.push(...pageRules(p, site));

  const ok = site.pages.filter((p) => p.status < 400 && p.extraction);
  const groupBy = (key: (p: CrawledPage) => string | null) => {
    const m = new Map<string, string[]>();
    for (const p of ok) {
      const k = key(p);
      if (!k) continue;
      m.set(k, [...(m.get(k) ?? []), p.finalUrl]);
    }
    return [...m.entries()].filter(([, urls]) => urls.length > 1);
  };
  for (const [title, urls] of groupBy((p) => p.extraction!.title)) {
    siteIssue("duplicate_titles", { title, urls: urls.slice(0, 10), count: urls.length });
  }
  for (const [d, urls] of groupBy((p) => p.extraction!.metaDescription)) {
    siteIssue("duplicate_descriptions", { description: d.slice(0, 160), urls: urls.slice(0, 10), count: urls.length });
  }
  return issues;
}

const SEVERITY_WEIGHT: Record<Severity, number> = { critical: 5, high: 4, medium: 3, low: 2, info: 1 };
export const SEVERITY_ORDER: Severity[] = ["critical", "high", "medium", "low", "info"];

export function issueScore(issue: SeoIssue): number {
  const r = RULES[issue.ruleKey]!;
  let impact: number = r.impact;
  if (issue.ruleKey === "noindex" && issue.evidence["isHomepage"] === true) impact = 5;
  const raw = ((impact * 2 + SEVERITY_WEIGHT[issue.severity]) * r.certainty) / r.effort;
  return Math.round(raw * 100) / 100;
}

export interface Opportunity {
  ruleKey: string;
  title: string;
  category: Category;
  severity: Severity;
  affectedUrls: string[];
  affectedCount: number;
  impact: number;
  effort: number;
  certainty: number;
  score: number;
  fix: string;
}

/**
 * Groups issues by rule and ranks them by impact × certainty / effort, boosted by breadth.
 * Fully deterministic: ties break on severity, then rule key.
 */
export function prioritize(issues: SeoIssue[], limit = 10): Opportunity[] {
  const byRule = new Map<string, SeoIssue[]>();
  for (const i of issues) byRule.set(i.ruleKey, [...(byRule.get(i.ruleKey) ?? []), i]);
  const opps: Opportunity[] = [];
  for (const [ruleKey, list] of byRule) {
    const r = RULES[ruleKey]!;
    const urls = [...new Set(list.map((i) => i.url).filter((u): u is string => !!u))].sort();
    const affected = Math.max(1, urls.length);
    const base = Math.max(...list.map(issueScore));
    const score = Math.round(base * (1 + Math.log2(affected) * 0.25) * 100) / 100;
    opps.push({
      ruleKey,
      title: r.title,
      category: r.category,
      severity: list.reduce<Severity>((acc, i) => (SEVERITY_ORDER.indexOf(i.severity) < SEVERITY_ORDER.indexOf(acc) ? i.severity : acc), "info"),
      affectedUrls: urls.slice(0, 20),
      affectedCount: urls.length,
      impact: r.impact,
      effort: r.effort,
      certainty: r.certainty,
      score,
      fix: r.fix,
    });
  }
  // Critical blockers (site down for search, no HTTPS…) always lead the list.
  opps.sort(
    (a, b) =>
      Number(b.severity === "critical") - Number(a.severity === "critical") ||
      b.score - a.score ||
      SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity) ||
      a.ruleKey.localeCompare(b.ruleKey),
  );
  return opps.slice(0, limit);
}

/** Transparent 0–100 health score: 100 minus weighted penalties per distinct rule (capped). */
export function healthScore(issues: SeoIssue[]): { score: number; method: string } {
  const penalty: Record<Severity, number> = { critical: 20, high: 10, medium: 5, low: 2, info: 0 };
  const seen = new Set<string>();
  let total = 0;
  for (const i of issues) {
    if (seen.has(i.ruleKey)) continue;
    seen.add(i.ruleKey);
    total += penalty[i.severity];
  }
  return {
    score: Math.max(0, 100 - total),
    method: "100 − Σ penalización por regla distinta (crítica 20, alta 10, media 5, baja 2, info 0). Indicador interno, no predice rankings.",
  };
}
