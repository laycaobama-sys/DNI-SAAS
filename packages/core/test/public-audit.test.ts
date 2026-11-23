import { describe, expect, it } from "vitest";
import { buildPublicAuditResult, PILLAR_CATEGORIES, pillarScores, RULES, scoreBand, teaserOf, type SeoIssue } from "../src";

const issue = (ruleKey: string, url: string | null = "https://a.es/", extra: Partial<SeoIssue> = {}): SeoIssue => ({
  ruleKey,
  severity: RULES[ruleKey]!.severity,
  category: RULES[ruleKey]!.category,
  url,
  evidence: {},
  ...extra,
});

describe("free audit scores", () => {
  it("every rule category belongs to exactly one pillar", () => {
    const cats = Object.values(PILLAR_CATEGORIES).flat();
    expect(new Set(cats).size).toBe(cats.length);
    for (const r of Object.values(RULES)) expect(cats).toContain(r.category);
  });

  it("is 100 everywhere with no issues and never leaves 0–100", () => {
    expect(pillarScores([])).toEqual({ technical: 100, seo: 100, geo: 100 });
    const everything = Object.keys(RULES).map((k) => issue(k));
    for (const v of Object.values(pillarScores(everything))) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(100);
    }
  });

  it("counts each rule once, ignores legal pages and content-volume findings", () => {
    const one = pillarScores([issue("title_missing")]);
    expect(pillarScores([issue("title_missing"), issue("title_missing", "https://a.es/b")])).toEqual(one);
    expect(one.seo).toBeLessThan(100);
    expect(one.technical).toBe(100);
    expect(pillarScores([issue("title_missing", "https://a.es/legal", { pageType: "legal" })]).seo).toBe(100);
    expect(pillarScores([issue("site_sparse", null)])).toEqual({ technical: 100, seo: 100, geo: 100 });
  });

  it("the teaser shows three findings with evidence and counts the rest", () => {
    const issues = [issue("https_missing", null), issue("title_missing"), issue("meta_description_missing"), issue("h1_missing"), issue("lang_missing")].filter((i) => RULES[i.ruleKey]);
    const r = buildPublicAuditResult(issues, { origin: "https://a.es", pagesAnalyzed: 3, observedAt: "2026-11-24T10:00:00.000Z" });
    expect(r.measurement).toBe("derived");
    expect(r.method).toMatch(/no predicen posiciones/);
    const t = teaserOf(r);
    expect(t.top).toHaveLength(3);
    expect(t.othersCount).toBe(r.findings.length - 3);
    expect(t.top.every((f) => f.evidence.length > 0 && f.fix.length > 0)).toBe(true);
    expect("findings" in t).toBe(false);
  });

  it("bands are words next to the number", () => {
    expect([scoreBand(95), scoreBand(80), scoreBand(79), scoreBand(50), scoreBand(49)]).toEqual(["bien", "bien", "mejorable", "mejorable", "urgente"]);
  });
});
