import {
  approxTokens,
  estimateImageCostUsd,
  estimateTextCostUsd,
  parseTextResult,
  WORKERS_AI_IMAGE_MODEL,
  WORKERS_AI_TEXT_MODELS,
  type AiProviderKey,
  type ChatMessage,
} from "@dni/core";
import type { Deps, Env } from "../env";
import { log } from "./util";

/**
 * AI runtime with automatic fallback:
 *   1. Workers AI (no key; billed per neuron) — only while today's estimated spend is under
 *      AI_DAILY_BUDGET_USD (default 0.10 ≈ the daily free allocation), so we never spend silently.
 *   2. OpenRouter FREE models (":free", price 0) — only if OPENROUTER_API_KEY is set.
 *   3. Google Gemini — only if GEMINI_API_KEY is set.
 * Each provider/model failure is recorded and the next one is tried. Keys never reach logs.
 */

export interface TextResult {
  text: string;
  provider: AiProviderKey;
  model: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}
export interface ImageResult {
  bytes: Uint8Array;
  contentType: string;
  provider: AiProviderKey;
  model: string;
  costUsd: number;
}

export class AiUnavailableError extends Error {
  constructor(readonly attempts: string[]) {
    super("ai_unavailable");
  }
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

// ── OpenRouter free model catalogue (public endpoint, cached per isolate) ─────────────────────
interface OrModel {
  id: string;
  context_length?: number;
  pricing?: Record<string, string>;
  architecture?: { input_modalities?: string[]; output_modalities?: string[] };
}
let orCache: { at: number; text: string[]; image: string[] } | null = null;

const isFree = (m: OrModel) => {
  const p = m.pricing ?? {};
  return Object.values(p).every((v) => Number(v) === 0) && (m.id.endsWith(":free") || Number(p.prompt) === 0);
};

export async function openRouterFreeModels(deps: Deps): Promise<{ text: string[]; image: string[] }> {
  if (orCache && Date.now() - orCache.at < 6 * 3600_000) return orCache;
  try {
    const res = await deps.fetchImpl("https://openrouter.ai/api/v1/models", { headers: { accept: "application/json" }, signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error(`models_${res.status}`);
    const data = ((await res.json()) as { data?: OrModel[] }).data ?? [];
    const free = data.filter((m) => typeof m.id === "string" && isFree(m) && !m.id.startsWith("openrouter/"));
    const out = (m: OrModel) => m.architecture?.output_modalities ?? ["text"];
    const text = free.filter((m) => out(m).includes("text") && !out(m).includes("image")).sort((a, b) => (b.context_length ?? 0) - (a.context_length ?? 0)).map((m) => m.id);
    const image = free.filter((m) => out(m).includes("image")).map((m) => m.id);
    orCache = { at: Date.now(), text, image };
    return orCache;
  } catch (e) {
    log("warn", "ai.openrouter_catalogue_failed", { error: String((e as Error).message ?? e) });
    return orCache ?? { text: [], image: [] };
  }
}

/** Test hook: reset the per-isolate cache. */
export const resetOpenRouterCache = () => void (orCache = null);

async function openRouterChat(env: Env, deps: Deps, model: string, body: Record<string, unknown>) {
  const res = await deps.fetchImpl("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      authorization: `Bearer ${env.OPENROUTER_API_KEY}`,
      "content-type": "application/json",
      "x-title": "DNI Growth",
      "http-referer": env.APP_ORIGIN,
    },
    body: JSON.stringify({ model, ...body }),
    signal: AbortSignal.timeout(45_000),
  });
  if (!res.ok) throw new Error(`openrouter_${res.status}`);
  const json = (await res.json()) as { error?: unknown };
  if (json.error) throw new Error("openrouter_error");
  return json as Record<string, unknown>;
}

// ── Text ─────────────────────────────────────────────────────────────────────────────────────
export async function generateText(env: Env, deps: Deps, messages: ChatMessage[], maxTokens = 700): Promise<TextResult> {
  const attempts: string[] = [];
  const inputApprox = approxTokens(messages.map((m) => m.content).join("\n"));

  for (const m of WORKERS_AI_TEXT_MODELS) {
    const budgetTokens = m.reasoning ? Math.max(maxTokens * 3, 2048) : maxTokens;
    const estimate = estimateTextCostUsd(m, { input: inputApprox, output: budgetTokens });
    if (!(await workersAiAllowed(env, estimate))) {
      attempts.push(`${m.model}:skipped_budget`);
      break;
    }
    try {
      const raw = await env.AI!.run(m.model as Parameters<Ai["run"]>[0], { messages, max_tokens: budgetTokens, temperature: 0.4 } as never);
      const { text, usage } = parseTextResult(raw);
      if (!text) throw new Error("empty");
      const u = usage ?? { input: inputApprox, output: approxTokens(text) };
      const cost = estimateTextCostUsd(m, u);
      await recordUsage(env, "workers_ai", cost, false);
      return { text, provider: "workers_ai", model: m.model, inputTokens: u.input, outputTokens: u.output, costUsd: cost };
    } catch (e) {
      attempts.push(`${m.model}:${String((e as Error).message ?? e).slice(0, 60)}`);
      log("warn", "ai.model_failed", { provider: "workers_ai", model: m.model, error: String((e as Error).message ?? e).slice(0, 120) });
      await recordUsage(env, "workers_ai", 0, true);
    }
  }

  if (env.OPENROUTER_API_KEY) {
    const { text: models } = await openRouterFreeModels(deps);
    for (const model of models.slice(0, 4)) {
      try {
        const json = await openRouterChat(env, deps, model, { messages, max_tokens: maxTokens, temperature: 0.4 });
        const { text, usage } = parseTextResult(json);
        if (!text) throw new Error("empty");
        await recordUsage(env, "openrouter", 0, false);
        return { text, provider: "openrouter", model, inputTokens: usage?.input ?? inputApprox, outputTokens: usage?.output ?? approxTokens(text), costUsd: 0 };
      } catch (e) {
        attempts.push(`${model}:${String((e as Error).message ?? e).slice(0, 60)}`);
        await recordUsage(env, "openrouter", 0, true);
      }
    }
  }

  if (env.GEMINI_API_KEY) {
    const model = "gemini-flash-latest";
    try {
      const system = messages.filter((m) => m.role === "system").map((m) => m.content).join("\n");
      const contents = messages.filter((m) => m.role !== "system").map((m) => ({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: m.content }] }));
      const res = await deps.fetchImpl(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-goog-api-key": env.GEMINI_API_KEY },
        body: JSON.stringify({ systemInstruction: { parts: [{ text: system }] }, contents, generationConfig: { maxOutputTokens: maxTokens, temperature: 0.4 } }),
        signal: AbortSignal.timeout(45_000),
      });
      if (!res.ok) throw new Error(`gemini_${res.status}`);
      const j = (await res.json()) as { candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>; usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number } };
      const text = (j.candidates?.[0]?.content?.parts ?? []).map((p) => p.text ?? "").join("").trim();
      if (!text) throw new Error("empty");
      await recordUsage(env, "gemini", 0, false);
      return { text, provider: "gemini", model, inputTokens: j.usageMetadata?.promptTokenCount ?? inputApprox, outputTokens: j.usageMetadata?.candidatesTokenCount ?? approxTokens(text), costUsd: 0 };
    } catch (e) {
      attempts.push(`${model}:${String((e as Error).message ?? e).slice(0, 60)}`);
      await recordUsage(env, "gemini", 0, true);
    }
  }

  log("error", "ai.text_unavailable", { attempts });
  throw new AiUnavailableError(attempts);
}

// ── Images ───────────────────────────────────────────────────────────────────────────────────
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

export async function generateImage(env: Env, deps: Deps, prompt: string): Promise<ImageResult> {
  const attempts: string[] = [];
  const estimate = estimateImageCostUsd();
  if (await workersAiAllowed(env, estimate)) {
    try {
      const raw = (await env.AI!.run(WORKERS_AI_IMAGE_MODEL.model as Parameters<Ai["run"]>[0], { prompt, steps: WORKERS_AI_IMAGE_MODEL.steps } as never)) as { image?: string };
      if (!raw?.image) throw new Error("empty");
      const bytes = b64ToBytes(raw.image);
      const contentType = sniffImageType(bytes);
      if (!contentType) throw new Error("not_an_image");
      await recordUsage(env, "workers_ai", estimate, false);
      return { bytes, contentType, provider: "workers_ai", model: WORKERS_AI_IMAGE_MODEL.model, costUsd: estimate };
    } catch (e) {
      attempts.push(`${WORKERS_AI_IMAGE_MODEL.model}:${String((e as Error).message ?? e).slice(0, 60)}`);
      await recordUsage(env, "workers_ai", 0, true);
    }
  } else attempts.push(`${WORKERS_AI_IMAGE_MODEL.model}:skipped_budget`);

  if (env.OPENROUTER_API_KEY) {
    const { image: models } = await openRouterFreeModels(deps);
    for (const model of models.slice(0, 3)) {
      try {
        const json = (await openRouterChat(env, deps, model, { messages: [{ role: "user", content: prompt }], modalities: ["image", "text"] })) as {
          choices?: Array<{ message?: { images?: Array<{ image_url?: { url?: string } }> } }>;
        };
        const url = json.choices?.[0]?.message?.images?.[0]?.image_url?.url ?? "";
        const m = /^data:image\/(png|jpeg|webp);base64,(.+)$/.exec(url);
        if (!m) throw new Error("no_image");
        const bytes = b64ToBytes(m[2]!);
        const contentType = sniffImageType(bytes);
        if (!contentType) throw new Error("not_an_image");
        await recordUsage(env, "openrouter", 0, false);
        return { bytes, contentType, provider: "openrouter", model, costUsd: 0 };
      } catch (e) {
        attempts.push(`${model}:${String((e as Error).message ?? e).slice(0, 60)}`);
        await recordUsage(env, "openrouter", 0, true);
      }
    }
  }
  log("error", "ai.image_unavailable", { attempts });
  throw new AiUnavailableError(attempts);
}

/** Public, secret-free status for the UI. */
export async function aiStatus(env: Env) {
  const spent = await spentToday(env, "workers_ai");
  return {
    workersAi: !!env.AI,
    openRouter: !!env.OPENROUTER_API_KEY,
    gemini: !!env.GEMINI_API_KEY,
    images: !!env.AI && !!env.MEDIA,
    dailyBudgetUsd: budget(env),
    spentTodayUsd: Math.round(spent * 10000) / 10000,
    budgetExhausted: spent >= budget(env),
  };
}
