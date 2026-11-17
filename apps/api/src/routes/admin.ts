import { Hono } from "hono";
import { z } from "zod";
import { freeGate } from "@dni/core";
import type { AppEnv } from "../env";
import { logInvocation } from "../lib/ai";
import { auditStmt } from "../lib/audit";
import { ApiError, parseBody } from "../lib/http";
import {
  callOpenRouterChat,
  getState,
  loadModel,
  OpenRouterCallError,
  openRouterAvailability,
  quotaScopes,
  refreshKeyInfo,
  releaseQuota,
  reserveQuota,
  setState,
  syncOpenRouterCatalog,
} from "../lib/openrouter";
import { rateLimit } from "../lib/ratelimit";
import { addSeconds, nowIso, uuid } from "../lib/util";
import { requirePlatformAdmin, requireUser } from "../middleware";
import { providerStatus } from "./aihub";

/** Platform SuperAdmin endpoints for the AI Model Hub. 404 for everyone else. */
export const admin = new Hono<AppEnv>();
admin.use("*", requireUser, requirePlatformAdmin);

admin.get("/ai/overview", async (c) => {
  const db = c.env.DB;
  const since = addSeconds(-7 * 86400);
  const [{ results: perTenant }, { results: perModel }, { results: changes }, totals] = await Promise.all([
    db
      .prepare(
        `SELECT i.organization_id, o.name AS organization, COUNT(*) AS calls, SUM(CASE WHEN i.provider = 'openrouter' THEN 1 ELSE 0 END) AS openrouter_calls
         FROM ai_invocations i LEFT JOIN organizations o ON o.id = i.organization_id WHERE i.created_at > ? GROUP BY i.organization_id ORDER BY calls DESC LIMIT 50`,
      )
      .bind(since)
      .all(),
    db
      .prepare(
        `SELECT provider, model, task, COUNT(*) AS calls, SUM(CASE WHEN status='ok' THEN 1 ELSE 0 END) AS ok, SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) AS failed,
                SUM(CASE WHEN error_code='http_429' THEN 1 ELSE 0 END) AS rate_limited, ROUND(AVG(CASE WHEN status='ok' THEN latency_ms END)) AS avg_latency_ms,
                SUM(CASE WHEN is_fallback=1 AND status='ok' THEN 1 ELSE 0 END) AS served_as_fallback
         FROM ai_invocations WHERE created_at > ? GROUP BY provider, model, task ORDER BY calls DESC LIMIT 100`,
      )
      .bind(since)
      .all(),
    db.prepare("SELECT model_id, change, detail, created_at FROM ai_model_changes ORDER BY created_at DESC LIMIT 50").all(),
    db
      .prepare(
        `SELECT COUNT(*) AS calls, SUM(CASE WHEN provider='openrouter' AND cost_state='billed' THEN 1 ELSE 0 END) AS billed_calls,
                SUM(COALESCE(reported_cost_usd,0)) AS reported_cost_usd, SUM(CASE WHEN error_code='http_429' THEN 1 ELSE 0 END) AS rate_limited,
                SUM(CASE WHEN is_fallback=1 AND status='ok' THEN 1 ELSE 0 END) AS fallback_ok, SUM(CASE WHEN status='ok' THEN 1 ELSE 0 END) AS ok
         FROM ai_invocations WHERE created_at > ?`,
      )
      .bind(since)
      .first(),
  ]);
  return c.json({ period: "últimos 7 días", measurement: "observed", status: await providerStatus(c.env), totals, perTenant, perModel, changes });
});

admin.post("/ai/models/sync", async (c) => {
  await rateLimit(c.env.DB, `or-sync:${c.get("user")!.id}`, 6, 3600);
  const summary = await syncOpenRouterCatalog(c.env, c.get("deps"), { force: true });
  await refreshKeyInfo(c.env, c.get("deps"));
  await auditStmt(c.env.DB, { organizationId: null, actorUserId: c.get("user")!.id, action: "ai.catalog_sync", entityType: "ai_models", entityId: "openrouter", after: summary, requestId: c.get("requestId") }).run();
  if (!summary.ok) throw new ApiError(502, "sync_failed", "No se pudo sincronizar el catálogo de OpenRouter. Se conserva la última versión válida.", { error: summary.error });
  return c.json(summary);
});

const ToggleInput = z.strictObject({ enabled: z.boolean() });
admin.post("/ai/openrouter/kill-switch", async (c) => {
  const { enabled } = await parseBody(c, ToggleInput);
  await setState(c.env.DB, "or_enabled", enabled);
  await auditStmt(c.env.DB, { organizationId: null, actorUserId: c.get("user")!.id, action: enabled ? "ai.openrouter_enable" : "ai.openrouter_kill_switch", entityType: "platform", entityId: "openrouter", after: { enabled }, requestId: c.get("requestId") }).run();
  return c.json({ enabled });
});

admin.post("/ai/openrouter/reset-halt", async (c) => {
  const halt = await getState(c.env.DB, "or_halt", null);
  await c.env.DB.batch([
    c.env.DB.prepare("DELETE FROM ai_platform_state WHERE k IN ('or_halt','or_cooldown_until')"),
    auditStmt(c.env.DB, { organizationId: null, actorUserId: c.get("user")!.id, action: "ai.openrouter_reset_halt", entityType: "platform", entityId: "openrouter", before: halt, requestId: c.get("requestId") }),
  ]);
  return c.json({ ok: true });
});

/** Opt-in health check of ONE model: one tiny request, at most once per model per 24 h. */
admin.post("/ai/models/health-check", async (c) => {
  const { modelId } = await parseBody(c, z.strictObject({ modelId: z.string().max(120) }));
  const db = c.env.DB;
  await rateLimit(db, "or-health-global", 10, 86400);
  const row = await loadModel(db, modelId);
  if (!row || !freeGate(row, "classification").ok) throw new ApiError(422, "model_not_allowed", "Solo se comprueban modelos gratuitos elegibles.");
  if (row.healthCheckedAt && Date.now() - Date.parse(row.healthCheckedAt) < 86_400_000) throw new ApiError(429, "recently_checked", "Este modelo ya se comprobó en las últimas 24 horas.");
  const avail = await openRouterAvailability(c.env);
  if (!avail.usable) throw new ApiError(503, "openrouter_unavailable", `OpenRouter no está disponible: ${avail.reason}.`);
  const scopes = await quotaScopes(c.env, null, null);
  const q = await reserveQuota(db, scopes);
  if (!q.ok) throw new ApiError(429, "quota_exhausted", "La cuota gratuita de OpenRouter se ha agotado.");
  const ref = uuid();
  try {
    const r = await callOpenRouterChat(c.env, c.get("deps"), modelId, "classification", [{ role: "user", content: "Responde únicamente con la palabra: OK" }], { maxTokens: 16, temperature: 0, privacyFirst: false });
    await db.prepare("UPDATE ai_models SET health_status = 'ok', health_checked_at = ?, health_error = NULL WHERE model_id = ?").bind(nowIso(), modelId).run();
    await logInvocation(c.env, { orgId: null, userId: c.get("user")!.id, requestRef: ref, task: "health_check", strategy: "manual_free", provider: "openrouter", model: modelId, servedModel: r.servedModel, status: "ok", latencyMs: r.latencyMs, inputTokens: r.inputTokens, outputTokens: r.outputTokens, reportedCostUsd: r.reportedCostUsd, costState: r.reportedCostUsd === 0 ? "zero_confirmed" : "zero_expected", isFallback: false });
    return c.json({ ok: true, latencyMs: r.latencyMs, servedModel: r.servedModel, reportedCostUsd: r.reportedCostUsd });
  } catch (e) {
    const code = e instanceof OpenRouterCallError ? e.code : "error";
    if (code.startsWith("gate:")) await releaseQuota(db, scopes);
    await db.prepare("UPDATE ai_models SET health_status = 'failed', health_checked_at = ?, health_error = ? WHERE model_id = ?").bind(nowIso(), code, modelId).run();
    await logInvocation(c.env, { orgId: null, userId: c.get("user")!.id, requestRef: ref, task: "health_check", strategy: "manual_free", provider: "openrouter", model: modelId, status: "failed", errorCode: code, costState: "zero_expected", isFallback: false });
    return c.json({ ok: false, error: code }, 200);
  }
});
