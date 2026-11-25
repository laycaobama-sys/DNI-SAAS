import { parse } from "node-html-parser";
import type { PageExtraction } from "./extract";
import { robotsAiReport } from "./free-tools";

/**
 * Server-side logic of the free tools that need to read a public web page (/herramientas/*): keyword gap
 * against a competitor, broken links and readiness for AI assistants. Pure functions over HTML and text that
 * the API has already downloaded safely (SSRF-checked). Page content is untrusted DATA: it is only counted
 * and compared, never interpreted. Deterministic, no AI and no third-party data.
 */

// ── Keyword gap ───────────────────────────────────────────────────────────────────────────────────
const STOP = new Set(
  (
    "a al algo algun alguna algunas alguno algunos ante antes aqui asi aun bajo bien cada casi como con contra cual cuales cuando de del desde donde dos el ella ellas ellos en entre era eres es esa esas ese eso esos esta estas este esto estos fue ha hace hacen hacer hacia han hasta hay la las le les lo los mas me mi mis mucho muy nada ni no nos nuestra nuestras nuestro nuestros o os otra otras otro otros para pero poco por porque puede pueden que quien se sea ser si sin sobre solo son su sus tambien tan tanto te ti tiene tienen todo todos tu tus un una unas uno unos usted ustedes va vez y ya yo " +
    "the and for with you your our are was were this that from have has not but all can will more about into out also its it's of to in on at by an or as be is it we us they them their " +
    "aquí más también así aún qué cómo cuál dónde está están sí tú él través además hoy cookies cookie aviso legal política privacidad inicio menú contacto copyright reservados derechos leer ver saber click clic aceptar rechazar configurar www com es html https http"
  ).split(/\s+/),
);
const WEIGHT = { title: 5, h1: 4, description: 3, h2: 2, h3: 2, body: 1 } as const;
export type TermPlace = keyof typeof WEIGHT;
export const TERM_PLACE_LABEL: Record<TermPlace, string> = { title: "título", h1: "H1", description: "descripción", h2: "H2", h3: "H3", body: "texto" };

const norm = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/ñ/g, "n");

/** Words of 3+ letters (accents folded so «análisis» and «analisis» match), without numbers. */
export function tokenize(text: string): string[] {
  return (text.toLowerCase().match(/[\p{L}][\p{L}'’-]*[\p{L}]|[\p{L}]/gu) ?? []).map((w) => norm(w).replace(/['’]/g, "")).filter((w) => w.length >= 3);
}

export interface PageTerms {
  url: string;
  /** term → weighted score and the places where it appears. */
  terms: Map<string, { score: number; places: Set<TermPlace>; label: string }>;
  words: number;
}

/** Single words and two-word phrases (no stopword at either end), weighted by where they appear. */
export function pageTerms(html: string, url: string): PageTerms {
  const root = parse(html, { comment: false, blockTextElements: { script: true, style: true, noscript: true, pre: true } });
  const clean = (s: string) => s.replace(/\s+/g, " ").trim();
  const meta = root.querySelectorAll("meta").find((m) => (m.getAttribute("name") ?? "").toLowerCase() === "description");
  const parts: Array<[TermPlace, string]> = [
    ["title", clean(root.querySelector("title")?.text ?? "")],
    ["description", clean(meta?.getAttribute("content") ?? "")],
    ...root.querySelectorAll("h1").map((e) => ["h1", clean(e.text)] as [TermPlace, string]),
    ...root.querySelectorAll("h2").map((e) => ["h2", clean(e.text)] as [TermPlace, string]),
    ...root.querySelectorAll("h3").map((e) => ["h3", clean(e.text)] as [TermPlace, string]),
  ];
  const body = root.querySelector("body") ?? root;
  for (const n of body.querySelectorAll("script,style,noscript,template,svg,nav,footer,header,form")) n.remove();
  const bodyText = clean(body.text).slice(0, 200_000);
  parts.push(["body", bodyText]);
  const terms: PageTerms["terms"] = new Map();
  const add = (term: string, place: TermPlace, label: string) => {
    const t = terms.get(term) ?? { score: 0, places: new Set<TermPlace>(), label };
    t.score += WEIGHT[place];
    t.places.add(place);
    terms.set(term, t);
  };
  for (const [place, text] of parts) {
    if (!text) continue;
    const toks = tokenize(text);
    for (let i = 0; i < toks.length; i++) {
      const w = toks[i]!;
      if (!STOP.has(w) && w.length >= 4) add(w, place, w);
      const next = toks[i + 1];
      if (next && !STOP.has(w) && !STOP.has(next)) add(`${w} ${next}`, place, `${w} ${next}`);
    }
  }
  return { url, terms, words: tokenize(bodyText).length };
}

export interface KeywordGapItem {
  term: string;
  score: number;
  places: string[];
  /** Weight in your page (0 = absent). */
  yours: number;
}

export interface KeywordGapResult {
  /** Terms the competitor uses in important places that your page does not mention at all. */
  missing: KeywordGapItem[];
  /** Terms the competitor stresses much more than you (in title or headings and you only in the text). */
  weaker: KeywordGapItem[];
  shared: number;
  yourWords: number;
  competitorWords: number;
}

/**
 * Compares the vocabulary of two pages. A term counts for the competitor when it appears in the title,
 * a heading or the description, or at least 3 times in the text; the noise from menus and footers is dropped.
 */
export function keywordGap(mine: PageTerms, competitor: PageTerms, limit = 25): KeywordGapResult {
  const important = (t: { score: number; places: Set<TermPlace> }) => [...t.places].some((p) => p !== "body") || t.score >= 3;
  const missing: KeywordGapItem[] = [];
  const weaker: KeywordGapItem[] = [];
  let shared = 0;
  for (const [term, t] of competitor.terms) {
    if (!important(t)) continue;
    const mineT = mine.terms.get(term);
    const item = { term: t.label, score: t.score, places: [...t.places].map((p) => TERM_PLACE_LABEL[p]), yours: mineT?.score ?? 0 };
    if (!mineT) missing.push(item);
    else {
      shared++;
      const theirsHead = [...t.places].some((p) => p !== "body");
      const mineHead = [...mineT.places].some((p) => p !== "body");
      if (theirsHead && !mineHead && t.score >= mineT.score * 2) weaker.push(item);
    }
  }
  // Prefer phrases (more specific) at equal score, then drop single words already covered by a listed phrase.
  const rank = (a: KeywordGapItem, b: KeywordGapItem) => b.score - a.score || b.term.split(" ").length - a.term.split(" ").length || a.term.localeCompare(b.term);
  const dedupe = (items: KeywordGapItem[]) => {
    const out: KeywordGapItem[] = [];
    for (const it of items.sort(rank)) {
      if (!it.term.includes(" ") && out.some((o) => o.term.split(" ").includes(it.term) && o.score >= it.score * 0.6)) continue;
      out.push(it);
      if (out.length >= limit) break;
    }
    return out;
  };
  return { missing: dedupe(missing), weaker: dedupe(weaker).slice(0, 10), shared, yourWords: mine.words, competitorWords: competitor.words };
}

// ── Broken links ──────────────────────────────────────────────────────────────────────────────────
export const LINK_CHECK_MAX = 50;
export const LINK_CHECK_BATCH = 10;

/** Unique http(s) links of a page (fragment removed), internal first, at most LINK_CHECK_MAX. */
export function linkTargets(page: Pick<PageExtraction, "links">): Array<{ url: string; text: string; internal: boolean }> {
  const seen = new Set<string>();
  const out: Array<{ url: string; text: string; internal: boolean }> = [];
  const sorted = [...page.links].sort((a, b) => Number(b.internal) - Number(a.internal));
  for (const l of sorted) {
    if (seen.has(l.href)) continue;
    seen.add(l.href);
    out.push({ url: l.href, text: l.text, internal: l.internal });
  }
  return out.slice(0, LINK_CHECK_MAX);
}

export type LinkVerdict = "ok" | "redirect" | "broken" | "blocked" | "error";
export const LINK_VERDICT_LABEL: Record<LinkVerdict, string> = {
  ok: "Funciona",
  redirect: "Redirige",
  broken: "Roto",
  blocked: "No deja comprobarlo",
  error: "No responde",
};

/** 404/410 and other 4xx (except auth/anti-bot) are broken; 401/403/429 usually mean the site blocks robots. */
export function linkVerdict(status: number | null): LinkVerdict {
  if (status === null) return "error";
  if (status >= 200 && status < 300) return "ok";
  if (status >= 300 && status < 400) return "redirect";
  if (status === 401 || status === 403 || status === 429 || status === 999) return "blocked";
  if (status >= 400 && status < 500) return "broken";
  return "error";
}

// ── AI-assistant readiness ────────────────────────────────────────────────────────────────────────
export interface ReadinessInput {
  page: PageExtraction | null;
  status: number | null;
  https: boolean;
  /** null = the site has no robots.txt (404). */
  robotsTxt: string | null;
  llmsTxt: string | null;
  /** The file could not be downloaded (timeout, 5xx…): we say so instead of guessing. */
  robotsUnknown?: boolean;
  llmsUnknown?: boolean;
}

export interface ReadinessCheck {
  key: string;
  label: string;
  state: "ok" | "warn" | "bad";
  detail: string;
}

const SEARCH_BOTS = ["OAI-SearchBot", "ChatGPT-User", "PerplexityBot", "Claude-SearchBot", "Bingbot", "Googlebot"];

/**
 * What an AI assistant needs to read, understand and quote a page. These are technical prerequisites we can
 * check, not a measure of how often assistants mention the business (that needs sampled questions).
 */
export function aiReadiness(i: ReadinessInput): { checks: ReadinessCheck[]; ok: number; total: number } {
  const c: ReadinessCheck[] = [];
  const p = i.page;
  const push = (key: string, label: string, state: ReadinessCheck["state"], detail: string) => c.push({ key, label, state, detail });
  push("https", "Web con https", i.https ? "ok" : "bad", i.https ? "La página se sirve cifrada." : "La página no usa https: muchos sistemas la consideran poco fiable.");
  push(
    "reachable",
    "La página responde",
    i.status !== null && i.status < 400 && p ? "ok" : "bad",
    i.status === null ? "No se pudo descargar la página." : i.status >= 400 ? `Responde con HTTP ${i.status}.` : p ? `HTTP ${i.status}.` : "No es una página HTML.",
  );
  if (i.robotsUnknown) push("robots", "Robots de búsqueda de IA", "warn", "No pudimos descargar tu robots.txt ahora mismo. Compruébalo con el comprobador de robots.txt.");
  else if (i.robotsTxt === null) push("robots", "Robots de búsqueda de IA", "ok", "No hay robots.txt: ningún robot está bloqueado.");
  else {
    const r = robotsAiReport(i.robotsTxt);
    const blocked = r.bots.filter((b) => !b.allowed && SEARCH_BOTS.includes(b.ua)).map((b) => b.ua);
    push("robots", "Robots de búsqueda de IA", blocked.length ? "bad" : "ok", blocked.length ? `Tu robots.txt bloquea: ${blocked.join(", ")}. Así no pueden leer tu portada para citarla.` : "Tu robots.txt deja leer la portada a los robots de búsqueda de ChatGPT, Perplexity, Claude, Bing y Google.");
  }
  if (p) {
    const noindex = /noindex/.test(p.metaRobots ?? "");
    push("index", "Se puede indexar", noindex ? "bad" : "ok", noindex ? "La página tiene «noindex»: los buscadores no la guardan." : "Sin «noindex».");
    const textOk = p.wordCount >= 300;
    push(
      "text",
      "Texto visible sin JavaScript",
      textOk ? "ok" : p.wordCount >= 80 ? "warn" : "bad",
      textOk ? `${p.wordCount} palabras en el HTML.` : `Solo ${p.wordCount} palabras en el HTML. Muchos robots de IA no ejecutan JavaScript: lo que no está en el HTML no lo leen.`,
    );
    push("title", "Título y descripción", p.title && p.metaDescription ? "ok" : "warn", p.title && p.metaDescription ? "Tiene título y meta descripción." : `Falta ${!p.title ? "el título" : "la meta descripción"}.`);
    push("h1", "Un encabezado principal (H1)", p.h1.length === 1 ? "ok" : "warn", p.h1.length === 1 ? `«${p.h1[0]!.slice(0, 80)}»` : p.h1.length === 0 ? "No hay H1: el tema de la página queda menos claro." : `Hay ${p.h1.length} H1.`);
    const types = p.jsonLdTypes;
    const entity = types.some((t) => /Organization|LocalBusiness|Person|Store|Restaurant|ProfessionalService|MedicalBusiness|LegalService/.test(t));
    push("entity", "Datos estructurados de tu negocio", entity ? "ok" : "warn", entity ? `Marcado: ${types.filter((t) => /Organization|Business|Person|Store|Restaurant|Service/.test(t)).slice(0, 4).join(", ")}.` : "No hay marcado Organization o LocalBusiness (JSON-LD). Ayuda a que se entienda quién eres, dónde estás y qué haces.");
    if (p.jsonLdErrors) push("jsonld", "JSON-LD válido", "bad", `${p.jsonLdErrors} bloque(s) JSON-LD con errores de sintaxis: se ignoran.`);
    const faq = types.includes("FAQPage") || p.h2.concat(p.h3).filter((h) => /\?\s*$/.test(h)).length >= 2;
    push("faq", "Preguntas y respuestas", faq ? "ok" : "warn", faq ? "La página responde preguntas concretas." : "No vemos preguntas frecuentes. Los asistentes citan mejor respuestas cortas a preguntas concretas.");
    push("lang", "Idioma declarado", p.lang ? "ok" : "warn", p.lang ? `lang="${p.lang}"` : "Falta el atributo lang en <html>.");
  }
  const llms = i.llmsTxt !== null && /^#\s+\S/m.test(i.llmsTxt);
  push(
    "llms",
    "Archivo llms.txt",
    llms ? "ok" : "warn",
    llms ? "Existe /llms.txt con formato correcto." : i.llmsUnknown ? "No pudimos descargar /llms.txt ahora mismo." : i.llmsTxt !== null ? "Hay un /llms.txt, pero no empieza con un título «# Nombre»." : "No hay /llms.txt. Es una propuesta reciente y opcional; ayuda a que una IA encuentre tus páginas clave.",
  );
  return { checks: c, ok: c.filter((x) => x.state === "ok").length, total: c.length };
}
