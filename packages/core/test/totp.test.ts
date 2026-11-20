import { describe, expect, it } from "vitest";
import { base32Decode, base32Encode, hotp, newTotpSecret, otpauthUri, totpStep, verifyTotp } from "../src/totp";
import { aiImagesDailyLimit, aiUserDailyLimit, nextPlan, planThatRaises, usageLevel, AI_DAILY_REQUESTS } from "../src/plan-access";

// RFC 6238 appendix B (SHA1 seed "12345678901234567890").
const SEED = new TextEncoder().encode("12345678901234567890");
const SEED_B32 = base32Encode(SEED);

describe("TOTP", () => {
  it("base32 round-trips", () => {
    expect(SEED_B32).toBe("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ");
    expect([...base32Decode(SEED_B32)]).toEqual([...SEED]);
    expect(newTotpSecret()).toMatch(/^[A-Z2-7]{32}$/);
  });
  it("matches the RFC 6238 vectors", async () => {
    expect(await hotp(SEED, totpStep(59_000), 8)).toBe("94287082");
    expect(await hotp(SEED, totpStep(1111111109_000), 8)).toBe("07081804");
    expect(await hotp(SEED, totpStep(2000000000_000), 8)).toBe("69279037");
  });
  it("accepts ±1 step, rejects replays, wrong and malformed codes", async () => {
    const t = 1_700_000_000_000;
    const code = await hotp(SEED, totpStep(t));
    const step = await verifyTotp(SEED_B32, code, t);
    expect(step).toBe(totpStep(t));
    expect(await verifyTotp(SEED_B32, code, t + 30_000)).toBe(totpStep(t)); // drift
    expect(await verifyTotp(SEED_B32, code, t, step)).toBeNull(); // replay
    expect(await verifyTotp(SEED_B32, code, t + 120_000)).toBeNull(); // too old
    expect(await verifyTotp(SEED_B32, "12345", t)).toBeNull();
    expect(await verifyTotp(SEED_B32, "abcdef", t)).toBeNull();
  });
  it("otpauth URI carries no e-mail", () => {
    expect(otpauthUri("ABC")).toBe("otpauth://totp/DNI%20Growth%3APropietario?secret=ABC&issuer=DNI%20Growth&algorithm=SHA1&digits=6&period=30");
  });
});

describe("plan quotas", () => {
  it("per-user caps never exceed the organisation cap and grow with the plan", () => {
    for (const p of ["free", "starter", "growth", "pro", "agency"] as const) expect(aiUserDailyLimit(p)).toBeLessThanOrEqual(AI_DAILY_REQUESTS[p]);
    expect(aiUserDailyLimit("tampered")).toBe(10);
    expect(aiImagesDailyLimit("starter")).toBe(0);
    expect(aiImagesDailyLimit("growth")).toBeGreaterThan(0);
  });
  it("suggests the cheapest plan that actually raises a limit", () => {
    expect(nextPlan("free")).toBe("starter");
    expect(nextPlan("agency")).toBeNull();
    expect(planThatRaises("starter", aiImagesDailyLimit)).toBe("growth");
    expect(planThatRaises("agency", aiImagesDailyLimit)).toBeNull();
  });
  it("usage levels at 75/90/100 %", () => {
    expect(usageLevel(7, 10)).toBe("ok");
    expect(usageLevel(8, 10)).toBe("warning");
    expect(usageLevel(9, 10)).toBe("critical");
    expect(usageLevel(10, 10)).toBe("exhausted");
    expect(usageLevel(0, 0)).toBe("exhausted");
  });
});
