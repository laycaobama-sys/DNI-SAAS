import { Hono, type Context } from "hono";
import { z } from "zod";
import {
  AllowedOrigins,
  can,
  DEFAULT_CONSENT_TEXT,
  DEFAULT_MARKETING_TEXT,
  DEFAULT_SUCCESS_MESSAGE,
  isRole,
  LEAD_CAVEATS,
  LEAD_FORM_LIMITS,
  LEAD_STAGE_LABEL,
  LEAD_STAGES,
  LeadSubmission,
  cleanLine,
  cleanMultiline,
  normalizeEmail,
  pageUrlWithoutQuery,
  referrerHost,
  spamSignals,
  type LeadStage,
} from "@dni/core";
import type { AppEnv, Env } from "../env";
import { auditStmt } from "../lib/audit";
import { orgPlan } from "../lib/billing";
import { ApiError, assertUuid, notFound, parseBody } from "../lib/http";
import { emailHtml, sendMail } from "../lib/mail";
import { rateLimit } from "../lib/ratelimit";
import { hashIp, log, nowIso, parseJson, toCsv, uuid } from "../lib/util";
import { requireScope } from "../middleware";
import { AutoReplyConfig, FollowUpConfig, runLeadAutomations } from "../lib/automations";
import { recordLandingConversion } from "./landings";

/**
 * F5 — Lead capture (public, anti-spam, consent per purpose, UTM attribution, dedup by email)
 * and CRM (pipeline, owner, value, notes, tasks, full history, export and erasure).
 * Personal data never goes to logs, audit rows or emails: only ids and counters.
 */

type FormRow = {
  id: string;
  organization_id: string;
  brand_id: string | null;
  name: string;
  consent_text: string;
  marketing_text: string | null;
  privacy_url: string | null;
  success_message: string;
  redirect_url: string | null;
  allowed_origins_json: string;
  ask_phone: number;
  ask_company: number;
  notify: number;
  status: string;
};

const esc = (s: string) => s.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);

/** Minimal, self-contained page for forms posted without JavaScript. */
function resultPage(title: string, lines: string[], status: number, back?: string | null) {
  const body = `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${esc(title)}</title>
<style>body{font:16px/1.5 system-ui,sans-serif;margin:0;display:grid;min-height:100vh;place-items:center;background:#fafafa;color:#111}main{max-width:32rem;padding:2rem}h1{font-size:1.5rem}a{color:#3f6212}</style></head>
<body><main><h1>${esc(title)}</h1>${lines.map((l) => `<p>${esc(l)}</p>`).join("")}${back ? `<p><a href="${esc(back)}">Volver</a></p>` : ""}</main></body></html>`;
  return new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'" } });
}

function allowedOrigins(env: Env, form: FormRow): Set<string> {
  return new Set([new URL(env.APP_ORIGIN).origin, ...parseJson<string[]>(form.allowed_origins_json, [])]);
}

function corsHeaders(origin: string | undefined, allowed: Set<string>): Record<string, string> {
  if (!origin || !allowed.has(origin)) return {};
  return { "access-control-allow-origin": origin, "access-control-allow-methods": "POST, OPTIONS", "access-control-allow-headers": "content-type", "access-control-max-age": "600", vary: "Origin" };
}

async function loadPublicForm(env: Env, formId: string | undefined): Promise<FormRow | null> {
  if (!formId || !/^[0-9a-f-]{36}$/i.test(formId)) return null;
  return env.DB.prepare("SELECT id, organization_id, brand_id, name, consent_text, marketing_text, privacy_url, success_message, redirect_url, allowed_origins_json, ask_phone, ask_company, notify, status FROM lead_forms WHERE id = ? AND status = 'active'")
    .bind(formId)
    .first<FormRow>();
}

/** Owners/admins/marketing managers (active, verified) get a notification WITHOUT personal data. */
async function notifyTeam(env: Env, form: FormRow, leadId: string, n: number) {
  const { results } = await env.DB.prepare(
    `SELECT u.email FROM memberships m JOIN users u ON u.id = m.user_id
     WHERE m.organization_id = ? AND m.status = 'active' AND m.role IN ('owner','admin','marketing_manager') AND u.email_verified_at IS NOT NULL LIMIT 5`,
  )
    .bind(form.organization_id)
    .all<{ email: string }>();
  const url = `${env.APP_ORIGIN}/app/o/${form.organization_id}/crm?lead=${leadId}`;
  for (const r of results) {
    await sendMail(
      env,
      {
        to: r.email,
        subject: `Nuevo contacto desde «${form.name}»`,
        text: `Has recibido un contacto desde el formulario «${form.name}».\n\nÁbrelo en el CRM de DNI Growth:\n${url}\n\nPor privacidad, este correo no incluye los datos de la persona.`,
        html: emailHtml("Nuevo contacto", [`Has recibido un contacto desde el formulario «${form.name}».`, "Por privacidad, este correo no incluye los datos de la persona."], { label: "Abrir en el CRM", url }),
      },
      { kind: "notification", idempotencyKey: `lead-notify:${leadId}:${n}:${r.email}`, organizationId: form.organization_id },
    );
  }
}

async function handleSubmission(c: Context<AppEnv>, form: FormRow | null) {
  const origin = c.req.header("origin");
  const ctype = c.req.header("content-type") ?? "";
  const isJson = ctype.includes("application/json");
  if (!form) {
    if (isJson) throw new ApiError(404, "form_not_found", "Este formulario no existe o está desactivado.");
    return resultPage("Formulario no disponible", ["Este formulario no existe o está desactivado."], 404);
  }
  const allowed = allowedOrigins(c.env, form);
  const cors = corsHeaders(origin, allowed);
  // A browser always sends Origin on cross-site POSTs: refuse sites the owner did not list.
  if (origin && !allowed.has(origin)) {
    if (isJson) throw new ApiError(403, "origin_not_allowed", "Este sitio web no está autorizado para enviar este formulario.");
    return resultPage("Envío no autorizado", ["Este sitio web no está autorizado para enviar este formulario."], 403);
  }
  const ipHash = (await hashIp(c.env, c.req.header("cf-connecting-ip"))) ?? "noip";
  await rateLimit(c.env.DB, `lead:ip:${form.id}:${ipHash}`, 5, 600);
  await rateLimit(c.env.DB, `lead:ipday:${ipHash}`, 20, 86400);
  await rateLimit(c.env.DB, `lead:form:${form.id}`, 300, 86400);

  let raw: Record<string, unknown>;
  try {
    raw = isJson ? ((await c.req.json()) as Record<string, unknown>) : ((await c.req.parseBody()) as Record<string, unknown>);
  } catch {
    throw new ApiError(400, "invalid_body", "No se pudo leer el formulario.");
  }
  for (const k of Object.keys(raw)) if (typeof raw[k] !== "string" && typeof raw[k] !== "boolean" && typeof raw[k] !== "number") delete raw[k];
  const parsed = LeadSubmission.safeParse(raw);
  const back = origin ?? null;
  if (!parsed.success) {
    const msgs = [...new Set(parsed.error.issues.map((i) => i.message))].slice(0, 5);
    if (isJson) return c.json({ type: "about:blank", title: msgs.join(" "), status: 422, code: "validation_error", fields: parsed.error.issues.map((i) => i.path.join(".")) }, 422, cors);
    return resultPage("Revisa el formulario", msgs, 422, back);
  }
  const s = parsed.data;
  if (!s.consent) {
    const msg = "Para enviar el formulario debes aceptar el tratamiento de tus datos.";
    if (isJson) return c.json({ type: "about:blank", title: msg, status: 422, code: "consent_required", fields: ["consent"] }, 422, cors);
    return resultPage("Falta tu consentimiento", [msg], 422, back);
  }
  const done = () => (isJson ? c.json({ ok: true, message: form.success_message }, 200, cors) : form.redirect_url ? c.redirect(form.redirect_url, 303) : resultPage("Mensaje enviado", [form.success_message], 200, back));

  const spam = spamSignals(s);
  if (spam.length) {
    // Same answer as a real submission (bots learn nothing); only a counter is kept.
    await c.env.DB.prepare("UPDATE lead_forms SET spam_blocked = spam_blocked + 1 WHERE organization_id = ? AND id = ?").bind(form.organization_id, form.id).run();
    log("info", "lead.spam_blocked", { formId: form.id, reasons: spam });
    return done();
  }

  const now = nowIso();
  const marketing = s.marketing && !!form.marketing_text ? 1 : 0;
  const page = pageUrlWithoutQuery(s.page_url);
  const ref = referrerHost(s.referrer, page ? new URL(page).origin : undefined);
  const phone = form.ask_phone ? (s.phone ?? null) : null;
  const company = form.ask_company ? (s.company ?? null) : null;
  // Atomic upsert: the same person (email) in the same organisation is ONE lead. First-touch UTMs are
  // kept on the lead; every submission (with its own attribution) goes to the history.
  const row = await c.env.DB.prepare(
    `INSERT INTO leads (id, organization_id, form_id, brand_id, name, email, email_norm, phone, company, message, source, source_url, referrer_host,
       utm_source, utm_medium, utm_campaign, utm_term, utm_content, consent_contact, consent_marketing, consent_text, marketing_text, consent_at, submissions, created_at, updated_at, last_submitted_at, stage_changed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'form', ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, 1, ?, ?, ?, ?)
     ON CONFLICT(organization_id, email_norm) DO UPDATE SET
       name = excluded.name, phone = COALESCE(excluded.phone, leads.phone), company = COALESCE(excluded.company, leads.company),
       message = COALESCE(excluded.message, leads.message), consent_contact = 1, consent_marketing = MAX(leads.consent_marketing, excluded.consent_marketing),
       consent_text = excluded.consent_text, marketing_text = COALESCE(excluded.marketing_text, leads.marketing_text), consent_at = excluded.consent_at,
       submissions = leads.submissions + 1, updated_at = excluded.updated_at, last_submitted_at = excluded.last_submitted_at
     RETURNING id, submissions`,
  )
    .bind(
      uuid(), form.organization_id, form.id, form.brand_id, s.name, s.email, normalizeEmail(s.email), phone, company, s.message ?? null, page, ref,
      s.utm_source ?? null, s.utm_medium ?? null, s.utm_campaign ?? null, s.utm_term ?? null, s.utm_content ?? null,
      marketing, form.consent_text, marketing ? form.marketing_text : null, now, now, now, now, now,
    )
    .first<{ id: string; submissions: number }>();
  if (!row) throw new ApiError(500, "lead_not_saved", "No se pudo guardar el contacto.");
  const isNew = row.submissions === 1;
  await c.env.DB.batch([
    c.env.DB.prepare("INSERT INTO lead_events (id, organization_id, lead_id, kind, data_json, created_at) VALUES (?, ?, ?, 'submitted', ?, ?)").bind(
      uuid(), form.organization_id, row.id,
      JSON.stringify({ formId: form.id, formName: form.name, message: s.message ?? null, page, referrer: ref, utm: { source: s.utm_source, medium: s.utm_medium, campaign: s.utm_campaign, term: s.utm_term, content: s.utm_content }, consentMarketing: !!marketing, first: isNew }),
      now,
    ),
    c.env.DB.prepare("UPDATE lead_forms SET submissions = submissions + 1, updated_at = ? WHERE organization_id = ? AND id = ?").bind(now, form.organization_id, form.id),
    auditStmt(c.env.DB, { organizationId: form.organization_id, actorUserId: null, action: "lead.captured", entityType: "lead", entityId: row.id, after: { formId: form.id, isNew, consentMarketing: !!marketing }, ipHash, requestId: c.get("requestId") }),
  ]);
  const lp = await recordLandingConversion(c.env, form.organization_id, s._lp, s._v);
  if (lp)
    await c.env.DB.prepare("UPDATE leads SET landing_id = COALESCE(landing_id, ?), landing_variant = COALESCE(landing_variant, ?) WHERE organization_id = ? AND id = ?")
      .bind(lp.landingId, lp.variant, form.organization_id, row.id)
      .run();
  {
    const p = (async () => {
      if (form.notify) {
        try {
          await rateLimit(c.env.DB, `lead:notify:${form.organization_id}`, 50, 86400);
          await notifyTeam(c.env, form, row.id, row.submissions);
        } catch (e) {
          log("warn", "lead.notify_skipped", { formId: form.id, error: e instanceof ApiError ? e.code : "error" });
        }
      }
      const org = await c.env.DB.prepare("SELECT name FROM organizations WHERE id = ?").bind(form.organization_id).first<{ name: string }>();
      await runLeadAutomations(c.env, { orgId: form.organization_id, orgName: org?.name ?? "", formId: form.id, leadId: row.id, isNew, name: s.name, email: s.email });
    })();
    try {
      c.executionCtx.waitUntil(p);
    } catch {
      await p; // tests / environments without an execution context
    }
  }
  return done();
}

// ── Public endpoints (no session; CSRF-exempt path; CORS only for the form's allowed origins) ──────
export const crmPublic = new Hono<AppEnv>();

crmPublic.options("/forms/:formId/submit", async (c) => {
  const form = await loadPublicForm(c.env, c.req.param("formId"));
  const headers = form ? corsHeaders(c.req.header("origin"), allowedOrigins(c.env, form)) : {};
  return new Response(null, { status: 204, headers });
});
crmPublic.post("/forms/:formId/submit", async (c) => handleSubmission(c, await loadPublicForm(c.env, c.req.param("formId"))));
/** DNI Growth's own contact form (dnigrowth.com); the form lives in the DNI Growth organisation. */
crmPublic.post("/site-contact", async (c) => handleSubmission(c, await loadPublicForm(c.env, c.env.SITE_CONTACT_FORM_ID)));

// ── Tenant CRM ─────────────────────────────────────────────────────────────────────────────────────
export const crm = new Hono<AppEnv>();

const LEAD_COLS = `l.id, l.form_id, f.name AS form_name, l.name, l.email, l.phone, l.company, l.message, l.source, l.source_url, l.referrer_host,
  l.utm_source, l.utm_medium, l.utm_campaign, l.utm_term, l.utm_content, l.stage, l.lost_reason, l.value_cents, l.currency, l.assigned_user_id,
  u.name AS assigned_name, l.consent_contact, l.consent_marketing, l.consent_text, l.marketing_text, l.consent_at, l.submissions, l.is_test,
  l.created_at, l.updated_at, l.last_submitted_at, l.stage_changed_at,
  (SELECT COUNT(*) FROM crm_tasks t WHERE t.organization_id = l.organization_id AND t.lead_id = l.id AND t.status = 'open') AS open_tasks`;

type LeadRow = Record<string, unknown> & { id: string; stage: LeadStage; value_cents: number | null; consent_contact: number; consent_marketing: number; is_test: number };
const shapeLead = (r: LeadRow) => ({ ...r, consent_contact: !!r.consent_contact, consent_marketing: !!r.consent_marketing, is_test: !!r.is_test, value: r.value_cents === null ? null : r.value_cents / 100, stageLabel: LEAD_STAGE_LABEL[r.stage] });

async function loadLead(c: Context<AppEnv>, orgId: string) {
  const id = assertUuid(c.req.param("leadId"), "Contacto");
  const r = await c.env.DB.prepare(`SELECT ${LEAD_COLS} FROM leads l LEFT JOIN lead_forms f ON f.id = l.form_id AND f.organization_id = l.organization_id LEFT JOIN users u ON u.id = l.assigned_user_id WHERE l.organization_id = ? AND l.id = ?`)
    .bind(orgId, id)
    .first<LeadRow>();
  if (!r) throw notFound("Contacto");
  return r;
}

/** The assignee must be an active member whose role can see the CRM. */
async function assertAssignee(env: Env, orgId: string, userId: string | null | undefined) {
  if (!userId) return;
  const m = await env.DB.prepare("SELECT role FROM memberships WHERE organization_id = ? AND user_id = ? AND status = 'active'").bind(orgId, assertUuid(userId, "Usuario")).first<{ role: string }>();
  if (!m || !isRole(m.role) || !can(m.role, "crm:read")) throw new ApiError(422, "invalid_assignee", "Esa persona no tiene acceso al CRM de esta organización.");
}

const event = (db: D1Database, orgId: string, leadId: string, kind: string, actor: string, data: unknown) =>
  db.prepare("INSERT INTO lead_events (id, organization_id, lead_id, kind, actor_user_id, data_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)").bind(uuid(), orgId, leadId, kind, actor, JSON.stringify(data), nowIso());

crm.get("/crm/leads", requireScope("crm:read"), async (c) => {
  const t = c.get("tenant");
  const stage = c.req.query("stage");
  const q = (c.req.query("q") ?? "").trim().slice(0, 100);
  const mine = c.req.query("mine") === "1";
  const where = ["l.organization_id = ?"];
  const args: unknown[] = [t.orgId];
  if (stage && (LEAD_STAGES as readonly string[]).includes(stage)) {
    where.push("l.stage = ?");
    args.push(stage);
  }
  if (mine) {
    where.push("l.assigned_user_id = ?");
    args.push(c.get("user")!.id);
  }
  if (q) {
    where.push("(l.name LIKE ? ESCAPE '\\' OR l.email LIKE ? ESCAPE '\\' OR l.company LIKE ? ESCAPE '\\')");
    const like = `%${q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
    args.push(like, like, like);
  }
  const [list, counts] = await Promise.all([
    c.env.DB.prepare(`SELECT ${LEAD_COLS} FROM leads l LEFT JOIN lead_forms f ON f.id = l.form_id AND f.organization_id = l.organization_id LEFT JOIN users u ON u.id = l.assigned_user_id WHERE ${where.join(" AND ")} ORDER BY l.updated_at DESC LIMIT 500`)
      .bind(...args)
      .all<LeadRow>(),
    c.env.DB.prepare("SELECT stage, COUNT(*) AS n, COALESCE(SUM(value_cents), 0) AS value_cents FROM leads WHERE organization_id = ? AND is_test = 0 GROUP BY stage").bind(t.orgId).all<{ stage: LeadStage; n: number; value_cents: number }>(),
  ]);
  const byStage = LEAD_STAGES.map((s) => {
    const r = counts.results.find((x) => x.stage === s);
    return { stage: s, label: LEAD_STAGE_LABEL[s], count: r?.n ?? 0, value: (r?.value_cents ?? 0) / 100 };
  });
  const won = byStage.find((s) => s.stage === "won")!;
  const lost = byStage.find((s) => s.stage === "lost")!;
  const closed = won.count + lost.count;
  return c.json({
    items: list.results.map(shapeLead),
    stages: byStage,
    summary: {
      total: byStage.reduce((a, s) => a + s.count, 0),
      openPipelineValue: byStage.filter((s) => s.stage !== "won" && s.stage !== "lost").reduce((a, s) => a + s.value, 0),
      wonValue: won.value,
      winRate: closed ? Math.round((won.count / closed) * 1000) / 1000 : null,
      measurement: "observed",
      note: "Cifras de los contactos guardados en el CRM (sin contactos de prueba). El valor lo introduce tu equipo; no se estima.",
    },
    caveats: LEAD_CAVEATS,
  });
});

crm.get("/crm/leads/:leadId", requireScope("crm:read"), async (c) => {
  const t = c.get("tenant");
  const lead = await loadLead(c, t.orgId);
  const [events, tasks] = await Promise.all([
    c.env.DB.prepare("SELECT e.id, e.kind, e.data_json, e.created_at, u.name AS actor_name FROM lead_events e LEFT JOIN users u ON u.id = e.actor_user_id WHERE e.organization_id = ? AND e.lead_id = ? ORDER BY e.created_at DESC LIMIT 200")
      .bind(t.orgId, lead.id)
      .all<{ id: string; kind: string; data_json: string; created_at: string; actor_name: string | null }>(),
    c.env.DB.prepare("SELECT k.id, k.title, k.due_at, k.status, k.assigned_user_id, u.name AS assigned_name, k.created_at, k.done_at FROM crm_tasks k LEFT JOIN users u ON u.id = k.assigned_user_id WHERE k.organization_id = ? AND k.lead_id = ? ORDER BY k.status, COALESCE(k.due_at, k.created_at)")
      .bind(t.orgId, lead.id)
      .all(),
  ]);
  return c.json({ lead: shapeLead(lead), events: events.results.map((e) => ({ ...e, data: parseJson(e.data_json, {}), data_json: undefined })), tasks: tasks.results });
});

const optText = (max: number) => z.string().max(max).transform(cleanLine).optional().nullable();
const ManualLead = z.strictObject({
  name: z.string().transform(cleanLine).pipe(z.string().min(2).max(120)),
  email: z.string().transform(normalizeEmail).pipe(z.email("Email no válido.").max(254)),
  phone: optText(40),
  company: optText(160),
  message: z.string().max(3000).transform(cleanMultiline).optional().nullable(),
  valueEur: z.number().min(0).max(100_000_000).optional().nullable(),
  isTest: z.boolean().optional(),
});
crm.post("/crm/leads", requireScope("crm:write"), async (c) => {
  const t = c.get("tenant");
  const user = c.get("user")!;
  const b = await parseBody(c, ManualLead);
  const exists = await c.env.DB.prepare("SELECT id FROM leads WHERE organization_id = ? AND email_norm = ?").bind(t.orgId, b.email).first<{ id: string }>();
  if (exists) throw new ApiError(409, "lead_exists", "Ya existe un contacto con ese email.", { leadId: exists.id });
  const id = uuid();
  const now = nowIso();
  await c.env.DB.batch([
    c.env.DB.prepare(
      `INSERT INTO leads (id, organization_id, name, email, email_norm, phone, company, message, source, value_cents, assigned_user_id, is_test, submissions, created_at, updated_at, stage_changed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'manual', ?, ?, ?, 0, ?, ?, ?)`,
    ).bind(id, t.orgId, b.name, b.email, b.email, b.phone ?? null, b.company ?? null, b.message ?? null, b.valueEur === null || b.valueEur === undefined ? null : Math.round(b.valueEur * 100), user.id, b.isTest ? 1 : 0, now, now, now),
    event(c.env.DB, t.orgId, id, "created_manually", user.id, { isTest: !!b.isTest }),
    auditStmt(c.env.DB, { organizationId: t.orgId, actorUserId: user.id, action: "lead.create", entityType: "lead", entityId: id, after: { source: "manual", isTest: !!b.isTest }, requestId: c.get("requestId") }),
  ]);
  return c.json({ id }, 201);
});

const LeadPatch = z.strictObject({
  stage: z.enum(LEAD_STAGES).optional(),
  lostReason: z.string().max(300).transform(cleanLine).optional().nullable(),
  valueEur: z.number().min(0).max(100_000_000).optional().nullable(),
  assignedUserId: z.string().optional().nullable(),
  name: z.string().transform(cleanLine).pipe(z.string().min(2).max(120)).optional(),
  phone: optText(40),
  company: optText(160),
  isTest: z.boolean().optional(),
});
crm.patch("/crm/leads/:leadId", requireScope("crm:write"), async (c) => {
  const t = c.get("tenant");
  const user = c.get("user")!;
  const lead = await loadLead(c, t.orgId);
  const b = await parseBody(c, LeadPatch);
  if (b.assignedUserId !== undefined) await assertAssignee(c.env, t.orgId, b.assignedUserId);
  const sets: string[] = [];
  const args: unknown[] = [];
  const changes: Record<string, { from: unknown; to: unknown }> = {};
  const set = (col: string, key: string, from: unknown, to: unknown) => {
    if (to === undefined || from === to) return;
    sets.push(`${col} = ?`);
    args.push(to);
    changes[key] = { from, to };
  };
  set("stage", "stage", lead.stage, b.stage);
  if (b.stage && b.stage !== lead.stage) {
    sets.push("stage_changed_at = ?");
    args.push(nowIso());
  }
  set("lost_reason", "lostReason", lead.lost_reason, b.stage && b.stage !== "lost" ? null : b.lostReason);
  set("value_cents", "value", lead.value_cents, b.valueEur === undefined ? undefined : b.valueEur === null ? null : Math.round(b.valueEur * 100));
  set("assigned_user_id", "assignedUserId", lead.assigned_user_id, b.assignedUserId === undefined ? undefined : b.assignedUserId || null);
  set("name", "name", lead.name, b.name);
  set("phone", "phone", lead.phone, b.phone === undefined ? undefined : b.phone || null);
  set("company", "company", lead.company, b.company === undefined ? undefined : b.company || null);
  set("is_test", "isTest", lead.is_test, b.isTest === undefined ? undefined : b.isTest ? 1 : 0);
  if (!sets.length) return c.json({ lead: shapeLead(lead), changed: false });
  // Personal fields are recorded as "changed" only, never with their values, in the audit log.
  const auditAfter = Object.fromEntries(Object.entries(changes).map(([k, v]) => [k, ["name", "phone", "company"].includes(k) ? "changed" : v.to]));
  await c.env.DB.batch([
    c.env.DB.prepare(`UPDATE leads SET ${sets.join(", ")}, updated_at = ? WHERE organization_id = ? AND id = ?`).bind(...args, nowIso(), t.orgId, lead.id),
    ...Object.entries(changes).map(([k, v]) =>
      event(c.env.DB, t.orgId, lead.id, k === "stage" ? "stage_changed" : k === "assignedUserId" ? "assigned" : k === "value" ? "value_changed" : "updated", user.id, k === "stage" ? { from: v.from, to: v.to, lostReason: b.lostReason ?? null } : k === "value" ? { from: v.from === null ? null : Number(v.from) / 100, to: v.to === null ? null : Number(v.to) / 100 } : { field: k }),
    ),
    auditStmt(c.env.DB, { organizationId: t.orgId, actorUserId: user.id, action: "lead.update", entityType: "lead", entityId: lead.id, after: auditAfter, requestId: c.get("requestId") }),
  ]);
  return c.json({ lead: shapeLead(await loadLead(c, t.orgId)), changed: true });
});

crm.post("/crm/leads/:leadId/notes", requireScope("crm:write"), async (c) => {
  const t = c.get("tenant");
  const lead = await loadLead(c, t.orgId);
  const { text } = await parseBody(c, z.strictObject({ text: z.string().transform(cleanMultiline).pipe(z.string().min(1).max(2000)) }));
  await c.env.DB.batch([
    event(c.env.DB, t.orgId, lead.id, "note", c.get("user")!.id, { text }),
    c.env.DB.prepare("UPDATE leads SET updated_at = ? WHERE organization_id = ? AND id = ?").bind(nowIso(), t.orgId, lead.id),
  ]);
  return c.json({ ok: true }, 201);
});

const TaskInput = z.strictObject({
  title: z.string().transform(cleanLine).pipe(z.string().min(2).max(200)),
  dueAt: z.iso.datetime({ offset: true }).optional().nullable(),
  assignedUserId: z.string().optional().nullable(),
});
crm.post("/crm/leads/:leadId/tasks", requireScope("crm:write"), async (c) => {
  const t = c.get("tenant");
  const user = c.get("user")!;
  const lead = await loadLead(c, t.orgId);
  const b = await parseBody(c, TaskInput);
  await assertAssignee(c.env, t.orgId, b.assignedUserId);
  const open = await c.env.DB.prepare("SELECT COUNT(*) AS n FROM crm_tasks WHERE organization_id = ? AND lead_id = ? AND status = 'open'").bind(t.orgId, lead.id).first<{ n: number }>();
  if ((open?.n ?? 0) >= 50) throw new ApiError(422, "too_many_tasks", "Este contacto ya tiene 50 tareas abiertas.");
  const id = uuid();
  const due = b.dueAt ? new Date(b.dueAt).toISOString() : null;
  await c.env.DB.batch([
    c.env.DB.prepare("INSERT INTO crm_tasks (id, organization_id, lead_id, title, due_at, assigned_user_id, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").bind(id, t.orgId, lead.id, b.title, due, b.assignedUserId || user.id, user.id, nowIso()),
    event(c.env.DB, t.orgId, lead.id, "task_created", user.id, { taskId: id, title: b.title, dueAt: due }),
  ]);
  return c.json({ id }, 201);
});

crm.patch("/crm/tasks/:taskId", requireScope("crm:write"), async (c) => {
  const t = c.get("tenant");
  const user = c.get("user")!;
  const id = assertUuid(c.req.param("taskId"), "Tarea");
  const { status } = await parseBody(c, z.strictObject({ status: z.enum(["open", "done"]) }));
  const task = await c.env.DB.prepare("SELECT id, lead_id, title, status FROM crm_tasks WHERE organization_id = ? AND id = ?").bind(t.orgId, id).first<{ id: string; lead_id: string; title: string; status: string }>();
  if (!task) throw notFound("Tarea");
  if (task.status === status) return c.json({ ok: true, changed: false });
  await c.env.DB.batch([
    c.env.DB.prepare("UPDATE crm_tasks SET status = ?, done_at = ? WHERE organization_id = ? AND id = ?").bind(status, status === "done" ? nowIso() : null, t.orgId, id),
    event(c.env.DB, t.orgId, task.lead_id, status === "done" ? "task_done" : "task_reopened", user.id, { taskId: id, title: task.title }),
  ]);
  return c.json({ ok: true, changed: true });
});

crm.get("/crm/tasks", requireScope("crm:read"), async (c) => {
  const t = c.get("tenant");
  const mine = c.req.query("mine") === "1";
  const { results } = await c.env.DB.prepare(
    `SELECT k.id, k.title, k.due_at, k.status, k.lead_id, l.name AS lead_name, u.name AS assigned_name FROM crm_tasks k
     JOIN leads l ON l.id = k.lead_id AND l.organization_id = k.organization_id LEFT JOIN users u ON u.id = k.assigned_user_id
     WHERE k.organization_id = ? AND k.status = 'open' ${mine ? "AND k.assigned_user_id = ?" : ""} ORDER BY COALESCE(k.due_at, '9999') LIMIT 200`,
  )
    .bind(...(mine ? [t.orgId, c.get("user")!.id] : [t.orgId]))
    .all();
  return c.json({ items: results });
});

/** Right to erasure: removes the lead, its history and tasks. Only owner/admin. Audited without personal data. */
crm.delete("/crm/leads/:leadId", requireScope("crm:delete"), async (c) => {
  const t = c.get("tenant");
  const lead = await loadLead(c, t.orgId);
  await c.env.DB.batch([
    c.env.DB.prepare("DELETE FROM crm_tasks WHERE organization_id = ? AND lead_id = ?").bind(t.orgId, lead.id),
    c.env.DB.prepare("DELETE FROM lead_events WHERE organization_id = ? AND lead_id = ?").bind(t.orgId, lead.id),
    c.env.DB.prepare("DELETE FROM leads WHERE organization_id = ? AND id = ?").bind(t.orgId, lead.id),
    // Erasure also cancels automatic replies still waiting (quiet hours) and drops their encrypted copy.
    c.env.DB.prepare("UPDATE email_outbox SET status = 'dead', payload_enc = NULL, last_error_code = 'lead_erased', updated_at = ? WHERE organization_id = ? AND idempotency_key LIKE ? AND status IN ('queued','failed')").bind(nowIso(), t.orgId, `auto-reply:%:${lead.id}`),
    auditStmt(c.env.DB, { organizationId: t.orgId, actorUserId: c.get("user")!.id, action: "lead.erase", entityType: "lead", entityId: lead.id, after: { stage: lead.stage, isTest: !!lead.is_test }, requestId: c.get("requestId") }),
  ]);
  return c.json({ ok: true });
});

crm.get("/crm/export", requireScope("crm:write"), async (c) => {
  const t = c.get("tenant");
  const user = c.get("user")!;
  await rateLimit(c.env.DB, `crm-export:${t.orgId}`, 10, 3600);
  const { results } = await c.env.DB.prepare(`SELECT ${LEAD_COLS} FROM leads l LEFT JOIN lead_forms f ON f.id = l.form_id AND f.organization_id = l.organization_id LEFT JOIN users u ON u.id = l.assigned_user_id WHERE l.organization_id = ? ORDER BY l.created_at`)
    .bind(t.orgId)
    .all<LeadRow>();
  await auditStmt(c.env.DB, { organizationId: t.orgId, actorUserId: user.id, action: "crm.export", entityType: "leads", entityId: null, after: { rows: results.length, format: "csv" }, requestId: c.get("requestId") }).run();
  const header = ["nombre", "email", "telefono", "empresa", "etapa", "valor_eur", "responsable", "formulario", "pagina", "web_de_origen", "utm_source", "utm_medium", "utm_campaign", "consentimiento_contacto", "consentimiento_comercial", "fecha_consentimiento", "envios", "prueba", "creado", "actualizado"];
  const rows = results.map((r) => [r.name, r.email, r.phone, r.company, LEAD_STAGE_LABEL[r.stage], r.value_cents === null ? "" : r.value_cents / 100, r.assigned_name, r.form_name, r.source_url, r.referrer_host, r.utm_source, r.utm_medium, r.utm_campaign, r.consent_contact ? "sí" : "no", r.consent_marketing ? "sí" : "no", r.consent_at, r.submissions, r.is_test ? "sí" : "no", r.created_at, r.updated_at]);
  return new Response(toCsv(header, rows), { headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="contactos-${nowIso().slice(0, 10)}.csv"`, "cache-control": "no-store" } });
});

// ── Forms ─────────────────────────────────────────────────────────────────────────────────────────
async function formUsage(db: D1Database, orgId: string) {
  const plan = await orgPlan(db, orgId);
  const limit = plan.limits.leadForms ?? LEAD_FORM_LIMITS[plan.code] ?? 1;
  const r = await db.prepare("SELECT COUNT(*) AS n FROM lead_forms WHERE organization_id = ? AND status != 'archived'").bind(orgId).first<{ n: number }>();
  return { used: r?.n ?? 0, limit, plan: plan.code };
}

const httpsUrl = z
  .string()
  .max(500)
  .refine((v) => {
    try {
      return new URL(v).protocol === "https:";
    } catch {
      return false;
    }
  }, "Debe ser una URL https://");
const FormInput = z.strictObject({
  name: z.string().transform(cleanLine).pipe(z.string().min(2).max(120)),
  brandId: z.string().optional().nullable(),
  consentText: z.string().transform(cleanLine).pipe(z.string().min(20).max(500)).optional(),
  marketingText: z.string().transform(cleanLine).pipe(z.string().max(300)).optional().nullable(),
  privacyUrl: httpsUrl.optional().nullable(),
  successMessage: z.string().transform(cleanLine).pipe(z.string().min(5).max(300)).optional(),
  redirectUrl: httpsUrl.optional().nullable(),
  allowedOrigins: AllowedOrigins.optional(),
  askPhone: z.boolean().optional(),
  askCompany: z.boolean().optional(),
  notify: z.boolean().optional(),
  status: z.enum(["active", "paused", "archived"]).optional(),
});

const FORM_COLS = "id, brand_id, name, consent_text, marketing_text, privacy_url, success_message, redirect_url, allowed_origins_json, ask_phone, ask_company, notify, status, submissions, spam_blocked, created_at, updated_at";
const shapeForm = (r: Record<string, unknown>) => ({ ...r, allowedOrigins: parseJson<string[]>(r.allowed_origins_json as string, []), allowed_origins_json: undefined, ask_phone: !!r.ask_phone, ask_company: !!r.ask_company, notify: !!r.notify });

crm.get("/crm/forms", requireScope("crm:read"), async (c) => {
  const t = c.get("tenant");
  const { results } = await c.env.DB.prepare(`SELECT ${FORM_COLS} FROM lead_forms WHERE organization_id = ? AND status != 'archived' ORDER BY created_at`).bind(t.orgId).all();
  return c.json({ items: results.map(shapeForm), usage: await formUsage(c.env.DB, t.orgId), submitBase: `${new URL(c.env.APP_ORIGIN).origin}/api/v1/public/forms` });
});

crm.post("/crm/forms", requireScope("forms:manage"), async (c) => {
  const t = c.get("tenant");
  const user = c.get("user")!;
  const b = await parseBody(c, FormInput);
  if (b.brandId) {
    const ok = await c.env.DB.prepare("SELECT id FROM brands WHERE organization_id = ? AND id = ?").bind(t.orgId, assertUuid(b.brandId, "Marca")).first();
    if (!ok) throw notFound("Marca");
  }
  const u = await formUsage(c.env.DB, t.orgId);
  if (u.used >= u.limit) throw new ApiError(402, "plan_limit", `Tu plan permite ${u.limit} formulario${u.limit === 1 ? "" : "s"}. Archiva uno o mejora el plan.`);
  const id = uuid();
  const now = nowIso();
  await c.env.DB.batch([
    c.env.DB.prepare(
      `INSERT INTO lead_forms (id, organization_id, brand_id, name, consent_text, marketing_text, privacy_url, success_message, redirect_url, allowed_origins_json, ask_phone, ask_company, notify, status, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)`,
    ).bind(
      id, t.orgId, b.brandId || null, b.name, b.consentText ?? DEFAULT_CONSENT_TEXT, b.marketingText === undefined ? DEFAULT_MARKETING_TEXT : b.marketingText || null, b.privacyUrl ?? null,
      b.successMessage ?? DEFAULT_SUCCESS_MESSAGE, b.redirectUrl ?? null, JSON.stringify(b.allowedOrigins ?? []), b.askPhone === false ? 0 : 1, b.askCompany === false ? 0 : 1, b.notify === false ? 0 : 1, user.id, now, now,
    ),
    auditStmt(c.env.DB, { organizationId: t.orgId, actorUserId: user.id, action: "lead_form.create", entityType: "lead_form", entityId: id, after: { name: b.name, allowedOrigins: b.allowedOrigins ?? [] }, requestId: c.get("requestId") }),
  ]);
  const row = await c.env.DB.prepare(`SELECT ${FORM_COLS} FROM lead_forms WHERE organization_id = ? AND id = ?`).bind(t.orgId, id).first();
  return c.json(shapeForm(row!), 201);
});

crm.patch("/crm/forms/:formId", requireScope("forms:manage"), async (c) => {
  const t = c.get("tenant");
  const id = assertUuid(c.req.param("formId"), "Formulario");
  const cur = await c.env.DB.prepare(`SELECT ${FORM_COLS} FROM lead_forms WHERE organization_id = ? AND id = ?`).bind(t.orgId, id).first<Record<string, unknown>>();
  if (!cur) throw notFound("Formulario");
  const b = await parseBody(c, FormInput.partial());
  if (b.status && b.status !== "archived" && cur.status === "archived") {
    const u = await formUsage(c.env.DB, t.orgId);
    if (u.used >= u.limit) throw new ApiError(402, "plan_limit", `Tu plan permite ${u.limit} formulario${u.limit === 1 ? "" : "s"}.`);
  }
  const map: Array<[string, unknown]> = [
    ["name", b.name],
    ["consent_text", b.consentText],
    ["marketing_text", b.marketingText === undefined ? undefined : b.marketingText || null],
    ["privacy_url", b.privacyUrl],
    ["success_message", b.successMessage],
    ["redirect_url", b.redirectUrl],
    ["allowed_origins_json", b.allowedOrigins === undefined ? undefined : JSON.stringify(b.allowedOrigins)],
    ["ask_phone", b.askPhone === undefined ? undefined : b.askPhone ? 1 : 0],
    ["ask_company", b.askCompany === undefined ? undefined : b.askCompany ? 1 : 0],
    ["notify", b.notify === undefined ? undefined : b.notify ? 1 : 0],
    ["status", b.status],
  ];
  const sets = map.filter(([, v]) => v !== undefined);
  if (sets.length) {
    const setClause = sets.map(([k]) => k + " = ?").join(", ");
    await c.env.DB.batch([
      c.env.DB.prepare(`UPDATE lead_forms SET ${setClause}, updated_at = ? WHERE organization_id = ? AND id = ?`).bind(...sets.map(([, v]) => v ?? null), nowIso(), t.orgId, id),
      auditStmt(c.env.DB, { organizationId: t.orgId, actorUserId: c.get("user")!.id, action: "lead_form.update", entityType: "lead_form", entityId: id, after: Object.fromEntries(sets.map(([k, v]) => [k, v])), requestId: c.get("requestId") }),
    ]);
  }
  const row = await c.env.DB.prepare(`SELECT ${FORM_COLS} FROM lead_forms WHERE organization_id = ? AND id = ?`).bind(t.orgId, id).first();
  return c.json(shapeForm(row!));
});

// ── Follow-up automations (per form; off by default; changes audited) ──────────────────────────────
async function loadFormId(c: Context<AppEnv>, orgId: string) {
  const id = assertUuid(c.req.param("formId"), "Formulario");
  const f = await c.env.DB.prepare("SELECT id FROM lead_forms WHERE organization_id = ? AND id = ?").bind(orgId, id).first<{ id: string }>();
  if (!f) throw notFound("Formulario");
  return f.id;
}

crm.get("/crm/forms/:formId/automations", requireScope("crm:read"), async (c) => {
  const t = c.get("tenant");
  const formId = await loadFormId(c, t.orgId);
  const [rules, runs] = await Promise.all([
    c.env.DB.prepare("SELECT id, kind, enabled, config_json, updated_at FROM crm_automations WHERE organization_id = ? AND form_id = ?").bind(t.orgId, formId).all<{ id: string; kind: string; enabled: number; config_json: string; updated_at: string }>(),
    c.env.DB.prepare(
      `SELECT r.status, r.detail, r.created_at, a.kind FROM crm_automation_runs r JOIN crm_automations a ON a.id = r.automation_id AND a.organization_id = r.organization_id
       WHERE r.organization_id = ? AND a.form_id = ? ORDER BY r.created_at DESC LIMIT 30`,
    )
      .bind(t.orgId, formId)
      .all(),
  ]);
  return c.json({ items: rules.results.map((r) => ({ ...r, enabled: !!r.enabled, config: parseJson(r.config_json, {}), config_json: undefined })), runs: runs.results });
});

const AutomationInput = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("auto_reply"), enabled: z.boolean(), config: AutoReplyConfig }),
  z.strictObject({ kind: z.literal("follow_up_task"), enabled: z.boolean(), config: FollowUpConfig }),
]);
crm.put("/crm/forms/:formId/automations", requireScope("forms:manage"), async (c) => {
  const t = c.get("tenant");
  const user = c.get("user")!;
  const formId = await loadFormId(c, t.orgId);
  const b = await parseBody(c, AutomationInput);
  if (b.kind === "follow_up_task" && b.config.assignTo) await assertAssignee(c.env, t.orgId, b.config.assignTo);
  const now = nowIso();
  await c.env.DB.batch([
    c.env.DB.prepare(
      `INSERT INTO crm_automations (id, organization_id, form_id, kind, enabled, config_json, updated_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(organization_id, form_id, kind) DO UPDATE SET enabled = excluded.enabled, config_json = excluded.config_json, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
    ).bind(uuid(), t.orgId, formId, b.kind, b.enabled ? 1 : 0, JSON.stringify(b.config), user.id, now, now),
    auditStmt(c.env.DB, { organizationId: t.orgId, actorUserId: user.id, action: b.enabled ? "crm.automation_enable" : "crm.automation_disable", entityType: "lead_form", entityId: formId, after: { kind: b.kind }, requestId: c.get("requestId") }),
  ]);
  return c.json({ ok: true });
});
