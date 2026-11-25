import { describe, expect, it } from "vitest";
import { annualSaving, CANCEL_REASONS, evaluateGuarantee, PLAN_OFFERS, PRICING_ROWS, periodAmountCents, COMING_SOON, type GuaranteeInput } from "../src/pricing";
import { FEATURES } from "../src/features";
import { PLAN_PITCH } from "../src/plan-access";

describe("commercial catalogue", () => {
  it("annual prices are about two months free and add up exactly", () => {
    for (const o of PLAN_OFFERS.filter((p) => p.monthly > 0)) {
      expect(o.yearly).toBe(o.yearlyPerMonth * 12);
      // 2 months free = 10 × monthly; the published monthly equivalent is rounded down to whole euros.
      expect(Math.abs(o.yearly - o.monthly * 10)).toBeLessThan(12);
      expect(annualSaving(o)).toBeGreaterThan(o.monthly * 1.9);
    }
    expect(periodAmountCents("growth", "month")).toBe(12900);
    expect(periodAmountCents("growth", "year")).toBe(129600);
    expect(() => periodAmountCents("enterprise", "month")).toThrow();
  });

  it("only Growth has the free trial and exactly one plan is highlighted", () => {
    expect(PLAN_OFFERS.filter((p) => p.trialDays > 0).map((p) => p.code)).toEqual(["growth"]);
    expect(PLAN_OFFERS.filter((p) => p.highlight).map((p) => p.code)).toEqual(["growth"]);
  });

  it("every comparison row has a value per plan and a non-available row explains itself or is marked as building", () => {
    for (const r of PRICING_ROWS) {
      expect(Object.keys(r.values).sort()).toEqual(["agency", "free", "growth", "pro", "starter"]);
      if (r.status === "partial") expect(r.note).toBeTruthy();
    }
  });

  it("the pricing table never sells as available something the module registry says is not built", () => {
    const building = FEATURES.filter((f) => f.status === "building").map((f) => f.label.toLowerCase());
    for (const r of PRICING_ROWS.filter((x) => x.status === "available")) for (const b of building) expect(r.label.toLowerCase()).not.toContain(b);
    // Rows that depend on unbuilt integrations are not marked available.
    expect(PRICING_ROWS.find((r) => r.label.startsWith("Publicación en tu blog"))!.status).not.toBe("available");
    expect(PRICING_ROWS.find((r) => r.label.startsWith("Correcciones técnicas automáticas"))!.status).toBe("building");
  });

  it("a feature still in development is never sold with a tick in any plan (only «Próximamente»)", () => {
    for (const r of PRICING_ROWS.filter((x) => x.status === "building"))
      for (const [plan, v] of Object.entries(r.values)) {
        expect(v, `${r.label} · ${plan}`).not.toContain("✓");
        expect([COMING_SOON, "—"]).toContain(v);
      }
    // And no paid-plan pitch promises a feature that is still being built.
    const buildingWords = ["wordpress", "shopify", "publicación automática", "correcciones automáticas", "correcciones técnicas automáticas"];
    for (const pitch of Object.values(PLAN_PITCH)) for (const w of buildingWords) expect(pitch.toLowerCase()).not.toContain(w);
  });

  it("each cancellation reason maps to a valid Stripe feedback value and at most one offer", () => {
    const stripe = ["too_expensive", "missing_features", "switched_service", "unused", "customer_service", "too_complex", "low_quality", "other"];
    for (const r of CANCEL_REASONS) {
      expect(stripe).toContain(r.stripeFeedback);
      expect(["discount", "pause", "downgrade", "none"]).toContain(r.offer);
    }
  });
});

describe("90-day guarantee evaluation", () => {
  const DAY = 86_400_000;
  const start = Date.parse("2026-06-01T10:00:00Z");
  const base: GuaranteeInput = {
    planCode: "growth",
    subscribedSince: new Date(start).toISOString(),
    canceled: false,
    now: new Date(start + 95 * DAY).toISOString(),
    gscConnectedAt: new Date(start - 3 * DAY).toISOString(),
    articlesProposed: 10,
    articlesApproved: 8,
    criticalOpen: 0,
    baselineImpressions: 1000,
    currentImpressions: 1000,
  };

  it("refund only when every requirement is met and impressions did not grow", () => {
    expect(evaluateGuarantee(base).status).toBe("refund_available");
    expect(evaluateGuarantee({ ...base, currentImpressions: 1001 }).status).toBe("growth_achieved");
    expect(evaluateGuarantee({ ...base, currentImpressions: 900 }).changePct).toBe(-10);
  });

  it("before day 90 it reports progress, never a refund", () => {
    const r = evaluateGuarantee({ ...base, now: new Date(start + 40 * DAY).toISOString(), currentImpressions: 0 });
    expect(r.status).toBe("in_progress");
    expect(r.day).toBe(40);
    expect(r.daysLeft).toBe(50);
  });

  it("each missing requirement blocks the refund with a plain explanation", () => {
    const cases: Array<[Partial<GuaranteeInput>, string]> = [
      [{ gscConnectedAt: null }, "gsc"],
      [{ gscConnectedAt: new Date(start + 5 * DAY).toISOString() }, "gsc"],
      [{ articlesApproved: 7 }, "articles"],
      [{ articlesProposed: 0, articlesApproved: 0 }, "articles"],
      [{ criticalOpen: 2 }, "technical"],
      [{ canceled: true }, "days"],
      [{ interrupted: true }, "days"],
    ];
    for (const [patch, key] of cases) {
      const r = evaluateGuarantee({ ...base, ...patch });
      expect(r.status).toBe("requirements_missing");
      expect(r.requirements.find((q) => q.key === key)!.met).toBe(false);
    }
  });

  it("plans outside the guarantee and missing data never produce a refund", () => {
    expect(evaluateGuarantee({ ...base, planCode: "starter" }).status).toBe("not_applicable");
    expect(evaluateGuarantee({ ...base, subscribedSince: null }).status).toBe("not_applicable");
    expect(evaluateGuarantee({ ...base, baselineImpressions: null }).status).toBe("data_missing");
  });
});
