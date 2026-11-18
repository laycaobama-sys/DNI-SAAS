import {
  approxTokens,
  detectSensitiveData,
  estimateImageCostUsd,
  estimateTextCostUsd,
  parseTextResult,
  rankModels,
  sha256Hex,
  TASK_PROFILES,
  usdToNeurons,
  GEMINI_TEXT_MODEL_DEFAULT,
  GROQ_TEXT_MODEL,
  WORKERS_AI_FREE_NEURONS_PER_DAY,
  OPENROUTER_FREE_ROUTER,
  WORKERS_AI_IMAGE_MODEL,
  WORKERS_AI_TEXT_MODELS,
  type AiProviderKey,
  type AiTask,
  type ChatMessage,
} from "@dni/core";
import type { Deps, Env } from "../env";
import {
  callOpenRouterChat,
  listModels,
  observedStats,
  OpenRouterCallError,
  openRouterAvailability,
  quotaScopes,
  releaseQuota,
  reserveQuota,
} from "./openrouter";
import { ApiError } from "./http";
import { log, nowIso, uuid } from "./util";

/**
 * Single AI service for every text/image feature (advisor, content, editorial review, images).
 * 100 % free providers, each with its own cap; see generateText() for the order.
 * Every attempt is written to ai_invocations (model, status, latency, tokens, cost state; never prompts).
 */

export const MAX_OPENROUTER_ATTEMPTS = 2;
/** Hard ceiling on any answer length, whatever the caller asks (saves free quota). */
export const MAX_OUTPUT_TOKENS = 2500;

export interface TextResult {
  text: string;
  provider: AiProviderKey;
  model: string;
  servedModel?: string | null;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  fallback: boolean;
  attempts: string[];
  /** Served from the 24 h response cache: no model was called. */
  cached: boolean;
}
export interface ImageResult {
  bytes: Uint8Array;
  contentType: string;
  provider: AiProviderKey;
  model: string;
  costUsd: number;
}

export class AiUnavailableError extends Error {
  constructor(
    readonly attempts: string[],
    readonly openRouterQuotaExhausted = false,
    /** Workers AI reached today's free allowance and no free fallback answered. */
    readonly dailyQuotaExhausted = false,
  ) {
    super("ai_unavailable");
  }
}

/** Spanish, user-facing API error for any AI failure. No credit is ever charged when this is thrown. */
export function aiApiError(e: unknown): unknown {
  if (e instanceof SelectedModelFailedError)
    return new ApiError(503, "selected_model_failed", "El modelo gratuito que elegiste no ha respondido. No se ha cobrado ningún crédito. ¿Quieres usar el respaldo automático?", { attempts: e.attempts });
  if (e instanceof AiUnavailableError) {
    if (e.dailyQuotaExhausted)
      return new ApiError(
        503,
        "ai_daily_quota",
        "Se ha agotado el cupo gratuito diario de IA. Se renueva cada día a las 00:00 UTC (01:00 en España peninsular en invierno, 02:00 en verano). No se ha cobrado ningún crédito.",
      );
    return new ApiError(
      503,
      "ai_unavailable",
      e.openRouterQuotaExhausted
        ? "La cuota gratuita de OpenRouter se ha agotado y los respaldos gratuitos no están disponibles ahora. No se ha cobrado ningún crédito. Inténtalo más tarde."
        : "Los modelos de IA gratuitos no están disponibles en este momento. No se ha cobrado ningún crédito. Inténtalo de nuevo en unos minutos.",
    );
  }
  return e;
}
/** The organisation chose a specific model, it failed, and its policy is to ask before falling back. */
export class SelectedModelFailedError extends Error {
  constructor(readonly attempts: string[]) {
    super("selected_model_failed");
  }
}

export type Strategy = "automatic_free" | "manual_free" | "openrouter_free_router" | "cloudflare_only";
export interface AiPreferences {
  strategy: Strategy;
  manualModelId: string | null;
  fallbackPolicy: "auto" | "ask";
  privacyFirst: boolean;
  openrouterEnabled: boolean;
}
export const DEFAULT_PREFERENCES: AiPreferences = { strategy: "automatic_free", manualModelId: null, fallbackPolicy: "auto", privacyFirst: false, openrouterEnabled: true };

export async function getAiPreferences(db: D1Database, orgId: string | null | undefined): Promise<AiPreferences> {
  if (!orgId) return DEFAULT_PREFERENCES;
  const r = await db
    .prepare("SELECT strategy, manual_model_id, fallback_policy, privacy_first, openrouter_enabled FROM organization_ai_preferences WHERE organization_id = ?")
    .bind(orgId)
    .first<{ strategy: Strategy; manual_model_id: string | null; fallback_policy: "auto" | "ask"; privacy_first: number; openrouter_enabled: number }>();
  if (!r) return DEFAULT_PREFERENCES;
  return { strategy: r.strategy, manualModelId: r.manual_model_id, fallbackPolicy: r.fallback_policy, privacyFirst: r.privacy_first === 1, openrouterEnabled: r.openrouter_enabled === 1 };
}

const today = () => new Date().toISOString().slice(0, 10);
/** Never above 0.10 USD/day (≈ 9,090 Neurons), i.e. always inside the 10,000 free Neurons/day. */
export const MAX_FREE_BUDGET_USD = 0.1;
const budget = (env: Env) => {
  const n = Number(env.AI_DAILY_BUDGET_USD ?? "0.10");
  return Number.isFinite(n) && n >= 0 ? Math.min(n, MAX_FREE_BUDGET_USD) : MAX_FREE_BUDGET_USD;
};

export async function spentToday(env: Env, provider: AiProviderKey): Promise<number> {
  const r = await env.DB.prepare("SELECT cost_usd FROM ai_usage_daily WHERE day = ? AND provider = ?").bind(today(), provider).first<{ cost_usd: number }>();
  return r?.cost_usd ?? 0;
}

async function recordUsage(env: Env, provider: AiProviderKey, costUsd: number, failed: boolean) {
  await env.DB.prepare(
    `INSERT INTO ai_usage_daily (day, provider, requests, failures, cost_usd) VALUES (?, ?, 1, ?, ?)
     ON CONFLICT(day, provider) DO UPDATE SET requests = requests + 1, failures = failures + excluded.failures, cost_usd = cost_usd + excluded.cost_usd`,
  )
    .bind(today(), provider, failed ? 1 : 0, costUsd)
    .run();
}

async function workersAiAllowed(env: Env, estimate: number): Promise<boolean> {
  if (!env.AI) return false;
  return (await spentToday(env, "workers_ai")) + estimate <= budget(env);
}

export interface InvocationLog {
  orgId: string | null;
  userId: string | null;
  requestRef: string;
  task: string;
  strategy: string;
  provider: AiProviderKey | "cache";
  model: string;
  servedModel?: string | null;
  status: "ok" | "failed" | "skipped" | "blocked";
  errorCode?: string | null;
  latencyMs?: number | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  estimatedCostUsd?: number;
  reportedCostUsd?: number | null;
  costState: "zero_confirmed" | "zero_expected" | "estimated" | "billed" | "unknown";
  isFallback: boolean;
}

export async function logInvocation(env: Env, e: InvocationLog) {
  try {
    await env.DB.prepare(
      `INSERT INTO ai_invocations (id, organization_id, user_id, request_ref, task, strategy, provider, model, served_model, status, error_code, latency_ms,
         input_tokens, output_tokens, estimated_cost_usd, reported_cost_usd, cost_state, is_fallback, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        uuid(), e.orgId, e.userId, e.requestRef, e.task, e.strategy, e.provider, e.model, e.servedModel ?? null, e.status, e.errorCode ?? null, e.latencyMs ?? null,
        e.inputTokens ?? null, e.outputTokens ?? null, e.estimatedCostUsd ?? 0, e.reportedCostUsd ?? null, e.costState, e.isFallback ? 1 : 0, nowIso(),
      )
      .run();
  } catch (err) {
    log("error", "ai.invocation_log_failed", { error: String(err).slice(0, 120) });
  }
}

export interface GenerateOptions {
  task?: AiTask;
  maxTokens?: number;
  orgId?: string | null;
  userId?: string | null;
  requestRef?: string;
  /** Explicit user consent to use automatic fallback after a manually selected model failed. */
  allowFallback?: boolean;
  /** Reuse an identical answer from the last 24 h (default true). Never used for sensitive data. */
  cache?: boolean;
}

/** Picks the OpenRouter candidates for this request according to the organisation's strategy. */
async function openRouterCandidates(env: Env, prefs: AiPreferences, task: AiTask): Promise<string[]> {
  if (prefs.strategy === "manual_free") return prefs.manualModelId ? [prefs.manualModelId] : [];
  if (prefs.strategy === "openrouter_free_router") return [OPENROUTER_FREE_ROUTER];
  const ranked = rankModels(await listModels(env.DB), task, await observedStats(env.DB, task));
  return ranked.map((r) => r.modelId);
}

// ── Response cache (per organisation; saves free quota when the same request repeats) ───────────
export const AI_CACHE_TTL_HOURS = 24;

async function cacheKey(task: AiTask, maxTokens: number, prefs: AiPreferences, messages: ChatMessage[]): Promise<string> {
  return sha256Hex(JSON.stringify({ v: 1, task, maxTokens, s: prefs.strategy, m: prefs.manualModelId, p: prefs.privacyFirst, messages }));
}

async function cacheGet(env: Env, orgId: string, key: string) {
  try {
    const r = await env.DB.prepare(
      "SELECT provider, model, response_text, input_tokens, output_tokens FROM ai_response_cache WHERE organization_id = ? AND cache_key = ? AND expires_at > ?",
    )
      .bind(orgId, key, nowIso())
      .first<{ provider: AiProviderKey; model: string; response_text: string; input_tokens: number | null; output_tokens: number | null }>();
    if (r) await env.DB.prepare("UPDATE ai_response_cache SET hits = hits + 1 WHERE organization_id = ? AND cache_key = ?").bind(orgId, key).run();
    return r;
  } catch (err) {
    log("warn", "ai.cache_read_failed", { error: String(err).slice(0, 120) });
    return null;
  }
}

async function cachePut(env: Env, orgId: string, key: string, task: AiTask, r: TextResult) {
  try {
    const now = new Date();
    await env.DB.prepare(
      `INSERT INTO ai_response_cache (organization_id, cache_key, task, provider, model, response_text, input_tokens, output_tokens, hits, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
       ON CONFLICT(organization_id, cache_key) DO UPDATE SET provider = excluded.provider, model = excluded.model, response_text = excluded.response_text,
         input_tokens = excluded.input_tokens, output_tokens = excluded.output_tokens, created_at = excluded.created_at, expires_at = excluded.expires_at`,
    )
      .bind(orgId, key, task, r.provider, r.model, r.text, r.inputTokens, r.outputTokens, now.toISOString(), new Date(now.getTime() + AI_CACHE_TTL_HOURS * 3600_000).toISOString())
      .run();
  } catch (err) {
    log("warn", "ai.cache_write_failed", { error: String(err).slice(0, 120) });
  }
}

const intVar = (v: string | undefined, d: number) => {
  const n = Number(v ?? d);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : d;
};
async function requestsToday(env: Env, provider: AiProviderKey): Promise<number> {
  const r = await env.DB.prepare("SELECT requests FROM ai_usage_daily WHERE day = ? AND provider = ?").bind(today(), provider).first<{ requests: number }>();
  return r?.requests ?? 0;
}
/** Workers AI models in order; WORKERS_AI_TEXT_MODEL (if it is a catalogued model) goes first. */
export function workersAiTextModels(env: Env) {
  const pick = WORKERS_AI_TEXT_MODELS.find((m) => m.model === env.WORKERS_AI_TEXT_MODEL);
  return pick ? [pick, ...WORKERS_AI_TEXT_MODELS.filter((m) => m !== pick)] : WORKERS_AI_TEXT_MODELS;
}
export const geminiTextModel = (env: Env) => (env.GEMINI_TEXT_MODEL && /^gemini-[a-z0-9][a-z0-9.-]{1,60}$/.test(env.GEMINI_TEXT_MODEL) ? env.GEMINI_TEXT_MODEL : GEMINI_TEXT_MODEL_DEFAULT);

// ── Text ─────────────────────────────────────────────────────────────────────────────────────
/**
 * Single AI text service. Order:
 *   automatic_free (default): Workers AI → Groq (if GROQ_API_KEY) → Gemini (if GEMINI_API_KEY) → OpenRouter free
 *   manual_free / openrouter_free_router: the chosen OpenRouter free model first, then the same chain
 *   cloudflare_only: Workers AI only
 * Sensitive data (DNI, IBAN, passwords…) only ever goes to Workers AI. Every provider is free and capped.
 */
export async function generateText(env: Env, deps: Deps, messages: ChatMessage[], options: GenerateOptions | number = {}): Promise<TextResult> {
  const o: GenerateOptions = typeof options === "number" ? { maxTokens: options } : options;
  const task: AiTask = o.task ?? "advisor_chat";
  const profile = TASK_PROFILES[task];
  const maxTokens = Math.min(o.maxTokens ?? profile.maxOutputTokens, MAX_OUTPUT_TOKENS);
  const prefs = await getAiPreferences(env.DB, o.orgId);
  const base = { orgId: o.orgId ?? null, userId: o.userId ?? null, requestRef: o.requestRef ?? uuid(), task, strategy: prefs.strategy };
  const attempts: string[] = [];
  const inputApprox = approxTokens(messages.map((m) => m.content).join("\n"));
  let openRouterQuota = false;
  let dailyQuota = false;
  // Privacy guard: personal or secret data typed by the user never goes to free third-party providers
  // (they may log or train on prompts). Such requests are processed only by Workers AI (Cloudflare).
  const sensitive = detectSensitiveData(messages.filter((m) => m.role !== "system").map((m) => m.content).join("\n"));
  const thirdPartyAllowed = sensitive.length === 0;
  if (!thirdPartyAllowed) {
    attempts.push(`terceros:datos_sensibles:${sensitive.join(",")}`);
    await logInvocation(env, { ...base, provider: "openrouter", model: "-", status: "skipped", errorCode: `sensitive_data:${sensitive.join(",")}`, costState: "zero_expected", isFallback: false });
  }

  // 0. Cache (same organisation, same request, last 24 h). Sensitive requests are never cached.
  const useCache = o.cache !== false && !!base.orgId && thirdPartyAllowed;
  const key = useCache ? await cacheKey(task, maxTokens, prefs, messages) : null;
  if (key && base.orgId) {
    const hit = await cacheGet(env, base.orgId, key);
    if (hit) {
      await logInvocation(env, { ...base, provider: "cache", model: hit.model, status: "ok", errorCode: "cache_hit", latencyMs: 0, inputTokens: 0, outputTokens: 0, costState: "zero_confirmed", isFallback: false });
      return { text: hit.response_text, provider: hit.provider, model: hit.model, inputTokens: hit.input_tokens ?? 0, outputTokens: hit.output_tokens ?? 0, costUsd: 0, fallback: false, attempts, cached: true };
    }
  }
  const done = async (r: Omit<TextResult, "cached" | "attempts" | "fallback">): Promise<TextResult> => {
    const result: TextResult = { ...r, fallback: attempts.length > (thirdPartyAllowed ? 0 : 1), attempts, cached: false };
    if (key && base.orgId) await cachePut(env, base.orgId, key, task, result);
    return result;
  };
  const isFallback = () => attempts.length > (thirdPartyAllowed ? 0 : 1);

  // OpenRouter FREE (at most 2 attempts per request)
  const openRouter = async (): Promise<TextResult | null> => {
    const avail = await openRouterAvailability(env, prefs.openrouterEnabled);
    if (!avail.usable) {
      attempts.push(`openrouter:${avail.reason}`);
      return null;
    }
    const candidates = await openRouterCandidates(env, prefs, task);
    if (!candidates.length) attempts.push("openrouter:sin_modelos_gratuitos_elegibles");
    let tried = 0;
    for (const model of candidates) {
      if (tried >= MAX_OPENROUTER_ATTEMPTS) break;
      const scopes = await quotaScopes(env, base.orgId, base.userId);
      const q = await reserveQuota(env.DB, scopes);
      if (!q.ok) {
        openRouterQuota = true;
        attempts.push(`openrouter:cuota_agotada:${q.scope.split(":").slice(0, 2).join(":")}`);
        await logInvocation(env, { ...base, provider: "openrouter", model, status: "skipped", errorCode: `quota:${q.scope.split(":")[1]}`, costState: "zero_expected", isFallback: isFallback() });
        break;
      }
      tried++;
      try {
        const r = await callOpenRouterChat(env, deps, model, task, messages, { maxTokens, temperature: profile.temperature, privacyFirst: prefs.privacyFirst });
        await logInvocation(env, {
          ...base, provider: "openrouter", model, servedModel: r.servedModel, status: "ok", latencyMs: r.latencyMs, inputTokens: r.inputTokens, outputTokens: r.outputTokens,
          reportedCostUsd: r.reportedCostUsd, costState: r.reportedCostUsd === 0 ? "zero_confirmed" : "zero_expected", isFallback: isFallback(),
        });
        await recordUsage(env, "openrouter", 0, false);
        return done({ text: r.text, provider: "openrouter", model, servedModel: r.servedModel, inputTokens: r.inputTokens ?? inputApprox, outputTokens: r.outputTokens ?? approxTokens(r.text), costUsd: 0 });
      } catch (e) {
        const err = e instanceof OpenRouterCallError ? e : new OpenRouterCallError(String((e as Error).message ?? e).slice(0, 60), "model");
        const blocked = err.code.startsWith("gate:") || err.code === "policy_blocked";
        if (blocked) {
          tried--; // nothing was sent: give the quota back
          await releaseQuota(env.DB, scopes);
        }
        attempts.push(`${model}:${err.code}`);
        await logInvocation(env, {
          ...base, provider: "openrouter", model, status: blocked ? "blocked" : "failed", errorCode: err.code.slice(0, 80),
          reportedCostUsd: err.costUsd, costState: err.costUsd ? "billed" : "zero_expected", isFallback: isFallback(),
        });
        if (!blocked) await recordUsage(env, "openrouter", 0, true);
        if (err.scope === "global") break;
      }
    }
    return null;
  };

  // Workers AI (Cloudflare; capped by AI_DAILY_BUDGET_USD so usage stays inside the 10,000 free Neurons/day)
  const workersAi = async (): Promise<TextResult | null> => {
    if (!env.AI) {
      attempts.push("workers_ai:no_configurado");
      return null;
    }
    for (const m of workersAiTextModels(env)) {
      const budgetTokens = m.reasoning ? Math.max(maxTokens * 3, 2048) : maxTokens;
      const estimate = estimateTextCostUsd(m, { input: inputApprox, output: budgetTokens });
      if (!(await workersAiAllowed(env, estimate))) {
        dailyQuota = true;
        attempts.push(`${m.model}:cupo_diario_gratuito`);
        await logInvocation(env, { ...base, provider: "workers_ai", model: m.model, status: "skipped", errorCode: "daily_budget", costState: "estimated", isFallback: isFallback() });
        return null;
      }
      const started = Date.now();
      try {
        const input: Record<string, unknown> = { messages, max_tokens: budgetTokens, temperature: profile.temperature };
        if (m.thinkingSwitch) input.chat_template_kwargs = { enable_thinking: false };
        const raw = await env.AI.run(m.model as Parameters<Ai["run"]>[0], input as never);
        const { text, usage } = parseTextResult(raw);
        if (!text) throw new Error("empty");
        const u = usage ?? { input: inputApprox, output: approxTokens(text) };
        const cost = estimateTextCostUsd(m, u);
        await recordUsage(env, "workers_ai", cost, false);
        await logInvocation(env, { ...base, provider: "workers_ai", model: m.model, status: "ok", latencyMs: Date.now() - started, inputTokens: u.input, outputTokens: u.output, estimatedCostUsd: cost, costState: "estimated", isFallback: isFallback() });
        return done({ text, provider: "workers_ai", model: m.model, inputTokens: u.input, outputTokens: u.output, costUsd: cost });
      } catch (e) {
        const code = String((e as Error).message ?? e).slice(0, 60);
        attempts.push(`${m.model}:${code}`);
        log("warn", "ai.model_failed", { provider: "workers_ai", model: m.model, error: code });
        // Count an estimated input cost: a failed call may still have consumed Neurons.
        await recordUsage(env, "workers_ai", estimateTextCostUsd(m, { input: inputApprox, output: 0 }), true);
        await logInvocation(env, { ...base, provider: "workers_ai", model: m.model, status: "failed", errorCode: code, latencyMs: Date.now() - started, costState: "estimated", isFallback: isFallback() });
      }
    }
    return null;
  };

  // Groq (optional free key; OpenAI-compatible API; own daily cap)
  const groq = async (): Promise<TextResult | null> => {
    if (!env.GROQ_API_KEY) return null;
    const model = GROQ_TEXT_MODEL;
    if ((await requestsToday(env, "groq")) >= intVar(env.GROQ_DAILY_REQUESTS, 1000)) {
      attempts.push(`groq:cupo_diario`);
      await logInvocation(env, { ...base, provider: "groq", model, status: "skipped", errorCode: "daily_cap", costState: "zero_expected", isFallback: true });
      return null;
    }
    const started = Date.now();
    try {
      const res = await deps.fetchImpl("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${env.GROQ_API_KEY}` },
        body: JSON.stringify({ model, messages, max_tokens: maxTokens, temperature: profile.temperature }),
        signal: AbortSignal.timeout(45_000),
      });
      if (!res.ok) throw new Error(res.status === 429 ? "groq_cuota" : `groq_${res.status}`);
      const { text, usage } = parseTextResult(await res.json());
      if (!text) throw new Error("empty");
      const u = usage ?? { input: inputApprox, output: approxTokens(text) };
      await recordUsage(env, "groq", 0, false);
      await logInvocation(env, { ...base, provider: "groq", model, status: "ok", latencyMs: Date.now() - started, inputTokens: u.input, outputTokens: u.output, costState: "zero_expected", isFallback: true });
      return done({ text, provider: "groq", model, inputTokens: u.input, outputTokens: u.output, costUsd: 0 });
    } catch (e) {
      const code = String((e as Error).message ?? e).slice(0, 60);
      attempts.push(`groq:${code}`);
      await recordUsage(env, "groq", 0, true);
      await logInvocation(env, { ...base, provider: "groq", model, status: "failed", errorCode: code, latencyMs: Date.now() - started, costState: "zero_expected", isFallback: true });
      return null;
    }
  };

  // Gemini (free tier may use prompts to improve Google products → skipped in privacy-first mode)
  const gemini = async (): Promise<TextResult | null> => {
    if (!env.GEMINI_API_KEY || prefs.privacyFirst) return null;
    const model = geminiTextModel(env);
    if ((await requestsToday(env, "gemini")) >= intVar(env.GEMINI_TEXT_DAILY, 100)) {
      attempts.push(`gemini:cupo_diario`);
      await logInvocation(env, { ...base, provider: "gemini", model, status: "skipped", errorCode: "daily_cap", costState: "zero_expected", isFallback: true });
      return null;
    }
    const started = Date.now();
    try {
      const system = messages.filter((m) => m.role === "system").map((m) => m.content).join("\n");
      const contents = messages.filter((m) => m.role !== "system").map((m) => ({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: m.content }] }));
      const res = await deps.fetchImpl(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-goog-api-key": env.GEMINI_API_KEY },
        body: JSON.stringify({ systemInstruction: { parts: [{ text: system }] }, contents, generationConfig: { maxOutputTokens: Math.max(maxTokens, 1024) } }),
        signal: AbortSignal.timeout(45_000),
      });
      if (!res.ok) throw new Error(res.status === 429 ? "gemini_cuota" : `gemini_${res.status}`);
      const j = (await res.json()) as { candidates?: Array<{ content?: { parts?: Array<{ text?: string; thought?: boolean }> } }>; usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number } };
      const text = (j.candidates?.[0]?.content?.parts ?? []).filter((p) => !p.thought).map((p) => p.text ?? "").join("").trim();
      if (!text) throw new Error("empty");
      await recordUsage(env, "gemini", 0, false);
      const inT = j.usageMetadata?.promptTokenCount ?? inputApprox;
      const outT = j.usageMetadata?.candidatesTokenCount ?? approxTokens(text);
      await logInvocation(env, { ...base, provider: "gemini", model, status: "ok", latencyMs: Date.now() - started, inputTokens: inT, outputTokens: outT, costState: "zero_expected", isFallback: true });
      return done({ text, provider: "gemini", model, inputTokens: inT, outputTokens: outT, costUsd: 0 });
    } catch (e) {
      const code = String((e as Error).message ?? e).slice(0, 60);
      attempts.push(`${model}:${code}`);
      await recordUsage(env, "gemini", 0, true);
      await logInvocation(env, { ...base, provider: "gemini", model, status: "failed", errorCode: code, latencyMs: Date.now() - started, costState: "zero_expected", isFallback: true });
      return null;
    }
  };

  const openRouterFirst = thirdPartyAllowed && (prefs.strategy === "manual_free" || prefs.strategy === "openrouter_free_router");
  if (openRouterFirst) {
    const r = await openRouter();
    if (r) return r;
    if (prefs.strategy === "manual_free" && prefs.fallbackPolicy === "ask" && !o.allowFallback) throw new SelectedModelFailedError(attempts);
  }
  const chain: Array<() => Promise<TextResult | null>> = [workersAi];
  if (prefs.strategy !== "cloudflare_only" && thirdPartyAllowed) {
    chain.push(groq, gemini);
    if (!openRouterFirst) chain.push(openRouter);
  }
  for (const step of chain) {
    const r = await step();
    if (r) return r;
  }

  log("error", "ai.text_unavailable", { attempts, task });
  throw new AiUnavailableError(attempts, openRouterQuota, dailyQuota);
}

// ── Images (Workers AI FLUX only: OpenRouter has no free image-generation model in the catalogue) ─
function b64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function sniffImageType(b: Uint8Array): string | null {
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "image/png";
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45) return "image/webp";
  return null;
}

export async function generateImage(env: Env, _deps: Deps, prompt: string, ctx: { orgId?: string | null; userId?: string | null; requestRef?: string } = {}): Promise<ImageResult> {
  const attempts: string[] = [];
  const estimate = estimateImageCostUsd();
  const base = { orgId: ctx.orgId ?? null, userId: ctx.userId ?? null, requestRef: ctx.requestRef ?? uuid(), task: "image_generation", strategy: "cloudflare_only" };
  if (await workersAiAllowed(env, estimate)) {
    const started = Date.now();
    try {
      const raw = (await env.AI!.run(WORKERS_AI_IMAGE_MODEL.model as Parameters<Ai["run"]>[0], { prompt, steps: WORKERS_AI_IMAGE_MODEL.steps } as never)) as { image?: string };
      if (!raw?.image) throw new Error("empty");
      const bytes = b64ToBytes(raw.image);
      const contentType = sniffImageType(bytes);
      if (!contentType) throw new Error("not_an_image");
      await recordUsage(env, "workers_ai", estimate, false);
      await logInvocation(env, { ...base, provider: "workers_ai", model: WORKERS_AI_IMAGE_MODEL.model, status: "ok", latencyMs: Date.now() - started, estimatedCostUsd: estimate, costState: "estimated", isFallback: false });
      return { bytes, contentType, provider: "workers_ai", model: WORKERS_AI_IMAGE_MODEL.model, costUsd: estimate };
    } catch (e) {
      const code = String((e as Error).message ?? e).slice(0, 60);
      attempts.push(`${WORKERS_AI_IMAGE_MODEL.model}:${code}`);
      await recordUsage(env, "workers_ai", 0, true);
      await logInvocation(env, { ...base, provider: "workers_ai", model: WORKERS_AI_IMAGE_MODEL.model, status: "failed", errorCode: code, latencyMs: Date.now() - started, costState: "estimated", isFallback: false });
    }
  } else {
    attempts.push(`${WORKERS_AI_IMAGE_MODEL.model}:cupo_diario_gratuito`);
    if (env.AI) {
      log("warn", "ai.image_daily_quota", { attempts });
      throw new AiUnavailableError(attempts, false, true);
    }
  }
  log("error", "ai.image_unavailable", { attempts });
  throw new AiUnavailableError(attempts);
}

/** Public, secret-free status for the UI. */
export async function aiStatus(env: Env) {
  const spent = await spentToday(env, "workers_ai");
  const or = await openRouterAvailability(env);
  return {
    workersAi: !!env.AI,
    workersAiModel: workersAiTextModels(env)[0]!.model,
    openRouter: !!env.OPENROUTER_API_KEY,
    openRouterUsable: or.usable,
    openRouterReason: or.reason,
    groq: !!env.GROQ_API_KEY,
    groqModel: GROQ_TEXT_MODEL,
    gemini: !!env.GEMINI_API_KEY,
    geminiModel: geminiTextModel(env),
    order: ["workers_ai", ...(env.GROQ_API_KEY ? ["groq"] : []), ...(env.GEMINI_API_KEY ? ["gemini"] : []), ...(env.OPENROUTER_API_KEY ? ["openrouter"] : [])],
    neuronsToday: usdToNeurons(spent),
    neuronsDailyCap: usdToNeurons(budget(env)),
    neuronsFreePerDay: WORKERS_AI_FREE_NEURONS_PER_DAY,
    cacheTtlHours: AI_CACHE_TTL_HOURS,
    resetsAt: "00:00 UTC",
    images: !!env.AI && !!env.MEDIA,
    dailyBudgetUsd: budget(env),
    spentTodayUsd: Math.round(spent * 10000) / 10000,
    budgetExhausted: spent >= budget(env),
  };
}
