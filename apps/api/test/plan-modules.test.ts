import { describe, expect, it } from "vitest";
import { MODULE_MIN_PLAN, moduleForApiPath, PLAN_ORDER, planIncludes } from "@dni/core";
import { createHarness } from "./helpers";

/** One representative GET per module (relative to /orgs/:orgId). */
const PROBE: Record<string, string> = {
  "seo-tecnico": "/seo/overview",
  keywords: "/keywords/overview",
  content: "/content",
  landings: "/landings",
  reports: "/reports",
  authority: "/backlinks",
  creative: "/creative/images",
  video: "/video/projects",
  automations: "/automations/rules",
  attribution: "/crm/attribution",
  analytics: "/analytics",
  ads: "/ads/overview",
  agency: "/agency/clients",
};

describe("plan module matrix", () => {
  it("each plan includes everything the cheaper plans include", () => {
    for (const m of Object.keys(MODULE_MIN_PLAN)) {
      let seen = false;
      for (const p of PLAN_ORDER) {
        if (planIncludes(p, m)) seen = true;
        else expect(seen, `${m} lost on ${p}`).toBe(false);
      }
      expect(planIncludes("agency", m)).toBe(true);
    }
    expect(planIncludes("pro", "agency")).toBe(false);
    expect(planIncludes("starter", "authority")).toBe(false);
    expect(planIncludes("unknown-plan", "content")).toBe(false);
  });

  it("maps API paths to modules (branding writes are white label)", () => {
    expect(moduleForApiPath("/brands/x/geo/prompts")).toBe("ai-visibility");
    expect(moduleForApiPath("/brands/x")).toBeNull();
    expect(moduleForApiPath("/branding", "GET")).toBeNull();
    expect(moduleForApiPath("/branding", "PUT")).toBe("agency");
    expect(moduleForApiPath("/crm/leads")).toBeNull();
    expect(moduleForApiPath("/crm/attribution")).toBe("attribution");
    expect(moduleForApiPath("/keywords.csv")).toBe("keywords");
    expect(moduleForApiPath("/analytics")).toBe("analytics");
    expect(moduleForApiPath("/analytics", "DELETE")).toBeNull();
    expect(moduleForApiPath("/backlinks/x", "DELETE")).toBeNull();
  });
});

describe("plan gate on the API", () => {
  it("every plan reaches exactly its modules; locked ones answer 402 plan_required", async () => {
    const h = createHarness();
    const owner = await h.signup("owner@luna.es", "Olga");
    const orgId = await h.createOrg(owner, "Panadería Luna");
    for (const plan of PLAN_ORDER) {
      await h.db.prepare("UPDATE organizations SET plan_code = ? WHERE id = ?").bind(plan, orgId).run();
      for (const [module, path] of Object.entries(PROBE)) {
        const r = await owner.get(`/api/v1/orgs/${orgId}${path}`);
        if (planIncludes(plan, module)) expect(r.status, `${plan} ${module}`).not.toBe(402);
        else expect(r.json, `${plan} ${module}`).toMatchObject({ code: "plan_required", module, currentPlan: plan, requiredPlan: MODULE_MIN_PLAN[module] });
      }
    }
  });

  it("Pro cannot use white label or create client organisations; Agency can", async () => {
    const h = createHarness();
    const owner = await h.signup("owner@luna.es", "Olga");
    const orgId = await h.createOrg(owner, "Agencia Luna", "pro");
    const O = `/api/v1/orgs/${orgId}`;
    expect((await owner.put(`${O}/branding`, { displayName: "Luna" })).status).toBe(402);
    expect((await owner.post(`${O}/agency/clients`, { name: "Cliente" })).status).toBe(402);
    expect((await owner.get(`${O}/branding`)).status).toBe(200);
    await h.db.prepare("UPDATE organizations SET plan_code = 'agency' WHERE id = ?").bind(orgId).run();
    expect((await owner.put(`${O}/branding`, { displayName: "Luna" })).status).toBe(200);
    expect((await owner.post(`${O}/agency/clients`, { name: "Cliente" })).status).toBe(201);
  });

  it("a platform admin keeps access to every module of an organisation they belong to", async () => {
    const h = createHarness();
    const admin = await h.signup("admin@dni.es", "Admin");
    await h.db.prepare("UPDATE users SET is_platform_admin = 1 WHERE email = 'admin@dni.es'").run();
    const orgId = await h.createOrg(admin, "Interna");
    expect((await admin.get(`/api/v1/orgs/${orgId}/ads/overview`)).status).toBe(200);
    expect((await admin.get(`/api/v1/orgs/${orgId}/agency/clients`)).status).toBe(200);
  });

  it("/me exposes the effective plan (client organisations inherit the agency plan)", async () => {
    const h = createHarness();
    const owner = await h.signup("owner@luna.es", "Olga");
    const agencyId = await h.createOrg(owner, "Agencia", "agency");
    const client = await owner.post(`/api/v1/orgs/${agencyId}/agency/clients`, { name: "Cliente" });
    expect(client.status).toBe(201);
    const me = (await owner.get("/api/v1/auth/me")).json;
    const row = me.memberships.find((m: { id: string }) => m.id === client.json.id);
    expect(row).toMatchObject({ plan_code: "free", effective_plan: "agency" });
  });
});

describe("platform console", () => {
  it("is invisible to non-admins and gives admins counts, not tenant content", async () => {
    const h = createHarness();
    const user = await h.signup("user@luna.es", "Olga");
    const orgId = await h.createOrg(user, "Panadería Luna");
    for (const p of ["/api/v1/admin/overview", "/api/v1/admin/organizations", "/api/v1/admin/users"]) expect((await user.get(p)).status).toBe(404);
    expect((await user.post(`/api/v1/admin/organizations/${orgId}/plan`, { planCode: "agency", reason: "yo mismo" })).status).toBe(404);

    const admin = await h.signup("admin@dni.es", "Admin");
    await h.db.prepare("UPDATE users SET is_platform_admin = 1 WHERE email = 'admin@dni.es'").run();
    const ov = await admin.get("/api/v1/admin/overview");
    expect(ov.status).toBe(200);
    expect(ov.json).toMatchObject({ measurement: "observed", users: { total: 2 }, organizations: { total: 1 } });
    expect(ov.json.subscriptions.caveat).toMatch(/prueba|lista/);
    const orgs = (await admin.get("/api/v1/admin/organizations?q=Luna")).json.items;
    expect(orgs).toHaveLength(1);
    expect(orgs[0]).toMatchObject({ name: "Panadería Luna", plan_code: "free", members: 1, owner_email: "user@luna.es" });
    expect((await admin.get("/api/v1/admin/users?q=olga")).json.items.map((u: { email: string }) => u.email)).toEqual(["user@luna.es"]);
  });

  it("assigns an internal plan with audit, and refuses it while Stripe bills the organisation", async () => {
    const h = createHarness();
    const user = await h.signup("user@luna.es", "Olga");
    const orgId = await h.createOrg(user, "Panadería Luna");
    const admin = await h.signup("admin@dni.es", "Admin");
    await h.db.prepare("UPDATE users SET is_platform_admin = 1 WHERE email = 'admin@dni.es'").run();
    const url = `/api/v1/admin/organizations/${orgId}/plan`;
    expect((await admin.post(url, { planCode: "agency", reason: "x" })).status).toBe(422);
    expect((await admin.post(url, { planCode: "agency", reason: "Organización interna" })).json).toMatchObject({ changed: true });
    expect((await user.get(`/api/v1/orgs/${orgId}/agency/clients`)).status).toBe(200);
    const audit = await h.db.prepare("SELECT after_redacted FROM audit_logs WHERE action = 'platform.plan_assign'").first<{ after_redacted: string }>();
    expect(JSON.parse(audit!.after_redacted)).toMatchObject({ plan: "agency", charge: "none" });

    expect((await h.db.prepare("SELECT plan_code FROM subscriptions WHERE organization_id = ?").bind(orgId).first<{ plan_code: string }>())!.plan_code).toBe("agency");
    await h.db.prepare("UPDATE subscriptions SET plan_code = 'starter', provider = 'stripe', provider_sub_id = 'sub_test', status = 'active' WHERE organization_id = ?").bind(orgId).run();
    const r = await admin.post(url, { planCode: "free", reason: "Bajar a gratis" });
    expect(r.status).toBe(409);
    expect(r.json.code).toBe("stripe_subscription");
  });
});
