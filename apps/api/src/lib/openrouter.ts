import {
  buildFreeCatalog,
  CATALOG_TTL_HOURS,
  freeGate,
  OPENROUTER_API,
  OPENROUTER_FREE_ROUTER,
  servedModelAllowed,
  TASK_PROFILES,
  ZERO_MAX_PRICE,
  type AiTask,
  type Capability,
  type ChatMessage,
  type EligibilityRow,
  type FreeClass,
  type ObservedStats,
} from "@dni/core";
import type { Deps, Env } from "../env";
import { addSeconds, log, nowIso, parseJson, uuid } from "./util";

/**
 * OpenRouter FREE-only adapter. Fail-closed at every layer:
 *  - policy vars must say FREE_ONLY=true, ALLOW_PAID_MODELS=false, MAX_SPEND_USD=0, otherwise OpenRouter is off;
 *  - only ids in the server-built D1 allowlist (":free" + "openrouter/free") with a fresh zero price are callable;
 *  - every request carries provider.max_price = 0 for every component;
 *  - any reported cost > 0, 402, or a non-free served model halts OpenRouter for the whole platform
 *    until a platform admin resets it.
 * The API key lives only in the Worker secret OPENROUTER_API_KEY and is never logged or returned.
 */

// ── Platform state (D1 key/value) ────────────────────────────────────────────────────────────
export async function getState<T>(db: D1Database, k: string, fallback: T): Promise<T> {
  const r = await db.prepare("SELECT v FROM ai_platform_state WHERE k = ?").bind(k).first<{ v: string }>();
  return r ? parseJson<T>(r.v, fallback) : fallback;
}
export function setStateStmt(db: D1Database, k: string, v: unknown) {
  return db
    .prepare("INSERT INTO ai_platform_state (k, v, updated_at) VALUES (?, ?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v, updated_at = excluded.updated_at")
    .bind(k, JSON.stringify(v), nowIso());
}
export const setState = (db: D1Database, k: string, v: unknown) => setStateStmt(db, k, v).run();

export interface HaltState {
  reason: string;
  detail?: string;
  at: string;
}

export async function haltOpenRouter(env: Env, reason: string, detail = "") {
  await setState(env.DB, "or_halt", { reason, detail: detail.slice(0, 300), at: nowIso() } satisfies HaltState);
  await env.DB.prepare("INSERT INTO ai_model_changes (id, model_id, change, detail) VALUES (?, '*', 'blocked', ?)").bind(uuid(), `OpenRouter detenido: ${reason}`).run();
  log("error", "openrouter.halted", { reason });
}

/** Policy vars are fail-closed: anything but the exact safe values disables OpenRouter. */
export function policyCheck(env: Env): { ok: true } | { ok: false; reason: string } {
  if ((env.OPENROUTER_FREE_ONLY ?? "true") !== "true") return { ok: false, reason: "politica_free_only_desactivada" };
  if ((env.ALLOW_PAID_MODELS ?? "false") !== "false") return { ok: false, reason: "allow_paid_models_no_permitido" };
  if (Number(env.OPENROUTER_MAX_SPEND_USD ?? "0") !== 0) return { ok: false, reason: "max_spend_distinto_de_cero" };
  return { ok: true };
}

export interface OpenRouterAvailability {
  usable: boolean;
  reason: string | null;
}

export async function openRouterAvailability(env: Env, orgEnabled = true): Promise<OpenRouterAvailability> {
  if (!env.OPENROUTER_API_KEY) return { usable: false, reason: "no_configurado" };
  const p = policyCheck(env);
  if (!p.ok) return { usable: false, reason: p.reason };
  if (!(await getState(env.DB, "or_enabled", true))) return { usable: false, reason: "desactivado_por_administrador" };
  if (!orgEnabled) return { usable: false, reason: "desactivado_para_esta_empresa" };
  const halt = await getState<HaltState | null>(env.DB, "or_halt", null);
  if (halt) return { usable: false, reason: `detenido:${halt.reason}` };
  const cooldown = await getState<string | null>(env.DB, "or_cooldown_until", null);
  if (cooldown && Date.parse(cooldown) > Date.now()) return { usable: false, reason: "limite_de_frecuencia_temporal" };
  return { usable: true, reason: null };
}

// ── Quotas (shared key → global + per org + per user) ────────────────────────────────────────
export interface QuotaScope {
  scope: string;
  window: string;
  limit: number;
}
const intVar = (v: string | undefined, d: number) => {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : d;
};

export async function quotaLimits(env: Env) {
  const key = await getState<KeyInfo | null>(env.DB, "or_key_info", null);
  let globalDaily = intVar(env.OPENROUTER_DAILY_REQUESTS, 45);
  // When OpenRouter reports the key's real free-model allowance, never plan above it (5 request margin).
  if (typeof key?.freeDailyLimit === "number") globalDaily = Math.min(globalDaily, Math.max(0, key.freeDailyLimit - 5));
  return {
    globalDaily,
    globalPerMinute: Math.min(intVar(env.OPENROUTER_RPM, 15), 19),
    orgDaily: intVar(env.OPENROUTER_ORG_DAILY, 20),
    userDaily: intVar(env.OPENROUTER_USER_DAILY, 10),
    source: typeof key?.freeDailyLimit === "number" ? "reported_by_openrouter" : "estimated",
  };
}

export async function quotaScopes(env: Env, orgId: string | null, userId: string | null, now = new Date()): Promise<QuotaScope[]> {
  const l = await quotaLimits(env);
  const day = now.toISOString().slice(0, 10);
  const minute = now.toISOString().slice(0, 16);
  const s: QuotaScope[] = [
    { scope: "or:global:day", window: day, limit: l.globalDaily },
    { scope: "or:global:min", window: minute, limit: l.globalPerMinute },
  ];
  if (orgId) s.push({ scope: `or:org:${orgId}`, window: day, limit: l.orgDaily });
  if (userId) s.push({ scope: `or:user:${userId}`, window: day, limit: l.userDaily });
  return s;
}

/** Atomic all-or-nothing reservation (each step is a conditional upsert; compensates on failure). */
export async function reserveQuota(db: D1Database, scopes: QuotaScope[]): Promise<{ ok: true } | { ok: false; scope: string }> {
  const taken: QuotaScope[] = [];
  for (const q of scopes) {
    let ok = false;
    if (q.limit > 0) {
      const r = await db
        .prepare(
          `INSERT INTO ai_quota_counters (scope, window_key, count, updated_at) VALUES (?, ?, 1, ?)
           ON CONFLICT(scope, window_key) DO UPDATE SET count = count + 1, updated_at = excluded.updated_at WHERE ai_quota_counters.count < ?
           RETURNING count`,
        )
        .bind(q.scope, q.window, nowIso(), q.limit)
        .first<{ count: number }>();
      ok = !!r;
    }
    if (!ok) {
      await releaseQuota(db, taken);
      return { ok: false, scope: q.scope };
    }
    taken.push(q);
  }
  return { ok: true };
}

export async function releaseQuota(db: D1Database, scopes: QuotaScope[]) {
  for (const q of scopes)
    await db.prepare("UPDATE ai_quota_counters SET count = MAX(count - 1, 0), updated_at = ? WHERE scope = ? AND window_key = ?").bind(nowIso(), q.scope, q.window).run();
}

export async function quotaUsage(db: D1Database, scope: string, window: string): Promise<number> {
  const r = await db.prepare("SELECT count FROM ai_quota_counters WHERE scope = ? AND window_key = ?").bind(scope, window).first<{ count: number }>();
  return r?.count ?? 0;
}

// ── Catalogue registry ───────────────────────────────────────────────────────────────────────
export interface ModelRow extends EligibilityRow {
  displayName: string;
  description: string;
  maxOutput: number | null;
  inputModalities: string[];
  outputModalities: string[];
  supportedParameters: string[];
  pricing: Record<string, string>;
  reasons: string[];
  categories: string[];
  expirationDate: string | null;
  firstSeenAt: string;
  healthStatus: string;
  healthCheckedAt: string | null;
}

interface DbModel {
  model_id: string;
  display_name: string;
  description: string;
  context_length: number;
  max_output: number | null;
  input_modalities: string;
  output_modalities: string;
  supported_parameters: string;
  pricing_json: string;
  free_class: FreeClass;
  reasons: string;
  capabilities: string;
  categories: string;
  eligible: number;
  expiration_date: string | null;
  first_seen_at: string;
  last_checked_at: string;
  removed_at: string | null;
  cooldown_until: string | null;
  health_status: string;
  health_checked_at: string | null;
}

const toRow = (m: DbModel): ModelRow => ({
  modelId: m.model_id,
  displayName: m.display_name,
  description: m.description,
  contextLength: m.context_length,
  maxOutput: m.max_output,
  inputModalities: parseJson<string[]>(m.input_modalities, []),
  outputModalities: parseJson<string[]>(m.output_modalities, []),
  supportedParameters: parseJson<string[]>(m.supported_parameters, []),
  pricing: parseJson<Record<string, string>>(m.pricing_json, {}),
  freeClass: m.free_class,
  reasons: parseJson<string[]>(m.reasons, []),
  capabilities: parseJson<Capability[]>(m.capabilities, []),
  categories: parseJson<string[]>(m.categories, []),
  eligible: m.eligible === 1,
  expirationDate: m.expiration_date,
  firstSeenAt: m.first_seen_at,
  lastCheckedAt: m.last_checked_at,
  removedAt: m.removed_at,
  cooldownUntil: m.cooldown_until,
  healthStatus: m.health_status,
  healthCheckedAt: m.health_checked_at,
});

export async function listModels(db: D1Database): Promise<ModelRow[]> {
  const { results } = await db.prepare("SELECT * FROM ai_models ORDER BY eligible DESC, display_name").all<DbModel>();
  return results.map(toRow);
}
export async function loadModel(db: D1Database, id: string): Promise<ModelRow | null> {
  const r = await db.prepare("SELECT * FROM ai_models WHERE model_id = ?").bind(id).first<DbModel>();
  return r ? toRow(r) : null;
}

export interface SyncSummary {
  ok: boolean;
  at: string;
  seen: number;
  stored: number;
  eligible: number;
  added: number;
  removed: number;
  priceChanged: number;
  notModified?: boolean;
  error?: string;
}

/** Fetches the official catalogue and updates the allowlist. Keeps the last good snapshot on failure. */
export async function syncOpenRouterCatalog(env: Env, deps: Deps, opts: { force?: boolean } = {}): Promise<SyncSummary> {
  const db = env.DB;
  const at = nowIso();
  const failures = await getState<{ n: number; until?: string }>(db, "or_sync_failures", { n: 0 });
  if (!opts.force && failures.until && Date.parse(failures.until) > Date.now()) return { ok: false, at, seen: 0, stored: 0, eligible: 0, added: 0, removed: 0, priceChanged: 0, error: "circuit_open" };
  const etag = await getState<string | null>(db, "or_catalog_etag", null);
  let data: unknown;
  try {
    let res: Response | null = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      res = await deps.fetchImpl(`${OPENROUTER_API}/models`, {
        headers: { accept: "application/json", ...(etag && !opts.force ? { "if-none-match": etag } : {}) },
        signal: AbortSignal.timeout(10_000),
      });
      if (res.status < 500) break;
      await deps.sleep(500 + Math.floor(Math.random() * 500));
    }
    if (!res) throw new Error("no_response");
    if (res.status === 304) {
      await db.prepare("UPDATE ai_models SET last_checked_at = ?, expires_at = ? WHERE removed_at IS NULL").bind(at, addSeconds(CATALOG_TTL_HOURS * 3600)).run();
      const summary: SyncSummary = { ok: true, at, seen: 0, stored: 0, eligible: 0, added: 0, removed: 0, priceChanged: 0, notModified: true };
      await db.batch([setStateStmt(db, "or_last_sync", summary), setStateStmt(db, "or_sync_failures", { n: 0 })]);
      return summary;
    }
    if (!res.ok) throw new Error(`models_${res.status}`);
    const text = await res.text();
    if (text.length > 8_000_000) throw new Error("catalog_too_large");
    data = (JSON.parse(text) as { data?: unknown }).data;
    if (!Array.isArray(data)) throw new Error("catalog_schema_changed");
    const newTag = res.headers.get("etag");
    if (newTag) await setState(db, "or_catalog_etag", newTag);
  } catch (e) {
    const n = failures.n + 1;
    const err = String((e as Error).message ?? e).slice(0, 120);
    await setState(db, "or_sync_failures", { n, until: n >= 3 ? addSeconds(3600) : undefined });
    const summary: SyncSummary = { ok: false, at, seen: 0, stored: 0, eligible: 0, added: 0, removed: 0, priceChanged: 0, error: err };
    await setState(db, "or_last_sync", summary);
    log("warn", "openrouter.sync_failed", { error: err, consecutive: n });
    return summary;
  }

  const { models, seen } = buildFreeCatalog(data);
  const existing = new Map((await listModels(db)).map((m) => [m.modelId, m]));
  const stmts: D1PreparedStatement[] = [];
  let added = 0;
  let priceChanged = 0;
  const expires = addSeconds(CATALOG_TTL_HOURS * 3600);
  for (const m of models) {
    const prev = existing.get(m.modelId);
    const prevHash = prev ? Object.keys(prev.pricing).sort().map((k) => `${k}=${prev.pricing[k]}`).join(";") : null;
    if (!prev) {
      added++;
      stmts.push(db.prepare("INSERT INTO ai_model_changes (id, model_id, change, detail) VALUES (?, ?, 'added', ?)").bind(uuid(), m.modelId, m.eligible ? "nuevo modelo gratuito elegible" : `excluido: ${m.reasons.join(",")}`));
    } else if (prevHash !== m.priceHash) {
      priceChanged++;
      stmts.push(db.prepare("INSERT INTO ai_model_changes (id, model_id, change, detail) VALUES (?, ?, 'price_changed', ?)").bind(uuid(), m.modelId, `${prevHash} → ${m.priceHash}`.slice(0, 300)));
    }
    if (prev && prev.eligible && !m.eligible) stmts.push(db.prepare("INSERT INTO ai_model_changes (id, model_id, change, detail) VALUES (?, ?, 'blocked', ?)").bind(uuid(), m.modelId, m.reasons.join(",").slice(0, 300)));
    if (prev?.removedAt) stmts.push(db.prepare("INSERT INTO ai_model_changes (id, model_id, change, detail) VALUES (?, ?, 'restored', '')").bind(uuid(), m.modelId));
    stmts.push(
      db
        .prepare(
          `INSERT INTO ai_models (model_id, display_name, description, context_length, max_output, input_modalities, output_modalities, endpoints, supported_parameters,
             pricing_json, price_hash, free_class, reasons, capabilities, categories, eligible, expiration_date, last_checked_at, expires_at, removed_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
           ON CONFLICT(model_id) DO UPDATE SET display_name = excluded.display_name, description = excluded.description, context_length = excluded.context_length,
             max_output = excluded.max_output, input_modalities = excluded.input_modalities, output_modalities = excluded.output_modalities, endpoints = excluded.endpoints,
             supported_parameters = excluded.supported_parameters, pricing_json = excluded.pricing_json, price_hash = excluded.price_hash, free_class = excluded.free_class,
             reasons = excluded.reasons, capabilities = excluded.capabilities, categories = excluded.categories, eligible = excluded.eligible,
             expiration_date = excluded.expiration_date, last_checked_at = excluded.last_checked_at, expires_at = excluded.expires_at, removed_at = NULL`,
        )
        .bind(
          m.modelId, m.displayName, m.description, m.contextLength, m.maxOutput, JSON.stringify(m.inputModalities), JSON.stringify(m.outputModalities),
          JSON.stringify(m.endpoints), JSON.stringify(m.supportedParameters), JSON.stringify(m.pricing), m.priceHash, m.freeClass, JSON.stringify(m.reasons),
          JSON.stringify(m.capabilities), JSON.stringify(m.categories), m.eligible ? 1 : 0, m.expirationDate, at, expires,
        ),
    );
  }
  const seenIds = new Set(models.map((m) => m.modelId));
  let removed = 0;
  for (const prev of existing.values()) {
    if (seenIds.has(prev.modelId) || prev.removedAt) continue;
    removed++;
    stmts.push(
      db.prepare("UPDATE ai_models SET eligible = 0, free_class = 'unavailable', removed_at = ?, last_checked_at = ? WHERE model_id = ?").bind(at, at, prev.modelId),
      db.prepare("INSERT INTO ai_model_changes (id, model_id, change, detail) VALUES (?, ?, 'removed', 'ya no aparece en el catálogo gratuito')").bind(uuid(), prev.modelId),
    );
  }
  const summary: SyncSummary = { ok: true, at, seen, stored: models.length, eligible: models.filter((m) => m.eligible).length, added, removed, priceChanged };
  stmts.push(setStateStmt(db, "or_last_sync", summary), setStateStmt(db, "or_sync_failures", { n: 0 }));
  for (let i = 0; i < stmts.length; i += 50) await db.batch(stmts.slice(i, i + 50));
  log("info", "openrouter.synced", { seen, stored: summary.stored, eligible: summary.eligible, added, removed, priceChanged });
  return summary;
}

/** Cron hook: sync every 12 h (or immediately when the catalogue is empty). */
export async function maybeSyncCatalog(env: Env, deps: Deps) {
  if (!env.OPENROUTER_API_KEY || !policyCheck(env).ok) return;
  const last = await getState<SyncSummary | null>(env.DB, "or_last_sync", null);
  const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM ai_models").first<{ n: number }>();
  const due = !last || !count?.n || Date.now() - Date.parse(last.at) > 12 * 3600_000 || (!last.ok && Date.now() - Date.parse(last.at) > 15 * 60_000);
  if (due) await syncOpenRouterCatalog(env, deps);
  const key = await getState<KeyInfo | null>(env.DB, "or_key_info", null);
  if (!key || Date.now() - Date.parse(key.at) > 30 * 60_000) await refreshKeyInfo(env, deps);
}

// ── Key information (credits used, free-model allowance) ─────────────────────────────────────
export interface KeyInfo {
  at: string;
  isFreeTier: boolean | null;
  freeDailyLimit: number | null;
  freeDailyUsed: number | null;
  freeDailyRemaining: number | null;
  usageTotal: number | null;
  usageDaily: number | null;
  limitRemaining: number | null;
}

/** GET /key does not consume free-model requests. Any increase in billed usage halts OpenRouter. */
export async function refreshKeyInfo(env: Env, deps: Deps): Promise<KeyInfo | null> {
  if (!env.OPENROUTER_API_KEY) return null;
  try {
    const res = await deps.fetchImpl(`${OPENROUTER_API}/key`, { headers: { authorization: `Bearer ${env.OPENROUTER_API_KEY}` }, signal: AbortSignal.timeout(8000) });
    if (res.status === 401 || res.status === 403) {
      await haltOpenRouter(env, "clave_invalida", `GET /key → ${res.status}`);
      return null;
    }
    if (!res.ok) return null;
    const d = ((await res.json()) as { data?: Record<string, unknown> }).data ?? {};
    const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
    const fm = (d.free_model_daily_requests ?? null) as { used?: unknown; limit?: unknown; remaining?: unknown } | null;
    const info: KeyInfo = {
      at: nowIso(),
      isFreeTier: typeof d.is_free_tier === "boolean" ? d.is_free_tier : null,
      freeDailyLimit: num(fm?.limit),
      freeDailyUsed: num(fm?.used),
      freeDailyRemaining: num(fm?.remaining),
      usageTotal: num(d.usage),
      usageDaily: num(d.usage_daily),
      limitRemaining: num(d.limit_remaining),
    };
    const baseline = await getState<number | null>(env.DB, "or_usage_baseline", null);
    if (typeof baseline !== "number" && typeof info.usageTotal === "number") await setState(env.DB, "or_usage_baseline", info.usageTotal);
    else if (typeof baseline === "number" && typeof info.usageTotal === "number" && info.usageTotal > baseline + 1e-9)
      await haltOpenRouter(env, "gasto_detectado_en_la_clave", `usage ${baseline} → ${info.usageTotal}`);
    await setState(env.DB, "or_key_info", info);
    return info;
  } catch (e) {
    log("warn", "openrouter.key_info_failed", { error: String((e as Error).message ?? e).slice(0, 80) });
    return null;
  }
}

// ── Observed stats for ranking ───────────────────────────────────────────────────────────────
export async function observedStats(db: D1Database, task: AiTask): Promise<Record<string, ObservedStats>> {
  const { results } = await db
    .prepare(
      `SELECT model, SUM(CASE WHEN status = 'ok' THEN 1 ELSE 0 END) AS ok, SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed,
              AVG(CASE WHEN status = 'ok' THEN latency_ms END) AS lat
       FROM ai_invocations WHERE provider = 'openrouter' AND task = ? AND created_at > ? GROUP BY model`,
    )
    .bind(task, addSeconds(-7 * 86400))
    .all<{ model: string; ok: number; failed: number; lat: number | null }>();
  const out: Record<string, ObservedStats> = {};
  for (const r of results) out[r.model] = { ok: r.ok, failed: r.failed, avgLatencyMs: r.lat };
  return out;
}

// ── The call ─────────────────────────────────────────────────────────────────────────────────
export class OpenRouterCallError extends Error {
  constructor(
    readonly code: string,
    readonly scope: "model" | "global",
    readonly costUsd: number | null = null,
  ) {
    super(code);
  }
}

export interface OpenRouterResult {
  text: string;
  servedModel: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  reportedCostUsd: number | null;
  latencyMs: number;
}

/**
 * Executes ONE chat completion against an allowlisted free model. Revalidates the allowlist row
 * right before sending (fail-closed), sends max_price = 0, and verifies the reported cost.
 */
export async function callOpenRouterChat(
  env: Env,
  deps: Deps,
  modelId: string,
  task: AiTask,
  messages: ChatMessage[],
  opts: { maxTokens: number; temperature: number; privacyFirst: boolean },
): Promise<OpenRouterResult> {
  if (!policyCheck(env).ok || !env.OPENROUTER_API_KEY) throw new OpenRouterCallError("policy_blocked", "global");
  const row = await loadModel(env.DB, modelId);
  const gate = freeGate(row, task);
  if (!gate.ok) throw new OpenRouterCallError(`gate:${gate.reason}`, "model");
  const maxTokens = Math.max(16, Math.min(opts.maxTokens, row!.maxOutput ?? opts.maxTokens, TASK_PROFILES[task].maxOutputTokens * 2));
  const body = {
    model: modelId,
    messages,
    max_tokens: maxTokens,
    temperature: opts.temperature,
    usage: { include: true },
    provider: { max_price: ZERO_MAX_PRICE, ...(opts.privacyFirst ? { data_collection: "deny", zdr: true } : {}) },
  };
  const started = Date.now();
  let res: Response;
  try {
    res = await deps.fetchImpl(`${OPENROUTER_API}/chat/completions`, {
      method: "POST",
      headers: { authorization: `Bearer ${env.OPENROUTER_API_KEY}`, "content-type": "application/json", "x-title": "DNI Growth", "http-referer": env.APP_ORIGIN },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(45_000),
    });
  } catch {
    await cooldownModel(env, modelId, 600);
    throw new OpenRouterCallError("timeout", "model");
  }
  const latencyMs = Date.now() - started;
  if (!res.ok) {
    const s = res.status;
    if (s === 402) {
      await haltOpenRouter(env, "pago_requerido_402", `modelo ${modelId}`);
      throw new OpenRouterCallError("http_402", "global");
    }
    if (s === 401 || s === 403) {
      await haltOpenRouter(env, "clave_invalida", `HTTP ${s}`);
      throw new OpenRouterCallError(`http_${s}`, "global");
    }
    if (s === 429) {
      const ra = Number(res.headers.get("retry-after"));
      const reset = Number(res.headers.get("x-ratelimit-reset"));
      const until = Number.isFinite(ra) && ra > 0 ? addSeconds(Math.min(ra, 3600)) : Number.isFinite(reset) && reset > Date.now() ? new Date(Math.min(reset, Date.now() + 86_400_000)).toISOString() : addSeconds(60);
      await setState(env.DB, "or_cooldown_until", until);
      throw new OpenRouterCallError("http_429", "global");
    }
    if (s === 404 && !opts.privacyFirst) await cooldownModel(env, modelId, 3600);
    else if (s === 408 || s >= 500) await cooldownModel(env, modelId, 600);
    throw new OpenRouterCallError(`http_${s}`, "model");
  }
  let json: {
    model?: unknown;
    error?: unknown;
    choices?: Array<{ message?: { content?: unknown }; finish_reason?: unknown }>;
    usage?: { prompt_tokens?: unknown; completion_tokens?: unknown; cost?: unknown };
  };
  try {
    json = await res.json();
  } catch {
    throw new OpenRouterCallError("invalid_json", "model");
  }
  const rawCost = json.usage?.cost;
  const reportedCostUsd = typeof rawCost === "number" && Number.isFinite(rawCost) ? rawCost : typeof rawCost === "string" && Number.isFinite(Number(rawCost)) ? Number(rawCost) : null;
  if (typeof reportedCostUsd === "number" && reportedCostUsd > 0) {
    await haltOpenRouter(env, "cobro_inesperado", `${modelId} cost=${reportedCostUsd}`);
    throw new OpenRouterCallError("unexpected_charge", "global", reportedCostUsd);
  }
  const servedModel = typeof json.model === "string" ? json.model.slice(0, 160) : null;
  if (!servedModelAllowed(modelId, servedModel)) {
    if (typeof reportedCostUsd !== "number") await haltOpenRouter(env, "modelo_servido_no_verificable", `${modelId} → ${servedModel}`);
    throw new OpenRouterCallError("served_model_not_free", typeof reportedCostUsd !== "number" ? "global" : "model");
  }
  if (json.error) throw new OpenRouterCallError("provider_error", "model");
  const content = json.choices?.[0]?.message?.content;
  const text = typeof content === "string" ? content.trim() : "";
  if (!text) throw new OpenRouterCallError(json.choices?.[0]?.finish_reason === "length" ? "truncated_empty" : "empty", "model");
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
  return { text, servedModel, inputTokens: n(json.usage?.prompt_tokens), outputTokens: n(json.usage?.completion_tokens), reportedCostUsd, latencyMs };
}

async function cooldownModel(env: Env, modelId: string, seconds: number) {
  await env.DB.prepare("UPDATE ai_models SET cooldown_until = ? WHERE model_id = ?").bind(addSeconds(seconds), modelId).run();
}

export const isRouterId = (id: string) => id === OPENROUTER_FREE_ROUTER;
