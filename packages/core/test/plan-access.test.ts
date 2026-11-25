import { describe, expect, it } from "vitest";
import { MODULE_MIN_PLAN, PLAN_ORDER, menuShowsModule, planIncludes } from "../src/plan-access";
import { PRICING_ROWS } from "../src/pricing";

const BASE = ["", "analyze", "advisor", "ai-hub", "audits", "brands", "search-console", "content", "crm", "jobs", "integrations", "team", "billing", "audit-log"];
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
    expect(visible("free")).toContain("content");
    expect(visible("starter")).toContain("analytics");
    expect(visible("free")).not.toContain("analytics");
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

describe("what /precios sells is what each plan opens", () => {
  /** Published rows that depend on an app module (rows not listed here are not tied to one module). */
  const ROW_MODULE: Record<string, string> = {
    "Borradores de artículos al mes (revisión humana)": "content",
    "Google Search Console (solo lectura)": "search-console",
    "Google Analytics 4 (solo lectura)": "analytics",
    "Visibilidad en IA (prompts en seguimiento)": "ai-visibility",
    "Oportunidades de autoridad y enlaces seguros": "authority",
    "Vídeos y piezas sociales": "video",
    "Publicación en tu blog o CMS": "cms",
    "Publicación programada en Facebook e Instagram (con aprobación)": "social",
    "CRM y atribución de clic a venta": "attribution",
    "Informe mensual": "reports",
    "Portal de cliente con marca blanca": "agency",
  };

  it("a plan that shows a value for a row opens its module, and a «—» keeps it closed", () => {
    for (const [label, module] of Object.entries(ROW_MODULE)) {
      const row = PRICING_ROWS.find((r) => r.label === label);
      expect(row, `fila «${label}» no encontrada en PRICING_ROWS`).toBeDefined();
      for (const plan of PLAN_ORDER) expect(planIncludes(plan, module), `${plan} · ${label} = «${row!.values[plan]}»`).toBe(row!.values[plan] !== "—");
    }
  });

  it("every paid plan opens at least the modules of the plan below (nobody pays more for less)", () => {
    for (const m of Object.keys(MODULE_MIN_PLAN)) for (let i = 1; i < PLAN_ORDER.length; i++) if (planIncludes(PLAN_ORDER[i - 1]!, m)) expect(planIncludes(PLAN_ORDER[i]!, m)).toBe(true);
  });
});
