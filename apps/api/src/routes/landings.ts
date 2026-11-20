import { Hono, type Context } from "hono";
import { z } from "zod";
import { abTest, LANDING_LIMITS, LANDING_SLUG, LandingContent, landingTemplate, type LandingContent as LC } from "@dni/core";
import type { AppEnv, Env } from "../env";
import { auditStmt } from "../lib/audit";
import { orgPlan } from "../lib/billing";
import { ApiError, assertUuid, notFound, parseBody } from "../lib/http";
import { landingCsp, renderLanding, type RenderForm } from "../lib/landing-render";
import { hashIp, nowIso, uuid } from "../lib/util";
import { requireScope } from "../middleware";

/**
 * F5 landing pages (blocks → versions → publish at /l/<org>/<slug>) and F7 A/B tests on them.
 * Publishing makes a page public: it needs `landings:publish`, is audited and can be undone.
 */
export const landings = new Hono<AppEnv>();

type PageRow = {
  id: string;
  brand_id: string | null;
  slug: string;
  name: string;
  status: "draft" | "published" | "unpublished" | "archived";
  form_id: string | null;
  noindex: number;
  draft_version_id: string | null;
  published_version_id: string | null;
  experiment_status: "none" | "running" | "stopped";
  variant_b_version_id: string | null;
  split_b: number;
  experiment_started_at: string | null;
  experiment_hypothesis: string | null;
  created_at: string;
  updated_at: string;
  published_at: string | null;
};
const PAGE_COLS =
  "id, brand_id, slug, name, status, form_id, noindex, draft_version_id, published_version_id, experiment_status, variant_b_version_id, split_b, experiment_started_at, experiment_hypothesis, created_at, updated_at, published_at";

const publicUrl = (env: Env, orgSlug: string, slug: string) => `${new URL(env.APP_ORIGIN).origin}/l/${orgSlug}/${slug}`;

async function orgSlug(env: Env, orgId: string) {
  const r = await env.DB.prepare("SELECT slug, name FROM organizations WHERE id = ?").bind(orgId).first<{ slug: string; name: string }>();
  if (!r) throw notFound("Organización");
  return r;
}

async function loadPage(c: Context<AppEnv>, orgId: string) {
  const id = assertUuid(c.req.param("landingId"), "Landing");
  const p = await c.env.DB.prepare(`SELECT ${PAGE_COLS} FROM landing_pages WHERE organization_id = ? AND id = ?`).bind(orgId, id).first<PageRow>();
  if (!p) throw notFound("Landing");
  return p;
}

async function loadVersion(env: Env, orgId: string, landingId: string, versionId: string | null) {
  if (!versionId) return null;
  const v = await env.DB.prepare("SELECT id, version, content_json, note, created_at FROM landing_versions WHERE organization_id = ? AND landing_id = ? AND id = ?")
    .bind(orgId, landingId, versionId)
    .first<{ id: string; version: number; content_json: string; note: string | null; created_at: string }>();
  return v ? { ...v, content: LandingContent.parse(JSON.parse(v.content_json)) } : null;
}

async function loadForm(env: Env, orgId: string, formId: string | null): Promise<RenderForm | null> {
  if (!formId) return null;
  const f = await env.DB.prepare("SELECT id, consent_text, marketing_text, privacy_url, ask_phone, ask_company, status FROM lead_forms WHERE organization_id = ? AND id = ?")
    .bind(orgId, formId)
    .first<{ id: string; consent_text: string; marketing_text: string | null; privacy_url: string | null; ask_phone: number; ask_company: number; status: string }>();
  if (!f || f.status !== "active") return null;
  return { id: f.id, consentText: f.consent_text, marketingText: f.marketing_text, privacyUrl: f.privacy_url, askPhone: !!f.ask_phone, askCompany: !!f.ask_company };
}

async function assertForm(env: Env, orgId: string, formId: string | null | undefined) {
  if (!formId) return;
  const ok = await env.DB.prepare("SELECT id FROM lead_forms WHERE organization_id = ? AND id = ? AND status != 'archived'").bind(orgId, assertUuid(formId, "Formulario")).first();
  if (!ok) throw notFound("Formulario");
}

async function usage(db: D1Database, orgId: string) {
  const plan = await orgPlan(db, orgId);
  const limit = (plan.limits as { landingPages?: number }).landingPages ?? LANDING_LIMITS[plan.code] ?? 1;
  const r = await db.prepare("SELECT COUNT(*) AS n FROM landing_pages WHERE organization_id = ? AND status != 'archived'").bind(orgId).first<{ n: number }>();
  return { used: r?.n ?? 0, limit, plan: plan.code };
}

async function stats(env: Env, orgId: string, p: PageRow) {
  const since = p.experiment_started_at?.slice(0, 10) ?? new Date(Date.now() - 30 * 86400_000).toISOString().slice(0, 10);
  const { results } = await env.DB.prepare("SELECT variant, version_id, SUM(views) AS views, SUM(conversions) AS conversions FROM landing_stats_daily WHERE organization_id = ? AND landing_id = ? AND day >= ? GROUP BY variant, version_id")
    .bind(orgId, p.id, since)
    .all<{ variant: "A" | "B"; version_id: string; views: number; conversions: number }>();
  const sum = (variant: "A" | "B", versionId: string | null) => {
    const rows = results.filter((r) => r.variant === variant && (!versionId || r.version_id === versionId));
    return { views: rows.reduce((a, r) => a + r.views, 0), conversions: rows.reduce((a, r) => a + r.conversions, 0) };
  };
  const a = sum("A", p.experiment_status === "none" ? null : p.published_version_id);
  const b = sum("B", p.variant_b_version_id);
  return {
    since,
    measurement: "observed",
    a,
    b,
    test: p.experiment_status === "none" ? null : abTest(a, b),
    caveats: [
      "Visitas contadas en el servidor, sin cookies; se excluyen los robots que se identifican como tales. Una persona que recarga cuenta varias veces.",
      "Conversión = envío válido del formulario de la landing (sin spam).",
    ],
  };
}

landings.get("/landings", requireScope("content:read"), async (c) => {
  const t = c.get("tenant");
  const o = await orgSlug(c.env, t.orgId);
  const { results } = await c.env.DB.prepare(`SELECT ${PAGE_COLS} FROM landing_pages WHERE organization_id = ? AND status != 'archived' ORDER BY updated_at DESC`).bind(t.orgId).all<PageRow>();
  const totals = await c.env.DB.prepare("SELECT landing_id, SUM(views) AS views, SUM(conversions) AS conversions FROM landing_stats_daily WHERE organization_id = ? AND day >= ? GROUP BY landing_id")
    .bind(t.orgId, new Date(Date.now() - 30 * 86400_000).toISOString().slice(0, 10))
    .all<{ landing_id: string; views: number; conversions: number }>();
  return c.json({
    items: results.map((p) => ({ ...p, noindex: !!p.noindex, url: publicUrl(c.env, o.slug, p.slug), last30: totals.results.find((x) => x.landing_id === p.id) ?? { views: 0, conversions: 0 } })),
    usage: await usage(c.env.DB, t.orgId),
  });
});

const CreateInput = z.strictObject({ name: z.string().trim().min(2).max(120), slug: LANDING_SLUG, brandId: z.string().optional().nullable(), formId: z.string().optional().nullable() });
landings.post("/landings", requireScope("landings:write"), async (c) => {
  const t = c.get("tenant");
  const user = c.get("user")!;
  const b = await parseBody(c, CreateInput);
  const u = await usage(c.env.DB, t.orgId);
  if (u.used >= u.limit) throw new ApiError(402, "plan_limit", `Tu plan permite ${u.limit} landing${u.limit === 1 ? "" : "s"}. Archiva una o mejora el plan.`);
  let brandName = (await orgSlug(c.env, t.orgId)).name;
  if (b.brandId) {
    const br = await c.env.DB.prepare("SELECT name FROM brands WHERE organization_id = ? AND id = ?").bind(t.orgId, assertUuid(b.brandId, "Marca")).first<{ name: string }>();
    if (!br) throw notFound("Marca");
    brandName = br.name;
  }
  await assertForm(c.env, t.orgId, b.formId);
  const dup = await c.env.DB.prepare("SELECT id FROM landing_pages WHERE organization_id = ? AND slug = ?").bind(t.orgId, b.slug).first();
  if (dup) throw new ApiError(409, "slug_taken", "Ya tienes una landing con esa dirección.");
  const id = uuid();
  const vid = uuid();
  const now = nowIso();
  await c.env.DB.batch([
    c.env.DB.prepare(`INSERT INTO landing_pages (id, organization_id, brand_id, slug, name, form_id, draft_version_id, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(id, t.orgId, b.brandId || null, b.slug, b.name, b.formId || null, vid, user.id, now, now),
    c.env.DB.prepare("INSERT INTO landing_versions (id, organization_id, landing_id, version, content_json, note, created_by, created_at) VALUES (?, ?, ?, 1, ?, 'Plantilla inicial', ?, ?)").bind(vid, t.orgId, id, JSON.stringify(landingTemplate(brandName)), user.id, now),
    auditStmt(c.env.DB, { organizationId: t.orgId, actorUserId: user.id, action: "landing.create", entityType: "landing", entityId: id, after: { slug: b.slug }, requestId: c.get("requestId") }),
  ]);
  return c.json({ id }, 201);
});

landings.get("/landings/:landingId", requireScope("content:read"), async (c) => {
  const t = c.get("tenant");
  const p = await loadPage(c, t.orgId);
  const o = await orgSlug(c.env, t.orgId);
  const [draft, versions] = await Promise.all([
    loadVersion(c.env, t.orgId, p.id, p.draft_version_id),
    c.env.DB.prepare("SELECT v.id, v.version, v.note, v.created_at, u.name AS created_by_name FROM landing_versions v LEFT JOIN users u ON u.id = v.created_by WHERE v.organization_id = ? AND v.landing_id = ? ORDER BY v.version DESC LIMIT 50")
      .bind(t.orgId, p.id)
      .all(),
  ]);
  return c.json({ page: { ...p, noindex: !!p.noindex, url: publicUrl(c.env, o.slug, p.slug) }, draft: draft && { id: draft.id, version: draft.version, content: draft.content }, versions: versions.results, stats: await stats(c.env, t.orgId, p) });
});

const SaveInput = z.strictObject({ content: z.unknown(), note: z.string().trim().max(200).optional(), baseVersionId: z.string() });
landings.put("/landings/:landingId/content", requireScope("landings:write"), async (c) => {
  const t = c.get("tenant");
  const user = c.get("user")!;
  const p = await loadPage(c, t.orgId);
  const b = await parseBody(c, SaveInput);
  const parsed = LandingContent.safeParse(b.content);
  if (!parsed.success) throw new ApiError(422, "invalid_content", [...new Set(parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`))].slice(0, 5).join(" · "));
  if (b.baseVersionId !== p.draft_version_id) throw new ApiError(409, "version_conflict", "Alguien guardó otra versión mientras editabas. Recarga para ver los cambios.");
  const last = await c.env.DB.prepare("SELECT MAX(version) AS v FROM landing_versions WHERE organization_id = ? AND landing_id = ?").bind(t.orgId, p.id).first<{ v: number }>();
  const vid = uuid();
  const now = nowIso();
  const res = await c.env.DB.batch([
    c.env.DB.prepare("INSERT INTO landing_versions (id, organization_id, landing_id, version, content_json, note, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").bind(vid, t.orgId, p.id, (last?.v ?? 0) + 1, JSON.stringify(parsed.data), b.note ?? null, user.id, now),
    c.env.DB.prepare("UPDATE landing_pages SET draft_version_id = ?, updated_at = ? WHERE organization_id = ? AND id = ? AND draft_version_id = ?").bind(vid, now, t.orgId, p.id, b.baseVersionId),
  ]);
  if (!res[1]?.meta.changes) throw new ApiError(409, "version_conflict", "Alguien guardó otra versión mientras editabas. Recarga para ver los cambios.");
  return c.json({ versionId: vid, version: (last?.v ?? 0) + 1 });
});

const PatchInput = z.strictObject({ name: z.string().trim().min(2).max(120).optional(), slug: LANDING_SLUG.optional(), formId: z.string().nullable().optional(), noindex: z.boolean().optional(), status: z.literal("archived").optional() });
landings.patch("/landings/:landingId", requireScope("landings:write"), async (c) => {
  const t = c.get("tenant");
  const p = await loadPage(c, t.orgId);
  const b = await parseBody(c, PatchInput);
  if (b.formId) await assertForm(c.env, t.orgId, b.formId);
  if (b.slug && b.slug !== p.slug) {
    const dup = await c.env.DB.prepare("SELECT id FROM landing_pages WHERE organization_id = ? AND slug = ?").bind(t.orgId, b.slug).first();
    if (dup) throw new ApiError(409, "slug_taken", "Ya tienes una landing con esa dirección.");
  }
  if (b.status === "archived" && p.status === "published") throw new ApiError(409, "published", "Despublica la landing antes de archivarla.");
  const sets: Array<[string, unknown]> = [
    ["name", b.name],
    ["slug", b.slug],
    ["form_id", b.formId === undefined ? undefined : b.formId || null],
    ["noindex", b.noindex === undefined ? undefined : b.noindex ? 1 : 0],
    ["status", b.status],
  ].filter(([, v]) => v !== undefined) as Array<[string, unknown]>;
  if (sets.length) {
    const setClause = sets.map(([k]) => k + " = ?").join(", ");
    await c.env.DB.batch([
      c.env.DB.prepare(`UPDATE landing_pages SET ${setClause}, updated_at = ? WHERE organization_id = ? AND id = ?`).bind(...sets.map(([, v]) => v ?? null), nowIso(), t.orgId, p.id),
      auditStmt(c.env.DB, { organizationId: t.orgId, actorUserId: c.get("user")!.id, action: "landing.update", entityType: "landing", entityId: p.id, after: Object.fromEntries(sets), requestId: c.get("requestId") }),
    ]);
  }
  return c.json({ ok: true });
});

landings.post("/landings/:landingId/versions/:versionId/restore", requireScope("landings:write"), async (c) => {
  const t = c.get("tenant");
  const p = await loadPage(c, t.orgId);
  const v = await loadVersion(c.env, t.orgId, p.id, assertUuid(c.req.param("versionId"), "Versión"));
  if (!v) throw notFound("Versión");
  const last = await c.env.DB.prepare("SELECT MAX(version) AS v FROM landing_versions WHERE organization_id = ? AND landing_id = ?").bind(t.orgId, p.id).first<{ v: number }>();
  const vid = uuid();
  const now = nowIso();
  await c.env.DB.batch([
    c.env.DB.prepare("INSERT INTO landing_versions (id, organization_id, landing_id, version, content_json, note, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").bind(vid, t.orgId, p.id, (last?.v ?? 0) + 1, v.content_json, `Restaurada la versión ${v.version}`, c.get("user")!.id, now),
    c.env.DB.prepare("UPDATE landing_pages SET draft_version_id = ?, updated_at = ? WHERE organization_id = ? AND id = ?").bind(vid, now, t.orgId, p.id),
  ]);
  return c.json({ versionId: vid });
});

landings.get("/landings/:landingId/preview", requireScope("content:read"), async (c) => {
  const t = c.get("tenant");
  const p = await loadPage(c, t.orgId);
  const versionId = c.req.query("versionId") ? assertUuid(c.req.query("versionId"), "Versión") : p.draft_version_id;
  const v = await loadVersion(c.env, t.orgId, p.id, versionId);
  if (!v) throw notFound("Versión");
  const o = await orgSlug(c.env, t.orgId);
  const nonce = uuid().replace(/-/g, "");
  const html = renderLanding({ content: v.content, orgName: o.name, canonicalUrl: publicUrl(c.env, o.slug, p.slug), noindex: true, form: await loadForm(c.env, t.orgId, p.form_id), landingId: p.id, variant: "A", nonce, preview: true });
  return new Response(html, { headers: { "content-type": "text/html; charset=utf-8", "content-security-policy": landingCsp(nonce, false).replace("form-action 'self'", "form-action 'none'"), "cache-control": "no-store" } });
});

function hasFormBlock(content: LC) {
  return content.blocks.some((b) => b.type === "form");
}

landings.post("/landings/:landingId/publish", requireScope("landings:publish"), async (c) => {
  const t = c.get("tenant");
  const user = c.get("user")!;
  const p = await loadPage(c, t.orgId);
  const { versionId } = await parseBody(c, z.strictObject({ versionId: z.string().optional() }));
  const v = await loadVersion(c.env, t.orgId, p.id, versionId ? assertUuid(versionId, "Versión") : p.draft_version_id);
  if (!v) throw notFound("Versión");
  if (hasFormBlock(v.content) && !(await loadForm(c.env, t.orgId, p.form_id))) throw new ApiError(422, "form_required", "La landing tiene un bloque de formulario: elige un formulario activo del CRM antes de publicar.");
  if (p.experiment_status === "running") throw new ApiError(409, "experiment_running", "Hay un test A/B en marcha: páralo antes de publicar otra versión.");
  const now = nowIso();
  await c.env.DB.batch([
    c.env.DB.prepare("UPDATE landing_pages SET status = 'published', published_version_id = ?, published_at = ?, updated_at = ? WHERE organization_id = ? AND id = ?").bind(v.id, now, now, t.orgId, p.id),
    auditStmt(c.env.DB, { organizationId: t.orgId, actorUserId: user.id, action: "landing.publish", entityType: "landing", entityId: p.id, after: { versionId: v.id, version: v.version, slug: p.slug }, requestId: c.get("requestId") }),
  ]);
  const o = await orgSlug(c.env, t.orgId);
  return c.json({ ok: true, url: publicUrl(c.env, o.slug, p.slug), version: v.version });
});

landings.post("/landings/:landingId/unpublish", requireScope("landings:publish"), async (c) => {
  const t = c.get("tenant");
  const p = await loadPage(c, t.orgId);
  await c.env.DB.batch([
    c.env.DB.prepare("UPDATE landing_pages SET status = 'unpublished', experiment_status = CASE WHEN experiment_status = 'running' THEN 'stopped' ELSE experiment_status END, updated_at = ? WHERE organization_id = ? AND id = ?").bind(nowIso(), t.orgId, p.id),
    auditStmt(c.env.DB, { organizationId: t.orgId, actorUserId: c.get("user")!.id, action: "landing.unpublish", entityType: "landing", entityId: p.id, after: { slug: p.slug }, requestId: c.get("requestId") }),
  ]);
  return c.json({ ok: true });
});

const ExperimentInput = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("start"), variantBVersionId: z.string(), split: z.number().int().min(5).max(95).default(50), hypothesis: z.string().trim().min(10, "Escribe la hipótesis (qué cambias y qué esperas).").max(500) }),
  z.strictObject({ action: z.literal("stop") }),
  z.strictObject({ action: z.literal("promote_b") }),
]);
landings.post("/landings/:landingId/experiment", requireScope("landings:publish"), async (c) => {
  const t = c.get("tenant");
  const user = c.get("user")!;
  const p = await loadPage(c, t.orgId);
  const b = await parseBody(c, ExperimentInput);
  const now = nowIso();
  if (b.action === "start") {
    if (p.status !== "published" || !p.published_version_id) throw new ApiError(409, "not_published", "Publica la landing (variante A) antes de empezar un test.");
    if (p.experiment_status === "running") throw new ApiError(409, "experiment_running", "Ya hay un test en marcha.");
    const vb = await loadVersion(c.env, t.orgId, p.id, assertUuid(b.variantBVersionId, "Versión"));
    if (!vb) throw notFound("Versión");
    if (vb.id === p.published_version_id) throw new ApiError(422, "same_version", "La variante B debe ser una versión distinta de la publicada.");
    if (hasFormBlock(vb.content) !== hasFormBlock((await loadVersion(c.env, t.orgId, p.id, p.published_version_id))!.content)) throw new ApiError(422, "form_mismatch", "Las dos variantes deben tener formulario para poder comparar conversiones.");
    await c.env.DB.batch([
      c.env.DB.prepare("UPDATE landing_pages SET experiment_status = 'running', variant_b_version_id = ?, split_b = ?, experiment_started_at = ?, experiment_hypothesis = ?, updated_at = ? WHERE organization_id = ? AND id = ?").bind(vb.id, b.split, now, b.hypothesis, now, t.orgId, p.id),
      auditStmt(c.env.DB, { organizationId: t.orgId, actorUserId: user.id, action: "landing.experiment_start", entityType: "landing", entityId: p.id, after: { variantB: vb.version, split: b.split }, requestId: c.get("requestId") }),
    ]);
  } else if (b.action === "stop") {
    if (p.experiment_status !== "running") throw new ApiError(409, "no_experiment", "No hay ningún test en marcha.");
    await c.env.DB.batch([
      c.env.DB.prepare("UPDATE landing_pages SET experiment_status = 'stopped', updated_at = ? WHERE organization_id = ? AND id = ?").bind(now, t.orgId, p.id),
      auditStmt(c.env.DB, { organizationId: t.orgId, actorUserId: user.id, action: "landing.experiment_stop", entityType: "landing", entityId: p.id, after: { result: (await stats(c.env, t.orgId, p)).test?.verdict ?? null }, requestId: c.get("requestId") }),
    ]);
  } else {
    if (!p.variant_b_version_id || p.experiment_status === "none") throw new ApiError(409, "no_experiment", "No hay variante B que aplicar.");
    await c.env.DB.batch([
      c.env.DB.prepare("UPDATE landing_pages SET published_version_id = variant_b_version_id, experiment_status = 'stopped', published_at = ?, updated_at = ? WHERE organization_id = ? AND id = ?").bind(now, now, t.orgId, p.id),
      auditStmt(c.env.DB, { organizationId: t.orgId, actorUserId: user.id, action: "landing.experiment_promote_b", entityType: "landing", entityId: p.id, after: { versionId: p.variant_b_version_id }, requestId: c.get("requestId") }),
    ]);
  }
  return c.json({ ok: true });
});

// ── Public page ────────────────────────────────────────────────────────────────────────────────────
const BOT_UA = /bot|crawl|spider|slurp|preview|facebookexternalhit|headless|lighthouse|monitor|curl|wget|python|go-http/i;

const notFoundPage = () =>
  new Response('<!doctype html><html lang="es"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>Página no disponible</title><body style="font:16px system-ui;padding:3rem;text-align:center"><h1>Página no disponible</h1><p>Esta página no existe o ya no está publicada.</p></body></html>', {
    status: 404,
    headers: { "content-type": "text/html; charset=utf-8", "content-security-policy": "default-src 'none'; base-uri 'none'", "cache-control": "no-store" },
  });

export async function servePublicLanding(c: Context<AppEnv>): Promise<Response> {
  const orgSlugParam = c.req.param("orgSlug") ?? "";
  const slug = c.req.param("slug") ?? "";
  if (!/^[a-z0-9-]{1,80}$/.test(orgSlugParam) || !LANDING_SLUG.safeParse(slug).success) return notFoundPage();
  // Suspended or deleted organisations do not serve public pages.
  const org = await c.env.DB.prepare("SELECT id, name FROM organizations WHERE slug = ? AND status = 'active' AND deleted_at IS NULL").bind(orgSlugParam).first<{ id: string; name: string }>();
  if (!org) return notFoundPage();
  const p = await c.env.DB.prepare(`SELECT ${PAGE_COLS} FROM landing_pages WHERE organization_id = ? AND slug = ? AND status = 'published'`).bind(org.id, slug).first<PageRow>();
  if (!p?.published_version_id) return notFoundPage();
  let variant: "A" | "B" = "A";
  let versionId = p.published_version_id;
  const ipHash = (await hashIp(c.env, c.req.header("cf-connecting-ip"))) ?? "noip";
  if (p.experiment_status === "running" && p.variant_b_version_id) {
    // Deterministic per connection and page, without cookies.
    const bucket = parseInt(ipHash.slice(0, 8), 16) % 100;
    if (bucket < p.split_b) {
      variant = "B";
      versionId = p.variant_b_version_id;
    }
  }
  const v = await loadVersion(c.env, org.id, p.id, versionId);
  if (!v) return notFoundPage();
  if (c.req.method === "GET" && !BOT_UA.test(c.req.header("user-agent") ?? "")) {
    const day = nowIso().slice(0, 10);
    try {
      await c.env.DB.prepare(
        `INSERT INTO landing_stats_daily (organization_id, landing_id, day, variant, version_id, views) VALUES (?, ?, ?, ?, ?, 1)
         ON CONFLICT(landing_id, day, variant, version_id) DO UPDATE SET views = views + 1`,
      )
        .bind(org.id, p.id, day, variant, versionId)
        .run();
    } catch {
      /* counting must never break the page */
    }
  }
  const nonce = uuid().replace(/-/g, "");
  const html = renderLanding({ content: v.content, orgName: org.name, canonicalUrl: publicUrl(c.env, orgSlugParam, slug), noindex: !!p.noindex, form: await loadForm(c.env, org.id, p.form_id), landingId: p.id, variant, nonce });
  return new Response(html, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "content-security-policy": landingCsp(nonce, false),
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "referrer-policy": "strict-origin-when-cross-origin",
      "x-frame-options": "DENY",
      "permissions-policy": "camera=(), microphone=(), geolocation=(), interest-cohort=()",
    },
  });
}

/** Called by the public form handler after a valid (non-spam) submission coming from a landing. */
export async function recordLandingConversion(env: Env, orgId: string, landingId: unknown, variant: unknown): Promise<{ landingId: string; variant: "A" | "B" } | null> {
  if (typeof landingId !== "string" || !/^[0-9a-f-]{36}$/i.test(landingId) || (variant !== "A" && variant !== "B")) return null;
  const p = await env.DB.prepare("SELECT id, published_version_id, variant_b_version_id, experiment_status FROM landing_pages WHERE organization_id = ? AND id = ? AND status = 'published'")
    .bind(orgId, landingId)
    .first<{ id: string; published_version_id: string | null; variant_b_version_id: string | null; experiment_status: string }>();
  if (!p) return null;
  const versionId = variant === "B" ? p.variant_b_version_id : p.published_version_id;
  if (!versionId || (variant === "B" && p.experiment_status !== "running")) return null;
  await env.DB.prepare(
    `INSERT INTO landing_stats_daily (organization_id, landing_id, day, variant, version_id, conversions) VALUES (?, ?, ?, ?, ?, 1)
     ON CONFLICT(landing_id, day, variant, version_id) DO UPDATE SET conversions = conversions + 1`,
  )
    .bind(orgId, p.id, nowIso().slice(0, 10), variant, versionId)
    .run();
  return { landingId: p.id, variant };
}

