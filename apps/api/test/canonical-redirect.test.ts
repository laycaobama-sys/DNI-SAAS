import { describe, expect, it } from "vitest";
import { canonicalRedirect, PATH_ALIASES } from "../src/app";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const canon = new URL("https://dnigrowth.com");
const r = (u: string) => canonicalRedirect(new URL(u), canon);

describe("canonicalRedirect (duplicate-content guard)", () => {
  it("keeps canonical URLs untouched", () => {
    expect(r("https://dnigrowth.com/")).toBeNull();
    expect(r("https://dnigrowth.com/legal/privacidad")).toBeNull();
    expect(r("https://dnigrowth.com/?utm_source=x")).toBeNull();
    expect(r("https://dnigrowth.com/app/orgs/1")).toBeNull();
  });

  it("sends other hosts and http to the canonical origin", () => {
    expect(r("https://dni-growth.example.workers.dev/")).toBe("https://dnigrowth.com/");
    expect(r("http://dnigrowth.com/legal/condiciones")).toBe("https://dnigrowth.com/legal/condiciones");
    expect(r("https://www.dnigrowth.com/app?x=1")).toBe("https://dnigrowth.com/app?x=1");
    expect(r("https://dni-growth.example.workers.dev/api/v1/auth/google/start")).toBe("https://dnigrowth.com/api/v1/auth/google/start");
  });

  it("strips .html, /index.html and trailing slashes on public pages", () => {
    expect(r("https://dnigrowth.com/index.html")).toBe("https://dnigrowth.com/");
    expect(r("https://dnigrowth.com/legal/privacidad.html")).toBe("https://dnigrowth.com/legal/privacidad");
    expect(r("https://dnigrowth.com/legal/aviso-legal/")).toBe("https://dnigrowth.com/legal/aviso-legal");
    // Blog: one URL for the list and for each post.
    expect(r("https://dnigrowth.com/blog")).toBeNull();
    expect(r("https://dnigrowth.com/blog.html")).toBe("https://dnigrowth.com/blog");
    expect(r("https://dnigrowth.com/blog/")).toBe("https://dnigrowth.com/blog");
    expect(r("https://dnigrowth.com/blog/que-es-geo/")).toBe("https://dnigrowth.com/blog/que-es-geo");
    expect(r("https://www.dnigrowth.com/blog/que-es-geo")).toBe("https://dnigrowth.com/blog/que-es-geo");
    expect(r("https://dnigrowth.com/blog/feed.xml")).toBeNull();
  });

  it("never redirects the JSON API or search-engine ownership files", () => {
    expect(r("https://dni-growth.example.workers.dev/api/v1/health")).toBeNull();
    expect(r("http://dni-growth.example.workers.dev/api/v1/webhooks/stripe")).toBeNull();
    expect(r("https://dni-growth.example.workers.dev/google07bca8a276fd14a6.html")).toBeNull();
    expect(r("https://dni-growth.example.workers.dev/BingSiteAuth.xml")).toBeNull();
    expect(r("https://dni-growth.example.workers.dev/c2d713b310de907a6ead8590e603ff8c.txt")).toBeNull();
  });
});

describe("legal and support aliases (links in Stripe's public business details)", () => {
  it("send the URLs Stripe shows on Checkout and receipts to the real pages", () => {
    expect(r("https://dnigrowth.com/terminos-y-condiciones")).toBe("https://dnigrowth.com/legal/condiciones");
    expect(r("https://dnigrowth.com/politica-de-privacidad/")).toBe("https://dnigrowth.com/legal/privacidad");
    expect(r("https://dnigrowth.com/soporte")).toBe("https://dnigrowth.com/#contacto");
    expect(r("http://www.dnigrowth.com/privacidad.html")).toBe("https://dnigrowth.com/legal/privacidad");
  });

  it("every alias reaches the Worker and points to a page that exists", () => {
    const wrangler = readFileSync(join(import.meta.dirname, "..", "wrangler.jsonc"), "utf8");
    const web = join(import.meta.dirname, "..", "..", "web");
    for (const [from, to] of Object.entries(PATH_ALIASES)) {
      expect(wrangler).toContain(`"${from}"`);
      const page = to.split("#")[0];
      const file = page === "/" ? "index.html" : `${page.slice(1)}.html`;
      expect(() => readFileSync(join(web, file))).not.toThrow();
    }
  });
});
