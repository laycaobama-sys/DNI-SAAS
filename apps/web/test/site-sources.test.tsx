import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { FEATURE_STATUS_LABEL, FEATURES } from "@dni/core/features";
import { PLAN_LABEL, requiredPlan } from "@dni/core/plan-access";
import { MenuStatus, navFor } from "../src/app/shell";

/**
 * Public site sources (Fase 0): FEATURES is the single source for the landing badges, llms.txt and the app
 * menu; the landing shows no invented media, no jargon and no brand family outside /seguridad.
 */

const WEB = join(import.meta.dirname, "..");
const read = (p: string) => readFileSync(join(WEB, p), "utf8");
const stripComments = (h: string) => h.replace(/<!--[\s\S]*?-->/g, "");
const INDEX = read("index.html");
/** index.html without the pricing section (owned by the billing work) and without HTML comments. */
const LANDING = stripComments(INDEX.replace(/<section id="precios"[\s\S]*?<\/section>/, ""));
const PAGES = ["index.html", "blog.html", "seguridad.html", "404.html", ...readdirSync(join(WEB, "legal")).filter((f) => f.endsWith(".html")).map((f) => `legal/${f}`)];

const decode = (s: string) => s.replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">");

afterEach(() => cleanup());

describe("landing badges come from FEATURES", () => {
  const badges = [...INDEX.matchAll(/<span class="row-name">([^<]+)<\/span><span data-feature="([a-z]+)"([^>]*)>([^<]+)<\/span>/g)].map((m) => ({
    name: decode(m[1]!),
    key: m[2]!,
    title: /title="([^"]*)"/.exec(m[3]!)?.[1],
    text: m[4]!.trim(),
  }));

  it("lists every module once, with the registry's label, status and limit", () => {
    expect(badges.map((b) => b.key).sort()).toEqual(FEATURES.map((f) => f.key).sort());
    expect((INDEX.match(/data-feature="/g) ?? []).length).toBe(FEATURES.length);
    for (const f of FEATURES) {
      const b = badges.find((x) => x.key === f.key)!;
      expect(b.name, f.key).toBe(f.label);
      expect(b.text, f.key).toBe(FEATURE_STATUS_LABEL[f.status]);
      expect(b.title === undefined ? undefined : decode(b.title), f.key).toBe(f.limit);
    }
  });

  it("never shows a status label outside a module badge (pricing excluded)", () => {
    const labels = Object.values(FEATURE_STATUS_LABEL).join("|");
    const loose = [...LANDING.matchAll(new RegExp(`<([a-z0-9]+)([^>]*)>\\s*(${labels})\\s*</\\1>`, "g"))].filter((m) => !/data-feature=/.test(m[2]!));
    expect(loose.map((m) => m[0])).toEqual([]);
  });

  it("names the plan of each feature shown as working today exactly as the plan matrix does", () => {
    const spans = [...INDEX.matchAll(/<span data-plan-module="([a-z-]+)">([^<]+)<\/span>/g)];
    expect(spans.length).toBeGreaterThanOrEqual(4);
    for (const [, module, label] of spans) expect(label, module).toBe(PLAN_LABEL[requiredPlan(module!)]);
  });

  it("llms.txt is generated from FEATURES at build time, not written by hand", () => {
    const vite = read("vite.config.ts");
    expect(vite).toMatch(/import \{[^}]*buildLlmsTxt[^}]*\} from "[^"]*features"/);
    expect(vite).toContain('fileName: "llms.txt"');
    expect(vite).toContain("buildLlmsTxt(SITE_URL)");
    expect(existsSync(join(WEB, "public", "llms.txt"))).toBe(false);
    expect(vite).toMatch(/seguridad: resolve\([^)]*"seguridad\.html"\)/);
    expect(vite).toMatch(/notFound: resolve\([^)]*"404\.html"\)/);
  });
});

describe("app menu badges come from FEATURES", () => {
  it("every module FEATURES maps exists in the menu", () => {
    const menu = new Set(navFor("org").flatMap((g) => g.items.map((i) => i.module)));
    for (const f of FEATURES) for (const m of f.menu) expect(menu.has(m), `${f.key} → ${m}`).toBe(true);
  });

  it("marks partial modules and leaves available ones clean", () => {
    const ads = FEATURES.find((f) => f.key === "ads")!;
    const { container, unmount } = render(<MenuStatus module="ads" />);
    const badge = container.querySelector("[data-menu-status='ads']")!;
    expect(badge.getAttribute("title")).toBe(ads.limit);
    expect(badge.textContent).toBe(`${FEATURE_STATUS_LABEL.partial}: ${ads.limit}`);
    unmount();
    expect(render(<MenuStatus module="analyze" />).container.innerHTML).toBe("");
  });
});

describe("landing copy and media", () => {
  it("leads with the promise and four benefits, with the modules as a secondary section", () => {
    expect(INDEX).toMatch(/<h1[^>]*>\s*Más clientes desde Google y ChatGPT\. <em>Con pruebas\.<\/em>\s*<\/h1>/);
    expect((INDEX.match(/<li class="benefit[ "]/g) ?? []).length).toBe(4);
    expect(INDEX).not.toMatch(/data-count|class="stats?"/);
    expect(INDEX.indexOf('id="beneficios"')).toBeLessThan(INDEX.indexOf('id="ya-funciona"'));
    expect(INDEX.indexOf('id="ya-funciona"')).toBeLessThan(INDEX.indexOf('id="modulos"'));
    expect(INDEX).toMatch(/<section id="modulos" class="[^"]*modules-secondary/);
  });

  it("uses no internal jargon on the landing", () => {
    const text = LANDING.replace(/<script[\s\S]*?<\/script>/g, "").replace(/<[^>]+>/g, " ");
    for (const term of [/cola duradera/i, /\bledger\b/i, /\b9 roles\b/i, /se trata como dato/i, /\bRLS\b/, /idempoten/i, /\bSSRF\b/, /\boutbox\b/i, /multi-?tenant/i, /\bD1\b/]) expect(text).not.toMatch(term);
  });

  it("shows no image that does not exist and keeps empty screenshot and video slots hidden", () => {
    for (const page of PAGES) {
      for (const m of stripComments(read(page)).matchAll(/<img\b[^>]*\ssrc="([^"]+)"/g)) {
        const src = m[1]!;
        expect(src, `${page}: ${src}`).toMatch(/^\/(?!\/)/);
        expect(existsSync(join(WEB, "public", src)), `${page}: ${src} must exist`).toBe(true);
      }
    }
    const figures = [...LANDING.matchAll(/<figure class="shot"([^>]*)>([\s\S]*?)<\/figure>/g)];
    expect(figures.length).toBe(3);
    for (const [, attrs, inner] of figures) {
      const hasMedia = /<img\b/.test(inner!);
      expect(/\shidden\b/.test(attrs!), attrs).toBe(!hasMedia);
      if (hasMedia) expect(inner).toMatch(/<img\b[^>]*\swidth="\d+"[^>]*\sheight="\d+"/);
    }
    const demo = /<section id="demo"([^>]*)>/.exec(INDEX)![1]!;
    const src = /data-video-src="([^"]*)"/.exec(demo)![1];
    expect(/\shidden\b/.test(demo)).toBe(!src);
    if (src) expect(existsSync(join(WEB, "public", src))).toBe(true);
    expect(INDEX).not.toMatch(/<video\b/);
  });

  it("mentions the DNI brand family only on /seguridad", () => {
    const family = /DNI GYM|DNI DIRECTO|familia de marcas/i;
    for (const page of PAGES.filter((p) => p !== "seguridad.html")) expect(read(page), page).not.toMatch(family);
    const seguridad = read("seguridad.html");
    expect((seguridad.match(/DNI GYM/g) ?? []).length).toBe(1);
    expect(seguridad).toMatch(/<p class="legal-note">[^<]*DNI GYM[^<]*<\/p>/);
  });

  it("links /seguridad from every public page footer", () => {
    for (const page of PAGES) expect(read(page), page).toContain('href="/seguridad"');
  });
});
