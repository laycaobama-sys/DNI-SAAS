/**
 * F5 landing pages (blocks, versions, preview, publish, public page) · F7 A/B on landings ·
 * F5 follow-up automations (auto-reply with quiet hours and cap, follow-up task).
 */
import { describe, expect, it } from "vitest";
import { inQuietHours, nextSendTime, renderTemplate } from "../src/lib/automations";
import { renderLanding } from "../src/lib/landing-render";
import { createHarness } from "./helpers";

const UA = "Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 Chrome/130 Safari/537.36";

async function setup() {
  const h = createHarness();
  const owner = await h.signup("owner@luna.es", "Olga");
  const orgId = await h.createOrg(owner, "Panadería Luna");
  await h.db.prepare("UPDATE organizations SET plan_code = 'growth' WHERE id = ?").bind(orgId).run();
  const org = await h.db.prepare("SELECT slug FROM organizations WHERE id = ?").bind(orgId).first<{ slug: string }>();
  const form = await owner.post(`/api/v1/orgs/${orgId}/crm/forms`, { name: "Landing", privacyUrl: "https://panaderialuna.es/privacidad" });
  expect(form.status).toBe(201);
  const formId = form.json.id as string;
  const L = `/api/v1/orgs/${orgId}/landings`;
  const visit = async (path: string, o: { ip?: string; ua?: string; method?: string } = {}) => {
    const res = await h.app.request(path, { method: o.method ?? "GET", headers: { "cf-connecting-ip": o.ip ?? "198.51.100.1", "user-agent": o.ua ?? UA } }, h.env, h.ctx);
    return { status: res.status, html: await res.text(), headers: res.headers };
  };
  const submit = async (body: Record<string, unknown>, ip = "198.51.100.77") => {
    const res = await h.app.request(
      `/api/v1/public/forms/${formId}/submit`,
      { method: "POST", headers: { "content-type": "application/json", origin: "http://localhost:8787", "cf-connecting-ip": ip }, body: JSON.stringify(body) },
      h.env,
      h.ctx,
    );
    return { status: res.status, json: (await res.json()) as any };
  };
  const lead = (extra: Record<string, unknown> = {}) => ({ name: "Ana Pérez", email: "ana@example.com", consent: true, _t: Date.now() - 10_000, ...extra });
  return { h, owner, orgId, orgSlug: org!.slug, formId, L, visit, submit, lead };
}

async function createPublished(s: Awaited<ReturnType<typeof setup>>, slug = "oferta-navidad") {
  const c = await s.owner.post(s.L, { name: "Oferta Navidad", slug, formId: s.formId });
  expect(c.status).toBe(201);
  const id = c.json.id as string;
  const pub = await s.owner.post(`${s.L}/${id}/publish`, {});
  expect(pub.status).toBe(200);
  return id;
}

describe("Landing renderer", () => {
  it("escapes every user text and only runs the nonce'd script", () => {
    const html = renderLanding({
      content: {
        seo: { title: '<script>alert(1)</script>', description: '"><img src=x onerror=alert(1)>' },
        theme: { accent: "#3f6212", mode: "light" },
        blocks: [
          { type: "hero", heading: "<b>Hola</b>", subheading: "", ctaLabel: "Ir", ctaHref: "#formulario", imageUrl: null, imageAlt: "" },
          { type: "text", heading: "", body: "a\n\n<iframe src=//evil>" },
        ],
      },
      orgName: "O'Brien & Co",
      canonicalUrl: "https://x.es/l/o/s",
      noindex: false,
      form: null,
      landingId: "00000000-0000-0000-0000-000000000000",
      variant: "A",
      nonce: "abc123",
    });
    expect(html).not.toMatch(/<script>alert|<img src=x|<iframe|<b>Hola/);
    expect(html).toContain("&lt;b&gt;Hola&lt;/b&gt;");
    expect(html).toContain("O&#39;Brien &amp; Co");
    expect(html.match(/<script/g)).toHaveLength(1);
    expect(html).toContain('<script nonce="abc123">');
  });
});

describe("Landing pages", () => {
  it("creates from the template, saves versions with optimistic locking and validates content", async () => {
    const s = await setup();
    const c = await s.owner.post(s.L, { name: "Oferta", slug: "oferta" });
    expect(c.status).toBe(201);
    const d = (await s.owner.get(`${s.L}/${c.json.id}`)).json;
    expect(d.draft.version).toBe(1);
    expect(d.page.url).toBe(`http://localhost:8787/l/${s.orgSlug}/oferta`);
    const content = { ...d.draft.content, blocks: [...d.draft.content.blocks, { type: "text", heading: "Más", body: "Detalle" }] };
    const save = await s.owner.put(`${s.L}/${c.json.id}/content`, { content, note: "Añado texto", baseVersionId: d.draft.id });
    expect(save.json.version).toBe(2);
    // Stale base version → conflict, nothing overwritten.
    expect((await s.owner.put(`${s.L}/${c.json.id}/content`, { content, baseVersionId: d.draft.id })).status).toBe(409);
    // Invalid content: javascript: link and empty blocks.
    const bad = await s.owner.put(`${s.L}/${c.json.id}/content`, { content: { ...content, blocks: [{ type: "cta", heading: "Hola", ctaLabel: "Ir", ctaHref: "javascript:alert(1)" }] }, baseVersionId: save.json.versionId });
    expect(bad.status).toBe(422);
    expect((await s.owner.post(s.L, { name: "Otra", slug: "oferta" })).status).toBe(409);
    expect((await s.owner.post(s.L, { name: "Otra", slug: "Mal Slug" })).status).toBe(422);
  });

  it("publishing needs an active form when there is a form block; public page served with CSP, noindex honoured, 404 when unpublished", async () => {
    const s = await setup();
    const c = await s.owner.post(s.L, { name: "Oferta", slug: "oferta" });
    const id = c.json.id as string;
    const noForm = await s.owner.post(`${s.L}/${id}/publish`, {});
    expect(noForm.status).toBe(422);
    expect(noForm.json.code).toBe("form_required");
    expect((await s.visit(`/l/${s.orgSlug}/oferta`)).status).toBe(404);
    await s.owner.patch(`${s.L}/${id}`, { formId: s.formId, noindex: true });
    expect((await s.owner.post(`${s.L}/${id}/publish`, {})).status).toBe(200);
    const page = await s.visit(`/l/${s.orgSlug}/oferta`);
    expect(page.status).toBe(200);
    expect(page.html).toContain(`action="/api/v1/public/forms/${s.formId}/submit"`);
    expect(page.html).toContain('content="noindex,nofollow"');
    expect(page.headers.get("content-security-policy")).toMatch(/script-src 'nonce-[0-9a-f]{32}'/);
    expect(page.headers.get("set-cookie")).toBeNull();
    expect((await s.owner.post(`${s.L}/${id}/unpublish`, {})).status).toBe(200);
    expect((await s.visit(`/l/${s.orgSlug}/oferta`)).status).toBe(404);
    expect((await s.visit(`/l/otra-org/oferta`)).status).toBe(404);
    // Audit trail for publish/unpublish.
    const acts = await s.h.db.prepare("SELECT action FROM audit_logs WHERE organization_id = ? AND action LIKE 'landing.%' ORDER BY rowid").bind(s.orgId).all<{ action: string }>();
    expect(acts.results.map((a) => a.action)).toEqual(expect.arrayContaining(["landing.create", "landing.update", "landing.publish", "landing.unpublish"]));
  });

  it("preview is private, marked as preview and cannot submit", async () => {
    const s = await setup();
    const id = await createPublished(s);
    const pv = await s.owner.get(`${s.L}/${id}/preview`);
    expect(pv.status).toBe(200);
    expect(pv.json).toContain("Vista previa");
    expect(pv.headers.get("content-security-policy")).toContain("form-action 'none'");
    const anon = new s.h.Client();
    expect((await anon.get(`${s.L}/${id}/preview`)).status).toBe(401);
  });

  it("counts human views (not bots, not HEAD) and conversions from the landing form, and links the lead to the landing", async () => {
    const s = await setup();
    const id = await createPublished(s);
    await s.visit(`/l/${s.orgSlug}/oferta-navidad`);
    await s.visit(`/l/${s.orgSlug}/oferta-navidad`, { ip: "198.51.100.2" });
    await s.visit(`/l/${s.orgSlug}/oferta-navidad`, { ua: "Googlebot/2.1" });
    await s.visit(`/l/${s.orgSlug}/oferta-navidad`, { method: "HEAD" });
    const r = await s.submit(s.lead({ _lp: id, _v: "A" }));
    expect(r.status).toBe(200);
    // A spam submission from the landing does not count as a conversion.
    await s.submit(s.lead({ email: "spam@x.es", website: "http://x", _lp: id, _v: "A" }));
    const d = (await s.owner.get(`${s.L}/${id}`)).json;
    expect(d.stats.a).toEqual({ views: 2, conversions: 1 });
    expect(d.stats.measurement).toBe("observed");
    const leadRow = await s.h.db.prepare("SELECT landing_id, landing_variant FROM leads WHERE organization_id = ?").bind(s.orgId).first();
    expect(leadRow).toEqual({ landing_id: id, landing_variant: "A" });
    // A forged landing id from another organisation is ignored.
    const other = await s.h.signup("otra@x.es");
    const otherOrg = await s.h.createOrg(other, "Otra", "starter");
    expect(otherOrg).toBeTruthy();
    await s.submit(s.lead({ email: "b@x.es", _lp: "11111111-1111-1111-1111-111111111111", _v: "B" }));
    expect((await s.owner.get(`${s.L}/${id}`)).json.stats.a.conversions).toBe(1);
  });

  it("A/B: needs a published page, a different version and a hypothesis; assigns deterministically without cookies; stop and promote B", async () => {
    const s = await setup();
    const id = await createPublished(s);
    const d = (await s.owner.get(`${s.L}/${id}`)).json;
    const vB = await s.owner.put(`${s.L}/${id}/content`, { content: { ...d.draft.content, blocks: d.draft.content.blocks.map((b: any) => (b.type === "hero" ? { ...b, heading: "Titular B distinto" } : b)) }, note: "Titular B", baseVersionId: d.draft.id });
    const vbId = vB.json.versionId as string;
    expect((await s.owner.post(`${s.L}/${id}/experiment`, { action: "start", variantBVersionId: vbId, split: 50, hypothesis: "corta" })).status).toBe(422);
    expect((await s.owner.post(`${s.L}/${id}/experiment`, { action: "start", variantBVersionId: d.page.published_version_id, split: 50, hypothesis: "El titular B convierte más" })).status).toBe(422);
    const start = await s.owner.post(`${s.L}/${id}/experiment`, { action: "start", variantBVersionId: vbId, split: 50, hypothesis: "El titular B convierte más" });
    expect(start.status).toBe(200);
    // Publishing another version while running is blocked.
    expect((await s.owner.post(`${s.L}/${id}/publish`, {})).json.code).toBe("experiment_running");
    let seenA = 0;
    let seenB = 0;
    for (let i = 1; i <= 40; i++) {
      const ip = `203.0.113.${i}`;
      const first = await s.visit(`/l/${s.orgSlug}/oferta-navidad`, { ip });
      const again = await s.visit(`/l/${s.orgSlug}/oferta-navidad`, { ip });
      const isB = first.html.includes("Titular B distinto");
      expect(again.html.includes("Titular B distinto")).toBe(isB);
      expect(first.html).toContain(`name="_v" value="${isB ? "B" : "A"}"`);
      if (isB) seenB++;
      else seenA++;
    }
    expect(seenA).toBeGreaterThan(5);
    expect(seenB).toBeGreaterThan(5);
    await s.submit(s.lead({ _lp: id, _v: "B" }));
    const st = (await s.owner.get(`${s.L}/${id}`)).json.stats;
    expect(st.a.views + st.b.views).toBe(80);
    expect(st.b.conversions).toBe(1);
    expect(st.test.verdict).toBe("insufficient_data");
    expect(st.test.warnings[0]).toMatch(/Muestra insuficiente/);
    expect((await s.owner.post(`${s.L}/${id}/experiment`, { action: "stop" })).status).toBe(200);
    // After stopping, everyone sees A and a B conversion is no longer counted.
    for (let i = 1; i <= 10; i++) expect((await s.visit(`/l/${s.orgSlug}/oferta-navidad`, { ip: `203.0.113.${i}` })).html).not.toContain("Titular B distinto");
    expect((await s.owner.post(`${s.L}/${id}/experiment`, { action: "promote_b" })).status).toBe(200);
    expect((await s.visit(`/l/${s.orgSlug}/oferta-navidad`)).html).toContain("Titular B distinto");
  });

  it("roles: editors edit but cannot publish; analysts only read; other tenants see nothing; plan limit enforced", async () => {
    const s = await setup();
    const id = await createPublished(s);
    const editor = await s.h.invite(s.owner, s.orgId, "editor@luna.es", "editor");
    const analyst = await s.h.invite(s.owner, s.orgId, "analyst@luna.es", "analyst");
    expect((await editor.patch(`${s.L}/${id}`, { name: "Renombrada" })).status).toBe(200);
    expect((await editor.post(`${s.L}/${id}/publish`, {})).status).toBe(403);
    expect((await editor.post(`${s.L}/${id}/unpublish`, {})).status).toBe(403);
    expect((await analyst.get(s.L)).status).toBe(200);
    expect((await analyst.patch(`${s.L}/${id}`, { name: "No" })).status).toBe(403);
    const intruder = await s.h.signup("intruso@x.es");
    const iOrg = await s.h.createOrg(intruder, "Intrusa", "starter");
    expect((await intruder.get(s.L)).status).toBe(404);
    expect((await intruder.get(`/api/v1/orgs/${iOrg}/landings/${id}`)).status).toBe(404);
    expect((await intruder.patch(`/api/v1/orgs/${iOrg}/landings/${id}`, { formId: s.formId })).status).toBe(404);
    expect((await intruder.post(`/api/v1/orgs/${iOrg}/landings`, { name: "Intrusa", slug: "xxx", formId: s.formId })).status).toBe(404);
    await s.h.db.prepare("UPDATE organizations SET plan_code = 'free' WHERE id = ?").bind(s.orgId).run();
    const lim = await s.owner.post(s.L, { name: "Segunda", slug: "segunda" });
    expect(lim.status).toBe(402);
  });
});

describe("Follow-up automations", () => {
  it("helpers: quiet hours across midnight, next send time and {nombre}", () => {
    // 22:30 and 07:00 Madrid (CET, UTC+1 in winter) are quiet for 21:00–08:00; 12:00 is not.
    expect(inQuietHours(new Date("2026-01-15T21:30:00Z"), "21:00", "08:00")).toBe(true);
    expect(inQuietHours(new Date("2026-01-15T06:00:00Z"), "21:00", "08:00")).toBe(true);
    expect(inQuietHours(new Date("2026-01-15T11:00:00Z"), "21:00", "08:00")).toBe(false);
    expect(inQuietHours(new Date("2026-01-15T11:00:00Z"), "00:00", "00:00")).toBe(false);
    const next = nextSendTime(new Date("2026-01-15T21:30:00Z"), "21:00", "08:00");
    expect(next?.toISOString()).toBe("2026-01-16T07:00:00.000Z");
    expect(nextSendTime(new Date("2026-01-15T11:00:00Z"), "21:00", "08:00")).toBeNull();
    expect(renderTemplate("Hola {nombre}, {nombre}", { nombre: "Ana Pérez" })).toBe("Hola Ana, Ana");
  });

  it("auto-reply goes once to a new lead (not on re-submission), with the org as sender name; follow-up task is created", async () => {
    const s = await setup();
    const A = `/api/v1/orgs/${s.orgId}/crm/forms/${s.formId}/automations`;
    const bad = await s.owner.put(A, { kind: "auto_reply", enabled: true, config: { subject: "Hola", body: "corto", replyTo: "no-email" } });
    expect(bad.status).toBe(422);
    expect((await s.owner.put(A, { kind: "auto_reply", enabled: true, config: { subject: "Recibido, {nombre}", body: "Hola {nombre}:\n\nTe respondemos pronto.", replyTo: "hola@panaderialuna.es", quietStart: "00:00", quietEnd: "00:00" } })).status).toBe(200);
    expect((await s.owner.put(A, { kind: "follow_up_task", enabled: true, config: { title: "Llamar al contacto", dueHours: 4 } })).status).toBe(200);
    await s.submit(s.lead());
    await s.h.drain();
    await s.submit(s.lead({ message: "Otra vez" }));
    await s.h.drain();
    const mails = await s.h.db.prepare("SELECT subject, body FROM dev_mailbox WHERE to_email = 'ana@example.com'").all<{ subject: string; body: string }>();
    expect(mails.results).toHaveLength(1);
    expect(mails.results[0]!.subject).toBe("Recibido, Ana");
    expect(mails.results[0]!.body).toMatch(/Hola Ana:[\s\S]*Panadería Luna a través de su formulario/);
    const tasks = await s.h.db.prepare("SELECT title, due_at FROM crm_tasks WHERE organization_id = ?").bind(s.orgId).all<{ title: string; due_at: string }>();
    expect(tasks.results).toHaveLength(1);
    expect(tasks.results[0]!.title).toBe("Llamar al contacto");
    const runs = (await s.owner.get(A)).json;
    expect(runs.items.map((x: any) => x.kind).sort()).toEqual(["auto_reply", "follow_up_task"]);
    expect(runs.runs).toHaveLength(2);
    // Spam never triggers automations.
    await s.submit(s.lead({ email: "bot@x.es", website: "http://spam" }));
    await s.h.drain();
    expect((await s.h.db.prepare("SELECT COUNT(*) AS n FROM dev_mailbox WHERE to_email = 'bot@x.es'").first<{ n: number }>())!.n).toBe(0);
  });

  it("quiet hours queue the email for later instead of sending now; disabled automations do nothing; only forms:manage can configure", async () => {
    const s = await setup();
    const A = `/api/v1/orgs/${s.orgId}/crm/forms/${s.formId}/automations`;
    await s.owner.put(A, { kind: "auto_reply", enabled: true, config: { subject: "Recibido", body: "Gracias por escribirnos.", replyTo: "hola@panaderialuna.es", quietStart: "00:00", quietEnd: "23:59" } });
    await s.submit(s.lead());
    await s.h.drain();
    const q = await s.h.db.prepare("SELECT status, next_attempt_at FROM email_outbox WHERE organization_id = ? AND idempotency_key LIKE 'auto-reply:%'").bind(s.orgId).first<{ status: string; next_attempt_at: string }>();
    expect(q?.status).toBe("queued");
    expect(q!.next_attempt_at > new Date().toISOString()).toBe(true);
    expect((await s.h.db.prepare("SELECT COUNT(*) AS n FROM dev_mailbox WHERE to_email = 'ana@example.com'").first<{ n: number }>())!.n).toBe(0);
    // Erasing the lead cancels the pending reply and drops its encrypted payload.
    const leadId = (await s.owner.get(`/api/v1/orgs/${s.orgId}/crm/leads`)).json.items[0].id as string;
    expect((await s.owner.del(`/api/v1/orgs/${s.orgId}/crm/leads/${leadId}`)).status).toBe(200);
    const cancelled = await s.h.db.prepare("SELECT status, payload_enc FROM email_outbox WHERE organization_id = ? AND idempotency_key LIKE 'auto-reply:%'").bind(s.orgId).first();
    expect(cancelled).toEqual({ status: "dead", payload_enc: null });
    await s.owner.put(A, { kind: "auto_reply", enabled: false, config: { subject: "Recibido", body: "Gracias por escribirnos.", replyTo: "hola@panaderialuna.es" } });
    await s.submit(s.lead({ email: "luis@example.com" }));
    await s.h.drain();
    expect((await s.h.db.prepare("SELECT COUNT(*) AS n FROM email_outbox WHERE organization_id = ? AND idempotency_key LIKE 'auto-reply:%'").bind(s.orgId).first<{ n: number }>())!.n).toBe(1);
    const editor = await s.h.invite(s.owner, s.orgId, "editor@luna.es", "editor");
    expect((await editor.put(A, { kind: "follow_up_task", enabled: true, config: { title: "Llamar" } })).status).toBe(403);
    const intruder = await s.h.signup("intruso@x.es");
    const iOrg = await s.h.createOrg(intruder, "Intrusa", "starter");
    expect((await intruder.get(`/api/v1/orgs/${iOrg}/crm/forms/${s.formId}/automations`)).status).toBe(404);
  });
});
