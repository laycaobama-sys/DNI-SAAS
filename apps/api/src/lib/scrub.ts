/**
 * «IA DNI Growth»: customers never learn which AI provider or model runs behind the product, nor its
 * internal cost. Every JSON response of a customer workspace goes through this scrub unless the caller
 * is platform staff with an unlocked session. It removes AI-internal keys and rewrites provider/model
 * names that appear inside free text (job events, errors, audit diffs).
 */
export const AI_BRAND = "IA DNI Growth";

const DROP_KEYS = new Set([
  "servedModel",
  "served_model",
  "fallbackModel",
  "costUsd",
  "cost_usd",
  "estimated_cost_usd",
  "estimatedCostUsd",
  "reported_cost_usd",
  "reportedCostUsd",
  "cost_state",
  "costState",
  "is_fallback",
  "isFallback",
  "neurons",
  "generatedWith",
  "model_version",
  "modelVersion",
  "modelsUsed",
]);
/** «model» is also an attribution model (plain text): only AI model identifiers are dropped. */
const AI_MODEL_ID = /(^-$|^[\w.-]+\/[\w.:@-]+$|@cf|:free|gemini|gemma|llama|glm-|gpt-|flux|qwen|mistral|deepseek|claude|kimi|nemotron)/i;
const AI_PROVIDERS = new Set(["workers_ai", "openrouter", "groq", "gemini", "ollama", "cache", "cloudflare", "google_gemini"]);
const NAME_PATTERNS: RegExp[] = [
  /@cf\/[\w./-]+/gi,
  /\b[\w-]+\/[\w.-]+:free\b/gi,
  /\bopenai\/gpt-oss[\w.-]*/gi,
  /\bgemini-[\w.-]+/gi,
  /\bgemma[\w.-]*/gi,
  /\bllama[\w.-]*/gi,
  /\bglm-[\w.-]+/gi,
  /\bflux[\w.-]*\b/gi,
  /\bCloudflare Workers AI\b/gi,
  /\bWorkers AI\b/gi,
  /\bOpenRouter\b/gi,
  /\bGroq\b/gi,
  /\bGemini\b/gi,
  /\bOllama\b/gi,
];

/** GEO text: the measured engine stays («Gemini»), its model id/version never shows. */
export function scrubModelIds(s: string): string {
  return s.replace(/\bgemini-[\w.-]+/gi, "Gemini").replace(/@cf\/[\w./-]+|\b[\w-]+\/[\w.-]+:free\b|\bopenai\/gpt-oss[\w.-]*/gi, AI_BRAND);
}

export function scrubText(s: string): string {
  let out = s;
  for (const re of NAME_PATTERNS) out = out.replace(re, AI_BRAND);
  // Collapse repetitions created by the replacement («IA DNI Growth (IA DNI Growth)»).
  return out.replace(/(IA DNI Growth)(\s*[·:,/(]\s*IA DNI Growth\)?)+/g, "$1");
}

/**
 * `keepEngineNames`: AI Visibility (GEO) measures how PUBLIC assistants (Gemini, ChatGPT…) talk about
 * the brand. There the engine name is the source of the metric, not the AI that powers DNI Growth, so
 * it is kept (hiding it would make the metric's source false). Model ids, versions and costs still go.
 */
export function scrubAi(value: unknown, key = "", opts: { keepEngineNames?: boolean } = {}): unknown {
  if (typeof value === "string") {
    if ((key === "after_redacted" || key === "before_redacted") && value.startsWith("{")) {
      try {
        return JSON.stringify(scrubAi(JSON.parse(value), "", opts));
      } catch {
        return opts.keepEngineNames ? scrubModelIds(value) : scrubText(value);
      }
    }
    return opts.keepEngineNames ? scrubModelIds(value) : scrubText(value);
  }
  if (Array.isArray(value)) return value.map((v) => scrubAi(v, key, opts));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (DROP_KEYS.has(k)) continue;
      if ((k === "model" || k === "models") && (typeof v === "string" ? AI_MODEL_ID.test(v) : Array.isArray(v))) continue;
      if (k === "attempts" && Array.isArray(v)) continue;
      if (k === "provider" && typeof v === "string" && AI_PROVIDERS.has(v.toLowerCase())) {
        out[k] = "dni_ai";
        continue;
      }
      out[k] = scrubAi(v, k, opts);
    }
    return out;
  }
  return value;
}
