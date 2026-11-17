/**
 * OpenRouter FREE-only policy (pure logic, no I/O).
 *
 * Policy (owner's standing rule, applies to every present and future feature):
 *   OPENROUTER = ONLY FREE MODELS. Authorised OpenRouter spend: 0.00 USD.
 *
 * A model is usable only when ALL of these hold:
 *   - its id ends in ":free" (or it is the official "openrouter/free" router),
 *   - every pricing component published by the catalogue parses to exactly 0,
 *     prompt and completion are present, and no pricing overrides exist,
 *   - it serves text through /api/v1/chat/completions,
 *   - it has not expired.
 * Anything else is excluded and labelled. There is no code path that accepts a paid model.
 */

export const OPENROUTER_API = "https://openrouter.ai/api/v1";
export const OPENROUTER_FREE_ROUTER = "openrouter/free";
/** Sent with every OpenRouter request: providers must charge 0 for every component. */
export const ZERO_MAX_PRICE = { prompt: 0, completion: 0, request: 0, image: 0 } as const;
/** A catalogue snapshot older than this is no longer trusted for eligibility. */
export const CATALOG_TTL_HOURS = 26;

export type FreeClass = "verified" | "restricted" | "unknown" | "paid" | "incompatible" | "unavailable";

export const FREE_CLASS_LABEL: Record<FreeClass, string> = {
  verified: "GRATIS VERIFICADO",
  restricted: "GRATIS CON RESTRICCIONES",
  unknown: "PRECIO DESCONOCIDO",
  paid: "DE PAGO / BLOQUEADO",
  incompatible: "NO COMPATIBLE",
  unavailable: "TEMPORALMENTE NO DISPONIBLE",
};

export type Capability = "chat" | "reasoning" | "vision" | "audio_input" | "video_input" | "tools" | "structured_output" | "long_context";

export type AiCategory = "chat_reasoning" | "code_analysis" | "seo_geo_aeo" | "marketing_content" | "vision_multimodal" | "translation_documents";

export const CATEGORY_INFO: Record<AiCategory, { label: string; rule: string }> = {
  chat_reasoning: { label: "Chat y razonamiento", rule: "Chat de texto; marcado como razonamiento si admite el parámetro reasoning." },
  code_analysis: { label: "Programación y análisis", rule: "Admite herramientas (tools) o salida estructurada (JSON)." },
  seo_geo_aeo: { label: "SEO, GEO y AEO", rule: "Chat de texto con al menos 32k de contexto (cabe una auditoría completa)." },
  marketing_content: { label: "Marketing y contenido", rule: "Chat de texto con al menos 32k de contexto." },
  vision_multimodal: { label: "Análisis visual y multimodal", rule: "Acepta imágenes de entrada (entiende imágenes; NO las genera)." },
  translation_documents: { label: "Traducción y documentos", rule: "Al menos 128k de contexto para documentos largos." },
};

/** Raw catalogue entry (only the fields we read; everything else is ignored). */
export interface OrCatalogModel {
  id?: unknown;
  name?: unknown;
  description?: unknown;
  context_length?: unknown;
  architecture?: { input_modalities?: unknown; output_modalities?: unknown } | null;
  pricing?: unknown;
  top_provider?: { max_completion_tokens?: unknown } | null;
  per_request_limits?: unknown;
  supported_parameters?: unknown;
  endpoints?: unknown;
  expiration_date?: unknown;
}

export interface ClassifiedModel {
  modelId: string;
  displayName: string;
  description: string;
  contextLength: number;
  maxOutput: number | null;
  inputModalities: string[];
  outputModalities: string[];
  endpoints: string[];
  supportedParameters: string[];
  pricing: Record<string, string>;
  priceHash: string;
  freeClass: FreeClass;
  reasons: string[];
  capabilities: Capability[];
  categories: AiCategory[];
  eligible: boolean;
  expirationDate: string | null;
  isRouter: boolean;
}

const strArr = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").slice(0, 64) : []);
const ID_RE = /^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._:-]*$/i;

/** Removes HTML, control chars and markdown links/images from untrusted catalogue text. */
export function sanitizeCatalogText(s: unknown, max = 400): string {
  if (typeof s !== "string") return "";
  return s
    .replace(/<[^>]*>/g, " ")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/https?:\/\/\S+/g, "")
    // eslint-disable-next-line no-control-regex -- intentionally removing control characters
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

/** Stable fingerprint of the pricing object (detects any price change between syncs). */
export function priceFingerprint(pricing: Record<string, string>): string {
  return Object.keys(pricing)
    .sort()
    .map((k) => `${k}=${pricing[k]}`)
    .join(";");
}

function normalisePricing(p: unknown): { pricing: Record<string, string>; problems: string[] } {
  const problems: string[] = [];
  const pricing: Record<string, string> = {};
  if (!p || typeof p !== "object" || Array.isArray(p)) return { pricing, problems: ["sin_tarifas_publicadas"] };
  for (const [k, v] of Object.entries(p as Record<string, unknown>)) {
    if (k === "overrides") {
      const empty = v === null || v === undefined || (Array.isArray(v) && v.length === 0) || (typeof v === "object" && Object.keys(v as object).length === 0);
      pricing[k] = empty ? "" : "present";
      if (!empty) problems.push("tarifas_especiales_no_verificables");
      continue;
    }
    if (typeof v !== "string" && typeof v !== "number") {
      pricing[k] = "?";
      problems.push(`tarifa_${k}_no_numerica`);
      continue;
    }
    pricing[k] = String(v);
  }
  return { pricing, problems };
}

export function classifyOpenRouterModel(raw: OrCatalogModel, now = new Date()): ClassifiedModel | null {
  if (typeof raw.id !== "string" || raw.id.length > 120 || !ID_RE.test(raw.id)) return null;
  const modelId = raw.id;
  const isRouter = modelId === OPENROUTER_FREE_ROUTER;
  const reasons: string[] = [];
  const inputModalities = strArr(raw.architecture?.input_modalities);
  const outputModalities = strArr(raw.architecture?.output_modalities);
  const endpoints = strArr(raw.endpoints);
  const supportedParameters = strArr(raw.supported_parameters);
  const contextLength = typeof raw.context_length === "number" && raw.context_length > 0 ? Math.floor(raw.context_length) : 0;
  const maxOut = raw.top_provider?.max_completion_tokens;
  const maxOutput = typeof maxOut === "number" && maxOut > 0 ? Math.floor(maxOut) : null;
  const expirationDate = typeof raw.expiration_date === "string" && raw.expiration_date ? raw.expiration_date : null;
  const { pricing, problems } = normalisePricing(raw.pricing);

  let freeClass: FreeClass = "verified";
  if (!modelId.endsWith(":free") && !isRouter) {
    freeClass = "paid";
    reasons.push("no_es_variante_free");
  } else {
    const numeric = Object.entries(pricing).filter(([k]) => k !== "overrides");
    const nonZero = numeric.filter(([, v]) => !(v.trim() !== "" && Number.isFinite(Number(v)) && Number(v) === 0));
    if (nonZero.length) {
      freeClass = "paid";
      reasons.push(...nonZero.map(([k]) => `tarifa_${k}_distinta_de_cero`));
    } else if (problems.length || !("prompt" in pricing) || !("completion" in pricing)) {
      freeClass = "unknown";
      reasons.push(...problems);
      if (!("prompt" in pricing) || !("completion" in pricing)) reasons.push("faltan_tarifas_prompt_o_completion");
    }
  }

  const chatEndpoint = endpoints.length === 0 ? isRouter : endpoints.includes("/api/v1/chat/completions");
  const textOut = outputModalities.length === 0 ? isRouter : outputModalities.includes("text");
  if (freeClass === "verified" || freeClass === "unknown") {
    if (!textOut || outputModalities.some((m) => m !== "text")) {
      freeClass = freeClass === "verified" ? "incompatible" : freeClass;
      reasons.push("salida_no_es_solo_texto");
    } else if (!chatEndpoint) {
      freeClass = freeClass === "verified" ? "incompatible" : freeClass;
      reasons.push("sin_endpoint_chat_completions");
    }
  }
  if (freeClass === "verified" && expirationDate) {
    const exp = Date.parse(expirationDate);
    if (Number.isFinite(exp) && exp <= now.getTime()) {
      freeClass = "unavailable";
      reasons.push("modelo_caducado");
    } else {
      freeClass = "restricted";
      reasons.push(`disponible_hasta_${expirationDate.slice(0, 10)}`);
    }
  }
  if (freeClass === "verified" && (raw.per_request_limits ?? null) !== null) {
    freeClass = "restricted";
    reasons.push("limites_por_peticion");
  }

  const capabilities: Capability[] = [];
  if (textOut && chatEndpoint) capabilities.push("chat");
  if (supportedParameters.includes("reasoning") || supportedParameters.includes("include_reasoning")) capabilities.push("reasoning");
  if (inputModalities.includes("image")) capabilities.push("vision");
  if (inputModalities.includes("audio")) capabilities.push("audio_input");
  if (inputModalities.includes("video")) capabilities.push("video_input");
  if (supportedParameters.includes("tools")) capabilities.push("tools");
  if (supportedParameters.includes("response_format") || supportedParameters.includes("structured_outputs")) capabilities.push("structured_output");
  if (contextLength >= 128_000) capabilities.push("long_context");

  const categories: AiCategory[] = [];
  if (capabilities.includes("chat")) {
    categories.push("chat_reasoning");
    if (capabilities.includes("tools") || capabilities.includes("structured_output")) categories.push("code_analysis");
    if (contextLength >= 32_000 || isRouter) categories.push("seo_geo_aeo", "marketing_content");
    if (capabilities.includes("vision")) categories.push("vision_multimodal");
    if (contextLength >= 128_000) categories.push("translation_documents");
  }

  const eligible = (freeClass === "verified" || freeClass === "restricted") && capabilities.includes("chat");
  return {
    modelId,
    displayName: sanitizeCatalogText(raw.name, 120) || modelId,
    description: sanitizeCatalogText(raw.description, 400),
    contextLength,
    maxOutput,
    inputModalities,
    outputModalities,
    endpoints,
    supportedParameters,
    pricing,
    priceHash: priceFingerprint(pricing),
    freeClass,
    reasons,
    capabilities,
    categories,
    eligible,
    expirationDate,
    isRouter,
  };
}

/** Classifies a full catalogue and keeps only rows we persist (":free" ids + the free router). */
export function buildFreeCatalog(data: unknown, now = new Date()): { models: ClassifiedModel[]; seen: number; excludedPaid: number } {
  const arr = Array.isArray(data) ? (data as OrCatalogModel[]) : [];
  const models: ClassifiedModel[] = [];
  let excludedPaid = 0;
  for (const raw of arr.slice(0, 5000)) {
    const m = classifyOpenRouterModel(raw, now);
    if (!m) continue;
    if (m.modelId.endsWith(":free") || m.isRouter) models.push(m);
    else excludedPaid++;
  }
  return { models, seen: arr.length, excludedPaid };
}

// ── Task profiles ────────────────────────────────────────────────────────────────────────────
export type AiTask =
  | "advisor_chat"
  | "seo_strategy"
  | "content_article"
  | "competitor_analysis"
  | "editorial_review"
  | "classification"
  | "audit_reasoning"
  | "structured_plan"
  | "translation"
  | "customer_support"
  | "image_interpretation"
  | "document_extraction";

export interface TaskProfile {
  label: string;
  requires: Capability[];
  minContext: number;
  maxOutputTokens: number;
  temperature: number;
  category: AiCategory;
}

export const TASK_PROFILES: Record<AiTask, TaskProfile> = {
  advisor_chat: { label: "Asesor de crecimiento", requires: ["chat"], minContext: 16_000, maxOutputTokens: 900, temperature: 0.4, category: "seo_geo_aeo" },
  seo_strategy: { label: "Estrategia SEO/GEO/AEO", requires: ["chat"], minContext: 32_000, maxOutputTokens: 1200, temperature: 0.4, category: "seo_geo_aeo" },
  content_article: { label: "Artículos y copy comercial", requires: ["chat"], minContext: 32_000, maxOutputTokens: 2200, temperature: 0.6, category: "marketing_content" },
  competitor_analysis: { label: "Análisis de competencia", requires: ["chat"], minContext: 32_000, maxOutputTokens: 1200, temperature: 0.3, category: "seo_geo_aeo" },
  editorial_review: { label: "Revisión editorial y factual", requires: ["chat"], minContext: 32_000, maxOutputTokens: 1000, temperature: 0.2, category: "marketing_content" },
  classification: { label: "Clasificación", requires: ["chat"], minContext: 8_000, maxOutputTokens: 200, temperature: 0, category: "code_analysis" },
  audit_reasoning: { label: "Razonamiento de auditorías", requires: ["chat"], minContext: 32_000, maxOutputTokens: 1200, temperature: 0.2, category: "chat_reasoning" },
  structured_plan: { label: "Planes estructurados (JSON)", requires: ["chat", "structured_output"], minContext: 32_000, maxOutputTokens: 1500, temperature: 0.2, category: "code_analysis" },
  translation: { label: "Traducción", requires: ["chat"], minContext: 32_000, maxOutputTokens: 2500, temperature: 0.2, category: "translation_documents" },
  customer_support: { label: "Atención al cliente", requires: ["chat"], minContext: 8_000, maxOutputTokens: 600, temperature: 0.4, category: "chat_reasoning" },
  image_interpretation: { label: "Interpretación de imágenes", requires: ["chat", "vision"], minContext: 8_000, maxOutputTokens: 800, temperature: 0.2, category: "vision_multimodal" },
  document_extraction: { label: "Extracción de documentos", requires: ["chat", "long_context"], minContext: 128_000, maxOutputTokens: 1500, temperature: 0.1, category: "translation_documents" },
};

export const AI_TASKS = Object.keys(TASK_PROFILES) as AiTask[];

export interface EligibilityRow {
  modelId: string;
  eligible: boolean;
  freeClass: FreeClass;
  capabilities: Capability[];
  contextLength: number;
  lastCheckedAt: string;
  cooldownUntil?: string | null;
  removedAt?: string | null;
}

/** Final gate, evaluated immediately before any OpenRouter request. Fail-closed. */
export function freeGate(row: EligibilityRow | null, task: AiTask, now = new Date()): { ok: true } | { ok: false; reason: string } {
  if (!row) return { ok: false, reason: "modelo_no_esta_en_la_lista_permitida" };
  if (!row.modelId.endsWith(":free") && row.modelId !== OPENROUTER_FREE_ROUTER) return { ok: false, reason: "no_es_variante_free" };
  if (row.removedAt) return { ok: false, reason: "retirado_del_catalogo" };
  if (!row.eligible || (row.freeClass !== "verified" && row.freeClass !== "restricted")) return { ok: false, reason: `clasificacion_${row.freeClass}` };
  const age = now.getTime() - Date.parse(row.lastCheckedAt);
  if (!Number.isFinite(age) || age > CATALOG_TTL_HOURS * 3600_000) return { ok: false, reason: "precio_no_revalidado_recientemente" };
  const p = TASK_PROFILES[task];
  if (!p.requires.every((c) => row.capabilities.includes(c))) return { ok: false, reason: "capacidad_no_soportada" };
  if (row.modelId !== OPENROUTER_FREE_ROUTER && row.contextLength < p.minContext) return { ok: false, reason: "contexto_insuficiente" };
  if (row.cooldownUntil && Date.parse(row.cooldownUntil) > now.getTime()) return { ok: false, reason: "en_pausa_por_fallos" };
  return { ok: true };
}

export interface ObservedStats {
  ok: number;
  failed: number;
  avgLatencyMs: number | null;
}

/**
 * Ranks eligible models for a task using OBSERVED results only (success rate with a Laplace
 * prior, then latency), plus capability fit. No invented benchmarks.
 */
export function rankModels<T extends EligibilityRow>(rows: T[], task: AiTask, stats: Record<string, ObservedStats>, now = new Date()): T[] {
  const scored = rows
    .filter((r) => r.modelId !== OPENROUTER_FREE_ROUTER && freeGate(r, task, now).ok)
    .map((r) => {
      const s = stats[r.modelId] ?? { ok: 0, failed: 0, avgLatencyMs: null };
      const success = (s.ok + 1) / (s.ok + s.failed + 2);
      const latency = typeof s.avgLatencyMs === "number" ? Math.max(0, 1 - s.avgLatencyMs / 60_000) : 0.5;
      const ctx = Math.min(1, r.contextLength / 256_000);
      const reasoningBonus = (task === "audit_reasoning" || task === "seo_strategy") && r.capabilities.includes("reasoning") ? 0.05 : 0;
      return { r, score: success * 0.7 + latency * 0.2 + ctx * 0.1 + reasoningBonus };
    });
  scored.sort((a, b) => b.score - a.score || a.r.modelId.localeCompare(b.r.modelId));
  return scored.map((x) => x.r);
}

/** Validates a reported served model: the router may only serve ":free" variants. */
export function servedModelAllowed(requested: string, served: unknown): boolean {
  if (typeof served !== "string" || !served) return true; // not reported: requested id was used
  if (requested === OPENROUTER_FREE_ROUTER) return served === OPENROUTER_FREE_ROUTER || served.endsWith(":free");
  // Direct requests may report the canonical slug (e.g. "vendor/model-20261113"); it must be the same model family.
  return served.startsWith(requested.replace(/:free$/, ""));
}
