import { Hono } from "hono";
import { AnalyzeInput, CreateBrandInput, validatePublicUrl, UrlBlockedError } from "@dni/core";
import type { AppEnv } from "../env";
import { auditStmt } from "../lib/audit";
import { analysesThisMonth, creditBalance, ensureMonthlyGrant, ledgerStmt, orgPlan } from "../lib/billing";
import { ApiError, assertUuid, notFound, parseBody } from "../lib/http";
import { trackFromRequest } from "../lib/product-events";
import { rateLimit } from "../lib/ratelimit";
import { nowIso, uuid } from "../lib/util";
import { dispatchOutbox } from "../jobs/queue";
import { requireScope } from "../middleware";

/** Brands, URL analysis jobs and job control (mounted under /orgs/:orgId). */
export const work = new Hono<AppEnv>();

work.get("/brands", requireScope("brand:read"), async (c) => {
  const t = c.get("tenant");
  const { results } = await c.env.DB.prepare(
    `SELECT b.id, b.name, b.domain, b.created_at, p.confirmed_at,
       (SELECT origin FROM sites s WHERE s.organization_id = b.organization_id AND s.brand_id = b.id ORDER BY s.created_at DESC LIMIT 1) AS origin
     FROM brands b LEFT JOIN brand_profiles p ON p.organization_id = b.organization_id AND p.brand_id = b.id
     WHERE b.organization_id = ? ORDER BY b.created_at`,
  ).bind(t.orgId).all();
  return c.json({ items: results });
});

work.post("/brands", requireScope("brand:write"), async (c) => {
  const t = c.get("tenant");
  const input = await parseBody(c, CreateBrandInput);
  const plan = await orgPlan(c.env.DB, t.orgId);
  const n = await c.env.DB.prepare("SELECT COUNT(*) AS n FROM brands WHERE organization_id = ?").bind(t.orgId).first<{ n: number }>();
  if ((n?.n ?? 0) >= plan.limits.brands) throw new ApiError(402, "plan_limit", `Tu plan ${plan.name} permite ${plan.limits.brands} marca(s).`);
  const id = uuid();
  await c.env.DB.batch([
    c.env.DB.prepare("INSERT INTO brands (id, organization_id, name, domain) VALUES (?, ?, ?, ?)").bind(id, t.orgId, input.name, input.domain ?? null),
    auditStmt(c.env.DB, { organizationId: t.orgId, actorUserId: t.userId, action: "brand.create", entityType: "brand", entityId: id, after: input, requestId: c.get("requestId") }),
  ]);
  return c.json({ id }, 201);
});

export const MAX_ACTIVE_JOBS = 2;

/**
 * POST /sites/analyze — validates the URL synchronously (SSRF policy), checks plan quota and credits,
 * then commits brand/site + job + credit reservation + outbox row in ONE atomic batch.
 * Idempotency-Key header makes retries from the client safe.
 */
work.post("/sites/analyze", requireScope("site:analyze"), async (c) => {
  const t = c.get("tenant");
  const db = c.env.DB;
  await rateLimit(db, `analyze:${t.orgId}`, 20, 3600);
  const input = await parseBody(c, AnalyzeInput);
  const idemHeader = c.req.header("idempotency-key");
  if (idemHeader && !/^[A-Za-z0-9_-]{8,80}$/.test(idemHeader)) throw new ApiError(400, "invalid_idempotency_key", "Idempotency-Key no válida.");
  const idempotencyKey = idemHeader ?? uuid();

  const existing = await db.prepare("SELECT id, state FROM jobs WHERE organization_id = ? AND idempotency_key = ?").bind(t.orgId, idempotencyKey).first<{ id: string; state: string }>();
  if (existing) return c.json({ jobId: existing.id, state: existing.state, idempotentReplay: true }, 200);

  let url: URL;
  try {
    url = validatePublicUrl(input.url);
  } catch (e) {
    if (e instanceof UrlBlockedError) {
      throw new ApiError(422, "url_blocked", "Esta URL no se puede analizar: solo se permiten sitios web públicos (http/https).", { reason: e.reason });
    }
    throw e;
  }

  const plan = await orgPlan(db, t.orgId);
  await ensureMonthlyGrant(db, t.orgId, plan);
  if ((await analysesThisMonth(db, t.orgId)) >= plan.limits.analysesPerMonth) {
    throw new ApiError(402, "plan_limit", `Has usado los ${plan.limits.analysesPerMonth} análisis de tu plan ${plan.name} este mes.`);
  }
  // Fairness: at most MAX_ACTIVE_JOBS concurrent analyses per organization.
  const active = await db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE organization_id = ? AND kind = 'site_analysis' AND state IN ('queued','validating','running')").bind(t.orgId).first<{ n: number }>();
  if ((active?.n ?? 0) >= MAX_ACTIVE_JOBS) throw new ApiError(429, "too_many_active_jobs", `Ya tienes ${MAX_ACTIVE_JOBS} análisis en curso. Espera a que termine alguno.`);
  const reserve = plan.limits.pagesPerCrawl;
  if ((await creditBalance(db, t.orgId)) < reserve) throw new ApiError(402, "insufficient_credits", "No tienes créditos suficientes para este análisis.");

  // Resolve or create the brand (tenant-scoped; a foreign brandId simply isn't found).
  let brandId = input.brandId ?? null;
  const stmts: D1PreparedStatement[] = [];
  if (brandId) {
    const b = await db.prepare("SELECT id FROM brands WHERE organization_id = ? AND id = ?").bind(t.orgId, brandId).first();
    if (!b) throw notFound("Marca");
  } else {
    const site = await db.prepare("SELECT brand_id FROM sites WHERE organization_id = ? AND origin = ?").bind(t.orgId, url.origin).first<{ brand_id: string }>();
    if (site) brandId = site.brand_id;
    else {
      const count = await db.prepare("SELECT COUNT(*) AS n FROM brands WHERE organization_id = ?").bind(t.orgId).first<{ n: number }>();
      if ((count?.n ?? 0) >= plan.limits.brands) throw new ApiError(402, "plan_limit", `Tu plan ${plan.name} permite ${plan.limits.brands} marca(s). Elige una marca existente.`);
      brandId = uuid();
      stmts.push(db.prepare("INSERT INTO brands (id, organization_id, name, domain) VALUES (?, ?, ?, ?)").bind(brandId, t.orgId, input.brandName ?? url.hostname.replace(/^www\./, ""), url.hostname));
    }
  }
  const siteRow = await db.prepare("SELECT id FROM sites WHERE organization_id = ? AND origin = ?").bind(t.orgId, url.origin).first<{ id: string }>();
  const siteId = siteRow?.id ?? uuid();
  if (!siteRow) stmts.push(db.prepare("INSERT INTO sites (id, organization_id, brand_id, url, origin) VALUES (?, ?, ?, ?, ?)").bind(siteId, t.orgId, brandId, url.toString(), url.origin));

  const jobId = uuid();
  const outboxId = uuid();
  stmts.push(
    db
      .prepare("INSERT INTO jobs (id, organization_id, brand_id, kind, idempotency_key, input_json, cost_estimate, actor_user_id) VALUES (?, ?, ?, 'site_analysis', ?, ?, ?, ?)")
      .bind(jobId, t.orgId, brandId, idempotencyKey, JSON.stringify({ url: url.toString(), brandId, siteId }), reserve, t.userId),
    ledgerStmt(db, { orgId: t.orgId, jobId, kind: "reserve", amount: -reserve, category: "site_analysis" }),
    db
      .prepare("INSERT INTO outbox_events (id, organization_id, topic, payload_json, dedupe_key) VALUES (?, ?, 'jobs', ?, ?)")
      .bind(outboxId, t.orgId, JSON.stringify({ jobId, organizationId: t.orgId, outboxId }), `job:${jobId}`),
    db.prepare("INSERT INTO job_events (id, organization_id, job_id, level, kind, message) VALUES (?, ?, ?, 'info', 'queued', ?)").bind(uuid(), t.orgId, jobId, `En cola: análisis público de ${url.origin}`),
    auditStmt(db, { organizationId: t.orgId, actorUserId: t.userId, action: "site.analyze", entityType: "job", entityId: jobId, after: { url: url.toString() }, requestId: c.get("requestId") }),
  );
  try {
    await db.batch(stmts);
  } catch (e) {
    // Concurrent request with the same Idempotency-Key won the race.
    const raced = await db.prepare("SELECT id, state FROM jobs WHERE organization_id = ? AND idempotency_key = ?").bind(t.orgId, idempotencyKey).first<{ id: string; state: string }>();
    if (raced) return c.json({ jobId: raced.id, state: raced.state, idempotentReplay: true }, 200);
    throw e;
  }
  await dispatchOutbox(c.env, c.get("deps"), (p) => c.executionCtx.waitUntil(p), [outboxId]);
  // Product funnel (no URL is stored: only that an analysis started in this organisation).
  await trackFromRequest(c, "audit_started", { organizationId: t.orgId, props: { from: "app" } });
  return c.json({ jobId, brandId, siteId, state: "queued", creditsReserved: reserve }, 202);
});

work.get("/jobs", requireScope("jobs:read"), async (c) => {
  const t = c.get("tenant");
  const { results } = await c.env.DB.prepare(
    "SELECT id, kind, state, progress, attempts, failure_code, created_at, finished_at, json_extract(input_json, '$.url') AS url FROM jobs WHERE organization_id = ? ORDER BY created_at DESC LIMIT 50",
  ).bind(t.orgId).all();
  return c.json({ items: results });
});

work.get("/jobs/:jobId", requireScope("jobs:read"), async (c) => {
  const t = c.get("tenant");
  const jobId = assertUuid(c.req.param("jobId"), "Trabajo");
  const job = await c.env.DB.prepare(
    `SELECT id, kind, state, progress, attempts, max_attempts, failure_code, last_error, retry_after, cost_estimate, cost_actual, output_json,
            json_extract(input_json, '$.url') AS url, created_at, started_at, finished_at, cancel_requested_at, dead_lettered_at
     FROM jobs WHERE organization_id = ? AND id = ?`,
  ).bind(t.orgId, jobId).first<Record<string, unknown> & { output_json: string | null }>();
  if (!job) throw notFound("Trabajo");
  const { results: events } = await c.env.DB.prepare("SELECT level, kind, message, data_redacted_json, created_at FROM job_events WHERE organization_id = ? AND job_id = ? ORDER BY created_at, rowid")
    .bind(t.orgId, jobId)
    .all();
  const { output_json, ...rest } = job;
  return c.json({ job: { ...rest, output: output_json ? JSON.parse(output_json) : null }, events });
});

work.post("/jobs/:jobId/cancel", requireScope("jobs:control"), async (c) => {
  const t = c.get("tenant");
  const jobId = assertUuid(c.req.param("jobId"), "Trabajo");
  const r = await c.env.DB.prepare("UPDATE jobs SET cancel_requested_at = ? WHERE organization_id = ? AND id = ? AND state IN ('queued','validating','running') AND cancel_requested_at IS NULL")
    .bind(nowIso(), t.orgId, jobId)
    .run();
  if (!r.meta.changes) {
    const exists = await c.env.DB.prepare("SELECT state FROM jobs WHERE organization_id = ? AND id = ?").bind(t.orgId, jobId).first();
    if (!exists) throw notFound("Trabajo");
    return c.json({ ok: true, alreadyFinal: true });
  }
  // Queued jobs are cancelled immediately and their credit reservation released.
  await c.env.DB.batch([
    c.env.DB.prepare("UPDATE jobs SET state = 'cancelled', finished_at = ? WHERE organization_id = ? AND id = ? AND state = 'queued'").bind(nowIso(), t.orgId, jobId),
    auditStmt(c.env.DB, { organizationId: t.orgId, actorUserId: t.userId, action: "job.cancel", entityType: "job", entityId: jobId, requestId: c.get("requestId") }),
  ]);
  const job = await c.env.DB.prepare("SELECT state, cost_estimate FROM jobs WHERE organization_id = ? AND id = ?").bind(t.orgId, jobId).first<{ state: string; cost_estimate: number }>();
  if (job?.state === "cancelled" && job.cost_estimate !== 0) await ledgerStmt(c.env.DB, { orgId: t.orgId, jobId, kind: "release", amount: job.cost_estimate, category: "site_analysis" }).run();
  return c.json({ ok: true });
});

/** Retry = a NEW job (new idempotency key) for the same input; the failed job stays as history. */
work.post("/jobs/:jobId/retry", requireScope("site:analyze"), async (c) => {
  const t = c.get("tenant");
  const jobId = assertUuid(c.req.param("jobId"), "Trabajo");
  const job = await c.env.DB.prepare("SELECT state, json_extract(input_json, '$.url') AS url, brand_id FROM jobs WHERE organization_id = ? AND id = ?")
    .bind(t.orgId, jobId)
    .first<{ state: string; url: string; brand_id: string }>();
  if (!job) throw notFound("Trabajo");
  if (job.state !== "failed" && job.state !== "cancelled") throw new ApiError(409, "not_retryable", "Solo se pueden reintentar trabajos fallidos o cancelados.");
  return c.json({ url: job.url, brandId: job.brand_id });
});
