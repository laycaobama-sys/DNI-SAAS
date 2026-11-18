/**
 * F5 — Lead capture (public form: consent, anti-spam, dedup, UTM, allowed origins, rate limits) and
 * CRM (pipeline, history, tasks, roles, tenant isolation, export, erasure).
 */
import { describe, expect, it } from "vitest";
import { createHarness } from "./helpers";

async function setup() {
  const h = createHarness();
  const owner = await h.signup("owner@luna.es", "Olga");
  const orgId = await h.createOrg(owner, "Panadería Luna");
  await h.db.prepare("UPDATE organizations SET plan_code = 'growth' WHERE id = ?").bind(orgId).run();
  const form = await owner.post(`/api/v1/orgs/${orgId}/crm/forms`, { name: "Contacto web", allowedOrigins: ["https://panaderialuna.es"], privacyUrl: "https://panaderialuna.es/privacidad" });
  expect(form.status).toBe(201);
  const formId = form.json.id as string;
  let ip = 10;
  /** Public submission as a browser on another site would send it (no session, no CSRF header). */
  const submit = async (body: Record<string, unknown>, o: { origin?: string | null; form?: boolean; ip?: string; path?: string } = {}) => {
    const headers: Record<string, string> = { "cf-connecting-ip": o.ip ?? `198.51.100.${ip++}` };
    if (o.origin !== null) headers.origin = o.origin ?? "https://panaderialuna.es";
    let payload: string;
    if (o.form) {
      headers["content-type"] = "application/x-www-form-urlencoded";
      payload = new URLSearchParams(Object.entries(body).map(([k, v]) => [k, String(v)])).toString();
    } else {
      headers["content-type"] = "application/json";
      payload = JSON.stringify(body);
    }
    const res = await h.app.request(o.path ?? `/api/v1/public/forms/${formId}/submit`, { method: "POST", headers, body: payload }, h.env, h.ctx);
    const text = await res.text();
    let json: any;
    try {
      json = JSON.parse(text);
    } catch {
      json = text;
    }
    return { status: res.status, json, headers: res.headers };
  };
  const valid = { name: "Ana Pérez", email: "Ana@Example.com ", phone: "+34 600 000 000", message: "Quiero un presupuesto para 200 cruasanes.", consent: true, _t: Date.now() - 10_000, page_url: "https://panaderialuna.es/encargos?utm_source=ig&email=ana@example.com", referrer: "https://www.instagram.com/p/xyz?igshid=1", utm_source: "instagram", utm_medium: "social", utm_campaign: "navidad" };
  return { h, owner, orgId, formId, submit, valid };
}

describe("Public lead form", () => {
  it("stores a real lead with consent snapshot, UTM, page without query and referrer host only; CORS for the allowed origin", async () => {
    const { h, owner, orgId, submit, valid } = await setup();
    const r = await submit(valid);
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ ok: true });
    expect(r.headers.get("access-control-allow-origin")).toBe("https://panaderialuna.es");
    const list = await owner.get(`/api/v1/orgs/${orgId}/crm/leads`);
    expect(list.json.items).toHaveLength(1);
    const lead = list.json.items[0];
    expect(lead).toMatchObject({ name: "Ana Pérez", email: "ana@example.com", stage: "new", stageLabel: "Nuevo", consent_contact: true, consent_marketing: false, utm_source: "instagram", utm_campaign: "navidad", source_url: "https://panaderialuna.es/encargos", referrer_host: "www.instagram.com", form_name: "Contacto web" });
    expect(lead.consent_text).toMatch(/Acepto que se traten mis datos/);
    expect(list.json.stages.find((s: { stage: string }) => s.stage === "new").count).toBe(1);
    // No personal data in the audit log.
    const audit = await h.db.prepare("SELECT after_redacted FROM audit_logs WHERE organization_id = ? AND action = 'lead.captured'").bind(orgId).first<{ after_redacted: string }>();
    expect(audit!.after_redacted).not.toMatch(/ana|example|600/i);
  });

  it("requires consent and validates fields (Spanish messages)", async () => {
    const { submit, valid } = await setup();
    const noConsent = await submit({ ...valid, consent: false });
    expect(noConsent.status).toBe(422);
    expect(noConsent.json.code).toBe("consent_required");
    const bad = await submit({ ...valid, email: "no-es-email", name: "A" });
    expect(bad.status).toBe(422);
    expect(bad.json.title).toMatch(/email válido/);
    expect(bad.json.fields).toEqual(expect.arrayContaining(["email", "name"]));
  });

  it("deduplicates by email: one lead, history of every submission, first-touch UTM kept", async () => {
    const { owner, orgId, submit, valid } = await setup();
    await submit(valid);
    await submit({ ...valid, email: "ana@example.com", message: "Segundo mensaje", utm_source: "google", marketing: "on" });
    const list = (await owner.get(`/api/v1/orgs/${orgId}/crm/leads`)).json;
    expect(list.items).toHaveLength(1);
    expect(list.items[0]).toMatchObject({ submissions: 2, utm_source: "instagram", message: "Segundo mensaje", consent_marketing: true });
    const detail = (await owner.get(`/api/v1/orgs/${orgId}/crm/leads/${list.items[0].id}`)).json;
    const subs = detail.events.filter((e: { kind: string }) => e.kind === "submitted");
    expect(subs).toHaveLength(2);
    expect(subs[0].data.utm.source).toBe("google");
  });

  it("anti-spam: honeypot, too fast and link floods are dropped silently and only counted", async () => {
    const { owner, orgId, submit, valid } = await setup();
    expect((await submit({ ...valid, website: "http://spam.example" })).json).toMatchObject({ ok: true });
    expect((await submit({ ...valid, email: "b@x.es", _t: Date.now() })).json).toMatchObject({ ok: true });
    expect((await submit({ ...valid, email: "c@x.es", message: "http://a.ru http://b.ru http://c.ru" })).json).toMatchObject({ ok: true });
    expect((await owner.get(`/api/v1/orgs/${orgId}/crm/leads`)).json.items).toHaveLength(0);
    expect((await owner.get(`/api/v1/orgs/${orgId}/crm/forms`)).json.items[0]).toMatchObject({ spam_blocked: 3, submissions: 0 });
  });

  it("refuses sites that are not allowed, paused forms and unknown ids; rate-limits per IP", async () => {
    const { owner, orgId, formId, submit, valid } = await setup();
    const evil = await submit(valid, { origin: "https://evil.example" });
    expect(evil.status).toBe(403);
    expect(evil.headers.get("access-control-allow-origin")).toBeNull();
    expect((await submit(valid, { path: "/api/v1/public/forms/00000000-0000-4000-8000-000000000000/submit" })).status).toBe(404);
    for (let i = 0; i < 5; i++) expect((await submit({ ...valid, email: `p${i}@x.es` }, { ip: "203.0.113.50" })).status).toBe(200);
    expect((await submit({ ...valid, email: "p6@x.es" }, { ip: "203.0.113.50" })).status).toBe(429);
    await owner.patch(`/api/v1/orgs/${orgId}/crm/forms/${formId}`, { status: "paused" });
    expect((await submit({ ...valid, email: "z@x.es" })).status).toBe(404);
  });

  it("works without JavaScript (HTML form post): thank-you page or redirect, never reflecting input as HTML", async () => {
    const { owner, orgId, formId, submit, valid } = await setup();
    const page = await submit({ ...valid, name: "<script>alert(1)</script>", consent: "on" }, { form: true });
    expect(page.status).toBe(200);
    expect(page.headers.get("content-type")).toMatch(/text\/html/);
    expect(page.json).toContain("Gracias");
    expect(page.json).not.toContain("<script>alert");
    const bad = await submit({ ...valid, email: "x", consent: "on" }, { form: true });
    expect(bad.status).toBe(422);
    await owner.patch(`/api/v1/orgs/${orgId}/crm/forms/${formId}`, { redirectUrl: "https://panaderialuna.es/gracias" });
    const redir = await submit({ ...valid, email: "otra@x.es", consent: "on" }, { form: true });
    expect(redir.status).toBe(303);
    expect(redir.headers.get("location")).toBe("https://panaderialuna.es/gracias");
  });

  it("notifies the team by email without the person's data", async () => {
    const { h, submit, valid } = await setup();
    await submit(valid);
    await h.drain();
    const mail = await h.db.prepare("SELECT subject, body FROM dev_mailbox WHERE to_email = 'owner@luna.es' AND subject LIKE 'Nuevo contacto%'").first<{ subject: string; body: string }>();
    expect(mail!.subject).toBe("Nuevo contacto desde «Contacto web»");
    expect(mail!.body).toContain("/crm?lead=");
    expect(mail!.body).not.toMatch(/Ana|example\.com|600 000/);
  });

  it("the site contact form of dnigrowth.com uses SITE_CONTACT_FORM_ID", async () => {
    const { h, formId, submit, valid } = await setup();
    expect((await submit(valid, { path: "/api/v1/public/site-contact", origin: "http://localhost:8787" })).status).toBe(404);
    h.env.SITE_CONTACT_FORM_ID = formId;
    expect((await submit(valid, { path: "/api/v1/public/site-contact", origin: "http://localhost:8787" })).json).toMatchObject({ ok: true });
  });
});

describe("CRM pipeline", () => {
  it("stage, value, assignee, notes and tasks are recorded in the history; summary uses real values only", async () => {
    const { h, owner, orgId, submit, valid } = await setup();
    await submit(valid);
    const id = (await owner.get(`/api/v1/orgs/${orgId}/crm/leads`)).json.items[0].id as string;
    const me = (await owner.get("/api/v1/auth/me")).json.user.id as string;
    expect((await owner.patch(`/api/v1/orgs/${orgId}/crm/leads/${id}`, { stage: "proposal", valueEur: 1250.5, assignedUserId: me })).json).toMatchObject({ changed: true, lead: { stage: "proposal", value: 1250.5, assigned_user_id: me } });
    expect((await owner.post(`/api/v1/orgs/${orgId}/crm/leads/${id}/notes`, { text: "Llamada hecha." })).status).toBe(201);
    const task = await owner.post(`/api/v1/orgs/${orgId}/crm/leads/${id}/tasks`, { title: "Enviar presupuesto", dueAt: "2026-11-20T09:00:00.000Z" });
    expect(task.status).toBe(201);
    expect((await owner.get(`/api/v1/orgs/${orgId}/crm/tasks?mine=1`)).json.items).toHaveLength(1);
    await owner.patch(`/api/v1/orgs/${orgId}/crm/tasks/${task.json.id}`, { status: "done" });
    await owner.patch(`/api/v1/orgs/${orgId}/crm/leads/${id}`, { stage: "won" });
    const d = (await owner.get(`/api/v1/orgs/${orgId}/crm/leads/${id}`)).json;
    expect(d.events.map((e: { kind: string }) => e.kind)).toEqual(expect.arrayContaining(["submitted", "stage_changed", "value_changed", "assigned", "note", "task_created", "task_done"]));
    expect(d.tasks[0]).toMatchObject({ status: "done" });
    const s = (await owner.get(`/api/v1/orgs/${orgId}/crm/leads`)).json.summary;
    expect(s).toMatchObject({ total: 1, wonValue: 1250.5, openPipelineValue: 0, winRate: 1, measurement: "observed" });
    // Test contacts are excluded from the summary.
    await owner.post(`/api/v1/orgs/${orgId}/crm/leads`, { name: "Prueba", email: "prueba@test.es", valueEur: 999, isTest: true });
    expect((await owner.get(`/api/v1/orgs/${orgId}/crm/leads`)).json.summary.total).toBe(1);
    const audit = await h.db.prepare("SELECT after_redacted FROM audit_logs WHERE organization_id = ? AND action = 'lead.update'").bind(orgId).all<{ after_redacted: string }>();
    expect(JSON.stringify(audit.results)).not.toMatch(/Ana|example/);
  });

  it("roles: analyst/editor/viewer cannot see contacts; marketing manager works but cannot erase; assignee must have CRM access", async () => {
    const { h, owner, orgId, submit, valid } = await setup();
    await submit(valid);
    const id = (await owner.get(`/api/v1/orgs/${orgId}/crm/leads`)).json.items[0].id as string;
    const editor = await h.invite(owner, orgId, "editor@luna.es", "editor");
    expect((await editor.get(`/api/v1/orgs/${orgId}/crm/leads`)).status).toBe(403);
    const editorId = (await editor.get("/api/v1/auth/me")).json.user.id as string;
    expect((await owner.patch(`/api/v1/orgs/${orgId}/crm/leads/${id}`, { assignedUserId: editorId })).status).toBe(422);
    const mm = await h.invite(owner, orgId, "mm@luna.es", "marketing_manager");
    expect((await mm.get(`/api/v1/orgs/${orgId}/crm/leads/${id}`)).status).toBe(200);
    expect((await mm.patch(`/api/v1/orgs/${orgId}/crm/leads/${id}`, { stage: "contacted" })).status).toBe(200);
    expect((await mm.del(`/api/v1/orgs/${orgId}/crm/leads/${id}`)).status).toBe(403);
  });

  it("tenant isolation: another organisation cannot read, change, export or erase my contacts or forms", async () => {
    const { h, owner, orgId, formId, submit, valid } = await setup();
    await submit(valid);
    const id = (await owner.get(`/api/v1/orgs/${orgId}/crm/leads`)).json.items[0].id as string;
    const mallory = await h.signup("mallory@evil.es");
    const orgB = await h.createOrg(mallory, "Evil");
    expect((await mallory.get(`/api/v1/orgs/${orgId}/crm/leads`)).status).toBe(404);
    expect((await mallory.get(`/api/v1/orgs/${orgB}/crm/leads/${id}`)).status).toBe(404);
    expect((await mallory.patch(`/api/v1/orgs/${orgB}/crm/leads/${id}`, { stage: "lost" })).status).toBe(404);
    expect((await mallory.del(`/api/v1/orgs/${orgB}/crm/leads/${id}`)).status).toBe(404);
    expect((await mallory.patch(`/api/v1/orgs/${orgB}/crm/forms/${formId}`, { status: "paused" })).status).toBe(404);
    expect((await mallory.get(`/api/v1/orgs/${orgB}/crm/export`)).json).not.toContain("ana@example.com");
  });

  it("export (CSV, audited, formula-safe) and erasure (lead, history and tasks gone; audit keeps only ids)", async () => {
    const { h, owner, orgId, submit, valid } = await setup();
    await submit({ ...valid, name: "=SUMA(1;1) Ana" });
    const csv = await owner.get(`/api/v1/orgs/${orgId}/crm/export`);
    expect(csv.status).toBe(200);
    expect(csv.headers.get("content-disposition")).toMatch(/contactos-\d{4}-\d{2}-\d{2}\.csv/);
    expect(csv.json).toContain("ana@example.com");
    expect(csv.json).not.toMatch(/(^|,)=SUMA/m);
    const id = (await owner.get(`/api/v1/orgs/${orgId}/crm/leads`)).json.items[0].id as string;
    await owner.post(`/api/v1/orgs/${orgId}/crm/leads/${id}/tasks`, { title: "Llamar" });
    expect((await owner.del(`/api/v1/orgs/${orgId}/crm/leads/${id}`)).status).toBe(200);
    for (const t of ["leads", "lead_events", "crm_tasks"]) expect((await h.db.prepare(`SELECT COUNT(*) AS n FROM ${t} WHERE organization_id = ?`).bind(orgId).first<{ n: number }>())!.n).toBe(0);
    const audit = await h.db.prepare("SELECT action FROM audit_logs WHERE organization_id = ? AND action IN ('crm.export','lead.erase')").bind(orgId).all();
    expect(audit.results).toHaveLength(2);
  });

  it("form limit per plan and origin validation", async () => {
    const { h, owner, orgId } = await setup();
    await h.db.prepare("UPDATE organizations SET plan_code = 'free' WHERE id = ?").bind(orgId).run();
    expect((await owner.post(`/api/v1/orgs/${orgId}/crm/forms`, { name: "Otro" })).status).toBe(402);
    await h.db.prepare("UPDATE organizations SET plan_code = 'growth' WHERE id = ?").bind(orgId).run();
    const bad = await owner.post(`/api/v1/orgs/${orgId}/crm/forms`, { name: "Otro", allowedOrigins: ["http://insecure.es"] });
    expect(bad.status).toBe(422);
    const ok = await owner.post(`/api/v1/orgs/${orgId}/crm/forms`, { name: "Otro", allowedOrigins: ["https://a.es/ruta", "https://a.es"] });
    expect(ok.json.allowedOrigins).toEqual(["https://a.es"]);
  });
});
