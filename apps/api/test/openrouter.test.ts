/**
 * OpenRouter FREE-ONLY policy: no route of the system can execute a paid model.
 * Every test that touches /chat/completions asserts which model ids actually reached the network.
 */
import { describe, expect, it } from "vitest";
import { syncOpenRouterCatalog } from "../src/lib/openrouter";
import { createHarness } from "./helpers";

const FREE_A = "vendor-a/alpha-large:free";
const FREE_B = "vendor-b/beta-small:free";
const PAID = "vendor-a/alpha-large";
const ZERO_NOT_FREE = "google/lyria-3-pro-preview";

function catalog(overrides: Record<string, unknown> = {}) {
  const chat = ["/api/v1/chat/completions"];
  const text = { input_modalities: ["text"], output_modalities: ["text"] };
  return [
    { id: FREE_A, name: "Alpha Large (free)", description: "<script>alert(1)</script>Modelo <b>alpha</b> [web](https://evil.example)", context_length: 262144, architecture: text, pricing: { prompt: "0", completion: "0" }, endpoints: chat, supported_parameters: ["max_tokens", "tools", "reasoning"], top_provider: { max_completion_tokens: 32768 } },
    { id: FREE_B, name: "Beta Small (free)", context_length: 131072, architecture: { input_modalities: ["text", "image"], output_modalities: ["text"] }, pricing: { prompt: "0", completion: "0" }, endpoints: chat, supported_parameters: ["max_tokens", "response_format"] },
    { id: PAID, name: "Alpha Large", context_length: 262144, architecture: text, pricing: { prompt: "0.0000003", completion: "0.0000012" }, endpoints: chat },
    { id: ZERO_NOT_FREE, name: "Lyria", context_length: 1000, architecture: { input_modalities: ["text"], output_modalities: ["audio"] }, pricing: { prompt: "0", completion: "0" } },
    { id: "vendor-c/hidden-fee:free", name: "Hidden fee", context_length: 131072, architecture: text, pricing: { prompt: "0", completion: "0", request: "0.002" }, endpoints: chat },
    { id: "vendor-c/search-fee:free", name: "Web search fee", context_length: 131072, architecture: text, pricing: { prompt: "0", completion: "0", web_search: "0.004" }, endpoints: chat },
    { id: "vendor-c/no-pricing:free", name: "No pricing", context_length: 131072, architecture: text, endpoints: chat },
    { id: "vendor-c/overrides:free", name: "Overrides", context_length: 131072, architecture: text, pricing: { prompt: "0", completion: "0", overrides: { "x": 1 } }, endpoints: chat },
    { id: "vendor-d/image-gen:free", name: "Image gen", context_length: 32000, architecture: { input_modalities: ["text"], output_modalities: ["image"] }, pricing: { prompt: "0", completion: "0" }, endpoints: chat },
    { id: "openrouter/free", name: "Free Models Router", context_length: 200000, architecture: { input_modalities: ["text", "image"], output_modalities: ["text"] }, pricing: { prompt: "0", completion: "0" } },
    ...((overrides.extra as unknown[]) ?? []),
  ];
}

type ChatHandler = (body: { model: string; provider?: { max_price?: Record<string, number>; data_collection?: string } }) => Response;

// Workers AI is the PRIMARY engine of the AI service. These tests exercise the OpenRouter route,
// so by default there is no Workers AI binding (OpenRouter is then the free provider that answers).
// Pass `wai` to add a Workers AI binding that answers ("ok") or fails ("fail").
async function setup(opts: { chat?: ChatHandler; models?: unknown[]; key?: boolean; wai?: "ok" | "fail" } = {}) {
  const h = createHarness();
  const waiCalls: string[] = [];
  if (opts.wai) Object.assign(h.env, {
    AI: {
      async run(model: string) {
        waiCalls.push(model);
        if (opts.wai === "fail") throw new Error("overloaded");
        return { response: "Respuesta Workers AI.", usage: { prompt_tokens: 100, completion_tokens: 20 } };
      },
    },
  });
  if (opts.key !== false) h.env.OPENROUTER_API_KEY = "test-or-key";
  const chatCalls: Array<{ model: string; body: Record<string, unknown> }> = [];
  let models = opts.models ?? catalog();
  const real = h.deps.fetchImpl;
  h.deps.fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url === "https://openrouter.ai/api/v1/models") return Response.json({ data: models });
    if (url === "https://openrouter.ai/api/v1/key") return Response.json({ data: { usage: 0, usage_daily: 0, is_free_tier: true, free_model_daily_requests: { used: 0, limit: 50, remaining: 50 } } });
    if (url === "https://openrouter.ai/api/v1/chat/completions") {
      const body = JSON.parse(String(init?.body));
      expect((init?.headers as Record<string, string>).authorization).toBe("Bearer test-or-key");
      chatCalls.push({ model: body.model, body });
      return (opts.chat ?? (() => Response.json({ model: body.model, choices: [{ message: { content: "Respuesta gratuita." } }], usage: { prompt_tokens: 50, completion_tokens: 10, cost: 0 } })))(body);
    }
    return real(input, init);
  }) as typeof fetch;
  const owner = await h.signup("owner@luna.es");
  const orgId = await h.createOrg(owner, "Panadería Luna");
  await h.db.prepare("UPDATE organizations SET plan_code = 'growth' WHERE id = ?").bind(orgId).run();
  return { h, owner, orgId, chatCalls, waiCalls, setModels: (m: unknown[]) => void (models = m) };
}

const sync = (h: ReturnType<typeof createHarness>) => syncOpenRouterCatalog(h.env, h.deps, { force: true });
// Each question is unique so the 24 h response cache never hides a provider call in these tests.
let askN = 0;
const ask = (c: { post: (p: string, b?: unknown) => Promise<{ status: number; json: any }> }, orgId: string, extra: Record<string, unknown> = {}) =>
  c.post(`/api/v1/orgs/${orgId}/advisor`, { question: `¿Qué hago primero? (${++askN})`, ...extra });

describe("OpenRouter catalogue sync and classification", () => {
  it("stores only :free ids + the free router, classifies hidden fees, and sanitises descriptions", async () => {
    const { h, owner, orgId } = await setup();
    const s = await sync(h);
    expect(s).toMatchObject({ ok: true, seen: 10, eligible: 3 }); // FREE_A, FREE_B, openrouter/free
    const r = await owner.get(`/api/v1/orgs/${orgId}/ai/models?freeOnly=false`);
    const byId = Object.fromEntries(r.json.items.map((m: { id: string }) => [m.id, m]));
    expect(byId[PAID]).toBeUndefined();
    expect(byId[ZERO_NOT_FREE]).toBeUndefined();
    expect(byId["vendor-c/hidden-fee:free"]).toMatchObject({ freeClass: "paid", label: "DE PAGO / BLOQUEADO", eligible: false });
    expect(byId["vendor-c/search-fee:free"]).toMatchObject({ freeClass: "paid", eligible: false });
    expect(byId["vendor-c/no-pricing:free"]).toMatchObject({ freeClass: "unknown", label: "PRECIO DESCONOCIDO", eligible: false });
    expect(byId["vendor-c/overrides:free"]).toMatchObject({ freeClass: "unknown", eligible: false });
    expect(byId["vendor-d/image-gen:free"]).toMatchObject({ freeClass: "incompatible", eligible: false });
    expect(byId[FREE_A]).toMatchObject({ freeClass: "verified", label: "GRATIS VERIFICADO", eligible: true });
    expect(byId[FREE_A].description).not.toMatch(/<|evil|script>/);
    expect(byId[FREE_B].capabilities).toContain("vision");
    expect(byId[FREE_B].categories).toContain("vision_multimodal");
    const freeOnly = await owner.get(`/api/v1/orgs/${orgId}/ai/models`);
    expect(freeOnly.json.items.map((m: { id: string }) => m.id).sort()).toEqual([FREE_A, FREE_B, "openrouter/free"].sort());
    // Never exposes the key
    expect(JSON.stringify(r.json)).not.toContain("test-or-key");
    expect(JSON.stringify((await owner.get(`/api/v1/orgs/${orgId}/ai/provider-status`)).json)).not.toContain("test-or-key");
  });

  it("a price change on the next sync blocks the model immediately and logs the change", async () => {
    const { h, owner, orgId, chatCalls, setModels } = await setup();
    await sync(h);
    const changed = catalog().map((m) => (m.id === FREE_A || m.id === FREE_B ? { ...m, pricing: { prompt: "0.000001", completion: "0" } } : m));
    setModels(changed.filter((m) => m.id !== "openrouter/free"));
    const s = await sync(h);
    expect(s.priceChanged).toBeGreaterThanOrEqual(2);
    const r = await ask(owner, orgId);
    expect(r.status).toBe(503); // no Workers AI binding in this suite: nothing else may answer
    expect(chatCalls).toHaveLength(0);
    const changes = await h.db.prepare("SELECT change FROM ai_model_changes WHERE model_id = ?").bind(FREE_A).all<{ change: string }>();
    expect(changes.results.map((x) => x.change)).toEqual(expect.arrayContaining(["added", "price_changed", "blocked"]));
  });

  it("a model removed from the catalogue is retired without breaking past conversations", async () => {
    const { h, owner, orgId, setModels } = await setup();
    await sync(h);
    const first = await ask(owner, orgId);
    expect(first.json.message.provider).toBe("openrouter");
    setModels(catalog().filter((m) => m.id !== FREE_A && m.id !== FREE_B && m.id !== "openrouter/free"));
    await sync(h);
    const row = await h.db.prepare("SELECT eligible, removed_at FROM ai_models WHERE model_id = ?").bind(FREE_A).first<{ eligible: number; removed_at: string }>();
    expect(row).toMatchObject({ eligible: 0 });
    expect(row!.removed_at).toBeTruthy();
    const conv = await owner.get(`/api/v1/orgs/${orgId}/advisor/conversations/${first.json.conversationId}`);
    expect(conv.json.messages).toHaveLength(2);
  });

  it("keeps the last valid snapshot when the catalogue fetch fails", async () => {
    const { h } = await setup();
    await sync(h);
    h.deps.fetchImpl = (async () => new Response("boom", { status: 500 })) as typeof fetch;
    const s = await sync(h);
    expect(s.ok).toBe(false);
    const n = await h.db.prepare("SELECT COUNT(*) AS n FROM ai_models WHERE eligible = 1").first<{ n: number }>();
    expect(n!.n).toBe(3);
  });
});

describe("FREE-only routing: paid models can never be executed", () => {
  it("uses a verified free model, sends max_price = 0 and records zero confirmed cost", async () => {
    const { h, owner, orgId, chatCalls } = await setup();
    await sync(h);
    const r = await ask(owner, orgId);
    expect(r.status).toBe(200);
    expect(r.json.message).toMatchObject({ provider: "openrouter", content: "Respuesta gratuita." });
    expect([FREE_A, FREE_B]).toContain(r.json.message.model);
    expect(chatCalls).toHaveLength(1);
    expect(chatCalls[0]!.body.provider).toMatchObject({ max_price: { prompt: 0, completion: 0, request: 0, image: 0 } });
    expect(chatCalls.every((c) => c.model.endsWith(":free"))).toBe(true);
    const usage = await owner.get(`/api/v1/orgs/${orgId}/ai/usage`);
    expect(usage.json.recent[0]).toMatchObject({ provider: "openrouter", status: "ok", cost_state: "zero_confirmed", reported_cost_usd: 0 });
  });

  it("the client cannot inject a model, provider or price in the advisor request", async () => {
    const { h, owner, orgId, chatCalls } = await setup();
    await sync(h);
    for (const extra of [{ model: PAID }, { provider: "openrouter" }, { maxPrice: 1 }, { modelId: PAID }]) {
      const r = await ask(owner, orgId, extra);
      expect(r.status).toBe(422);
      expect(r.json.code).toBe("validation_error");
    }
    expect(chatCalls).toHaveLength(0);
  });

  it("selecting a paid or unknown-price model in preferences is rejected by the server", async () => {
    const { h, owner, orgId, chatCalls } = await setup();
    await sync(h);
    for (const id of [PAID, "vendor-c/hidden-fee:free", "vendor-c/no-pricing:free", "openai/gpt-x", "vendor-d/image-gen:free", ZERO_NOT_FREE]) {
      const r = await owner.patch(`/api/v1/orgs/${orgId}/ai/preferences`, { strategy: "manual_free", manualModelId: id });
      expect(r.status, id).toBe(422);
    }
    // Extra fields (e.g. a "allowPaid" flag) are rejected by the strict schema
    expect((await owner.patch(`/api/v1/orgs/${orgId}/ai/preferences`, { strategy: "automatic_free", allowPaid: true })).status).toBe(422);
    const ok = await owner.patch(`/api/v1/orgs/${orgId}/ai/preferences`, { strategy: "manual_free", manualModelId: FREE_B });
    expect(ok.status).toBe(200);
    expect(ok.json).toMatchObject({ strategy: "manual_free", manualModelId: FREE_B });
    expect(chatCalls).toHaveLength(0);
  });

  it("even if a paid id is forced into the database, the pre-call gate blocks it before any network call", async () => {
    const { h, owner, orgId, chatCalls } = await setup();
    await sync(h);
    // Simulate tampering: preference points to a paid model and a paid row marked eligible.
    await h.db.prepare("INSERT INTO organization_ai_preferences (organization_id, strategy, manual_model_id) VALUES (?, 'manual_free', ?)").bind(orgId, PAID).run();
    await h.db.prepare("INSERT INTO ai_models (model_id, display_name, free_class, eligible, capabilities, expires_at, context_length) VALUES (?, 'x', 'verified', 1, '[\"chat\"]', '2999-01-01', 999999)").bind(PAID).run();
    const r = await ask(owner, orgId);
    expect(r.status).toBe(503); // no Workers AI binding in this suite: nothing else may answer
    expect(chatCalls).toHaveLength(0);
    const blocked = await h.db.prepare("SELECT status, error_code FROM ai_invocations WHERE model = ?").bind(PAID).first<{ status: string; error_code: string }>();
    expect(blocked).toMatchObject({ status: "blocked" });
    expect(blocked!.error_code).toContain("no_es_variante_free");
  });

  it("a stale price snapshot (not revalidated in 26 h) is not trusted", async () => {
    const { h, owner, orgId, chatCalls } = await setup();
    await sync(h);
    await h.db.prepare("UPDATE ai_models SET last_checked_at = '2020-01-01T00:00:00.000Z'").run();
    const r = await ask(owner, orgId);
    expect(r.status).toBe(503);
    expect(chatCalls).toHaveLength(0);
  });

  it("policy vars are fail-closed: ALLOW_PAID_MODELS=true or MAX_SPEND≠0 disables OpenRouter entirely", async () => {
    for (const vars of [{ ALLOW_PAID_MODELS: "true" }, { OPENROUTER_MAX_SPEND_USD: "5" }, { OPENROUTER_FREE_ONLY: "false" }]) {
      const { h, owner, orgId, chatCalls } = await setup();
      await sync(h);
      Object.assign(h.env, vars);
      const r = await ask(owner, orgId);
      expect(r.status).toBe(503);
      expect(chatCalls).toHaveLength(0);
    }
  });

  it("a reported cost > 0 halts OpenRouter for the whole platform; later requests never reach it", async () => {
    const { h, owner, orgId, chatCalls } = await setup({ chat: (b) => Response.json({ model: b.model, choices: [{ message: { content: "x" } }], usage: { cost: 0.0004 } }) });
    await sync(h);
    const r = await ask(owner, orgId);
    expect(r.status).toBe(503); // no Workers AI binding in this suite: nothing else may answer
    expect(chatCalls).toHaveLength(1);
    const st = await owner.get(`/api/v1/orgs/${orgId}/ai/provider-status`);
    expect(st.json.openrouter.halted).toMatchObject({ reason: "cobro_inesperado" });
    await ask(owner, orgId);
    expect(chatCalls).toHaveLength(1);
    const billed = await h.db.prepare("SELECT cost_state FROM ai_invocations WHERE provider = 'openrouter' AND status = 'failed'").first<{ cost_state: string }>();
    expect(billed!.cost_state).toBe("billed");
  });

  it("the free router may only serve :free models; a paid served model halts OpenRouter", async () => {
    const { h, owner, orgId, chatCalls } = await setup({ chat: () => Response.json({ model: "openai/gpt-paid", choices: [{ message: { content: "x" } }] }) });
    await sync(h);
    await owner.patch(`/api/v1/orgs/${orgId}/ai/preferences`, { strategy: "openrouter_free_router" });
    const r = await ask(owner, orgId);
    expect(r.status).toBe(503);
    expect(chatCalls.map((c) => c.model)).toEqual(["openrouter/free"]);
    expect((await owner.get(`/api/v1/orgs/${orgId}/ai/provider-status`)).json.openrouter.halted.reason).toBe("modelo_servido_no_verificable");
  });

  it("402 halts OpenRouter (never buys credits); 401 marks the key invalid", async () => {
    for (const [status, reason] of [[402, "pago_requerido_402"], [401, "clave_invalida"]] as const) {
      const { h, owner, orgId, chatCalls } = await setup({ chat: () => new Response("{}", { status }) });
      await sync(h);
      const r = await ask(owner, orgId);
      expect(r.status).toBe(503);
      expect(chatCalls).toHaveLength(1); // no second OpenRouter attempt after a global error
      expect((await owner.get(`/api/v1/orgs/${orgId}/ai/provider-status`)).json.openrouter.halted.reason).toBe(reason);
    }
  });

  it("429 sets a global cooldown honouring Retry-After and skips OpenRouter (no retry storm)", async () => {
    const { h, owner, orgId, chatCalls } = await setup({ chat: () => new Response("{}", { status: 429, headers: { "retry-after": "120" } }) });
    await sync(h);
    await ask(owner, orgId);
    await ask(owner, orgId);
    expect(chatCalls).toHaveLength(1);
    const st = await owner.get(`/api/v1/orgs/${orgId}/ai/provider-status`);
    expect(st.json.openrouter).toMatchObject({ connected: false, reason: "limite_de_frecuencia_temporal" });
  });

  it("5xx / timeout / empty answer: at most 2 OpenRouter attempts, then an honest 503", async () => {
    const { h, owner, orgId, chatCalls } = await setup({ chat: () => new Response("{}", { status: 503 }) });
    await sync(h);
    const r = await ask(owner, orgId);
    expect(r.status).toBe(503);
    expect(r.json.code).toBe("ai_unavailable");
    expect(chatCalls).toHaveLength(2);
  });

  it("with the free OpenRouter router chosen: OpenRouter first, Workers AI as fallback", async () => {
    const { h, owner, orgId, chatCalls } = await setup({ chat: () => new Response("{}", { status: 503 }), wai: "ok" });
    await sync(h);
    await owner.patch(`/api/v1/orgs/${orgId}/ai/preferences`, { strategy: "openrouter_free_router" });
    const r = await ask(owner, orgId);
    expect(r.json.message.provider).toBe("workers_ai");
    expect(r.json.message.fallback).toBe(true);
    expect(chatCalls).toHaveLength(1);
  });

  it("malformed JSON and empty content count as model failures", async () => {
    let n = 0;
    const { h, owner, orgId } = await setup({ chat: () => (n++ === 0 ? new Response("not json", { status: 200 }) : Response.json({ choices: [{ message: { content: "" } }] })) });
    await sync(h);
    const r = await ask(owner, orgId);
    expect(r.status).toBe(503);
    const codes = (await h.db.prepare("SELECT error_code FROM ai_invocations WHERE provider = 'openrouter' ORDER BY created_at").all<{ error_code: string }>()).results.map((x) => x.error_code);
    expect(codes).toEqual(["invalid_json", "empty"]);
  });

  it("without OPENROUTER_API_KEY nothing is called and Workers AI answers", async () => {
    const { h, owner, orgId, chatCalls } = await setup({ key: false, wai: "ok" });
    await sync(h);
    const r = await ask(owner, orgId);
    expect(r.json.message.provider).toBe("workers_ai");
    expect(chatCalls).toHaveLength(0);
  });

  it("when everything fails: 503 with an honest message and the credit is released", async () => {
    const { h, owner, orgId } = await setup({ chat: () => new Response("{}", { status: 429 }), wai: "fail" });
    await sync(h);
    const before = (await owner.get(`/api/v1/orgs/${orgId}/billing`)).json.balance;
    const r = await ask(owner, orgId);
    expect(r.status).toBe(503);
    expect((await owner.get(`/api/v1/orgs/${orgId}/billing`)).json.balance).toBe(before);
  });
});

describe("Shared free quota (global key + per organisation + per user)", () => {
  it("the global daily budget is shared by ALL tenants and never exceeded", async () => {
    const { h, owner, orgId, chatCalls } = await setup();
    h.env.OPENROUTER_DAILY_REQUESTS = "3";
    await sync(h);
    const other = await h.signup("otra@empresa.es");
    const otherOrg = await h.createOrg(other, "Otra");
    await ask(owner, orgId);
    await ask(owner, orgId);
    await ask(other, otherOrg);
    const r = await ask(other, otherOrg);
    expect(r.status).toBe(503);
    expect(r.json.code).toBe("ai_unavailable");
    expect(chatCalls).toHaveLength(3);
  });

  it("per-organisation and per-user daily limits apply", async () => {
    const { h, owner, orgId, chatCalls } = await setup();
    h.env.OPENROUTER_USER_DAILY = "1";
    await sync(h);
    await ask(owner, orgId);
    const r = await ask(owner, orgId);
    expect(r.status).toBe(503);
    expect(chatCalls).toHaveLength(1);
    const usage = await owner.get(`/api/v1/orgs/${orgId}/ai/usage`);
    expect(usage.json.quotaToday.user).toEqual({ used: 1, limit: 1 });
  });

  it("concurrent requests cannot exceed the global budget", async () => {
    const { h, owner, orgId, chatCalls } = await setup();
    h.env.OPENROUTER_DAILY_REQUESTS = "2";
    h.env.OPENROUTER_USER_DAILY = "50";
    await sync(h);
    await Promise.all(Array.from({ length: 6 }, () => ask(owner, orgId)));
    expect(chatCalls.length).toBeLessThanOrEqual(2);
    const used = await h.db.prepare("SELECT count FROM ai_quota_counters WHERE scope = 'or:global:day'").first<{ count: number }>();
    expect(used!.count).toBeLessThanOrEqual(2);
  });

  it("OpenRouter-reported allowance caps the planned budget (limit - 5 margin)", async () => {
    const { h, owner, orgId } = await setup();
    const { refreshKeyInfo } = await import("../src/lib/openrouter");
    await refreshKeyInfo(h.env, h.deps);
    const st = await owner.get(`/api/v1/orgs/${orgId}/ai/provider-status`);
    expect(st.json.openrouter.quota).toMatchObject({ dailyLimit: 45, source: "reported_by_openrouter" });
  });

  it("a rise in the key's billed usage halts OpenRouter", async () => {
    const { h, owner, orgId } = await setup();
    const { refreshKeyInfo } = await import("../src/lib/openrouter");
    await refreshKeyInfo(h.env, h.deps); // baseline 0
    const real = h.deps.fetchImpl;
    h.deps.fetchImpl = (async (i: RequestInfo | URL, init?: RequestInit) =>
      String(i) === "https://openrouter.ai/api/v1/key" ? Response.json({ data: { usage: 0.01 } }) : real(i, init)) as typeof fetch;
    await refreshKeyInfo(h.env, h.deps);
    expect((await owner.get(`/api/v1/orgs/${orgId}/ai/provider-status`)).json.openrouter.halted.reason).toBe("gasto_detectado_en_la_clave");
  });
});

describe("Preferences, kill switches and permissions", () => {
  it("cloudflare_only never calls OpenRouter; the tenant switch disables it without redeploy", async () => {
    const { h, owner, orgId, chatCalls } = await setup({ wai: "fail" });
    await sync(h);
    await owner.patch(`/api/v1/orgs/${orgId}/ai/preferences`, { strategy: "cloudflare_only" });
    expect((await ask(owner, orgId)).status).toBe(503);
    expect(chatCalls).toHaveLength(0);
  });

  it("automatic: with Workers AI answering, OpenRouter is not called at all", async () => {
    const { h, owner, orgId, chatCalls } = await setup({ wai: "ok" });
    await sync(h);
    await owner.patch(`/api/v1/orgs/${orgId}/ai/preferences`, { strategy: "cloudflare_only" });
    expect((await ask(owner, orgId)).json.message.provider).toBe("workers_ai");
    await owner.patch(`/api/v1/orgs/${orgId}/ai/preferences`, { strategy: "automatic_free", openrouterEnabled: false });
    expect((await ask(owner, orgId)).json.message.provider).toBe("workers_ai");
    expect(chatCalls).toHaveLength(0);
  });

  it("privacy-first asks OpenRouter for no data collection and skips Gemini", async () => {
    const { h, owner, orgId, chatCalls } = await setup();
    await sync(h);
    await owner.patch(`/api/v1/orgs/${orgId}/ai/preferences`, { strategy: "automatic_free", privacyFirst: true });
    await ask(owner, orgId);
    expect(chatCalls[0]!.body.provider).toMatchObject({ data_collection: "deny", zdr: true, max_price: { prompt: 0 } });
  });

  it("manual model + policy 'ask': failure returns selected_model_failed, and the user can consent to fallback", async () => {
    const { h, owner, orgId } = await setup({ chat: () => new Response("{}", { status: 500 }), wai: "ok" });
    await sync(h);
    await owner.patch(`/api/v1/orgs/${orgId}/ai/preferences`, { strategy: "manual_free", manualModelId: FREE_B, fallbackPolicy: "ask" });
    const r = await ask(owner, orgId);
    expect(r.status).toBe(503);
    expect(r.json.code).toBe("selected_model_failed");
    const r2 = await ask(owner, orgId, { allowFallback: true });
    expect(r2.status).toBe(200);
    expect(r2.json.message.provider).toBe("workers_ai");
  });

  it("only owner/admin/marketing manager can change AI preferences; editors and viewers cannot", async () => {
    const { h, owner, orgId } = await setup();
    await sync(h);
    const editor = await h.invite(owner, orgId, "editor@luna.es", "editor");
    const viewer = await h.invite(owner, orgId, "viewer@luna.es", "client_viewer");
    expect((await editor.patch(`/api/v1/orgs/${orgId}/ai/preferences`, { strategy: "cloudflare_only" })).status).toBe(403);
    expect((await viewer.get(`/api/v1/orgs/${orgId}/ai/models`)).status).toBe(403);
    expect((await editor.get(`/api/v1/orgs/${orgId}/ai/models`)).status).toBe(200);
  });

  it("usage is tenant-isolated", async () => {
    const { h, owner, orgId } = await setup();
    await sync(h);
    await ask(owner, orgId);
    const intruder = await h.signup("intruso@otra.es");
    const otherOrg = await h.createOrg(intruder, "Otra");
    expect((await intruder.get(`/api/v1/orgs/${orgId}/ai/usage`)).status).toBe(404);
    expect((await intruder.get(`/api/v1/orgs/${otherOrg}/ai/usage`)).json.recent).toHaveLength(0);
  });

  it("platform admin endpoints are invisible (404) to normal users and work for platform admins", async () => {
    const { h, owner } = await setup();
    expect((await owner.post("/api/v1/admin/ai/models/sync")).status).toBe(404);
    expect((await owner.get("/api/v1/admin/ai/overview")).status).toBe(404);
    h.env.PLATFORM_ADMIN_EMAILS = "owner@luna.es";
    const s = await owner.post("/api/v1/admin/ai/models/sync");
    expect(s.status).toBe(200);
    expect(s.json.eligible).toBe(3);
    expect((await owner.post("/api/v1/admin/ai/openrouter/kill-switch", { enabled: false })).json).toEqual({ enabled: false });
    expect((await owner.get("/api/v1/auth/me")).json.user.isPlatformAdmin).toBe(true);
  });

  it("global kill switch stops OpenRouter for every tenant without redeploy", async () => {
    const { h, owner, orgId, chatCalls } = await setup();
    h.env.PLATFORM_ADMIN_EMAILS = "owner@luna.es";
    await sync(h);
    await owner.post("/api/v1/admin/ai/openrouter/kill-switch", { enabled: false });
    expect((await ask(owner, orgId)).status).toBe(503);
    expect(chatCalls).toHaveLength(0);
    await owner.post("/api/v1/admin/ai/openrouter/kill-switch", { enabled: true });
    expect((await ask(owner, orgId)).json.message.provider).toBe("openrouter");
  });

  it("opt-in health check: one tiny request per model, refused for non-free models", async () => {
    const { h, owner, chatCalls } = await setup();
    h.env.PLATFORM_ADMIN_EMAILS = "owner@luna.es";
    await sync(h);
    expect((await owner.post("/api/v1/admin/ai/models/health-check", { modelId: PAID })).status).toBe(422);
    const r = await owner.post("/api/v1/admin/ai/models/health-check", { modelId: FREE_A });
    expect(r.json).toMatchObject({ ok: true, reportedCostUsd: 0 });
    // Small, bounded budget even for a reasoning model (16 × 3 + classification headroom of 200); still free.
    expect(chatCalls[0]!.body.max_tokens).toBeLessThanOrEqual(248);
    expect((await owner.post("/api/v1/admin/ai/models/health-check", { modelId: FREE_A })).status).toBe(429);
    expect(chatCalls).toHaveLength(1);
  });
});

describe("Single chokepoint: the only code that can reach OpenRouter chat", () => {
  it("only lib/openrouter.ts builds a chat request; only ai.ts and admin.ts call it", async () => {
    const { readdirSync, readFileSync, statSync } = await import("node:fs");
    const { join } = await import("node:path");
    const walk = (d: string): string[] => readdirSync(d).flatMap((f) => (statSync(join(d, f)).isDirectory() ? walk(join(d, f)) : [join(d, f)]));
    const files = walk(join(__dirname, "../src")).filter((f) => f.endsWith(".ts"));
    const rel = (f: string) => f.replace(/\\/g, "/").split("/src/")[1];
    const src = (f: string) => readFileSync(f, "utf8");
    expect(files.filter((f) => /OPENROUTER_API\}\/chat\/completions/.test(src(f))).map(rel)).toEqual(["lib/openrouter.ts"]);
    // The only other chat-completions endpoint is Groq's (optional free fallback in lib/ai.ts).
    expect(files.filter((f) => /chat\/completions/.test(src(f))).map(rel).sort()).toEqual(["lib/ai.ts", "lib/openrouter.ts"]);
    expect(files.filter((f) => /callOpenRouterChat\(/.test(src(f))).map(rel).sort()).toEqual(["lib/ai.ts", "lib/openrouter.ts", "routes/admin.ts"]);
    // No other module performs fetches with the OpenRouter key
    expect(files.filter((f) => /OPENROUTER_API_KEY\}/.test(src(f))).map(rel)).toEqual(["lib/openrouter.ts"]);
  });

  it("callOpenRouterChat itself refuses any non-allowlisted id without touching the network", async () => {
    const { callOpenRouterChat } = await import("../src/lib/openrouter");
    const { h, chatCalls } = await setup();
    await sync(h);
    for (const id of [PAID, "vendor-c/hidden-fee:free", "vendor-c/no-pricing:free", "unknown/model:free", "openai/gpt-x", ZERO_NOT_FREE, "vendor-d/image-gen:free"]) {
      await expect(
        callOpenRouterChat(h.env, h.deps, id, "advisor_chat", [{ role: "user", content: "hola" }], { maxTokens: 50, temperature: 0, privacyFirst: false }),
      ).rejects.toMatchObject({ scope: "model" });
    }
    expect(chatCalls).toHaveLength(0);
  });
});

describe("Privacy guard: sensitive data never reaches free third-party providers", () => {
  it("a question with a DNI, IBAN or password is answered by Workers AI only (no OpenRouter, no Gemini)", async () => {
    const { h, owner, orgId, chatCalls, waiCalls } = await setup({ wai: "ok" });
    h.env.GEMINI_API_KEY = "test-gemini";
    const geminiCalls: string[] = [];
    const inner = h.deps.fetchImpl;
    h.deps.fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.includes("generativelanguage.googleapis.com")) geminiCalls.push(url);
      return inner(input, init);
    }) as typeof fetch;
    await sync(h);
    for (const question of [
      "Mi DNI es 12345678Z, ¿puedo ponerlo en la web?",
      "Factura a ES91 2100 0418 4502 0005 1332, ¿la incluyo?",
      "La contraseña: Hunter2024! ¿es segura para el CMS?",
    ]) {
      const r = await owner.post(`/api/v1/orgs/${orgId}/advisor`, { question });
      expect(r.status).toBe(200);
      expect(r.json.message.provider).toBe("workers_ai");
    }
    expect(chatCalls).toHaveLength(0);
    expect(geminiCalls).toHaveLength(0);
    expect(waiCalls.length).toBeGreaterThanOrEqual(3);
    const logs = await h.db.prepare("SELECT error_code FROM ai_invocations WHERE status = 'skipped' AND error_code LIKE 'sensitive_data:%'").all<{ error_code: string }>();
    expect(logs.results.map((x) => x.error_code)).toEqual(["sensitive_data:dni_nie", "sensitive_data:iban", "sensitive_data:credencial"]);
    // The raw sensitive value is never written to the AI activity log.
    const dump = JSON.stringify((await h.db.prepare("SELECT * FROM ai_invocations").all()).results);
    expect(dump).not.toMatch(/12345678Z|ES91|Hunter2024/);
  });

  it("an ordinary marketing question can still use the free OpenRouter route when Workers AI is unavailable", async () => {
    const { h, owner, orgId, chatCalls } = await setup();
    await sync(h);
    const r = await owner.post(`/api/v1/orgs/${orgId}/advisor`, { question: "¿Cómo mejoro el SEO local de mi panadería con 3 tiendas y 120 reseñas?" });
    expect(r.json.message.provider).toBe("openrouter");
    expect(chatCalls).toHaveLength(1);
  });
});

describe("Reasoning models", () => {
  it("asks reasoning models for low effort with headroom so answers are not truncated to empty", async () => {
    const { h, owner, orgId, chatCalls } = await setup();
    await sync(h);
    await owner.patch(`/api/v1/orgs/${orgId}/ai/preferences`, { strategy: "manual_free", manualModelId: FREE_A });
    const r = await ask(owner, orgId);
    expect(r.json.message.provider).toBe("openrouter");
    const body = chatCalls[0]!.body as { max_tokens: number; reasoning?: { effort: string; exclude: boolean }; provider: { max_price: Record<string, number> } };
    expect(body.reasoning).toEqual({ effort: "low", exclude: true });
    expect(body.max_tokens).toBeGreaterThan(900);
    expect(body.provider.max_price).toEqual({ prompt: 0, completion: 0, request: 0, image: 0 });
  });

  it("non-reasoning models keep the task budget and get no reasoning parameter", async () => {
    const { h, owner, orgId, chatCalls } = await setup();
    await sync(h);
    await owner.patch(`/api/v1/orgs/${orgId}/ai/preferences`, { strategy: "manual_free", manualModelId: FREE_B });
    await ask(owner, orgId);
    const body = chatCalls[0]!.body as { max_tokens: number; reasoning?: unknown };
    expect(body.reasoning).toBeUndefined();
    expect(body.max_tokens).toBeLessThanOrEqual(1800);
  });
});
