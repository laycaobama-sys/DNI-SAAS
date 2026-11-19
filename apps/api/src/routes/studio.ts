import { Hono } from "hono";
import { z } from "zod";
import { AdCampaignInput, AdCreativeInput, projectDurationMs, projectToSrt, scopesFor, spendGuardianCheck, utmCampaignSlug, VideoProject } from "@dni/core";
import type { AppEnv } from "../env";
import { auditStmt } from "../lib/audit";
import { orgPlan } from "../lib/billing";
import { ApiError, assertUuid, forbidden, notFound, parseBody } from "../lib/http";
import { rateLimit } from "../lib/ratelimit";
import { nowIso, parseJson, uuid } from "../lib/util";
import { requireScope } from "../middleware";

/**
 * F6 Ads Manager (drafts, review, Spend Guardian, export for manual upload — no ad platform is
 * called and nothing is ever spent from here) and F4 Video Studio (projects + media; rendering
 * happens in the user's browser, so it costs nothing on the server).
 */
export const studio = new Hono<AppEnv>();

// ── Ads Manager ─────────────────────────────────────────────────────────────────────────────────
type CampaignRow = {
  id: string; name: string; platform: string; objective: string; status: string; daily_budget_cents: number; start_date: string | null; end_date: string | null;
  audience_json: string; landing_id: string | null; destination_url: string | null; utm_campaign: string | null; notes: string | null; review_note: string | null;
  submitted_by: string | null; approved_by: string | null; approved_at: string | null; created_at: string; updated_at: string;
};
const CAMPAIGN_COLS = "id, name, platform, objective, status, daily_budget_cents, start_date, end_date, audience_json, landing_id, destination_url, utm_campaign, notes, review_note, submitted_by, approved_by, approved_at, created_at, updated_at";

async function loadCampaign(db: D1Database, orgId: string, id: string | undefined) {
  const r = await db.prepare(`SELECT ${CAMPAIGN_COLS} FROM ad_campaigns WHERE organization_id = ? AND id = ?`).bind(orgId, assertUuid(id, "Campaña")).first<CampaignRow>();
  if (!r) throw notFound("Campaña");
  return r;
}

async function guardian(db: D1Database, orgId: string) {
  const g = await db.prepare("SELECT max_daily_cents, max_campaign_daily_cents, kill_switch, updated_at FROM spend_guardian WHERE organization_id = ?").bind(orgId).first<{ max_daily_cents: number; max_campaign_daily_cents: number; kill_switch: number; updated_at: string }>();
  return { maxDailyCents: g?.max_daily_cents ?? 0, maxCampaignDailyCents: g?.max_campaign_daily_cents ?? 0, killSwitch: g ? !!g.kill_switch : true, updatedAt: g?.updated_at ?? null };
}

/** Final URL with UTM parameters, so leads from the ad are attributed in the CRM. */
async function finalUrl(c: { env: AppEnv["Bindings"] }, orgId: string, r: Pick<CampaignRow, "landing_id" | "destination_url" | "platform" | "utm_campaign">) {
  let base = r.destination_url;
  if (r.landing_id) {
    const lp = await c.env.DB.prepare("SELECT l.slug, o.slug AS org_slug FROM landing_pages l JOIN organizations o ON o.id = l.organization_id WHERE l.organization_id = ? AND l.id = ?").bind(orgId, r.landing_id).first<{ slug: string; org_slug: string }>();
    if (lp) base = `${c.env.APP_ORIGIN}/l/${lp.org_slug}/${lp.slug}`;
  }
  if (!base) return null;
  const u = new URL(base);
  u.searchParams.set("utm_source", r.platform);
  u.searchParams.set("utm_medium", "paid_social");
  if (r.platform === "google") u.searchParams.set("utm_medium", "cpc");
  if (r.utm_campaign) u.searchParams.set("utm_campaign", r.utm_campaign);
  return u.toString();
}

const shapeCampaign = (r: CampaignRow) => ({ ...r, dailyBudgetEur: r.daily_budget_cents / 100, audience: parseJson(r.audience_json, {}) });

studio.get("/ads/overview", requireScope("content:read"), async (c) => {
  const t = c.get("tenant");
  const db = c.env.DB;
  const [campaigns, creatives, landings] = await Promise.all([
    db.prepare(`SELECT ${CAMPAIGN_COLS} FROM ad_campaigns WHERE organization_id = ? AND status != 'archived' ORDER BY updated_at DESC LIMIT 200`).bind(t.orgId).all<CampaignRow>(),
    db.prepare("SELECT id, campaign_id, format, headline, primary_text, description, cta, media_id, created_at FROM ad_creatives WHERE organization_id = ? ORDER BY created_at").bind(t.orgId).all<{ campaign_id: string }>(),
    db.prepare("SELECT id, name, slug, status FROM landing_pages WHERE organization_id = ? AND status != 'archived' ORDER BY name").bind(t.orgId).all(),
  ]);
  const g = await guardian(db, t.orgId);
  const approvedDaily = campaigns.results.filter((r) => r.status === "approved").reduce((a, r) => a + r.daily_budget_cents, 0);
  return c.json({
    campaigns: await Promise.all(campaigns.results.map(async (r) => ({ ...shapeCampaign(r), creatives: creatives.results.filter((x) => x.campaign_id === r.id), finalUrl: await finalUrl(c, t.orgId, r) }))),
    guardian: { ...g, approvedDailyCents: approvedDaily },
    landings: landings.results,
    connectors: [
      { platform: "meta", status: "blocked_external", note: "Publicar en Meta requiere app verificada por Meta (Marketing API, revisión de permisos ads_management). Mientras tanto: exporta el paquete y súbelo en el Administrador de anuncios." },
      { platform: "google", status: "blocked_external", note: "Publicar en Google Ads requiere developer token aprobado por Google. Mientras tanto: exporta el paquete y créalo en Google Ads." },
    ],
    note: "Los presupuestos son PROPUESTAS. DNI Growth no gasta dinero ni publica anuncios desde aquí.",
  });
});

async function validateLanding(db: D1Database, orgId: string, landingId: string | null | undefined) {
  if (!landingId) return;
  const ok = await db.prepare("SELECT 1 AS ok FROM landing_pages WHERE organization_id = ? AND id = ?").bind(orgId, landingId).first();
  if (!ok) throw new ApiError(422, "invalid_landing", "Esa landing no pertenece a tu organización.");
}

studio.post("/ads/campaigns", requireScope("ads:draft"), async (c) => {
  const t = c.get("tenant");
  const b = await parseBody(c, AdCampaignInput);
  await validateLanding(c.env.DB, t.orgId, b.landingId);
  const n = await c.env.DB.prepare("SELECT COUNT(*) AS n FROM ad_campaigns WHERE organization_id = ? AND status != 'archived'").bind(t.orgId).first<{ n: number }>();
  if ((n?.n ?? 0) >= 200) throw new ApiError(402, "plan_limit", "Máximo de 200 borradores de campaña activos.");
  const id = uuid();
  const now = nowIso();
  await c.env.DB.batch([
    c.env.DB.prepare(
      "INSERT INTO ad_campaigns (id, organization_id, name, platform, objective, status, daily_budget_cents, start_date, end_date, audience_json, landing_id, destination_url, utm_campaign, notes, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).bind(id, t.orgId, b.name, b.platform, b.objective, Math.round(b.dailyBudgetEur * 100), b.startDate ?? null, b.endDate ?? null, JSON.stringify(b.audience), b.landingId ?? null, b.destinationUrl ?? null, utmCampaignSlug(b.name) || "campana", b.notes ?? null, t.userId, now, now),
    auditStmt(c.env.DB, { organizationId: t.orgId, actorUserId: t.userId, action: "ads.campaign_draft", entityType: "ad_campaign", entityId: id, after: { platform: b.platform, dailyBudgetEur: b.dailyBudgetEur }, requestId: c.get("requestId") }),
  ]);
  return c.json({ id }, 201);
});

studio.put("/ads/campaigns/:id", requireScope("ads:draft"), async (c) => {
  const t = c.get("tenant");
  const r = await loadCampaign(c.env.DB, t.orgId, c.req.param("id"));
  if (!["draft", "changes_requested"].includes(r.status)) throw new ApiError(409, "not_editable", "Solo se editan borradores o campañas con cambios solicitados.");
  const b = await parseBody(c, AdCampaignInput);
  await validateLanding(c.env.DB, t.orgId, b.landingId);
  await c.env.DB.prepare(
    "UPDATE ad_campaigns SET name = ?, platform = ?, objective = ?, daily_budget_cents = ?, start_date = ?, end_date = ?, audience_json = ?, landing_id = ?, destination_url = ?, utm_campaign = ?, notes = ?, updated_at = ? WHERE organization_id = ? AND id = ?",
  )
    .bind(b.name, b.platform, b.objective, Math.round(b.dailyBudgetEur * 100), b.startDate ?? null, b.endDate ?? null, JSON.stringify(b.audience), b.landingId ?? null, b.destinationUrl ?? null, utmCampaignSlug(b.name) || "campana", b.notes ?? null, nowIso(), t.orgId, r.id)
    .run();
  return c.json({ ok: true });
});

studio.post("/ads/campaigns/:id/creatives", requireScope("ads:draft"), async (c) => {
  const t = c.get("tenant");
  const r = await loadCampaign(c.env.DB, t.orgId, c.req.param("id"));
  if (!["draft", "changes_requested"].includes(r.status)) throw new ApiError(409, "not_editable", "La campaña ya está en revisión o aprobada.");
  const b = await parseBody(c, AdCreativeInput);
  if (b.mediaId) {
    const ok = await c.env.DB.prepare("SELECT 1 AS ok FROM ai_images WHERE organization_id = ? AND id = ? UNION SELECT 1 AS ok FROM media_uploads WHERE organization_id = ? AND id = ?").bind(t.orgId, b.mediaId, t.orgId, b.mediaId).first();
    if (!ok) throw new ApiError(422, "invalid_media", "Esa imagen no pertenece a tu organización.");
  }
  const n = await c.env.DB.prepare("SELECT COUNT(*) AS n FROM ad_creatives WHERE organization_id = ? AND campaign_id = ?").bind(t.orgId, r.id).first<{ n: number }>();
  if ((n?.n ?? 0) >= 10) throw new ApiError(409, "too_many", "Máximo 10 anuncios por campaña.");
  const id = uuid();
  await c.env.DB.prepare("INSERT INTO ad_creatives (id, organization_id, campaign_id, format, headline, primary_text, description, cta, media_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .bind(id, t.orgId, r.id, b.format, b.headline, b.primaryText, b.description ?? null, b.cta, b.mediaId ?? null, nowIso())
    .run();
  return c.json({ id }, 201);
});

studio.delete("/ads/creatives/:id", requireScope("ads:draft"), async (c) => {
  const t = c.get("tenant");
  const id = assertUuid(c.req.param("id"), "Anuncio");
  const r = await c.env.DB.prepare(
    "DELETE FROM ad_creatives WHERE organization_id = ? AND id = ? AND campaign_id IN (SELECT id FROM ad_campaigns WHERE organization_id = ? AND status IN ('draft','changes_requested'))",
  )
    .bind(t.orgId, id, t.orgId)
    .run();
  if (!r.meta.changes) throw notFound("Anuncio");
  return c.json({ ok: true });
});

studio.post("/ads/campaigns/:id/submit", requireScope("ads:draft"), async (c) => {
  const t = c.get("tenant");
  const r = await loadCampaign(c.env.DB, t.orgId, c.req.param("id"));
  if (!["draft", "changes_requested"].includes(r.status)) throw new ApiError(409, "invalid_state", "La campaña ya está enviada.");
  const n = await c.env.DB.prepare("SELECT COUNT(*) AS n FROM ad_creatives WHERE organization_id = ? AND campaign_id = ?").bind(t.orgId, r.id).first<{ n: number }>();
  if (!n?.n) throw new ApiError(422, "no_creatives", "Añade al menos un anuncio antes de enviar a revisión.");
  if (!r.landing_id && !r.destination_url) throw new ApiError(422, "no_destination", "Indica una landing o una URL de destino.");
  await c.env.DB.batch([
    c.env.DB.prepare("UPDATE ad_campaigns SET status = 'in_review', submitted_by = ?, review_note = NULL, updated_at = ? WHERE organization_id = ? AND id = ?").bind(t.userId, nowIso(), t.orgId, r.id),
    auditStmt(c.env.DB, { organizationId: t.orgId, actorUserId: t.userId, action: "ads.campaign_submit", entityType: "ad_campaign", entityId: r.id, requestId: c.get("requestId") }),
  ]);
  return c.json({ ok: true });
});

studio.post("/ads/campaigns/:id/review", requireScope("ads:approve"), async (c) => {
  const t = c.get("tenant");
  const r = await loadCampaign(c.env.DB, t.orgId, c.req.param("id"));
  const b = await parseBody(c, z.strictObject({ decision: z.enum(["approve", "changes"]), note: z.string().trim().max(500).optional() }));
  if (r.status !== "in_review") throw new ApiError(409, "invalid_state", "La campaña no está en revisión.");
  // Separation of duties: whoever submitted cannot approve, except the owner of a one-person team.
  if (b.decision === "approve" && r.submitted_by === t.userId && t.role !== "owner") throw forbidden("Otra persona del equipo debe aprobar la campaña que tú enviaste.");
  if (b.decision === "approve") {
    const g = await guardian(c.env.DB, t.orgId);
    const other = await c.env.DB.prepare("SELECT COALESCE(SUM(daily_budget_cents), 0) AS s FROM ad_campaigns WHERE organization_id = ? AND status = 'approved' AND id != ?").bind(t.orgId, r.id).first<{ s: number }>();
    const problems = spendGuardianCheck(g, r.daily_budget_cents, other?.s ?? 0);
    if (problems.length) throw new ApiError(422, "spend_guardian", problems.join(" "), { problems });
  }
  const now = nowIso();
  await c.env.DB.batch([
    b.decision === "approve"
      ? c.env.DB.prepare("UPDATE ad_campaigns SET status = 'approved', approved_by = ?, approved_at = ?, review_note = ?, updated_at = ? WHERE organization_id = ? AND id = ?").bind(t.userId, now, b.note ?? null, now, t.orgId, r.id)
      : c.env.DB.prepare("UPDATE ad_campaigns SET status = 'changes_requested', review_note = ?, updated_at = ? WHERE organization_id = ? AND id = ?").bind(b.note ?? null, now, t.orgId, r.id),
    auditStmt(c.env.DB, { organizationId: t.orgId, actorUserId: t.userId, action: b.decision === "approve" ? "ads.campaign_approve" : "ads.campaign_request_changes", entityType: "ad_campaign", entityId: r.id, after: { dailyBudgetEur: r.daily_budget_cents / 100 }, requestId: c.get("requestId") }),
  ]);
  return c.json({ ok: true });
});

studio.post("/ads/campaigns/:id/archive", requireScope("ads:draft"), async (c) => {
  const t = c.get("tenant");
  const r = await loadCampaign(c.env.DB, t.orgId, c.req.param("id"));
  await c.env.DB.batch([
    c.env.DB.prepare("UPDATE ad_campaigns SET status = 'archived', updated_at = ? WHERE organization_id = ? AND id = ?").bind(nowIso(), t.orgId, r.id),
    auditStmt(c.env.DB, { organizationId: t.orgId, actorUserId: t.userId, action: "ads.campaign_archive", entityType: "ad_campaign", entityId: r.id, requestId: c.get("requestId") }),
  ]);
  return c.json({ ok: true });
});

studio.get("/ads/campaigns/:id/export", requireScope("content:read"), async (c) => {
  const t = c.get("tenant");
  const r = await loadCampaign(c.env.DB, t.orgId, c.req.param("id"));
  if (r.status !== "approved") throw new ApiError(409, "not_approved", "Solo se exportan campañas aprobadas.");
  const { results } = await c.env.DB.prepare("SELECT format, headline, primary_text, description, cta, media_id FROM ad_creatives WHERE organization_id = ? AND campaign_id = ? ORDER BY created_at").bind(t.orgId, r.id).all();
  const pack = {
    generated_at: nowIso(),
    disclaimer: "Paquete para subir MANUALMENTE en la plataforma publicitaria. DNI Growth no ha publicado ni gastado nada.",
    campaign: { name: r.name, platform: r.platform, objective: r.objective, proposed_daily_budget_eur: r.daily_budget_cents / 100, start_date: r.start_date, end_date: r.end_date, audience: parseJson(r.audience_json, {}), final_url: await finalUrl(c, t.orgId, r), approved_at: r.approved_at },
    ads: results,
  };
  return new Response(JSON.stringify(pack, null, 2), { headers: { "content-type": "application/json; charset=utf-8", "content-disposition": `attachment; filename="campana-${r.utm_campaign ?? r.id.slice(0, 8)}.json"`, "cache-control": "no-store" } });
});

const GuardianInput = z.strictObject({ maxDailyEur: z.number().min(0).max(1_000_000), maxCampaignDailyEur: z.number().min(0).max(1_000_000), killSwitch: z.boolean() });
studio.get("/ads/guardian", requireScope("content:read"), async (c) => c.json(await guardian(c.env.DB, c.get("tenant").orgId)));
studio.put("/ads/guardian", requireScope("ads:emergency_stop"), async (c) => {
  const t = c.get("tenant");
  const b = await parseBody(c, GuardianInput);
  // Turning the kill switch ON is always allowed with ads:emergency_stop; changing limits or turning it OFF needs ads:approve too.
  const before = await guardian(c.env.DB, t.orgId);
  const relaxes = !b.killSwitch || b.maxDailyEur * 100 !== before.maxDailyCents || b.maxCampaignDailyEur * 100 !== before.maxCampaignDailyCents;
  const scopes: readonly string[] = scopesFor(t.role);
  if (relaxes && !scopes.includes("ads:approve")) throw forbidden("Cambiar límites o desactivar el interruptor requiere permiso de aprobación de anuncios.");
  const now = nowIso();
  await c.env.DB.batch([
    c.env.DB.prepare(
      "INSERT INTO spend_guardian (organization_id, max_daily_cents, max_campaign_daily_cents, kill_switch, updated_by, updated_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(organization_id) DO UPDATE SET max_daily_cents = excluded.max_daily_cents, max_campaign_daily_cents = excluded.max_campaign_daily_cents, kill_switch = excluded.kill_switch, updated_by = excluded.updated_by, updated_at = excluded.updated_at",
    ).bind(t.orgId, Math.round(b.maxDailyEur * 100), Math.round(b.maxCampaignDailyEur * 100), b.killSwitch ? 1 : 0, t.userId, now),
    auditStmt(c.env.DB, { organizationId: t.orgId, actorUserId: t.userId, action: "ads.spend_guardian_update", entityType: "spend_guardian", entityId: t.orgId, before, after: b, requestId: c.get("requestId") }),
  ]);
  return c.json(await guardian(c.env.DB, t.orgId));
});

// ── Media uploads (images/audio for video and ads) ─────────────────────────────────────────────
const MEDIA_TYPES: Record<string, { kind: "image" | "audio"; max: number; magic: (b: Uint8Array) => boolean }> = {
  "image/png": { kind: "image", max: 5_000_000, magic: (b) => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 },
  "image/jpeg": { kind: "image", max: 5_000_000, magic: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  "image/webp": { kind: "image", max: 5_000_000, magic: (b) => ascii(b, 0, 4) === "RIFF" && ascii(b, 8, 12) === "WEBP" },
  "audio/mpeg": { kind: "audio", max: 15_000_000, magic: (b) => ascii(b, 0, 3) === "ID3" || (b[0] === 0xff && ((b[1] ?? 0) & 0xe0) === 0xe0) },
  "audio/wav": { kind: "audio", max: 15_000_000, magic: (b) => ascii(b, 0, 4) === "RIFF" && ascii(b, 8, 12) === "WAVE" },
  "audio/ogg": { kind: "audio", max: 15_000_000, magic: (b) => ascii(b, 0, 4) === "OggS" },
};
function ascii(b: Uint8Array, from: number, to: number) {
  return String.fromCharCode(...b.slice(from, to));
}
export const MEDIA_MAX_FILES = 300;

studio.get("/media", requireScope("content:read"), async (c) => {
  const t = c.get("tenant");
  const { results } = await c.env.DB.prepare("SELECT id, kind, content_type, bytes, name, created_at FROM media_uploads WHERE organization_id = ? ORDER BY created_at DESC LIMIT 300").bind(t.orgId).all<{ id: string }>();
  const { results: generated } = await c.env.DB.prepare("SELECT id, prompt, created_at FROM ai_images WHERE organization_id = ? ORDER BY created_at DESC LIMIT 60").bind(t.orgId).all<{ id: string }>();
  return c.json({
    uploads: results.map((r) => ({ ...r, url: `/api/v1/orgs/${t.orgId}/media/${r.id}/file` })),
    generated: generated.map((r) => ({ ...r, url: `/api/v1/orgs/${t.orgId}/creative/images/${r.id}/file` })),
    storage: c.env.MEDIA ? "available" : "not_configured",
  });
});

studio.post("/media", requireScope("content:write"), async (c) => {
  const t = c.get("tenant");
  if (!c.env.MEDIA) throw new ApiError(503, "storage_unavailable", "El almacenamiento de archivos no está configurado.");
  await rateLimit(c.env.DB, `media-upload:${t.orgId}`, 100, 86400);
  const len = Number(c.req.header("content-length") ?? "0");
  if (len > 16_000_000) throw new ApiError(413, "too_large", "El archivo supera el tamaño máximo (15 MB audio, 5 MB imagen).");
  const form = await c.req.formData().catch(() => null);
  const file = form?.get("file");
  if (!form || !file || typeof file === "string") throw new ApiError(400, "no_file", "Adjunta un archivo.");
  if (form.get("rightsConfirmed") !== "true") throw new ApiError(422, "rights_required", "Confirma que tienes derechos de uso sobre el archivo.");
  const spec = MEDIA_TYPES[file.type];
  if (!spec) throw new ApiError(415, "unsupported_type", "Formato no admitido. Imágenes PNG, JPG o WebP; audio MP3, WAV u OGG.");
  if (file.size > spec.max) throw new ApiError(413, "too_large", "El archivo supera el tamaño máximo.");
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (!spec.magic(bytes)) throw new ApiError(415, "content_mismatch", "El contenido del archivo no coincide con su tipo.");
  const n = await c.env.DB.prepare("SELECT COUNT(*) AS n FROM media_uploads WHERE organization_id = ?").bind(t.orgId).first<{ n: number }>();
  if ((n?.n ?? 0) >= MEDIA_MAX_FILES) throw new ApiError(402, "plan_limit", `Máximo ${MEDIA_MAX_FILES} archivos subidos. Borra alguno.`);
  const id = uuid();
  const key = `media/${t.orgId}/uploads/${id}`;
  await c.env.MEDIA.put(key, bytes, { httpMetadata: { contentType: file.type }, customMetadata: { organizationId: t.orgId } });
  const name = (file.name || "archivo").replace(/[^\p{L}\p{N}._ -]/gu, "").slice(0, 120) || "archivo";
  await c.env.DB.batch([
    c.env.DB.prepare("INSERT INTO media_uploads (id, organization_id, r2_key, kind, content_type, bytes, name, rights_confirmed, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)").bind(id, t.orgId, key, spec.kind, file.type, bytes.byteLength, name, t.userId, nowIso()),
    auditStmt(c.env.DB, { organizationId: t.orgId, actorUserId: t.userId, action: "media.upload", entityType: "media_upload", entityId: id, after: { kind: spec.kind, bytes: bytes.byteLength, rightsConfirmed: true }, requestId: c.get("requestId") }),
  ]);
  return c.json({ id, kind: spec.kind, url: `/api/v1/orgs/${t.orgId}/media/${id}/file` }, 201);
});

studio.get("/media/:id/file", requireScope("content:read"), async (c) => {
  const t = c.get("tenant");
  const row = await c.env.DB.prepare("SELECT r2_key, content_type FROM media_uploads WHERE organization_id = ? AND id = ?").bind(t.orgId, assertUuid(c.req.param("id"), "Archivo")).first<{ r2_key: string; content_type: string }>();
  if (!row || !row.r2_key.startsWith(`media/${t.orgId}/`) || !c.env.MEDIA) throw notFound("Archivo");
  const obj = await c.env.MEDIA.get(row.r2_key);
  if (!obj) throw notFound("Archivo");
  return new Response(obj.body, { headers: { "content-type": row.content_type, "cache-control": "private, max-age=3600", "x-content-type-options": "nosniff", "content-disposition": "inline" } });
});

studio.delete("/media/:id", requireScope("content:write"), async (c) => {
  const t = c.get("tenant");
  const row = await c.env.DB.prepare("SELECT id, r2_key FROM media_uploads WHERE organization_id = ? AND id = ?").bind(t.orgId, assertUuid(c.req.param("id"), "Archivo")).first<{ id: string; r2_key: string }>();
  if (!row) throw notFound("Archivo");
  if (c.env.MEDIA && row.r2_key.startsWith(`media/${t.orgId}/`)) await c.env.MEDIA.delete(row.r2_key);
  await c.env.DB.batch([
    c.env.DB.prepare("DELETE FROM media_uploads WHERE organization_id = ? AND id = ?").bind(t.orgId, row.id),
    auditStmt(c.env.DB, { organizationId: t.orgId, actorUserId: t.userId, action: "media.delete", entityType: "media_upload", entityId: row.id, requestId: c.get("requestId") }),
  ]);
  return c.json({ ok: true });
});

// ── Video Studio projects ──────────────────────────────────────────────────────────────────────
type VideoRow = { id: string; name: string; aspect: string; project_json: string; version: number; status: string; last_export_json: string | null; created_at: string; updated_at: string };
const VIDEO_COLS = "id, name, aspect, project_json, version, status, last_export_json, created_at, updated_at";
const VideoCreate = z.strictObject({ name: z.string().trim().min(2).max(120), aspect: z.enum(["9:16", "1:1", "4:5", "16:9"]).default("9:16"), project: VideoProject.optional() });
const VideoUpdate = z.strictObject({ name: z.string().trim().min(2).max(120), aspect: z.enum(["9:16", "1:1", "4:5", "16:9"]), project: VideoProject, version: z.number().int().min(1) });

const starterProject = (name: string): VideoProject =>
  VideoProject.parse({
    scenes: [
      { id: "s1", durationMs: 3000, title: name, body: "Tu mensaje principal en una frase.", caption: name },
      { id: "s2", durationMs: 4000, title: "Por qué elegirnos", body: "Un beneficio concreto y verificable.", caption: "Un beneficio concreto y verificable." },
      { id: "s3", durationMs: 3000, title: "Escríbenos hoy", body: "Enlace en la descripción", caption: "Escríbenos hoy", background: "#1f3a2e" },
    ],
  });

async function videoLimit(db: D1Database, orgId: string) {
  const plan = await orgPlan(db, orgId);
  const limit = plan.limits.videoProjects ?? 2;
  const used = (await db.prepare("SELECT COUNT(*) AS n FROM video_projects WHERE organization_id = ? AND status != 'archived'").bind(orgId).first<{ n: number }>())?.n ?? 0;
  return { used, limit };
}
const shapeVideo = (r: VideoRow) => ({ id: r.id, name: r.name, aspect: r.aspect, version: r.version, status: r.status, project: parseJson(r.project_json, null), lastExport: parseJson(r.last_export_json, null), createdAt: r.created_at, updatedAt: r.updated_at });

studio.get("/video/projects", requireScope("content:read"), async (c) => {
  const t = c.get("tenant");
  const { results } = await c.env.DB.prepare(`SELECT ${VIDEO_COLS} FROM video_projects WHERE organization_id = ? AND status != 'archived' ORDER BY updated_at DESC LIMIT 200`).bind(t.orgId).all<VideoRow>();
  return c.json({ projects: results.map((r) => ({ ...shapeVideo(r), durationMs: (() => { const p = VideoProject.safeParse(parseJson(r.project_json, null)); return p.success ? projectDurationMs(p.data) : 0; })() })), usage: await videoLimit(c.env.DB, t.orgId) });
});

studio.post("/video/projects", requireScope("content:write"), async (c) => {
  const t = c.get("tenant");
  const b = await parseBody(c, VideoCreate);
  const u = await videoLimit(c.env.DB, t.orgId);
  if (u.used >= u.limit) throw new ApiError(402, "plan_limit", `Tu plan permite ${u.limit} proyectos de vídeo.`);
  const id = uuid();
  const now = nowIso();
  await c.env.DB.prepare(`INSERT INTO video_projects (id, organization_id, name, aspect, project_json, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(id, t.orgId, b.name, b.aspect, JSON.stringify(b.project ?? starterProject(b.name)), t.userId, now, now)
    .run();
  return c.json({ id }, 201);
});

async function loadVideo(db: D1Database, orgId: string, id: string | undefined) {
  const r = await db.prepare(`SELECT ${VIDEO_COLS} FROM video_projects WHERE organization_id = ? AND id = ?`).bind(orgId, assertUuid(id, "Proyecto")).first<VideoRow>();
  if (!r) throw notFound("Proyecto");
  return r;
}

studio.get("/video/projects/:id", requireScope("content:read"), async (c) => c.json({ project: shapeVideo(await loadVideo(c.env.DB, c.get("tenant").orgId, c.req.param("id"))) }));

studio.put("/video/projects/:id", requireScope("content:write"), async (c) => {
  const t = c.get("tenant");
  const r = await loadVideo(c.env.DB, t.orgId, c.req.param("id"));
  const b = await parseBody(c, VideoUpdate);
  const ids = [...new Set(b.project.scenes.map((s) => s.mediaId).filter(Boolean) as string[]), ...(b.project.audioId ? [b.project.audioId] : [])];
  for (const mid of ids) {
    const ok = await c.env.DB.prepare("SELECT 1 AS ok FROM media_uploads WHERE organization_id = ? AND id = ? UNION SELECT 1 AS ok FROM ai_images WHERE organization_id = ? AND id = ?").bind(t.orgId, mid, t.orgId, mid).first();
    if (!ok) throw new ApiError(422, "invalid_media", "Un archivo del proyecto no pertenece a tu organización.");
  }
  // Optimistic concurrency: a stale editor tab cannot overwrite newer work.
  const res = await c.env.DB.prepare("UPDATE video_projects SET name = ?, aspect = ?, project_json = ?, version = version + 1, updated_at = ? WHERE organization_id = ? AND id = ? AND version = ?")
    .bind(b.name, b.aspect, JSON.stringify(b.project), nowIso(), t.orgId, r.id, b.version)
    .run();
  if (!res.meta.changes) throw new ApiError(409, "version_conflict", "El proyecto cambió en otra pestaña. Recarga para ver la última versión.");
  return c.json({ version: b.version + 1 });
});

studio.post("/video/projects/:id/exported", requireScope("content:write"), async (c) => {
  const t = c.get("tenant");
  const r = await loadVideo(c.env.DB, t.orgId, c.req.param("id"));
  const b = await parseBody(c, z.strictObject({ mimeType: z.string().max(80), bytes: z.number().int().min(0).max(2_000_000_000), durationMs: z.number().int().min(0).max(3_600_000), width: z.number().int().max(4096), height: z.number().int().max(4096) }));
  await c.env.DB.prepare("UPDATE video_projects SET status = 'exported', last_export_json = ?, updated_at = ? WHERE organization_id = ? AND id = ?").bind(JSON.stringify({ ...b, at: nowIso(), renderer: "navegador" }), nowIso(), t.orgId, r.id).run();
  return c.json({ ok: true });
});

studio.get("/video/projects/:id/srt", requireScope("content:read"), async (c) => {
  const t = c.get("tenant");
  const r = await loadVideo(c.env.DB, t.orgId, c.req.param("id"));
  const p = VideoProject.safeParse(parseJson(r.project_json, null));
  if (!p.success) throw new ApiError(422, "invalid_project", "El proyecto no es válido.");
  return new Response(projectToSrt(p.data), { headers: { "content-type": "application/x-subrip; charset=utf-8", "content-disposition": `attachment; filename="subtitulos-${r.id.slice(0, 8)}.srt"`, "cache-control": "no-store" } });
});

studio.post("/video/projects/:id/duplicate", requireScope("content:write"), async (c) => {
  const t = c.get("tenant");
  const r = await loadVideo(c.env.DB, t.orgId, c.req.param("id"));
  const u = await videoLimit(c.env.DB, t.orgId);
  if (u.used >= u.limit) throw new ApiError(402, "plan_limit", `Tu plan permite ${u.limit} proyectos de vídeo.`);
  const id = uuid();
  const now = nowIso();
  await c.env.DB.prepare("INSERT INTO video_projects (id, organization_id, name, aspect, project_json, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").bind(id, t.orgId, `${r.name} (copia)`.slice(0, 120), r.aspect, r.project_json, t.userId, now, now).run();
  return c.json({ id }, 201);
});

studio.delete("/video/projects/:id", requireScope("content:write"), async (c) => {
  const t = c.get("tenant");
  const r = await loadVideo(c.env.DB, t.orgId, c.req.param("id"));
  await c.env.DB.prepare("UPDATE video_projects SET status = 'archived', updated_at = ? WHERE organization_id = ? AND id = ?").bind(nowIso(), t.orgId, r.id).run();
  return c.json({ ok: true });
});
