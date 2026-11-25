import { describe, expect, it } from "vitest";
import { fillPageMeta } from "../src/landing/page-meta";

const page = (head: string) => `<html><head><title>Precios</title><meta name="description" content="Planes" /><link rel="canonical" href="https://dnigrowth.com/precios" />${head}</head><body></body></html>`;

describe("fillPageMeta", () => {
  it("adds the share tags, the large X card and JSON-LD when a page has none", () => {
    const out = fillPageMeta(page(""), "https://dnigrowth.com");
    expect(out).toContain('property="og:image" content="https://dnigrowth.com/og-dni-growth.png"');
    expect(out.match(/name="twitter:card"/g)).toHaveLength(1);
    expect(out).toContain("application/ld+json");
  });

  it("adds the X card to a page that has its own og:image, without duplicating anything", () => {
    const own = page('<meta property="og:image" content="https://dnigrowth.com/precios.png" /><script type="application/ld+json">{}</script>');
    const out = fillPageMeta(own, "https://dnigrowth.com");
    expect(out.match(/name="twitter:card"/g)).toHaveLength(1);
    expect(out.match(/og:image"/g)).toHaveLength(1);
    expect(fillPageMeta(out, "https://dnigrowth.com")).toBe(out);
  });
});
