import { PILLAR_LABEL, scoreBand, teaserOf, UrlBlockedError, validatePublicUrl, type AuditFinding, type Pillar, type PublicAuditResult } from "@dni/core";
import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import type { AppEnv } from "../env";
import { enqueuePublicAudit, PUBLIC_AUDIT_ERRORS } from "../jobs/public-audit";
import { activationFor, SKIPPABLE_STEPS, type ActivationStepKey } from "../lib/activation";
import { auditStmt } from "../lib/audit";
import { ApiError, assertUuid, notFound, parseBody } from "../lib/http";
import { verifyUnsubscribeToken } from "../lib/lifecycle";
import { verifyReportUnsubscribeToken } from "../lib/monthly-report";
import { loadSession } from "../lib/session";
import { trackFromRequest } from "../lib/product-events";
import { rateLimit } from "../lib/ratelimit";
import { SITE_SECURITY_HEADERS } from "../lib/site-headers";
import { hashIp, nowIso, parseJson, uuid } from "../lib/util";
import { requireScope } from "../middleware";

/**
 * Phase 2 (ADR 0023): free audit without an account. Anyone can start one for a public URL (≤5 pages, no
 * AI, no credits), limited per hashed IP and per day for the whole platform, cached 24 h per host. The page
 * /auditoria/{id} shows the scores and the top three problems with their evidence; the rest of the list
 * and the 30-day plan come with a free account, which claims the audit for its organisation.
 */
export const publicAudits = new Hono<AppEnv>();

const ANON_TTL_DAYS = 30;
const CACHE_HOURS = 24;
const IP_PER_HOUR = 6;
const IP_PER_DAY = 20;
const GLOBAL_PER_DAY = 400;

const small = bodyLimit({
  maxSize: 4096,
  onError: () => {
    throw new ApiError(413, "payload_too_large", "Petición demasiado grande.");
  },
});

const StartInput = z.strictObject({ url: z.string().trim().min(3).max(500) });

interface AuditRow {
  id: string;
  url: string;
  host: string;
  status: "queued" | "running" | "completed" | "failed";
  result_json: string | null;
  error_code: string | null;
  compare_of: string | null;
  is_competitor: number;
  claimed_org_id: string | null;
  created_at: string;
  finished_at: string | null;
}

const bareHost = (u: URL) => u.hostname.toLowerCase().replace(/\.$/, "").replace(/^www\./, "");

function sameOrigin(c: Context<AppEnv>) {
  const origin = c.req.header("origin");
  if (origin && origin !== new URL(c.req.url).origin && origin !== c.env.APP_ORIGIN) throw new ApiError(403, "origin_not_allowed", "Origen no permitido.");
}

function parseTarget(raw: string): URL {
  try {
    return validatePublicUrl(raw);
  } catch (e) {
    if (e instanceof UrlBlockedError) throw new ApiError(422, "url_not_allowed", PUBLIC_AUDIT_ERRORS.url_blocked!);
    throw e;
  }
}

/**
 * Creates (or reuses from the 24 h cache) an audit for `target`. A completed audit of the same host is copied
 * into a new row, so every visitor gets their own link and nothing done on one link shows on another.
 */
async function startAudit(c: Context<AppEnv>, target: URL, opts: { compareOf?: string } = {}): Promise<{ id: string; status: string; cached: boolean }> {
  const db = c.env.DB;
  const ipHash = await hashIp(c.env, c.req.header("cf-connecting-ip"));
  const ipKey = ipHash ?? "noip";
  await rateLimit(db, `paudit:ip:${ipKey}`, IP_PER_HOUR, 3600);
  await rateLimit(db, `paudit:ipday:${ipKey}`, IP_PER_DAY, 86400);
  const host = bareHost(target);
  const now = nowIso();
  const expires = new Date(Date.now() + ANON_TTL_DAYS * 86400_000).toISOString();
  const cacheFrom = new Date(Date.now() - CACHE_HOURS * 3600_000).toISOString();
  const cached = await db
    .prepare("SELECT id, status, result_json, finished_at FROM public_audits WHERE host = ? AND created_at > ? AND status IN ('queued', 'running', 'completed') ORDER BY (status = 'completed') DESC, created_at DESC LIMIT 1")
    .bind(host, cacheFrom)
    .first<{ id: string; status: string; result_json: string | null; finished_at: string | null }>();
  const isCompetitor = opts.compareOf ? 1 : 0;
  if (cached?.status === "completed" && cached.result_json) {
    const id = uuid();
    await db
      .prepare(
        `INSERT INTO public_audits (id, url, host, status, ip_hash, result_json, compare_of, is_competitor, attempts, created_at, started_at, finished_at, expires_at)
         VALUES (?, ?, ?, 'completed', ?, ?, ?, ?, 0, ?, ?, ?, ?)`,
      )
      .bind(id, target.toString(), host, ipHash, cached.result_json, opts.compareOf ?? null, isCompetitor, now, now, cached.finished_at ?? now, expires)
      .run();
    return { id, status: "completed", cached: true };
  }
  // Same host still being reviewed: share that run (it has no competitor attached yet).
  if (cached && !opts.compareOf) return { id: cached.id, status: cached.status, cached: true };
  try {
    await rateLimit(db, "paudit:global", GLOBAL_PER_DAY, 86400);
  } catch (e) {
    if (e instanceof ApiError && e.status === 429)
      throw new ApiError(429, "public_audit_daily_cap", "Hoy ya hemos hecho todas las auditorías gratuitas que permitimos. Crea tu cuenta gratis para analizar tu web ahora o vuelve mañana.", e.extra);
    throw e;
  }
  const id = uuid();
  await db
    .prepare("INSERT INTO public_audits (id, url, host, status, ip_hash, compare_of, is_competitor, created_at, expires_at) VALUES (?, ?, ?, 'queued', ?, ?, ?, ?, ?)")
    .bind(id, target.toString(), host, ipHash, opts.compareOf ?? null, isCompetitor, now, expires)
    .run();
  await enqueuePublicAudit(c.env, c.get("deps"), id, (p) => c.executionCtx.waitUntil(p));
  return { id, status: "queued", cached: false };
}

const loadAudit = (db: D1Database, id: string) =>
  db
    .prepare("SELECT id, url, host, status, result_json, error_code, compare_of, is_competitor, claimed_org_id, created_at, finished_at FROM public_audits WHERE id = ?")
    .bind(id)
    .first<AuditRow>();

async function isMemberOf(c: Context<AppEnv>, orgId: string | null): Promise<boolean> {
  const user = c.get("user");
  if (!user || !orgId) return false;
  const m = await c.env.DB.prepare("SELECT 1 AS ok FROM memberships WHERE organization_id = ? AND user_id = ? AND status = 'active'").bind(orgId, user.id).first<{ ok: number }>();
  return !!m;
}

/** What the API and the page show of one audit: teaser for everyone, full list only to its organisation. */
async function auditView(c: Context<AppEnv>, row: AuditRow, vsId?: string | null) {
  const result = parseJson<PublicAuditResult | null>(row.result_json, null);
  const full = row.status === "completed" && (await isMemberOf(c, row.claimed_org_id));
  let competitor: { id: string; host: string; status: string; scores: PublicAuditResult["scores"] | null; error: string | null } | null = null;
  if (vsId) {
    const vs = await loadAudit(c.env.DB, vsId);
    if (vs && vs.is_competitor === 1 && vs.compare_of === row.id) {
      const r = parseJson<PublicAuditResult | null>(vs.result_json, null);
      competitor = { id: vs.id, host: vs.host, status: vs.status, scores: r?.scores ?? null, error: vs.status === "failed" ? (PUBLIC_AUDIT_ERRORS[vs.error_code ?? ""] ?? PUBLIC_AUDIT_ERRORS.unreachable!) : null };
    }
  }
  return {
    id: row.id,
    host: row.host,
    url: row.url,
    status: row.status,
    createdAt: row.created_at,
    finishedAt: row.finished_at,
    isCompetitor: row.is_competitor === 1,
    claimed: !!row.claimed_org_id,
    error: row.status === "failed" ? { code: row.error_code ?? "unreachable", message: PUBLIC_AUDIT_ERRORS[row.error_code ?? ""] ?? PUBLIC_AUDIT_ERRORS.unreachable! } : null,
    teaser: result && row.status === "completed" ? teaserOf(result) : null,
    findings: full && result ? result.findings : null,
    competitor,
  };
}

publicAudits.post("/audits", small, async (c) => {
  sameOrigin(c);
  const input = await parseBody(c, StartInput);
  const target = parseTarget(input.url);
  const r = await startAudit(c, target);
  if (!r.cached) await trackFromRequest(c, "audit_started", { props: { from: "public" } });
  return c.json({ id: r.id, status: r.status, cached: r.cached, page: `/auditoria/${r.id}` }, r.cached ? 200 : 201, { "cache-control": "no-store" });
});

publicAudits.get("/audits/:id", async (c) => {
  const id = assertUuid(c.req.param("id"), "Auditoría");
  const row = await loadAudit(c.env.DB, id);
  if (!row) throw notFound("Auditoría");
  const vs = c.req.query("vs");
  return c.json(await auditView(c, row, vs && /^[0-9a-f-]{36}$/i.test(vs) ? vs.toLowerCase() : null), 200, { "cache-control": "no-store" });
});

publicAudits.post("/audits/:id/compare", small, async (c) => {
  sameOrigin(c);
  const id = assertUuid(c.req.param("id"), "Auditoría");
  const row = await loadAudit(c.env.DB, id);
  if (!row || row.is_competitor === 1) throw notFound("Auditoría");
  if (row.status !== "completed") throw new ApiError(409, "audit_not_ready", "Espera a que termine tu auditoría para compararte.");
  const input = await parseBody(c, StartInput);
  const target = parseTarget(input.url);
  if (bareHost(target) === row.host) throw new ApiError(422, "same_site", "Escribe la web de un competidor, no la tuya.");
  const r = await startAudit(c, target, { compareOf: row.id });
  return c.json({ id: r.id, status: r.status, page: `/auditoria/${row.id}?vs=${r.id}` }, 201, { "cache-control": "no-store" });
});

// ── Help emails: one-click opt-out (GET shows a confirmation so link scanners never unsubscribe anyone) ──
const unsubPage = (title: string, body: string) =>
  `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>${title} · DNI Growth</title><style>body{margin:0;background:#0b0b0c;color:#f5f5f4;font-family:Inter,system-ui,sans-serif}main{max-width:560px;margin:0 auto;padding:72px 16px}h1{font-size:28px;margin:0 0 12px}p{color:#c4c4cc;line-height:1.6}button{min-height:44px;padding:0 20px;border-radius:999px;border:0;background:#b4ff4d;color:#0b0b0c;font-weight:700;font-size:16px;cursor:pointer}a{color:#e8e8ee}</style></head><body><main>${body}</main></body></html>`;

const UnsubInput = z.object({ u: z.string().uuid(), t: z.string().regex(/^[0-9a-f]{32}$/) });

publicAudits.get("/lifecycle/unsubscribe", async (c) => {
  const p = UnsubInput.safeParse({ u: c.req.query("u"), t: c.req.query("t") });
  const ok = p.success && (await verifyUnsubscribeToken(c.env, p.data.u, p.data.t));
  const headers = { "content-type": "text/html; charset=utf-8", ...SITE_SECURITY_HEADERS, "cache-control": "no-store" };
  if (!ok || !p.success) return c.body(unsubPage("Enlace no válido", `<h1>Enlace no válido</h1><p>Este enlace para darte de baja no es correcto o está incompleto. Puedes escribirnos a hola@dnigrowth.com.</p>`), 400, headers);
  return c.body(
    unsubPage(
      "Dejar de recibir consejos",
      `<h1>¿Dejar de recibir consejos de configuración?</h1><p>No te enviaremos más correos de ayuda para terminar la configuración. Los correos de tu cuenta (como recuperar la contraseña) seguirán llegando.</p><form method="post" action="/api/v1/public/lifecycle/unsubscribe"><input type="hidden" name="u" value="${p.data.u}"><input type="hidden" name="t" value="${p.data.t}"><button type="submit">Sí, darme de baja</button></form>`,
    ),
    200,
    headers,
  );
});

publicAudits.post("/lifecycle/unsubscribe", small, async (c) => {
  sameOrigin(c);
  const form = await c.req.parseBody().catch(() => ({}) as Record<string, unknown>);
  const p = UnsubInput.safeParse({ u: form["u"], t: form["t"] });
  const headers = { "content-type": "text/html; charset=utf-8", ...SITE_SECURITY_HEADERS, "cache-control": "no-store" };
  if (!p.success || !(await verifyUnsubscribeToken(c.env, p.data.u, p.data.t))) return c.body(unsubPage("Enlace no válido", "<h1>Enlace no válido</h1><p>No hemos podido darte de baja con este enlace.</p>"), 400, headers);
  await c.env.DB.prepare("UPDATE users SET lifecycle_emails_opt_out_at = COALESCE(lifecycle_emails_opt_out_at, ?) WHERE id = ?").bind(nowIso(), p.data.u).run();
  return c.body(unsubPage("Baja hecha", `<h1>Hecho</h1><p>No te enviaremos más consejos de configuración.</p><p><a href="/">Volver a DNI Growth</a></p>`), 200, headers);
});

// Monthly report: same two-step opt-out (GET confirms, POST unsubscribes) so link scanners change nothing.
publicAudits.get("/monthly-report/unsubscribe", async (c) => {
  const p = UnsubInput.safeParse({ u: c.req.query("u"), t: c.req.query("t") });
  const headers = { "content-type": "text/html; charset=utf-8", ...SITE_SECURITY_HEADERS, "cache-control": "no-store" };
  if (!p.success || !(await verifyReportUnsubscribeToken(c.env, p.data.u, p.data.t))) return c.body(unsubPage("Enlace no válido", `<h1>Enlace no válido</h1><p>Este enlace para darte de baja no es correcto o está incompleto. Puedes escribirnos a hola@dnigrowth.com.</p>`), 400, headers);
  return c.body(
    unsubPage(
      "Dejar de recibir el informe mensual",
      `<h1>¿Dejar de recibir el informe mensual?</h1><p>No te enviaremos más el resumen mensual de tus organizaciones. Los correos de tu cuenta (como recuperar la contraseña) seguirán llegando.</p><form method="post" action="/api/v1/public/monthly-report/unsubscribe"><input type="hidden" name="u" value="${p.data.u}"><input type="hidden" name="t" value="${p.data.t}"><button type="submit">Sí, darme de baja</button></form>`,
    ),
    200,
    headers,
  );
});

publicAudits.post("/monthly-report/unsubscribe", small, async (c) => {
  sameOrigin(c);
  const form = await c.req.parseBody().catch(() => ({}) as Record<string, unknown>);
  const p = UnsubInput.safeParse({ u: form["u"], t: form["t"] });
  const headers = { "content-type": "text/html; charset=utf-8", ...SITE_SECURITY_HEADERS, "cache-control": "no-store" };
  if (!p.success || !(await verifyReportUnsubscribeToken(c.env, p.data.u, p.data.t))) return c.body(unsubPage("Enlace no válido", "<h1>Enlace no válido</h1><p>No hemos podido darte de baja con este enlace.</p>"), 400, headers);
  await c.env.DB.prepare("UPDATE users SET monthly_report_opt_out_at = COALESCE(monthly_report_opt_out_at, ?) WHERE id = ?").bind(nowIso(), p.data.u).run();
  return c.body(unsubPage("Baja hecha", `<h1>Hecho</h1><p>No te enviaremos más el informe mensual.</p><p><a href="/">Volver a DNI Growth</a></p>`), 200, headers);
});

// ── Inside an organisation: claim the free audit, guided set-up state and choices ──────────────────────
export const activationRoutes = new Hono<AppEnv>();

activationRoutes.post("/public-audits/:auditId/claim", requireScope("site:analyze"), async (c) => {
  const t = c.get("tenant");
  const db = c.env.DB;
  const id = assertUuid(c.req.param("auditId"), "Auditoría");
  const row = await loadAudit(db, id);
  if (!row || row.is_competitor === 1) throw notFound("Auditoría");
  let claimedId = row.id;
  if (row.claimed_org_id && row.claimed_org_id !== t.orgId) {
    // Already linked to another organisation: this one gets its own copy (the other copy is untouched).
    claimedId = uuid();
    await db
      .prepare(
        `INSERT INTO public_audits (id, url, host, status, result_json, error_code, is_competitor, claimed_org_id, claimed_by, claimed_at, attempts, created_at, started_at, finished_at, expires_at)
         SELECT ?, url, host, status, result_json, error_code, 0, ?, ?, ?, attempts, created_at, started_at, finished_at, expires_at FROM public_audits WHERE id = ?`,
      )
      .bind(claimedId, t.orgId, t.userId, nowIso(), row.id)
      .run();
  } else if (!row.claimed_org_id) {
    await db.batch([
      // Linked to the organisation: it is the organisation's data now, so the IP hash is no longer needed.
      db.prepare("UPDATE public_audits SET claimed_org_id = ?, claimed_by = ?, claimed_at = ?, ip_hash = NULL WHERE id = ? AND claimed_org_id IS NULL").bind(t.orgId, t.userId, nowIso(), row.id),
      auditStmt(db, { organizationId: t.orgId, actorUserId: t.userId, action: "public_audit.claimed", entityType: "public_audit", entityId: row.id, after: { host: row.host }, requestId: c.get("requestId") }),
    ]);
  }
  const claimed = await loadAudit(db, claimedId);
  return c.json({ ...(await auditView(c, claimed!)), analyzeUrl: claimed!.url });
});

activationRoutes.get("/activation", requireScope("org:read"), async (c) => c.json(await activationFor(c.env.DB, c.get("tenant").orgId), 200, { "cache-control": "no-store" }));

const OnboardingInput = z.strictObject({
  publishingMode: z.enum(["approval", "autopilot"]).optional(),
  articlesPerWeek: z.number().int().min(1).max(7).optional(),
  skip: z.enum(["competitors", "analytics", "cms"]).optional(),
  unskip: z.enum(["competitors", "analytics", "cms"]).optional(),
});

activationRoutes.put("/onboarding", requireScope("org:update"), async (c) => {
  const t = c.get("tenant");
  const db = c.env.DB;
  const input = await parseBody(c, OnboardingInput);
  const cur = await db
    .prepare("SELECT publishing_mode, articles_per_week, skipped_json FROM organization_onboarding WHERE organization_id = ?")
    .bind(t.orgId)
    .first<{ publishing_mode: string | null; articles_per_week: number | null; skipped_json: string }>();
  const skipped = new Set(parseJson<string[]>(cur?.skipped_json, []).filter((k) => SKIPPABLE_STEPS.has(k as ActivationStepKey)));
  if (input.skip) skipped.add(input.skip);
  if (input.unskip) skipped.delete(input.unskip);
  const mode = input.publishingMode ?? cur?.publishing_mode ?? null;
  const perWeek = input.articlesPerWeek ?? cur?.articles_per_week ?? (mode ? 1 : null);
  await db.batch([
    db
      .prepare(
        `INSERT INTO organization_onboarding (organization_id, publishing_mode, articles_per_week, skipped_json, updated_by, updated_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(organization_id) DO UPDATE SET publishing_mode = excluded.publishing_mode, articles_per_week = excluded.articles_per_week, skipped_json = excluded.skipped_json, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
      )
      .bind(t.orgId, mode, perWeek, JSON.stringify([...skipped]), t.userId, nowIso()),
    auditStmt(db, { organizationId: t.orgId, actorUserId: t.userId, action: "onboarding.updated", entityType: "organization", entityId: t.orgId, after: { publishingMode: mode, articlesPerWeek: perWeek, skipped: [...skipped] }, requestId: c.get("requestId") }),
  ]);
  if (input.publishingMode) await trackFromRequest(c, "onboarding_step", { organizationId: t.orgId, props: { step: "mode", mode: input.publishingMode } });
  return c.json(await activationFor(db, t.orgId));
});

// ── Public page /auditoria/{id} (rendered by the Worker into the built auditoria.html) ─────────────────
const ENT: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const esc = (s: string) => s.replace(/[&<>"']/g, (ch) => ENT[ch]!);
const SEVERITY_ES: Record<string, string> = { critical: "crítica", high: "alta", medium: "media", low: "baja", info: "informativa" };
const BAND_ES = { bien: "Bien", mejorable: "Mejorable", urgente: "Urgente" } as const;
const PAGE_HEADERS = { "content-type": "text/html; charset=utf-8", ...SITE_SECURITY_HEADERS, "cache-control": "no-store", "x-robots-tag": "noindex, nofollow" };
const day = (iso: string) => new Date(iso).toLocaleString("es-ES", { day: "numeric", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "Europe/Madrid" });

const FALLBACK_SHELL = `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Auditoría gratuita · DNI Growth</title><meta name="description" content=""><meta property="og:title" content=""><meta property="og:description" content=""><meta property="og:url" content=""></head><body><main id="main" class="legal audit" data-audit-main></main></body></html>`;

async function shell(c: Context<AppEnv>): Promise<string> {
  if (!c.env.ASSETS) return FALLBACK_SHELL;
  try {
    const res = await c.env.ASSETS.fetch(new Request(new URL("/auditoria", c.req.url)));
    const html = res.ok ? await res.text() : "";
    return html.includes("data-audit-main") ? html : FALLBACK_SHELL;
  } catch {
    return FALLBACK_SHELL;
  }
}

function fillPage(tpl: string, p: { title: string; description: string; url: string; main: string }): string {
  return tpl
    .replace(/<title>[^<]*<\/title>/, `<title>${esc(p.title)}</title>`)
    .replace(/<meta name="description" content="[^"]*"/, `<meta name="description" content="${esc(p.description)}"`)
    .replace(/<meta property="og:title" content="[^"]*"/, `<meta property="og:title" content="${esc(p.title)}"`)
    .replace(/<meta property="og:description" content="[^"]*"/, `<meta property="og:description" content="${esc(p.description)}"`)
    .replace(/<meta property="og:url" content="[^"]*"/, `<meta property="og:url" content="${esc(p.url)}"`)
    .replace(/(<main[^>]*data-audit-main[^>]*)>[\s\S]*?(<\/main>)/, (_m, open: string, close: string) => `${open}>${p.main}${close}`);
}

const scoreCard = (label: string, value: number, main = false) =>
  `<li class="audit-score${main ? " is-main" : ""}" data-band="${scoreBand(value)}"><span class="audit-score-label">${esc(label)}</span><span class="audit-score-value"><strong>${value}</strong>/100</span><span class="audit-score-band">${BAND_ES[scoreBand(value)]}</span><span class="audit-bar" aria-hidden="true"><span style="width:${value}%"></span></span></li>`;

function findingItem(f: AuditFinding): string {
  const urls = f.urls.length ? `<p class="audit-urls">Páginas: ${f.urls.map((u) => `<span>${esc(u)}</span>`).join(" · ")}${f.affectedCount > f.urls.length ? ` y ${f.affectedCount - f.urls.length} más` : ""}</p>` : "";
  return `<li class="audit-finding" data-severity="${esc(f.severity)}"><h3>${esc(f.title)}</h3><p class="audit-meta">Gravedad ${esc(SEVERITY_ES[f.severity] ?? f.severity)} · ${esc(PILLAR_LABEL[f.pillar])}${f.affectedCount > 1 ? ` · ${f.affectedCount} páginas` : ""}</p><p><strong>Qué vimos:</strong> ${f.evidence === f.title ? (f.urls.length ? "lo detectamos en las páginas indicadas." : "lo detectamos al revisar la web.") : esc(f.evidence)}</p><p><strong>Cómo arreglarlo:</strong> ${esc(f.fix)}</p>${urls}</li>`;
}

function pendingMain(v: Awaited<ReturnType<typeof auditView>>): string {
  return `<p class="audit-eyebrow">Auditoría gratuita</p><h1>Revisando ${esc(v.host)}…</h1><p class="audit-lead" role="status" aria-live="polite" data-audit-progress>Estamos leyendo hasta 5 páginas públicas de la web con las mismas reglas que el análisis completo. Suele tardar menos de un minuto.</p><div class="audit-loader" aria-hidden="true"><span></span></div><noscript><p>Vuelve a cargar la página en un minuto para ver el resultado.</p></noscript>`;
}

function failedMain(v: Awaited<ReturnType<typeof auditView>>): string {
  return `<p class="audit-eyebrow">Auditoría gratuita</p><h1>No hemos podido revisar ${esc(v.host)}</h1><p class="audit-lead">${esc(v.error?.message ?? PUBLIC_AUDIT_ERRORS.unreachable!)}</p><p><a class="btn btn-accent" href="/#auditar">Probar con otra dirección</a></p><p class="audit-micro">¿Es tu web y no se deja revisar? <a href="/app/register">Crea tu cuenta gratis</a> y te ayudamos desde dentro.</p>`;
}

function compareBlock(v: Awaited<ReturnType<typeof auditView>>): string {
  const c = v.competitor;
  if (!c || !v.teaser) return "";
  if (c.status === "failed") return `<section class="audit-vs" aria-labelledby="vs-title"><h2 id="vs-title">Comparación con ${esc(c.host)}</h2><p>${esc(c.error ?? "")}</p></section>`;
  if (!c.scores) return `<section class="audit-vs" aria-labelledby="vs-title" data-vs-pending><h2 id="vs-title">Comparación con ${esc(c.host)}</h2><p role="status" aria-live="polite">Revisando la web del competidor… Suele tardar menos de un minuto.</p></section>`;
  const rows: Array<[string, keyof PublicAuditResult["scores"]]> = [["Nota global", "global"], ["Técnica", "technical"], ["SEO", "seo"], ["GEO / AEO", "geo"]];
  const mine = v.teaser.scores;
  return `<section class="audit-vs" aria-labelledby="vs-title"><h2 id="vs-title">Tu web frente a ${esc(c.host)}</h2><div class="tw"><table><thead><tr><th scope="col">Área</th><th scope="col">${esc(v.host)}</th><th scope="col">${esc(c.host)}</th></tr></thead><tbody>${rows
    .map(([label, k]) => {
      const a = mine[k];
      const b = c.scores![k];
      return `<tr><th scope="row">${label}</th><td>${a}${a > b ? ' <span class="audit-win">mejor</span>' : ""}</td><td>${b}${b > a ? ' <span class="audit-win">mejor</span>' : ""}</td></tr>`;
    })
    .join("")}</tbody></table></div><p class="audit-micro">Las dos webs se revisan igual: hasta 5 páginas públicas y las mismas reglas.</p></section>`;
}

function completedMain(v: Awaited<ReturnType<typeof auditView>>, origin: string): string {
  const t = v.teaser!;
  const shareUrl = `${origin}/auditoria/${v.id}`;
  const shareText = `${v.host} saca ${t.scores.global}/100 en la auditoría gratuita de DNI Growth`;
  const enc = encodeURIComponent;
  const pillars = (["technical", "seo", "geo"] as Pillar[]).map((p) => scoreCard(PILLAR_LABEL[p], t.scores[p])).join("");
  const top = t.top.length ? `<ol class="audit-findings">${t.top.map(findingItem).join("")}</ol>` : `<p>No hemos encontrado problemas en las páginas revisadas. Con tu cuenta revisamos más páginas y medimos con tus datos de Google.</p>`;
  const rest = v.findings
    ? v.findings.length > t.top.length
      ? `<h2>El resto de problemas (${v.findings.length - t.top.length})</h2><ol class="audit-findings" start="${t.top.length + 1}">${v.findings.slice(t.top.length).map(findingItem).join("")}</ol><p><a class="btn btn-accent" href="/app/">Ir a mi cuenta</a></p>`
      : `<p><a class="btn btn-accent" href="/app/">Ir a mi cuenta</a></p>`
    : `<div class="audit-locked"><p class="audit-locked-title">${t.othersCount > 0 ? `Y ${t.othersCount} problema${t.othersCount === 1 ? "" : "s"} más.` : "Tu plan de 30 días te espera."}</p><p>${t.othersCount > 0 ? "Crea tu cuenta gratis para ver la lista completa, ordenada por lo que más pesa, y tu plan de 30 días." : "Crea tu cuenta gratis para revisar más páginas y recibir tu plan de 30 días, paso a paso."}</p><p><a class="btn btn-accent" href="/app/register?audit=${v.id}" data-claim-link>Ver el informe completo gratis</a></p><p class="audit-micro">Gratis y sin tarjeta · Solo leemos tu web pública · No cambiamos nada</p></div>`;
  const share = v.isCompetitor
    ? ""
    : `<section class="audit-share" aria-labelledby="share-title"><h2 id="share-title">Comparte tu nota</h2><div class="audit-share-row"><button type="button" class="btn" data-share data-share-url="${esc(shareUrl)}" data-share-text="${esc(shareText)}" hidden>Compartir</button><button type="button" class="btn" data-copy="${esc(shareUrl)}" hidden>Copiar enlace</button><a class="btn" href="https://www.linkedin.com/sharing/share-offsite/?url=${enc(shareUrl)}" target="_blank" rel="noopener noreferrer">LinkedIn</a><a class="btn" href="https://x.com/intent/post?text=${enc(shareText)}&amp;url=${enc(shareUrl)}" target="_blank" rel="noopener noreferrer">X</a><a class="btn" href="https://wa.me/?text=${enc(`${shareText} ${shareUrl}`)}" target="_blank" rel="noopener noreferrer">WhatsApp</a></div><p class="audit-micro" data-copy-status role="status" aria-live="polite"></p></section>`;
  const compare = v.isCompetitor
    ? ""
    : `<section class="audit-compare" aria-labelledby="compare-title" data-compare hidden><h2 id="compare-title">Compárate con un competidor</h2><p>Escribe la web de un competidor y la revisamos igual que la tuya.</p><form class="audit-form" data-compare-form data-audit-id="${v.id}" novalidate><label class="sr-only" for="vs-url">Web del competidor</label><input id="vs-url" name="url" type="text" inputmode="url" autocomplete="off" placeholder="competidor.es" required maxlength="500"><button class="btn btn-accent" type="submit">Comparar</button></form><p class="audit-micro" data-compare-status role="status" aria-live="polite"></p></section>`;
  return `<p class="audit-eyebrow">Auditoría gratuita · ${esc(day(t.observedAt))}</p><h1><span class="audit-host">${esc(v.host)}</span> <span class="audit-global">${t.scores.global}<small>/100</small></span></h1><p class="audit-lead">Hemos revisado ${t.pagesAnalyzed} página${t.pagesAnalyzed === 1 ? "" : "s"} pública${t.pagesAnalyzed === 1 ? "" : "s"} con las mismas reglas que el análisis completo. Esto es lo que más pesa ahora mismo.</p><ul class="audit-scores">${scoreCard("Nota global", t.scores.global, true)}${pillars}</ul>${compareBlock(v)}<h2>${t.top.length === 1 ? "El problema que más pesa" : t.top.length ? `Los ${t.top.length} problemas que más pesan` : "Problemas encontrados"}</h2>${top}${rest}${share}${compare}<details class="audit-method"><summary>Cómo calculamos estas notas</summary><p>${esc(t.method)}</p><p>Fuente: rastreo propio de DNI Growth (solo páginas públicas, respetando robots.txt) el ${esc(day(t.observedAt))}. Tipo de medida: derivada. Limitación: una muestra de hasta 5 páginas; el análisis completo revisa más.</p></details>`;
}

export function registerAuditPage(app: Hono<AppEnv>, notFoundPage: (c: Context<AppEnv>) => Promise<Response>) {
  app.get("/auditoria", (c) => c.redirect("/#auditar", 302));
  app.get("/auditoria/:id", async (c) => {
    const raw = c.req.param("id");
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(raw)) return notFoundPage(c);
    const row = await loadAudit(c.env.DB, raw.toLowerCase());
    if (!row) return notFoundPage(c);
    // The session is read here too (the page is outside /api), so the organisation that claimed it sees everything.
    c.set("user", await loadSession(c));
    const vs = c.req.query("vs");
    const v = await auditView(c, row, vs && /^[0-9a-f-]{36}$/i.test(vs) ? vs.toLowerCase() : null);
    const origin = c.env.APP_ORIGIN.replace(/\/$/, "");
    const main =
      v.status === "completed" && v.teaser ? completedMain(v, origin) : v.status === "failed" ? failedMain(v) : pendingMain(v);
    const title = v.teaser ? `${v.host}: ${v.teaser.scores.global}/100 en la auditoría gratuita · DNI Growth` : `Auditoría gratuita de ${v.host} · DNI Growth`;
    const description = v.teaser
      ? `Técnica ${v.teaser.scores.technical}, SEO ${v.teaser.scores.seo}, GEO/AEO ${v.teaser.scores.geo}. ${v.teaser.top.length} problemas prioritarios con evidencia y cómo arreglarlos.`
      : "Revisión gratuita de hasta 5 páginas públicas: SEO técnico, metadatos y preparación para buscadores con IA.";
    const html = fillPage(await shell(c), {
      title,
      description,
      url: `${origin}/auditoria/${v.id}`,
      main: `<div data-audit-state="${v.status}" data-audit-id="${v.id}"${v.competitor && !v.competitor.scores && v.competitor.status !== "failed" ? ` data-vs-id="${v.competitor.id}"` : ""}>${main}</div>`,
    });
    return c.body(html, 200, PAGE_HEADERS);
  });
}
