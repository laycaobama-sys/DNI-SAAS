import { describe, expect, it } from "vitest";
import { MODULE_MIN_PLAN, PLAN_ORDER, menuShowsModule, planIncludes } from "../src/plan-access";

const BASE = ["", "analyze", "advisor", "ai-hub", "audits", "brands", "search-console", "crm", "jobs", "integrations", "team", "billing", "audit-log"];
const visible = (plan: string, bypass = false) => [...BASE, ...Object.keys(MODULE_MIN_PLAN)].filter((m) => menuShowsModule(plan, m, bypass));

describe("menu by plan", () => {
  it("a free organisation sees only the base modules, never paid ones", () => {
    expect(visible("free").sort()).toEqual([...BASE].sort());
  });

  it("each paid plan shows exactly its modules and nothing from a higher plan", () => {
    for (const plan of PLAN_ORDER) {
      const shown = visible(plan);
      for (const [mod, min] of Object.entries(MODULE_MIN_PLAN)) {
        expect(shown.includes(mod), `${plan} → ${mod}`).toBe(PLAN_ORDER.indexOf(plan) >= PLAN_ORDER.indexOf(min));
        expect(shown.includes(mod)).toBe(planIncludes(plan, mod));
      }
    }
    expect(visible("starter")).toContain("content");
    expect(visible("starter")).not.toContain("creative");
    expect(visible("growth")).toContain("creative");
    expect(visible("growth")).not.toContain("ads");
    expect(visible("pro")).toContain("ads");
    expect(visible("pro")).not.toContain("agency");
    expect(visible("agency")).toContain("agency");
  });

  it("unknown or tampered plan codes fall back to free", () => {
    expect(visible("enterprise-hack").sort()).toEqual([...BASE].sort());
    expect(visible("").sort()).toEqual([...BASE].sort());
  });

  it("only the platform admin bypass shows everything", () => {
    expect(visible("free", true)).toHaveLength(BASE.length + Object.keys(MODULE_MIN_PLAN).length);
  });
});
