/**
 * F3 — Explainable GEO recommendations and comparable visibility statistics.
 *
 * Everything here is DETERMINISTIC (no AI call, no cost): each recommendation states the observed gap
 * (with the sample that proves it), the page or action it maps to, why, and the limits of the inference.
 * Nothing is promised: publishing a page does not guarantee that an AI engine will mention the brand.
 */
import { GEO_CATEGORY_LABEL, GEO_INTENT_LABEL, normalizeQuestion, type GeoCategory, type GeoIntent } from "./geo";

/** Wilson score interval for a proportion (95 % by default). Honest for small samples, never outside [0, 1]. */
export function wilsonInterval(k: number, n: number, z = 1.96): { low: number; high: number } | null {
  if (!Number.isFinite(k) || !Number.isFinite(n) || n <= 0 || k < 0 || k > n) return null;
  const p = k / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const centre = (p + z2 / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
  const r = (x: number) => Math.round(Math.min(1, Math.max(0, x)) * 1000) / 1000;
  return { low: r(centre - half), high: r(centre + half) };
}

export interface GeoRecSample {
  promptId: string;
  question: string;
  intent: GeoIntent;
  category: GeoCategory;
  sampleId: string;
  sampledAt: string;
  model: string;
  grounded: boolean;
  mentioned: boolean;
  cited: boolean;
  competitorsMentioned: string[];
}

export interface GeoRecPage {
  url: string;
  title: string | null;
  h1: string | null;
}

export interface GeoRecInput {
  brandName: string;
  samples: GeoRecSample[];
  pages: GeoRecPage[];
  site: { origin: string | null; llmsTxt: boolean | null; organizationJsonLd: boolean | null; crawledAt: string | null };
}

export type GeoRecPriority = "alta" | "media" | "baja";
export type GeoContentKind = "blog_article" | "landing_copy" | "faq_aeo" | "entity_summary";

export interface GeoRecommendation {
  id: string;
  priority: GeoRecPriority;
  score: number;
  title: string;
  gap: string;
  action: string;
  why: string;
  target: { type: "existing_page" | "new_page" | "site"; url: string | null; title: string | null; reason: string };
  draft: { kind: GeoContentKind; title: string; keyword: string; angle: string } | null;
  evidence: Array<{ promptId: string; sampleId: string; question: string; sampledAt: string; model: string; grounded: boolean; mentioned: boolean; competitorsMentioned: string[] }>;
  limitations: string[];
  measurement: "derived";
}

const STOP = new Set(
  "a al algo algun alguna alguno ante como con cual cuales cuando de del donde el en entre es esta este esto la las lo los mas me mejor mejores mi mis muy no o para pero por que quien se ser si sin sobre son su sus te tu un una uno unos y ya hay puedo debo hacer hago tiene tienen the and for with what how".split(" "),
);
export function keywordTokens(s: string, exclude: string[] = []): string[] {
  const ex = new Set(exclude.flatMap((e) => normalizeQuestion(e).split(" ")));
  return [...new Set(normalizeQuestion(s).replace(/[^a-z0-9ñ ]/g, " ").split(/\s+/).filter((w) => w.length > 2 && !STOP.has(w) && !ex.has(w)))];
}

/** Picks the crawled page whose URL/title/H1 shares the most keywords with the question (≥ 2, or 1 for very short questions). */
export function matchPage(question: string, pages: GeoRecPage[], brandName: string): { page: GeoRecPage; overlap: string[] } | null {
  const q = keywordTokens(question, [brandName]);
  if (!q.length) return null;
  let best: { page: GeoRecPage; overlap: string[] } | null = null;
  for (const page of pages) {
    let path = page.url;
    try {
      path = new URL(page.url).pathname;
    } catch {
      /* keep raw */
    }
    const words = new Set(keywordTokens(`${path.replace(/[/_-]+/g, " ")} ${page.title ?? ""} ${page.h1 ?? ""}`, [brandName]));
    const overlap = q.filter((w) => words.has(w) || [...words].some((x) => x.length > 4 && w.length > 4 && (x.startsWith(w.slice(0, 5)) || w.startsWith(x.slice(0, 5)))));
    if (!best || overlap.length > best.overlap.length) best = { page, overlap };
  }
  const need = q.length <= 2 ? 1 : 2;
  return best && best.overlap.length >= need ? best : null;
}

const slugify = (s: string) =>
  keywordTokens(s)
    .slice(0, 6)
    .join("-")
    .slice(0, 60) || "nueva-pagina";

const COMMON_LIMITS = (s: GeoRecSample) => [
  `Basado en 1 respuesta observada (${s.model}, ${s.sampledAt.slice(0, 10)}). Las respuestas de IA varían entre ejecuciones: repite el muestreo antes de decidir.`,
  s.grounded
    ? "La respuesta usó búsqueda web: los cambios en tu web pueden reflejarse cuando el motor vuelva a rastrearla, sin plazo garantizado."
    : "La respuesta se generó SIN búsqueda web (nivel gratuito): refleja lo que el modelo aprendió en su entrenamiento. Publicar contenido no la cambia de inmediato; los modelos se actualizan en meses y no hay garantía.",
  "Es una inferencia por reglas (hueco observado → tipo de contenido), no una relación causa-efecto demostrada. Ningún cambio garantiza menciones en motores de IA.",
];

const PRIORITY_RANK: Record<GeoRecPriority, number> = { alta: 3, media: 2, baja: 1 };

export function buildGeoRecommendations(input: GeoRecInput): GeoRecommendation[] {
  const recs: GeoRecommendation[] = [];
  const brand = input.brandName;
  for (const s of input.samples) {
    const evidence = [{ promptId: s.promptId, sampleId: s.sampleId, question: s.question, sampledAt: s.sampledAt, model: s.model, grounded: s.grounded, mentioned: s.mentioned, competitorsMentioned: s.competitorsMentioned }];
    const rivals = s.competitorsMentioned.length;
    const match = matchPage(s.question, input.pages, brand);
    const keyword = keywordTokens(s.question, [brand]).slice(0, 5).join(" ") || s.question.slice(0, 60);
    const target = (newTitle: string): GeoRecommendation["target"] =>
      match
        ? { type: "existing_page", url: match.page.url, title: match.page.title ?? match.page.h1, reason: `Comparte con la pregunta: ${match.overlap.join(", ")}. Mejorar esta página antes que crear otra evita contenido duplicado.` }
        : { type: "new_page", url: input.site.origin ? `${input.site.origin}/${slugify(newTitle)}` : null, title: newTitle, reason: "Ninguna página rastreada trata este tema (sin coincidencia de palabras clave con URL, título o H1)." };
    const base = { evidence, measurement: "derived" as const };
    // Questions about the brand itself: the official home page is the natural source when no page matches.
    const brandTarget = (newTitle: string): GeoRecommendation["target"] => {
      if (match) return target(newTitle);
      const home = input.pages.find((p) => {
        try {
          return new URL(p.url).pathname === "/";
        } catch {
          return false;
        }
      });
      return home ? { type: "existing_page", url: home.url, title: home.title ?? home.h1, reason: "La página de inicio es la fuente oficial principal sobre la marca." } : target(newTitle);
    };

    if (s.category === "brand") {
      if (!s.mentioned) {
        recs.push({
          ...base,
          id: `brand-unknown:${s.promptId}`,
          priority: "alta",
          score: 90,
          title: `El motor no reconoce a ${brand} en una pregunta sobre la propia marca`,
          gap: `A «${s.question}» la respuesta no menciona ${brand}.`,
          action: `Página «Qué es ${brand}» (o «Sobre nosotros») que defina la entidad en la primera frase: qué es, qué ofrece, para quién y dónde, con datos verificables; añade JSON-LD Organization con sameAs a tus perfiles oficiales.`,
          why: "Los motores responden mejor sobre entidades descritas de forma explícita y coherente en su web oficial y en perfiles de terceros.",
          target: brandTarget(`Qué es ${brand}`),
          draft: { kind: "entity_summary", title: `Qué es ${brand}`, keyword: brand, angle: "Definición clara de la entidad con datos verificables, sin promesas." },
          limitations: COMMON_LIMITS(s),
        });
      } else if (!s.grounded) {
        recs.push({
          ...base,
          id: `brand-verify:${s.promptId}`,
          priority: "media",
          score: 55,
          title: `Revisa que lo que dice el motor sobre ${brand} sea correcto`,
          gap: `A «${s.question}» el motor menciona ${brand}, pero respondió sin búsqueda web: puede haber datos inventados o desactualizados.`,
          action: "Lee la respuesta guardada y anota cada dato falso. Corrige o amplía la página oficial que debería servir de fuente (servicios, precios, contacto) para que la información correcta sea fácil de encontrar.",
          why: "Una mención con datos falsos puede dañar más que la ausencia de mención.",
          target: brandTarget(`Sobre ${brand}`),
          draft: null,
          limitations: [...COMMON_LIMITS(s), "DNI Growth no comprueba automáticamente la veracidad de la respuesta: requiere revisión humana."],
        });
      }
      continue;
    }
    if (s.mentioned) continue; // no gap on this prompt

    if (s.intent === "comparative") {
      recs.push({
        ...base,
        id: `comparative:${s.promptId}`,
        priority: rivals ? "alta" : "media",
        score: rivals ? 85 : 65,
        title: rivals ? `Aparecen otros y no ${brand} en una comparativa` : `${brand} no aparece en una pregunta comparativa`,
        gap: `«${s.question}»: ${brand} no aparece${rivals ? `; sí aparecen ${s.competitorsMentioned.slice(0, 5).join(", ")}` : ""}.`,
        action: "Página de comparativa o alternativas honesta: criterios explícitos, tabla comparativa y para quién es cada opción (incluida la tuya). Busca además presencia legítima en reseñas y directorios del sector; nunca enlaces comprados.",
        why: "Las preguntas comparativas se responden con listas; los motores tienden a citar fuentes que comparan con criterios claros.",
        target: target(s.question.replace(/[¿?]/g, "")),
        draft: { kind: "blog_article", title: s.question.replace(/[¿?]/g, "").trim(), keyword, angle: "Comparativa con criterios explícitos y honesta; incluye cuándo NO somos la mejor opción." },
        limitations: COMMON_LIMITS(s),
      });
    } else if (s.intent === "transactional") {
      recs.push({
        ...base,
        id: `transactional:${s.promptId}`,
        priority: "alta",
        score: rivals ? 88 : 75,
        title: `${brand} no aparece cuando alguien quiere contratar o comprar`,
        gap: `«${s.question}»: ${brand} no aparece${rivals ? `; sí aparecen ${s.competitorsMentioned.slice(0, 5).join(", ")}` : ""}.`,
        action: `Página de servicio clara: qué incluye, precio o rango, zona${s.category === "geography" ? " y ciudades donde trabajas" : ""}, plazos y llamada a la acción; marcado JSON-LD Service/Offer${s.category === "geography" ? " y LocalBusiness si atiendes en un lugar físico" : ""}.`,
        why: "Las preguntas transaccionales premian páginas con oferta concreta y verificable.",
        target: target(s.question.replace(/[¿?]/g, "")),
        draft: { kind: "landing_copy", title: s.question.replace(/[¿?]/g, "").trim(), keyword, angle: "Oferta concreta y verificable; sin garantías de resultados." },
        limitations: COMMON_LIMITS(s),
      });
    } else {
      recs.push({
        ...base,
        id: `educational:${s.promptId}`,
        priority: rivals ? "media" : "baja",
        score: rivals ? 60 : 45,
        title: `${brand} no aparece en una pregunta informativa del sector`,
        gap: `«${s.question}»: ${brand} no aparece${rivals ? `; sí aparecen ${s.competitorsMentioned.slice(0, 5).join(", ")}` : ""}.`,
        action: "Guía o FAQ que responda la pregunta directamente: respuesta de 40–60 palabras al principio y después el detalle, con autoría, fecha y fuentes.",
        why: "Los motores extraen respuestas directas y bien estructuradas; el formato pregunta-respuesta facilita citarlas.",
        target: target(s.question.replace(/[¿?]/g, "")),
        draft: { kind: "faq_aeo", title: s.question.replace(/[¿?]/g, "").trim(), keyword, angle: "Respuesta directa primero, luego detalle con fuentes." },
        limitations: COMMON_LIMITS(s),
      });
    }
  }

  // Site-level signals (from the latest crawl; null = unknown, nothing is recommended).
  const siteLimits = ["Señal técnica de apoyo: ayuda a que los motores entiendan tu web, pero por sí sola no produce menciones."];
  if (input.site.organizationJsonLd === false)
    recs.push({
      id: "site:organization-jsonld",
      priority: "media",
      score: 50,
      title: "Falta el marcado de organización (JSON-LD Organization)",
      gap: `La última auditoría (${input.site.crawledAt?.slice(0, 10) ?? "fecha desconocida"}) no encontró JSON-LD Organization en las páginas rastreadas.`,
      action: "Añade en la página de inicio un JSON-LD Organization con nombre, URL, logo y sameAs a tus perfiles oficiales.",
      why: "Describe la entidad de forma inequívoca para buscadores y motores de IA.",
      target: { type: "site", url: input.site.origin, title: "Página de inicio", reason: "El marcado de organización va en la página principal." },
      draft: null,
      evidence: [],
      limitations: siteLimits,
      measurement: "derived",
    });
  if (input.site.llmsTxt === false)
    recs.push({
      id: "site:llms-txt",
      priority: "baja",
      score: 30,
      title: "No hay /llms.txt",
      gap: `La última auditoría (${input.site.crawledAt?.slice(0, 10) ?? "fecha desconocida"}) no encontró /llms.txt.`,
      action: "Publica /llms.txt con un resumen de la empresa y enlaces a las páginas clave (servicios, precios, contacto).",
      why: "Es una propuesta abierta para orientar a los modelos; su uso por los motores no está garantizado.",
      target: { type: "site", url: input.site.origin ? `${input.site.origin}/llms.txt` : null, title: "/llms.txt", reason: "Archivo en la raíz del dominio." },
      draft: null,
      evidence: [],
      limitations: [...siteLimits, "Ningún motor principal ha confirmado públicamente que use llms.txt para decidir sus respuestas."],
      measurement: "derived",
    });

  return recs.sort((a, b) => PRIORITY_RANK[b.priority] - PRIORITY_RANK[a.priority] || b.score - a.score || a.id.localeCompare(b.id));
}

export const GEO_REC_METHOD =
  "Reglas deterministas de DNI Growth sobre la última respuesta correcta de cada pregunta: hueco observado (la marca no aparece, aparecen otros, o la respuesta no usó búsqueda) → tipo de página según la intención (educativa → guía/FAQ, comparativa → comparativa honesta, transaccional → página de servicio, marca → página de entidad). La página destino se elige por coincidencia de palabras con las páginas rastreadas.";

export const geoIntentLabel = (i: GeoIntent) => GEO_INTENT_LABEL[i];
export const geoCategoryLabel = (c: GeoCategory) => GEO_CATEGORY_LABEL[c];
