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
  type BrandFact,
} from "@dni/core";
import type { AppEnv } from "../env";
import { auditStmt } from "../lib/audit";
import { orgPlan } from "../lib/billing";
import { ApiError, assertUuid, notFound, parseBody } from "../lib/http";
import { rateLimit } from "../lib/ratelimit";
import { nowIso, parseJson, uuid } from "../lib/util";
import { requireScope } from "../middleware";

/** GEO prompt library (mounted under /orgs/:orgId). Stores questions only — never AI answers. */
export const geo = new Hono<AppEnv>();

export const GEO_LIBRARY_CAVEATS = [
  "Esta biblioteca define qué preguntas se medirán; todavía no se ha consultado ningún motor de IA y no se muestra ninguna respuesta ni visibilidad.",
  "Cuando se active el muestreo, cada respuesta será una muestra puntual (fecha, motor, idioma y región) y no prueba lo que ve cada usuario real.",
  "Los motores sin API oficial (AI Overviews, app de ChatGPT) no se consultan automáticamente: quedan para revisión manual.",
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
    sampling: { active: false, reason: "El muestreo de respuestas de IA aún no está activo." },
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
  // Spreadsheet formula injection guard: prefix cells that start with = + - @ (or tab/CR).
  const cell = (v: unknown) => {
    let s = v === null || v === undefined ? "" : String(v);
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
    return /[",\n\r;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const csv = String.fromCharCode(0xfeff) + [cols.join(","), ...items.map((i) => cols.map((k) => cell(i[k])).join(","))].join("\r\n") + "\r\n";
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
