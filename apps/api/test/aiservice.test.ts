/**
 * Central AI service: Workers AI first (free daily Neurons, own cap), then optional free Groq and
 * Gemini keys, then OpenRouter free. 24 h response cache per organisation; clear Spanish message
 * when the free daily quota is spent.
 */
import { describe, expect, it } from "vitest";
import { createHarness } from "./helpers";

type RunInput = { messages?: Array<{ role: string; content: string }>; max_tokens?: number; chat_template_kwargs?: { enable_thinking?: boolean } };

async function setup(opts: { wai?: "ok" | "fail" } = { wai: "ok" }) {
  const h = createHarness();
  // Engine internals are inspected as platform staff; customers only see «IA DNI Growth».
  h.env.PLATFORM_ADMIN_EMAILS = "owner@luna.es";
  const runs: Array<{ model: string; input: RunInput }> = [];
  Object.assign(h.env, {
    AI: {
      async run(model: string, input: RunInput) {
        runs.push({ model, input });
        if (opts.wai === "fail") throw new Error("overloaded");
        return { choices: [{ message: { content: "Respuesta Workers AI." } }], usage: { prompt_tokens: 800, completion_tokens: 150 } };
      },
    },
  });
  const external: Array<{ url: string; headers: Record<string, string>; body: any }> = [];
  let groqStatus = 200;
  let geminiStatus = 200;
  const real = h.deps.fetchImpl;
  h.deps.fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.startsWith("https://api.groq.com/")) {
      external.push({ url, headers: init?.headers as Record<string, string>, body: JSON.parse(String(init?.body)) });
      if (groqStatus !== 200) return new Response("{}", { status: groqStatus });
      return Response.json({ choices: [{ message: { content: "Respuesta Groq." } }], usage: { prompt_tokens: 700, completion_tokens: 90 } });
    }
    if (url.startsWith("https://generativelanguage.googleapis.com/")) {
      external.push({ url, headers: init?.headers as Record<string, string>, body: JSON.parse(String(init?.body)) });
      if (geminiStatus !== 200) return new Response("{}", { status: geminiStatus });
      return Response.json({ candidates: [{ content: { parts: [{ text: "Respuesta Gemini." }] } }], usageMetadata: { promptTokenCount: 600, candidatesTokenCount: 80 } });
    }
    return real(input, init);
  }) as typeof fetch;
  const owner = await h.signup("owner@luna.es");
  const orgId = await h.createOrg(owner, "Panadería Luna");
  await h.db.prepare("UPDATE organizations SET plan_code = 'growth' WHERE id = ?").bind(orgId).run();
  const spendBudget = () =>
    h.db.prepare("INSERT INTO ai_usage_daily (day, provider, requests, cost_usd) VALUES (?, 'workers_ai', 1, 0.1)").bind(new Date().toISOString().slice(0, 10)).run();
  return {
    h, owner, orgId, runs, external, spendBudget,
    setGroq: (s: number) => void (groqStatus = s),
    setGemini: (s: number) => void (geminiStatus = s),
  };
}
const ask = (c: { post: (p: string, b?: unknown) => Promise<{ status: number; json: any }> }, orgId: string, question = "¿Cómo mejoro el SEO local de mi panadería?") =>
  c.post(`/api/v1/orgs/${orgId}/advisor`, { question });

describe("AI service: Workers AI is the primary free engine", () => {
  it("answers with Workers AI, thinking switched off and output capped by the task budget", async () => {
    const { owner, orgId, runs, external } = await setup();
    const r = await ask(owner, orgId);
    expect(r.status).toBe(200);
    expect(r.json.message).toMatchObject({ provider: "workers_ai", model: "@cf/google/gemma-4-26b-a4b-it" });
    expect(runs).toHaveLength(1);
    expect(runs[0]!.input.chat_template_kwargs).toEqual({ enable_thinking: false });
    expect(runs[0]!.input.max_tokens).toBeLessThanOrEqual(900);
    expect(external).toHaveLength(0);
  });

  it("the daily cap can never be raised above the free allowance (0.10 USD ≈ 9,091 Neurons)", async () => {
    const { h, owner, orgId } = await setup();
    h.env.AI_DAILY_BUDGET_USD = "5";
    const st = await owner.get(`/api/v1/orgs/${orgId}/ai/status`);
    expect(st.json).toMatchObject({ workersAi: true, dailyBudgetUsd: 0.1, neuronsDailyCap: 9091, neuronsFreePerDay: 10000, resetsAt: "00:00 UTC", order: ["workers_ai"] });
  });

  it("when the free daily quota is spent and no fallback key exists: clear Spanish message, no credit charged", async () => {
    const { owner, orgId, runs, spendBudget } = await setup();
    await spendBudget();
    const before = (await owner.get(`/api/v1/orgs/${orgId}/billing`)).json.balance;
    const r = await ask(owner, orgId);
    expect(r.status).toBe(503);
    expect(r.json.code).toBe("ai_daily_quota");
    expect(r.json.title).toMatch(/IA DNI Growth.*00:00 UTC.*No se ha cobrado/);
    expect(runs).toHaveLength(0);
    expect((await owner.get(`/api/v1/orgs/${orgId}/billing`)).json.balance).toBe(before);
  });
});

describe("AI service: free fallbacks (only if their key exists)", () => {
  it("quota spent → Groq (gpt-oss-20b, low reasoning) answers transparently", async () => {
    const { h, owner, orgId, external, spendBudget } = await setup();
    h.env.GROQ_API_KEY = "test-groq";
    h.env.GEMINI_API_KEY = "test-gemini";
    await spendBudget();
    const r = await ask(owner, orgId);
    expect(r.status).toBe(200);
    expect(r.json.message).toMatchObject({ provider: "groq", model: "openai/gpt-oss-20b", content: "Respuesta Groq." });
    expect(external).toHaveLength(1);
    expect(external[0]!.url).toBe("https://api.groq.com/openai/v1/chat/completions");
    expect(external[0]!.headers.authorization).toBe("Bearer test-groq");
    expect(external[0]!.body).toMatchObject({ model: "openai/gpt-oss-20b", max_tokens: 2312, reasoning_effort: "low", include_reasoning: false });
  });

  it("Workers AI failing + Groq 429 → Gemini 3.5 Flash-Lite (free tier) answers", async () => {
    const { h, owner, orgId, external, setGroq } = await setup({ wai: "fail" });
    h.env.GROQ_API_KEY = "test-groq";
    h.env.GEMINI_API_KEY = "test-gemini";
    setGroq(429);
    const r = await ask(owner, orgId);
    expect(r.json.message).toMatchObject({ provider: "gemini", model: "gemini-3.5-flash-lite", content: "Respuesta Gemini." });
    expect(external.map((e) => new URL(e.url).hostname)).toEqual(["api.groq.com", "generativelanguage.googleapis.com"]);
    expect(external[1]!.url).toContain("/models/gemini-3.5-flash-lite:generateContent");
    expect(external[1]!.body.generationConfig.maxOutputTokens).toBeLessThanOrEqual(1024);
  });

  it("each free fallback has its own daily cap (Gemini keeps room for the GEO monitor)", async () => {
    const { h, owner, orgId, external, spendBudget } = await setup();
    h.env.GEMINI_API_KEY = "test-gemini";
    h.env.GEMINI_TEXT_DAILY = "0";
    await spendBudget();
    const r = await ask(owner, orgId);
    expect(r.status).toBe(503);
    expect(r.json.code).toBe("ai_daily_quota");
    expect(external).toHaveLength(0);
  });

  it("cloudflare_only and privacy-first are respected by the fallbacks", async () => {
    const { h, owner, orgId, external, spendBudget } = await setup();
    h.env.GROQ_API_KEY = "test-groq";
    h.env.GEMINI_API_KEY = "test-gemini";
    await spendBudget();
    await owner.patch(`/api/v1/orgs/${orgId}/ai/preferences`, { strategy: "cloudflare_only" });
    expect((await ask(owner, orgId)).status).toBe(503);
    expect(external).toHaveLength(0);
    await owner.patch(`/api/v1/orgs/${orgId}/ai/preferences`, { strategy: "automatic_free", privacyFirst: true, openrouterEnabled: false });
    h.env.GROQ_API_KEY = undefined;
    expect((await ask(owner, orgId)).status).toBe(503); // Gemini is never used in privacy-first mode
    expect(external).toHaveLength(0);
  });

  it("sensitive data never reaches Groq or Gemini, even with the Workers AI quota spent", async () => {
    const { h, owner, orgId, external, spendBudget } = await setup();
    h.env.GROQ_API_KEY = "test-groq";
    h.env.GEMINI_API_KEY = "test-gemini";
    await spendBudget();
    const r = await ask(owner, orgId, "Mi DNI es 12345678Z, ¿lo pongo en la web?");
    expect(r.status).toBe(503);
    expect(external).toHaveLength(0);
  });
});

describe("AI service: 24 h response cache", () => {
  it("an identical request is served from the cache (no model call); another tenant never sees it", async () => {
    const { h, owner, orgId, runs } = await setup();
    const a = await ask(owner, orgId);
    const b = await ask(owner, orgId); // new conversation, same question and context
    expect(b.json.message.content).toBe(a.json.message.content);
    expect(runs).toHaveLength(1);
    const hit = await h.db.prepare("SELECT provider, model, error_code, cost_state FROM ai_invocations WHERE provider = 'cache'").first();
    expect(hit).toMatchObject({ provider: "cache", model: "@cf/google/gemma-4-26b-a4b-it", error_code: "cache_hit", cost_state: "zero_confirmed" });
    // The cache stores only a hash of the request, never the prompt.
    const row = await h.db.prepare("SELECT * FROM ai_response_cache").first<Record<string, unknown>>();
    expect(row!.cache_key).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(row)).not.toContain("panadería");

    const other = await h.signup("rival@sol.es");
    const otherOrg = await h.createOrg(other, "Panadería Luna");
    await ask(other, otherOrg);
    expect(runs).toHaveLength(2);
  });

  it("requests with sensitive data are never cached", async () => {
    const { h, owner, orgId, runs } = await setup();
    await ask(owner, orgId, "Mi contraseña: Hunter2024! ¿es segura?");
    await ask(owner, orgId, "Mi contraseña: Hunter2024! ¿es segura?");
    expect(runs).toHaveLength(2);
    expect((await h.db.prepare("SELECT COUNT(*) AS n FROM ai_response_cache").first<{ n: number }>())!.n).toBe(0);
  });

  it("expired entries are not reused", async () => {
    const { h, owner, orgId, runs } = await setup();
    await ask(owner, orgId);
    await h.db.prepare("UPDATE ai_response_cache SET expires_at = ?").bind(new Date(Date.now() - 1000).toISOString()).run();
    await ask(owner, orgId);
    expect(runs).toHaveLength(2);
  });
});

describe("Admin «probar conexión» per provider", () => {
  it("is invisible to normal users; calls only the chosen provider, never caches, audits without the key", async () => {
    const { h, owner, runs, external, setGroq } = await setup();
    h.env.PLATFORM_ADMIN_EMAILS = "";
    expect((await owner.post("/api/v1/admin/ai/providers/test", { provider: "groq" })).status).toBe(404);
    h.env.PLATFORM_ADMIN_EMAILS = "owner@luna.es";
    const none = await owner.post("/api/v1/admin/ai/providers/test", { provider: "groq" });
    expect(none.json).toMatchObject({ ok: false, provider: "groq", error: "groq:sin_clave" });
    h.env.GROQ_API_KEY = "test-groq-secret";
    const ok = await owner.post("/api/v1/admin/ai/providers/test", { provider: "groq" });
    expect(ok.json).toMatchObject({ ok: true, provider: "groq", model: "openai/gpt-oss-20b" });
    expect(runs).toHaveLength(0); // Workers AI was not called
    expect(external.filter((x) => x.url.startsWith("https://api.groq.com/"))).toHaveLength(1);
    expect(external[0]!.body.max_tokens).toBeLessThanOrEqual(544);
    setGroq(401);
    expect((await owner.post("/api/v1/admin/ai/providers/test", { provider: "groq" })).json).toMatchObject({ ok: false, error: "groq:groq_401" });
    expect((await owner.post("/api/v1/admin/ai/providers/test", { provider: "workers_ai" })).json).toMatchObject({ ok: true, provider: "workers_ai" });
    expect((await owner.post("/api/v1/admin/ai/providers/test", { provider: "openrouter" })).status).toBe(422);
    const { results } = await h.db.prepare("SELECT after_redacted FROM audit_logs WHERE action = 'ai.provider_test'").all<{ after_redacted: string }>();
    expect(results).toHaveLength(4);
    expect(JSON.stringify(results)).not.toContain("test-groq-secret");
    expect((await h.db.prepare("SELECT COUNT(*) AS n FROM ai_response_cache").first<{ n: number }>())!.n).toBe(0);
  });
});
