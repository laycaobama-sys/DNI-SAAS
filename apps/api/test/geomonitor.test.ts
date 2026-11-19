import { describe, expect, it } from "vitest";
import { detectMention } from "@dni/core";
import { parseGemini, safeErrorDetail } from "../src/lib/geoGemini";
import { createHarness } from "./helpers";

const GEMINI = "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent";
const GEMINI_DEFAULT = "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent";
const KEY = ["test", "gemini", "key"].join("-");

type Reply = { status?: number; body?: unknown };
const answer = (text: string, chunks: Array<{ uri: string; title: string }> = [], extra: Record<string, unknown> = {}) => ({
  candidates: [{ finishReason: "STOP", content: { parts: [{ text }] }, groundingMetadata: { webSearchQueries: ["mejor tienda zapatillas"], groundingChunks: chunks.map((web) => ({ web })) } }],
  modelVersion: "gemini-2.5-flash-lite-001",
  usageMetadata: { promptTokenCount: 30, candidatesTokenCount: 120 },
  ...extra,
});

async function setup(opts: { key?: boolean; replies?: Reply[]; env?: Record<string, string> } = {}) {
  const h = createHarness();
  if (opts.key !== false) Object.assign(h.env, { GEMINI_API_KEY: KEY });
  Object.assign(h.env, opts.env ?? {});
  const calls: Array<{ url: string; body: any; key: string | null }> = [];
  const replies = [...(opts.replies ?? [])];
  const realFetch = h.deps.fetchImpl;
  h.deps.fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url.startsWith("https://generativelanguage.googleapis.com/")) {
      calls.push({ url, body: JSON.parse(String(init?.body ?? "{}")), key: new Headers(init?.headers).get("x-goog-api-key") });
      const r = replies.shift() ?? { body: answer("Respuesta sin marcas.") };
      return Response.json(r.body ?? {}, { status: r.status ?? 200 });
    }
    return realFetch(input, init);
  }) as typeof fetch;
  const alice = await h.signup("alice@a.es", "Alice");
  const orgA = await h.createOrg(alice, "Org A", "starter");
  const brandA = (await alice.post(`/api/v1/orgs/${orgA}/brands`, { name: "Tienda A", domain: "tienda-a.es" })).json.id as string;
  await h.db.prepare("INSERT INTO brand_profiles (id, organization_id, brand_id, competitors_json) VALUES (?, ?, ?, ?)").bind(crypto.randomUUID(), orgA, brandA, JSON.stringify(["www.rival.es"])).run();
  const base = `/api/v1/orgs/${orgA}/brands/${brandA}/geo`;
  const add = (questions: string[], engines = ["gemini_api"]) =>
    alice.post(`${base}/prompts`, { questions, intent: "comparative", category: "product", engines, locale: "es-ES", regionCountry: "ES", regionDetail: "Madrid" });
  const run = async () => {
    const r = await alice.post(`${base}/sample`);
    await h.drain();
    const job = r.json.jobId ? (await alice.get(`/api/v1/orgs/${orgA}/jobs/${r.json.jobId}`)).json.job : null;
    return { r, job };
  };
  return { h, alice, orgA, brandA, base, add, run, calls };
}

describe("GEO monitor (Gemini API, free tier)", () => {
  it("samples only enabled Gemini prompts, stores the real answer with sources and detects mentions", async () => {
    const { h, alice, base, add, run, calls } = await setup({
      env: { GEMINI_MODEL: "gemini-2.5-flash-lite" },
      replies: [
        { body: answer("Las mejores opciones son Tienda A y Rival. Tienda A envía en 24 h.", [{ uri: "https://vertexaisearch.cloud.google.com/grounding-api-redirect/abc", title: "tienda-a.es" }, { uri: "http://insecure.example/x", title: "insecure.example" }]) },
        { body: answer("Depende de lo que busques; rival.es tiene buenas opiniones.", [{ uri: "https://vertexaisearch.cloud.google.com/grounding-api-redirect/def", title: "rival.es" }]) },
      ],
    });
    await add(["¿Cuál es la mejor tienda de zapatillas?", "¿Dónde comprar zapatillas de trail?"]);
    await add(["Pregunta solo para Perplexity sobre zapatillas"], ["perplexity_api"]);
    const paused = (await alice.get(`${base}/prompts`)).json.items.find((p: any) => p.engine === "perplexity_api");
    expect(paused).toBeTruthy();

    const { r, job } = await run();
    expect(r.status).toBe(202);
    expect(job.state).toBe("completed");
    expect(job.output).toMatchObject({ requested: 2, ok: 2, errors: 0, mentioned: 1, stoppedReason: null, creditsUsed: 0 });
    expect(calls).toHaveLength(2);
    expect(calls[0]!.url).toBe(GEMINI);
    expect(calls[0]!.key).toBe(KEY);
    expect(calls[0]!.body.tools).toEqual([{ google_search: {} }]);
    expect(calls[0]!.body.systemInstruction.parts[0].text).toContain("Madrid");

    const samples = (await alice.get(`${base}/samples`)).json;
    expect(samples.measurement).toBe("observed_sample");
    const first = samples.items.find((s: any) => s.answer_text.startsWith("Las mejores"));
    expect(first).toMatchObject({ status: "ok", model: "gemini-2.5-flash-lite", model_version: "gemini-2.5-flash-lite-001", grounded: true, brand_mentioned: true, brand_mention_count: 2, brand_cited: true, locale: "es-ES", region_country: "ES", region_detail: "Madrid" });
    expect(first.citations).toEqual([{ title: "tienda-a.es", uri: "https://vertexaisearch.cloud.google.com/grounding-api-redirect/abc", domain: "tienda-a.es" }]);
    expect(first.competitors).toEqual([{ name: "rival", domain: "rival.es", mentioned: true, mentionCount: 1, cited: false }]);
    const second = samples.items.find((s: any) => s.answer_text.startsWith("Depende"));
    expect(second).toMatchObject({ brand_mentioned: false, brand_cited: false });
    expect(second.competitors[0]).toMatchObject({ mentioned: true, cited: true });

    const vis = (await alice.get(`${base}/visibility`)).json;
    expect(vis).toMatchObject({ sampledPrompts: 2, mentioned: 1, cited: 1, mentionRate: 0.5, measurement: "observed_sample" });
    expect(vis.competitors[0]).toMatchObject({ domain: "rival.es", mentioned: 2, cited: 1 });
    const lib = (await alice.get(`${base}/prompts`)).json;
    expect(lib.sampling).toMatchObject({ active: true, model: "gemini-2.5-flash-lite", tier: "free", usedToday: 2 });
    expect(Object.keys(lib.lastSamples)).toHaveLength(2);
    // The key never reaches the database.
    const dump = await h.db.prepare("SELECT GROUP_CONCAT(COALESCE(answer_text,'') || citations_json || method) AS all_text FROM ai_response_samples").first<{ all_text: string }>();
    expect(dump!.all_text).not.toContain(KEY);
    const audit = await h.db.prepare("SELECT after_redacted FROM audit_logs WHERE action = 'geo.sample_run'").first<{ after_redacted: string }>();
    expect(JSON.parse(audit!.after_redacted)).toMatchObject({ engine: "gemini_api", prompts: 2 });
  });

  it("refuses to run without a key, without Gemini prompts, or twice at the same time", async () => {
    const noKey = await setup({ key: false });
    await noKey.add(["¿Cuál es la mejor tienda de zapatillas?"]);
    expect((await noKey.alice.post(`${noKey.base}/sample`)).json.code).toBe("geo_sampling_not_configured");
    expect((await noKey.alice.get(`${noKey.base}/prompts`)).json.sampling.active).toBe(false);

    const s = await setup();
    expect((await s.alice.post(`${s.base}/sample`)).json.code).toBe("geo_no_prompts");
    await s.add(["Pregunta solo para Perplexity sobre zapatillas"], ["perplexity_api"]);
    expect((await s.alice.post(`${s.base}/sample`)).json.code).toBe("geo_no_prompts");
    await s.add(["¿Cuál es la mejor tienda de zapatillas?"]);
    const first = await s.alice.post(`${s.base}/sample`);
    await s.h.drain();
    // The harness runs jobs inline: put this one back to "running" to exercise the in-flight guard.
    await s.h.db.prepare("UPDATE jobs SET state = 'running' WHERE id = ?").bind(first.json.jobId).run();
    const again = await s.alice.post(`${s.base}/sample`);
    expect(first.status).toBe(202);
    expect(again.json).toMatchObject({ jobId: first.json.jobId, alreadyQueued: true });
    await s.h.drain();
  });

  it("enforces the per-organization daily cap before calling Gemini", async () => {
    const { alice, base, add, run, calls } = await setup({ env: { GEO_SAMPLES_DAILY_ORG: "1" } });
    await add(["¿Cuál es la mejor tienda de zapatillas?", "¿Dónde comprar zapatillas de trail?"]);
    const { job } = await run();
    expect(job.output).toMatchObject({ ok: 1, stoppedReason: "daily_cap" });
    expect(calls).toHaveLength(1);
    const again = await alice.post(`${base}/sample`);
    expect(again.status).toBe(429);
    expect(again.json.code).toBe("geo_daily_cap");
  });

  it("stops the run on a Gemini quota error and stores errors as errors (nothing invented)", async () => {
    const quota = { status: 429, body: { error: { status: "RESOURCE_EXHAUSTED" } } };
    // The first 429 with search is retried once without search; a second 429 is a real quota stop.
    const { alice, base, add, run, calls } = await setup({ replies: [{ body: answer("Tienda A es una opción.") }, quota, quota] });
    await add(["Pregunta uno sobre zapatillas de running", "Pregunta dos sobre zapatillas de running", "Pregunta tres sobre zapatillas de running"]);
    const { job } = await run();
    expect(job.state).toBe("completed");
    expect(job.output).toMatchObject({ ok: 1, errors: 1, stoppedReason: "gemini_quota" });
    expect(calls).toHaveLength(3);
    expect(calls[1]!.body.tools).toEqual([{ google_search: {} }]);
    expect(calls[2]!.body.tools).toBeUndefined();
    const items = (await alice.get(`${base}/samples`)).json.items;
    const err = items.find((s: any) => s.status === "error");
    expect(err).toMatchObject({ error_code: "gemini_quota", answer_text: null, brand_mentioned: null });
    // Only successful samples count for visibility.
    expect((await alice.get(`${base}/visibility`)).json).toMatchObject({ sampledPrompts: 1, mentioned: 1 });
  });

  it("fails permanently on an invalid key or a model the key cannot use (one call, never retried)", async () => {
    for (const [reply, code] of [
      [{ status: 403, body: {} }, "gemini_403"],
      [{ status: 404, body: { error: { status: "NOT_FOUND", message: "models/x is not found for API version v1beta" } } }, "gemini_model_unavailable"],
    ] as const) {
      const { add, run, calls } = await setup({ replies: [reply] });
      await add(["¿Cuál es la mejor tienda de zapatillas?", "¿Dónde comprar zapatillas de trail?"]);
      const { job } = await run();
      expect(job.state).toBe("failed");
      expect(job.failure_code).toBe(code);
      expect(calls).toHaveLength(1);
    }
  });

  it.each([
    ["a 400", { status: 400, body: { error: { status: "FAILED_PRECONDITION", message: "Grounding with Google Search is not available on the free tier for this model" } } }],
    ["a zero-quota 429", { status: 429, body: { error: { status: "RESOURCE_EXHAUSTED", message: "You exceeded your current quota, please check your plan and billing details." } } }],
  ])("falls back to sampling WITHOUT search when the free tier refuses it with %s, and labels it (default model)", async (_name, refusal) => {
    const plain = (text: string) => ({ candidates: [{ finishReason: "STOP", content: { parts: [{ text }] } }], modelVersion: "gemini-3.8-flash" });
    const { alice, base, add, run, calls } = await setup({
      replies: [refusal, { body: plain("Tienda A es conocida por sus envíos rápidos.") }, { body: plain("Hay muchas tiendas; depende de tu zona.") }],
    });
    await add(["¿Cuál es la mejor tienda de zapatillas?", "¿Dónde comprar zapatillas de trail?"]);
    const { job } = await run();
    expect(job.state).toBe("completed");
    expect(job.output).toMatchObject({ model: "gemini-3.8-flash", grounded: false, requested: 2, ok: 2, errors: 0, mentioned: 1 });
    expect(calls).toHaveLength(3);
    expect(calls.every((c) => c.url === GEMINI_DEFAULT)).toBe(true);
    expect(calls[0]!.body.tools).toEqual([{ google_search: {} }]);
    expect(calls[1]!.body.tools).toBeUndefined();
    expect(calls[2]!.body.tools).toBeUndefined();
    const items = (await alice.get(`${base}/samples`)).json.items;
    expect(items).toHaveLength(2);
    for (const s of items) expect(s).toMatchObject({ status: "ok", model: "gemini-3.8-flash", grounded: false, method: "gemini-api:generateContent:v1", citations: [] });
    // No search means no sources: the citation rate is unknown, not 0 %.
    expect((await alice.get(`${base}/visibility`)).json).toMatchObject({ sampledPrompts: 2, mentioned: 1, groundedSamples: 0, citationRate: null, models: ["gemini-3.8-flash"] });
  });

  it("retries an overloaded model briefly, then asks the free fallback model and records who answered", async () => {
    const busy = { status: 503, body: { error: { status: "UNAVAILABLE", message: "This model is currently experiencing high demand." } } };
    const { alice, base, add, run, calls } = await setup({
      env: { GEMINI_FALLBACK_MODEL: "gemini-3.5-flash-lite" },
      replies: [busy, busy, busy, { body: answer("Tienda A destaca.", [], { modelVersion: "gemini-3.5-flash-lite" }) }, { body: answer("Otra respuesta.") }],
    });
    await add(["¿Cuál es la mejor tienda de zapatillas?", "¿Dónde comprar zapatillas de trail?"]);
    const { job } = await run();
    expect(job.state).toBe("completed");
    expect(job.output).toMatchObject({ ok: 2, errors: 0, modelsUsed: ["gemini-3.5-flash-lite"], stoppedReason: null });
    // The 2nd question goes straight to the fallback: the main model was overloaded in this run.
    expect(calls.map((c) => c.url.split("/models/")[1])).toEqual([
      "gemini-3.8-flash:generateContent",
      "gemini-3.8-flash:generateContent",
      "gemini-3.8-flash:generateContent",
      "gemini-3.5-flash-lite:generateContent",
      "gemini-3.5-flash-lite:generateContent",
    ]);
    const items = (await alice.get(`${base}/samples`)).json.items;
    expect(items.every((s: any) => s.status === "ok" && s.model === "gemini-3.5-flash-lite")).toBe(true);
    expect(items.some((s: any) => s.brand_mentioned)).toBe(true);
    const sampling = (await alice.get(`${base}/prompts`)).json.sampling;
    expect(sampling).toMatchObject({ model: "gemini-3.8-flash", fallbackModel: "gemini-3.5-flash-lite" });
    const vis = (await alice.get(`${base}/visibility`)).json;
    expect(vis.models).toEqual(["gemini-3.5-flash-lite"]);
    expect(vis.source).toContain("gemini-3.5-flash-lite");
  });

  it("moves to the fallback model when the main model's own free quota is used up; stops if both are", async () => {
    const quota = { status: 429, body: { error: { status: "RESOURCE_EXHAUSTED" } } };
    const { add, run, calls } = await setup({
      env: { GEMINI_FALLBACK_MODEL: "gemini-3.5-flash-lite" },
      // search refused (429) → same model without search (429) → fallback: ok → next question on the fallback: 429 → stop.
      replies: [quota, quota, { body: answer("Tienda A es buena.") }, quota],
    });
    await add(["Pregunta uno sobre zapatillas de running", "Pregunta dos sobre zapatillas de running", "Pregunta tres sobre zapatillas de running"]);
    const { job } = await run();
    expect(job.state).toBe("completed");
    expect(job.output).toMatchObject({ ok: 1, errors: 1, modelsUsed: ["gemini-3.5-flash-lite"], stoppedReason: "gemini_quota" });
    expect(calls.map((c) => [c.url.split("/models/")[1]!.split(":")[0], !!c.body.tools])).toEqual([
      ["gemini-3.8-flash", true],
      ["gemini-3.8-flash", false],
      ["gemini-3.5-flash-lite", false],
      ["gemini-3.5-flash-lite", false],
    ]);
  });

  it("stops early when Gemini stays overloaded instead of spending the daily quota on failures", async () => {
    const busy = { status: 503, body: { error: { status: "UNAVAILABLE" } } };
    const { add, run, calls } = await setup({ replies: Array.from({ length: 12 }, () => busy) });
    await add(["Pregunta uno sobre zapatillas de running", "Pregunta dos sobre zapatillas de running", "Pregunta tres sobre zapatillas de running", "Pregunta cuatro sobre zapatillas de running"]);
    const { job } = await run();
    expect(job.state).toBe("completed");
    expect(job.output).toMatchObject({ ok: 0, errors: 3, stoppedReason: "gemini_unavailable" });
    expect(calls).toHaveLength(9); // 3 questions × (1 call + 2 short retries); the 4th is never sent.
  });

  it("keeps only a short, key-free excerpt of Google's error text", () => {
    const leaked = `Bad request for key AIza${"x".repeat(30)} please check`;
    expect(safeErrorDetail(leaked)).toBe("Bad request for key [redacted] please check");
    expect(safeErrorDetail("a".repeat(500))).toHaveLength(300);
    expect(safeErrorDetail(undefined)).toBeNull();
  });

  it("stores blocked answers without mention flags", async () => {
    const { alice, base, add, run } = await setup({ replies: [{ body: { candidates: [{ finishReason: "SAFETY", content: { parts: [] } }] } }] });
    await add(["¿Cuál es la mejor tienda de zapatillas?"]);
    await run();
    const s = (await alice.get(`${base}/samples`)).json.items[0];
    expect(s).toMatchObject({ status: "blocked", brand_mentioned: null, brand_cited: null });
  });

  it("viewers read samples and visibility but cannot run sampling; other tenants get 404", async () => {
    const { h, alice, orgA, base, add, run } = await setup();
    await h.db.prepare("UPDATE organizations SET plan_code = 'pro' WHERE id = ?").bind(orgA).run();
    await add(["¿Cuál es la mejor tienda de zapatillas?"]);
    await run();
    const viewer = await h.invite(alice, orgA, "viewer@a.es", "client_viewer");
    expect((await viewer.get(`${base}/samples`)).status).toBe(200);
    expect((await viewer.get(`${base}/visibility`)).status).toBe(200);
    expect((await viewer.post(`${base}/sample`)).status).toBe(403);
    const bob = await h.signup("bob@b.es", "Bob");
    const orgB = await h.createOrg(bob, "Org B", "starter");
    const viaB = base.replace(orgA, orgB);
    for (const p of [`${base}/samples`, `${base}/visibility`, `${viaB}/samples`, `${viaB}/visibility`]) expect((await bob.get(p)).status).toBe(404);
    expect((await bob.post(`${viaB}/sample`)).status).toBe(404);
  });
});

describe("GEO mention detection", () => {
  const me = { name: "DNI Growth", domain: "dnigrowth.com" };
  it("counts the brand once per occurrence across name, compact name and domain", () => {
    const r = detectMention("DNI Growth es útil. Más en dnigrowth.com. DNIGROWTH también audita.", [], me);
    expect(r).toEqual({ mentioned: true, mentionCount: 3, cited: false });
  });
  it("ignores substrings and matches citations by domain (subdomains too)", () => {
    expect(detectMention("Las dnigrowthers no cuentan.", [], me).mentioned).toBe(false);
    expect(detectMention("Nada.", [{ title: "blog.dnigrowth.com", uri: "https://x", domain: "blog.dnigrowth.com" }], me).cited).toBe(true);
    expect(detectMention("Nada.", [{ title: "notdnigrowth.com", uri: "https://x", domain: "notdnigrowth.com" }], me).cited).toBe(false);
  });
  it("accent and case insensitive", () => {
    expect(detectMention("La Clínica Óptima es buena", [], { name: "clinica optima", domain: null }).mentionCount).toBe(1);
  });
  it("keeps only https grounding sources", () => {
    const s = parseGemini({ candidates: [{ content: { parts: [{ text: "x" }] }, groundingMetadata: { groundingChunks: [{ web: { uri: "javascript:alert(1)", title: "a.com" } }, { web: { uri: "https://ok", title: "b.com" } }] } }] });
    expect(s.citations.map((c) => c.domain)).toEqual(["b.com"]);
  });
});
