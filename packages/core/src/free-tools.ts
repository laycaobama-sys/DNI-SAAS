/**
 * Free public tools (/herramientas). Pure, deterministic functions: no AI, no network, no cost. They run
 * in the visitor's browser, so what the visitor pastes never leaves their device. The four tools that read a public
 * URL call the API instead (routes/public-tools.ts, logic in site-tools.ts). The same functions are
 * unit-tested here and bundled into the public pages.
 */

export interface FreeTool {
  slug: string;
  name: string;
  /** One sentence: what it does. */
  summary: string;
}

export const FREE_TOOLS: FreeTool[] = [
  { slug: "robots-txt-bots-ia", name: "Comprobador de robots.txt y bots de IA", summary: "Pega tu robots.txt y mira si ChatGPT, Claude, Perplexity, Gemini y Google pueden leer tu web." },
  { slug: "generador-llms-txt", name: "Generador de llms.txt", summary: "Crea el archivo llms.txt que resume tu web para los asistentes de IA, listo para subir a la raíz." },
  { slug: "generador-schema", name: "Generador de datos estructurados (JSON-LD)", summary: "Datos estructurados de organización, negocio local o artículo, validados y listos para pegar." },
  { slug: "generador-faq-aeo", name: "Generador de preguntas frecuentes para AEO", summary: "Convierte tus preguntas y respuestas en un bloque HTML y su marcado FAQPage." },
  { slug: "vista-previa-google", name: "Vista previa del resultado en Google", summary: "Mira cómo se vería tu título y tu descripción en el buscador y si se cortan." },
  { slug: "comprobador-sitemap", name: "Comprobador de sitemap.xml", summary: "Pega tu sitemap y detecta direcciones duplicadas, sin https, fechas mal escritas y límites superados." },
  { slug: "etiquetas-open-graph", name: "Generador de etiquetas Open Graph", summary: "Las etiquetas para que tu página se vea bien al compartirla en WhatsApp, LinkedIn, Facebook o X." },
  { slug: "calculadora-valor-trafico", name: "Calculadora del valor de tu tráfico orgánico", summary: "Cuánto costaría conseguir con anuncios las visitas que ya te llegan desde Google." },
  { slug: "preparada-para-ia", name: "¿Tu web está preparada para ChatGPT y otros asistentes de IA?", summary: "Revisa si los asistentes con IA pueden leer, entender y citar tu página." },
  { slug: "palabras-clave-competidor", name: "Palabras clave que te faltan frente a un competidor", summary: "Compara tu página con la de un competidor y mira qué términos destaca él y tú no usas." },
  { slug: "comprobador-enlaces-rotos", name: "Comprobador de enlaces rotos", summary: "Comprueba hasta 50 enlaces de una página: cuáles funcionan, redirigen o están rotos." },
  { slug: "comprobador-imagen-compartir", name: "Comprobador de la imagen al compartir (og:image)", summary: "Mira qué imagen, título y descripción salen al compartir tu página en redes y WhatsApp." },
];

// ── robots.txt and AI crawlers ────────────────────────────────────────────────────────────────────
/** User agents documented by each company (checked 2026-11-25). */
export const AI_BOTS: Array<{ ua: string; owner: string; purpose: string }> = [
  { ua: "GPTBot", owner: "OpenAI", purpose: "entrenamiento de modelos" },
  { ua: "OAI-SearchBot", owner: "OpenAI", purpose: "búsqueda de ChatGPT" },
  { ua: "ChatGPT-User", owner: "OpenAI", purpose: "visitas pedidas por un usuario de ChatGPT" },
  { ua: "ClaudeBot", owner: "Anthropic", purpose: "entrenamiento de modelos" },
  { ua: "Claude-SearchBot", owner: "Anthropic", purpose: "búsqueda de Claude" },
  { ua: "Claude-User", owner: "Anthropic", purpose: "visitas pedidas por un usuario de Claude" },
  { ua: "PerplexityBot", owner: "Perplexity", purpose: "búsqueda de Perplexity" },
  { ua: "Google-Extended", owner: "Google", purpose: "uso en Gemini (no afecta a Google Search)" },
  { ua: "Googlebot", owner: "Google", purpose: "Google Search" },
  { ua: "Bingbot", owner: "Microsoft", purpose: "Bing y Copilot" },
  { ua: "Applebot-Extended", owner: "Apple", purpose: "entrenamiento de Apple Intelligence" },
  { ua: "CCBot", owner: "Common Crawl", purpose: "archivo público usado para entrenar modelos" },
];

interface RobotsGroup {
  agents: string[];
  rules: Array<{ allow: boolean; path: string }>;
}

export function parseRobotsGroups(txt: string): { groups: RobotsGroup[]; sitemaps: string[] } {
  const groups: RobotsGroup[] = [];
  const sitemaps: string[] = [];
  let current: RobotsGroup | null = null;
  let lastWasAgent = false;
  for (const raw of txt.split(/\r?\n/).slice(0, 5000)) {
    const line = raw.replace(/#.*$/, "").trim();
    if (!line) continue;
    const m = /^([A-Za-z-]+)\s*:\s*(.*)$/.exec(line);
    if (!m) continue;
    const key = m[1]!.toLowerCase();
    const value = m[2]!.trim();
    if (key === "user-agent") {
      if (!current || !lastWasAgent) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (key === "sitemap") sitemaps.push(value);
    else if ((key === "allow" || key === "disallow") && current) {
      if (key === "disallow" && value === "") continue; // «Disallow:» empty = allow everything
      current.rules.push({ allow: key === "allow", path: value });
    }
  }
  return { groups, sitemaps };
}

const ruleMatches = (pattern: string, path: string) => {
  const anchored = pattern.endsWith("$");
  const body = (anchored ? pattern.slice(0, -1) : pattern).replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${body}${anchored ? "$" : ""}`).test(path);
};

/** RFC 9309: the most specific group for the agent, then the longest matching rule (allow wins ties). */
export function robotsAllows(txt: string, ua: string, path = "/"): { allowed: boolean; group: string } {
  const { groups } = parseRobotsGroups(txt);
  const name = ua.toLowerCase();
  let group = groups.find((g) => g.agents.includes(name));
  let label = ua;
  if (!group) {
    group = groups.find((g) => g.agents.includes("*"));
    label = "*";
  }
  if (!group) return { allowed: true, group: "ninguno" };
  const rules = groups.filter((g) => (label === "*" ? g.agents.includes("*") : g.agents.includes(name))).flatMap((g) => g.rules);
  let best: { allow: boolean; len: number } | null = null;
  for (const r of rules) {
    if (!ruleMatches(r.path, path)) continue;
    const len = r.path.length;
    if (!best || len > best.len || (len === best.len && r.allow)) best = { allow: r.allow, len };
  }
  return { allowed: best ? best.allow : true, group: label };
}

export function robotsAiReport(txt: string) {
  const parsed = parseRobotsGroups(txt);
  return {
    bots: AI_BOTS.map((b) => ({ ...b, ...robotsAllows(txt, b.ua, "/") })),
    sitemaps: parsed.sitemaps,
    groups: parsed.groups.length,
  };
}

// ── llms.txt ──────────────────────────────────────────────────────────────────────────────────────
export interface LlmsInput {
  name: string;
  summary: string;
  details?: string;
  sections: Array<{ title: string; links: Array<{ title: string; url: string; note?: string }> }>;
}
const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();
/** Format proposed at llmstxt.org: H1 name, blockquote summary, free text, H2 sections of links. */
export function buildLlmsFile(i: LlmsInput): string {
  const out = [`# ${oneLine(i.name)}`, "", `> ${oneLine(i.summary)}`];
  if (i.details?.trim()) out.push("", i.details.trim());
  for (const s of i.sections) {
    const links = s.links.filter((l) => l.title.trim() && /^https?:\/\//i.test(l.url.trim()));
    if (!s.title.trim() || links.length === 0) continue;
    out.push("", `## ${oneLine(s.title)}`, "");
    for (const l of links) out.push(`- [${oneLine(l.title)}](${l.url.trim()})${l.note?.trim() ? `: ${oneLine(l.note)}` : ""}`);
  }
  return `${out.join("\n")}\n`;
}

// ── JSON-LD ──────────────────────────────────────────────────────────────────────────────────────
const clean = <T extends Record<string, unknown>>(o: T): T => {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) {
    if (v === undefined || v === null || v === "" || (Array.isArray(v) && v.length === 0)) continue;
    out[k] = typeof v === "object" && !Array.isArray(v) ? clean(v as Record<string, unknown>) : v;
  }
  return out as T;
};
export const jsonLdScript = (data: unknown) => `<script type="application/ld+json">\n${JSON.stringify(data, null, 2).replace(/</g, "\\u003c")}\n</script>`;

export interface SchemaInput {
  type: "Organization" | "LocalBusiness" | "Article";
  name: string;
  url: string;
  logo?: string;
  description?: string;
  sameAs?: string[];
  phone?: string;
  street?: string;
  city?: string;
  postalCode?: string;
  country?: string;
  author?: string;
  datePublished?: string;
  image?: string;
}
export function buildSchema(i: SchemaInput): Record<string, unknown> {
  if (i.type === "Article")
    return clean({
      "@context": "https://schema.org",
      "@type": "Article",
      headline: i.name.slice(0, 110),
      url: i.url,
      description: i.description,
      image: i.image,
      datePublished: i.datePublished,
      author: i.author ? { "@type": "Person", name: i.author } : undefined,
    });
  return clean({
    "@context": "https://schema.org",
    "@type": i.type,
    name: i.name,
    url: i.url,
    logo: i.logo,
    description: i.description,
    sameAs: (i.sameAs ?? []).filter((u) => /^https:\/\//.test(u)),
    telephone: i.phone,
    address:
      i.type === "LocalBusiness" && (i.street || i.city)
        ? { "@type": "PostalAddress", streetAddress: i.street, addressLocality: i.city, postalCode: i.postalCode, addressCountry: i.country || "ES" }
        : undefined,
  });
}

/** Problems a person can fix before pasting (empty = ready). */
export function schemaProblems(i: SchemaInput): string[] {
  const p: string[] = [];
  if (!i.name.trim()) p.push(i.type === "Article" ? "Falta el título del artículo." : "Falta el nombre.");
  if (!/^https:\/\//.test(i.url)) p.push("La dirección tiene que empezar por https://.");
  if (i.type === "LocalBusiness" && !i.city?.trim()) p.push("Un negocio local necesita al menos la ciudad.");
  if (i.type === "Article" && i.datePublished && !/^\d{4}-\d{2}-\d{2}/.test(i.datePublished)) p.push("La fecha tiene que tener el formato AAAA-MM-DD.");
  if (i.logo && !/^https:\/\//.test(i.logo)) p.push("El logo tiene que ser una dirección https://.");
  return p;
}

// ── FAQ for AEO ──────────────────────────────────────────────────────────────────────────────────
const escHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
export function buildFaq(pairs: Array<{ q: string; a: string }>): { html: string; jsonLd: Record<string, unknown>; count: number } {
  const ok = pairs.map((p) => ({ q: oneLine(p.q), a: p.a.trim() })).filter((p) => p.q && p.a);
  const html = `<section class="faq">\n  <h2>Preguntas frecuentes</h2>\n${ok.map((p) => `  <details>\n    <summary>${escHtml(p.q)}</summary>\n    <p>${escHtml(p.a).replace(/\n+/g, "<br>")}</p>\n  </details>`).join("\n")}\n</section>`;
  const jsonLd = { "@context": "https://schema.org", "@type": "FAQPage", mainEntity: ok.map((p) => ({ "@type": "Question", name: p.q, acceptedAnswer: { "@type": "Answer", text: p.a } })) };
  return { html, jsonLd, count: ok.length };
}

// ── Search result preview ────────────────────────────────────────────────────────────────────────
/** Google cuts by pixels (≈ 580 px title, ≈ 920 px description on desktop); without a canvas, approximate by characters. */
export const SERP_TITLE_PX = 580;
export const SERP_DESC_PX = 920;
export function truncateToWidth(text: string, maxPx: number, measure: (s: string) => number): { text: string; cut: boolean } {
  const t = oneLine(text);
  if (measure(t) <= maxPx) return { text: t, cut: false };
  let lo = 0;
  let hi = t.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (measure(`${t.slice(0, mid)} …`) <= maxPx) lo = mid;
    else hi = mid - 1;
  }
  return { text: `${t.slice(0, lo).replace(/\s+\S*$/, "")} …`, cut: true };
}

// ── sitemap.xml ──────────────────────────────────────────────────────────────────────────────────
export function sitemapReport(xml: string) {
  const isIndex = /<sitemapindex[\s>]/i.test(xml);
  const locs = [...xml.matchAll(/<loc>\s*([^<]+?)\s*<\/loc>/gi)].map((m) => m[1]!.replace(/&amp;/g, "&"));
  const lastmods = [...xml.matchAll(/<lastmod>\s*([^<]+?)\s*<\/lastmod>/gi)].map((m) => m[1]!);
  const seen = new Set<string>();
  const duplicates: string[] = [];
  for (const l of locs) {
    if (seen.has(l)) duplicates.push(l);
    seen.add(l);
  }
  const notHttps = locs.filter((l) => !/^https:\/\//i.test(l));
  const hosts = new Set(locs.map((l) => /^https?:\/\/([^/]+)/i.exec(l)?.[1]?.toLowerCase()).filter(Boolean));
  const badDates = lastmods.filter((d) => !/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2}))?$/.test(d));
  const problems: string[] = [];
  if (!/<(urlset|sitemapindex)[\s>]/i.test(xml)) problems.push("No es un sitemap: falta la etiqueta <urlset> o <sitemapindex>.");
  if (locs.length === 0) problems.push("No hay ninguna dirección (<loc>).");
  if (locs.length > 50_000) problems.push(`Tiene ${locs.length} direcciones: el máximo por archivo es 50.000. Divídelo con un índice de sitemaps.`);
  if (new TextEncoder().encode(xml).length > 50 * 1024 * 1024) problems.push("Pesa más de 50 MB sin comprimir: divídelo.");
  if (duplicates.length) problems.push(`${duplicates.length} direcciones repetidas.`);
  if (notHttps.length) problems.push(`${notHttps.length} direcciones sin https://.`);
  if (hosts.size > 1) problems.push(`Mezcla ${hosts.size} dominios distintos (${[...hosts].slice(0, 3).join(", ")}): un sitemap solo debe listar páginas de su propio dominio.`);
  if (badDates.length) problems.push(`${badDates.length} fechas <lastmod> con formato no válido (usa AAAA-MM-DD).`);
  return { kind: isIndex ? ("index" as const) : ("urlset" as const), urls: locs.length, withLastmod: lastmods.length, duplicates: duplicates.slice(0, 20), notHttps: notHttps.slice(0, 20), hosts: [...hosts] as string[], badDates: badDates.slice(0, 20), problems };
}

// ── Open Graph ───────────────────────────────────────────────────────────────────────────────────
export function buildOgTags(i: { title: string; description: string; url: string; image: string; siteName?: string; type?: "website" | "article" }): string {
  const m = (p: string, c: string) => (c.trim() ? `<meta property="${p}" content="${escHtml(oneLine(c))}" />` : "");
  const n = (p: string, c: string) => (c.trim() ? `<meta name="${p}" content="${escHtml(oneLine(c))}" />` : "");
  return [
    m("og:type", i.type ?? "website"),
    m("og:title", i.title),
    m("og:description", i.description),
    m("og:url", i.url),
    m("og:image", i.image),
    m("og:site_name", i.siteName ?? ""),
    m("og:locale", "es_ES"),
    n("twitter:card", i.image ? "summary_large_image" : "summary"),
    n("twitter:title", i.title),
    n("twitter:description", i.description),
    n("twitter:image", i.image),
  ]
    .filter(Boolean)
    .join("\n");
}

// ── Traffic value ────────────────────────────────────────────────────────────────────────────────
/** Estimate (not a measurement): monthly organic visits × average CPC you would pay for those clicks. */
export function trafficValue(visitsPerMonth: number, cpcEur: number): { monthly: number; yearly: number } | null {
  if (!Number.isFinite(visitsPerMonth) || !Number.isFinite(cpcEur) || visitsPerMonth < 0 || cpcEur < 0 || visitsPerMonth > 1e9 || cpcEur > 1000) return null;
  const monthly = Math.round(visitsPerMonth * cpcEur * 100) / 100;
  return { monthly, yearly: Math.round(monthly * 12 * 100) / 100 };
}
