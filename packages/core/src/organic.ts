/**
 * Page types and the «Potencial orgánico» indicator.
 * Technical health says "is the site clean?"; potential says "how much is there to be found for?".
 * A one-page site can be technically perfect and still have almost nothing to rank or be cited for.
 */
export type PageType = "home" | "legal" | "contact" | "blog_index" | "article" | "other";

export const PAGE_TYPE_LABEL: Record<PageType, string> = {
  home: "Página principal",
  legal: "Página legal",
  contact: "Contacto",
  blog_index: "Índice del blog",
  article: "Artículo",
  other: "Página",
};

/** How much a finding on each page type matters for growth. Legal pages barely count (B8). */
export const PAGE_TYPE_WEIGHT: Record<PageType, number> = { home: 1.2, legal: 0.1, contact: 0.8, blog_index: 1, article: 1, other: 1 };

const LEGAL_RE = /(^|[/_-])(legal|aviso-?legal|avisolegal|privacidad|privacy|cookies?|terminos|terms|condiciones|conditions|gdpr|rgpd|politica|policy|imprint|impressum|accesibilidad|accessibility|lopd)([/_.-]|$)/i;
const CONTACT_RE = /(^|\/)(contacto|contact|contactar|contact-us)(\/|$)/i;
const SECTION = "(blog|articulos|noticias|news|guias|guides|recursos|resources|insights|aprende|magazine|journal|actualidad)";
const BLOG_INDEX_RE = new RegExp(`^/${SECTION}/?$`, "i");
const ARTICLE_RE = new RegExp(`^/${SECTION}/.+`, "i");
const ARTICLE_TYPES = /^(Article|BlogPosting|NewsArticle|TechArticle|Report)$/i;

export function classifyPage(url: string, homepageUrl?: string | null, jsonLdTypes: string[] = []): PageType {
  let path: string;
  try {
    const u = new URL(url);
    path = u.pathname;
    if (homepageUrl && (url === homepageUrl || (path === "/" && !u.search))) return "home";
  } catch {
    return "other";
  }
  if (path === "/" || path === "") return "home";
  if (LEGAL_RE.test(path)) return "legal";
  if (CONTACT_RE.test(path)) return "contact";
  if (BLOG_INDEX_RE.test(path)) return "blog_index";
  if (ARTICLE_RE.test(path) || jsonLdTypes.some((t) => ARTICLE_TYPES.test(t))) return "article";
  return "other";
}

export interface PotentialPage {
  url: string;
  status: number;
  wordCount: number | null;
  h2: string[];
  jsonLdTypes: string[];
  internalLinks: number;
  noindex?: boolean;
}

export interface PotentialSignal {
  key: string;
  label: string;
  value: number | string;
  points: number;
  max: number;
  detail: string;
}

export interface OrganicPotential {
  score: number;
  level: "bajo" | "medio" | "alto";
  signals: PotentialSignal[];
  contentPages: number;
  articlePages: number;
  hasContentSection: boolean;
  method: string;
  measurement: "derived";
  source: string;
  caveats: string[];
}

export const CONTENT_PAGE_MIN_WORDS = 300;
const FAQ_RE = /(preguntas frecuentes|faq|dudas frecuentes)/i;
const normHeading = (s: string) => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim();
const round1 = (n: number) => Math.round(n * 10) / 10;

/** Pages that can bring search visits: indexable, not legal, with enough own text. */
export function contentPages(pages: PotentialPage[], homepageUrl?: string | null) {
  return pages.filter((p) => p.status === 200 && !p.noindex && (p.wordCount ?? 0) >= CONTENT_PAGE_MIN_WORDS && classifyPage(p.url, homepageUrl, p.jsonLdTypes) !== "legal");
}

export function organicPotential(pages: PotentialPage[], opts: { homepageUrl?: string | null; sitemapUrlCount: number }): OrganicPotential {
  const ok = pages.filter((p) => p.status === 200 && !p.noindex);
  const types = ok.map((p) => classifyPage(p.url, opts.homepageUrl, p.jsonLdTypes));
  const nonLegal = ok.filter((_, i) => types[i] !== "legal");
  const content = contentPages(pages, opts.homepageUrl);
  const articles = types.filter((t) => t === "article").length;
  const hasIndex = types.includes("blog_index");
  const hasSection = hasIndex || articles >= 2;
  const headings = new Set(nonLegal.flatMap((p) => p.h2.map(normHeading)).filter((h) => h.length >= 4));
  const faq = ok.some((p) => p.jsonLdTypes.some((t) => /^FAQPage$/i.test(t)) || p.h2.some((h) => FAQ_RE.test(h)));
  const avgLinks = nonLegal.length ? nonLegal.reduce((a, p) => a + p.internalLinks, 0) / nonLegal.length : 0;

  const signals: PotentialSignal[] = [
    { key: "content_pages", label: "Páginas con contenido indexable", value: content.length, points: Math.min(30, content.length * 3), max: 30, detail: `Páginas indexables (no legales) con al menos ${CONTENT_PAGE_MIN_WORDS} palabras. Objetivo orientativo: 10 o más.` },
    { key: "content_section", label: "Blog o sección de contenidos", value: hasSection ? "Sí" : articles === 1 ? "1 artículo" : "No", points: hasSection ? 20 : articles === 1 ? 8 : 0, max: 20, detail: "Sección donde publicar respuestas a preguntas reales de tus clientes (blog, guías, recursos)." },
    { key: "topic_depth", label: "Temas distintos tratados", value: headings.size, points: Math.min(15, round1(headings.size / 2)), max: 15, detail: "Encabezados H2 distintos en las páginas no legales: una aproximación a cuántos temas cubre la web." },
    { key: "faq", label: "Preguntas frecuentes", value: faq ? "Sí" : "No", points: faq ? 10 : 0, max: 10, detail: "Bloque de preguntas frecuentes visible (o marcado FAQPage) que responda dudas reales." },
    { key: "internal_links", label: "Enlazado interno medio", value: round1(avgLinks), points: Math.min(10, round1(avgLinks)), max: 10, detail: "Enlaces internos por página: ayudan a descubrir y relacionar el contenido. Objetivo orientativo: 10." },
    { key: "site_size", label: "URLs declaradas en el sitemap", value: opts.sitemapUrlCount, points: Math.min(15, round1(opts.sitemapUrlCount * 1.5)), max: 15, detail: "Tamaño del sitio según su sitemap XML. Objetivo orientativo: 10 o más URLs útiles." },
  ];
  const score = Math.round(signals.reduce((a, s) => a + s.points, 0));
  return {
    score,
    level: score < 35 ? "bajo" : score < 65 ? "medio" : "alto",
    signals,
    contentPages: content.length,
    articlePages: articles,
    hasContentSection: hasSection,
    method: "Suma de 6 señales observadas en el rastreo (páginas con contenido 30, sección de contenidos 20, temas 15, sitemap 15, FAQ 10, enlazado 10).",
    measurement: "derived",
    source: "Rastreo público DNIGrowthBot",
    caveats: [
      "Indica margen para crecer con contenido; no predice tráfico, posiciones ni menciones en IA.",
      "Solo cuenta las páginas rastreadas (límite de tu plan) y el HTML inicial.",
    ],
  };
}
