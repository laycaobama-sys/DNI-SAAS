import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { SITE_PAGES } from "../../api/src/routes/site-blog";

const web = (p: string) => resolve(import.meta.dirname, "..", p);
const PAGES = ["seo-con-ia", "geo-posicionar-en-chatgpt", "auditoria-seo-gratis", "seo-wordpress", "seo-shopify", "para-agencias", "sectores/clinicas", "sectores/despachos", "sectores/ecommerce", "sectores/restaurantes", "sectores/inmobiliarias", "sectores/reformas"];

describe("product and sector landing pages", () => {
  const vite = readFileSync(web("vite.config.ts"), "utf8");
  const home = readFileSync(web("index.html"), "utf8");
  for (const slug of PAGES) {
    it(`/${slug} is built, in the sitemap, linked from the home page and indexable`, () => {
      expect(existsSync(web(`${slug}.html`))).toBe(true);
      const html = readFileSync(web(`${slug}.html`), "utf8");
      expect(vite).toContain(`"${slug}": resolve(import.meta.dirname, "${slug}.html")`);
      expect(SITE_PAGES).toContain(`/${slug}`);
      expect(home).toContain(`href="/${slug}"`);
      expect(html).toContain(`<link rel="canonical" href="__SITE_URL__/${slug}" />`);
      expect(html).not.toMatch(/noindex/);
      expect(html.match(/<h1>/g)).toHaveLength(1);
      expect(html).toContain('"@type": "FAQPage"');
      expect(html).toContain('href="/#auditar"');
      const title = html.match(/<title>([^<]*)<\/title>/)![1]!.replace(/&amp;/g, "&");
      const desc = html.match(/<meta name="description" content="([^"]*)"/)![1]!;
      expect(title.length).toBeLessThanOrEqual(65);
      expect(desc.length).toBeLessThanOrEqual(160);
      // Honesty: no guaranteed rankings or invented results.
      expect(html).not.toMatch(/garantizamos|garantizado el|primera posición asegurada|resultados garantizados/i);
      expect(html).toContain("Nadie puede garantizar una posición en Google");
    });
  }
  it("/comparativa/babylovegrowth cites a source and the date for each fact and says where the other tool is ahead", () => {
    const html = readFileSync(web("comparativa/babylovegrowth.html"), "utf8");
    expect(vite).toContain('"comparativa/babylovegrowth"');
    expect(SITE_PAGES).toContain("/comparativa/babylovegrowth");
    expect(html).toContain("comprobados el 25 de noviembre de 2026");
    const rows = html.match(/<tr><th scope="row">/g) ?? [];
    const sourced = html.match(/<tr><th scope="row">[^]*?https:\/\/www\.babylovegrowth\.ai[^]*?<\/tr>/g) ?? [];
    expect(rows.length).toBeGreaterThanOrEqual(10);
    expect(sourced.length).toBe(rows.length);
    expect(html).toContain("Dónde BabyLoveGrowth va por delante hoy");
    expect(html).toContain('rel="nofollow noopener noreferrer"');
  });

  it("Shopify publishing is not sold as available", () => {
    const html = readFileSync(web("seo-shopify.html"), "utf8");
    expect(html).toContain("En desarrollo:</strong> la publicación directa en Shopify");
  });
});
