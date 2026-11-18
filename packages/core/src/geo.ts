import { z } from "zod";

/**
 * GEO prompt library (F3). Defines WHAT to ask AI engines, per brand, engine, intent, language and
 * region. It never produces answers: sampling happens later, only through each provider's permitted
 * mechanism, and engines without an official API are stored for manual review only.
 */

export type GeoEngineStatus = "official_api" | "no_official_api";
export interface GeoEngine {
  key: string;
  label: string;
  vendor: string;
  status: GeoEngineStatus;
  mechanism: string;
  caveat: string;
}

export const GEO_ENGINES: readonly GeoEngine[] = [
  {
    key: "gemini_api",
    label: "Gemini (API)",
    vendor: "Google",
    status: "official_api",
    mechanism: "Gemini API con búsqueda de Google como herramienta (grounding)",
    caveat: "La respuesta del modelo por API puede diferir de la app de Gemini y de AI Overviews.",
  },
  {
    key: "openai_api",
    label: "OpenAI (API)",
    vendor: "OpenAI",
    status: "official_api",
    mechanism: "API de OpenAI con la herramienta de búsqueda web",
    caveat: "No es la app de ChatGPT: personalización, memoria y región del usuario no se reproducen.",
  },
  {
    key: "perplexity_api",
    label: "Perplexity (API Sonar)",
    vendor: "Perplexity",
    status: "official_api",
    mechanism: "API Sonar (devuelve las fuentes citadas)",
    caveat: "Los resultados de la API pueden diferir de perplexity.ai.",
  },
  {
    key: "claude_api",
    label: "Claude (API)",
    vendor: "Anthropic",
    status: "official_api",
    mechanism: "API de Claude con la herramienta de búsqueda web",
    caveat: "No es la app de Claude: personalización y región del usuario no se reproducen.",
  },
  {
    key: "google_ai_overviews",
    label: "Google AI Overviews / AI Mode",
    vendor: "Google",
    status: "no_official_api",
    mechanism: "Sin API oficial",
    caveat: "No se muestrea automáticamente (no hay mecanismo permitido): la pregunta queda para revisión manual.",
  },
  {
    key: "chatgpt_app",
    label: "ChatGPT (app)",
    vendor: "OpenAI",
    status: "no_official_api",
    mechanism: "Sin API oficial para la app",
    caveat: "No se muestrea automáticamente: la pregunta queda para revisión manual. Usa «OpenAI (API)» para muestreo.",
  },
];
export const GEO_ENGINE_KEYS = GEO_ENGINES.map((e) => e.key) as [string, ...string[]];

export const GEO_INTENTS = ["educational", "comparative", "transactional"] as const;
export type GeoIntent = (typeof GEO_INTENTS)[number];
export const GEO_CATEGORIES = ["brand", "product", "sector", "geography"] as const;
export type GeoCategory = (typeof GEO_CATEGORIES)[number];

export const GEO_INTENT_LABEL: Record<GeoIntent, string> = { educational: "Educativa", comparative: "Comparativa", transactional: "Transaccional" };
export const GEO_CATEGORY_LABEL: Record<GeoCategory, string> = { brand: "Marca", product: "Producto", sector: "Sector", geography: "Geografía" };

/** Default number of tracked prompt rows (question × engine) per plan, when the plan does not set it. */
export const GEO_PROMPT_LIMITS: Record<string, number> = { free: 10, starter: 50, growth: 150, pro: 400, agency: 1500 };

// eslint-disable-next-line no-control-regex
const CONTROL = new RegExp("[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]", "g");

/** Canonical text kept for display: control/bidi characters removed, whitespace collapsed. */
export const cleanQuestion = (s: string) => s.replace(CONTROL, " ").replace(/\s+/g, " ").trim();
/** Key used to detect duplicates: case, accents and trailing punctuation do not matter. */
export const normalizeQuestion = (s: string) =>
  cleanQuestion(s)
    .toLowerCase()
    .normalize("NFD")
    .replace(new RegExp("[\u0300-\u036f]", "g"), "")
    .replace(/[¿?¡!.,;:]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

export const GeoQuestion = z
  .string()
  .transform(cleanQuestion)
  .pipe(z.string().min(8, "La pregunta es demasiado corta.").max(300, "Máximo 300 caracteres."));
export const GeoLocale = z.string().regex(/^[a-z]{2}(-[A-Z]{2})?$/, "Idioma en formato es o es-ES.");
export const GeoCountry = z.string().regex(/^[A-Z]{2}$/, "País en formato ISO de 2 letras (ES, MX…).");
export const GeoRegionDetail = z
  .string()
  .transform(cleanQuestion)
  .pipe(z.string().max(80))
  .optional()
  .nullable();

export const CreateGeoPromptsInput = z.object({
  questions: z.array(GeoQuestion).min(1).max(50),
  intent: z.enum(GEO_INTENTS),
  category: z.enum(GEO_CATEGORIES),
  engines: z.array(z.enum(GEO_ENGINE_KEYS)).min(1).max(GEO_ENGINES.length),
  locale: GeoLocale,
  regionCountry: GeoCountry,
  regionDetail: GeoRegionDetail,
  source: z.enum(["manual", "suggestion"]).default("manual"),
});
export type CreateGeoPromptsInput = z.infer<typeof CreateGeoPromptsInput>;

export const UpdateGeoPromptInput = z
  .object({
    question: GeoQuestion.optional(),
    intent: z.enum(GEO_INTENTS).optional(),
    category: z.enum(GEO_CATEGORIES).optional(),
    locale: GeoLocale.optional(),
    regionCountry: GeoCountry.optional(),
    regionDetail: GeoRegionDetail,
    enabled: z.boolean().optional(),
  })
  .refine((v) => Object.values(v).some((x) => x !== undefined), "Nada que cambiar.");
export type UpdateGeoPromptInput = z.infer<typeof UpdateGeoPromptInput>;

export interface GeoSuggestionInput {
  brandName: string | null;
  sector: string | null;
  offerings: string[];
  place: string | null;
  competitors: string[];
  audience: string | null;
  locale: string;
}
export interface GeoSuggestion {
  question: string;
  intent: GeoIntent;
  category: GeoCategory;
  basedOn: string[];
}

const lowerFirst = (s: string) => (s && s === s.toUpperCase() ? s : s.charAt(0).toLowerCase() + s.slice(1));
const short = (s: string, n = 60) => cleanQuestion(s).slice(0, n).replace(/[.,;:]+$/, "");
/** Competitor entries are domains: keep a readable name. */
const competitorName = (s: string) => s.replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/\/.*$/, "");

/**
 * Deterministic question templates from the confirmed or extracted brand profile. Only facts that
 * exist are used; whatever is missing is reported instead of being invented. Suggestions are not
 * stored until a person accepts them.
 */
export function suggestGeoPrompts(input: GeoSuggestionInput): { suggestions: GeoSuggestion[]; missing: string[] } {
  const en = input.locale.startsWith("en");
  const out: GeoSuggestion[] = [];
  const missing: string[] = [];
  const add = (question: string, intent: GeoIntent, category: GeoCategory, basedOn: string[]) => {
    const q = cleanQuestion(question);
    if (q.length >= 8 && q.length <= 300 && !out.some((o) => normalizeQuestion(o.question) === normalizeQuestion(q))) out.push({ question: q, intent, category, basedOn });
  };
  const brand = input.brandName ? short(input.brandName, 80) : null;
  const sector = input.sector ? lowerFirst(short(input.sector)) : null;
  const place = input.place ? short(input.place, 60) : null;
  const offerings = input.offerings.map((o) => lowerFirst(short(o))).filter(Boolean).slice(0, 3);
  const competitors = input.competitors.map(competitorName).filter(Boolean).slice(0, 3);

  if (!brand) missing.push(en ? "Brand name" : "Nombre de marca");
  if (!sector) missing.push(en ? "Sector / industry" : "Sector o tipo de negocio");
  if (!offerings.length) missing.push(en ? "Products or services" : "Productos o servicios");
  if (!place) missing.push(en ? "Area served / city" : "Zona de servicio o ciudad");
  if (!competitors.length) missing.push(en ? "Competitors" : "Competidores");

  if (brand) {
    add(en ? `What is ${brand} and what does it offer?` : `¿Qué es ${brand} y qué ofrece?`, "educational", "brand", ["name"]);
    add(en ? `Is ${brand} reliable? Reviews and prices` : `¿${brand} es de fiar? Opiniones y precios`, "transactional", "brand", ["name"]);
    for (const comp of competitors) add(en ? `${brand} vs ${comp}: which is better?` : `¿${brand} o ${comp}: cuál es mejor?`, "comparative", "brand", ["name", "competitors"]);
  }
  for (const off of offerings) {
    add(en ? `What is the best ${off}${place ? ` in ${place}` : ""}?` : `¿Cuál es el mejor ${off}${place ? ` en ${place}` : ""}?`, "comparative", "product", place ? ["offering", "place"] : ["offering"]);
    add(en ? `Where to buy ${off}${place ? ` in ${place}` : ""}?` : `¿Dónde contratar o comprar ${off}${place ? ` en ${place}` : ""}?`, "transactional", "product", place ? ["offering", "place"] : ["offering"]);
  }
  if (sector) {
    add(en ? `How to choose a ${sector} provider?` : `¿Cómo elegir una empresa de ${sector}?`, "educational", "sector", ["sector"]);
    add(en ? `Which ${sector} companies are recommended?` : `¿Qué empresas de ${sector} se recomiendan?`, "comparative", "sector", ["sector"]);
    if (input.audience) add(en ? `Best ${sector} options for ${lowerFirst(short(input.audience, 60))}` : `Mejores opciones de ${sector} para ${lowerFirst(short(input.audience, 60))}`, "comparative", "sector", ["sector", "audience"]);
    if (place) {
      add(en ? `Best ${sector} companies in ${place}` : `Mejores empresas de ${sector} en ${place}`, "comparative", "geography", ["sector", "place"]);
      add(en ? `${sector} near ${place} with good reviews` : `${sector} en ${place} con buenas opiniones`, "transactional", "geography", ["sector", "place"]);
    }
  }
  return { suggestions: out.slice(0, 20), missing };
}

// ---------------------------------------------------------------------------------------------
// Monitor: mention and citation detection on a REAL sampled answer (never on simulated text).

export interface GeoCitation {
  title: string;
  uri: string;
  domain: string | null;
}
export interface GeoEntity {
  name: string;
  domain: string | null;
}
export interface GeoMentionResult {
  mentioned: boolean;
  mentionCount: number;
  cited: boolean;
}

const fold = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFD")
    .replace(new RegExp("[\u0300-\u036f]", "g"), "");
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Bare host of a domain or URL: "https://www.Example.com/x" → "example.com". */
export function bareDomain(v: string | null | undefined): string | null {
  if (!v) return null;
  const host = v.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").replace(/[/?#].*$/, "").replace(/:\d+$/, "");
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(host) ? host : null;
}

/** Terms that identify an entity in free text: its name, the name without spaces, the domain and the domain label. */
export function entityTerms(e: GeoEntity): string[] {
  const terms = new Set<string>();
  const name = fold(e.name).replace(/\s+/g, " ").trim();
  if (name.length >= 3) {
    terms.add(name);
    if (name.includes(" ")) terms.add(name.replace(/ /g, ""));
  }
  const d = bareDomain(e.domain);
  if (d) {
    terms.add(d);
    const label = d.split(".")[0]!;
    if (label.length >= 4) terms.add(label);
  }
  return [...terms];
}

/** Counts whole-word occurrences of the entity in the answer and whether a cited source belongs to it. */
export function detectMention(answer: string, citations: GeoCitation[], e: GeoEntity): GeoMentionResult {
  const text = fold(answer);
  let count = 0;
  const spans: Array<[number, number]> = [];
  // Longest terms first so "dni growth" is not counted again as "dnigrowth"/"dni".
  for (const term of entityTerms(e).sort((a, b) => b.length - a.length)) {
    const re = new RegExp(`(^|[^a-z0-9])(${escapeRe(term)})(?![a-z0-9])`, "g");
    for (const m of text.matchAll(re)) {
      const start = (m.index ?? 0) + m[1]!.length;
      const end = start + m[2]!.length;
      if (spans.some(([s, f]) => start < f && end > s)) continue;
      spans.push([start, end]);
      count++;
    }
  }
  const d = bareDomain(e.domain);
  const cited = !!d && citations.some((c) => {
    const cd = c.domain ?? bareDomain(c.title);
    return !!cd && (cd === d || cd.endsWith(`.${d}`));
  });
  return { mentioned: count > 0, mentionCount: count, cited };
}
