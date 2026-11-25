import { Hono, type Context } from "hono";
import { checkDraft, markdownToSafeHtml, normalizeWpSite, WordPressConnectInput, WordPressFixInput, WordPressLlmsInput, WordPressPublishInput, WP_FIX_LABEL, WP_PUBLISHABLE_KINDS, wpMarker, wpSlug } from "@dni/core";
import type { AppEnv } from "../env";
import { auditStmt } from "../lib/audit";
import { ApiError, assertUuid, notFound, parseBody } from "../lib/http";
import { rateLimit } from "../lib/ratelimit";
import { log, nowIso, uuid } from "../lib/util";
import {
  discoverWpApi,
  openWpCreds,
  sealWpCreds,
  wpCreatePost,
  wpPluginFix,
  wpPluginLlms,
  wpPluginRevert,
  wpPluginStatus,
  wpFindBySlug,
  WpError,
  wpFriendly,
  wpReady,
  wpRevokeCurrentPassword,
  wpUpdatePost,
  wpWhoAmI,
  type WpCreds,
  type WpPost,
} from "../lib/wordpress";
import { requireScope } from "../middleware";
import { blogDescription } from "./site-blog";
import { WP_PLUGIN_VERSION } from "../lib/wp-plugin-source";

/**
 * WordPress publishing (APPROVAL_REQUIRED): only content approved by a person is sent, only by a role
 * with content:approve, and every send is audited. Idempotent: one row per content item, claimed with a
 * conditional write, and the post body carries a hidden marker so a retry after an unknown outcome finds
 * the post it already created instead of making a second one. «Retirar» moves the post back to draft
 * in WordPress (reversible); DNI Growth never deletes posts from the customer's site.
 */
export const cms = new Hono<AppEnv>();

const PROVIDER = "wordpress";
const STUCK_MS = 3 * 60_000;
const SCOPES = JSON.stringify(["publish_posts"]);

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
  attempts: number;
  last_error: string | null;
  published_at: string | null;
  updated_at: string;
}

const connection = (db: D1Database, orgId: string) =>
  db.prepare("SELECT id, status, account_ref, last_error, created_at FROM integrations WHERE organization_id = ? AND provider = ?").bind(orgId, PROVIDER).first<Conn>();

const connOut = (c: Conn | null) => (c ? { status: c.status, site: c.account_ref, connectedAt: c.created_at, lastError: c.last_error } : null);
const pubOut = (p: PubRow | null) =>
  p ? { state: p.state, url: p.external_url, postId: p.external_id, contentVersion: p.content_version, lastError: p.last_error, publishedAt: p.published_at, updatedAt: p.updated_at } : null;

async function credsFor(c: Context<AppEnv>, orgId: string): Promise<{ conn: Conn; creds: WpCreds }> {
  const conn = await connection(c.env.DB, orgId);
  if (!conn || conn.status === "disconnected") throw new ApiError(409, "wordpress_not_connected", "Conecta primero tu WordPress en Contenidos → WordPress.");
  if (conn.status !== "connected") throw new ApiError(409, "wordpress_reauth", "WordPress ya no acepta la conexión. Vuelve a conectar con una contraseña de aplicación nueva.");
  const sec = await c.env.DB.prepare("SELECT ciphertext FROM integration_secrets WHERE organization_id = ? AND integration_id = ?").bind(orgId, conn.id).first<{ ciphertext: string }>();
  if (!sec) throw new ApiError(409, "wordpress_reauth", "Vuelve a conectar tu WordPress.");
  return { conn, creds: await openWpCreds(c.env, orgId, conn.id, sec.ciphertext) };
}

cms.get("/cms", requireScope("content:read"), async (c) => {
  const t = c.get("tenant");
  return c.json({ configured: wpReady(c.env), wordpress: connOut(await connection(c.env.DB, t.orgId)), mode: "APPROVAL_REQUIRED" });
});

/** Connects (or reconnects) the organisation's WordPress with an Application Password. */
cms.post("/cms/wordpress", requireScope("integrations:manage"), async (c) => {
  const t = c.get("tenant");
  if (!wpReady(c.env)) throw new ApiError(503, "cms_not_configured", "La conexión con WordPress no está activada en este entorno.");
  await rateLimit(c.env.DB, `wp-connect:${t.orgId}`, 10, 3600);
  const input = await parseBody(c, WordPressConnectInput);
  const site = normalizeWpSite(input.siteUrl)!;
  const deps = c.get("deps");
  let api: string;
  try {
    api = (await discoverWpApi(deps, site)).api;
    const creds: WpCreds = { api, user: input.username, pass: input.appPassword.replace(/\s+/g, "") };
    const me = await wpWhoAmI(deps, creds);
    if (me.capabilities && me.capabilities.publish_posts !== true) throw new ApiError(403, "wordpress_cannot_publish", "Ese usuario de WordPress no puede publicar entradas. Usa un usuario con rol Editor o Administrador.");
    const db = c.env.DB;
    const existing = await connection(db, t.orgId);
    const integrationId = existing?.id ?? uuid();
    const secretId = uuid();
    const sealed = await sealWpCreds(c.env, t.orgId, integrationId, creds);
    await db.batch([
      existing
        ? db.prepare("UPDATE integrations SET status = 'connected', scopes_json = ?, account_ref = ?, secret_ref = ?, last_error = NULL, last_sync_at = ? WHERE organization_id = ? AND id = ?").bind(SCOPES, site, `integration_secrets:${secretId}`, nowIso(), t.orgId, integrationId)
        : db
            .prepare("INSERT INTO integrations (id, organization_id, provider, status, scopes_json, account_ref, secret_ref, last_sync_at) VALUES (?, ?, 'wordpress', 'connected', ?, ?, ?, ?)")
            .bind(integrationId, t.orgId, SCOPES, site, `integration_secrets:${secretId}`, nowIso()),
      db.prepare("DELETE FROM integration_secrets WHERE organization_id = ? AND integration_id = ?").bind(t.orgId, integrationId),
      db.prepare("INSERT INTO integration_secrets (id, organization_id, integration_id, ciphertext) VALUES (?, ?, ?, ?)").bind(secretId, t.orgId, integrationId, sealed),
      auditStmt(db, { organizationId: t.orgId, actorUserId: t.userId, action: "cms.wordpress_connect", entityType: "integration", entityId: integrationId, after: { site, restRoute: api.includes("rest_route=") ? "query" : "wp-json" }, requestId: c.get("requestId") }),
    ]);
    return c.json({ wordpress: connOut(await connection(db, t.orgId)) }, existing ? 200 : 201);
  } catch (e) {
    if (e instanceof ApiError) throw e;
    log("info", "cms.wordpress_connect_failed", { orgId: t.orgId, code: e instanceof WpError ? e.code : "unknown" });
    throw new ApiError(422, "wordpress_connect_failed", wpFriendly(e));
  }
});

/** Disconnects: revokes the Application Password in WordPress (best effort) and deletes our copy. */
cms.delete("/cms/wordpress", requireScope("integrations:manage"), async (c) => {
  const t = c.get("tenant");
  const db = c.env.DB;
  const conn = await connection(db, t.orgId);
  if (!conn) throw notFound("Conexión");
  let revoked = false;
  const sec = await db.prepare("SELECT ciphertext FROM integration_secrets WHERE organization_id = ? AND integration_id = ?").bind(t.orgId, conn.id).first<{ ciphertext: string }>();
  if (sec && wpReady(c.env)) {
    try {
      revoked = await wpRevokeCurrentPassword(c.get("deps"), await openWpCreds(c.env, t.orgId, conn.id, sec.ciphertext));
    } catch {
      revoked = false;
    }
  }
  await db.batch([
    db.prepare("DELETE FROM integration_secrets WHERE organization_id = ? AND integration_id = ?").bind(t.orgId, conn.id),
    db.prepare("UPDATE integrations SET status = 'disconnected', secret_ref = NULL, last_error = NULL WHERE organization_id = ? AND id = ?").bind(t.orgId, conn.id),
    auditStmt(db, { organizationId: t.orgId, actorUserId: t.userId, action: "cms.wordpress_disconnect", entityType: "integration", entityId: conn.id, after: { revokedInWordPress: revoked }, requestId: c.get("requestId") }),
  ]);
  return c.json({ ok: true, revokedInWordPress: revoked });
});

const loadPub = (db: D1Database, orgId: string, contentId: string) =>
  db.prepare("SELECT * FROM cms_publications WHERE organization_id = ? AND content_id = ? AND provider = 'wordpress'").bind(orgId, contentId).first<PubRow>();

cms.get("/content/:contentId/wordpress", requireScope("content:read"), async (c) => {
  const t = c.get("tenant");
  const id = assertUuid(c.req.param("contentId"), "Contenido");
  const conn = await connection(c.env.DB, t.orgId);
  return c.json({ wordpress: connOut(conn), publication: pubOut(await loadPub(c.env.DB, t.orgId, id)) });
});

/** Sends the approved version to WordPress, as a draft or published. Creates the post once, then updates it. */
cms.post("/content/:contentId/wordpress", requireScope("content:approve"), async (c) => {
  const t = c.get("tenant");
  const db = c.env.DB;
  const deps = c.get("deps");
  const id = assertUuid(c.req.param("contentId"), "Contenido");
  const input = await parseBody(c, WordPressPublishInput);
  await rateLimit(db, `wp-publish:${t.orgId}`, 60, 3600);
  const item = await db
    .prepare("SELECT id, kind, title, body_md, status, version FROM content_items WHERE organization_id = ? AND id = ?")
    .bind(t.orgId, id)
    .first<{ id: string; kind: string; title: string; body_md: string; status: string; version: number }>();
  if (!item) throw notFound("Contenido");
  if (!(WP_PUBLISHABLE_KINDS as readonly string[]).includes(item.kind)) throw new ApiError(422, "wordpress_kind", "Este tipo de contenido no se publica como entrada de WordPress. Expórtalo en HTML.");
  if (item.status !== "approved") throw new ApiError(409, "not_approved", "Publica solo contenido aprobado: envíalo a revisión y apruébalo antes.");
  const blocking = checkDraft(item.body_md).filter((x) => x.level === "blocking");
  if (blocking.length) throw new ApiError(422, "draft_checks_failed", blocking.map((x) => x.message).join(" "), { checks: blocking });
  const { conn, creds } = await credsFor(c, t.orgId);

  // Claim: one send at a time per content item (a double click or two tabs cannot create two posts).
  const now = nowIso();
  let pub = await loadPub(db, t.orgId, id);
  if (!pub) {
    const ins = await db
      .prepare(
        "INSERT INTO cms_publications (id, organization_id, content_id, integration_id, provider, state, attempts, created_at, updated_at) VALUES (?, ?, ?, ?, 'wordpress', 'publishing', 1, ?, ?) ON CONFLICT (organization_id, content_id, provider) DO NOTHING",
      )
      .bind(uuid(), t.orgId, id, conn.id, now, now)
      .run();
    pub = await loadPub(db, t.orgId, id);
    if (!pub || !ins.meta.changes) throw new ApiError(409, "wordpress_in_progress", "Ya se está enviando este contenido a WordPress. Espera unos segundos.");
  } else {
    const claim = await db
      .prepare("UPDATE cms_publications SET state = 'publishing', attempts = attempts + 1, integration_id = ?, updated_at = ? WHERE organization_id = ? AND id = ? AND (state <> 'publishing' OR updated_at < ?)")
      .bind(conn.id, now, t.orgId, pub.id, new Date(Date.now() - STUCK_MS).toISOString())
      .run();
    if (!claim.meta.changes) throw new ApiError(409, "wordpress_in_progress", "Ya se está enviando este contenido a WordPress. Espera unos segundos.");
  }

  const bodyMd = item.body_md.replace(/^\s*#\s+[^\n]*\n+/, "");
  const html = `${markdownToSafeHtml(bodyMd)}\n${wpMarker(id)}`;
  const payload: Record<string, unknown> = { title: item.title, content: html, excerpt: blogDescription(bodyMd), status: input.status };
  // With the «DNI Growth Connector» plugin: SEO title, description and Article JSON-LD (mirrored into Yoast / Rank Math).
  const plugin = await wpPluginStatus(deps, creds).catch(() => null);
  if (plugin) {
    const description = blogDescription(bodyMd);
    payload.meta = {
      _dni_seo_title: item.title.slice(0, 200),
      _dni_seo_description: description,
      _dni_jsonld: JSON.stringify({ "@context": "https://schema.org", "@type": "Article", headline: item.title.slice(0, 110), description, inLanguage: "es" }),
    };
  }
  try {
    let postId = pub.external_id;
    if (!postId) {
      // A previous attempt may have created it without us hearing back: find it by slug + our marker.
      const found = (await wpFindBySlug(deps, creds, wpSlug(item.title))).find((p) => (p.content?.raw ?? "").includes(wpMarker(id)));
      if (found) postId = String(found.id);
    }
    let result: WpPost;
    try {
      result = postId ? await wpUpdatePost(deps, creds, postId, payload) : await wpCreatePost(deps, creds, { ...payload, slug: wpSlug(item.title) });
    } catch (e) {
      // The post was deleted in WordPress: create a new one.
      if (postId && e instanceof WpError && (e.code === "rest_post_invalid_id" || e.status === 404)) result = await wpCreatePost(deps, creds, { ...payload, slug: wpSlug(item.title) });
      else throw e;
    }
    const state = result.status === "publish" ? "published" : "draft";
    const url = typeof result.link === "string" && /^https:\/\//.test(result.link) ? result.link.slice(0, 600) : null;
    const at = nowIso();
    await db.batch([
      db
        .prepare(
          "UPDATE cms_publications SET state = ?, external_id = ?, external_url = ?, content_version = ?, last_error = NULL, published_by = ?, published_at = CASE WHEN ? = 'published' THEN COALESCE(published_at, ?) ELSE published_at END, updated_at = ? WHERE organization_id = ? AND id = ?",
        )
        .bind(state, String(result.id).slice(0, 40), url, item.version, t.userId, state, at, at, t.orgId, pub.id),
      auditStmt(db, {
        organizationId: t.orgId,
        actorUserId: t.userId,
        action: "cms.wordpress_publish",
        entityType: "content_item",
        entityId: id,
        before: pub.external_id ? { postId: pub.external_id, state: pub.state, version: pub.content_version } : null,
        after: { postId: String(result.id), state, version: item.version, site: conn.account_ref },
        approvedBy: t.userId,
        requestId: c.get("requestId"),
      }),
    ]);
    return c.json({ publication: pubOut(await loadPub(db, t.orgId, id)) });
  } catch (e) {
    const code = e instanceof WpError ? e.code : "unknown";
    log("warn", "cms.wordpress_publish_failed", { orgId: t.orgId, contentId: id, code });
    const msg =
      e instanceof WpError && e.unknownOutcome
        ? "WordPress no confirmó el envío. Vuelve a intentarlo: si la entrada ya se creó la encontraremos y no se duplicará."
        : wpFriendly(e);
    const stmts = [
      db.prepare("UPDATE cms_publications SET state = 'failed', last_error = ?, updated_at = ? WHERE organization_id = ? AND id = ?").bind(msg.slice(0, 400), nowIso(), t.orgId, pub.id),
      auditStmt(db, { organizationId: t.orgId, actorUserId: t.userId, action: "cms.wordpress_failed", entityType: "content_item", entityId: id, after: { code }, requestId: c.get("requestId") }),
    ];
    if (e instanceof WpError && e.needsReauth) stmts.push(db.prepare("UPDATE integrations SET status = 'reauth_required', last_error = ? WHERE organization_id = ? AND id = ?").bind(code, t.orgId, conn.id));
    await db.batch(stmts);
    throw new ApiError(502, "wordpress_publish_failed", msg);
  }
});

/** «Retirar»: moves the post back to draft in WordPress (reversible). Never deletes it. */
cms.post("/content/:contentId/wordpress/unpublish", requireScope("content:approve"), async (c) => {
  const t = c.get("tenant");
  const db = c.env.DB;
  const id = assertUuid(c.req.param("contentId"), "Contenido");
  const pub = await loadPub(db, t.orgId, id);
  if (!pub?.external_id) throw notFound("Publicación");
  const { creds, conn } = await credsFor(c, t.orgId);
  try {
    await wpUpdatePost(c.get("deps"), creds, pub.external_id, { status: "draft" });
  } catch (e) {
    if (e instanceof WpError && e.needsReauth) await db.prepare("UPDATE integrations SET status = 'reauth_required', last_error = ? WHERE organization_id = ? AND id = ?").bind(e.code, t.orgId, conn.id).run();
    throw new ApiError(502, "wordpress_unpublish_failed", wpFriendly(e));
  }
  await db.batch([
    db.prepare("UPDATE cms_publications SET state = 'unpublished', updated_at = ? WHERE organization_id = ? AND id = ?").bind(nowIso(), t.orgId, pub.id),
    auditStmt(db, { organizationId: t.orgId, actorUserId: t.userId, action: "cms.wordpress_unpublish", entityType: "content_item", entityId: id, before: { postId: pub.external_id, state: pub.state }, after: { state: "unpublished" }, requestId: c.get("requestId") }),
  ]);
  return c.json({ publication: pubOut(await loadPub(db, t.orgId, id)) });
});

/* ── «DNI Growth Connector» plugin: status, reversible technical fixes and llms.txt ─────────────────── */

interface FixRow {
  id: string;
  field: string;
  target_url: string | null;
  attachment_id: number | null;
  post_id: number | null;
  remote_fix_id: string | null;
  before_value: string | null;
  after_value: string;
  state: string;
  last_error: string | null;
  created_at: string;
  reverted_at: string | null;
}
const fixOut = (f: FixRow) => ({
  id: f.id,
  field: f.field,
  label: WP_FIX_LABEL[f.field as keyof typeof WP_FIX_LABEL] ?? f.field,
  url: f.target_url,
  attachmentId: f.attachment_id,
  before: f.before_value,
  after: f.after_value,
  state: f.state,
  error: f.last_error,
  createdAt: f.created_at,
  revertedAt: f.reverted_at,
});
const loadFix = (db: D1Database, orgId: string, id: string) => db.prepare("SELECT * FROM wp_fixes WHERE organization_id = ? AND id = ?").bind(orgId, id).first<FixRow>();

/** Plugin status on the connected site and the latest version available for download. */
cms.get("/cms/wordpress/plugin", requireScope("content:read"), async (c) => {
  const t = c.get("tenant");
  const latest = { version: WP_PLUGIN_VERSION, download: "/descargas/dni-growth-connector.zip" };
  const conn = await connection(c.env.DB, t.orgId);
  if (!conn || conn.status !== "connected") return c.json({ latest, installed: null, connected: false });
  const { creds } = await credsFor(c, t.orgId);
  try {
    const installed = await wpPluginStatus(c.get("deps"), creds);
    return c.json({ latest, installed, connected: true, outdated: installed ? installed.version !== WP_PLUGIN_VERSION : false });
  } catch (e) {
    throw new ApiError(502, "wordpress_plugin_status", wpFriendly(e));
  }
});

cms.get("/cms/wordpress/fixes", requireScope("content:read"), async (c) => {
  const t = c.get("tenant");
  const { results } = await c.env.DB.prepare("SELECT * FROM wp_fixes WHERE organization_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 100").bind(t.orgId).all<FixRow>();
  return c.json({ fixes: results.map(fixOut) });
});

async function pluginOrFail(c: Context<AppEnv>, orgId: string) {
  const { conn, creds } = await credsFor(c, orgId);
  let plugin;
  try {
    plugin = await wpPluginStatus(c.get("deps"), creds);
  } catch (e) {
    throw new ApiError(502, "wordpress_plugin_status", wpFriendly(e));
  }
  if (!plugin) throw new ApiError(409, "wordpress_plugin_missing", "Instala y activa el plugin «DNI Growth Connector» en tu WordPress para aplicar correcciones.");
  return { conn, creds, plugin };
}

const hostOf = (u: string) => new URL(u).hostname.toLowerCase().replace(/^www\./, "");

/** Applies one fix (approval = this action, by a role with content:approve). Audited and reversible. */
cms.post("/cms/wordpress/fixes", requireScope("content:approve"), async (c) => {
  const t = c.get("tenant");
  const db = c.env.DB;
  const input = await parseBody(c, WordPressFixInput);
  await rateLimit(db, `wp-fix:${t.orgId}`, 60, 3600);
  const { conn, creds } = await pluginOrFail(c, t.orgId);
  if (input.url && conn.account_ref && hostOf(input.url) !== hostOf(conn.account_ref)) {
    throw new ApiError(422, "wordpress_other_site", `Esa URL no es de tu WordPress conectado (${hostOf(conn.account_ref)}).`);
  }
  const id = uuid();
  await db
    .prepare("INSERT INTO wp_fixes (id, organization_id, integration_id, field, target_url, attachment_id, after_value, state, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'applying', ?, ?)")
    .bind(id, t.orgId, conn.id, input.field, input.url ?? null, input.attachmentId ?? null, input.value, t.userId, nowIso())
    .run();
  try {
    const r = await wpPluginFix(c.get("deps"), creds, { field: input.field, value: input.value, url: input.url, attachment_id: input.attachmentId, ref: id });
    await db.batch([
      db
        .prepare("UPDATE wp_fixes SET state = 'applied', post_id = ?, remote_fix_id = ?, before_value = ?, after_value = ?, target_url = COALESCE(target_url, ?) WHERE organization_id = ? AND id = ?")
        .bind(r.postId, r.id, r.before, r.after, r.url ?? null, t.orgId, id),
      auditStmt(db, {
        organizationId: t.orgId,
        actorUserId: t.userId,
        action: "cms.wordpress_fix",
        entityType: "wp_fix",
        entityId: id,
        before: { field: input.field, value: r.before.slice(0, 500) },
        after: { field: input.field, value: r.after.slice(0, 500), postId: r.postId },
        approvedBy: t.userId,
        requestId: c.get("requestId"),
      }),
    ]);
  } catch (e) {
    await db.prepare("UPDATE wp_fixes SET state = 'failed', last_error = ? WHERE organization_id = ? AND id = ?").bind(e instanceof WpError ? e.code : "error", t.orgId, id).run();
    if (e instanceof WpError && (e.status === 403 || e.status === 401)) {
      throw new ApiError(403, "wordpress_fix_forbidden", "WordPress no deja editar eso: la URL no es una entrada o página de tu web, o tu usuario no tiene permiso para editarla.");
    }
    throw new ApiError(502, "wordpress_fix_failed", wpFriendly(e));
  }
  return c.json({ fix: fixOut((await loadFix(db, t.orgId, id))!) }, 201);
});

/** Undoes a fix: the plugin restores the value it had before. */
cms.post("/cms/wordpress/fixes/:fixId/revert", requireScope("content:approve"), async (c) => {
  const t = c.get("tenant");
  const db = c.env.DB;
  const id = assertUuid(c.req.param("fixId"), "Corrección");
  const row = await loadFix(db, t.orgId, id);
  if (!row) throw notFound("Corrección");
  if (row.state === "reverted") return c.json({ fix: fixOut(row) });
  if (row.state !== "applied") throw new ApiError(409, "wordpress_fix_not_applied", "Solo se puede deshacer una corrección aplicada.");
  const { creds } = await pluginOrFail(c, t.orgId);
  try {
    if (row.field === "llms") await wpPluginLlms(c.get("deps"), creds, row.before_value ?? "");
    else await wpPluginRevert(c.get("deps"), creds, row.post_id!, row.remote_fix_id!);
  } catch (e) {
    throw new ApiError(502, "wordpress_revert_failed", wpFriendly(e));
  }
  await db.batch([
    db.prepare("UPDATE wp_fixes SET state = 'reverted', reverted_by = ?, reverted_at = ? WHERE organization_id = ? AND id = ? AND state = 'applied'").bind(t.userId, nowIso(), t.orgId, id),
    auditStmt(db, {
      organizationId: t.orgId,
      actorUserId: t.userId,
      action: "cms.wordpress_fix_revert",
      entityType: "wp_fix",
      entityId: id,
      before: { field: row.field, value: row.after_value.slice(0, 500) },
      after: { field: row.field, value: (row.before_value ?? "").slice(0, 500) },
      requestId: c.get("requestId"),
    }),
  ]);
  return c.json({ fix: fixOut((await loadFix(db, t.orgId, id))!) });
});

/** Replaces llms.txt on the site (needs an Administrator in WordPress). Reversible like any other fix. */
cms.post("/cms/wordpress/llms", requireScope("content:approve"), async (c) => {
  const t = c.get("tenant");
  const db = c.env.DB;
  const input = await parseBody(c, WordPressLlmsInput);
  await rateLimit(db, `wp-fix:${t.orgId}`, 60, 3600);
  const { conn, creds, plugin } = await pluginOrFail(c, t.orgId);
  if (!plugin.canLlmsTxt) throw new ApiError(403, "wordpress_llms_forbidden", "Para cambiar llms.txt, el usuario de WordPress conectado debe ser Administrador.");
  let r: { before: string; after: string; url: string };
  try {
    r = await wpPluginLlms(c.get("deps"), creds, input.content);
  } catch (e) {
    throw new ApiError(502, "wordpress_fix_failed", wpFriendly(e));
  }
  const id = uuid();
  await db.batch([
    db
      .prepare("INSERT INTO wp_fixes (id, organization_id, integration_id, field, target_url, before_value, after_value, state, created_by, created_at) VALUES (?, ?, ?, 'llms', ?, ?, ?, 'applied', ?, ?)")
      .bind(id, t.orgId, conn.id, r.url, r.before, r.after, t.userId, nowIso()),
    auditStmt(db, { organizationId: t.orgId, actorUserId: t.userId, action: "cms.wordpress_llms", entityType: "wp_fix", entityId: id, after: { bytes: r.after.length }, approvedBy: t.userId, requestId: c.get("requestId") }),
  ]);
  return c.json({ fix: fixOut((await loadFix(db, t.orgId, id))!) }, 201);
});
