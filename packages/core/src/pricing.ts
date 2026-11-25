/**
 * Commercial catalogue (plan comercial 2026-11-23): one source for the pricing page, the landing, the
 * app and the Stripe sync. Prices in EUR, VAT not included; annual = 2 months free (10 × monthly),
 * shown as a monthly equivalent rounded down to whole euros like the published table.
 *
 * Every comparison row states whether it works today ("available"), works with a named limit
 * ("partial") or is still being built ("building"). The pricing page prints that status next to the
 * row, so a plan never sells something that does not work end to end.
 */
import type { PlanCode } from "./plan-access";


export type PaidPlanCode = Exclude<PlanCode, "free">;
export type BillingInterval = "month" | "year";
export type RowStatus = "available" | "partial" | "building";

export interface PlanOffer {
  code: PlanCode;
  name: string;
  tagline: string;
  monthly: number;
  /** Annual price per month as published (rounded down). */
  yearlyPerMonth: number;
  /** Annual total charged once a year. */
  yearly: number;
  trialDays: number;
  highlight?: boolean;
}

const offer = (code: PlanCode, name: string, tagline: string, monthly: number, yearlyPerMonth: number, trialDays = 0, highlight = false): PlanOffer => ({
  code,
  name,
  tagline,
  monthly,
  yearlyPerMonth,
  yearly: yearlyPerMonth * 12,
  trialDays,
  ...(highlight ? { highlight } : {}),
});

export const PLAN_OFFERS: PlanOffer[] = [
  offer("free", "Free", "Para ver dónde estás", 0, 0),
  offer("starter", "Starter", "Para una web que empieza a crecer", 49, 41),
  offer("growth", "Growth", "Para crecer cada semana con datos", 129, 108, 7, true),
  offer("pro", "Pro", "Para varias webs o mercados", 249, 208),
  offer("agency", "Agency", "Para agencias con muchos clientes", 449, 374),
];

export const PAID_PLAN_CODES: PaidPlanCode[] = ["starter", "growth", "pro", "agency"];

export const offerFor = (code: string): PlanOffer | undefined => PLAN_OFFERS.find((p) => p.code === code);

/** Amount in cents charged per billing period. */
export function periodAmountCents(code: string, interval: BillingInterval): number {
  const o = offerFor(code);
  if (!o) throw new Error(`unknown_plan:${code}`);
  return Math.round((interval === "year" ? o.yearly : o.monthly) * 100);
}

/** Saving of the annual plan vs paying monthly for a year, in whole euros. */
export const annualSaving = (o: PlanOffer) => o.monthly * 12 - o.yearly;

export const formatEur = (n: number) => `${new Intl.NumberFormat("es-ES", { maximumFractionDigits: 0 }).format(n)} €`;

export interface PricingRow {
  label: string;
  values: Record<PlanCode, string>;
  status: RowStatus;
  /** Plain-language limit shown when status is not "available". */
  note?: string;
}

/** What a plan shows for a feature that is still being built: never a tick, always this. */
export const COMING_SOON = "Próximamente · incluida sin coste extra";

const row = (label: string, v: [string, string, string, string, string], status: RowStatus = "available", note?: string): PricingRow => ({
  label,
  // A feature still in development is never sold with a tick: the plans that will get it say so.
  values: Object.fromEntries((["free", "starter", "growth", "pro", "agency"] as const).map((k, i) => [k, status === "building" && v[i] !== "—" ? COMING_SOON : v[i]!])) as Record<PlanCode, string>,
  status,
  ...(note ? { note } : {}),
});

export const PRICING_ROWS: PricingRow[] = [
  row("Webs (proyectos)", ["1", "1", "1", "3", "15"]),
  row("Usuarios", ["1", "1", "3", "10", "Ilimitados"]),
  row("Auditorías al mes", ["3", "20", "60", "200", "600"]),
  row("Páginas por auditoría", ["10", "100", "250", "500", "500"], "available", "Límite técnico actual de 500 páginas por rastreo."),
  row("Perfil de marca y plan de 30 días", ["✓", "✓", "✓", "✓", "✓"]),
  row("Informe de auditoría y briefs (HTML/Markdown)", ["✓", "✓", "✓", "✓", "✓"]),
  row("Borradores de artículos al mes (revisión humana)", ["1 de prueba", "8", "30", "60", "30 por web"], "partial", "Content Studio redacta con IA y siempre pide revisión humana antes de aprobar. Proveedores en /subencargados."),
  row("Publicación en tu blog o CMS", ["—", "✓", "✓", "✓", "✓"], "partial", "WordPress: se conecta con una contraseña de aplicación y publica solo lo aprobado; con el plugin gratuito también envía el título, la descripción SEO y los datos estructurados. También Ghost y un webhook firmado (Webflow a través de Make o Zapier). Shopify y Webflow directo están en desarrollo (mientras, exportación HTML/Markdown)."),
  row("Actualización de artículos que pierden tráfico", ["—", "—", "✓", "✓", "✓"], "building"),
  row("Google Search Console (solo lectura)", ["✓", "✓", "✓", "✓", "✓"]),
  row("Google Analytics 4 (solo lectura)", ["—", "✓", "✓", "✓", "✓"]),
  row("Visibilidad en IA (prompts en seguimiento)", ["—", "10", "30", "100", "30 por web"], "partial", "Muestreo con Gemini; ChatGPT, Claude y Perplexity se añadirán cuando estén conectados."),
  row("Correcciones técnicas en tu web", ["—", "✓", "✓", "✓", "✓"], "partial", "En WordPress, con el plugin gratuito «DNI Growth Connector»: título SEO, descripción, URL canónica, JSON-LD, texto alternativo de imágenes y llms.txt. Cada corrección la apruebas tú, queda registrada y se deshace con un clic. Todavía no se aplican solas desde la auditoría ni en otros CMS."),
  row("Oportunidades de autoridad y enlaces seguros", ["—", "10/mes", "40/mes", "120/mes", "40 por web"], "partial", "Comprobación de enlaces y oportunidades; sin redes de intercambio de enlaces."),
  row("Vídeos y piezas sociales", ["—", "4/mes", "12/mes", "30/mes", "12 por web"], "partial", "Estudio de vídeo en el navegador."),
  row("Publicación programada en Facebook e Instagram (con aprobación)", ["—", "✓", "✓", "✓", "✓"], "building", "Construida y en pruebas con nuestras propias cuentas; se abre a todos los clientes cuando Meta apruebe la app."),
  row("CRM y atribución de clic a venta", ["—", "—", "✓", "✓", "✓"], "partial", "Atribución con el valor de venta que declaras en el CRM."),
  row("Informe mensual", ["—", "✓", "✓", "Con tu marca", "Marca blanca"], "partial", "Exportación desde Informes; el envío automático por email está en desarrollo."),
  row("Portal de cliente con marca blanca", ["—", "—", "—", "—", "✓"], "partial", "Organizaciones de cliente con tu marca; el dominio propio está en desarrollo."),
  row("Soporte", ["Email", "Email 48 h", "Email 24 h", "Prioritario", "Prioritario"]),
];

export const ROW_STATUS_LABEL: Record<RowStatus, string> = { available: "Disponible", partial: "Parcial", building: "En desarrollo" };

// ── Cancellation: honest survey + one offer per reason ────────────────────────────────────────────
export type CancelReason = "too_expensive" | "missing_features" | "not_using" | "no_results" | "switched_service" | "temporary" | "other";
export type RetentionOffer = "discount" | "pause" | "downgrade" | "none";

export const CANCEL_REASONS: Array<{ key: CancelReason; label: string; offer: RetentionOffer; stripeFeedback: string }> = [
  { key: "too_expensive", label: "Es demasiado caro para mí ahora", offer: "discount", stripeFeedback: "too_expensive" },
  { key: "not_using", label: "No lo estoy usando lo suficiente", offer: "downgrade", stripeFeedback: "unused" },
  { key: "temporary", label: "Solo necesito parar unos meses", offer: "pause", stripeFeedback: "other" },
  { key: "no_results", label: "No veo resultados todavía", offer: "pause", stripeFeedback: "low_quality" },
  { key: "missing_features", label: "Le falta algo que necesito", offer: "none", stripeFeedback: "missing_features" },
  { key: "switched_service", label: "Me cambio a otra herramienta o agencia", offer: "none", stripeFeedback: "switched_service" },
  { key: "other", label: "Otro motivo", offer: "none", stripeFeedback: "other" },
];

export const RETENTION_DISCOUNT = { percentOff: 30, months: 2, couponId: "dni_growth_retencion_30_2m" } as const;

// ── 90-day measurable guarantee ───────────────────────────────────────────────────────────────────
export const GUARANTEE = { days: 90, windowDays: 28, minApprovedShare: 0.8, plans: ["growth", "pro", "agency"] as PlanCode[] } as const;

export interface GuaranteeInput {
  planCode: string;
  /** First day of the continuous paid subscription (ISO). */
  subscribedSince: string | null;
  canceled: boolean;
  /** The subscription was paused or dropped to Free for non-payment after it started (continuity broken). */
  interrupted?: boolean;
  now: string;
  /** When Search Console was connected (ISO), null if not connected. */
  gscConnectedAt: string | null;
  articlesProposed: number;
  articlesApproved: number;
  criticalOpen: number;
  /** Organic impressions (Search Console) in the 28 days before the subscription started. */
  baselineImpressions: number | null;
  /** Organic impressions in the last 28 days at day 90. */
  currentImpressions: number | null;
}

export interface GuaranteeRequirement {
  key: "plan" | "days" | "gsc" | "articles" | "technical";
  label: string;
  met: boolean;
  detail: string;
  /** What the customer can do today, with what exists, to meet it (shown while not met). */
  todo: string;
}

export type GuaranteeStatus = "not_applicable" | "in_progress" | "requirements_missing" | "growth_achieved" | "refund_available" | "data_missing";

export interface GuaranteeResult {
  status: GuaranteeStatus;
  day: number;
  daysLeft: number;
  requirements: GuaranteeRequirement[];
  baselineImpressions: number | null;
  currentImpressions: number | null;
  changePct: number | null;
}

const DAY = 86_400_000;

/**
 * Pure evaluation of the guarantee. Refund only when every requirement is met at day ≥ 90 and the
 * observed impressions (Search Console) did not grow. Missing data never turns into a refund or a win.
 */
export function evaluateGuarantee(i: GuaranteeInput): GuaranteeResult {
  const since = i.subscribedSince ? Date.parse(i.subscribedSince) : NaN;
  const now = Date.parse(i.now);
  const day = Number.isFinite(since) ? Math.max(0, Math.floor((now - since) / DAY)) : 0;
  const daysLeft = Math.max(0, GUARANTEE.days - day);
  const eligiblePlan = (GUARANTEE.plans as string[]).includes(i.planCode);
  const gscOnTime = !!i.gscConnectedAt && Number.isFinite(since) && Date.parse(i.gscConnectedAt) <= since + DAY;
  const share = i.articlesProposed > 0 ? i.articlesApproved / i.articlesProposed : 0;
  const requirements: GuaranteeRequirement[] = [
    { key: "plan", label: "Plan Growth o superior", met: eligiblePlan, detail: eligiblePlan ? "Plan incluido en la garantía." : "La garantía cubre Growth, Pro y Agency.", todo: "Cambia a Growth, Pro o Agency desde esta página." },
    {
      key: "days",
      label: "90 días seguidos de suscripción",
      met: !i.canceled && !i.interrupted && day >= GUARANTEE.days,
      detail: i.canceled
        ? "La suscripción se canceló antes de cumplir 90 días."
        : i.interrupted
          ? "La suscripción se pausó o pasó al plan Free por impago: los 90 días deben ser seguidos."
          : day >= GUARANTEE.days
            ? "Cumplido."
            : `Día ${day} de ${GUARANTEE.days}.`,
      todo: "Mantén la suscripción activa, sin pausas ni impagos, hasta el día 90.",
    },
    {
      key: "gsc",
      label: "Search Console conectado desde el primer día",
      met: gscOnTime,
      detail: !i.gscConnectedAt ? "Search Console no está conectado." : gscOnTime ? "Conectado a tiempo." : "Se conectó después del primer día de suscripción.",
      todo: "Menú «Search Console» → «Conectar con Google (solo lectura)» y elige la propiedad de tu web.",
    },
    {
      key: "articles",
      label: "Al menos el 80 % de los artículos propuestos aprobados en Content Studio",
      met: i.articlesProposed > 0 && share >= GUARANTEE.minApprovedShare,
      detail: i.articlesProposed === 0 ? "Todavía no hay artículos propuestos." : `${i.articlesApproved} de ${i.articlesProposed} (${Math.round(share * 100)} %).`,
      todo: "En Content Studio, revisa cada borrador y pulsa «Aprobar». No hace falta publicarlo en tu web: cuenta la aprobación.",
    },
    {
      key: "technical",
      label: "Sin problemas técnicos críticos en la última auditoría",
      met: i.criticalOpen === 0,
      detail: i.criticalOpen === 0 ? "Sin problemas críticos abiertos en la última auditoría." : `${i.criticalOpen} problema(s) crítico(s) sin corregir en la última auditoría.`,
      todo: "Corrige los problemas críticos en tu web (a mano o con tu desarrollador, siguiendo el brief de cada uno) y lanza una nueva auditoría para comprobarlo.",
    },
  ];
  const changePct =
    i.baselineImpressions !== null && i.currentImpressions !== null && i.baselineImpressions > 0
      ? Math.round(((i.currentImpressions - i.baselineImpressions) / i.baselineImpressions) * 1000) / 10
      : null;
  const base = { day, daysLeft, requirements, baselineImpressions: i.baselineImpressions, currentImpressions: i.currentImpressions, changePct };
  if (!eligiblePlan || !Number.isFinite(since)) return { status: "not_applicable", ...base };
  if (day < GUARANTEE.days && !i.canceled && !i.interrupted) return { status: "in_progress", ...base };
  if (requirements.some((r) => !r.met)) return { status: "requirements_missing", ...base };
  if (i.baselineImpressions === null || i.currentImpressions === null) return { status: "data_missing", ...base };
  return { status: i.currentImpressions > i.baselineImpressions ? "growth_achieved" : "refund_available", ...base };
}
