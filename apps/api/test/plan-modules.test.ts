import { describe, expect, it } from "vitest";
import { MODULE_MIN_PLAN, moduleForApiPath, PLAN_ORDER, planIncludes } from "@dni/core";
import { claimPlatformOwner, createHarness } from "./helpers";

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
  social: "/social",
  cms: "/cms",
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
    expect(planIncludes("starter", "authority")).toBe(true);
    expect(planIncludes("free", "authority")).toBe(false);
    expect(planIncludes("starter", "creative")).toBe(false);
    expect(planIncludes("unknown-plan", "seo-tecnico")).toBe(false);
    expect(planIncludes("unknown-plan", "content")).toBe(true);
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
    expect(moduleForApiPath("/content/abc/wordpress", "POST")).toBe("cms");
    expect(moduleForApiPath("/content/abc/wordpress/unpublish", "POST")).toBe("cms");
    expect(moduleForApiPath("/content/abc")).toBe("content");
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

  it("a new organisation starts free and its Command Center only offers what each plan includes", async () => {
    const h = createHarness();
    const owner = await h.signup("nueva@luna.es", "Nuria");
    const created = await owner.post("/api/v1/orgs", { name: "Cuenta nueva" });
    const orgId = created.json.id as string;
    const me = (await owner.get("/api/v1/auth/me")).json;
    expect(me.user.isPlatformAdmin).toBe(false);
    expect(me.memberships.find((m: any) => m.id === orgId).plan_code).toBe("free");
    const cards = async () => {
      const d = (await owner.get(`/api/v1/orgs/${orgId}/dashboard`)).json;
      return { kpis: d.kpis.map((k: any) => k.key), unavailable: d.unavailable.map((u: any) => u.key) };
    };
    expect(await cards()).toEqual({ kpis: ["organic_traffic", "attributed_revenue"], unavailable: [] });
    const expected: Record<string, string[]> = {
      starter: ["organic_traffic", "ai_visibility", "attributed_revenue"],
      growth: ["organic_traffic", "ai_visibility", "attributed_revenue"],
      pro: ["organic_traffic", "ai_visibility", "attributed_revenue", "ads_plan"],
      agency: ["organic_traffic", "ai_visibility", "attributed_revenue", "ads_plan"],
    };
    for (const [plan, kpis] of Object.entries(expected)) {
      await h.db.prepare("UPDATE organizations SET plan_code = ? WHERE id = ?").bind(plan, orgId).run();
      expect(await cards(), plan).toEqual({ kpis, unavailable: planIncludes(plan, "ads") ? ["ad_spend"] : [] });
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
    // A legacy admin (before the owner is bound with TOTP) cannot change plans.
    expect((await admin.post(url, { planCode: "agency", reason: "Organización interna" })).json.code).toBe("platform_claim_required");
    await claimPlatformOwner(h, admin);
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

describe("the limits each plan applies are at least what /precios sells", () => {
  /** Published row → limit key in plans.limits_json. «N por web» is multiplied by the plan's webs. */
  const ROW_LIMIT: Record<string, string> = {
    "Webs (proyectos)": "brands",
    Usuarios: "seats",
    "Auditorías al mes": "analysesPerMonth",
    "Páginas por auditoría": "pagesPerCrawl",
    "Borradores de artículos al mes (revisión humana)": "articlesPerMonth",
    "Visibilidad en IA (prompts en seguimiento)": "trackedPrompts",
    "Vídeos y piezas sociales": "videoProjects",
  };
  const sold = (value: string, webs: number): number | null => {
    if (value === "—") return null;
    if (/ilimitad/i.test(value)) return 1000;
    const n = Number(/(\d+)/.exec(value)?.[1]);
    if (!Number.isFinite(n)) throw new Error(`valor sin número: ${value}`);
    return /por web/.test(value) ? n * webs : n;
  };

  it("checks every numeric row against the plans table the API enforces", async () => {
    const h = createHarness();
    const { results } = await h.db.prepare("SELECT code, price_eur_month, price_eur_year, limits_json FROM plans WHERE active = 1").all<{ code: string; price_eur_month: number; price_eur_year: number; limits_json: string }>();
    const { PRICING_ROWS, PLAN_OFFERS } = await import("@dni/core");
    for (const offer of PLAN_OFFERS) {
      const plan = results.find((r) => r.code === offer.code);
      expect(plan, `plan ${offer.code} en la tabla plans`).toBeDefined();
      // The price charged is the price published.
      expect([plan!.price_eur_month, plan!.price_eur_year ?? 0], offer.code).toEqual([offer.monthly, offer.yearly]);
      const limits = JSON.parse(plan!.limits_json) as Record<string, number>;
      for (const [label, key] of Object.entries(ROW_LIMIT)) {
        const row = PRICING_ROWS.find((r) => r.label === label)!;
        expect(row, label).toBeDefined();
        const n = sold(row.values[offer.code], limits.brands ?? 1);
        if (n !== null) expect(limits[key] ?? 0, `${offer.code} · ${label}: vendido ${row.values[offer.code]}, límite ${key}=${limits[key]}`).toBeGreaterThanOrEqual(n);
      }
    }
  });
});
