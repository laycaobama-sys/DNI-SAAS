import { Hono, type Context } from "hono";
import {
  checkDraft,
  ExternalPublishInput,
  ghostInternalTag,
  ghostInternalTagSlug,
  GhostConnectInput,
  markdownToSafeHtml,
  normalizeGhostSite,
  validatePublicUrl,
  WebhookConnectInput,
  WP_PUBLISHABLE_KINDS,
  wpSlug,
  type ExternalCmsProvider,
} from "@dni/core";
import type { AppEnv } from "../env";
import { auditStmt } from "../lib/audit";
import { deliverCmsWebhook, newWebhookSecret, openWebhookCreds, sealWebhookCreds, webhookFriendly, type WebhookCreds } from "../lib/cms-webhook";
import { ghostCreatePost, ghostFindByTag, ghostFriendly, ghostSite, ghostUpdatePost, openGhostCreds, sealGhostCreds, type GhostCreds, type GhostPost } from "../lib/ghost";
import { ApiError, assertUuid, notFound, parseBody } from "../lib/http";
import { rateLimit } from "../lib/ratelimit";
import { log, nowIso, uuid } from "../lib/util";
import { WpError, wpReady } from "../lib/wordpress";
import { requireScope } from "../middleware";
import { blogDescription } from "./site-blog";

/**
 * Ghost and generic webhook publishing (APPROVAL_REQUIRED), same guarantees as WordPress: approved content
 * only, roles with content:approve, one row per content item and provider claimed with a conditional write,
 * audited. «Retirar» makes the Ghost post a draft again, or sends `content.unpublish` to the webhook.
 */
export const cmsExternal = new Hono<AppEnv>();

const STUCK_MS = 3 * 60_000;
/** integrations.provider for each publication provider («webhook» alone is too generic a name there). */
const INTEGRATION: Record<ExternalCmsProvider, string> = { ghost: "ghost", webhook: "cms_webhook" };
const NAME: Record<ExternalCmsProvider, string> = { ghost: "Ghost", webhook: "el webhook" };

interface Conn {
  id: string;
  status: string;
  account_ref: string | null;
  last_error: string | null;
  created_at: string;
}
interface PubRow {
  id: string;
  state: string;
  external_id: string | null;
  external_url: string | null;
  content_version: number | null;
  last_error: string | null;
  published_at: string | null;
  updated_at: string;
}

const isProvider = (p: string): p is ExternalCmsProvider => p === "ghost" || p === "webhook";
const providerParam = (c: Context<AppEnv>): ExternalCmsProvider => {
  const p = c.req.param("provider") ?? "";
  if (!isProvider(p)) throw notFound("Destino");
  return p;
};
const connection = (db: D1Database, orgId: string, p: ExternalCmsProvider) =>
  db.prepare("SELECT id, status, account_ref, last_error, created_at FROM integrations WHERE organization_id = ? AND provider = ?").bind(orgId, INTEGRATION[p]).first<Conn>();
const connOut = (c: Conn | null) => (c && c.status !== "disconnected" ? { status: c.status, target: c.account_ref, connectedAt: c.created_at, lastError: c.last_error } : null);
const loadPub = (db: D1Database, orgId: string, contentId: string, p: ExternalCmsProvider) =>
  db.prepare("SELECT * FROM cms_external_publications WHERE organization_id = ? AND content_id = ? AND provider = ?").bind(orgId, contentId, p).first<PubRow>();
const pubOut = (p: PubRow | null) =>
  p ? { state: p.state, url: p.external_url, externalId: p.external_id, contentVersion: p.content_version, lastError: p.last_error, publishedAt: p.published_at, updatedAt: p.updated_at } : null;

async function secretFor(c: Context<AppEnv>, orgId: string, p: ExternalCmsProvider) {
  const conn = await connection(c.env.DB, orgId, p);
  if (!conn || conn.status === "disconnected") throw new ApiError(409, `${p}_not_connected`, `Conecta primero ${NAME[p]}.`);
  const sec = await c.env.DB.prepare("SELECT ciphertext FROM integration_secrets WHERE organization_id = ? AND integration_id = ?").bind(orgId, conn.id).first<{ ciphertext: string }>();
  if (!sec) throw new ApiError(409, `${p}_reauth`, `Vuelve a conectar ${NAME[p]}.`);
  return { conn, ciphertext: sec.ciphertext };
}

/** Saves (or replaces) the connection and its sealed secret, audited. */
async function saveConnection(c: Context<AppEnv>, p: ExternalCmsProvider, target: string, seal: (integrationId: string) => Promise<string>, auditAfter: Record<string, unknown>) {
  const t = c.get("tenant");
  const db = c.env.DB;
  const existing = await connection(db, t.orgId, p);
  const integrationId = existing?.id ?? uuid();
  const secretId = uuid();
  const sealed = await seal(integrationId);
  await db.batch([
    existing
      ? db.prepare("UPDATE integrations SET status = 'connected', account_ref = ?, secret_ref = ?, last_error = NULL, last_sync_at = ? WHERE organization_id = ? AND id = ?").bind(target, `integration_secrets:${secretId}`, nowIso(), t.orgId, integrationId)
      : db
          .prepare("INSERT INTO integrations (id, organization_id, provider, status, scopes_json, account_ref, secret_ref, last_sync_at) VALUES (?, ?, ?, 'connected', '[]', ?, ?, ?)")
          .bind(integrationId, t.orgId, INTEGRATION[p], target, `integration_secrets:${secretId}`, nowIso()),
    db.prepare("DELETE FROM integration_secrets WHERE organization_id = ? AND integration_id = ?").bind(t.orgId, integrationId),
    db.prepare("INSERT INTO integration_secrets (id, organization_id, integration_id, ciphertext) VALUES (?, ?, ?, ?)").bind(secretId, t.orgId, integrationId, sealed),
    auditStmt(db, { organizationId: t.orgId, actorUserId: t.userId, action: `cms.${p}_connect`, entityType: "integration", entityId: integrationId, after: { target, ...auditAfter }, requestId: c.get("requestId") }),
  ]);
  return existing ? 200 : 201;
}

const requireReady = (c: Context<AppEnv>) => {
  if (!wpReady(c.env)) throw new ApiError(503, "cms_not_configured", "La publicación externa no está activada en este entorno.");
};

cmsExternal.get("/cms/external", requireScope("content:read"), async (c) => {
  const t = c.get("tenant");
  const [ghost, webhook] = await Promise.all([connection(c.env.DB, t.orgId, "ghost"), connection(c.env.DB, t.orgId, "webhook")]);
  return c.json({ ghost: connOut(ghost), webhook: connOut(webhook) });
});

/** Ghost: Admin API key of a custom integration. Checked against /site before saving. */
cmsExternal.post("/cms/ghost", requireScope("integrations:manage"), async (c) => {
  const t = c.get("tenant");
  requireReady(c);
  await rateLimit(c.env.DB, `cms-connect:${t.orgId}`, 10, 3600);
  const input = await parseBody(c, GhostConnectInput);
  const site = normalizeGhostSite(input.apiUrl)!;
  const creds: GhostCreds = { site, key: input.adminKey };
  let title: string | null;
  try {
    title = (await ghostSite(c.get("deps"), creds)).site?.title?.slice(0, 120) ?? null;
  } catch (e) {
    log("info", "cms.ghost_connect_failed", { orgId: t.orgId, code: e instanceof WpError ? e.code : "unknown" });
    throw new ApiError(422, "ghost_connect_failed", ghostFriendly(e));
  }
  const status = await saveConnection(c, "ghost", site, (iid) => sealGhostCreds(c.env, t.orgId, iid, creds), { siteTitle: title });
  return c.json({ ghost: connOut(await connection(c.env.DB, t.orgId, "ghost")) }, status);
});

/** Webhook: https endpoint; a `ping` signed with a new secret must get a 2xx. The secret is shown once. */
cmsExternal.post("/cms/webhook", requireScope("integrations:manage"), async (c) => {
  const t = c.get("tenant");
  requireReady(c);
  await rateLimit(c.env.DB, `cms-connect:${t.orgId}`, 10, 3600);
  const input = await parseBody(c, WebhookConnectInput);
  let url: string;
  try {
    url = validatePublicUrl(input.url).toString();
  } catch {
    throw new ApiError(422, "webhook_url_blocked", "Esa dirección no es pública: no enviamos datos a redes internas.");
  }
  const creds: WebhookCreds = { url, secret: newWebhookSecret() };
  try {
    await deliverCmsWebhook(c.get("deps"), creds, "ping", `ping-${uuid()}`, { organizationId: t.orgId });
  } catch (e) {
    log("info", "cms.webhook_connect_failed", { orgId: t.orgId, code: e instanceof WpError ? e.code : "unknown" });
    throw new ApiError(422, "webhook_connect_failed", webhookFriendly(e));
  }
  const status = await saveConnection(c, "webhook", url, (iid) => sealWebhookCreds(c.env, t.orgId, iid, creds), {});
  return c.json({ webhook: connOut(await connection(c.env.DB, t.orgId, "webhook")), secret: creds.secret }, status);
});

const disconnect = (p: ExternalCmsProvider) => async (c: Context<AppEnv>) => {
  const t = c.get("tenant");
  const db = c.env.DB;
  const conn = await connection(db, t.orgId, p);
  if (!conn || conn.status === "disconnected") throw notFound("Conexión");
  await db.batch([
    db.prepare("DELETE FROM integration_secrets WHERE organization_id = ? AND integration_id = ?").bind(t.orgId, conn.id),
    db.prepare("UPDATE integrations SET status = 'disconnected', secret_ref = NULL, last_error = NULL WHERE organization_id = ? AND id = ?").bind(t.orgId, conn.id),
    auditStmt(db, { organizationId: t.orgId, actorUserId: t.userId, action: `cms.${p}_disconnect`, entityType: "integration", entityId: conn.id, requestId: c.get("requestId") }),
  ]);
  return c.json({ ok: true });
};
cmsExternal.delete("/cms/ghost", requireScope("integrations:manage"), disconnect("ghost"));
cmsExternal.delete("/cms/webhook", requireScope("integrations:manage"), disconnect("webhook"));

cmsExternal.get("/content/:contentId/external", requireScope("content:read"), async (c) => {
  const t = c.get("tenant");
  const db = c.env.DB;
  const id = assertUuid(c.req.param("contentId"), "Contenido");
  const [gc, wc, gp, wp] = await Promise.all([connection(db, t.orgId, "ghost"), connection(db, t.orgId, "webhook"), loadPub(db, t.orgId, id, "ghost"), loadPub(db, t.orgId, id, "webhook")]);
  return c.json({ ghost: { connection: connOut(gc), publication: pubOut(gp) }, webhook: { connection: connOut(wc), publication: pubOut(wp) } });
});

interface Item {
  id: string;
  kind: string;
  title: string;
  body_md: string;
  status: string;
  version: number;
}

/** Sends the approved version, as a draft or published. Creates once, then updates the same post. */
cmsExternal.post("/content/:contentId/external/:provider", requireScope("content:approve"), async (c) => {
  const t = c.get("tenant");
  const db = c.env.DB;
  const deps = c.get("deps");
  const p = providerParam(c);
  const id = assertUuid(c.req.param("contentId"), "Contenido");
  const input = await parseBody(c, ExternalPublishInput);
  await rateLimit(db, `cms-ext-publish:${t.orgId}`, 60, 3600);
  const item = await db.prepare("SELECT id, kind, title, body_md, status, version FROM content_items WHERE organization_id = ? AND id = ?").bind(t.orgId, id).first<Item>();
  if (!item) throw notFound("Contenido");
  if (!(WP_PUBLISHABLE_KINDS as readonly string[]).includes(item.kind)) throw new ApiError(422, "cms_kind", "Este tipo de contenido no se publica como entrada. Expórtalo en HTML.");
  if (item.status !== "approved") throw new ApiError(409, "not_approved", "Publica solo contenido aprobado: envíalo a revisión y apruébalo antes.");
  const blocking = checkDraft(item.body_md).filter((x) => x.level === "blocking");
  if (blocking.length) throw new ApiError(422, "draft_checks_failed", blocking.map((x) => x.message).join(" "), { checks: blocking });
  const { conn, ciphertext } = await secretFor(c, t.orgId, p);

  // Claim: one send at a time per content item and destination.
  const now = nowIso();
  let pub = await loadPub(db, t.orgId, id, p);
  if (!pub) {
    const ins = await db
      .prepare(
        "INSERT INTO cms_external_publications (id, organization_id, content_id, integration_id, provider, state, attempts, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'publishing', 1, ?, ?) ON CONFLICT (organization_id, content_id, provider) DO NOTHING",
      )
      .bind(uuid(), t.orgId, id, conn.id, p, now, now)
      .run();
    pub = await loadPub(db, t.orgId, id, p);
    if (!pub || !ins.meta.changes) throw new ApiError(409, "cms_in_progress", "Ya se está enviando este contenido. Espera unos segundos.");
  } else {
    const claim = await db
      .prepare("UPDATE cms_external_publications SET state = 'publishing', attempts = attempts + 1, integration_id = ?, updated_at = ? WHERE organization_id = ? AND id = ? AND (state <> 'publishing' OR updated_at < ?)")
      .bind(conn.id, now, t.orgId, pub.id, new Date(Date.now() - STUCK_MS).toISOString())
      .run();
    if (!claim.meta.changes) throw new ApiError(409, "cms_in_progress", "Ya se está enviando este contenido. Espera unos segundos.");
  }

  const bodyMd = item.body_md.replace(/^\s*#\s+[^\n]*\n+/, "");
  const html = markdownToSafeHtml(bodyMd);
  const excerpt = blogDescription(bodyMd);
  const slug = wpSlug(item.title);
  try {
    let externalId: string | null = pub.external_id;
    let url: string | null = null;
    let state: "published" | "draft";
    if (p === "ghost") {
      const creds = await openGhostCreds(c.env, t.orgId, conn.id, ciphertext);
      const post = { title: item.title, html, status: input.status === "publish" ? "published" : "draft", custom_excerpt: excerpt.slice(0, 300), meta_title: item.title.slice(0, 300), meta_description: excerpt.slice(0, 500) };
      // A previous attempt may have created it without us hearing back: our internal tag finds it.
      if (!externalId) externalId = (await ghostFindByTag(deps, creds, ghostInternalTagSlug(id)))?.id ?? null;
      let r: GhostPost;
      try {
        r = externalId ? await ghostUpdatePost(deps, creds, externalId, post) : await ghostCreatePost(deps, creds, { ...post, slug, tags: [{ name: ghostInternalTag(id) }] });
      } catch (e) {
        if (externalId && e instanceof WpError && e.status === 404) r = await ghostCreatePost(deps, creds, { ...post, slug, tags: [{ name: ghostInternalTag(id) }] });
        else throw e;
      }
      externalId = r.id;
      url = typeof r.url === "string" && /^https:\/\//.test(r.url) ? r.url.slice(0, 600) : null;
      state = r.status === "published" ? "published" : "draft";
    } else {
      const creds = await openWebhookCreds(c.env, t.orgId, conn.id, ciphertext);
      const jsonld = { "@context": "https://schema.org", "@type": "Article", headline: item.title.slice(0, 110), description: excerpt, inLanguage: "es" };
      const r = await deliverCmsWebhook(deps, creds, "content.publish", `${pub.id}-v${item.version}-${input.status}`, {
        contentId: id,
        kind: item.kind,
        version: item.version,
        status: input.status,
        title: item.title,
        slug,
        excerpt,
        html,
        markdown: bodyMd,
        jsonld,
        approvedAt: now,
      });
      externalId = r.id ?? externalId;
      url = r.url ?? pub.external_url;
      state = input.status === "publish" ? "published" : "draft";
    }
    const at = nowIso();
    await db.batch([
      db
        .prepare(
          "UPDATE cms_external_publications SET state = ?, external_id = ?, external_url = ?, content_version = ?, last_error = NULL, published_by = ?, published_at = CASE WHEN ? = 'published' THEN COALESCE(published_at, ?) ELSE published_at END, updated_at = ? WHERE organization_id = ? AND id = ?",
        )
        .bind(state, externalId, url, item.version, t.userId, state, at, at, t.orgId, pub.id),
      auditStmt(db, {
        organizationId: t.orgId,
        actorUserId: t.userId,
        action: `cms.${p}_publish`,
        entityType: "content_item",
        entityId: id,
        before: pub.external_id ? { externalId: pub.external_id, state: pub.state, version: pub.content_version } : null,
        after: { externalId, state, version: item.version, target: conn.account_ref },
        approvedBy: t.userId,
        requestId: c.get("requestId"),
      }),
    ]);
    return c.json({ publication: pubOut(await loadPub(db, t.orgId, id, p)) });
  } catch (e) {
    const code = e instanceof WpError ? e.code : "unknown";
    log("warn", `cms.${p}_publish_failed`, { orgId: t.orgId, contentId: id, code });
    const msg = p === "ghost" ? ghostFriendly(e) : webhookFriendly(e);
    const stmts = [
      db.prepare("UPDATE cms_external_publications SET state = 'failed', last_error = ?, updated_at = ? WHERE organization_id = ? AND id = ?").bind(msg.slice(0, 400), nowIso(), t.orgId, pub.id),
      auditStmt(db, { organizationId: t.orgId, actorUserId: t.userId, action: `cms.${p}_failed`, entityType: "content_item", entityId: id, after: { code }, requestId: c.get("requestId") }),
    ];
    if (p === "ghost" && e instanceof WpError && (e.status === 401 || e.status === 403)) stmts.push(db.prepare("UPDATE integrations SET status = 'reauth_required', last_error = ? WHERE organization_id = ? AND id = ?").bind(code, t.orgId, conn.id));
    await db.batch(stmts);
    throw new ApiError(502, `${p}_publish_failed`, msg);
  }
});

/** «Retirar»: Ghost post back to draft (never deleted); the webhook receives `content.unpublish`. */
cmsExternal.post("/content/:contentId/external/:provider/unpublish", requireScope("content:approve"), async (c) => {
  const t = c.get("tenant");
  const db = c.env.DB;
  const p = providerParam(c);
  const id = assertUuid(c.req.param("contentId"), "Contenido");
  const pub = await loadPub(db, t.orgId, id, p);
  if (!pub || pub.state === "publishing" || (p === "ghost" && !pub.external_id)) throw notFound("Publicación");
  const { conn, ciphertext } = await secretFor(c, t.orgId, p);
  try {
    if (p === "ghost") await ghostUpdatePost(c.get("deps"), await openGhostCreds(c.env, t.orgId, conn.id, ciphertext), pub.external_id!, { status: "draft" });
    else await deliverCmsWebhook(c.get("deps"), await openWebhookCreds(c.env, t.orgId, conn.id, ciphertext), "content.unpublish", `${pub.id}-unpublish-${pub.content_version ?? 0}`, { contentId: id, externalId: pub.external_id, url: pub.external_url });
  } catch (e) {
    throw new ApiError(502, `${p}_unpublish_failed`, p === "ghost" ? ghostFriendly(e) : webhookFriendly(e));
  }
  await db.batch([
    db.prepare("UPDATE cms_external_publications SET state = 'unpublished', updated_at = ? WHERE organization_id = ? AND id = ?").bind(nowIso(), t.orgId, pub.id),
    auditStmt(db, { organizationId: t.orgId, actorUserId: t.userId, action: `cms.${p}_unpublish`, entityType: "content_item", entityId: id, before: { externalId: pub.external_id, state: pub.state }, after: { state: "unpublished" }, requestId: c.get("requestId") }),
  ]);
  return c.json({ publication: pubOut(await loadPub(db, t.orgId, id, p)) });
});
