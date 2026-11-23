import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { canonicalRedirect } from "../src/app";
import { FALLBACK_404_HTML, SITE_CSP, SITE_SECURITY_HEADERS } from "../src/lib/site-headers";
import { SITE_PAGES } from "../src/routes/site-blog";
import { createHarness } from "./helpers";

/** Public site: one CSP everywhere (Fase 0.3), /seguridad (0.10) and the custom 404 (0.9). */

const WEB = join(import.meta.dirname, "..", "..", "web");
const read = (p: string) => readFileSync(join(WEB, p), "utf8");
const PAGES = ["index.html", "blog.html", "seguridad.html", "precios.html", "404.html", ...readdirSync(join(WEB, "legal")).filter((f) => f.endsWith(".html")).map((f) => `legal/${f}`)];

/** Headers of the `/*` block of apps/web/public/_headers, lower-cased names. */
function headersFileBlock(): Record<string, string> {
  const lines = read("public/_headers").split(/\r?\n/);
  const start = lines.findIndex((l) => l.trim() === "/*");
  const out: Record<string, string> = {};
  for (const l of lines.slice(start + 1)) {
    if (!l.trim()) break;
    const i = l.indexOf(":");
    out[l.slice(0, i).trim().toLowerCase()] = l.slice(i + 1).trim();
  }
  return out;
}

/** Fake Workers Static Assets with not_found_handling «404-page» and auto-trailing-slash HTML handling. */
function fakeAssets(files: Record<string, string>) {
  const fetched: string[] = [];
  const binding = {
    fetch: async (input: RequestInfo | URL) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);
      fetched.push(url.pathname);
      const body = files[url.pathname];
      if (body !== undefined) return new Response(body, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } });
      return new Response(files["/404"] ?? "", { status: 404, headers: { "content-type": "text/html; charset=utf-8" } });
    },
  };
  return { binding: binding as unknown as Fetcher, fetched };
}

describe("one Content-Security-Policy for the whole public site", () => {
  it("_headers (pages served by Static Assets) and the Worker (pages it renders) send the same headers", () => {
    expect(headersFileBlock()).toEqual(SITE_SECURITY_HEADERS);
  });

  it("allows Cloudflare Web Analytics only if a page loads its beacon, and pages need nothing the CSP blocks", () => {
    const html = PAGES.map((p) => [p, read(p)] as const);
    const loadsBeacon = html.some(([, h]) => h.includes("static.cloudflareinsights.com"));
    expect(SITE_CSP.includes("cloudflareinsights.com")).toBe(loadsBeacon);
    for (const [page, h] of html) {
      // script-src 'self': no third-party script, no executable inline script, no inline handlers.
      for (const m of h.matchAll(/<script\b([^>]*)>/gi)) {
        const attrs = m[1] ?? "";
        const src = /\ssrc="([^"]+)"/.exec(attrs)?.[1];
        if (src) expect(src, `${page}: ${src}`).toMatch(/^\/(?!\/)/);
        else expect(attrs, `${page}: inline script`).toMatch(/type="application\/ld\+json"/);
      }
      expect(h, `${page}: inline event handler`).not.toMatch(/<[^>]+\son[a-z]+\s*=\s*["']/i);
      // Stylesheets only from our origin or Google Fonts (style-src).
      for (const m of h.matchAll(/<link\b[^>]*rel="stylesheet"[^>]*href="([^"]+)"/gi)) expect(m[1], page).toMatch(/^(\/(?!\/)|https:\/\/fonts\.googleapis\.com\/)/);
    }
  });

  it("the blog and the app shell carry the same CSP as the static pages", async () => {
    const h = createHarness();
    const { binding } = fakeAssets({ "/app/": "<!doctype html><div id=root></div>" });
    h.env.ASSETS = binding;
    const blog = await h.app.request("/blog", {}, h.env, h.ctx);
    expect(blog.status).toBe(200);
    for (const [k, v] of Object.entries(SITE_SECURITY_HEADERS)) expect(blog.headers.get(k), k).toBe(v);
    const app = await h.app.request("/app/o/x/crm", {}, h.env, h.ctx);
    expect(app.status).toBe(200);
    expect(app.headers.get("content-security-policy")).toBe(SITE_CSP);
    expect(app.headers.get("x-robots-tag")).toBe("noindex, nofollow");
  });
});

describe("/seguridad", () => {
  it("is listed in the sitemap and has one canonical URL", async () => {
    expect(SITE_PAGES).toContain("/seguridad");
    const h = createHarness();
    const map = await h.app.request("/sitemap.xml", {}, h.env, h.ctx);
    expect(await map.text()).toContain("<loc>http://localhost:8787/seguridad</loc>");
    const canon = new URL("https://dnigrowth.com");
    expect(canonicalRedirect(new URL("https://dnigrowth.com/seguridad.html"), canon)).toBe("https://dnigrowth.com/seguridad");
    expect(canonicalRedirect(new URL("https://dnigrowth.com/seguridad/"), canon)).toBe("https://dnigrowth.com/seguridad");
    expect(canonicalRedirect(new URL("https://www.dnigrowth.com/seguridad"), canon)).toBe("https://dnigrowth.com/seguridad");
    expect(canonicalRedirect(new URL("https://dnigrowth.com/seguridad"), canon)).toBeNull();
  });

  it("is served from the built assets like the other static pages", async () => {
    const h = createHarness();
    h.env.ASSETS = fakeAssets({ "/seguridad": "<h1>Seguridad y confianza</h1>" }).binding;
    const res = await h.app.request("/seguridad", {}, h.env, h.ctx);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("Seguridad y confianza");
  });
});

describe("custom 404 for unknown public pages", () => {
  const LINKS = ['href="/"', 'href="/app/register"', 'href="/blog"', 'href="/#precios"', 'href="/#contacto"'];

  async function expectNotFound(res: Response, marker: string) {
    expect(res.status).toBe(404);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(res.headers.get("x-robots-tag")).toBe("noindex");
    expect(res.headers.get("cache-control")).toBe("no-store");
    for (const [k, v] of Object.entries(SITE_SECURITY_HEADERS)) expect(res.headers.get(k), k).toBe(v);
    const body = await res.text();
    expect(body).toContain(marker);
    return body;
  }

  it("answers 404 with the site page, noindex and the same security headers", async () => {
    const h = createHarness();
    const page404 = '<!doctype html><meta name="robots" content="noindex"><main data-not-found><h1>Esta página no existe</h1></main>';
    const { binding, fetched } = fakeAssets({ "/": "<h1>Inicio</h1>", "/404": page404, "/app/": "<div id=root></div>" });
    h.env.ASSETS = binding;
    await expectNotFound(await h.app.request("/precios-viejos", {}, h.env, h.ctx), "Esta página no existe");
    await expectNotFound(await h.app.request("/legal/no-existe", {}, h.env, h.ctx), "Esta página no existe");
    // The 404 page itself is never a 200 page.
    await expectNotFound(await h.app.request("/404", {}, h.env, h.ctx), "Esta página no existe");
    await expectNotFound(await h.app.request("/404.html", {}, h.env, h.ctx), "Esta página no existe");
    expect(fetched).toContain("/404");
    const head = await h.app.request("/no-existe", { method: "HEAD" }, h.env, h.ctx);
    expect(head.status).toBe(404);
    expect(await head.text()).toBe("");
    // Known pages, the API and the SPA keep their own behaviour.
    expect((await h.app.request("/", {}, h.env, h.ctx)).status).toBe(200);
    const api = await h.app.request("/api/v1/no-existe", {}, h.env, h.ctx);
    expect(api.status).toBe(404);
    expect(api.headers.get("content-type")).toContain("application/problem+json");
    expect((await h.app.request("/app/ruta-de-la-spa", {}, h.env, h.ctx)).status).toBe(200);
  });

  it("falls back to the inline page when the built 404 is missing, with every way out", async () => {
    const noAssets = createHarness();
    const body = await expectNotFound(await noAssets.app.request("/no-existe", {}, noAssets.env, noAssets.ctx), "data-not-found");
    expect(body).toBe(FALLBACK_404_HTML);
    const emptyAssets = createHarness();
    emptyAssets.env.ASSETS = fakeAssets({}).binding;
    expect(await expectNotFound(await emptyAssets.app.request("/no-existe", {}, emptyAssets.env, emptyAssets.ctx), "data-not-found")).toBe(FALLBACK_404_HTML);
    expect(FALLBACK_404_HTML).toContain('<meta name="robots" content="noindex">');
    for (const l of LINKS) expect(FALLBACK_404_HTML).toContain(l);
  });

  it("dist/404.html (apps/web/404.html) is noindex, styled like the site and links the same ways out", () => {
    const page = read("404.html");
    expect(page).toContain('<meta name="robots" content="noindex" />');
    expect(page).toContain("data-not-found");
    expect(page).toContain("/src/landing/landing.css");
    expect(page).not.toMatch(/rel="canonical"/);
    for (const l of LINKS) expect(page).toContain(l);
  });
});
