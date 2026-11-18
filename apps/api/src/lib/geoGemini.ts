import { bareDomain, type GeoCitation } from "@dni/core";
import type { Deps, Env } from "../env";

/**
 * Gemini API sampler for the GEO monitor (FREE tier only).
 *
 * The model comes from the GEMINI_MODEL var (default gemini-3.8-flash). Each run first asks with the
 * Google Search tool; when the free tier refuses search for that model (Gemini 3.x has no free
 * grounding), the rest of the run samples WITHOUT search and every sample records whether it was
 * grounded. Transient 5xx answers ("high demand") are retried briefly and, if GEMINI_FALLBACK_MODEL is
 * set, the question goes to that (also free) model; each sample stores the model that answered.
 * The key's project has no billing account (AI Studio: "Nivel gratuito"), so calls cannot be
 * charged. Our own daily caps stay far below Google's free limits.
 */
export const GEO_DEFAULT_MODEL = "gemini-3.8-flash";
const MODEL_RE = /^gemini-[a-z0-9][a-z0-9.-]{1,60}$/;
export const geoModel = (env: Env) => {
  const m = (env.GEMINI_MODEL ?? "").trim();
  return MODEL_RE.test(m) ? m : GEO_DEFAULT_MODEL;
};
export const geoFallbackModel = (env: Env) => {
  const m = (env.GEMINI_FALLBACK_MODEL ?? "").trim();
  return MODEL_RE.test(m) && m !== geoModel(env) ? m : null;
};
export const geoMethod = (grounding: boolean) => (grounding ? "gemini-api:generateContent+google_search:v1" : "gemini-api:generateContent:v1");
const MAX_ANSWER = 12_000;

export const geoLimits = (env: Env) => ({
  globalDaily: Math.max(0, Number(env.GEO_SAMPLES_DAILY_GLOBAL ?? 150) || 0),
  orgDaily: Math.max(0, Number(env.GEO_SAMPLES_DAILY_ORG ?? 40) || 0),
  perRun: Math.max(1, Math.min(50, Number(env.GEO_RUN_MAX ?? 20) || 20)),
  spacingMs: Math.max(0, Number(env.GEO_SPACING_MS ?? 4500) || 0),
});
export const geoSamplingReady = (env: Env) => !!env.GEMINI_API_KEY && geoLimits(env).globalDaily > 0;

export class GeminiCallError extends Error {
  constructor(
    public readonly code: string,
    public readonly permanent: boolean,
    public readonly stopRun: boolean,
    /** Google's own error text, sanitized (never contains the key, which travels in a header). */
    public readonly detail: string | null = null,
  ) {
    super(code);
  }

  /** Overload / outage on Google's side: worth a short retry or another model. */
  get transient() {
    return this.code === "gemini_network" || /^gemini_5\d\d$/.test(this.code);
  }
}

/** Keeps a short, safe excerpt of an API error message for diagnostics. */
export function safeErrorDetail(v: unknown): string | null {
  if (typeof v !== "string" || !v.trim()) return null;
  return v.replace(/AIza[\w-]{10,}/g, "[redacted]").replace(/\s+/g, " ").trim().slice(0, 300);
}

export interface GeminiSample {
  status: "ok" | "blocked" | "empty";
  text: string;
  truncated: boolean;
  citations: GeoCitation[];
  searchQueries: string[];
  modelVersion: string | null;
  grounded: boolean;
  inputTokens: number | null;
  outputTokens: number | null;
}

const LANG: Record<string, string> = { es: "español", en: "inglés", ca: "catalán", pt: "portugués", fr: "francés", de: "alemán", it: "italiano" };

/** Context given to the model. Gemini has no per-request location for Search, so region is stated explicitly. */
export function sampleInstruction(locale: string, country: string, detail: string | null) {
  let region = country;
  try {
    region = new Intl.DisplayNames(["es"], { type: "region" }).of(country) ?? country;
  } catch {
    /* keep ISO code */
  }
  const lang = LANG[locale.slice(0, 2)] ?? locale;
  return `Responde en ${lang} a la pregunta de una persona que se encuentra en ${detail ? `${detail}, ` : ""}${region}, como lo harías para cualquier usuario. Usa la búsqueda de Google si está disponible y te ayuda.`;
}

type GeminiResponse = {
  candidates?: Array<{
    finishReason?: string;
    content?: { parts?: Array<{ text?: string; thought?: boolean }> };
    groundingMetadata?: { webSearchQueries?: string[]; groundingChunks?: Array<{ web?: { uri?: string; title?: string } }> };
  }>;
  promptFeedback?: { blockReason?: string };
  modelVersion?: string;
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
  error?: { status?: string; message?: string };
};

export function parseGemini(j: GeminiResponse): GeminiSample {
  const cand = j.candidates?.[0];
  const text = (cand?.content?.parts ?? []).filter((p) => !p.thought).map((p) => p.text ?? "").join("").trim();
  const gm = cand?.groundingMetadata;
  const seen = new Set<string>();
  const citations: GeoCitation[] = [];
  for (const ch of gm?.groundingChunks ?? []) {
    const uri = ch.web?.uri ?? "";
    if (!/^https:\/\//i.test(uri) || seen.has(uri)) continue;
    seen.add(uri);
    const title = (ch.web?.title ?? "").slice(0, 200);
    citations.push({ title, uri: uri.slice(0, 2000), domain: bareDomain(title) });
    if (citations.length >= 20) break;
  }
  const blocked = !!j.promptFeedback?.blockReason || ["SAFETY", "BLOCKLIST", "PROHIBITED_CONTENT", "SPII", "RECITATION"].includes(cand?.finishReason ?? "");
  return {
    status: blocked ? "blocked" : text ? "ok" : "empty",
    text: text.slice(0, MAX_ANSWER),
    truncated: text.length > MAX_ANSWER,
    citations,
    searchQueries: (gm?.webSearchQueries ?? []).map((q) => String(q).slice(0, 200)).slice(0, 10),
    modelVersion: j.modelVersion ? String(j.modelVersion).slice(0, 80) : null,
    grounded: !!gm && ((gm.groundingChunks?.length ?? 0) > 0 || (gm.webSearchQueries?.length ?? 0) > 0),
    inputTokens: j.usageMetadata?.promptTokenCount ?? null,
    outputTokens: j.usageMetadata?.candidatesTokenCount ?? null,
  };
}

export async function sampleGemini(env: Env, deps: Deps, q: { question: string; locale: string; country: string; detail: string | null }, grounding = true, model = geoModel(env)): Promise<GeminiSample> {
  if (!env.GEMINI_API_KEY) throw new GeminiCallError("gemini_not_configured", true, true);
  let res: Response;
  try {
    res = await deps.fetchImpl(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": env.GEMINI_API_KEY },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: sampleInstruction(q.locale, q.country, q.detail) }] },
        contents: [{ role: "user", parts: [{ text: q.question }] }],
        ...(grounding ? { tools: [{ google_search: {} }] } : {}),
        // Default temperature (recommended for Gemini 3); room for thinking models' hidden reasoning.
        generationConfig: { maxOutputTokens: 4096 },
      }),
      signal: AbortSignal.timeout(45_000),
    });
  } catch {
    throw new GeminiCallError("gemini_network", false, false);
  }
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as GeminiResponse;
    const detail = safeErrorDetail(body.error?.message);
    if (res.status === 429) throw new GeminiCallError("gemini_quota", false, true, detail);
    if (res.status === 401 || res.status === 403) throw new GeminiCallError(`gemini_${res.status}`, true, true, detail);
    // The model is not served to this key/project: retrying the other prompts cannot work.
    if (res.status === 404) throw new GeminiCallError("gemini_model_unavailable", true, true, detail);
    if (res.status === 400) {
      const msg = `${body.error?.status ?? ""} ${body.error?.message ?? ""}`.toLowerCase();
      // Billing/grounding problems must stop the run: never retried in a way that could start charging.
      if (/billing|grounding|search|not supported|not available/.test(msg)) throw new GeminiCallError("gemini_grounding_unavailable", true, true, detail);
      throw new GeminiCallError("gemini_400", false, false, detail);
    }
    throw new GeminiCallError(`gemini_${res.status}`, false, false, detail);
  }
  return parseGemini((await res.json()) as GeminiResponse);
}
