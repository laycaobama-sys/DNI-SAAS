/**
 * Static HTML for the public prices (landing and /precios), generated at build time from the single
 * commercial catalogue (packages/core/src/pricing.ts). Relative import on purpose: vite.config.ts
 * bundles this file, so it must not depend on workspace package resolution.
 */
import { GUARANTEE, PLAN_OFFERS, PRICING_ROWS, ROW_STATUS_LABEL, annualSaving, type PlanOffer } from "../../../../packages/core/src/pricing";

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const eur = (n: number) => `${new Intl.NumberFormat("es-ES", { maximumFractionDigits: 0 }).format(n)} €`;

function priceBlock(o: PlanOffer): string {
  if (o.monthly === 0) return `<p class="price">0 €</p><p class="price-note">Gratis para siempre</p>`;
  return (
    `<p class="price"><span class="pm">${eur(o.monthly)}</span><span class="py">${eur(o.yearlyPerMonth)}</span><small>/mes</small></p>` +
    `<p class="price-note"><span class="pm">IVA aparte · mensual</span><span class="py">${eur(o.yearly)} al año · ahorras ${eur(annualSaving(o))}</span></p>`
  );
}

function cta(o: PlanOffer): string {
  if (o.monthly === 0) return `<a class="btn" href="/app/register">Crear cuenta gratis</a>`;
  // Neutral until the API confirms real payments are open (pricing.ts upgrades the label): never promise a trial that cannot start.
  const trial = o.trialDays > 0 ? ` data-trial-label="Probar ${o.trialDays} días gratis"` : "";
  return `<a class="btn${o.highlight ? " btn-accent" : ""}" href="/app/register?plan=${o.code}"${trial}>Empezar con ${esc(o.name)}</a>`;
}

/** Compact plan cards for the landing (#precios). */
export function landingPlansHtml(): string {
  return PLAN_OFFERS.map(
    (o) =>
      `<article class="plan${o.highlight ? " plan-featured" : ""} reveal"><h3>${esc(o.name)}</h3>${priceBlock(o)}<p class="plan-tag">${esc(o.tagline)}</p>` +
      (o.trialDays > 0 ? `<p class="plan-trial">${o.trialDays} días de prueba gratis</p>` : "") +
      cta(o) +
      `</article>`,
  ).join("\n          ");
}

/** Full plan cards for /precios. */
export function pricingPlansHtml(): string {
  return PLAN_OFFERS.map(
    (o) =>
      `<article class="pp-plan${o.highlight ? " pp-featured" : ""}">` +
      (o.highlight ? `<p class="pp-badge">Recomendado</p>` : "") +
      `<h2 class="pp-name">${esc(o.name)}</h2><p class="pp-tag">${esc(o.tagline)}</p>${priceBlock(o)}` +
      (o.trialDays > 0 ? `<p class="plan-trial">${o.trialDays} días de prueba gratis · se pide tarjeta · avisamos antes de cobrar</p>` : "") +
      ((GUARANTEE.plans as string[]).includes(o.code) ? `<p class="pp-guarantee"><a href="/legal/garantia">Garantía de ${GUARANTEE.days} días</a></p>` : "") +
      cta(o) +
      `</article>`,
  ).join("\n        ");
}

/** Comparison table: every row states whether it works today. */
export function pricingTableHtml(): string {
  const head = `<thead><tr><th scope="col">Qué incluye</th>${PLAN_OFFERS.map((o) => `<th scope="col">${esc(o.name)}</th>`).join("")}<th scope="col">Estado hoy</th></tr></thead>`;
  const body = PRICING_ROWS.map(
    (r) =>
      `<tr><th scope="row">${esc(r.label)}${r.note ? `<span class="pt-note">${esc(r.note)}</span>` : ""}</th>` +
      PLAN_OFFERS.map((o) => `<td>${esc(r.values[o.code])}</td>`).join("") +
      `<td><span class="st st-${r.status}">${ROW_STATUS_LABEL[r.status]}</span></td></tr>`,
  ).join("");
  return `<table class="pt">${head}<tbody>${body}</tbody></table>`;
}

/** JSON-LD Product offers built from the same catalogue (no ratings, no reviews). */
export function pricingJsonLd(siteUrl: string): string {
  const data = {
    "@context": "https://schema.org",
    "@type": "Product",
    name: "DNI Growth",
    description: "Software de crecimiento digital con IA: auditoría SEO técnica, GEO y AEO con evidencia, plan de crecimiento y borradores revisables.",
    brand: { "@type": "Brand", name: "DNI Growth" },
    url: `${siteUrl}/precios`,
    offers: PLAN_OFFERS.filter((o) => o.monthly > 0).map((o) => ({
      "@type": "Offer",
      name: o.name,
      price: o.monthly.toFixed(2),
      priceCurrency: "EUR",
      url: `${siteUrl}/precios`,
      priceSpecification: { "@type": "UnitPriceSpecification", price: o.monthly.toFixed(2), priceCurrency: "EUR", unitText: "MONTH", valueAddedTaxIncluded: false },
    })),
  };
  return `<script type="application/ld+json">${JSON.stringify(data).replace(/</g, "\\u003c")}</script>`;
}

export function fillPricing(html: string, siteUrl: string): string {
  return html
    .replace("<!--PRICING:LANDING_PLANS-->", landingPlansHtml())
    .replace("<!--PRICING:PLANS-->", pricingPlansHtml())
    .replace("<!--PRICING:TABLE-->", pricingTableHtml())
    .replace("<!--PRICING:JSONLD-->", pricingJsonLd(siteUrl));
}
