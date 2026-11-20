import { describe, expect, it } from "vitest";
import { claimPlatformOwner, createHarness, insertClaimCode, TEST_ENC_KEY, totpNow } from "./helpers";

/** Platform Control Center: owner binding, TOTP, step-up, scopes, organisation lifecycle and support. */
async function setup() {
  const h = createHarness();
  h.env.DATA_ENC_KEY = TEST_ENC_KEY;
  const owner = await h.signup("dueno@dnigrowth.test", "Dueña");
  const customer = await h.signup("cliente@luna.es", "Olga");
  const orgId = await h.createOrg(customer, "Panadería Luna");
  return { h, owner, customer, orgId };
}
const A = "/api/v1/admin";
/** Moves this session's last TOTP proof `minutes` into the past (to test the 15-minute step-up). */
const ageMfa = (h: ReturnType<typeof createHarness>, minutes: number) =>
  h.db.prepare("UPDATE sessions SET platform_mfa_at = ? WHERE platform_mfa_at IS NOT NULL").bind(new Date(Date.now() - minutes * 60_000).toISOString()).run();

describe("platform owner binding (claim code + TOTP)", () => {
  it("never grants privileges by e-mail once an owner is claimed; codes are single use and hashed", async () => {
    const { h, owner, customer } = await setup();
    expect((await customer.get("/api/v1/platform/session")).json).toEqual({ member: false, claimed: false });
    for (const p of [`${A}/overview`, `${A}/ops`, `${A}/audit`, `${A}/ai/usage`]) expect((await customer.get(p)).status).toBe(404);

    expect((await owner.post("/api/v1/platform/claim", { code: "WRONG-CODE0-00000-00000" })).status).toBe(400);
    await insertClaimCode(h, "OLD00-CODE0-00000-00000", "platform_owner", -1000);
    expect((await owner.post("/api/v1/platform/claim", { code: "OLD00-CODE0-00000-00000" })).status).toBe(400);

    // Only the hash is stored.
    await insertClaimCode(h, "AAAAA-BBBBB-CCCCC-DDDDD");
    const stored = await h.db.prepare("SELECT code_hash FROM platform_claim_codes WHERE used_at IS NULL AND expires_at > ?").bind(new Date().toISOString()).first<{ code_hash: string }>();
    expect(stored!.code_hash).toMatch(/^[0-9a-f]{64}$/);
    const claim = await owner.post("/api/v1/platform/claim", { code: "AAAAA-BBBBB-CCCCC-DDDDD" });
    expect(claim.status).toBe(200);
    expect(claim.json.otpauthUri).toMatch(/^otpauth:\/\/totp\/DNI%20Growth%3APropietario\?secret=/);
    expect(claim.json.otpauthUri).not.toContain("dnigrowth.test");
    // Pending until the first code: the panel asks to finish enrolment.
    expect((await owner.get(`${A}/overview`)).json.code).toBe("platform_enrolment_required");
    expect((await owner.post("/api/v1/platform/mfa/confirm", { code: "000000" })).status).toBe(400);
    const conf = await owner.post("/api/v1/platform/mfa/confirm", { code: await totpNow(claim.json.secret) });
    expect(conf.status).toBe(200);
    expect(conf.json.recoveryCodes).toHaveLength(10);
    expect((await owner.get(`${A}/overview`)).status).toBe(200);
    // Burnt code.
    expect((await customer.post("/api/v1/platform/claim", { code: "AAAAA-BBBBB-CCCCC-DDDDD" })).status).toBe(400);
    // A second owner code cannot take over the platform.
    await insertClaimCode(h, "EEEEE-FFFFF-GGGGG-HHHHH");
    expect((await customer.post("/api/v1/platform/claim", { code: "EEEEE-FFFFF-GGGGG-HHHHH" })).json.code).toBe("owner_exists");

    // Legacy paths stop working once claimed: allowlisted e-mail and is_platform_admin get 404.
    h.env.PLATFORM_ADMIN_EMAILS = "cliente@luna.es";
    await h.db.prepare("UPDATE users SET is_platform_admin = 1 WHERE email = 'cliente@luna.es'").run();
    expect((await customer.get(`${A}/overview`)).status).toBe(404);
    expect((await customer.get("/api/v1/auth/me")).json.user.isPlatformAdmin).toBe(false);
    const audit = await h.db.prepare("SELECT COUNT(*) AS n FROM audit_logs WHERE action IN ('platform.claimed','platform.claim_failed','platform.mfa_enabled')").first<{ n: number }>();
    expect(audit!.n).toBeGreaterThanOrEqual(4);
  });

  it("each session must prove TOTP; codes cannot be replayed; recovery codes work once", async () => {
    const { h, owner } = await setup();
    const { secret, recoveryCodes } = await claimPlatformOwner(h, owner);
    await owner.post("/api/v1/platform/lock");
    expect((await owner.get(`${A}/overview`)).json.code).toBe("platform_mfa_required");
    // The code used at enrolment cannot be replayed.
    expect((await owner.post("/api/v1/platform/mfa/verify", { code: await totpNow(secret) })).status).toBe(400);
    expect((await owner.post("/api/v1/platform/mfa/verify", { code: await totpNow(secret, 1) })).status).toBe(200);
    expect((await owner.get(`${A}/overview`)).status).toBe(200);
    // Another session of the same account starts locked.
    const other = new h.Client();
    await other.post("/api/v1/auth/login", { email: "dueno@dnigrowth.test", password: "Sup3rSecretPass" });
    expect((await other.get(`${A}/overview`)).json.code).toBe("platform_mfa_required");
    expect((await other.post("/api/v1/platform/mfa/verify", { code: recoveryCodes[0] })).json).toMatchObject({ ok: true, viaRecovery: true });
    await other.post("/api/v1/platform/lock");
    expect((await other.post("/api/v1/platform/mfa/verify", { code: recoveryCodes[0] })).status).toBe(400);
  });

  it("critical actions need a fresh code (step-up, 15 min); legacy admins cannot do them at all", async () => {
    const { h, owner, orgId } = await setup();
    h.env.PLATFORM_ADMIN_EMAILS = "dueno@dnigrowth.test";
    expect((await owner.get(`${A}/overview`)).status).toBe(200); // legacy read access before the claim
    const legacy = await owner.post(`${A}/organizations/${orgId}/status`, { status: "suspended", reason: "Prueba legacy" });
    expect(legacy.json.code).toBe("platform_claim_required");
    await claimPlatformOwner(h, owner);
    await ageMfa(h, 20);
    expect((await owner.get(`${A}/organizations/${orgId}`)).status).toBe(200);
    expect((await owner.post(`${A}/organizations/${orgId}/status`, { status: "suspended", reason: "Prueba" })).json.code).toBe("step_up_required");
    expect((await owner.post(`${A}/organizations/${orgId}/plan`, { planCode: "pro", reason: "Prueba" })).json.code).toBe("step_up_required");
    await ageMfa(h, 13 * 60);
    expect((await owner.get(`${A}/overview`)).json.code).toBe("platform_mfa_required");
  });

  it("platform roles are least-privilege: an analyst reads but cannot suspend", async () => {
    const { h, owner, customer, orgId } = await setup();
    await claimPlatformOwner(h, owner);
    await insertClaimCode(h, "ANALY-STCOD-E0000-00000", "platform_analyst");
    const analyst = await h.signup("analista@dnigrowth.test");
    const claim = await analyst.post("/api/v1/platform/claim", { code: "ANALY-STCOD-E0000-00000" });
    expect(claim.json.role).toBe("platform_analyst");
    await analyst.post("/api/v1/platform/mfa/confirm", { code: await totpNow(claim.json.secret) });
    expect((await analyst.get(`${A}/overview`)).status).toBe(200);
    expect((await analyst.get(`${A}/ai/usage`)).status).toBe(200);
    expect((await analyst.post(`${A}/organizations/${orgId}/status`, { status: "suspended", reason: "No debería" })).status).toBe(403);
    expect((await analyst.post(`${A}/organizations/${orgId}/support`, { reason: "No debería" })).status).toBe(403);
    expect((await customer.get(`/api/v1/orgs/${orgId}`)).status).toBe(200);
  });
});

describe("organisations from the Control Center (always reversible)", () => {
  it("suspend → 423 for members, reactivate; delete needs the exact name → 410, restore within 30 days", async () => {
    const { h, owner, customer, orgId } = await setup();
    await claimPlatformOwner(h, owner);
    const det = await owner.get(`${A}/organizations/${orgId}`);
    expect(det.status).toBe(200);
    expect(det.json.members[0].email).not.toBe("cliente@luna.es"); // masked
    expect(det.json.members[0].email).toMatch(/\*/);

    expect((await owner.post(`${A}/organizations/${orgId}/status`, { status: "suspended", reason: "Impago de prueba" })).json).toMatchObject({ changed: true });
    const blocked = await customer.get(`/api/v1/orgs/${orgId}/dashboard`);
    expect(blocked.status).toBe(423);
    expect(JSON.stringify(blocked.json)).not.toContain("Impago");
    expect((await customer.get(`/api/v1/orgs/${orgId}`)).json.organization.status).toBe("suspended");
    await owner.post(`${A}/organizations/${orgId}/status`, { status: "active", reason: "Pago recibido" });
    expect((await customer.get(`/api/v1/orgs/${orgId}/dashboard`)).status).toBe(200);

    expect((await owner.post(`${A}/organizations/${orgId}/delete`, { confirmName: "Otra", reason: "Prueba" })).json.code).toBe("confirm_name_mismatch");
    const del = await owner.post(`${A}/organizations/${orgId}/delete`, { confirmName: "Panadería Luna", reason: "Pedido por la clienta" });
    expect(del.json.purgeAfter > new Date(Date.now() + 29 * 86400_000).toISOString()).toBe(true);
    expect((await customer.get(`/api/v1/orgs/${orgId}/dashboard`)).status).toBe(410);
    const me = (await customer.get("/api/v1/auth/me")).json;
    expect(JSON.stringify(me.memberships)).not.toContain(orgId);
    expect(me.deletedOrganizations).toHaveLength(1);
    expect((await owner.post(`${A}/organizations/${orgId}/restore`)).json).toEqual({ ok: true });
    expect((await customer.get(`/api/v1/orgs/${orgId}/dashboard`)).status).toBe(200);
    const actions = (await owner.get(`${A}/audit`)).json.items.map((i: { action: string }) => i.action);
    expect(actions).toEqual(expect.arrayContaining(["platform.org_suspend", "platform.org_reactivate", "platform.org_delete", "platform.org_restore"]));
  });

  it("the owner can rename, delete (typing the name) and restore her own organisation; others cannot", async () => {
    const { h, customer, orgId } = await setup();
    await h.db.prepare("UPDATE organizations SET plan_code = 'starter' WHERE id = ?").bind(orgId).run();
    await h.db.prepare("UPDATE plans SET limits_json = json_set(limits_json, '$.seats', 3) WHERE code = 'starter'").run();
    const editor = await h.invite(customer, orgId, "editor@luna.es", "editor");
    expect((await editor.req("DELETE", `/api/v1/orgs/${orgId}`, { confirmName: "Panadería Luna" })).status).toBe(403);
    expect((await customer.patch(`/api/v1/orgs/${orgId}`, { name: "Panadería Luna SL" })).json).toMatchObject({ ok: true });
    expect((await customer.req("DELETE", `/api/v1/orgs/${orgId}`, { confirmName: "Panadería Luna" })).status).toBe(400);
    expect((await customer.req("DELETE", `/api/v1/orgs/${orgId}`, { confirmName: "Panadería Luna SL" })).status).toBe(200);
    expect((await editor.get(`/api/v1/orgs/${orgId}/brands`)).status).toBe(410);
    expect((await editor.post(`/api/v1/orgs/${orgId}/restore`)).status).toBe(403);
    expect((await customer.post(`/api/v1/orgs/${orgId}/restore`)).status).toBe(200);
    expect((await editor.get(`/api/v1/orgs/${orgId}/brands`)).status).toBe(200);
  });

  it("support access is temporary, read-only, audited and never silent", async () => {
    const { h, owner, orgId } = await setup();
    await claimPlatformOwner(h, owner);
    expect((await owner.get(`/api/v1/orgs/${orgId}/brands`)).status).toBe(404); // no access without a grant
    const g = await owner.post(`${A}/organizations/${orgId}/support`, { reason: "Ticket de la clienta", hours: 1 });
    expect(g.status).toBe(200);
    expect((await owner.get(`/api/v1/orgs/${orgId}/brands`)).status).toBe(200);
    expect((await owner.post(`/api/v1/orgs/${orgId}/brands`, { name: "Intrusa", domain: "x.es" })).status).toBe(403);
    expect((await owner.get(`/api/v1/orgs/${orgId}`)).json.supportAccess).toBe(true);
    const row = await h.db.prepare("SELECT organization_id FROM audit_logs WHERE action = 'platform.support_access_start'").first<{ organization_id: string }>();
    expect(row!.organization_id).toBe(orgId);
    await owner.del(`${A}/support/${g.json.grantId}`);
    expect((await owner.get(`/api/v1/orgs/${orgId}/brands`)).status).toBe(404);
    // Expired grants are useless.
    const g2 = await owner.post(`${A}/organizations/${orgId}/support`, { reason: "Otra revisión", hours: 1 });
    await h.db.prepare("UPDATE support_access_grants SET expires_at = ? WHERE id = ?").bind(new Date(Date.now() - 1000).toISOString(), g2.json.grantId).run();
    expect((await owner.get(`/api/v1/orgs/${orgId}/brands`)).status).toBe(404);
  });

  it("per-organisation AI limits override the plan (and go back to it); usage reflects them", async () => {
    const { h, owner, customer, orgId } = await setup();
    await claimPlatformOwner(h, owner);
    expect((await owner.put(`${A}/organizations/${orgId}/limits`, { ai_daily: 3, reason: "Abuso detectado" })).json).toEqual({ ok: true });
    let u = (await customer.get(`/api/v1/orgs/${orgId}/usage`)).json.items.find((i: { key: string }) => i.key === "ai_org_day");
    expect(u).toMatchObject({ limit: 3, overridden: true, upgrade: null });
    await owner.put(`${A}/organizations/${orgId}/limits`, { ai_daily: null, reason: "Vuelve al plan" });
    u = (await customer.get(`/api/v1/orgs/${orgId}/usage`)).json.items.find((i: { key: string }) => i.key === "ai_org_day");
    expect(u).toMatchObject({ limit: 10, overridden: false });
    expect((await owner.put(`${A}/organizations/${orgId}/limits`, { ai_daily: -1, reason: "Negativo" })).status).toBe(422);
  });

  it("credit adjustments are idempotent, audited and never leave a negative balance", async () => {
    const { h, owner, customer, orgId } = await setup();
    await claimPlatformOwner(h, owner);
    const before = (await customer.get(`/api/v1/orgs/${orgId}/billing`)).json.balance as number;
    const body = { amount: 50, reason: "Compensación incidencia", idempotencyKey: "ticket-0001" };
    const a = await owner.post(`${A}/organizations/${orgId}/credits`, body);
    const b = await owner.post(`${A}/organizations/${orgId}/credits`, body);
    expect(a.json.balance).toBe(before + 50);
    expect(b.json).toMatchObject({ duplicate: true, balance: before + 50 });
    expect((await owner.post(`${A}/organizations/${orgId}/credits`, { amount: -(before + 51), reason: "Demasiado", idempotencyKey: "ticket-0002" })).json.code).toBe("balance_negative");
  });

  it("global AI stop is audited and visible in the AI centre; ops shows status only", async () => {
    const { h, owner } = await setup();
    await claimPlatformOwner(h, owner);
    expect((await owner.post(`${A}/ai/halt`, { halted: true, reason: "Mantenimiento" })).json).toEqual({ ok: true, halted: true });
    expect((await owner.get(`${A}/ai/usage`)).json.halt).toMatchObject({ reason: "Mantenimiento" });
    await owner.post(`${A}/ai/halt`, { halted: false, reason: "Fin mantenimiento" });
    expect((await owner.get(`${A}/ai/usage`)).json.halt).toBeNull();
    const ops = await owner.get(`${A}/ops`);
    expect(ops.json).toMatchObject({ measurement: "observed", database: { orgs: 1 } });
  });
});
