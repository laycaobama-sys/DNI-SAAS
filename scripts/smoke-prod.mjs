// Nightly production smoke test (read-only, anonymous): public pages, /estado checks, pricing status and one free tool.
// Usage: node scripts/smoke-prod.mjs [origin]  (default https://dnigrowth.com). Exits 1 on any failure.
// It never logs in, never pays and never writes customer data; the free-tool call counts against the normal public limits.
const origin = (process.argv[2] ?? process.env.SMOKE_ORIGIN ?? "https://dnigrowth.com").replace(/\/$/, "");
const UA = "DNIGrowthSmoke/1.0 (+https://dnigrowth.com/estado)";
const failures = [];
const ok = (cond, msg) => {
  if (!cond) failures.push(msg);
  console.log(`${cond ? "✓" : "✗"} ${msg}`);
};
const get = (path, init = {}) => fetch(origin + path, { redirect: "manual", ...init, headers: { "user-agent": UA, ...(init.headers ?? {}) } });

const PAGES = [
  "/",
  "/precios",
  "/herramientas",
  "/herramientas/preparada-para-ia",
  "/seo-con-ia",
  "/geo-posicionar-en-chatgpt",
  "/auditoria-seo-gratis",
  "/sectores/clinicas",
  "/comparativa/babylovegrowth",
  "/guia-como-aparecer-en-chatgpt",
  "/blog",
  "/estado",
  "/seguridad",
  "/legal/privacidad",
  "/legal/condiciones",
  "/robots.txt",
  "/sitemap.xml",
  "/llms.txt",
  "/app/login",
];

for (const p of PAGES) {
  const r = await get(p);
  ok(r.status === 200, `${p} → ${r.status}`);
  if (p === "/" && r.status === 200) {
    const html = await r.text();
    ok(!html.includes("fonts.googleapis.com"), "la portada no carga fuentes de Google");
    ok(/<title>[^<]{10,65}<\/title>/.test(html), "la portada tiene un título de 10–65 caracteres");
  }
}
ok((await get("/guia/contenido")).status === 404, "la guía no se sirve sin enlace confirmado");

const status = await (await get("/api/v1/public/status")).json();
for (const c of status.checks ?? []) ok(c.ok !== false, `/estado · ${c.label}: ${c.detail ?? (c.ok ? "ok" : "sin datos")}`);
ok((status.checks ?? []).length >= 9, `/estado tiene ${(status.checks ?? []).length} comprobaciones`);

const pricing = await (await get("/api/v1/public/pricing-status")).json();
ok(pricing.paymentsOpen === true, "los pagos están abiertos");

const tool = await get("/api/v1/public/tools/ai-readiness", {
  method: "POST",
  headers: { "content-type": "application/json", origin },
  body: JSON.stringify({ url: origin + "/" }),
});
const t = tool.status === 200 ? await tool.json() : null;
ok(tool.status === 200 && t && t.ok === t.total, `herramienta «preparada para IA» con dnigrowth.com: ${t ? `${t.ok}/${t.total}` : tool.status}`);

if (failures.length) {
  console.error(`\n${failures.length} comprobación(es) fallida(s).`);
  process.exit(1);
}
console.log("\nTodo correcto.");
