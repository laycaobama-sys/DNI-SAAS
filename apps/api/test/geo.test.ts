import { describe, expect, it } from "vitest";
import { normalizeQuestion, suggestGeoPrompts } from "@dni/core";
import { placeFromAddress, sectorFromTypes } from "../src/routes/geo";
import { createHarness } from "./helpers";

async function setup() {
  const h = createHarness();
  const alice = await h.signup("alice@a.es", "Alice");
  const orgA = await h.createOrg(alice, "Org A", "starter");
  const b = await alice.post(`/api/v1/orgs/${orgA}/brands`, { name: "Tienda A", domain: "tienda-a.es" });
  expect(b.status).toBe(201);
  const brandA = b.json.id as string;
  const base = `/api/v1/orgs/${orgA}/brands/${brandA}/geo`;
  return { h, alice, orgA, brandA, base };
}
const body = (over: Record<string, unknown> = {}) => ({
  questions: ["¿Cuál es la mejor tienda de zapatillas de running?"],
  intent: "comparative",
  category: "product",
  engines: ["gemini_api"],
  locale: "es-ES",
  regionCountry: "ES",
  ...over,
});
const RLO = String.fromCharCode(0x202e);
const NUL = String.fromCharCode(0);

describe("GEO prompt library", () => {
  it("creates question × engine rows, reports no sampling and audits the change", async () => {
    const { h, alice, base } = await setup();
    const r = await alice.post(`${base}/prompts`, body({ questions: ["¿Qué es Tienda A?", "Mejores zapatillas trail en Madrid"], engines: ["gemini_api", "perplexity_api", "google_ai_overviews"], regionDetail: "Madrid" }));
    expect(r.status).toBe(201);
    expect(r.json.created).toBe(6);
    const list = await alice.get(`${base}/prompts`);
    expect(list.status).toBe(200);
    expect(list.json.items).toHaveLength(6);
    expect(list.json.usage).toMatchObject({ used: 6, limit: 50, plan: "starter" });
    expect(list.json.sampling.active).toBe(false);
    expect(list.json.engines.find((e: { key: string }) => e.key === "google_ai_overviews").status).toBe("no_official_api");
    expect(list.json.items[0]).toMatchObject({ locale: "es-ES", regionCountry: "ES", regionDetail: "Madrid", enabled: true, source: "manual", createdByName: "Alice" });
    const audit = await h.db.prepare("SELECT after_redacted FROM audit_logs WHERE action = 'geo.prompts_create'").first<{ after_redacted: string }>();
    expect(JSON.parse(audit!.after_redacted)).toMatchObject({ created: 6, questions: 2 });
  });

  it("skips duplicates (case, accents, punctuation) and in-request repeats", async () => {
    const { alice, base } = await setup();
    expect((await alice.post(`${base}/prompts`, body())).json.created).toBe(1);
    const r = await alice.post(`${base}/prompts`, body({ questions: ["cual es la MEJOR tienda de zapatillas de running", "¿Cuál es la mejor tienda de zapatillas de running?!"] }));
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({ created: 0, duplicates: 1 });
    // Same question for another country is a different row.
    expect((await alice.post(`${base}/prompts`, body({ regionCountry: "MX", locale: "es-MX" }))).json.created).toBe(1);
  });

  it("validates engine, locale, country and strips control/bidi characters", async () => {
    const { alice, base } = await setup();
    for (const bad of [{ engines: ["bing_scraper"] }, { locale: "spanish" }, { regionCountry: "es" }, { questions: ["corta"] }, { questions: [] }, { intent: "spam" }]) {
      const r = await alice.post(`${base}/prompts`, body(bad));
      expect(r.status, JSON.stringify(bad)).toBe(422);
    }
    const r = await alice.post(`${base}/prompts`, body({ questions: [`¿Mejor${RLO} tienda${NUL} de   zapatillas?`] }));
    expect(r.status).toBe(201);
    const item = (await alice.get(`${base}/prompts`)).json.items[0];
    expect(item.question).toBe("¿Mejor tienda de zapatillas?");
  });

  it("enforces the plan limit and frees capacity when archiving", async () => {
    const { alice, base } = await setup();
    // Starter: 50 tracked prompts (question × engine).
    const many = Array.from({ length: 26 }, (_, i) => `Pregunta de prueba número ${i + 1} sobre zapatillas`);
    expect((await alice.post(`${base}/prompts`, body({ questions: many.slice(0, 13), engines: ["gemini_api", "openai_api"] }))).json.created).toBe(26);
    expect((await alice.post(`${base}/prompts`, body({ questions: many.slice(13, 25), engines: ["gemini_api", "openai_api"] }))).json.created).toBe(24);
    const over = await alice.post(`${base}/prompts`, body({ questions: [many[25]] }));
    expect(over.status).toBe(402);
    expect(over.json).toMatchObject({ code: "plan_limit", used: 50, limit: 50, requested: 1 });
    const id = (await alice.get(`${base}/prompts`)).json.items[0].id;
    expect((await alice.del(`${base}/prompts/${id}`)).status).toBe(200);
    expect((await alice.post(`${base}/prompts`, body({ questions: [many[25]] }))).json.created).toBe(1);
    // Library is full again: restoring the archived row must respect the limit.
    expect((await alice.post(`${base}/prompts/${id}/restore`)).status).toBe(402);
    const archived = (await alice.get(`${base}/prompts?archived=1`)).json.items;
    expect(archived.map((x: { id: string }) => x.id)).toEqual([id]);
  });

  it("the in-transaction guard stops concurrent requests from exceeding the limit", async () => {
    const { alice, base } = await setup();
    const reqs = Array.from({ length: 4 }, (_, k) => alice.post(`${base}/prompts`, body({ questions: Array.from({ length: 8 }, (_, i) => `Pregunta concurrente ${k}-${i} sobre zapatillas`), engines: ["gemini_api", "openai_api"] })));
    await Promise.all(reqs);
    expect((await alice.get(`${base}/prompts`)).json.usage.used).toBeLessThanOrEqual(50);
  });

  it("restore refuses when an equal active prompt exists; edit detects duplicates", async () => {
    const { alice, base } = await setup();
    await alice.post(`${base}/prompts`, body({ questions: ["¿Dónde comprar zapatillas de running?", "¿Qué zapatillas de trail recomiendan?"] }));
    const items = (await alice.get(`${base}/prompts`)).json.items as Array<{ id: string; question: string }>;
    const a = items.find((i) => i.question.startsWith("¿Dónde"))!;
    const b = items.find((i) => i.question.startsWith("¿Qué"))!;
    expect((await alice.patch(`${base}/prompts/${b.id}`, { question: "donde comprar zapatillas de running" })).status).toBe(409);
    expect((await alice.patch(`${base}/prompts/${b.id}`, { enabled: false, intent: "educational" })).json.changed.sort()).toEqual(["enabled", "intent"]);
    expect((await alice.patch(`${base}/prompts/${b.id}`, {})).status).toBe(422);
    await alice.del(`${base}/prompts/${a.id}`);
    expect((await alice.patch(`${base}/prompts/${a.id}`, { enabled: true })).json.code).toBe("prompt_archived");
    await alice.post(`${base}/prompts`, body({ questions: ["¿Dónde comprar zapatillas de running?"] }));
    expect((await alice.post(`${base}/prompts/${a.id}/restore`)).status).toBe(409);
  });

  it("client viewers and analysts can read and export but not write; editors can write", async () => {
    const { h, alice, orgA, base } = await setup();
    // Test data: the free plan has a single seat, so this org is moved to a multi-seat plan.
    await h.db.prepare("UPDATE organizations SET plan_code = 'pro' WHERE id = ?").bind(orgA).run();
    await alice.post(`${base}/prompts`, body());
    const id = (await alice.get(`${base}/prompts`)).json.items[0].id;
    for (const role of ["client_viewer", "analyst"]) {
      const m = await h.invite(alice, orgA, `${role}@a.es`, role);
      expect((await m.get(`${base}/prompts`)).status).toBe(200);
      expect((await m.get(`${base}/prompts/export`)).status).toBe(200);
      expect((await m.post(`${base}/prompts`, body({ questions: ["Otra pregunta distinta de prueba"] }))).status).toBe(403);
      expect((await m.patch(`${base}/prompts/${id}`, { enabled: false })).status).toBe(403);
      expect((await m.del(`${base}/prompts/${id}`)).status).toBe(403);
      expect((await m.post(`${base}/prompts/${id}/restore`)).status).toBe(403);
    }
    const editor = await h.invite(alice, orgA, "editor@a.es", "editor");
    expect((await editor.post(`${base}/prompts`, body({ questions: ["Pregunta del editor sobre zapatillas"] }))).status).toBe(201);
  });

  it("is isolated per tenant (404 through any path)", async () => {
    const { h, alice, orgA, brandA, base } = await setup();
    await alice.post(`${base}/prompts`, body());
    const id = (await alice.get(`${base}/prompts`)).json.items[0].id;
    const bob = await h.signup("bob@b.es", "Bob");
    const orgB = await h.createOrg(bob, "Org B", "starter");
    const viaB = `/api/v1/orgs/${orgB}/brands/${brandA}/geo`;
    expect((await bob.get(`${base}/prompts`)).status).toBe(404);
    expect((await bob.get(`${viaB}/prompts`)).status).toBe(404);
    expect((await bob.post(`${viaB}/prompts`, body())).status).toBe(404);
    expect((await bob.patch(`${viaB}/prompts/${id}`, { enabled: false })).status).toBe(404);
    expect((await bob.del(`${viaB}/prompts/${id}`)).status).toBe(404);
    expect((await bob.get(`${viaB}/prompts/export`)).status).toBe(404);
    expect((await bob.post(`${viaB}/suggestions`, {})).status).toBe(404);
    // A prompt id of Org A under a brand of Org B is also not found.
    const bb = (await bob.post(`/api/v1/orgs/${orgB}/brands`, { name: "Marca B" })).json.id;
    expect((await bob.patch(`/api/v1/orgs/${orgB}/brands/${bb}/geo/prompts/${id}`, { enabled: false })).status).toBe(404);
    expect((await bob.post(`/api/v1/orgs/${orgB}/brands/${bb}/geo/prompts/${id}/restore`)).status).toBe(404);
    const row = await h.db.prepare("SELECT enabled, organization_id FROM tracked_prompts WHERE id = ?").bind(id).first<{ enabled: number; organization_id: string }>();
    expect(row).toEqual({ enabled: 1, organization_id: orgA });
  });

  it("exports CSV with a formula-injection guard and JSON without answers", async () => {
    const { alice, base } = await setup();
    await alice.post(`${base}/prompts`, body({ questions: ['=HYPERLINK("http://x") mejores zapatillas'] }));
    const csv = await alice.get(`${base}/prompts/export`);
    expect(csv.headers.get("content-type")).toContain("text/csv");
    expect(csv.headers.get("content-disposition")).toMatch(/geo-prompts-tienda-a\.es-\d{4}-\d{2}-\d{2}\.csv/);
    expect(csv.json).toContain(`"'=HYPERLINK(""http://x"") mejores zapatillas"`);
    const json = await alice.get(`${base}/prompts/export?format=json`);
    expect(json.json.measurement).toMatch(/none/);
    expect(json.json.items).toHaveLength(1);
  });

  it("suggests from the brand profile only, reports what is missing and stores nothing", async () => {
    const { h, alice, orgA, brandA, base } = await setup();
    const empty = await alice.post(`${base}/suggestions`, {});
    expect(empty.status).toBe(200);
    expect(empty.json.profile.exists).toBe(false);
    expect(empty.json.missing).toContain("Productos o servicios");
    const fact = (id: string, key: string, value: string, status = "extracted") => ({ id, key, label: key, value, sourceUrl: null, method: "json-ld", confidence: "high", status });
    const facts = [
      fact("f1", "name", "Tienda A"),
      fact("f2", "offering", "Zapatillas de trail"),
      fact("f3", "industry", "LocalBusiness, ShoeStore"),
      fact("f4", "address", "Calle Mayor 1, 28013, Madrid, ES"),
      fact("f5", "offering", "Rechazado", "rejected"),
    ];
    await h.db.prepare("INSERT INTO brand_profiles (id, organization_id, brand_id, facts_json, competitors_json) VALUES (?, ?, ?, ?, ?)")
      .bind(crypto.randomUUID(), orgA, brandA, JSON.stringify(facts), JSON.stringify(["www.rival.es"]))
      .run();
    const r = await alice.post(`${base}/suggestions`, { locale: "es-ES" });
    expect(r.json.inputs).toMatchObject({ brandName: "Tienda A", sector: "shoe store", place: "Madrid", offerings: ["Zapatillas de trail"], competitors: ["www.rival.es"] });
    const qs = r.json.suggestions.map((s: { question: string }) => s.question);
    expect(qs).toContain("¿Tienda A o rival.es: cuál es mejor?");
    expect(qs).toContain("¿Cuál es el mejor zapatillas de trail en Madrid?");
    expect(qs.join(" ")).not.toContain("Rechazado");
    expect(qs.join(" ")).not.toContain("Calle Mayor");
    const override = await alice.post(`${base}/suggestions`, { sector: "tiendas de running", place: "Valencia" });
    expect(override.json.inputs).toMatchObject({ sector: "tiendas de running", place: "Valencia" });
    expect((await alice.get(`${base}/prompts`)).json.items).toHaveLength(0);
  });
});

describe("GEO helpers", () => {
  it("normalizes questions for duplicate detection", () => {
    expect(normalizeQuestion("  ¿Cuál es  la MEJOR clínica?  ")).toBe(normalizeQuestion("cual es la mejor clinica"));
  });
  it("derives a sector and a city without exposing the street", () => {
    expect(sectorFromTypes("Organization, ExerciseGym")).toBe("exercise gym");
    expect(sectorFromTypes("LocalBusiness")).toBeNull();
    expect(placeFromAddress("Calle Mayor 1, 28013, Madrid, ES")).toBe("Madrid");
    expect(placeFromAddress("Calle Mayor 1")).toBeNull();
  });
  it("never invents: with no data there are no suggestions, only missing fields", () => {
    const r = suggestGeoPrompts({ brandName: null, sector: null, offerings: [], place: null, competitors: [], audience: null, locale: "en-US" });
    expect(r.suggestions).toEqual([]);
    expect(r.missing).toEqual(["Brand name", "Sector / industry", "Products or services", "Area served / city", "Competitors"]);
  });
});
