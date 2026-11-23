/**
 * /precios: honest payment status (from the API, never assumed) and the "what does it cost you today"
 * calculator, which only uses the visitor's own numbers.
 */
const GROWTH_MONTHLY = 129;
const GROWTH_ARTICLES = 30;

async function paymentStatus() {
  const el = document.querySelector<HTMLElement>("[data-pricing-status]");
  if (!el) return;
  try {
    const r = await fetch("/api/v1/public/pricing-status", { headers: { accept: "application/json" } });
    if (!r.ok) return;
    const s = (await r.json()) as { paymentsOpen: boolean };
    if (s.paymentsOpen) for (const a of document.querySelectorAll<HTMLAnchorElement>("a[data-trial-label]")) a.textContent = a.dataset.trialLabel ?? a.textContent;
    el.textContent = s.paymentsOpen ? "Pagos activos con Stripe: puedes contratar desde tu cuenta." : "Los planes de pago se activan en cuanto Stripe termine de verificar la cuenta. Mientras tanto, el plan Free funciona sin límite de tiempo.";
  } catch {
    /* status line stays hidden */
  }
}

function calculator() {
  const form = document.querySelector<HTMLFormElement>("[data-pricing-calc]");
  const out = document.querySelector<HTMLElement>("[data-pricing-calc-out]");
  if (!form || !out) return;
  const eur = (n: number) => `${new Intl.NumberFormat("es-ES", { maximumFractionDigits: 0 }).format(n)} €`;
  const update = () => {
    const cost = Number((form.elements.namedItem("cost") as HTMLInputElement).value);
    const count = Math.min(200, Math.max(1, Math.round(Number((form.elements.namedItem("count") as HTMLInputElement).value) || 1)));
    if (!cost || cost <= 0) return;
    const today = cost * count;
    const covered = Math.min(count, GROWTH_ARTICLES);
    out.textContent =
      `Hoy: ${eur(today)} al mes por ${count} artículos. Growth: ${eur(GROWTH_MONTHLY)} al mes, con hasta ${GROWTH_ARTICLES} borradores` +
      (count > GROWTH_ARTICLES ? ` (cubre ${covered} de tus ${count})` : "") +
      ". Los borradores siempre los revisas tú antes de publicar; esto compara precio, no calidad.";
  };
  form.addEventListener("input", update);
  form.addEventListener("submit", (e) => e.preventDefault());
}

void paymentStatus();
calculator();
