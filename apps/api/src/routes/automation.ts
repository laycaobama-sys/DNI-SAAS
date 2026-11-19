import { Hono } from "hono";
import { z } from "zod";
import { AutomationRuleInput } from "@dni/core";
import type { AppEnv } from "../env";
import { auditStmt } from "../lib/audit";
import { orgPlan } from "../lib/billing";
import { ApiError, assertUuid, notFound, parseBody } from "../lib/http";
import { describeActions, dryRun, newWebhookSecret, parseRule } from "../lib/rules";
import { nowIso, toCsv, uuid } from "../lib/util";
import { requireScope } from "../middleware";

/** F5 rule engine management + F7 data-based attribution (UTM → contacto → ganado). */
export const automation = new Hono<AppEnv>();

type RuleRow = { id: string; organization_id: string; name: string; trigger: "lead_created" | "stage_changed" | "task_overdue"; conditions_json: string; actions_json: string; enabled: number; webhook_secret_enc: string | null; created_at: string; updated_at: string };
const RULE_COLS = "id, organization_id, name, trigger, conditions_json, actions_json, enabled, webhook_secret_enc, created_at, updated_at";

const shape = (r: RuleRow) => {
  const p = parseRule(r);
  return { id: r.id, name: r.name, trigger: r.trigger, enabled: !!r.enabled, conditions: p.conditions ?? [], actions: p.actions ?? [], summary: p.actions ? describeActions(p.actions) : [], hasWebhookSecret: !!r.webhook_secret_enc, createdAt: r.created_at, updatedAt: r.updated_at };
};

async function loadRule(db: D1Database, orgId: string, id: string) {
  const r = await db.prepare(`SELECT ${RULE_COLS} FROM automation_rules WHERE organization_id = ? AND id = ?`).bind(orgId, assertUuid(id, "Regla")).first<RuleRow>();
  if (!r) throw notFound("Regla");
  return r;
}

async function ruleLimit(db: D1Database, orgId: string) {
  const plan = await orgPlan(db, orgId);
  const limit = (plan.limits as { automationRules?: number }).automationRules ?? 2;
  const used = (await db.prepare("SELECT COUNT(*) AS n FROM automation_rules WHERE organization_id = ?").bind(orgId).first<{ n: number }>())?.n ?? 0;
  return { used, limit };
}

automation.get("/automations/rules", requireScope("crm:read"), async (c) => {
  const t = c.get("tenant");
  const db = c.env.DB;
  const [rules, runs, deliveries, members, forms] = await Promise.all([
    db.prepare(`SELECT ${RULE_COLS} FROM automation_rules WHERE organization_id = ? ORDER BY created_at DESC`).bind(t.orgId).all<RuleRow>(),
    db.prepare("SELECT r.id, r.rule_id, a.name AS rule_name, r.status, r.detail_json, r.created_at FROM automation_runs r JOIN automation_rules a ON a.organization_id = r.organization_id AND a.id = r.rule_id WHERE r.organization_id = ? ORDER BY r.created_at DESC LIMIT 50").bind(t.orgId).all(),
    db.prepare("SELECT id, rule_id, url, status, attempts, last_status, last_error, next_attempt_at, created_at FROM webhook_deliveries WHERE organization_id = ? ORDER BY created_at DESC LIMIT 30").bind(t.orgId).all(),
    db.prepare("SELECT u.id, u.name FROM memberships m JOIN users u ON u.id = m.user_id WHERE m.organization_id = ? AND m.status = 'active' ORDER BY u.name").bind(t.orgId).all(),
    db.prepare("SELECT id, name FROM lead_forms WHERE organization_id = ? AND status = 'active' ORDER BY name").bind(t.orgId).all(),
  ]);
  return c.json({ rules: rules.results.map(shape), runs: runs.results, deliveries: deliveries.results, members: members.results, forms: forms.results, usage: await ruleLimit(db, t.orgId) });
});

automation.post("/automations/rules", requireScope("crm:write"), async (c) => {
  const t = c.get("tenant");
  const b = await parseBody(c, AutomationRuleInput);
  const u = await ruleLimit(c.env.DB, t.orgId);
  if (u.used >= u.limit) throw new ApiError(402, "plan_limit", `Tu plan permite ${u.limit} reglas de automatización.`);
  const id = uuid();
  const now = nowIso();
  const needsSecret = b.actions.some((a) => a.type === "webhook");
  const sec = needsSecret ? await newWebhookSecret(c.env, t.orgId, id) : null;
  await c.env.DB.batch([
    c.env.DB.prepare("INSERT INTO automation_rules (id, organization_id, name, trigger, conditions_json, actions_json, enabled, webhook_secret_enc, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").bind(
      id, t.orgId, b.name, b.trigger, JSON.stringify(b.conditions), JSON.stringify(b.actions), b.enabled ? 1 : 0, sec?.enc ?? null, t.userId, now, now,
    ),
    auditStmt(c.env.DB, { organizationId: t.orgId, actorUserId: t.userId, action: "automation.rule_create", entityType: "automation_rule", entityId: id, after: { trigger: b.trigger, actions: b.actions.map((a) => a.type), enabled: b.enabled }, requestId: c.get("requestId") }),
  ]);
  // The signing secret is shown ONCE so the customer can verify our webhooks; it is stored encrypted.
  return c.json({ rule: shape(await loadRule(c.env.DB, t.orgId, id)), webhookSecret: sec?.secret ?? null }, 201);
});

automation.put("/automations/rules/:id", requireScope("crm:write"), async (c) => {
  const t = c.get("tenant");
  const r = await loadRule(c.env.DB, t.orgId, c.req.param("id"));
  const b = await parseBody(c, AutomationRuleInput);
  const needsSecret = b.actions.some((a) => a.type === "webhook");
  const sec = needsSecret && !r.webhook_secret_enc ? await newWebhookSecret(c.env, t.orgId, r.id) : null;
  await c.env.DB.batch([
    c.env.DB.prepare("UPDATE automation_rules SET name = ?, trigger = ?, conditions_json = ?, actions_json = ?, enabled = ?, webhook_secret_enc = COALESCE(?, webhook_secret_enc), updated_at = ? WHERE organization_id = ? AND id = ?").bind(
      b.name, b.trigger, JSON.stringify(b.conditions), JSON.stringify(b.actions), b.enabled ? 1 : 0, sec?.enc ?? null, nowIso(), t.orgId, r.id,
    ),
    auditStmt(c.env.DB, { organizationId: t.orgId, actorUserId: t.userId, action: b.enabled !== !!r.enabled ? (b.enabled ? "automation.rule_enable" : "automation.rule_disable") : "automation.rule_update", entityType: "automation_rule", entityId: r.id, after: { trigger: b.trigger, actions: b.actions.map((a) => a.type), enabled: b.enabled }, requestId: c.get("requestId") }),
  ]);
  return c.json({ rule: shape(await loadRule(c.env.DB, t.orgId, r.id)), webhookSecret: sec?.secret ?? null });
});

automation.delete("/automations/rules/:id", requireScope("crm:write"), async (c) => {
  const t = c.get("tenant");
  const r = await loadRule(c.env.DB, t.orgId, c.req.param("id"));
  await c.env.DB.batch([
    c.env.DB.prepare("DELETE FROM automation_rules WHERE organization_id = ? AND id = ?").bind(t.orgId, r.id),
    auditStmt(c.env.DB, { organizationId: t.orgId, actorUserId: t.userId, action: "automation.rule_delete", entityType: "automation_rule", entityId: r.id, requestId: c.get("requestId") }),
  ]);
  return c.json({ ok: true });
});

automation.post("/automations/rules/:id/dry-run", requireScope("crm:write"), async (c) => {
  const t = c.get("tenant");
  const r = await loadRule(c.env.DB, t.orgId, c.req.param("id"));
  const { leadId } = await parseBody(c, z.strictObject({ leadId: z.string().uuid() }));
  const out = await dryRun(c.env, t.orgId, r, leadId);
  if (!out) throw notFound("Contacto");
  return c.json(out);
});

automation.post("/automations/rules/:id/rotate-secret", requireScope("crm:write"), async (c) => {
  const t = c.get("tenant");
  const r = await loadRule(c.env.DB, t.orgId, c.req.param("id"));
  const sec = await newWebhookSecret(c.env, t.orgId, r.id);
  await c.env.DB.batch([
    c.env.DB.prepare("UPDATE automation_rules SET webhook_secret_enc = ?, updated_at = ? WHERE organization_id = ? AND id = ?").bind(sec.enc, nowIso(), t.orgId, r.id),
    auditStmt(c.env.DB, { organizationId: t.orgId, actorUserId: t.userId, action: "automation.secret_rotate", entityType: "automation_rule", entityId: r.id, requestId: c.get("requestId") }),
  ]);
  return c.json({ webhookSecret: sec.secret });
});

automation.post("/automations/deliveries/:id/retry", requireScope("crm:write"), async (c) => {
  const t = c.get("tenant");
  const r = await c.env.DB.prepare("UPDATE webhook_deliveries SET status = 'queued', next_attempt_at = ?, updated_at = ? WHERE organization_id = ? AND id = ? AND status IN ('failed','dead')")
    .bind(nowIso(), nowIso(), t.orgId, assertUuid(c.req.param("id"), "Envío"))
    .run();
  if (!r.meta.changes) throw notFound("Envío");
  return c.json({ ok: true });
});

// ── Attribution: real CRM data only, first touch (the UTM/landing recorded when the lead arrived) ──
const PeriodQuery = z.object({ days: z.coerce.number().int().min(1).max(730).default(90), group: z.enum(["source", "campaign", "landing", "form"]).default("source") });

automation.get("/crm/attribution", requireScope("crm:read"), async (c) => {
  const t = c.get("tenant");
  const q = PeriodQuery.parse({ days: c.req.query("days"), group: c.req.query("group") });
  const since = new Date(Date.now() - q.days * 86400_000).toISOString();
  const key =
    q.group === "source"
      ? "COALESCE(NULLIF(l.utm_source, '') || ' / ' || COALESCE(NULLIF(l.utm_medium, ''), '—'), CASE WHEN l.referrer_host IS NOT NULL THEN 'referencia: ' || l.referrer_host WHEN l.source = 'manual' THEN 'alta manual' ELSE 'directo / sin UTM' END)"
      : q.group === "campaign"
        ? "COALESCE(NULLIF(l.utm_campaign, ''), '(sin campaña)')"
        : q.group === "landing"
          ? "COALESCE(lp.name, '(sin landing)')"
          : "COALESCE(f.name, '(sin formulario)')";
  const { results } = await c.env.DB.prepare(
    `SELECT ${key} AS channel, COUNT(*) AS leads,
       SUM(CASE WHEN l.stage IN ('qualified','proposal','won') THEN 1 ELSE 0 END) AS qualified,
       SUM(CASE WHEN l.stage = 'won' THEN 1 ELSE 0 END) AS won,
       SUM(CASE WHEN l.stage = 'lost' THEN 1 ELSE 0 END) AS lost,
       COALESCE(SUM(CASE WHEN l.stage = 'won' THEN l.value_cents ELSE 0 END), 0) AS won_cents,
       COALESCE(SUM(CASE WHEN l.stage NOT IN ('won','lost') THEN l.value_cents ELSE 0 END), 0) AS open_cents
     FROM leads l
     LEFT JOIN lead_forms f ON f.organization_id = l.organization_id AND f.id = l.form_id
     LEFT JOIN landing_pages lp ON lp.organization_id = l.organization_id AND lp.id = l.landing_id
     WHERE l.organization_id = ? AND l.is_test = 0 AND l.created_at >= ?
     GROUP BY channel ORDER BY won_cents DESC, leads DESC LIMIT 100`,
  )
    .bind(t.orgId, since)
    .all<{ channel: string; leads: number; qualified: number; won: number; lost: number; won_cents: number; open_cents: number }>();
  const rows = results.map((r) => ({ channel: r.channel, leads: r.leads, qualified: r.qualified, won: r.won, lost: r.lost, wonValue: r.won_cents / 100, openValue: r.open_cents / 100, winRate: r.won + r.lost ? r.won / (r.won + r.lost) : null, leadToWon: r.leads ? r.won / r.leads : null }));
  const total = rows.reduce((a, r) => ({ leads: a.leads + r.leads, won: a.won + r.won, wonValue: a.wonValue + r.wonValue }), { leads: 0, won: 0, wonValue: 0 });
  if (c.req.query("format") === "csv") {
    return new Response(toCsv(["canal", "contactos", "cualificados", "ganados", "perdidos", "valor_ganado_eur", "valor_abierto_eur"], rows.map((r) => [r.channel, r.leads, r.qualified, r.won, r.lost, r.wonValue, r.openValue])), {
      headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="atribucion-${q.group}-${q.days}d.csv"`, "cache-control": "no-store" },
    });
  }
  return c.json({
    period: { days: q.days, since, until: nowIso() },
    group: q.group,
    rows,
    total,
    measurement: "derived",
    source: "CRM de DNI Growth (contactos reales, sin pruebas)",
    model: "Primer contacto: el canal/UTM/landing registrado cuando llegó el contacto.",
    caveats: [
      "El valor ganado es el que tu equipo declara en el CRM, no un cobro verificado.",
      "Sin datos de inversión publicitaria conectados no calculamos ROAS ni CPA.",
      "Los contactos sin UTM aparecen como «directo / sin UTM» o por el dominio que los refirió.",
    ],
  });
});
