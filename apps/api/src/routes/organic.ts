import { Hono, type Context } from "hono";
import { z } from "zod";
import {
  BacklinkInput,
  classifyIntent,
  contentGap,
  CRAWLER_USER_AGENT,
  extractPage,
  extractTerms,
  findLink,
  gscOpportunities,
  isAllowed,
  normalizeKeyword,
  parseBacklinkCsv,
  parseRobots,
  RULES,
  safeFetch,
  validatePublicUrl,
  type SafeFetchResult,
} from "@dni/core";
import type { AppEnv } from "../env";
import { auditStmt } from "../lib/audit";
import { orgPlan } from "../lib/billing";
import { ApiError, assertUuid, notFound, parseBody } from "../lib/http";
import { rateLimit } from "../lib/ratelimit";
import { nowIso, parseJson, toCsv, uuid } from "../lib/util";
import { requireScope } from "../middleware";

/**
 * F2 organic modules: technical SEO over time (crawl history, comparison, issue workflow),
 * keywords from the customer's own data (Search Console + their pages + public competitor pages),
 * and a backlink tracker that only verifies links the customer lists. No invented volumes.
 */
export const organic = new Hono<AppEnv>();

// ── SEO técnico ─────────────────────────────────────────────────────────────────────────────────
organic.get("/seo/overview", requireScope("audit_results:read"), async (c) => {
  const t = c.get("tenant");
  const { results } = await c.env.DB.prepare(
    `SELECT w.id, w.site_id, s.origin, w.status, w.pages_count, w.health_score, w.robots_found, w.sitemap_found, w.llms_txt_found, w.served_over_https, w.started_at, w.completed_at,
       (SELECT COUNT(*) FROM seo_issues i WHERE i.organization_id = w.organization_id AND i.crawl_id = w.id) AS issues,
       (SELECT COUNT(*) FROM seo_issues i WHERE i.organization_id = w.organization_id AND i.crawl_id = w.id AND i.severity IN ('critical','high')) AS serious,
       (SELECT COUNT(*) FROM seo_issues i WHERE i.organization_id = w.organization_id AND i.crawl_id = w.id AND i.status = 'open') AS open_issues
     FROM web_crawls w JOIN sites s ON s.organization_id = w.organization_id AND s.id = w.site_id
     WHERE w.organization_id = ? AND w.status = 'completed' ORDER BY w.started_at DESC LIMIT 100`,
  )
    .bind(t.orgId)
    .all<Record<string, unknown> & { site_id: string; origin: string }>();
  const sites = new Map<string, { siteId: string; origin: string; crawls: typeof results }>();
  for (const r of results) {
    const s = sites.get(r.site_id) ?? { siteId: r.site_id, origin: r.origin, crawls: [] };
    s.crawls.push(r);
    sites.set(r.site_id, s);
  }
  return c.json({ sites: [...sites.values()], measurement: "observed", source: "Rastreos de DNI Growth (DNIGrowthBot, robots.txt respetado)" });
});

type IssueRow = { id: string; url: string | null; rule_key: string; severity: string; category: string; status: string; priority_score: number };
async function crawlIssues(db: D1Database, orgId: string, crawlId: string) {
  const { results } = await db.prepare("SELECT id, url, rule_key, severity, category, status, priority_score FROM seo_issues WHERE organization_id = ? AND crawl_id = ?").bind(orgId, crawlId).all<IssueRow>();
  return results;
}
async function loadCrawl(db: D1Database, orgId: string, id: string) {
  const r = await db.prepare("SELECT id, site_id, health_score, pages_count, started_at FROM web_crawls WHERE organization_id = ? AND id = ? AND status = 'completed'").bind(orgId, id).first<{ id: string; site_id: string; health_score: number | null; pages_count: number; started_at: string }>();
  if (!r) throw notFound("Auditoría");
  return r;
}

organic.get("/seo/compare", requireScope("audit_results:read"), async (c) => {
  const t = c.get("tenant");
  const cur = await loadCrawl(c.env.DB, t.orgId, assertUuid(c.req.query("crawlId"), "Auditoría"));
  const base = await loadCrawl(c.env.DB, t.orgId, assertUuid(c.req.query("baseId"), "Auditoría"));
  if (cur.site_id !== base.site_id) throw new ApiError(422, "different_site", "Solo se comparan auditorías del mismo sitio.");
  const [a, b] = await Promise.all([crawlIssues(c.env.DB, t.orgId, cur.id), crawlIssues(c.env.DB, t.orgId, base.id)]);
  const k = (i: IssueRow) => `${i.rule_key}|${i.url ?? ""}`;
  const baseKeys = new Set(b.map(k));
  const curKeys = new Set(a.map(k));
  const decorate = (i: IssueRow) => ({ ...i, title: RULES[i.rule_key]?.title ?? i.rule_key });
  return c.json({
    current: cur,
    base,
    healthDelta: cur.health_score !== null && base.health_score !== null ? cur.health_score - base.health_score : null,
    newIssues: a.filter((i) => !baseKeys.has(k(i))).map(decorate),
    resolved: b.filter((i) => !curKeys.has(k(i))).map(decorate),
    persisting: a.filter((i) => baseKeys.has(k(i))).length,
    measurement: "derived",
    caveat: "Una incidencia «resuelta» puede deberse también a que esa URL no se rastreó en la auditoría nueva (límite de páginas del plan).",
  });
});

organic.patch("/seo/issues/:issueId", requireScope("plan:write"), async (c) => {
  const t = c.get("tenant");
  const id = assertUuid(c.req.param("issueId"), "Incidencia");
  const { status } = await parseBody(c, z.strictObject({ status: z.enum(["open", "fixed", "ignored"]) }));
  const r = await c.env.DB.prepare("UPDATE seo_issues SET status = ? WHERE organization_id = ? AND id = ?").bind(status, t.orgId, id).run();
  if (!r.meta.changes) throw notFound("Incidencia");
  await auditStmt(c.env.DB, { organizationId: t.orgId, actorUserId: t.userId, action: "seo.issue_status", entityType: "seo_issue", entityId: id, after: { status }, requestId: c.get("requestId") }).run();
  return c.json({ ok: true });
});

organic.get("/seo/issues.csv", requireScope("audit_results:read"), async (c) => {
  const t = c.get("tenant");
  const crawl = await loadCrawl(c.env.DB, t.orgId, assertUuid(c.req.query("crawlId"), "Auditoría"));
  const rows = (await crawlIssues(c.env.DB, t.orgId, crawl.id)).sort((x, y) => y.priority_score - x.priority_score);
  const csv = toCsv(
    ["regla", "titulo", "severidad", "categoria", "url", "estado", "prioridad", "como_corregir"],
    rows.map((i) => [i.rule_key, RULES[i.rule_key]?.title ?? i.rule_key, i.severity, i.category, i.url ?? "", i.status, i.priority_score, RULES[i.rule_key]?.fix ?? ""]),
  );
  return new Response(csv, { headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="seo-tecnico-${crawl.started_at.slice(0, 10)}.csv"`, "cache-control": "no-store" } });
});

// ── Keywords & competition ─────────────────────────────────────────────────────────────────────
async function ownTexts(db: D1Database, orgId: string): Promise<{ texts: string[]; crawlId: string | null; origin: string | null }> {
  const crawl = await db.prepare("SELECT w.id, s.origin FROM web_crawls w JOIN sites s ON s.organization_id = w.organization_id AND s.id = w.site_id WHERE w.organization_id = ? AND w.status = 'completed' ORDER BY w.started_at DESC LIMIT 1")
    .bind(orgId)
    .first<{ id: string; origin: string }>();
  if (!crawl) return { texts: [], crawlId: null, origin: null };
  const { results } = await db.prepare("SELECT title, description, h1 FROM crawl_pages WHERE organization_id = ? AND crawl_id = ?").bind(orgId, crawl.id).all<{ title: string | null; description: string | null; h1: string | null }>();
  return { texts: results.flatMap((p) => [p.title ?? "", p.description ?? "", p.h1 ?? ""]).filter(Boolean), crawlId: crawl.id, origin: crawl.origin };
}

organic.get("/keywords/overview", requireScope("content:read"), async (c) => {
  const t = c.get("tenant");
  const db = c.env.DB;
  const prop = await db.prepare("SELECT id, site_url, last_sync_at FROM gsc_properties WHERE organization_id = ? AND selected = 1 LIMIT 1").bind(t.orgId).first<{ id: string; site_url: string; last_sync_at: string | null }>();
  const gscRows = prop
    ? (
        await db
          .prepare("SELECT key, clicks, impressions, ctr, position, period_start, period_end, observed_at FROM gsc_top_rows WHERE organization_id = ? AND property_id = ? AND dimension = 'query' ORDER BY impressions DESC LIMIT 200")
          .bind(t.orgId, prop.id)
          .all<{ key: string; clicks: number; impressions: number; ctr: number; position: number; period_start: string; period_end: string; observed_at: string }>()
      ).results
    : [];
  const own = await ownTexts(db, t.orgId);
  const [saved, competitors] = await Promise.all([
    db.prepare("SELECT id, keyword, intent, source, status, target_url, notes, created_at, updated_at FROM keyword_items WHERE organization_id = ? ORDER BY updated_at DESC LIMIT 500").bind(t.orgId).all(),
    db.prepare("SELECT id, url, host, status_code, title, word_count, terms_json, fetched_at FROM competitor_pages WHERE organization_id = ? ORDER BY fetched_at DESC LIMIT 20").bind(t.orgId).all<{ terms_json: string }>(),
  ]);
  return c.json({
    gsc: {
      connected: !!prop,
      property: prop?.site_url ?? null,
      lastSync: prop?.last_sync_at ?? null,
      period: gscRows[0] ? { start: gscRows[0].period_start, end: gscRows[0].period_end } : null,
      rows: gscRows.map((r) => ({ ...r, intent: classifyIntent(r.key), opportunities: gscOpportunities(r) })),
      measurement: "observed",
      note: "Clics, impresiones, CTR y posición media de Google Search Console (tus datos). Las etiquetas de oportunidad e intención son derivadas.",
    },
    site: { origin: own.origin, crawlId: own.crawlId, terms: extractTerms(own.texts, 40), measurement: "observed", note: "Términos más repetidos en títulos, descripciones y H1 de tu última auditoría." },
    saved: saved.results,
    competitors: competitors.results.map(({ terms_json, ...r }) => ({ ...r, gap: contentGap(parseJson(terms_json, [] as Array<{ term: string; count: number }>), own.texts, 20) })),
    unavailable: ["Volumen de búsqueda", "CPC", "Dificultad"],
    unavailableReason: "Requieren un proveedor de datos con licencia (de pago). No los estimamos ni los inventamos.",
  });
});

const KeywordInput = z.strictObject({ keyword: z.string().trim().min(2).max(120), source: z.enum(["manual", "gsc", "competitor", "site"]).default("manual"), targetUrl: z.string().url().max(500).nullable().optional(), notes: z.string().trim().max(500).optional() });
organic.post("/keywords", requireScope("content:write"), async (c) => {
  const t = c.get("tenant");
  const b = await parseBody(c, KeywordInput);
  const norm = normalizeKeyword(b.keyword);
  const count = await c.env.DB.prepare("SELECT COUNT(*) AS n FROM keyword_items WHERE organization_id = ?").bind(t.orgId).first<{ n: number }>();
  if ((count?.n ?? 0) >= 2000) throw new ApiError(402, "plan_limit", "Has llegado al máximo de 2000 keywords guardadas.");
  const id = uuid();
  const now = nowIso();
  const r = await c.env.DB.prepare(
    "INSERT OR IGNORE INTO keyword_items (id, organization_id, keyword, keyword_norm, intent, source, target_url, notes, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  )
    .bind(id, t.orgId, b.keyword, norm, classifyIntent(b.keyword), b.source, b.targetUrl ?? null, b.notes ?? null, t.userId, now, now)
    .run();
  if (!r.meta.changes) throw new ApiError(409, "duplicate", "Esa keyword ya está en tu lista.");
  return c.json({ id }, 201);
});

const KeywordPatch = z.strictObject({ status: z.enum(["idea", "planned", "covered", "discarded"]).optional(), intent: z.enum(["informational", "commercial", "transactional", "navigational", "unclear"]).optional(), targetUrl: z.string().url().max(500).nullable().optional(), notes: z.string().trim().max(500).nullable().optional() });
organic.patch("/keywords/:id", requireScope("content:write"), async (c) => {
  const t = c.get("tenant");
  const id = assertUuid(c.req.param("id"), "Keyword");
  const b = await parseBody(c, KeywordPatch);
  const sets = (
    [
      ["status", b.status],
      ["intent", b.intent],
      ["target_url", b.targetUrl],
      ["notes", b.notes],
    ] as Array<[string, unknown]>
  ).filter(([, v]) => v !== undefined);
  if (!sets.length) return c.json({ ok: true });
  const setClause = sets.map(([k]) => k + " = ?").join(", ");
  const r = await c.env.DB.prepare(`UPDATE keyword_items SET ${setClause}, updated_at = ? WHERE organization_id = ? AND id = ?`).bind(...sets.map(([, v]) => v ?? null), nowIso(), t.orgId, id).run();
  if (!r.meta.changes) throw notFound("Keyword");
  return c.json({ ok: true });
});

organic.delete("/keywords/:id", requireScope("content:write"), async (c) => {
  const t = c.get("tenant");
  const r = await c.env.DB.prepare("DELETE FROM keyword_items WHERE organization_id = ? AND id = ?").bind(t.orgId, assertUuid(c.req.param("id"), "Keyword")).run();
  if (!r.meta.changes) throw notFound("Keyword");
  return c.json({ ok: true });
});

organic.get("/keywords.csv", requireScope("content:read"), async (c) => {
  const t = c.get("tenant");
  const { results } = await c.env.DB.prepare("SELECT keyword, intent, source, status, target_url, notes, created_at FROM keyword_items WHERE organization_id = ? ORDER BY keyword").bind(t.orgId).all<Record<string, unknown>>();
  const csv = toCsv(["keyword", "intencion_heuristica", "origen", "estado", "url_objetivo", "notas", "creada", "volumen"], results.map((r) => [r.keyword, r.intent, r.source, r.status, r.target_url, r.notes, r.created_at, "no disponible"]));
  return new Response(csv, { headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": 'attachment; filename="keywords.csv"', "cache-control": "no-store" } });
});

/** Fetches ONE public page if robots.txt allows our bot. Returns null + reason otherwise. */
async function politeFetch(c: Context<AppEnv>, rawUrl: string): Promise<{ res: SafeFetchResult | null; blocked: string | null }> {
  const deps = c.get("deps");
  const url = validatePublicUrl(rawUrl);
  const opts = { resolve: deps.resolve, fetchImpl: deps.fetchImpl, timeoutMs: 10_000, maxBytes: 1_500_000 };
  try {
    const robots = await safeFetch(`${url.origin}/robots.txt`, { ...opts, accept: "text/plain", maxBytes: 200_000 }).catch(() => null);
    if (robots && robots.status === 200 && !isAllowed(parseRobots(robots.body), CRAWLER_USER_AGENT, url.pathname + url.search)) return { res: null, blocked: "robots" };
    return { res: await safeFetch(url.toString(), opts), blocked: null };
  } catch (e) {
    return { res: null, blocked: e instanceof Error && e.name === "UrlBlockedError" ? "unsafe_url" : "fetch_error" };
  }
}

organic.post("/keywords/competitors", requireScope("content:write"), async (c) => {
  const t = c.get("tenant");
  const { url } = await parseBody(c, z.strictObject({ url: z.string().trim().url().max(500) }));
  await rateLimit(c.env.DB, `competitor:${t.orgId}`, 30, 86_400);
  let parsed: URL;
  try {
    parsed = validatePublicUrl(url);
  } catch {
    throw new ApiError(422, "unsafe_url", "Esa dirección no es pública o no está permitida.");
  }
  const { res, blocked } = await politeFetch(c, parsed.toString());
  if (blocked === "robots") throw new ApiError(422, "robots_disallow", "El robots.txt de esa web no permite a nuestro rastreador leer esa página. La respetamos.");
  if (!res) throw new ApiError(422, "fetch_failed", "No se pudo leer esa página (no responde, no es pública o no es HTML).");
  if (!/html/i.test(res.contentType)) throw new ApiError(422, "not_html", "La dirección no devuelve una página HTML.");
  const page = extractPage(res.body, res.finalUrl);
  const headings = [...page.h1, ...page.h2, ...page.h3].slice(0, 60);
  const terms = extractTerms([page.title ?? "", page.metaDescription ?? "", ...headings, page.textSample], 80);
  const id = uuid();
  await c.env.DB.prepare(
    `INSERT INTO competitor_pages (id, organization_id, url, host, status_code, title, description, headings_json, terms_json, word_count, json_ld_types, fetched_at, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(organization_id, url) DO UPDATE SET status_code = excluded.status_code, title = excluded.title, description = excluded.description, headings_json = excluded.headings_json, terms_json = excluded.terms_json, word_count = excluded.word_count, json_ld_types = excluded.json_ld_types, fetched_at = excluded.fetched_at`,
  )
    .bind(id, t.orgId, res.finalUrl, new URL(res.finalUrl).host, res.status, page.title, page.metaDescription, JSON.stringify(headings), JSON.stringify(terms), page.wordCount, page.jsonLdTypes.join(","), nowIso(), t.userId)
    .run();
  const own = await ownTexts(c.env.DB, t.orgId);
  return c.json({ url: res.finalUrl, title: page.title, headings, terms: terms.slice(0, 30), gap: contentGap(terms, own.texts, 25), comparedWith: own.origin, measurement: "observed", caveat: "Una sola página pública leída hoy; el contenido externo se trata como datos, nunca como instrucciones." }, 201);
});

organic.delete("/keywords/competitors/:id", requireScope("content:write"), async (c) => {
  const t = c.get("tenant");
  await c.env.DB.prepare("DELETE FROM competitor_pages WHERE organization_id = ? AND id = ?").bind(t.orgId, assertUuid(c.req.param("id"), "Competidor")).run();
  return c.json({ ok: true });
});

// ── Backlinks / Authority ───────────────────────────────────────────────────────────────────────
async function backlinkLimit(db: D1Database, orgId: string) {
  const plan = await orgPlan(db, orgId);
  const limit = (plan.limits as { backlinks?: number }).backlinks ?? 50;
  const used = (await db.prepare("SELECT COUNT(*) AS n FROM backlinks WHERE organization_id = ?").bind(orgId).first<{ n: number }>())?.n ?? 0;
  return { used, limit };
}

organic.get("/backlinks", requireScope("audit_results:read"), async (c) => {
  const t = c.get("tenant");
  const { results } = await c.env.DB.prepare(
    "SELECT id, source_url, source_host, target_url, anchor_expected, status, rel, anchor_found, http_status, last_checked_at, first_live_at, notes, origin, created_at FROM backlinks WHERE organization_id = ? ORDER BY created_at DESC LIMIT 1000",
  )
    .bind(t.orgId)
    .all<{ status: string; rel: string | null; source_host: string }>();
  const by = (s: string) => results.filter((r) => r.status === s).length;
  return c.json({
    items: results,
    summary: { total: results.length, live: by("live"), lost: by("lost"), unverified: by("unverified"), errors: by("error") + by("blocked"), nofollow: results.filter((r) => r.status === "live" && /nofollow|sponsored|ugc/.test(r.rel ?? "")).length, domains: new Set(results.map((r) => r.source_host)).size },
    usage: await backlinkLimit(c.env.DB, t.orgId),
    measurement: "observed",
    note: "Solo los enlaces que tú añades o importas, comprobados leyendo la página de origen. No es un índice de toda la web.",
  });
});

organic.post("/backlinks", requireScope("content:write"), async (c) => {
  const t = c.get("tenant");
  const body = await parseBody(c, z.union([z.strictObject({ csv: z.string().max(200_000) }), BacklinkInput]));
  const parsed = "csv" in body ? parseBacklinkCsv(body.csv) : { rows: [body], errors: [] };
  const u = await backlinkLimit(c.env.DB, t.orgId);
  const room = Math.max(0, u.limit - u.used);
  if (!room) throw new ApiError(402, "plan_limit", `Tu plan permite ${u.limit} enlaces.`);
  const now = nowIso();
  const rows = parsed.rows.slice(0, room);
  let added = 0;
  for (const r of rows) {
    const res = await c.env.DB.prepare(
      "INSERT OR IGNORE INTO backlinks (id, organization_id, source_url, source_host, target_url, anchor_expected, notes, origin, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
      .bind(uuid(), t.orgId, r.sourceUrl, new URL(r.sourceUrl).host, r.targetUrl, r.anchor ?? null, r.notes ?? null, "csv" in body ? "csv" : "manual", t.userId, now)
      .run();
    added += res.meta.changes ?? 0;
  }
  return c.json({ added, duplicates: rows.length - added, skippedByPlan: parsed.rows.length - rows.length, errors: parsed.errors.slice(0, 20) }, 201);
});

organic.post("/backlinks/check", requireScope("content:write"), async (c) => {
  const t = c.get("tenant");
  const { ids } = await parseBody(c, z.strictObject({ ids: z.array(z.string().uuid()).max(20).optional() }));
  await rateLimit(c.env.DB, `backlink-check:${t.orgId}`, 30, 3600);
  const rows = ids?.length
    ? (await c.env.DB.prepare(`SELECT id, source_url, target_url, status FROM backlinks WHERE organization_id = ? AND id IN (${ids.map(() => "?").join(",")})`).bind(t.orgId, ...ids).all<{ id: string; source_url: string; target_url: string; status: string }>()).results
    : (await c.env.DB.prepare("SELECT id, source_url, target_url, status FROM backlinks WHERE organization_id = ? ORDER BY COALESCE(last_checked_at, '') ASC LIMIT 10").bind(t.orgId).all<{ id: string; source_url: string; target_url: string; status: string }>()).results;
  const out: Array<{ id: string; status: string }> = [];
  for (const r of rows) {
    const { res, blocked } = await politeFetch(c, r.source_url);
    const now = nowIso();
    let status: string;
    let rel: string | null = null;
    let anchor: string | null = null;
    if (blocked) status = blocked === "robots" || blocked === "unsafe_url" ? "blocked" : "error";
    else if (!res || res.status >= 400) status = "error";
    else {
      const f = findLink(extractPage(res.body, res.finalUrl).links, r.target_url);
      status = f.found ? "live" : "lost";
      rel = f.rel;
      anchor = f.anchor;
    }
    await c.env.DB.prepare(
      "UPDATE backlinks SET status = ?, rel = ?, anchor_found = ?, http_status = ?, last_checked_at = ?, first_live_at = CASE WHEN ? = 'live' THEN COALESCE(first_live_at, ?) ELSE first_live_at END WHERE organization_id = ? AND id = ?",
    )
      .bind(status, rel, anchor, res?.status ?? null, now, status, now, t.orgId, r.id)
      .run();
    out.push({ id: r.id, status });
  }
  return c.json({ checked: out.length, results: out });
});

organic.delete("/backlinks/:id", requireScope("content:write"), async (c) => {
  const t = c.get("tenant");
  const r = await c.env.DB.prepare("DELETE FROM backlinks WHERE organization_id = ? AND id = ?").bind(t.orgId, assertUuid(c.req.param("id"), "Enlace")).run();
  if (!r.meta.changes) throw notFound("Enlace");
  return c.json({ ok: true });
});

organic.get("/backlinks.csv", requireScope("audit_results:read"), async (c) => {
  const t = c.get("tenant");
  const { results } = await c.env.DB.prepare("SELECT source_url, target_url, status, rel, anchor_found, http_status, last_checked_at, notes FROM backlinks WHERE organization_id = ? ORDER BY source_host").bind(t.orgId).all<Record<string, unknown>>();
  return new Response(toCsv(["origen", "destino", "estado", "rel", "ancla", "http", "comprobado", "notas"], results.map((r) => Object.values(r))), { headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": 'attachment; filename="backlinks.csv"', "cache-control": "no-store" } });
});

