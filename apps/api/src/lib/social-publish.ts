import { IG_DAILY_POSTS, planIncludes, type SocialNetwork } from "@dni/core";
import type { Deps, Env } from "../env";
import { auditStmt } from "./audit";
import { orgPlan } from "./billing";
import { createIgContainer, igContainerStatus, igPublish, MetaApiError, metaReady, openPageToken, publishFacebook, socialMediaUrl } from "./meta";
import { log, nowIso } from "./util";

/**
 * Cron (every minute): publishes approved posts whose time has come. Never twice:
 * - a post is claimed with a conditional UPDATE (approved → publishing), so two runs cannot both take it;
 * - Instagram is two steps (container → publish) and the container id is stored before publishing,
 *   so a crash resumes the same container instead of creating a second post;
 * - a Facebook post whose outcome is unknown (crash between Meta's answer and our write) is NOT retried
 *   automatically: it is marked failed with a note to check the Page first.
 */
const BATCH = 5;
const STUCK_MS = 10 * 60_000;
const CONTAINER_MAX_MS = 60 * 60_000;

interface Due {
  id: string;
  organization_id: string;
  account_id: string;
  caption: string;
  link: string | null;
  media_id: string | null;
  container_id: string | null;
  publishing_started_at: string | null;
  attempts: number;
  approved_by: string | null;
  status: string;
}

const friendly = (e: unknown) => {
  if (e instanceof MetaApiError) {
    if (e.needsReauth) return "Facebook ha retirado o caducado el permiso. Vuelve a conectar la cuenta.";
    if (e.userMessage) return `Meta: ${e.userMessage}`.slice(0, 280);
    if (/^meta_(4|17|32|613)(_|$)/.test(e.code)) return "Meta ha limitado temporalmente las publicaciones. Se reintentará más tarde.";
    return `Meta rechazó la publicación (${e.code}).`;
  }
  return "Error inesperado al publicar.";
};
/**
 * Safe to retry: rate limits (nothing was posted) always; network/5xx only on Instagram, where the stored
 * container makes the retry idempotent. A Facebook network error may have posted, so it is not retried.
 */
const transient = (e: unknown, network: SocialNetwork) =>
  e instanceof MetaApiError && (/^meta_(4|17|32|613)(_|$)/.test(e.code) || (network === "instagram" && (e.code === "network_error" || /^http_5/.test(e.code) || /^meta_(1|2)(_|$)/.test(e.code))));

export async function publishDueSocialPosts(env: Env, deps: Deps): Promise<{ published: number; failed: number }> {
  if (!metaReady(env)) return { published: 0, failed: 0 };
  const db = env.DB;
  const now = nowIso();
  let published = 0;
  let failed = 0;

  // 1) Facebook posts (or Instagram before its container existed) stuck in «publishing»: outcome unknown.
  await db
    .prepare(
      "UPDATE social_posts SET status = 'failed', last_error = 'No sabemos si llegó a publicarse (se cortó la conexión). Revisa tu página antes de reintentar.', updated_at = ? WHERE status = 'publishing' AND container_id IS NULL AND publishing_started_at < ? AND organization_id IS NOT NULL",
    )
    .bind(now, new Date(Date.now() - STUCK_MS).toISOString())
    .run();

  // 2) Due work: approved and due, plus Instagram containers waiting for Meta to process the image.
  const { results } = await db
    .prepare(
      `SELECT id, organization_id, account_id, caption, link, media_id, container_id, publishing_started_at, attempts, approved_by, status FROM social_posts
       WHERE (status = 'approved' AND scheduled_at <= ?) OR (status = 'publishing' AND container_id IS NOT NULL)
       ORDER BY scheduled_at LIMIT ?`,
    )
    .bind(now, BATCH)
    .all<Due>();

  for (const p of results) {
    const orgId = p.organization_id;
    const fail = async (msg: string, retryable = false) => {
      if (retryable && p.attempts < 5) {
        // Back to the queue in 15 minutes (an Instagram container is kept: the retry resumes it, never posts twice).
        await db
          .prepare("UPDATE social_posts SET status = 'approved', scheduled_at = ?, last_error = ?, updated_at = ? WHERE organization_id = ? AND id = ?")
          .bind(new Date(Date.now() + 15 * 60_000).toISOString(), msg, nowIso(), orgId, p.id)
          .run();
        return;
      }
      failed++;
      await db.batch([
        db.prepare("UPDATE social_posts SET status = 'failed', last_error = ?, updated_at = ? WHERE organization_id = ? AND id = ?").bind(msg.slice(0, 300), nowIso(), orgId, p.id),
        auditStmt(db, { organizationId: orgId, actorUserId: null, action: "social.post_failed", entityType: "social_post", entityId: p.id, after: { reason: msg.slice(0, 200) } }),
      ]);
    };

    const acc = await db
      .prepare(
        `SELECT a.network, a.external_id, a.page_id, a.token_enc, a.status, i.status AS conn FROM social_accounts a JOIN integrations i ON i.organization_id = a.organization_id AND i.id = a.integration_id
         WHERE a.organization_id = ? AND a.id = ?`,
      )
      .bind(orgId, p.account_id)
      .first<{ network: SocialNetwork; external_id: string; page_id: string; token_enc: string | null; status: string; conn: string }>();
    if (!acc) continue;
    if (acc.conn === "paused") continue; // kill switch: approved posts wait
    if (p.status === "approved") {
      // Claim (only one run can take it).
      const claim = await db
        .prepare("UPDATE social_posts SET status = 'publishing', publishing_started_at = ?, attempts = attempts + 1, updated_at = ? WHERE organization_id = ? AND id = ? AND status = 'approved'")
        .bind(nowIso(), nowIso(), orgId, p.id)
        .run();
      if (!claim.meta.changes) continue;
    }
    if (acc.status !== "active" || !acc.token_enc || acc.conn !== "connected") {
      await fail("La cuenta ya no está conectada. Vuelve a conectar con Facebook y reintenta.");
      continue;
    }
    const plan = await orgPlan(db, orgId);
    if (!planIncludes(plan.code, "social")) {
      await fail("Tu plan actual no incluye la publicación en redes.");
      continue;
    }

    try {
      const token = await openPageToken(env, orgId, p.account_id, acc.token_enc);
      const imageUrl = p.media_id ? await socialMediaUrl(env, orgId, p.id) : null;
      let result: { id: string; url: string | null };
      if (acc.network === "facebook") {
        result = await publishFacebook(env, deps, acc.page_id, token, { caption: p.caption, link: p.link, imageUrl });
      } else {
        const sent = await db
          .prepare("SELECT COUNT(*) AS n FROM social_posts WHERE organization_id = ? AND account_id = ? AND status = 'published' AND published_at > ?")
          .bind(orgId, p.account_id, new Date(Date.now() - 86_400_000).toISOString())
          .first<{ n: number }>();
        if ((sent?.n ?? 0) >= IG_DAILY_POSTS) {
          await db
            .prepare("UPDATE social_posts SET status = 'approved', scheduled_at = ?, last_error = ?, updated_at = ? WHERE organization_id = ? AND id = ?")
            .bind(new Date(Date.now() + 3_600_000).toISOString(), `Límite de ${IG_DAILY_POSTS} publicaciones al día en esta cuenta: se publicará más tarde.`, nowIso(), orgId, p.id)
            .run();
          continue;
        }
        let container = p.container_id;
        if (!container) {
          if (!imageUrl) throw new MetaApiError("no_image");
          container = await createIgContainer(env, deps, acc.external_id, token, imageUrl, p.caption);
          await db.prepare("UPDATE social_posts SET container_id = ?, updated_at = ? WHERE organization_id = ? AND id = ?").bind(container, nowIso(), orgId, p.id).run();
        }
        const status = await igContainerStatus(env, deps, container, token);
        if (status === "IN_PROGRESS") {
          if (p.publishing_started_at && Date.now() - Date.parse(p.publishing_started_at) > CONTAINER_MAX_MS) await fail("Instagram no terminó de procesar la imagen en una hora.");
          continue; // next minute
        }
        if (status === "ERROR" || status === "EXPIRED") {
          await fail(status === "EXPIRED" ? "El contenedor de Instagram caducó (24 h)." : "Instagram no pudo procesar la imagen. Prueba con otra imagen JPG.");
          continue;
        }
        if (status === "PUBLISHED") {
          result = { id: container, url: null }; // already live (an earlier run published it)
        } else result = await igPublish(env, deps, acc.external_id, token, container);
      }
      published++;
      const at = nowIso();
      await db.batch([
        db
          .prepare("UPDATE social_posts SET status = 'published', external_id = ?, external_url = ?, published_at = ?, last_error = NULL, updated_at = ? WHERE organization_id = ? AND id = ?")
          .bind(result.id.slice(0, 80), result.url?.slice(0, 500) ?? null, at, at, orgId, p.id),
        auditStmt(db, { organizationId: orgId, actorUserId: null, action: "social.post_published", entityType: "social_post", entityId: p.id, after: { network: acc.network }, approvedBy: p.approved_by }),
      ]);
    } catch (e) {
      log("warn", "social.publish_failed", { postId: p.id, code: e instanceof MetaApiError ? e.code : "unknown" });
      if (e instanceof MetaApiError && e.needsReauth) {
        await db.prepare("UPDATE integrations SET status = 'reauth_required', last_error = ? WHERE organization_id = ? AND provider = 'meta'").bind(e.code, orgId).run();
      }
      await fail(e instanceof MetaApiError && !transient(e, acc.network) && acc.network === "facebook" && (e.code === "network_error" || /^http_5/.test(e.code)) ? "No sabemos si llegó a publicarse (Meta no respondió). Revisa tu página antes de reintentar." : friendly(e), transient(e, acc.network));
    }
  }
  return { published, failed };
}
