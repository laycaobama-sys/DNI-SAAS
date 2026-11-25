import { Hono, type Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { z } from "zod";
import { can, isRole, META_SCOPES, randomToken, sha256Hex, SocialPostInput, socialPostProblems, timingSafeEqual, type SocialNetwork } from "@dni/core";
import type { AppEnv, Env } from "../env";
import { auditStmt } from "../lib/audit";
import { ApiError, assertUuid, notFound, parseBody } from "../lib/http";
import {
  canPublishOnPage,
  exchangeCode,
  graph,
  listPages,
  META_DIALOG,
  MetaApiError,
  metaReady,
  openUserToken,
  parseSignedRequest,
  sealPageToken,
  sealUserToken,
  verifySocialMediaSig,
} from "../lib/meta";
import { rateLimit } from "../lib/ratelimit";
import { addSeconds, log, nowIso, uuid } from "../lib/util";
import { requireScope } from "../middleware";

/**
 * Facebook Pages + Instagram: connect with Facebook Login for Business, write a post, send it for
 * approval, approve it (role with content:approve) and the cron publishes it at its time
 * (lib/social-publish.ts). Mode APPROVAL_REQUIRED, always: nothing reaches Meta without a human approval
 * recorded in the audit log. «Pausar» is the kill switch: nothing is published while it is on.
 */
export const social = new Hono<AppEnv>();

const STATE_COOKIE = "dni_meta_state";
const STATE_TTL = 600;
const PROVIDER = "meta";
const secure = (env: Env) => env.ENVIRONMENT !== "development" && env.ENVIRONMENT !== "test";
export const metaCallbackUri = (env: Env) => `${env.APP_ORIGIN.replace(/\/$/, "")}/api/v1/auth/meta/callback`;
const panel = (orgId: string) => `/app/o/${orgId}/social`;

interface PostRow {
  id: string;
  account_id: string;
  caption: string;
  link: string | null;
  media_id: string | null;
  status: string;
  scheduled_at: string | null;
  created_by: string | null;
  approved_by: string | null;
  approved_at: string | null;
  review_note: string | null;
  external_url: string | null;
  last_error: string | null;
  published_at: string | null;
  version: number;
  created_at: string;
  updated_at: string;
}
const postOut = (r: PostRow, orgId: string) => ({
  id: r.id,
  accountId: r.account_id,
  caption: r.caption,
  link: r.link,
  mediaId: r.media_id,
  mediaUrl: r.media_id ? `/api/v1/orgs/${orgId}/media/${r.media_id}/file` : null,
  status: r.status,
  scheduledAt: r.scheduled_at,
  approvedAt: r.approved_at,
  reviewNote: r.review_note,
  externalUrl: r.external_url,
  lastError: r.last_error,
  publishedAt: r.published_at,
  version: r.version,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

async function connection(db: D1Database, orgId: string) {
  return db.prepare("SELECT id, status, account_ref, last_sync_at, last_error, created_at FROM integrations WHERE organization_id = ? AND provider = ?").bind(orgId, PROVIDER).first<{
    id: string;
    status: string;
    account_ref: string | null;
    last_sync_at: string | null;
    last_error: string | null;
    created_at: string;
  }>();
}

social.get("/social", requireScope("content:read"), async (c) => {
  const t = c.get("tenant");
  const db = c.env.DB;
  const conn = await connection(db, t.orgId);
  const { results: accounts } = await db
    .prepare("SELECT id, network, external_id, page_id, name, username, status, updated_at FROM social_accounts WHERE organization_id = ? ORDER BY network, name")
    .bind(t.orgId)
    .all<{ id: string; network: SocialNetwork; external_id: string; page_id: string; name: string; username: string | null; status: string; updated_at: string }>();
  const { results: posts } = await db.prepare("SELECT * FROM social_posts WHERE organization_id = ? ORDER BY created_at DESC LIMIT 100").bind(t.orgId).all<PostRow>();
  return c.json({
    configured: metaReady(c.env),
    connection: conn ? { status: conn.status, connectedAt: conn.created_at, lastSyncAt: conn.last_sync_at, lastError: conn.last_error } : null,
    accounts: accounts.map((a) => ({ id: a.id, network: a.network, name: a.name, username: a.username, status: a.status, externalId: a.external_id, pageId: a.page_id })),
    posts: posts.map((p) => postOut(p, t.orgId)),
    mode: "APPROVAL_REQUIRED",
  });
});

/** POST: returns the Facebook Login for Business URL (the SPA navigates to it). */
social.post("/social/connect", requireScope("integrations:manage"), async (c) => {
  const t = c.get("tenant");
  if (!metaReady(c.env)) throw new ApiError(503, "meta_not_configured", "La conexión con Facebook e Instagram todavía no está activada en DNI Growth.");
  await rateLimit(c.env.DB, `meta-connect:${t.orgId}`, 10, 3600);
  const state = randomToken(32);
  await c.env.DB.batch([
    c.env.DB.prepare("DELETE FROM oauth_states WHERE expires_at < ?").bind(nowIso()),
    c.env.DB.prepare("INSERT INTO oauth_states (id, provider, code_verifier, nonce, next_path, expires_at, organization_id, user_id) VALUES (?, 'meta', '-', '-', ?, ?, ?, ?)").bind(
      await sha256Hex(state),
      panel(t.orgId),
      addSeconds(STATE_TTL),
      t.orgId,
      t.userId,
    ),
  ]);
  setCookie(c, STATE_COOKIE, state, { httpOnly: true, secure: secure(c.env), sameSite: "Lax", path: "/api/v1/auth/meta", maxAge: STATE_TTL });
  const url = new URL(META_DIALOG);
  const q: Record<string, string> = { client_id: c.env.META_APP_ID!, redirect_uri: metaCallbackUri(c.env), state, response_type: "code" };
  if (c.env.META_LOGIN_CONFIG_ID) q.config_id = c.env.META_LOGIN_CONFIG_ID;
  else q.scope = META_SCOPES.join(",");
  url.search = new URLSearchParams(q).toString();
  return c.json({ url: url.toString() });
});

/** Saves (or refreshes) the Pages and Instagram accounts the token can publish to. */
async function syncAccounts(c: Context<AppEnv>, orgId: string, integrationId: string, userToken: string) {
  const db = c.env.DB;
  const pages = (await listPages(c.env, c.get("deps"), userToken)).filter(canPublishOnPage);
  const now = nowIso();
  const seen: string[] = [];
  const stmts: D1PreparedStatement[] = [];
  for (const p of pages) {
    if (!p.access_token || !/^\d{1,40}$/.test(p.id)) continue;
    const rows: Array<{ network: SocialNetwork; external: string; name: string; username: string | null }> = [{ network: "facebook", external: p.id, name: p.name.slice(0, 200), username: null }];
    const ig = p.instagram_business_account;
    if (ig?.id && /^\d{1,40}$/.test(ig.id)) rows.push({ network: "instagram", external: ig.id, name: (ig.name || ig.username || p.name).slice(0, 200), username: ig.username?.slice(0, 100) ?? null });
    for (const r of rows) {
      const existing = await db.prepare("SELECT id FROM social_accounts WHERE organization_id = ? AND network = ? AND external_id = ?").bind(orgId, r.network, r.external).first<{ id: string }>();
      const id = existing?.id ?? uuid();
      const tok = await sealPageToken(c.env, orgId, id, p.access_token);
      seen.push(id);
      stmts.push(
        existing
          ? db
              .prepare("UPDATE social_accounts SET integration_id = ?, page_id = ?, name = ?, username = ?, token_enc = ?, status = 'active', updated_at = ? WHERE organization_id = ? AND id = ?")
              .bind(integrationId, p.id, r.name, r.username, tok, now, orgId, id)
          : db
              .prepare("INSERT INTO social_accounts (id, organization_id, integration_id, network, external_id, page_id, name, username, token_enc, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)")
              .bind(id, orgId, integrationId, r.network, r.external, p.id, r.name, r.username, tok, now, now),
      );
    }
  }
  // Accounts no longer granted: token removed, scheduled posts stay but will not be published.
  const placeholders = seen.map(() => "?").join(",");
  stmts.push(
    db
      .prepare(`UPDATE social_accounts SET status = 'disconnected', token_enc = NULL, updated_at = ? WHERE organization_id = ? AND status != 'disconnected'${seen.length ? ` AND id NOT IN (${placeholders})` : ""}`)
      .bind(now, orgId, ...seen),
    db.prepare("UPDATE integrations SET last_sync_at = ?, last_error = NULL WHERE organization_id = ? AND id = ?").bind(now, orgId, integrationId),
  );
  await db.batch(stmts);
  return seen.length;
}

/** Shared callback registered in the Meta app: https://dnigrowth.com/api/v1/auth/meta/callback */
export async function metaCallback(c: Context<AppEnv>) {
  const state = c.req.query("state") ?? "";
  const code = c.req.query("code") ?? "";
  const cookieState = getCookie(c, STATE_COOKIE) ?? "";
  deleteCookie(c, STATE_COOKIE, { path: "/api/v1/auth/meta", secure: secure(c.env) });
  const fail = (orgId: string | null, err: string) => {
    log("warn", "meta.connect_failed", { code: err, requestId: c.get("requestId") });
    return c.redirect(orgId && /^[0-9a-f-]{36}$/.test(orgId) ? `${panel(orgId)}?meta_error=${encodeURIComponent(err)}` : "/app/", 302);
  };
  if (!/^[0-9a-f]{64}$/.test(state) || !cookieState || !timingSafeEqual(state, cookieState)) return fail(null, "state_mismatch");
  const row = await c.env.DB.prepare("DELETE FROM oauth_states WHERE id = ? AND provider = 'meta' AND expires_at > ? RETURNING organization_id, user_id")
    .bind(await sha256Hex(state), nowIso())
    .first<{ organization_id: string | null; user_id: string | null }>();
  if (!row?.organization_id) return fail(null, "state_expired");
  const orgId = row.organization_id;
  const user = c.get("user");
  if (!user || user.id !== row.user_id) return fail(orgId, "session_mismatch");
  const m = await c.env.DB.prepare("SELECT role FROM memberships WHERE organization_id = ? AND user_id = ? AND status = 'active'").bind(orgId, user.id).first<{ role: string }>();
  if (!m || !isRole(m.role) || !can(m.role, "integrations:manage")) return fail(orgId, "forbidden");
  if (!metaReady(c.env)) return fail(orgId, "not_configured");
  if (c.req.query("error") || !code) return fail(orgId, "meta_denied");
  if (code.length > 2048) return fail(orgId, "missing_code");

  const deps = c.get("deps");
  let token: string;
  let expiresIn: number | null;
  let me: { id: string; name?: string };
  let granted: string[];
  try {
    ({ token, expiresIn } = await exchangeCode(c.env, deps, code, metaCallbackUri(c.env)));
    me = await graph(c.env, deps, "/me", { token, params: { fields: "id,name" } });
    const perms = await graph<{ data?: Array<{ permission: string; status: string }> }>(c.env, deps, "/me/permissions", { token });
    granted = (perms.data ?? []).filter((p) => p.status === "granted").map((p) => p.permission);
  } catch (e) {
    return fail(orgId, e instanceof MetaApiError ? `token_${e.code}` : "token_exchange_failed");
  }
  if (!granted.includes("pages_show_list") || !granted.includes("pages_manage_posts")) return fail(orgId, "scope_not_granted");

  const db = c.env.DB;
  const existing = await connection(db, orgId);
  const integrationId = existing?.id ?? uuid();
  const secretId = uuid();
  const expiresAt = expiresIn ? addSeconds(expiresIn) : null;
  const sealed = await sealUserToken(c.env, orgId, integrationId, token, expiresAt);
  const scopes = JSON.stringify(granted.filter((p) => (META_SCOPES as readonly string[]).includes(p)));
  const ref = `meta:${me.id}`;
  await db.batch([
    existing
      ? db.prepare("UPDATE integrations SET status = 'connected', scopes_json = ?, account_ref = ?, secret_ref = ?, last_error = NULL WHERE organization_id = ? AND id = ?").bind(scopes, ref, `integration_secrets:${secretId}`, orgId, integrationId)
      : db.prepare("INSERT INTO integrations (id, organization_id, provider, status, scopes_json, account_ref, secret_ref) VALUES (?, ?, 'meta', 'connected', ?, ?, ?)").bind(integrationId, orgId, scopes, ref, `integration_secrets:${secretId}`),
    db.prepare("DELETE FROM integration_secrets WHERE organization_id = ? AND integration_id = ?").bind(orgId, integrationId),
    db.prepare("INSERT INTO integration_secrets (id, organization_id, integration_id, ciphertext) VALUES (?, ?, ?, ?)").bind(secretId, orgId, integrationId, sealed),
    auditStmt(db, {
      organizationId: orgId,
      actorUserId: user.id,
      action: "integration.connect",
      entityType: "integration",
      entityId: integrationId,
      after: { provider: "meta", scopes: JSON.parse(scopes) },
      requestId: c.get("requestId"),
    }),
  ]);
  try {
    const n = await syncAccounts(c, orgId, integrationId, token);
    return c.redirect(`${panel(orgId)}?meta=connected&cuentas=${n}`, 302);
  } catch (e) {
    const err = e instanceof MetaApiError ? e.code : "list_failed";
    await db.prepare("UPDATE integrations SET last_error = ? WHERE organization_id = ? AND id = ?").bind(`accounts:${err}`, orgId, integrationId).run();
    return c.redirect(`${panel(orgId)}?meta=connected&meta_error=${encodeURIComponent(`accounts_${err}`)}`, 302);
  }
}

social.post("/social/refresh", requireScope("integrations:manage"), async (c) => {
  const t = c.get("tenant");
  const conn = await connection(c.env.DB, t.orgId);
  if (!conn || conn.status === "disconnected") throw notFound("Conexión con Meta");
  if (!metaReady(c.env)) throw new ApiError(503, "meta_not_configured", "La conexión con Facebook e Instagram no está activada.");
  await rateLimit(c.env.DB, `meta-refresh:${t.orgId}`, 20, 3600);
  const sec = await c.env.DB.prepare("SELECT ciphertext FROM integration_secrets WHERE organization_id = ? AND integration_id = ?").bind(t.orgId, conn.id).first<{ ciphertext: string }>();
  if (!sec) throw new ApiError(409, "reauth_required", "Vuelve a conectar con Facebook.");
  const tok = await openUserToken(c.env, t.orgId, conn.id, sec.ciphertext);
  try {
    const n = await syncAccounts(c, t.orgId, conn.id, tok.t);
    return c.json({ ok: true, accounts: n });
  } catch (e) {
    if (e instanceof MetaApiError && e.needsReauth) {
      await c.env.DB.prepare("UPDATE integrations SET status = 'reauth_required', last_error = ? WHERE organization_id = ? AND id = ?").bind(e.code, t.orgId, conn.id).run();
      throw new ApiError(409, "reauth_required", "Facebook ha caducado el permiso. Vuelve a conectar.");
    }
    throw new ApiError(502, "meta_error", "Meta no respondió. Inténtalo en unos minutos.");
  }
});

/** Kill switch: while paused nothing is published (approved posts wait). */
social.post("/social/pause", requireScope("content:approve"), async (c) => {
  const t = c.get("tenant");
  const { paused } = await parseBody(c, z.object({ paused: z.boolean() }));
  const conn = await connection(c.env.DB, t.orgId);
  if (!conn || conn.status === "disconnected") throw notFound("Conexión con Meta");
  const next = paused ? "paused" : "connected";
  await c.env.DB.batch([
    c.env.DB.prepare("UPDATE integrations SET status = ? WHERE organization_id = ? AND id = ? AND status IN ('connected','paused')").bind(next, t.orgId, conn.id),
    auditStmt(c.env.DB, { organizationId: t.orgId, actorUserId: t.userId, action: paused ? "social.pause" : "social.resume", entityType: "integration", entityId: conn.id, requestId: c.get("requestId") }),
  ]);
  return c.json({ ok: true, status: next });
});

social.delete("/social/connection", requireScope("integrations:manage"), async (c) => {
  const t = c.get("tenant");
  const db = c.env.DB;
  const conn = await connection(db, t.orgId);
  if (!conn) throw notFound("Conexión con Meta");
  // Best effort: withdraw our app's permissions at Meta too.
  let revoked = false;
  const sec = await db.prepare("SELECT ciphertext FROM integration_secrets WHERE organization_id = ? AND integration_id = ?").bind(t.orgId, conn.id).first<{ ciphertext: string }>();
  if (sec && metaReady(c.env)) {
    try {
      const tok = await openUserToken(c.env, t.orgId, conn.id, sec.ciphertext);
      await graph(c.env, c.get("deps"), "/me/permissions", { method: "DELETE", token: tok.t });
      revoked = true;
    } catch {
      revoked = false;
    }
  }
  const now = nowIso();
  await db.batch([
    db.prepare("DELETE FROM integration_secrets WHERE organization_id = ? AND integration_id = ?").bind(t.orgId, conn.id),
    db.prepare("UPDATE social_accounts SET status = 'disconnected', token_enc = NULL, updated_at = ? WHERE organization_id = ?").bind(now, t.orgId),
    db.prepare("UPDATE social_posts SET status = 'cancelled', last_error = 'Conexión con Meta desconectada.', updated_at = ? WHERE organization_id = ? AND status IN ('pending_approval','approved')").bind(now, t.orgId),
    db.prepare("UPDATE integrations SET status = 'disconnected', secret_ref = NULL WHERE organization_id = ? AND id = ?").bind(t.orgId, conn.id),
    auditStmt(db, { organizationId: t.orgId, actorUserId: t.userId, action: "integration.disconnect", entityType: "integration", entityId: conn.id, after: { provider: "meta", revokedAtMeta: revoked }, requestId: c.get("requestId") }),
  ]);
  return c.json({ ok: true, revokedAtMeta: revoked });
});

// ── Posts ──────────────────────────────────────────────────────────────────────────────────────────
async function loadPost(c: Context<AppEnv>, id: string) {
  const t = c.get("tenant");
  const r = await c.env.DB.prepare("SELECT * FROM social_posts WHERE organization_id = ? AND id = ?").bind(t.orgId, assertUuid(id, "Publicación")).first<PostRow>();
  if (!r) throw notFound("Publicación");
  return r;
}

async function accountFor(c: Context<AppEnv>, accountId: string) {
  const t = c.get("tenant");
  const a = await c.env.DB.prepare("SELECT id, network, status FROM social_accounts WHERE organization_id = ? AND id = ?").bind(t.orgId, accountId).first<{ id: string; network: SocialNetwork; status: string }>();
  if (!a) throw notFound("Cuenta");
  return a;
}

async function mediaFacts(c: Context<AppEnv>, mediaId: string | null) {
  if (!mediaId) return null;
  const t = c.get("tenant");
  const m = await c.env.DB.prepare("SELECT r2_key, content_type, bytes, kind FROM media_uploads WHERE organization_id = ? AND id = ?").bind(t.orgId, mediaId).first<{ r2_key: string; content_type: string; bytes: number; kind: string }>();
  if (!m || m.kind !== "image") throw new ApiError(422, "media_not_found", "La imagen no existe en tu biblioteca.");
  let head = new Uint8Array();
  if (c.env.MEDIA && m.r2_key.startsWith(`media/${t.orgId}/`)) {
    const obj = await c.env.MEDIA.get(m.r2_key, { range: { offset: 0, length: 65536 } });
    if (obj) head = new Uint8Array(await obj.arrayBuffer());
  }
  return { contentType: m.content_type, bytes: m.bytes, head };
}

const scheduleOk = (iso: string | null | undefined) => {
  if (!iso) return null;
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) throw new ApiError(422, "bad_date", "Fecha no válida.");
  if (ms > Date.now() + 75 * 86_400_000) throw new ApiError(422, "too_far", "Se puede programar como máximo con 75 días de antelación.");
  return new Date(ms).toISOString();
};

social.post("/social/posts", requireScope("content:write"), async (c) => {
  const t = c.get("tenant");
  const b = await parseBody(c, SocialPostInput);
  await accountFor(c, b.accountId);
  if (b.mediaId) await mediaFacts(c, b.mediaId);
  const id = uuid();
  const now = nowIso();
  await c.env.DB.batch([
    c.env.DB.prepare("INSERT INTO social_posts (id, organization_id, account_id, caption, link, media_id, status, scheduled_at, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?)").bind(
      id,
      t.orgId,
      b.accountId,
      b.caption,
      b.link ?? null,
      b.mediaId ?? null,
      scheduleOk(b.scheduledAt),
      t.userId,
      now,
      now,
    ),
    auditStmt(c.env.DB, { organizationId: t.orgId, actorUserId: t.userId, action: "social.post_create", entityType: "social_post", entityId: id, requestId: c.get("requestId") }),
  ]);
  return c.json(postOut((await loadPost(c, id))!, t.orgId), 201);
});

social.put("/social/posts/:id", requireScope("content:write"), async (c) => {
  const t = c.get("tenant");
  const cur = await loadPost(c, c.req.param("id"));
  if (!["draft", "failed", "cancelled"].includes(cur.status)) throw new ApiError(409, "not_editable", "Solo se pueden editar borradores. Si está pendiente o aprobado, cancélalo primero.");
  const b = await parseBody(c, SocialPostInput.extend({ expectedVersion: z.number().int().positive() }));
  await accountFor(c, b.accountId);
  if (b.mediaId) await mediaFacts(c, b.mediaId);
  const r = await c.env.DB.prepare(
    "UPDATE social_posts SET account_id = ?, caption = ?, link = ?, media_id = ?, scheduled_at = ?, status = 'draft', approved_by = NULL, approved_at = NULL, last_error = NULL, version = version + 1, updated_at = ? WHERE organization_id = ? AND id = ? AND version = ?",
  )
    .bind(b.accountId, b.caption, b.link ?? null, b.mediaId ?? null, scheduleOk(b.scheduledAt), nowIso(), t.orgId, cur.id, b.expectedVersion)
    .run();
  if (!r.meta.changes) throw new ApiError(409, "version_conflict", "Otra persona ha cambiado esta publicación. Recarga.");
  return c.json(postOut((await loadPost(c, cur.id))!, t.orgId));
});

/** What Meta would reject, checked before asking for approval. */
async function problemsFor(c: Context<AppEnv>, p: PostRow) {
  const a = await accountFor(c, p.account_id);
  if (a.status !== "active") return ["La cuenta ya no está conectada. Vuelve a conectar con Facebook."];
  return socialPostProblems(a.network, { caption: p.caption, link: p.link, media: await mediaFacts(c, p.media_id) });
}

social.post("/social/posts/:id/check", requireScope("content:read"), async (c) => {
  const p = await loadPost(c, c.req.param("id"));
  return c.json({ problems: await problemsFor(c, p) });
});

social.post("/social/posts/:id/submit", requireScope("content:write"), async (c) => {
  const t = c.get("tenant");
  const p = await loadPost(c, c.req.param("id"));
  if (p.status !== "draft") throw new ApiError(409, "bad_state", "Solo un borrador se puede enviar a aprobación.");
  const problems = await problemsFor(c, p);
  if (problems.length) throw new ApiError(422, "not_publishable", problems.join(" "), { problems });
  await c.env.DB.batch([
    c.env.DB.prepare("UPDATE social_posts SET status = 'pending_approval', submitted_by = ?, updated_at = ? WHERE organization_id = ? AND id = ? AND status = 'draft'").bind(t.userId, nowIso(), t.orgId, p.id),
    auditStmt(c.env.DB, { organizationId: t.orgId, actorUserId: t.userId, action: "social.post_submit", entityType: "social_post", entityId: p.id, requestId: c.get("requestId") }),
  ]);
  return c.json(postOut((await loadPost(c, p.id))!, t.orgId));
});

social.post("/social/posts/:id/review", requireScope("content:approve"), async (c) => {
  const t = c.get("tenant");
  const p = await loadPost(c, c.req.param("id"));
  const b = await parseBody(c, z.object({ decision: z.enum(["approve", "reject"]), note: z.string().trim().max(500).optional(), expectedVersion: z.number().int().positive() }));
  if (p.status !== "pending_approval") throw new ApiError(409, "bad_state", "Esta publicación no está pendiente de aprobación.");
  if (p.version !== b.expectedVersion) throw new ApiError(409, "version_conflict", "La publicación ha cambiado. Recarga antes de aprobar.");
  const now = nowIso();
  if (b.decision === "approve") {
    const problems = await problemsFor(c, p);
    if (problems.length) throw new ApiError(422, "not_publishable", problems.join(" "), { problems });
  }
  const r = await c.env.DB.batch([
    b.decision === "approve"
      ? c.env.DB.prepare(
          "UPDATE social_posts SET status = 'approved', approved_by = ?, approved_at = ?, review_note = ?, scheduled_at = COALESCE(scheduled_at, ?), attempts = 0, last_error = NULL, updated_at = ? WHERE organization_id = ? AND id = ? AND status = 'pending_approval' AND version = ?",
        ).bind(t.userId, now, b.note ?? null, now, now, t.orgId, p.id, b.expectedVersion)
      : c.env.DB.prepare("UPDATE social_posts SET status = 'draft', review_note = ?, updated_at = ? WHERE organization_id = ? AND id = ? AND status = 'pending_approval' AND version = ?").bind(
          b.note ?? null,
          now,
          t.orgId,
          p.id,
          b.expectedVersion,
        ),
    auditStmt(c.env.DB, { organizationId: t.orgId, actorUserId: t.userId, action: b.decision === "approve" ? "social.post_approve" : "social.post_reject", entityType: "social_post", entityId: p.id, after: { note: b.note ?? null }, requestId: c.get("requestId"), approvedBy: b.decision === "approve" ? t.userId : null }),
  ]);
  if (!r[0]!.meta.changes) throw new ApiError(409, "version_conflict", "La publicación ha cambiado. Recarga.");
  return c.json(postOut((await loadPost(c, p.id))!, t.orgId));
});

social.post("/social/posts/:id/cancel", requireScope("content:write"), async (c) => {
  const t = c.get("tenant");
  const p = await loadPost(c, c.req.param("id"));
  if (!["draft", "pending_approval", "approved"].includes(p.status)) throw new ApiError(409, "bad_state", "Ya no se puede cancelar: se está publicando o ya se publicó.");
  const r = await c.env.DB.batch([
    c.env.DB.prepare("UPDATE social_posts SET status = 'cancelled', updated_at = ? WHERE organization_id = ? AND id = ? AND status IN ('draft','pending_approval','approved')").bind(nowIso(), t.orgId, p.id),
    auditStmt(c.env.DB, { organizationId: t.orgId, actorUserId: t.userId, action: "social.post_cancel", entityType: "social_post", entityId: p.id, requestId: c.get("requestId") }),
  ]);
  if (!r[0]!.meta.changes) throw new ApiError(409, "bad_state", "Ya no se puede cancelar: se está publicando.");
  return c.json(postOut((await loadPost(c, p.id))!, t.orgId));
});

social.delete("/social/posts/:id", requireScope("content:write"), async (c) => {
  const t = c.get("tenant");
  const p = await loadPost(c, c.req.param("id"));
  if (["approved", "publishing"].includes(p.status)) throw new ApiError(409, "bad_state", "Cancela la publicación antes de borrarla.");
  await c.env.DB.batch([
    c.env.DB.prepare("DELETE FROM social_posts WHERE organization_id = ? AND id = ?").bind(t.orgId, p.id),
    auditStmt(c.env.DB, { organizationId: t.orgId, actorUserId: t.userId, action: "social.post_delete", entityType: "social_post", entityId: p.id, requestId: c.get("requestId") }),
  ]);
  return c.json({ ok: true });
});

// ── Public endpoints: OAuth callback, Meta callbacks and the image Meta downloads ───────────────────
export function registerMetaPublic(app: Hono<AppEnv>) {
  app.get("/api/v1/auth/meta/callback", metaCallback);

  /**
   * Meta «Deauthorize callback»: the person removed DNI Growth from their Facebook account. Every
   * connection of that Meta user (any organisation: matched only by the app-scoped id Meta signs) loses
   * its tokens at once and pending posts are cancelled.
   */
  const forget = async (env: Env, metaUserId: string, reason: string) => {
    const now = nowIso();
    const ref = `meta:${metaUserId}`;
    const { results } = await env.DB.prepare("SELECT id, organization_id FROM integrations WHERE provider = 'meta' AND account_ref = ?").bind(ref).all<{ id: string; organization_id: string }>();
    for (const r of results) {
      await env.DB.batch([
        env.DB.prepare("DELETE FROM integration_secrets WHERE organization_id = ? AND integration_id = ?").bind(r.organization_id, r.id),
        env.DB.prepare("UPDATE social_accounts SET status = 'disconnected', token_enc = NULL, updated_at = ? WHERE organization_id = ? AND integration_id = ?").bind(now, r.organization_id, r.id),
        env.DB.prepare("UPDATE social_posts SET status = 'cancelled', last_error = ?, updated_at = ? WHERE organization_id = ? AND status IN ('pending_approval','approved')").bind(reason, now, r.organization_id),
        env.DB.prepare("UPDATE integrations SET status = 'disconnected', secret_ref = NULL, last_error = ? WHERE organization_id = ? AND id = ?").bind(reason, r.organization_id, r.id),
        auditStmt(env.DB, { organizationId: r.organization_id, actorUserId: null, action: "integration.disconnect", entityType: "integration", entityId: r.id, after: { provider: "meta", by: "meta_callback" } }),
      ]);
    }
    return results.length;
  };

  const signed = async (c: Context<AppEnv>) => {
    if (!c.env.META_APP_SECRET) return null;
    const form = await c.req.parseBody().catch(() => ({}) as Record<string, unknown>);
    const sr = typeof form.signed_request === "string" ? form.signed_request : "";
    return parseSignedRequest(c.env.META_APP_SECRET, sr);
  };

  app.post("/api/v1/webhooks/meta/deauthorize", async (c) => {
    const data = await signed(c);
    if (!data?.user_id || !/^\d{1,40}$/.test(data.user_id)) return c.json({ error: "invalid_signed_request" }, 400);
    const n = await forget(c.env, data.user_id, "La persona retiró el acceso desde Facebook.");
    log("info", "meta.deauthorized", { connections: n });
    return c.json({ ok: true });
  });

  /** Meta «Data deletion request callback»: deletes what we hold about that Meta user and returns a code. */
  app.post("/api/v1/webhooks/meta/data-deletion", async (c) => {
    const data = await signed(c);
    if (!data?.user_id || !/^\d{1,40}$/.test(data.user_id)) return c.json({ error: "invalid_signed_request" }, 400);
    await forget(c.env, data.user_id, "Datos eliminados a petición desde Facebook.");
    const confirmation = (await sha256Hex(`${data.user_id}:${nowIso()}`)).slice(0, 16);
    log("info", "meta.data_deletion", { confirmation });
    return c.json({ url: `${c.env.APP_ORIGIN.replace(/\/$/, "")}/legal/eliminacion-datos?codigo=${confirmation}`, confirmation_code: confirmation });
  });

  /** The image of an approved post, for Meta's servers only (signed URL, expires in hours). */
  app.get("/api/v1/public/social-media/:org/:post/:exp/:file", async (c) => {
    const orgId = c.req.param("org");
    const postId = c.req.param("post");
    const sig = c.req.param("file").replace(/\.jpg$/, "");
    if (!/^[0-9a-f-]{36}$/.test(orgId) || !/^[0-9a-f-]{36}$/.test(postId) || !/^[0-9a-f]{32}$/.test(sig)) return c.text("Not found", 404);
    if (!(await verifySocialMediaSig(c.env, orgId, postId, c.req.param("exp"), sig))) return c.text("Not found", 404);
    const p = await c.env.DB.prepare("SELECT media_id, status FROM social_posts WHERE organization_id = ? AND id = ?").bind(orgId, postId).first<{ media_id: string | null; status: string }>();
    if (!p?.media_id || !["approved", "publishing", "published"].includes(p.status)) return c.text("Not found", 404);
    const m = await c.env.DB.prepare("SELECT r2_key, content_type FROM media_uploads WHERE organization_id = ? AND id = ?").bind(orgId, p.media_id).first<{ r2_key: string; content_type: string }>();
    if (!m || !m.r2_key.startsWith(`media/${orgId}/`) || !c.env.MEDIA) return c.text("Not found", 404);
    const obj = await c.env.MEDIA.get(m.r2_key);
    if (!obj) return c.text("Not found", 404);
    return new Response(obj.body, { headers: { "content-type": m.content_type, "cache-control": "private, max-age=600", "x-content-type-options": "nosniff", "x-robots-tag": "noindex" } });
  });
}
