import { Hono, type Context } from "hono";
import { z } from "zod";
import {
  CreateGeoPromptsInput,
  GEO_CATEGORIES,
  GEO_CATEGORY_LABEL,
  GEO_ENGINES,
  GEO_INTENT_LABEL,
  GEO_INTENTS,
  GEO_PROMPT_LIMITS,
  GeoLocale,
  normalizeQuestion,
  suggestGeoPrompts,
  UpdateGeoPromptInput,
  buildGeoRecommendations,
  GEO_REC_METHOD,
  wilsonInterval,
  type BrandFact,
  type GeoCategory,
  type GeoIntent,
} from "@dni/core";
import type { AppEnv, Env } from "../env";
import { auditStmt } from "../lib/audit";
import { orgPlan } from "../lib/billing";
import { ApiError, assertUuid, notFound, parseBody } from "../lib/http";
import { rateLimit } from "../lib/ratelimit";
import { nowIso, parseJson, toCsv, uuid } from "../lib/util";
import { requireScope } from "../middleware";
import { dispatchOutbox } from "../jobs/queue";
import { geoQuotaToday } from "../jobs/geo";
import { geoFallbackModel, geoLimits, geoModel, geoSamplingReady } from "../lib/geoGemini";

/** GEO prompt library (mounted under /orgs/:orgId). Stores questions only — never AI answers. */
export const geo = new Hono<AppEnv>();

export const GEO_LIBRARY_CAVEATS = [
  "Cada respuesta es una muestra puntual (fecha, motor, modelo, idioma y región) obtenida por la API oficial; no prueba lo que ve cada usuario real, que puede tener otra personalización, historial o ubicación.",
  "Solo se muestrea Gemini por API, en el nivel gratuito. Se pide con búsqueda de Google y, si el nivel gratuito no la ofrece para el modelo, sin búsqueda: entonces la respuesta refleja el conocimiento del modelo y no trae fuentes (cada muestra lo indica). Otros motores con API oficial requieren clave y presupuesto aprobados; los motores sin API oficial (AI Overviews, app de ChatGPT) no se consultan automáticamente.",
  "La región se indica al modelo en la instrucción: la API de Gemini no permite fijar la ubicación real de la búsqueda.",
  "La detección de menciones busca el nombre y el dominio de la marca en el texto, sin interpretar el contexto (una mención puede ser negativa).",
];
export const GEO_VISIBILITY_CAVEATS = [
  ...GEO_LIBRARY_CAVEATS,
  "Los porcentajes usan la última muestra correcta de cada pregunta de los últimos 30 días; con pocas preguntas varían mucho de una muestra a otra.",
];

type Row = {
  id: string;
  brand_id: string;
  question: string;
  intent: string;
  category: string;
  engine: string;
  locale: string;
  region_country: string;
  region_detail: string | null;
  enabled: number;
  source: string;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
  created_by_name: string | null;
};
const shape = (r: Row) => ({
  id: r.id,
  brandId: r.brand_id,
  question: r.question,
  intent: r.intent,
  category: r.category,
  engine: r.engine,
  locale: r.locale,
  regionCountry: r.region_country,
  regionDetail: r.region_detail,
  enabled: r.enabled === 1,
  source: r.source,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
  archivedAt: r.archived_at,
  createdByName: r.created_by_name,
});

async function loadBrand(c: Context<AppEnv>, orgId: string) {
  const brandId = assertUuid(c.req.param("brandId"), "Marca");
  const brand = await c.env.DB.prepare("SELECT id, name, domain, default_locale FROM brands WHERE organization_id = ? AND id = ?")
    .bind(orgId, brandId)
    .first<{ id: string; name: string; domain: string | null; default_locale: string }>();
  if (!brand) throw notFound("Marca");
  return brand;
}

async function usage(db: D1Database, orgId: string) {
  const plan = await orgPlan(db, orgId);
  const limit = plan.limits.trackedPrompts ?? GEO_PROMPT_LIMITS[plan.code] ?? GEO_PROMPT_LIMITS.free!;
  const r = await db.prepare("SELECT COUNT(*) AS n FROM tracked_prompts WHERE organization_id = ? AND archived_at IS NULL").bind(orgId).first<{ n: number }>();
  return { used: r?.n ?? 0, limit, plan: plan.code };
}

const SELECT_ROWS = `SELECT p.*, u.name AS created_by_name FROM tracked_prompts p LEFT JOIN users u ON u.id = p.created_by
  WHERE p.organization_id = ? AND p.brand_id = ?`;

const catalog = () => ({
  engines: GEO_ENGINES,
  intents: GEO_INTENTS.map((k) => ({ key: k, label: GEO_INTENT_LABEL[k] })),
  categories: GEO_CATEGORIES.map((k) => ({ key: k, label: GEO_CATEGORY_LABEL[k] })),
});

geo.get("/brands/:brandId/geo/prompts", requireScope("brand:read"), async (c) => {
  const t = c.get("tenant");
  const brand = await loadBrand(c, t.orgId);
  const archived = c.req.query("archived") === "1";
  const { results } = await c.env.DB.prepare(`${SELECT_ROWS} AND p.archived_at IS ${archived ? "NOT NULL" : "NULL"} ORDER BY p.created_at DESC, p.question, p.engine LIMIT 2000`)
    .bind(t.orgId, brand.id)
    .all<Row>();
  return c.json({
    brand,
    items: results.map(shape),
    usage: await usage(c.env.DB, t.orgId),
    ...catalog(),
    sampling: await samplingInfo(c, t.orgId, brand.id),
    lastSamples: await lastSamples(c.env.DB, t.orgId, brand.id),
    caveats: GEO_LIBRARY_CAVEATS,
  });
});

geo.post("/brands/:brandId/geo/prompts", requireScope("brand:write"), async (c) => {
  const t = c.get("tenant");
  const brand = await loadBrand(c, t.orgId);
  await rateLimit(c.env.DB, `geo-prompts:${t.orgId}`, 60, 3600);
  const input = await parseBody(c, CreateGeoPromptsInput);

  // Deduplicate inside the request first (same normalized question).
  const seen = new Set<string>();
  const questions = input.questions.filter((q) => {
    const n = normalizeQuestion(q);
    if (seen.has(n)) return false;
    seen.add(n);
    return true;
  });
  const engines = [...new Set(input.engines)];
  const candidates = questions.flatMap((q) => engines.map((engine) => ({ question: q, norm: normalizeQuestion(q), engine })));

  const { results: existing } = await c.env.DB.prepare(
    "SELECT question_norm, engine FROM tracked_prompts WHERE organization_id = ? AND brand_id = ? AND locale = ? AND region_country = ? AND archived_at IS NULL",
  )
    .bind(t.orgId, brand.id, input.locale, input.regionCountry)
    .all<{ question_norm: string; engine: string }>();
  const taken = new Set(existing.map((e) => `${e.question_norm}|${e.engine}`));
  const fresh = candidates.filter((x) => !taken.has(`${x.norm}|${x.engine}`));
  const duplicates = candidates.length - fresh.length;

  const u = await usage(c.env.DB, t.orgId);
  if (u.used + fresh.length > u.limit) {
    throw new ApiError(402, "plan_limit", `Tu plan permite ${u.limit} preguntas activas (pregunta × motor). Tienes ${u.used} y quieres añadir ${fresh.length}. Archiva algunas o cambia de plan.`, {
      reason: "tracked_prompts",
      used: u.used,
      limit: u.limit,
      requested: fresh.length,
    });
  }
  if (!fresh.length) return c.json({ created: 0, duplicates, ids: [] }, 200);

  const now = nowIso();
  const ids = fresh.map(() => uuid());
  // Each insert re-checks the limit inside the same transaction (concurrent requests cannot exceed it)
  // and OR IGNORE relies on the partial unique index for races on the same question.
  const stmts = fresh.map((x, i) =>
    c.env.DB.prepare(
      `INSERT OR IGNORE INTO tracked_prompts (id, organization_id, brand_id, question, question_norm, intent, category, engine, locale, region_country, region_detail, enabled, source, created_by, created_at, updated_at)
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?
       WHERE (SELECT COUNT(*) FROM tracked_prompts WHERE organization_id = ? AND archived_at IS NULL) < ?`,
    ).bind(ids[i], t.orgId, brand.id, x.question, x.norm, input.intent, input.category, x.engine, input.locale, input.regionCountry, input.regionDetail || null, input.source, t.userId, now, now, t.orgId, u.limit),
  );
  const res = await c.env.DB.batch([...stmts]);
  const createdIds = ids.filter((_, i) => (res[i]?.meta.changes ?? 0) > 0);
  if (createdIds.length) {
    await auditStmt(c.env.DB, {
      organizationId: t.orgId,
      actorUserId: t.userId,
      action: "geo.prompts_create",
      entityType: "brand",
      entityId: brand.id,
      after: { created: createdIds.length, questions: questions.length, engines, intent: input.intent, category: input.category, locale: input.locale, regionCountry: input.regionCountry, source: input.source },
      requestId: c.get("requestId"),
    }).run();
  }
  return c.json({ created: createdIds.length, duplicates: duplicates + (fresh.length - createdIds.length), ids: createdIds }, 201);
});

async function loadPrompt(c: Context<AppEnv>, orgId: string, brandId: string) {
  const id = assertUuid(c.req.param("id"), "Pregunta");
  const row = await c.env.DB.prepare(`${SELECT_ROWS} AND p.id = ?`).bind(orgId, brandId, id).first<Row>();
  if (!row) throw notFound("Pregunta");
  return row;
}
const DUPLICATE = () => new ApiError(409, "duplicate_prompt", "Ya existe esa pregunta activa para el mismo motor, idioma y país.");
const isUnique = (e: unknown) => e instanceof Error && /UNIQUE constraint failed/i.test(e.message);

geo.patch("/brands/:brandId/geo/prompts/:id", requireScope("brand:write"), async (c) => {
  const t = c.get("tenant");
  const brand = await loadBrand(c, t.orgId);
  const row = await loadPrompt(c, t.orgId, brand.id);
  if (row.archived_at) throw new ApiError(409, "prompt_archived", "Restaura la pregunta antes de editarla.");
  const input = await parseBody(c, UpdateGeoPromptInput);
  const next = {
    question: input.question ?? row.question,
    intent: input.intent ?? row.intent,
    category: input.category ?? row.category,
    locale: input.locale ?? row.locale,
    region_country: input.regionCountry ?? row.region_country,
    region_detail: input.regionDetail === undefined ? row.region_detail : input.regionDetail || null,
    enabled: input.enabled === undefined ? row.enabled : input.enabled ? 1 : 0,
  };
  const changed = Object.fromEntries(Object.entries(next).filter(([k, v]) => (row as Record<string, unknown>)[k] !== v));
  if (!Object.keys(changed).length) return c.json({ ok: true, changed: [] });
  try {
    await c.env.DB.batch([
      c.env.DB.prepare(
        `UPDATE tracked_prompts SET question = ?, question_norm = ?, intent = ?, category = ?, locale = ?, region_country = ?, region_detail = ?, enabled = ?, updated_at = ?
         WHERE organization_id = ? AND id = ? AND archived_at IS NULL`,
      ).bind(next.question, normalizeQuestion(next.question), next.intent, next.category, next.locale, next.region_country, next.region_detail, next.enabled, nowIso(), t.orgId, row.id),
      auditStmt(c.env.DB, {
        organizationId: t.orgId,
        actorUserId: t.userId,
        action: "geo.prompt_update",
        entityType: "tracked_prompt",
        entityId: row.id,
        before: Object.fromEntries(Object.keys(changed).map((k) => [k, (row as Record<string, unknown>)[k]])),
        after: changed,
        requestId: c.get("requestId"),
      }),
    ]);
  } catch (e) {
    if (isUnique(e)) throw DUPLICATE();
    throw e;
  }
  return c.json({ ok: true, changed: Object.keys(changed) });
});

geo.delete("/brands/:brandId/geo/prompts/:id", requireScope("brand:write"), async (c) => {
  const t = c.get("tenant");
  const brand = await loadBrand(c, t.orgId);
  const row = await loadPrompt(c, t.orgId, brand.id);
  if (row.archived_at) return c.json({ ok: true, archived: true });
  const now = nowIso();
  await c.env.DB.batch([
    c.env.DB.prepare("UPDATE tracked_prompts SET archived_at = ?, enabled = 0, updated_at = ? WHERE organization_id = ? AND id = ? AND archived_at IS NULL").bind(now, now, t.orgId, row.id),
    auditStmt(c.env.DB, { organizationId: t.orgId, actorUserId: t.userId, action: "geo.prompt_archive", entityType: "tracked_prompt", entityId: row.id, before: { question: row.question, engine: row.engine }, requestId: c.get("requestId") }),
  ]);
  return c.json({ ok: true, archived: true });
});

geo.post("/brands/:brandId/geo/prompts/:id/restore", requireScope("brand:write"), async (c) => {
  const t = c.get("tenant");
  const brand = await loadBrand(c, t.orgId);
  const row = await loadPrompt(c, t.orgId, brand.id);
  if (!row.archived_at) return c.json({ ok: true, restored: false });
  const u = await usage(c.env.DB, t.orgId);
  if (u.used >= u.limit) throw new ApiError(402, "plan_limit", `Tu plan permite ${u.limit} preguntas activas y ya tienes ${u.used}.`, { reason: "tracked_prompts", used: u.used, limit: u.limit, requested: 1 });
  let res: D1Result[];
  try {
    res = await c.env.DB.batch([
      c.env.DB.prepare(
        `UPDATE tracked_prompts SET archived_at = NULL, enabled = 1, updated_at = ? WHERE organization_id = ? AND id = ? AND archived_at IS NOT NULL
           AND (SELECT COUNT(*) FROM tracked_prompts WHERE organization_id = ? AND archived_at IS NULL) < ?`,
      ).bind(nowIso(), t.orgId, row.id, t.orgId, u.limit),
    ]);
  } catch (e) {
    if (isUnique(e)) throw DUPLICATE();
    throw e;
  }
  if (!res[0]?.meta.changes) throw new ApiError(402, "plan_limit", `Tu plan permite ${u.limit} preguntas activas.`, { reason: "tracked_prompts", used: u.limit, limit: u.limit, requested: 1 });
  await auditStmt(c.env.DB, { organizationId: t.orgId, actorUserId: t.userId, action: "geo.prompt_restore", entityType: "tracked_prompt", entityId: row.id, after: { question: row.question, engine: row.engine }, requestId: c.get("requestId") }).run();
  return c.json({ ok: true, restored: true });
});

/** Export of the ACTIVE library (questions only; no answers exist yet). */
geo.get("/brands/:brandId/geo/prompts/export", requireScope("brand:read"), async (c) => {
  const t = c.get("tenant");
  const brand = await loadBrand(c, t.orgId);
  const format = c.req.query("format") === "json" ? "json" : "csv";
  const { results } = await c.env.DB.prepare(`${SELECT_ROWS} AND p.archived_at IS NULL ORDER BY p.created_at, p.question, p.engine LIMIT 5000`).bind(t.orgId, brand.id).all<Row>();
  const items = results.map(shape);
  const exportedAt = nowIso();
  const fileBase = `geo-prompts-${(brand.domain ?? brand.name).replace(/[^a-z0-9.-]+/gi, "-").toLowerCase()}-${exportedAt.slice(0, 10)}`;
  if (format === "json") {
    c.header("content-disposition", `attachment; filename="${fileBase}.json"`);
    return c.json({ brand: { id: brand.id, name: brand.name, domain: brand.domain }, exportedAt, measurement: "none (prompt library only)", caveats: GEO_LIBRARY_CAVEATS, items });
  }
  const cols = ["question", "intent", "category", "engine", "locale", "regionCountry", "regionDetail", "enabled", "source", "createdAt"] as const;
  const csv = toCsv([...cols], items.map((i) => cols.map((k) => i[k])));
  return c.body(csv, 200, { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="${fileBase}.csv"` });
});

const SuggestInput = z.object({
  locale: GeoLocale.default("es-ES"),
  sector: z.string().trim().max(80).optional(),
  place: z.string().trim().max(80).optional(),
});

/** Human-readable sector from schema.org business types (generic types are ignored). */
const GENERIC_TYPES = new Set(["Organization", "LocalBusiness", "Corporation", "Thing", "WebSite", "Place"]);
export function sectorFromTypes(value: string | undefined): string | null {
  if (!value) return null;
  const t = value.split(",").map((s) => s.trim()).find((s) => s && !GENERIC_TYPES.has(s));
  return t ? t.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase() : null;
}
/** City-level place from a postal address: never the street. */
export function placeFromAddress(value: string | undefined): string | null {
  if (!value) return null;
  const parts = value.split(",").map((s) => s.trim()).filter(Boolean);
  return parts.slice(1).find((p) => !/\d/.test(p) && p.length > 2) ?? null;
}

geo.post("/brands/:brandId/geo/suggestions", requireScope("brand:read"), async (c) => {
  const t = c.get("tenant");
  const brand = await loadBrand(c, t.orgId);
  await rateLimit(c.env.DB, `geo-suggest:${t.orgId}`, 60, 3600);
  const input = await parseBody(c, SuggestInput);
  const p = await c.env.DB.prepare("SELECT facts_json, audience, competitors_json, confirmed_at FROM brand_profiles WHERE organization_id = ? AND brand_id = ?")
    .bind(t.orgId, brand.id)
    .first<{ facts_json: string; audience: string; competitors_json: string; confirmed_at: string | null }>();
  const facts = parseJson<BrandFact[]>(p?.facts_json, []).filter((f) => f.status !== "rejected");
  const first = (k: string) => facts.find((f) => f.key === k)?.value;
  const derived = {
    brandName: first("name") ?? brand.name,
    sector: sectorFromTypes(first("industry")),
    place: first("area_served") ?? placeFromAddress(first("address")),
    offerings: [...new Set(facts.filter((f) => f.key === "offering").map((f) => f.value))],
    competitors: parseJson<string[]>(p?.competitors_json, []),
    audience: p?.audience?.trim() || null,
  };
  const used = {
    ...derived,
    sector: input.sector || derived.sector,
    place: input.place || derived.place,
  };
  const r = suggestGeoPrompts({ ...used, locale: input.locale });
  return c.json({
    ...r,
    inputs: used,
    profile: { exists: Boolean(p), confirmed: Boolean(p?.confirmed_at) },
    note: "Plantillas deterministas a partir del perfil de marca: no se ha usado IA ni se ha guardado nada. Revisa y edita antes de añadirlas.",
  });
});

// ---------------------------------------------------------------------------------------------
// Monitor (Gemini API, free tier): run a sampling job, read samples and the observed visibility.

async function samplingInfo(c: Context<AppEnv>, orgId: string, brandId: string) {
  const ready = geoSamplingReady(c.env);
  const lim = geoLimits(c.env);
  const [quota, active, last] = await Promise.all([
    geoQuotaToday(c.env.DB, orgId),
    c.env.DB.prepare("SELECT id, state, progress FROM jobs WHERE organization_id = ? AND kind = 'geo_sample' AND brand_id = ? AND state IN ('queued','validating','running') ORDER BY created_at DESC LIMIT 1")
      .bind(orgId, brandId)
      .first<{ id: string; state: string; progress: number }>(),
    c.env.DB.prepare("SELECT id, state, output_json, failure_code, finished_at FROM jobs WHERE organization_id = ? AND kind = 'geo_sample' AND brand_id = ? AND state IN ('completed','failed','cancelled') ORDER BY created_at DESC LIMIT 1")
      .bind(orgId, brandId)
      .first<{ id: string; state: string; output_json: string | null; failure_code: string | null; finished_at: string | null }>(),
  ]);
  return {
    active: ready,
    engine: "gemini_api",
    model: geoModel(c.env),
    fallbackModel: geoFallbackModel(c.env),
    tier: "free",
    reason: ready ? "Muestreo con Gemini por API oficial (nivel gratuito)." : "El muestreo con Gemini no está configurado en este entorno.",
    perRun: lim.perRun,
    dailyOrgLimit: lim.orgDaily,
    usedToday: Math.min(quota.org, lim.orgDaily),
    platformExhausted: quota.global >= lim.globalDaily,
    activeJob: active ?? null,
    lastJob: last ? { id: last.id, state: last.state, failureCode: last.failure_code, finishedAt: last.finished_at, output: parseJson(last.output_json, null) } : null,
  };
}

type SampleRow = {
  id: string;
  prompt_id: string;
  status: string;
  error_code: string | null;
  brand_mentioned: number | null;
  brand_mention_count: number | null;
  brand_cited: number | null;
  sampled_at: string;
};
async function lastSamples(db: D1Database, orgId: string, brandId: string) {
  const { results } = await db
    .prepare(
      `SELECT s.id, s.prompt_id, s.status, s.error_code, s.brand_mentioned, s.brand_mention_count, s.brand_cited, s.sampled_at FROM ai_response_samples s
       WHERE s.organization_id = ? AND s.brand_id = ? AND s.sampled_at = (SELECT MAX(x.sampled_at) FROM ai_response_samples x WHERE x.organization_id = s.organization_id AND x.prompt_id = s.prompt_id)`,
    )
    .bind(orgId, brandId)
    .all<SampleRow>();
  return Object.fromEntries(
    results.map((r) => [
      r.prompt_id,
      { id: r.id, status: r.status, errorCode: r.error_code, mentioned: r.brand_mentioned === null ? null : r.brand_mentioned === 1, mentionCount: r.brand_mention_count, cited: r.brand_cited === null ? null : r.brand_cited === 1, sampledAt: r.sampled_at },
    ]),
  );
}

geo.post("/brands/:brandId/geo/sample", requireScope("brand:write"), async (c) => {
  const t = c.get("tenant");
  const db = c.env.DB;
  const brand = await loadBrand(c, t.orgId);
  if (!geoSamplingReady(c.env)) throw new ApiError(409, "geo_sampling_not_configured", "El muestreo con Gemini no está configurado.");
  const n = await db
    .prepare("SELECT COUNT(*) AS n FROM tracked_prompts WHERE organization_id = ? AND brand_id = ? AND engine = 'gemini_api' AND enabled = 1 AND archived_at IS NULL")
    .bind(t.orgId, brand.id)
    .first<{ n: number }>();
  if (!n?.n) throw new ApiError(409, "geo_no_prompts", "Añade y activa al menos una pregunta con el motor «Gemini (API)».");
  const active = await db
    .prepare("SELECT id, state FROM jobs WHERE organization_id = ? AND kind = 'geo_sample' AND brand_id = ? AND state IN ('queued','validating','running') LIMIT 1")
    .bind(t.orgId, brand.id)
    .first<{ id: string; state: string }>();
  if (active) return c.json({ jobId: active.id, state: active.state, alreadyQueued: true }, 200);
  const lim = geoLimits(c.env);
  const quota = await geoQuotaToday(db, t.orgId);
  if (quota.org >= lim.orgDaily) throw new ApiError(429, "geo_daily_cap", `Hoy ya se han hecho ${lim.orgDaily} muestras en esta organización (tope del nivel gratuito). Vuelve mañana.`, { reason: "org_daily", limit: lim.orgDaily });
  if (quota.global >= lim.globalDaily) throw new ApiError(429, "geo_daily_cap", "Se ha alcanzado el tope diario de muestras gratuitas de la plataforma. Vuelve mañana.", { reason: "platform_daily" });
  await rateLimit(db, `geo-sample:${t.orgId}`, 6, 3600);
  const jobId = uuid();
  const outboxId = uuid();
  await db.batch([
    db
      .prepare("INSERT INTO jobs (id, organization_id, brand_id, kind, idempotency_key, input_json, cost_estimate, actor_user_id) VALUES (?, ?, ?, 'geo_sample', ?, ?, 0, ?)")
      .bind(jobId, t.orgId, brand.id, `geo-sample-${jobId}`, JSON.stringify({ brandId: brand.id }), t.userId),
    db.prepare("INSERT INTO outbox_events (id, organization_id, topic, payload_json, dedupe_key) VALUES (?, ?, 'jobs', ?, ?)").bind(outboxId, t.orgId, JSON.stringify({ jobId, organizationId: t.orgId, outboxId }), `job:${jobId}`),
    db.prepare("INSERT INTO job_events (id, organization_id, job_id, level, kind, message) VALUES (?, ?, ?, 'info', 'queued', ?)").bind(uuid(), t.orgId, jobId, "En cola: muestrear respuestas de Gemini"),
    auditStmt(db, { organizationId: t.orgId, actorUserId: t.userId, action: "geo.sample_run", entityType: "job", entityId: jobId, after: { brandId: brand.id, engine: "gemini_api", model: geoModel(c.env), prompts: n.n }, requestId: c.get("requestId") }),
  ]);
  await dispatchOutbox(c.env, c.get("deps"), (pr) => c.executionCtx.waitUntil(pr), [outboxId]);
  return c.json({ jobId, state: "queued" }, 202);
});

geo.get("/brands/:brandId/geo/samples", requireScope("brand:read"), async (c) => {
  const t = c.get("tenant");
  const brand = await loadBrand(c, t.orgId);
  const promptId = c.req.query("promptId");
  const limit = Math.max(1, Math.min(100, Number(c.req.query("limit") ?? 20) || 20));
  const { results } = await c.env.DB.prepare(
    `SELECT id, prompt_id, engine, model, model_version, grounded, method, question, locale, region_country, region_detail, status, error_code, answer_text, answer_truncated,
       citations_json, search_queries_json, brand_mentioned, brand_mention_count, brand_cited, competitors_json, input_tokens, output_tokens, latency_ms, sampled_at
     FROM ai_response_samples WHERE organization_id = ? AND brand_id = ? ${promptId ? "AND prompt_id = ?" : ""} ORDER BY sampled_at DESC LIMIT ?`,
  )
    .bind(...(promptId ? [t.orgId, brand.id, assertUuid(promptId, "Pregunta"), limit] : [t.orgId, brand.id, limit]))
    .all<Record<string, unknown> & { citations_json: string; search_queries_json: string; competitors_json: string }>();
  return c.json({
    items: results.map(({ citations_json, search_queries_json, competitors_json, ...r }) => ({
      ...r,
      grounded: r.grounded === 1,
      answer_truncated: r.answer_truncated === 1,
      brand_mentioned: r.brand_mentioned === null ? null : r.brand_mentioned === 1,
      brand_cited: r.brand_cited === null ? null : r.brand_cited === 1,
      citations: parseJson(citations_json, []),
      searchQueries: parseJson(search_queries_json, []),
      competitors: parseJson(competitors_json, []),
    })),
    measurement: "observed_sample",
    caveats: GEO_LIBRARY_CAVEATS,
  });
});

/** Observed visibility: latest successful sample of each active prompt in the last 30 days. */
/** Comparable GEO visibility of a brand: last correct sample per prompt (30 days), with 95 % Wilson intervals. */
export async function geoVisibility(env: Env, orgId: string, brand: { id: string; name: string }) {
  const since = new Date(Date.now() - 30 * 86_400_000).toISOString();
  const { results } = await env.DB.prepare(
    `SELECT s.id, s.prompt_id, p.question, p.intent, p.category, s.engine, s.model, s.grounded, s.brand_mentioned, s.brand_cited, s.competitors_json, s.sampled_at FROM ai_response_samples s
     JOIN tracked_prompts p ON p.organization_id = s.organization_id AND p.id = s.prompt_id AND p.archived_at IS NULL
     WHERE s.organization_id = ? AND s.brand_id = ? AND s.status = 'ok' AND s.sampled_at >= ?
       AND s.sampled_at = (SELECT MAX(x.sampled_at) FROM ai_response_samples x WHERE x.organization_id = s.organization_id AND x.prompt_id = s.prompt_id AND x.status = 'ok')
     ORDER BY p.created_at, p.question`,
  )
    .bind(orgId, brand.id, since)
    .all<VisRow>();
  const n = results.length;
  const rate = (k: number) => (n ? k / n : null);
  const mentioned = results.filter((r) => r.brand_mentioned === 1).length;
  const cited = results.filter((r) => r.brand_cited === 1).length;
  // Citations only exist when the answer used search: the rate is over grounded samples only.
  const grounded = results.filter((r) => r.grounded === 1).length;
  // The models that actually answered (the fallback may have answered instead of the main model).
  const models = [...new Set(results.map((r) => r.model))].sort();
  const byIntent = GEO_INTENTS.map((intent) => {
    const rows = results.filter((r) => r.intent === intent);
    const m = rows.filter((r) => r.brand_mentioned === 1).length;
    return { intent, label: GEO_INTENT_LABEL[intent], sampled: rows.length, mentioned: m, interval: wilsonInterval(m, rows.length) };
  });
  const comp = new Map<string, { name: string; domain: string | null; mentioned: number; cited: number }>();
  for (const r of results) {
    for (const x of parseJson<Array<{ name: string; domain: string | null; mentioned: boolean; cited: boolean }>>(r.competitors_json, [])) {
      const key = x.domain ?? x.name;
      const cur = comp.get(key) ?? { name: x.name, domain: x.domain, mentioned: 0, cited: 0 };
      cur.mentioned += x.mentioned ? 1 : 0;
      cur.cited += x.cited ? 1 : 0;
      comp.set(key, cur);
    }
  }
  const dates = results.map((r) => r.sampled_at).sort();
  return {
    rows: results,
    summary: {
      brand: { id: brand.id, name: brand.name },
      sampledPrompts: n,
      mentioned,
      cited,
      mentionRate: rate(mentioned),
      mentionRateInterval: wilsonInterval(mentioned, n),
      intervalMethod: "Intervalo de Wilson al 95 % sobre las preguntas muestreadas (no sobre todas las búsquedas reales).",
      groundedSamples: grounded,
      models,
      citationRate: grounded ? cited / grounded : null,
      byIntent,
      competitors: [...comp.values()].map((x) => ({ ...x, mentionRate: rate(x.mentioned), interval: wilsonInterval(x.mentioned, n) })).sort((a, b) => b.mentioned - a.mentioned),
      period: n ? { from: dates[0]!, to: dates[n - 1]! } : null,
      source: `Gemini API (${models.join(", ") || geoModel(env)}, nivel gratuito; ${grounded} de ${n} con búsqueda de Google)`,
      measurement: "observed_sample",
      observedAt: dates[n - 1] ?? null,
      caveats: GEO_VISIBILITY_CAVEATS,
    },
  };
}
type VisRow = {
  id: string;
  prompt_id: string;
  question: string;
  intent: GeoIntent;
  category: GeoCategory;
  engine: string;
  model: string;
  grounded: number;
  brand_mentioned: number;
  brand_cited: number;
  competitors_json: string;
  sampled_at: string;
};

geo.get("/brands/:brandId/geo/visibility", requireScope("brand:read"), async (c) => {
  const t = c.get("tenant");
  const brand = await loadBrand(c, t.orgId);
  return c.json((await geoVisibility(c.env, t.orgId, brand)).summary);
});

const ORG_LD_TYPES = /^(Organization|Corporation|LocalBusiness|ProfessionalService|OnlineBusiness|OnlineStore|NGO|EducationalOrganization)$/;

/** Explainable recommendations: observed gap → page/action, with evidence and limitations. Deterministic, no AI cost. */
export async function geoRecommendations(env: Env, orgId: string, brand: { id: string; name: string }) {
  const db = env.DB;
  const vis = await geoVisibility(env, orgId, brand);
  const crawl = await db
    .prepare(
      `SELECT w.id, w.llms_txt_found, w.completed_at, s.origin FROM web_crawls w JOIN sites s ON s.organization_id = w.organization_id AND s.id = w.site_id
       WHERE w.organization_id = ? AND s.brand_id = ? AND w.status = 'completed' ORDER BY w.completed_at DESC LIMIT 1`,
    )
    .bind(orgId, brand.id)
    .first<{ id: string; llms_txt_found: number; completed_at: string; origin: string }>();
  const pages = crawl
    ? (
        await db
          .prepare("SELECT final_url, title, h1, metadata_json FROM crawl_pages WHERE organization_id = ? AND crawl_id = ? AND status_code = 200 ORDER BY final_url LIMIT 500")
          .bind(orgId, crawl.id)
          .all<{ final_url: string; title: string | null; h1: string | null; metadata_json: string }>()
      ).results
    : [];
  const hasOrgLd = pages.some((p) => parseJson<{ jsonLdTypes?: string[] }>(p.metadata_json, {}).jsonLdTypes?.some((x) => ORG_LD_TYPES.test(x)));
  const items = buildGeoRecommendations({
    brandName: brand.name,
    samples: vis.rows.map((r) => ({
      promptId: r.prompt_id,
      question: r.question,
      intent: r.intent,
      category: r.category,
      sampleId: r.id,
      sampledAt: r.sampled_at,
      model: r.model,
      grounded: r.grounded === 1,
      mentioned: r.brand_mentioned === 1,
      cited: r.brand_cited === 1,
      competitorsMentioned: parseJson<Array<{ name: string; mentioned: boolean }>>(r.competitors_json, [])
        .filter((x) => x.mentioned)
        .map((x) => x.name),
    })),
    pages: pages.map((p) => ({ url: p.final_url, title: p.title, h1: p.h1 })),
    site: { origin: crawl?.origin ?? null, llmsTxt: crawl ? crawl.llms_txt_found === 1 : null, organizationJsonLd: crawl && pages.length ? hasOrgLd : null, crawledAt: crawl?.completed_at ?? null },
  });
  return {
    brand: { id: brand.id, name: brand.name },
    items,
    basedOn: { sampledPrompts: vis.summary.sampledPrompts, period: vis.summary.period, models: vis.summary.models, crawlCompletedAt: crawl?.completed_at ?? null, crawledPages: pages.length },
    method: GEO_REC_METHOD,
    measurement: "derived",
    caveats: [
      "Las recomendaciones se deducen de muestras observadas y de la última auditoría de tu web; no son una predicción ni una garantía de menciones.",
      "Revisa cada propuesta antes de actuar. Nada se publica automáticamente: los borradores se crean en Contenido y requieren aprobación humana.",
      ...(vis.summary.groundedSamples === 0 && vis.summary.sampledPrompts ? ["Ninguna respuesta usó búsqueda web: reflejan el conocimiento entrenado del modelo, que cambia lentamente."] : []),
    ],
    observedAt: vis.summary.observedAt,
  };
}

geo.get("/brands/:brandId/geo/recommendations", requireScope("brand:read"), async (c) => {
  const t = c.get("tenant");
  const brand = await loadBrand(c, t.orgId);
  return c.json(await geoRecommendations(c.env, t.orgId, brand));
});
