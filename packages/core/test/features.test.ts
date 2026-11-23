import { describe, expect, it } from "vitest";
import { buildLlmsTxt, FEATURE_STATUS_LABEL, FEATURES, featureForMenu, menuStatusBadge, NOT_YET_AVAILABLE } from "../src/features";

/** FEATURES is the single source for the site badges, llms.txt and the app menu (Fase 0.1). */
describe("FEATURES registry", () => {
  it("is internally consistent: unique keys, a limit exactly when partial, each menu module owned once", () => {
    const keys = FEATURES.map((f) => f.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const f of FEATURES) {
      expect(f.summary.length).toBeGreaterThan(20);
      if (f.status === "partial") expect(f.limit, `${f.key} is partial and must name its limit`).toBeTruthy();
      if (f.status === "available") expect(f.limit, `${f.key} is available and cannot carry a limit`).toBeUndefined();
    }
    const menu = FEATURES.flatMap((f) => f.menu);
    expect(new Set(menu).size).toBe(menu.length);
  });

  it("gives the menu a badge only for modules that are not fully available", () => {
    expect(menuStatusBadge("ads")).toEqual({ label: "Parcial", title: FEATURES.find((f) => f.key === "ads")!.limit });
    expect(menuStatusBadge("jobs")?.label).toBe("Parcial");
    expect(menuStatusBadge("analyze")).toBeNull();
    expect(menuStatusBadge("no-such-module")).toBeNull();
    expect(featureForMenu("creative")?.key).toBe("video");
  });
});

describe("llms.txt generated from FEATURES", () => {
  const txt = buildLlmsTxt("https://dnigrowth.com/");

  it("lists every module with the same status label and limit as the registry", () => {
    for (const f of FEATURES) {
      const heading = `### ${f.label} — ${FEATURE_STATUS_LABEL[f.status]}`;
      expect(txt.split("\n").filter((l) => l === heading), heading).toHaveLength(1);
      if (f.limit) expect(txt).toContain(`- Límite: ${f.limit}`);
      for (const d of f.details ?? []) expect(txt).toContain(`- ${d}`);
    }
    // No module heading claims a status the registry does not give it.
    const headings = txt.split("\n").filter((l) => l.startsWith("### "));
    expect(headings).toHaveLength(FEATURES.length);
  });

  it("names what is not available yet and links the public pages without a trailing double slash", () => {
    const section = txt.split("## En desarrollo (no disponible todavía)")[1]!.split("## ")[0]!;
    for (const n of NOT_YET_AVAILABLE) expect(section).toContain(`- ${n}`);
    for (const f of FEATURES.filter((x) => x.status === "building")) expect(section).toContain(f.label);
    expect(txt).toContain("[Seguridad y confianza](https://dnigrowth.com/seguridad)");
    expect(txt).not.toContain("dnigrowth.com//");
    // The brand family belongs to the «Seguridad» page, never to llms.txt or a footer.
    expect(txt).not.toMatch(/DNI GYM|DNI DIRECTO|familia de marcas/);
  });
});
