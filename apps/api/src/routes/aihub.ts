import { Hono } from "hono";
import {
  AI_TASKS,
  AiPreferencesInput,
  CATEGORY_INFO,
  FREE_CLASS_LABEL,
  freeGate,
  OPENROUTER_FREE_ROUTER,
  TASK_PROFILES,
  WORKERS_AI_IMAGE_MODEL,
  WORKERS_AI_TEXT_MODELS,
  type AiTask,
  type AiCategory,
} from "@dni/core";
import type { AppEnv, Env } from "../env";
import { aiStatus, getAiPreferences, spentToday } from "../lib/ai";
import { auditStmt } from "../lib/audit";
import { ApiError, parseBody } from "../lib/http";
import { getState, listModels, loadModel, openRouterAvailability, quotaLimits, quotaUsage, type KeyInfo, type ModelRow, type SyncSummary } from "../lib/openrouter";
import { addSeconds, nowIso } from "../lib/util";
import { isPlatformAdmin, platformOnly, requireScope } from "../middleware";
import { aiUsageToday } from "../lib/quotas";

/** Public, credential-free view of an allowlist row. Descriptions are sanitised at sync time. */
export function publicModel(m: ModelRow) {
  return {
    id: m.modelId,
    name: m.displayName,
    description: m.description,
    provider: "openrouter",
    contextLength: m.contextLength,
    maxOutput: m.maxOutput,
    inputModalities: m.inputModalities,
    outputModalities: m.outputModalities,
    capabilities: m.capabilities,
    categories: m.categories,
    freeClass: m.freeClass,
    label: FREE_CLASS_LABEL[m.freeClass],
    reasons: m.reasons,
    eligible: m.eligible && !m.removedAt,
    isRouter: m.modelId === OPENROUTER_FREE_ROUTER,
    pricing: m.pricing,
    expirationDate: m.expirationDate,
    lastCheckedAt: m.lastCheckedAt,
    coolingDown: !!m.cooldownUntil && Date.parse(m.cooldownUntil) > Date.now(),
    health: { status: m.healthStatus, checkedAt: m.healthCheckedAt },
    tasks: AI_TASKS.filter((t) => freeGate(m, t).ok || (m.modelId === OPENROUTER_FREE_ROUTER && m.eligible && TASK_PROFILES[t].requires.every((c) => m.capabilities.includes(c)))),
  };
}

export async function providerStatus(env: Env, orgEnabled = true) {
  const db = env.DB;
  const day = new Date().toISOString().slice(0, 10);
  const [avail, lastSync, keyInfo, limits, halt, enabled, count, eligible, spent] = await Promise.all([
    openRouterAvailability(env, orgEnabled),
    getState<SyncSummary | null>(db, "or_last_sync", null),
    getState<KeyInfo | null>(db, "or_key_info", null),
    quotaLimits(env),
    getState<{ reason: string; at: string } | null>(db, "or_halt", null),
    getState(db, "or_enabled", true),
    db.prepare("SELECT COUNT(*) AS n FROM ai_models WHERE removed_at IS NULL").first<{ n: number }>(),
    db.prepare("SELECT COUNT(*) AS n FROM ai_models WHERE eligible = 1 AND removed_at IS NULL").first<{ n: number }>(),
    spentToday(env, "workers_ai"),
  ]);
  const usedToday = await quotaUsage(db, "or:global:day", day);
  return {
    policy: { freeOnly: true, allowPaidModels: false, maxSpendUsd: 0, statement: "OpenRouter solo con modelos gratuitos. Gasto autorizado en OpenRouter: 0,00 USD." },
    openrouter: {
      configured: !!env.OPENROUTER_API_KEY,
      connected: avail.usable,
      reason: avail.reason,
      enabledGlobally: enabled,
      halted: halt,
      lastSync,
      catalogCount: count?.n ?? 0,
      eligibleCount: eligible?.n ?? 0,
      quota: {
        usedToday,
        dailyLimit: limits.globalDaily,
        perMinute: limits.globalPerMinute,
        perOrgDaily: limits.orgDaily,
        perUserDaily: limits.userDaily,
        source: limits.source,
        note:
          limits.source === "reported_by_openrouter"
            ? "Límite diario de modelos gratuitos informado por OpenRouter para tu clave (menos un margen de 5)."
            : "Límite estimado y conservador: OpenRouter aún no ha informado el límite de tu clave. El contador es el de DNI Growth, no el de OpenRouter.",
        reset: "No mostramos hora de reinicio: OpenRouter no la publica para los modelos gratuitos.",
      },
      key: keyInfo ? { checkedAt: keyInfo.at, freeDailyLimit: keyInfo.freeDailyLimit, freeDailyUsed: keyInfo.freeDailyUsed, freeDailyRemaining: keyInfo.freeDailyRemaining, billedUsageUsd: keyInfo.usageTotal } : null,
    },
    workersAi: { configured: !!env.AI, dailyBudgetUsd: Number(env.AI_DAILY_BUDGET_USD ?? "0.10"), spentTodayUsd: Math.round(spent * 10000) / 10000, models: WORKERS_AI_TEXT_MODELS.map((m) => m.model), imageModel: WORKERS_AI_IMAGE_MODEL.model },
    gemini: { configured: !!env.GEMINI_API_KEY, note: "Respaldo gratuito tras Workers AI (y Groq, si está activado). El nivel gratuito de Gemini puede usar los datos para mejorar sus productos: se omite en modo privacidad y nunca recibe datos sensibles." },
    imageGeneration: { provider: "workers_ai", note: "OpenRouter no ofrece hoy ningún modelo gratuito que genere imágenes; las imágenes se crean con Workers AI (FLUX.1 schnell)." },
  };
}

export const aihub = new Hono<AppEnv>();

aihub.get("/ai/provider-status", platformOnly, requireScope("ai:use"), async (c) => {
  const prefs = await getAiPreferences(c.env.DB, c.get("tenant").orgId);
  return c.json({ ...(await providerStatus(c.env, prefs.openrouterEnabled)), legacy: await aiStatus(c.env) });
});

aihub.get("/ai/models", platformOnly, requireScope("ai:use"), async (c) => {
  const task = c.req.query("task") as AiTask | undefined;
  const category = c.req.query("category") as AiCategory | undefined;
  const capability = c.req.query("capability");
  const freeOnly = c.req.query("freeOnly") !== "false";
  const q = (c.req.query("q") ?? "").toLowerCase().slice(0, 80);
  if (task && !AI_TASKS.includes(task)) throw new ApiError(400, "invalid_task", "Tarea no válida.");
  if (category && !(category in CATEGORY_INFO)) throw new ApiError(400, "invalid_category", "Categoría no válida.");
  let items = (await listModels(c.env.DB)).map(publicModel);
  if (freeOnly) items = items.filter((m) => m.eligible);
  if (task) items = items.filter((m) => m.tasks.includes(task));
  if (category) items = items.filter((m) => m.categories.includes(category));
  if (capability) items = items.filter((m) => (m.capabilities as string[]).includes(capability));
  if (q) items = items.filter((m) => m.id.toLowerCase().includes(q) || m.name.toLowerCase().includes(q) || m.description.toLowerCase().includes(q));
  return c.json({
    items,
    categories: Object.entries(CATEGORY_INFO).map(([key, v]) => ({ key, ...v })),
    tasks: AI_TASKS.map((t) => ({ key: t, label: TASK_PROFILES[t].label, requires: TASK_PROFILES[t].requires })),
    labels: FREE_CLASS_LABEL,
    source: "https://openrouter.ai/api/v1/models (catálogo oficial, sincronizado por DNI Growth)",
  });
});

aihub.get("/ai/preferences", platformOnly, requireScope("ai:use"), async (c) => c.json(await getAiPreferences(c.env.DB, c.get("tenant").orgId)));

aihub.patch("/ai/preferences", platformOnly, requireScope("ai:configure"), async (c) => {
  const t = c.get("tenant");
  const input = await parseBody(c, AiPreferencesInput);
  let manual: string | null = null;
  if (input.strategy === "manual_free") {
    if (!input.manualModelId) throw new ApiError(400, "model_required", "Elige un modelo gratuito.");
    // Server-side allowlist: only eligible FREE models can be selected, whatever the UI sends.
    const row = await loadModel(c.env.DB, input.manualModelId);
    const usable = row && AI_TASKS.some((task) => freeGate(row, task).ok);
    if (!row || !usable || !(row.modelId.endsWith(":free") || row.modelId === OPENROUTER_FREE_ROUTER))
      throw new ApiError(422, "model_not_allowed", "Ese modelo no es gratuito verificado o no está disponible. Solo se pueden elegir modelos gratuitos elegibles.");
    manual = row.modelId;
  }
  const before = await getAiPreferences(c.env.DB, t.orgId);
  await c.env.DB.batch([
    c.env.DB.prepare(
      `INSERT INTO organization_ai_preferences (organization_id, strategy, manual_model_id, fallback_policy, privacy_first, openrouter_enabled, updated_by, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(organization_id) DO UPDATE SET strategy = excluded.strategy, manual_model_id = excluded.manual_model_id, fallback_policy = excluded.fallback_policy,
         privacy_first = excluded.privacy_first, openrouter_enabled = excluded.openrouter_enabled, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
    ).bind(t.orgId, input.strategy, manual, input.fallbackPolicy, input.privacyFirst ? 1 : 0, input.openrouterEnabled ? 1 : 0, t.userId, nowIso()),
    auditStmt(c.env.DB, { organizationId: t.orgId, actorUserId: t.userId, action: "ai.preferences_update", entityType: "organization", entityId: t.orgId, before, after: { ...input, manualModelId: manual }, requestId: c.get("requestId") }),
  ]);
  return c.json(await getAiPreferences(c.env.DB, t.orgId));
});

aihub.get("/ai/usage", requireScope("ai:use"), async (c) => {
  const t = c.get("tenant");
  const since = addSeconds(-30 * 86400);
  const db = c.env.DB;
  if (!(await isPlatformAdmin(c.env, c.get("user") ?? null))) {
    // Customers: «IA DNI Growth» activity only — no providers, models, tokens or costs.
    const [{ results: recent }, totals, today] = await Promise.all([
      db.prepare("SELECT task, status, latency_ms, created_at FROM ai_invocations WHERE organization_id = ? AND status IN ('ok','failed') ORDER BY created_at DESC LIMIT 60").bind(t.orgId).all(),
      db
        .prepare("SELECT COUNT(*) AS calls, SUM(CASE WHEN status = 'ok' THEN 1 ELSE 0 END) AS ok FROM ai_invocations WHERE organization_id = ? AND created_at > ? AND status IN ('ok','failed')")
        .bind(t.orgId, since)
        .first(),
      aiUsageToday(c.env, t.orgId, t.userId),
    ]);
    return c.json({
      period: "últimos 30 días",
      measurement: "observed",
      source: "Actividad de IA DNI Growth en tu organización",
      observedAt: nowIso(),
      engine: "IA DNI Growth",
      totals,
      recent,
      quotaToday: {
        organization: { used: today.used.org, limit: today.limits.orgDaily },
        user: { used: today.used.user, limit: today.limits.userDaily },
      },
    });
  }
  const [{ results: recent }, { results: byModel }, totals] = await Promise.all([
    db
      .prepare(
        `SELECT task, strategy, provider, model, served_model, status, error_code, latency_ms, input_tokens, output_tokens, estimated_cost_usd, reported_cost_usd, cost_state, is_fallback, created_at
         FROM ai_invocations WHERE organization_id = ? ORDER BY created_at DESC LIMIT 60`,
      )
      .bind(t.orgId)
      .all(),
    db
      .prepare(
        `SELECT provider, model, task, COUNT(*) AS calls, SUM(CASE WHEN status = 'ok' THEN 1 ELSE 0 END) AS ok, SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed,
                SUM(CASE WHEN error_code = 'http_429' THEN 1 ELSE 0 END) AS rate_limited, ROUND(AVG(CASE WHEN status = 'ok' THEN latency_ms END)) AS avg_latency_ms,
                SUM(COALESCE(input_tokens,0)) AS input_tokens, SUM(COALESCE(output_tokens,0)) AS output_tokens, SUM(COALESCE(reported_cost_usd,0)) AS reported_cost_usd,
                SUM(estimated_cost_usd) AS estimated_cost_usd
         FROM ai_invocations WHERE organization_id = ? AND created_at > ? GROUP BY provider, model, task ORDER BY calls DESC LIMIT 100`,
      )
      .bind(t.orgId, since)
      .all(),
    db
      .prepare(
        `SELECT COUNT(*) AS calls, SUM(CASE WHEN status = 'ok' THEN 1 ELSE 0 END) AS ok, SUM(CASE WHEN is_fallback = 1 AND status = 'ok' THEN 1 ELSE 0 END) AS fallback_ok,
                SUM(CASE WHEN provider = 'openrouter' AND cost_state = 'billed' THEN 1 ELSE 0 END) AS billed,
                SUM(CASE WHEN provider = 'openrouter' AND status = 'ok' THEN 1 ELSE 0 END) AS openrouter_ok,
                SUM(CASE WHEN provider = 'openrouter' AND cost_state = 'zero_confirmed' THEN 1 ELSE 0 END) AS openrouter_zero_confirmed
         FROM ai_invocations WHERE organization_id = ? AND created_at > ?`,
      )
      .bind(t.orgId, since)
      .first(),
  ]);
  const day = new Date().toISOString().slice(0, 10);
  const limits = await quotaLimits(c.env);
  return c.json({
    period: "últimos 30 días",
    measurement: "observed",
    source: "Registro de invocaciones de DNI Growth (ai_invocations)",
    observedAt: nowIso(),
    totals,
    byModel,
    recent,
    quotaToday: {
      organization: { used: await quotaUsage(db, `or:org:${t.orgId}`, day), limit: limits.orgDaily },
      user: { used: await quotaUsage(db, `or:user:${t.userId}`, day), limit: limits.userDaily },
    },
    note: "Los créditos internos de DNI Growth no son coste de OpenRouter. El coste de OpenRouter debe ser siempre 0 USD; 'zero_confirmed' significa que OpenRouter informó coste 0 en la respuesta.",
  });
});
