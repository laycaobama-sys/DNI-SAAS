import { describe, expect, it } from "vitest";
import { abTest, LANDING_SLUG, LandingContent, landingTemplate } from "../src/landing";

describe("abTest", () => {
  it("refuses to conclude with a small sample", () => {
    const r = abTest({ views: 50, conversions: 5 }, { views: 50, conversions: 15 });
    expect(r.verdict).toBe("insufficient_data");
    expect(r.warnings[0]).toMatch(/Muestra insuficiente/);
  });
  it("detects a clear winner with enough data (two-sided p < 0.05)", () => {
    const r = abTest({ views: 1000, conversions: 50 }, { views: 1000, conversions: 90 });
    expect(r.verdict).toBe("b_better");
    expect(r.pValue).toBeLessThan(0.01);
    expect(r.relativeLift).toBeCloseTo(0.8, 3);
    expect(abTest({ views: 1000, conversions: 90 }, { views: 1000, conversions: 50 }).verdict).toBe("a_better");
  });
  it("reports no significant difference for similar rates", () => {
    const r = abTest({ views: 500, conversions: 25 }, { views: 500, conversions: 28 });
    expect(r.verdict).toBe("no_significant_difference");
    expect(r.pValue).toBeGreaterThan(0.05);
  });
  it("handles zero views without dividing by zero", () => {
    const r = abTest({ views: 0, conversions: 0 }, { views: 0, conversions: 0 });
    expect(r).toMatchObject({ pValue: null, relativeLift: null, verdict: "insufficient_data" });
  });
});

describe("LandingContent", () => {
  it("the template is valid and invisible/control characters are stripped", () => {
    const t = landingTemplate("Panadería Luna");
    expect(LandingContent.parse(t).blocks).toHaveLength(3);
    const c = LandingContent.parse({ ...t, seo: { title: "Hola\u202e\u0007 mundo", description: "" } });
    expect(c.seo.title).toBe("Hola mundo");
  });
  it("only https images and https or #formulario links", () => {
    const t = landingTemplate("X");
    expect(LandingContent.safeParse({ ...t, blocks: [{ type: "cta", heading: "Hola", ctaLabel: "Ir", ctaHref: "javascript:alert(1)" }] }).success).toBe(false);
    expect(LandingContent.safeParse({ ...t, blocks: [{ type: "hero", heading: "Hola", imageUrl: "http://x.es/a.png" }] }).success).toBe(false);
    expect(LandingContent.safeParse({ ...t, blocks: [{ type: "cta", heading: "Hola", ctaLabel: "Ir", ctaHref: "https://x.es" }] }).success).toBe(true);
  });
  it("slug rules", () => {
    expect(LANDING_SLUG.safeParse("oferta-navidad-2026").success).toBe(true);
    expect(LANDING_SLUG.safeParse("Oferta Navidad").success).toBe(false);
    expect(LANDING_SLUG.safeParse("-mal").success).toBe(false);
  });
});
