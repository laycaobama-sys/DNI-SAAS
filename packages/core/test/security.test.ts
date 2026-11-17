import { describe, expect, it } from "vitest";
import { can, canAssignRole, ROLES, type Role } from "../src/rbac";
import { hashPassword, hmacSha256Hex, verifyPassword, verifyStripeSignature } from "../src/crypto";
import { redact } from "../src/redact";

describe("RBAC", () => {
  it("never lets a client viewer spend, publish, invite or manage billing", () => {
    for (const s of ["ads:publish", "ads:approve", "content:publish", "members:invite", "billing:manage", "site:analyze", "brand:write"] as const) {
      expect(can("client_viewer", s)).toBe(false);
    }
  });
  it("only owners/admins/ads_approvers can approve ads; publishers cannot approve", () => {
    const approvers = ROLES.filter((r) => can(r, "ads:approve"));
    expect(approvers.sort()).toEqual(["admin", "ads_approver", "owner"]);
    expect(can("ads_publisher", "ads:approve")).toBe(false);
  });
  it("billing:manage is owner + billing_admin only", () => {
    expect(ROLES.filter((r) => can(r, "billing:manage")).sort()).toEqual(["billing_admin", "owner"]);
  });
  it("prevents privilege escalation on role assignment", () => {
    expect(canAssignRole("admin", "owner")).toBe(false);
    expect(canAssignRole("admin", "admin")).toBe(false);
    expect(canAssignRole("admin", "editor")).toBe(true);
    expect(canAssignRole("editor", "client_viewer")).toBe(false);
    expect(canAssignRole("owner", "owner")).toBe(true);
    const all: Role[] = [...ROLES];
    expect(all.filter((r) => canAssignRole("client_viewer", r))).toEqual([]);
  });
});

describe("password hashing", () => {
  it("verifies correct passwords and rejects wrong/tampered ones", async () => {
    const h = await hashPassword("CorrectHorse123", 20_000);
    expect(h.startsWith("pbkdf2$sha256$20000$")).toBe(true);
    expect(await verifyPassword("CorrectHorse123", h)).toBe(true);
    expect(await verifyPassword("WrongHorse123", h)).toBe(false);
    expect(await verifyPassword("CorrectHorse123", h.replace("20000", "999999"))).toBe(false);
    expect(await verifyPassword("x", "garbage")).toBe(false);
  });
});

describe("Stripe signature", () => {
  const secret = "whsec_test_fixture";
  const body = JSON.stringify({ id: "evt_1", type: "checkout.session.completed" });
  it("accepts a valid signature", async () => {
    const t = 1_800_000_000;
    const sig = await hmacSha256Hex(secret, `${t}.${body}`);
    expect(await verifyStripeSignature(body, `t=${t},v1=${sig}`, secret, t)).toEqual({ ok: true, timestamp: t });
  });
  it("rejects tampered body, wrong secret, replay and malformed headers", async () => {
    const t = 1_800_000_000;
    const sig = await hmacSha256Hex(secret, `${t}.${body}`);
    expect((await verifyStripeSignature(body + " ", `t=${t},v1=${sig}`, secret, t)).ok).toBe(false);
    expect((await verifyStripeSignature(body, `t=${t},v1=${sig}`, "whsec_other", t)).ok).toBe(false);
    expect(await verifyStripeSignature(body, `t=${t},v1=${sig}`, secret, t + 3600)).toEqual({ ok: false, reason: "timestamp_out_of_tolerance" });
    expect(await verifyStripeSignature(body, `garbage`, secret, t)).toEqual({ ok: false, reason: "malformed_header" });
    expect(await verifyStripeSignature(body, null, secret, t)).toEqual({ ok: false, reason: "missing_header" });
  });
});

describe("redaction", () => {
  it("removes secrets, tokens and masks emails", () => {
    const r = redact({ password: "x", nested: { apiKey: "y", note: "Bearer abc.def.ghi from ana.perez@empresa.com key " + ["sk", "live", "1234567890abcdef"].join("_") } });
    expect(r.password).toBe("[REDACTED]");
    expect(r.nested.apiKey).toBe("[REDACTED]");
    expect(r.nested.note).not.toContain("abc.def");
    expect(r.nested.note).not.toContain("ana.perez");
    expect(r.nested.note).toContain("a***@empresa.com");
    expect(r.nested.note).toContain("[REDACTED_SECRET]");
  });
});
