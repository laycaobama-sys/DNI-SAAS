import { describe, expect, it } from "vitest";
import { scrubAi, scrubText } from "../src/lib/scrub";

describe("«IA DNI Growth» response scrub", () => {
  it("removes AI providers, model ids and internal costs, keeps business fields", () => {
    const out = scrubAi({
      message: { content: "Hola", provider: "openrouter", model: "vendor/model-x:free", servedModel: "x", costUsd: 0, credits: 1 },
      attempts: ["workers_ai:fail"],
      job: { attempts: 2 },
      attribution: { model: "last_touch" },
      events: [{ message: "Respondido por @cf/google/gemma-4-26b-a4b-it vía Cloudflare Workers AI" }],
      audit: { after_redacted: JSON.stringify({ provider: "groq", model: "openai/gpt-oss-20b", note: "Gemini falló" }) },
    }) as any;
    expect(out.message).toEqual({ content: "Hola", provider: "dni_ai", credits: 1 });
    expect(out.attempts).toBeUndefined();
    expect(out.job.attempts).toBe(2);
    expect(out.attribution.model).toBe("last_touch");
    expect(out.events[0].message).toBe("Respondido por IA DNI Growth vía IA DNI Growth");
    expect(JSON.parse(out.audit.after_redacted)).toEqual({ provider: "dni_ai", note: "IA DNI Growth falló" });
    expect(JSON.stringify(out)).not.toMatch(/openrouter|groq|gemma|gemini|workers|gpt-oss|@cf/i);
  });

  it("collapses repeated brand mentions", () => {
    expect(scrubText("Gemini (gemini-3.8-flash)")).toBe("IA DNI Growth");
  });
});

describe("GEO keeps the measured engine but never its model id", () => {
  it("rewrites model ids only", async () => {
    const { scrubAi: s } = await import("../src/lib/scrub");
    const out = s({ engine: "Gemini (API)", note: "Basado en 1 respuesta observada (gemini-3.5-flash-lite, 2026-11-20).", model: "gemini-3.8-flash" }, "", { keepEngineNames: true }) as any;
    expect(out).toEqual({ engine: "Gemini (API)", note: "Basado en 1 respuesta observada (Gemini, 2026-11-20)." });
  });
});
