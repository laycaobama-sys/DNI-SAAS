import {
  approxTokens,
  estimateImageCostUsd,
  estimateTextCostUsd,
  parseTextResult,
  rankModels,
  TASK_PROFILES,
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
import { log, nowIso, uuid } from "./util";

/**
 * AI Router. Order per organisation strategy:
 *   automatic_free / manual_free / openrouter_free_router:
 *     1. OpenRouter FREE models (allowlist + quotas + max_price 0; at most 2 attempts per request)
 *     2. Workers AI (only while today's estimated spend < AI_DAILY_BUDGET_USD ≈ free allocation)
 *     3. Gemini (only with GEMINI_API_KEY and not in privacy-first mode)
 *   cloudflare_only: Workers AI only.
 * Every attempt is written to ai_invocations (model, status, latency, tokens, cost state; never prompts).
 */

export const MAX_OPENROUTER_ATTEMPTS = 2;

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
  ) {
    super("ai_unavailable");
  }
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
const budget = (env: Env) => {
  const n = Number(env.AI_DAILY_BUDGET_USD ?? "0.10");
  return Number.isFinite(n) && n >= 0 ? n : 0.1;
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
  provider: AiProviderKey;
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
}

/** Picks the OpenRouter candidates for this request according to the organisation's strategy. */
async function openRouterCandidates(env: Env, prefs: AiPreferences, task: AiTask): Promise<string[]> {
  if (prefs.strategy === "manual_free") return prefs.manualModelId ? [prefs.manualModelId] : [];
  if (prefs.strategy === "openrouter_free_router") return [OPENROUTER_FREE_ROUTER];
  const ranked = rankModels(await listModels(env.DB), task, await observedStats(env.DB, task));
  return ranked.map((r) => r.modelId);
}

// ── Text ─────────────────────────────────────────────────────────────────────────────────────
export async function generateText(env: Env, deps: Deps, messages: ChatMessage[], options: GenerateOptions | number = {}): Promise<TextResult> {
  const o: GenerateOptions = typeof options === "number" ? { maxTokens: options } : options;
  const task: AiTask = o.task ?? "advisor_chat";
  const profile = TASK_PROFILES[task];
  const maxTokens = o.maxTokens ?? profile.maxOutputTokens;
  const prefs = await getAiPreferences(env.DB, o.orgId);
  const base = { orgId: o.orgId ?? null, userId: o.userId ?? null, requestRef: o.requestRef ?? uuid(), task, strategy: prefs.strategy };
  const attempts: string[] = [];
  const inputApprox = approxTokens(messages.map((m) => m.content).join("\n"));
  let quotaExhausted = false;
  let tried = 0;

  // 1. OpenRouter FREE
  if (prefs.strategy !== "cloudflare_only") {
    const avail = await openRouterAvailability(env, prefs.openrouterEnabled);
    if (!avail.usable) attempts.push(`openrouter:${avail.reason}`);
    else {
      const candidates = await openRouterCandidates(env, prefs, task);
      if (!candidates.length) attempts.push("openrouter:sin_modelos_gratuitos_elegibles");
      for (const model of candidates) {
        if (tried >= MAX_OPENROUTER_ATTEMPTS) break;
        const scopes = await quotaScopes(env, base.orgId, base.userId);
        const q = await reserveQuota(env.DB, scopes);
        if (!q.ok) {
          quotaExhausted = true;
          attempts.push(`openrouter:cuota_agotada:${q.scope.split(":").slice(0, 2).join(":")}`);
          await logInvocation(env, { ...base, provider: "openrouter", model, status: "skipped", errorCode: `quota:${q.scope.split(":")[1]}`, costState: "zero_expected", isFallback: tried > 0 });
          break;
        }
        tried++;
        try {
          const r = await callOpenRouterChat(env, deps, model, task, messages, { maxTokens, temperature: profile.temperature, privacyFirst: prefs.privacyFirst });
          await logInvocation(env, {
            ...base, provider: "openrouter", model, servedModel: r.servedModel, status: "ok", latencyMs: r.latencyMs, inputTokens: r.inputTokens, outputTokens: r.outputTokens,
            reportedCostUsd: r.reportedCostUsd, costState: r.reportedCostUsd === 0 ? "zero_confirmed" : "zero_expected", isFallback: tried > 1,
          });
          await recordUsage(env, "openrouter", 0, false);
          return {
            text: r.text, provider: "openrouter", model, servedModel: r.servedModel, inputTokens: r.inputTokens ?? inputApprox, outputTokens: r.outputTokens ?? approxTokens(r.text),
            costUsd: 0, fallback: tried > 1, attempts,
          };
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
            reportedCostUsd: err.costUsd, costState: err.costUsd ? "billed" : "zero_expected", isFallback: tried > 1,
          });
          if (!blocked) await recordUsage(env, "openrouter", 0, true);
          if (err.scope === "global") break;
        }
      }
    }
    if (prefs.strategy === "manual_free" && prefs.fallbackPolicy === "ask" && !o.allowFallback) throw new SelectedModelFailedError(attempts);
  }

  // 2. Workers AI (independent provider with its own daily budget)
  for (const m of WORKERS_AI_TEXT_MODELS) {
    const budgetTokens = m.reasoning ? Math.max(maxTokens * 3, 2048) : maxTokens;
    const estimate = estimateTextCostUsd(m, { input: inputApprox, output: budgetTokens });
    if (!(await workersAiAllowed(env, estimate))) {
      attempts.push(`${m.model}:presupuesto_diario`);
      await logInvocation(env, { ...base, provider: "workers_ai", model: m.model, status: "skipped", errorCode: env.AI ? "daily_budget" : "not_configured", costState: "estimated", isFallback: true });
      break;
    }
    const started = Date.now();
    try {
      const raw = await env.AI!.run(m.model as Parameters<Ai["run"]>[0], { messages, max_tokens: budgetTokens, temperature: profile.temperature } as never);
      const { text, usage } = parseTextResult(raw);
      if (!text) throw new Error("empty");
      const u = usage ?? { input: inputApprox, output: approxTokens(text) };
      const cost = estimateTextCostUsd(m, u);
      await recordUsage(env, "workers_ai", cost, false);
      const fallback = prefs.strategy !== "cloudflare_only";
      await logInvocation(env, { ...base, provider: "workers_ai", model: m.model, status: "ok", latencyMs: Date.now() - started, inputTokens: u.input, outputTokens: u.output, estimatedCostUsd: cost, costState: "estimated", isFallback: fallback });
      return { text, provider: "workers_ai", model: m.model, inputTokens: u.input, outputTokens: u.output, costUsd: cost, fallback, attempts };
    } catch (e) {
      const code = String((e as Error).message ?? e).slice(0, 60);
      attempts.push(`${m.model}:${code}`);
      log("warn", "ai.model_failed", { provider: "workers_ai", model: m.model, error: code });
      await recordUsage(env, "workers_ai", 0, true);
      await logInvocation(env, { ...base, provider: "workers_ai", model: m.model, status: "failed", errorCode: code, latencyMs: Date.now() - started, costState: "estimated", isFallback: true });
    }
  }

  // 3. Gemini (free tier may use prompts to improve Google products → skipped in privacy-first mode)
  if (env.GEMINI_API_KEY && !prefs.privacyFirst && prefs.strategy !== "cloudflare_only") {
    const model = "gemini-flash-latest";
    const started = Date.now();
    try {
      const system = messages.filter((m) => m.role === "system").map((m) => m.content).join("\n");
      const contents = messages.filter((m) => m.role !== "system").map((m) => ({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: m.content }] }));
      const res = await deps.fetchImpl(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-goog-api-key": env.GEMINI_API_KEY },
        body: JSON.stringify({ systemInstruction: { parts: [{ text: system }] }, contents, generationConfig: { maxOutputTokens: Math.max(maxTokens, 1024), temperature: profile.temperature } }),
        signal: AbortSignal.timeout(45_000),
      });
      if (!res.ok) throw new Error(`gemini_${res.status}`);
      const j = (await res.json()) as { candidates?: Array<{ content?: { parts?: Array<{ text?: string; thought?: boolean }> } }>; usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number } };
      const text = (j.candidates?.[0]?.content?.parts ?? []).filter((p) => !p.thought).map((p) => p.text ?? "").join("").trim();
      if (!text) throw new Error("empty");
      await recordUsage(env, "gemini", 0, false);
      const inT = j.usageMetadata?.promptTokenCount ?? inputApprox;
      const outT = j.usageMetadata?.candidatesTokenCount ?? approxTokens(text);
      await logInvocation(env, { ...base, provider: "gemini", model, status: "ok", latencyMs: Date.now() - started, inputTokens: inT, outputTokens: outT, costState: "zero_expected", isFallback: true });
      return { text, provider: "gemini", model, inputTokens: inT, outputTokens: outT, costUsd: 0, fallback: true, attempts };
    } catch (e) {
      const code = String((e as Error).message ?? e).slice(0, 60);
      attempts.push(`${model}:${code}`);
      await recordUsage(env, "gemini", 0, true);
      await logInvocation(env, { ...base, provider: "gemini", model, status: "failed", errorCode: code, latencyMs: Date.now() - started, costState: "zero_expected", isFallback: true });
    }
  }

  log("error", "ai.text_unavailable", { attempts, task });
  throw new AiUnavailableError(attempts, quotaExhausted);
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
  } else attempts.push(`${WORKERS_AI_IMAGE_MODEL.model}:presupuesto_diario`);
  log("error", "ai.image_unavailable", { attempts });
  throw new AiUnavailableError(attempts);
}

/** Public, secret-free status for the UI. */
export async function aiStatus(env: Env) {
  const spent = await spentToday(env, "workers_ai");
  const or = await openRouterAvailability(env);
  return {
    workersAi: !!env.AI,
    openRouter: !!env.OPENROUTER_API_KEY,
    openRouterUsable: or.usable,
    openRouterReason: or.reason,
    gemini: !!env.GEMINI_API_KEY,
    images: !!env.AI && !!env.MEDIA,
    dailyBudgetUsd: budget(env),
    spentTodayUsd: Math.round(spent * 10000) / 10000,
    budgetExhausted: spent >= budget(env),
  };
}
