import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { fillPricing, landingPlansHtml, pricingJsonLd, pricingPlansHtml, pricingTableHtml } from "../src/landing/pricing-html";
import { PLAN_OFFERS, PRICING_ROWS } from "@dni/core/pricing";

const WEB = join(import.meta.dirname, "..");
const eur = (n: number) => `${new Intl.NumberFormat("es-ES", { maximumFractionDigits: 0 }).format(n)} €`;

describe("public prices come from the single catalogue", () => {
  it("landing and /precios show every plan with its monthly and annual price, and the trial only where it exists", () => {
    for (const html of [landingPlansHtml(), pricingPlansHtml()]) {
      for (const o of PLAN_OFFERS) {
        expect(html).toContain(o.name);
        expect(html).toContain(eur(o.monthly));
        if (o.monthly > 0) expect(html).toContain(eur(o.yearlyPerMonth));
      }
      expect(html.match(/días de prueba gratis/g)).toHaveLength(PLAN_OFFERS.filter((o) => o.trialDays > 0).length);
      // Old launch prices and «coming soon» labels are gone.
      expect(html).not.toMatch(/\b(39|89|179|349) €|Próximamente/);
    }
  });

  it("the comparison table has one row per catalogue row with its honest status", () => {
    const html = pricingTableHtml();
    expect(html.match(/<tr><th scope="row">/g)).toHaveLength(PRICING_ROWS.length);
    expect(html.match(/class="st st-building"/g)?.length ?? 0).toBe(PRICING_ROWS.filter((r) => r.status === "building").length);
    expect(html).toContain("En desarrollo");
  });

  it("JSON-LD lists offers without ratings or reviews and cannot break out of the script tag", () => {
    const ld = pricingJsonLd("https://dnigrowth.com");
    expect(ld).not.toMatch(/aggregateRating|review/i);
    expect(ld.slice(ld.indexOf(">") + 1, ld.lastIndexOf("</script>"))).not.toContain("<");
    const data = JSON.parse(ld.replace(/^<script[^>]*>/, "").replace(/<\/script>$/, ""));
    expect(data.offers.map((o: { price: string }) => o.price)).toEqual(PLAN_OFFERS.filter((o) => o.monthly > 0).map((o) => o.monthly.toFixed(2)));
  });

  it("the pages carry the build markers and nothing is left unfilled", () => {
    const landing = readFileSync(join(WEB, "index.html"), "utf8");
    const precios = readFileSync(join(WEB, "precios.html"), "utf8");
    expect(landing).toContain("<!--PRICING:LANDING_PLANS-->");
    expect(precios).toContain("<!--PRICING:PLANS-->");
    expect(precios).toContain("<!--PRICING:TABLE-->");
    for (const page of [landing, precios]) expect(fillPricing(page, "https://dnigrowth.com")).not.toMatch(/<!--PRICING:/);
  });
});
