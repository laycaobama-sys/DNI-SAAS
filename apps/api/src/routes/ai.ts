import { Hono } from "hono";
import { AdvisorInput, buildAdvisorMessages, checkImagePrompt, ImageInput, type AdvisorContext, type ChatMessage } from "@dni/core";
import type { AppEnv } from "../env";
import { AiUnavailableError, aiStatus, generateImage, generateText } from "../lib/ai";
import { auditStmt } from "../lib/audit";
import { ensureMonthlyGrant, orgPlan, reserveCredits, usageLedgerStmt } from "../lib/billing";
import { ApiError, parseBody } from "../lib/http";
import { rateLimit } from "../lib/ratelimit";
import { nowIso, parseJson, uuid } from "../lib/util";
import { requireScope } from "../middleware";

export const ADVISOR_CREDITS = 1;
export const IMAGE_CREDITS = 5;

const unavailable = () =>
  new ApiError(503, "ai_unavailable", "Los modelos de IA no están disponibles en este momento (o se ha alcanzado el límite diario gratuito). No se ha cobrado ningún crédito. Inténtalo más tarde.");
const noCredits = () => new ApiError(402, "insufficient_credits", "No tienes créditos suficientes para esta acción.");

export const ai = new Hono<AppEnv>();

ai.get("/ai/status", requireScope("ai:use"), async (c) => c.json(await aiStatus(c.env)));

/** Builds the advisor context from tenant data (all queries scoped by organization_id). */
async function advisorContext(db: D1Database, orgId: string, brandId: string | null): Promise<AdvisorContext> {
  const org = await db.prepare("SELECT name FROM organizations WHERE id = ?").bind(orgId).first<{ name: string }>();
  const brand = brandId
    ? await db.prepare("SELECT id, name FROM brands WHERE organization_id = ? AND id = ?").bind(orgId, brandId).first<{ id: string; name: string }>()
    : await db.prepare("SELECT id, name FROM brands WHERE organization_id = ? ORDER BY created_at DESC LIMIT 1").bind(orgId).first<{ id: string; name: string }>();
  if (brandId && !brand) throw new ApiError(404, "not_found", "Marca no encontrada.");
  const ctx: AdvisorContext = { orgName: org?.name ?? "", brand: null, audit: null, plan: null };
  if (!brand) return ctx;
  const profile = await db
    .prepare("SELECT audience, tone, objective, prohibited_claims_json FROM brand_profiles WHERE organization_id = ? AND brand_id = ? ORDER BY version DESC LIMIT 1")
    .bind(orgId, brand.id)
    .first<{ audience: string; tone: string; objective: string; prohibited_claims_json: string }>();
  ctx.brand = { name: brand.name, audience: profile?.audience, tone: profile?.tone, objective: profile?.objective, prohibitedClaims: parseJson<string[]>(profile?.prohibited_claims_json, []) };
  const crawl = await db
    .prepare(
      `SELECT wc.id, s.origin, wc.health_score, wc.completed_at, wc.opportunities_json FROM web_crawls wc
       JOIN sites s ON s.organization_id = wc.organization_id AND s.id = wc.site_id
       WHERE wc.organization_id = ? AND s.brand_id = ? AND wc.status = 'completed' ORDER BY wc.completed_at DESC LIMIT 1`,
    )
    .bind(orgId, brand.id)
    .first<{ id: string; origin: string; health_score: number | null; completed_at: string | null; opportunities_json: string }>();
  if (crawl) {
    const ops = parseJson<Array<{ title: string; severity: string; fix: string; affectedCount: number }>>(crawl.opportunities_json, []);
    ctx.audit = { origin: crawl.origin, healthScore: crawl.health_score, completedAt: crawl.completed_at, opportunities: ops };
    const { results } = await db
      .prepare(
        `SELECT gt.title, gt.status, gt.week FROM growth_tasks gt JOIN growth_plans gp ON gp.organization_id = gt.organization_id AND gp.id = gt.plan_id
         WHERE gt.organization_id = ? AND gp.crawl_id = ? ORDER BY gt.week, gt.position LIMIT 15`,
      )
      .bind(orgId, crawl.id)
      .all<{ title: string; status: string; week: number }>();
    ctx.plan = { tasks: results };
  }
  return ctx;
}

ai.get("/advisor/conversations", requireScope("ai:use"), async (c) => {
  const t = c.get("tenant");
  const { results } = await c.env.DB.prepare("SELECT id, title, brand_id, updated_at FROM ai_conversations WHERE organization_id = ? AND user_id = ? ORDER BY updated_at DESC LIMIT 50")
    .bind(t.orgId, t.userId)
    .all();
  return c.json({ items: results });
});

ai.get("/advisor/conversations/:convId", requireScope("ai:use"), async (c) => {
  const t = c.get("tenant");
  const conv = await c.env.DB.prepare("SELECT id, title, brand_id, updated_at FROM ai_conversations WHERE organization_id = ? AND user_id = ? AND id = ?")
    .bind(t.orgId, t.userId, c.req.param("convId"))
    .first();
  if (!conv) throw new ApiError(404, "not_found", "Conversación no encontrada.");
  const { results } = await c.env.DB.prepare("SELECT id, role, content, provider, model, credits, created_at FROM ai_messages WHERE organization_id = ? AND conversation_id = ? ORDER BY created_at, rowid")
    .bind(t.orgId, c.req.param("convId"))
    .all();
  return c.json({ conversation: conv, messages: results });
});

ai.post("/advisor", requireScope("ai:use"), async (c) => {
  const t = c.get("tenant");
  const db = c.env.DB;
  await rateLimit(db, `advisor:${t.orgId}:${t.userId}`, 20, 600);
  await rateLimit(db, `advisor-org:${t.orgId}`, 200, 86400);
  const input = await parseBody(c, AdvisorInput);

  let convId = input.conversationId ?? null;
  let history: ChatMessage[] = [];
  let brandId = input.brandId ?? null;
  if (convId) {
    const conv = await db.prepare("SELECT id, brand_id FROM ai_conversations WHERE organization_id = ? AND user_id = ? AND id = ?").bind(t.orgId, t.userId, convId).first<{ id: string; brand_id: string | null }>();
    if (!conv) throw new ApiError(404, "not_found", "Conversación no encontrada.");
    brandId = conv.brand_id;
    const { results } = await db
      .prepare("SELECT role, content FROM ai_messages WHERE organization_id = ? AND conversation_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 8")
      .bind(t.orgId, convId)
      .all<{ role: "user" | "assistant"; content: string }>();
    history = results.reverse();
  }
  const ctx = await advisorContext(db, t.orgId, brandId);

  await ensureMonthlyGrant(db, t.orgId, await orgPlan(db, t.orgId));
  const msgId = uuid();
  if (!(await reserveCredits(db, { orgId: t.orgId, refId: msgId, amount: ADVISOR_CREDITS, category: "ai_advisor" }))) throw noCredits();

  let result;
  try {
    result = await generateText(c.env, c.get("deps"), buildAdvisorMessages(ctx, history, input.question));
  } catch (e) {
    await usageLedgerStmt(db, { orgId: t.orgId, refId: msgId, kind: "release", amount: ADVISOR_CREDITS, category: "ai_advisor" }).run();
    if (e instanceof AiUnavailableError) throw unavailable();
    throw e;
  }

  const stmts: D1PreparedStatement[] = [];
  if (!convId) {
    convId = uuid();
    stmts.push(
      db.prepare("INSERT INTO ai_conversations (id, organization_id, user_id, brand_id, title) VALUES (?, ?, ?, ?, ?)").bind(convId, t.orgId, t.userId, brandId, input.question.slice(0, 80)),
    );
  }
  const now = nowIso();
  stmts.push(
    db.prepare("INSERT INTO ai_messages (id, organization_id, conversation_id, role, content, created_at) VALUES (?, ?, ?, 'user', ?, ?)").bind(uuid(), t.orgId, convId, input.question, now),
    db
      .prepare(
        "INSERT INTO ai_messages (id, organization_id, conversation_id, role, content, provider, model, input_tokens, output_tokens, cost_usd, credits, created_at) VALUES (?, ?, ?, 'assistant', ?, ?, ?, ?, ?, ?, ?, ?)",
      )
      .bind(msgId, t.orgId, convId, result.text, result.provider, result.model, result.inputTokens, result.outputTokens, result.costUsd, ADVISOR_CREDITS, new Date(Date.parse(now) + 1).toISOString()),
    db.prepare("UPDATE ai_conversations SET updated_at = ? WHERE organization_id = ? AND id = ?").bind(now, t.orgId, convId),
    usageLedgerStmt(db, { orgId: t.orgId, refId: msgId, kind: "release", amount: ADVISOR_CREDITS, category: "ai_advisor" }),
    usageLedgerStmt(db, { orgId: t.orgId, refId: msgId, kind: "settle", amount: ADVISOR_CREDITS, category: "ai_advisor", provider: result.provider }),
  );
  await db.batch(stmts);
  return c.json({
    conversationId: convId,
    message: { id: msgId, role: "assistant", content: result.text, provider: result.provider, model: result.model, credits: ADVISOR_CREDITS },
    measurement: "Respuesta generada por IA a partir de los datos observados de tu auditoría; revísala antes de aplicarla.",
  });
});

// ── Creative: image generation stored in R2 ──────────────────────────────────────────────────
ai.get("/creative/images", requireScope("ai:use"), async (c) => {
  const t = c.get("tenant");
  const { results } = await c.env.DB.prepare("SELECT id, prompt, format, provider, model, credits, created_at FROM ai_images WHERE organization_id = ? ORDER BY created_at DESC LIMIT 60")
    .bind(t.orgId)
    .all();
  return c.json({ items: results });
});

ai.post("/creative/images", requireScope("creative:generate"), async (c) => {
  const t = c.get("tenant");
  const db = c.env.DB;
  if (!c.env.MEDIA || !c.env.AI) throw new ApiError(503, "provider_not_configured", "La generación de imágenes no está activada.");
  await rateLimit(db, `image:${t.orgId}:${t.userId}`, 10, 3600);
  await rateLimit(db, `image-org:${t.orgId}`, 50, 86400);
  const input = await parseBody(c, ImageInput);
  const policy = checkImagePrompt(input.prompt);
  if (!policy.ok) throw new ApiError(422, "prompt_rejected", policy.reason);

  await ensureMonthlyGrant(db, t.orgId, await orgPlan(db, t.orgId));
  const id = uuid();
  if (!(await reserveCredits(db, { orgId: t.orgId, refId: id, amount: IMAGE_CREDITS, category: "ai_image" }))) throw noCredits();

  let img;
  try {
    img = await generateImage(c.env, c.get("deps"), input.prompt);
  } catch (e) {
    await usageLedgerStmt(db, { orgId: t.orgId, refId: id, kind: "release", amount: IMAGE_CREDITS, category: "ai_image" }).run();
    if (e instanceof AiUnavailableError) throw unavailable();
    throw e;
  }
  const ext = img.contentType.split("/")[1];
  const key = `media/${t.orgId}/${id}.${ext}`;
  try {
    await c.env.MEDIA.put(key, img.bytes, { httpMetadata: { contentType: img.contentType }, customMetadata: { organizationId: t.orgId, provider: img.provider } });
  } catch (e) {
    await usageLedgerStmt(db, { orgId: t.orgId, refId: id, kind: "release", amount: IMAGE_CREDITS, category: "ai_image" }).run();
    throw e;
  }
  await db.batch([
    db.prepare("INSERT INTO ai_images (id, organization_id, user_id, prompt, format, r2_key, provider, model, cost_usd, credits) VALUES (?, ?, ?, ?, 'square', ?, ?, ?, ?, ?)").bind(
      id, t.orgId, t.userId, input.prompt, key, img.provider, img.model, img.costUsd, IMAGE_CREDITS,
    ),
    usageLedgerStmt(db, { orgId: t.orgId, refId: id, kind: "release", amount: IMAGE_CREDITS, category: "ai_image" }),
    usageLedgerStmt(db, { orgId: t.orgId, refId: id, kind: "settle", amount: IMAGE_CREDITS, category: "ai_image", provider: img.provider }),
    auditStmt(db, { organizationId: t.orgId, actorUserId: t.userId, action: "creative.image_generate", entityType: "ai_image", entityId: id, after: { provider: img.provider, model: img.model }, requestId: c.get("requestId") }),
  ]);
  return c.json({ id, provider: img.provider, model: img.model, credits: IMAGE_CREDITS, url: `/api/v1/orgs/${t.orgId}/creative/images/${id}/file` }, 201);
});

ai.get("/creative/images/:imageId/file", requireScope("ai:use"), async (c) => {
  const t = c.get("tenant");
  const row = await c.env.DB.prepare("SELECT r2_key FROM ai_images WHERE organization_id = ? AND id = ?").bind(t.orgId, c.req.param("imageId")).first<{ r2_key: string }>();
  // Defence in depth: the key must live under this tenant's prefix.
  if (!row || !row.r2_key.startsWith(`media/${t.orgId}/`) || !c.env.MEDIA) throw new ApiError(404, "not_found", "Imagen no encontrada.");
  const obj = await c.env.MEDIA.get(row.r2_key);
  if (!obj) throw new ApiError(404, "not_found", "Imagen no encontrada.");
  return new Response(obj.body, {
    headers: {
      "content-type": obj.httpMetadata?.contentType ?? "application/octet-stream",
      "cache-control": "private, max-age=3600",
      "x-content-type-options": "nosniff",
      "content-disposition": `inline; filename="dni-growth-${c.req.param("imageId").slice(0, 8)}.${row.r2_key.split(".").pop()}"`,
    },
  });
});
