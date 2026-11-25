import { describe, expect, it } from "vitest";
import { reportPeriod, reportUnsubscribeToken, sendMonthlyReports } from "../src/lib/monthly-report";
import { createHarness } from "./helpers";

const DEC2 = new Date("2026-12-02T09:00:00.000Z");
const mails = (h: ReturnType<typeof createHarness>, to: string) =>
  h.db.prepare("SELECT subject, body FROM dev_mailbox WHERE to_email = ? AND subject LIKE 'Tu mes en DNI Growth%' ORDER BY created_at, rowid").bind(to).all<{ subject: string; body: string }>();

describe("monthly report email", () => {
  it("computes the previous calendar month", () => {
    expect(reportPeriod(DEC2)).toMatchObject({ key: "2026-11", label: "noviembre de 2026", start: "2026-11-01", end: "2026-12-01", prevStart: "2026-10-01", daysInMonth: 30 });
    expect(reportPeriod(new Date("2027-01-03T10:00:00Z"))).toMatchObject({ key: "2026-12", start: "2026-12-01", end: "2027-01-01", prevLabel: "noviembre de 2026" });
  });

  it("sends owners/admins the month's work and observed Search Console figures once, and honours the opt-out", async () => {
    const h = createHarness();
    const owner = await h.signup("ana@informe.es", "Ana López");
    const orgId = await h.createOrg(owner, "Clínica Sol", "growth");
    const editor = await h.invite(owner, orgId, "edu@informe.es", "editor");
    void editor;
    const quiet = await h.signup("luis@informe.es", "Luis");
    const quietOrg = await h.createOrg(quiet, "Sin actividad");
    await h.db.prepare("UPDATE organizations SET created_at = '2026-09-01T00:00:00.000Z'").run();

    // Work: one content item approved in November (and one in October that must not count).
    for (const [title, at] of [
      ["Artículo de noviembre", "2026-11-15T10:00:00.000Z"],
      ["Artículo de octubre", "2026-10-20T10:00:00.000Z"],
    ] as const) {
      const r = await owner.post(`/api/v1/orgs/${orgId}/content/manual`, { kind: "blog_article", title });
      expect(r.status).toBe(201);
      await h.db.prepare("UPDATE content_items SET status = 'approved', approved_at = ? WHERE id = ?").bind(at, r.json.id).run();
    }
    // Search Console: 30 days in November (10 clicks/day) and 31 in October (8 clicks/day): not the same days → no % comparison.
    await h.db.batch([
      h.db.prepare("INSERT INTO integrations (id, organization_id, provider, status) VALUES ('i1', ?, 'google_search_console', 'connected')").bind(orgId),
      h.db.prepare("INSERT INTO gsc_properties (id, organization_id, integration_id, site_url, permission_level, selected) VALUES ('p1', ?, 'i1', 'sc-domain:clinicasol.es', 'siteOwner', 1)").bind(orgId),
    ]);
    const days: D1PreparedStatement[] = [];
    for (let d = 1; d <= 31; d++) {
      days.push(h.db.prepare("INSERT INTO gsc_daily_metrics (organization_id, property_id, date, clicks, impressions, ctr, position, observed_at) VALUES (?, 'p1', ?, 8, 100, 0.08, 9, '2026-12-01T03:00:00Z')").bind(orgId, `2026-10-${String(d).padStart(2, "0")}`));
      if (d <= 30) days.push(h.db.prepare("INSERT INTO gsc_daily_metrics (organization_id, property_id, date, clicks, impressions, ctr, position, observed_at) VALUES (?, 'p1', ?, 10, 120, 0.08, 8, '2026-12-01T03:00:00Z')").bind(orgId, `2026-11-${String(d).padStart(2, "0")}`));
    }
    days.push(h.db.prepare("INSERT INTO gsc_top_rows (organization_id, property_id, dimension, key, clicks, impressions, ctr, position, period_start, period_end, observed_at) VALUES (?, 'p1', 'page', 'https://clinicasol.es/', 20, 400, 0.05, 7, 'a', 'b', 'c')").bind(orgId));
    days.push(h.db.prepare("INSERT INTO gsc_page_prev (organization_id, property_id, key, clicks, impressions, ctr, position, period_start, period_end, observed_at) VALUES (?, 'p1', 'https://clinicasol.es/', 80, 500, 0.16, 3, 'a', 'b', 'c')").bind(orgId));
    await h.db.batch(days);

    // Outside days 1–7 (or before 07:00 UTC) nothing is sent.
    expect(await sendMonthlyReports(h.env, new Date("2026-12-12T09:00:00Z"))).toEqual({ sent: 0, skipped: 0 });
    expect(await sendMonthlyReports(h.env, new Date("2026-12-02T05:00:00Z"))).toEqual({ sent: 0, skipped: 0 });

    // Owner of the active org gets it; the editor does not; the org with nothing to report sends nothing.
    expect(await sendMonthlyReports(h.env, DEC2)).toEqual({ sent: 1, skipped: 1 });
    expect(await sendMonthlyReports(h.env, DEC2)).toEqual({ sent: 0, skipped: 0 });
    const box = (await mails(h, "ana@informe.es")).results;
    expect(box).toHaveLength(1);
    expect(box[0]!.subject).toBe("Tu mes en DNI Growth: noviembre de 2026 · Clínica Sol");
    const body = box[0]!.body;
    expect(body).toContain("Hola, Ana:");
    expect(body).toContain("1 contenido aprobado");
    expect(body).toContain("300 clics");
    expect(body).toContain("3600 impresiones".replace("3600", (3600).toLocaleString("es-ES")));
    expect(body).not.toContain("frente al mes anterior"); // 30 vs 31 days: no misleading comparison
    expect(body).toContain("no se compara con octubre de 2026");
    expect(body).toContain("1 página pierde clics");
    expect(body).toContain("Fuente: Google Search Console API");
    expect(body).toContain(`/app/o/${orgId}/search-console`);
    expect((await mails(h, "edu@informe.es")).results).toHaveLength(0);
    expect((await mails(h, "luis@informe.es")).results).toHaveLength(0);
    expect(await h.db.prepare("SELECT status, reason FROM monthly_report_sends WHERE organization_id = ?").bind(quietOrg).first()).toMatchObject({ status: "skipped", reason: "nothing_to_report" });

    // Opt-out: GET only confirms, POST unsubscribes; next month nothing is sent.
    const user = await h.db.prepare("SELECT id FROM users WHERE email = 'ana@informe.es'").first<{ id: string }>();
    const token = await reportUnsubscribeToken(h.env, user!.id);
    expect((await h.app.request(`/api/v1/public/monthly-report/unsubscribe?u=${user!.id}&t=${"0".repeat(32)}`, {}, h.env, h.ctx)).status).toBe(400);
    const confirm = await h.app.request(`/api/v1/public/monthly-report/unsubscribe?u=${user!.id}&t=${token}`, {}, h.env, h.ctx);
    expect(await confirm.text()).toContain("Sí, darme de baja");
    const done = await h.app.request("/api/v1/public/monthly-report/unsubscribe", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: `u=${user!.id}&t=${token}` }, h.env, h.ctx);
    expect(done.status).toBe(200);
    await h.db.prepare("UPDATE content_items SET approved_at = '2026-12-10T10:00:00.000Z' WHERE title = 'Artículo de noviembre'").run();
    expect(await sendMonthlyReports(h.env, new Date("2027-01-02T09:00:00Z"))).toMatchObject({ sent: 0 });
  });
});
