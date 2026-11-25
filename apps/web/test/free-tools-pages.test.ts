import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { FREE_TOOLS } from "@dni/core/free-tools";
import { SITE_PAGES } from "../../api/src/routes/site-blog";

const web = (p: string) => resolve(import.meta.dirname, "..", p);
const vite = readFileSync(web("vite.config.ts"), "utf8");

describe("/herramientas", () => {
  it("every tool has its page, its build entry, the sitemap entry and a card on the hub", () => {
    const hub = readFileSync(web("herramientas.html"), "utf8");
    expect(vite).toContain('herramientas: resolve(import.meta.dirname, "herramientas.html")');
    expect(SITE_PAGES).toContain("/herramientas");
    for (const t of FREE_TOOLS) {
      const file = web(`herramientas/${t.slug}.html`);
      expect(existsSync(file), t.slug).toBe(true);
      const html = readFileSync(file, "utf8");
      expect(html).toContain(`data-tool="${t.slug}"`);
      expect(html).toContain(`<link rel="canonical" href="__SITE_URL__/herramientas/${t.slug}" />`);
      expect(html).toContain('"@type": "WebApplication"');
      expect(html).toContain('href="/#auditar"'); // ends with the call to the free audit
      expect(html).toContain("/src/landing/tools.ts");
      expect(html).not.toMatch(/noindex/);
      expect(vite).toContain(`"herramientas/${t.slug}": resolve(import.meta.dirname, "herramientas/${t.slug}.html")`);
      expect(SITE_PAGES).toContain(`/herramientas/${t.slug}`);
      expect(hub).toContain(`href="/herramientas/${t.slug}"`);
    }
  });

  it("titles and descriptions fit in Google's results (our own audit checks the same)", () => {
    const decode = (x: string) => x.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#x27;|&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
    for (const f of ["herramientas.html", ...FREE_TOOLS.map((t) => `herramientas/${t.slug}.html`)]) {
      const html = readFileSync(web(f), "utf8");
      const title = decode(html.match(/<title>([^<]*)<\/title>/)![1]!);
      const desc = decode(html.match(/<meta name="description" content="([^"]*)"/)![1]!);
      expect(title.length, f).toBeLessThanOrEqual(65);
      expect(desc.length, f).toBeLessThanOrEqual(160);
    }
  });

  it("the browser script wires every tool and never writes user text as HTML", () => {
    const src = readFileSync(web("src/landing/tools.ts"), "utf8");
    for (const t of FREE_TOOLS) expect(src).toContain(`"${t.slug}"`);
    expect(src).not.toMatch(/innerHTML|insertAdjacentHTML|outerHTML/);
  });
});
