import { bareDomain, detectMention, type GeoEntity } from "@dni/core";
import { ApiError } from "../lib/http";
import { GeminiCallError, geoFallbackModel, geoLimits, geoMethod, geoModel, sampleGemini, type GeminiSample } from "../lib/geoGemini";
import { rateLimit } from "../lib/ratelimit";
import { nowIso, parseJson, uuid } from "../lib/util";
import { PermanentJobError, type JobContext } from "./consumer";

const DAY = 86_400;
export const geoGlobalKey = "geo-gemini-global";
/** Short waits before retrying a transient Gemini error (5xx / network) on the same model. */
const RETRY_WAITS_MS = [5_000, 15_000];
export const geoOrgKey = (orgId: string) => `geo-gemini-org:${orgId}`;

/** Counts one call against a daily cap; false when the cap is reached (nothing is called then). */
async function takeQuota(db: D1Database, key: string, limit: number) {
  try {
    await rateLimit(db, key, limit, DAY);
    return true;
  } catch (e) {
    if (e instanceof ApiError && e.status === 429) return false;
    throw e;
  }
}

export async function geoQuotaToday(db: D1Database, orgId: string) {
  const ws = Math.floor(Date.now() / 1000 / DAY) * DAY;
  const read = async (key: string) => (await db.prepare("SELECT count FROM rate_limits WHERE key = ? AND window_start = ?").bind(key, ws).first<{ count: number }>())?.count ?? 0;
  return { org: await read(geoOrgKey(orgId)), global: await read(geoGlobalKey) };
}

/**
 * Samples the brand's enabled Gemini prompts (least recently sampled first) through the official
 * Gemini API on the FREE tier, and stores each real answer with date, model, language, region,
 * sources and detected mentions. Errors are stored as errors; nothing is invented.
 */
export async function runGeoSample(ctx: JobContext, input: { brandId: string }) {
  const { env, deps, job } = ctx;
  const db = env.DB;
  const orgId = job.organization_id;
  const lim = geoLimits(env);
  const model = geoModel(env);
  const fallback = geoFallbackModel(env);
  if (!env.GEMINI_API_KEY || lim.globalDaily === 0) throw new PermanentJobError("gemini_not_configured", "El muestreo con Gemini no está configurado.");

  const brand = await db
    .prepare(
      `SELECT b.id, b.name, b.domain, (SELECT origin FROM sites s WHERE s.organization_id = b.organization_id AND s.brand_id = b.id ORDER BY s.created_at DESC LIMIT 1) AS origin,
         (SELECT competitors_json FROM brand_profiles p WHERE p.organization_id = b.organization_id AND p.brand_id = b.id) AS competitors_json
       FROM brands b WHERE b.organization_id = ? AND b.id = ?`,
    )
    .bind(orgId, input.brandId)
    .first<{ id: string; name: string; domain: string | null; origin: string | null; competitors_json: string | null }>();
  if (!brand) throw new PermanentJobError("brand_not_found", "La marca ya no existe.");
  const me: GeoEntity = { name: brand.name, domain: bareDomain(brand.domain) ?? bareDomain(brand.origin) };
  const competitors: GeoEntity[] = parseJson<string[]>(brand.competitors_json, [])
    .map((c) => bareDomain(c))
    .filter((d): d is string => !!d && d !== me.domain)
    .slice(0, 10)
    .map((d) => ({ name: d.split(".")[0]!, domain: d }));

  // Retries of this job never resample a prompt it already sampled.
  const { results: prompts } = await db
    .prepare(
      `SELECT p.id, p.question, p.locale, p.region_country, p.region_detail,
         (SELECT MAX(s.sampled_at) FROM ai_response_samples s WHERE s.organization_id = p.organization_id AND s.prompt_id = p.id) AS last_at
       FROM tracked_prompts p
       WHERE p.organization_id = ? AND p.brand_id = ? AND p.engine = 'gemini_api' AND p.enabled = 1 AND p.archived_at IS NULL
         AND NOT EXISTS (SELECT 1 FROM ai_response_samples x WHERE x.organization_id = p.organization_id AND x.prompt_id = p.id AND x.job_id = ?)
       ORDER BY last_at IS NOT NULL, last_at, p.created_at LIMIT ?`,
    )
    .bind(orgId, brand.id, job.id, lim.perRun)
    .all<{ id: string; question: string; locale: string; region_country: string; region_detail: string | null }>();
  if (!prompts.length) throw new PermanentJobError("geo_no_prompts", "No hay preguntas activas para Gemini en esta marca.");
  await ctx.event("info", "plan", `Se muestrearán hasta ${prompts.length} pregunta(s) con ${model} (nivel gratuito).`);

  let ok = 0;
  let errors = 0;
  let mentioned = 0;
  let stoppedReason: string | null = null;
  // Search first; if the free tier refuses it for this model, the rest of the run goes without it.
  let grounding = true;
  let transientInARow = 0;
  let stickToFallback = false;
  const modelsUsed = new Set<string>();
  const quota = async () => {
    if ((await takeQuota(db, geoGlobalKey, lim.globalDaily)) && (await takeQuota(db, geoOrgKey(orgId), lim.orgDaily))) return true;
    stoppedReason = "daily_cap";
    await ctx.event("warn", "daily_cap", "Se alcanzó el tope diario de muestras gratuitas; el resto queda para otro día.");
    return false;
  };
  for (const [i, p] of prompts.entries()) {
    await ctx.checkpoint();
    if (!(await quota())) break;
    if (i > 0 && lim.spacingMs) await deps.sleep(lim.spacingMs);
    const started = Date.now();
    const q = { question: p.question, locale: p.locale, country: p.region_country, detail: p.region_detail };
    const attempt = async (withSearch: boolean, m: string): Promise<GeminiSample | GeminiCallError> => {
      try {
        return await sampleGemini(env, deps, q, withSearch, m);
      } catch (e) {
        if (e instanceof GeminiCallError) return e;
        throw e;
      }
    };
    /** null = stop the run (daily cap reached). */
    const tryModel = async (m: string) => {
      let r = await attempt(grounding, m);
      // On the free tier Google refuses search either with a 400 or with a 429 "quota exceeded" (the
      // search quota for that model is zero). Retry the same question once without search: if that
      // also hits the quota, the run stops as a real quota stop below.
      if (r instanceof GeminiCallError && grounding && (r.code === "gemini_grounding_unavailable" || r.code === "gemini_quota")) {
        grounding = false;
        await ctx.event("info", "grounding_off", `La búsqueda de Google no está disponible (o no tiene cuota gratuita) para ${m}: se muestrea sin búsqueda (respuestas sin fuentes).`, { code: r.code, detail: r.detail });
        if (!(await quota())) return null;
        r = await attempt(false, m);
      }
      for (const wait of RETRY_WAITS_MS) {
        if (!(r instanceof GeminiCallError && r.transient)) break;
        await deps.sleep(wait);
        r = await attempt(grounding, m);
      }
      return r;
    };
    let usedModel = stickToFallback && fallback ? fallback : model;
    let res = await tryModel(usedModel);
    if (res === null) break;
    // Overload (5xx) or the main model's own free quota used up: each model has its own free quota.
    if (res instanceof GeminiCallError && (res.transient || res.code === "gemini_quota") && fallback && usedModel !== fallback) {
      await ctx.event("info", "fallback_model", `${model} no responde ahora (${res.code}); se usa ${fallback} (también gratuito) para el resto de esta ejecución.`, { code: res.code, detail: res.detail });
      usedModel = fallback;
      res = await tryModel(fallback);
      if (res === null) break;
      // The main model is overloaded right now: don't spend ~1 min per question re-checking it.
      if (!(res instanceof GeminiCallError)) stickToFallback = true;
    }
    const base = [uuid(), orgId, brand.id, p.id, job.id, "gemini_api", usedModel] as const;
    if (!(res instanceof GeminiCallError)) {
      const s = res;
      const mine = s.status === "ok" ? detectMention(s.text, s.citations, me) : null;
      const comps = s.status === "ok" ? competitors.map((c) => ({ name: c.name, domain: c.domain, ...detectMention(s.text, s.citations, c) })) : [];
      await db
        .prepare(
          `INSERT INTO ai_response_samples (id, organization_id, brand_id, prompt_id, job_id, engine, model, model_version, grounded, method, question, locale, region_country, region_detail,
             status, answer_text, answer_truncated, citations_json, search_queries_json, brand_mentioned, brand_mention_count, brand_cited, competitors_json, input_tokens, output_tokens, latency_ms, sampled_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          ...base,
          s.modelVersion,
          s.grounded ? 1 : 0,
          geoMethod(grounding),
          p.question,
          p.locale,
          p.region_country,
          p.region_detail,
          s.status,
          s.text || null,
          s.truncated ? 1 : 0,
          JSON.stringify(s.citations),
          JSON.stringify(s.searchQueries),
          mine ? (mine.mentioned ? 1 : 0) : null,
          mine ? mine.mentionCount : null,
          mine ? (mine.cited ? 1 : 0) : null,
          JSON.stringify(comps),
          s.inputTokens,
          s.outputTokens,
          Date.now() - started,
          nowIso(),
        )
        .run();
      transientInARow = 0;
      modelsUsed.add(usedModel);
      if (s.status === "ok") ok++;
      else errors++;
      if (mine?.mentioned) mentioned++;
    } else {
      const e = res;
      errors++;
      await db
        .prepare(
          `INSERT INTO ai_response_samples (id, organization_id, brand_id, prompt_id, job_id, engine, model, method, question, locale, region_country, region_detail, status, error_code, latency_ms, sampled_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'error', ?, ?, ?)`,
        )
        .bind(...base, geoMethod(grounding), p.question, p.locale, p.region_country, p.region_detail, e.code, Date.now() - started, nowIso())
        .run();
      await ctx.event("warn", "sample_error", `Gemini devolvió un error (${e.code}).`, { code: e.code, detail: e.detail });
      if (e.permanent && ok === 0) throw new PermanentJobError(e.code, "Gemini rechazó la petición; no se ha muestreado nada.");
      if (e.stopRun) {
        stoppedReason = e.code;
        break;
      }
      // Google is overloaded: stop early instead of spending the daily quota on failures.
      if (e.transient && ++transientInARow >= 3) {
        stoppedReason = "gemini_unavailable";
        await ctx.event("warn", "gemini_unavailable", "Gemini no está respondiendo (servicio saturado); el resto queda para la próxima ejecución.");
        break;
      }
    }
    await ctx.progress(((i + 1) / prompts.length) * 100);
  }
  return { creditsUsed: 0, brandId: brand.id, model, modelsUsed: [...modelsUsed], grounded: grounding, requested: prompts.length, ok, errors, mentioned, stoppedReason };
}
