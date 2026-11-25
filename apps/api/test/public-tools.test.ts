import { describe, expect, it } from "vitest";
import { createHarness } from "./helpers";

const BASE = "/api/v1/public/tools";
const HOME = `<html lang="es"><head><title>Taller Sol</title><meta name="description" content="Taller en Madrid">
<meta property="og:title" content="Taller Sol"><meta property="og:image" content="/og.png"></head>
<body><h1>Taller mecánico en Madrid</h1><h2>Cambio de aceite</h2><p>Reparamos coches.</p>
<a href="/ok">ok</a><a href="/roto">roto</a><a href="/mueve">mueve</a><a href="http://10.0.0.1/admin">interno</a></body></html>`;
const png = (w: number, h: number) => {
  const b = new Uint8Array(32);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const v = new DataView(b.buffer);
  v.setUint32(16, w);
  v.setUint32(20, h);
  return b;
};

function harness() {
  const h = createHarness({
    site: {
      "https://taller-sol.es/": { body: HOME },
      "https://taller-sol.es/ok": { body: "ok" },
      "https://taller-sol.es/mueve": { status: 301, location: "/ok" },
      "https://taller-sol.es/robots.txt": { body: "User-agent: PerplexityBot\nDisallow: /", type: "text/plain" },
      "https://rival.es/": { body: `<html><head><title>Taller con coche de sustitución</title></head><body><h1>Coche de sustitución gratis</h1><h2>Revisión ITV</h2><p>Coche de sustitución y revisión ITV.</p></body></html>` },
    },
    dns: { "intranet.example": ["10.1.2.3"] },
  });
  const site = h.deps.fetchImpl;
  h.deps.fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url === "https://taller-sol.es/og.png") return new Response(png(600, 315), { headers: { "content-type": "image/png" } });
    return site(input, init);
  }) as typeof fetch;
  return h;
}

describe("free tools that read a public page", () => {
  it("checks the share image: size and missing tags", async () => {
    const h = harness();
    const r = await new h.Client().post(`${BASE}/og-image`, { url: "taller-sol.es" });
    expect(r.status).toBe(200);
    expect(r.json.image.url).toBe("https://taller-sol.es/og.png");
    expect(r.json.image.info).toMatchObject({ format: "png", width: 600, height: 315 });
    expect(r.json.image.problems.join(" ")).toContain("1200×630");
    expect(r.json.problems.join(" ")).toContain("twitter:card");
  });

  it("lists links and checks them in batches without following redirects", async () => {
    const h = harness();
    const c = new h.Client();
    const l = await c.post(`${BASE}/links`, { url: "https://taller-sol.es/" });
    expect(l.status).toBe(200);
    expect(l.json.links.map((x: { url: string }) => x.url)).toContain("https://taller-sol.es/roto");
    const r = await c.post(`${BASE}/links/check`, { urls: ["https://taller-sol.es/ok", "https://taller-sol.es/roto", "https://taller-sol.es/mueve", "http://10.0.0.1/admin"] });
    expect(r.status).toBe(200);
    const v = Object.fromEntries(r.json.results.map((x: { url: string; verdict: string }) => [x.url, x.verdict]));
    expect(v).toEqual({ "https://taller-sol.es/ok": "ok", "https://taller-sol.es/roto": "broken", "https://taller-sol.es/mueve": "redirect", "http://10.0.0.1/admin": "error" });
    // The private address was never requested.
    expect(h.fetchLog.some((u) => u.includes("10.0.0.1"))).toBe(false);
    expect((await c.post(`${BASE}/links/check`, { urls: Array.from({ length: 11 }, (_, i) => `https://taller-sol.es/${i}`) })).status).toBe(422);
  });

  it("finds the competitor's keywords you are missing", async () => {
    const h = harness();
    const r = await new h.Client().post(`${BASE}/keyword-gap`, { mine: "taller-sol.es", competitor: "https://rival.es/" });
    expect(r.status).toBe(200);
    const terms = r.json.missing.map((m: { term: string }) => m.term);
    expect(terms).toContain("coche sustitucion");
    expect(terms).toContain("revision itv");
  });

  it("reports readiness for AI assistants from the page, robots.txt and llms.txt", async () => {
    const h = harness();
    const r = await new h.Client().post(`${BASE}/ai-readiness`, { url: "taller-sol.es" });
    expect(r.status).toBe(200);
    const by = Object.fromEntries(r.json.checks.map((c: { key: string; state: string }) => [c.key, c.state]));
    expect(by.robots).toBe("bad");
    expect(by.llms).toBe("warn");
    expect(by.https).toBe("ok");
  });

  it("refuses private targets, other origins and too many requests", async () => {
    const h = harness();
    const c = new h.Client();
    expect((await c.post(`${BASE}/og-image`, { url: "http://127.0.0.1/" })).status).toBe(422);
    const dns = await c.post(`${BASE}/og-image`, { url: "https://intranet.example/" });
    expect(dns.status).toBe(422);
    expect(h.fetchLog.some((u) => u.includes("intranet"))).toBe(false);
    expect((await c.post(`${BASE}/og-image`, { url: "taller-sol.es" }, { origin: "https://evil.example" })).status).toBe(403);
    const ip = { "cf-connecting-ip": "198.51.100.77" };
    let last = 0;
    for (let i = 0; i < 31; i++) last = (await c.post(`${BASE}/links/check`, { urls: ["https://taller-sol.es/ok"] }, ip)).status;
    expect(last).toBe(429);
  });
});
