import { z } from "zod";

/**
 * F5 — Landing pages built from blocks. Content is plain text (never HTML): the renderer escapes
 * everything, so a landing can never inject scripts. Images must be https URLs.
 */

// eslint-disable-next-line no-control-regex
const CONTROL = new RegExp("[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]", "g");
const text = (max: number) => z.string().max(max).transform((s) => s.replace(CONTROL, "").trim());
const opt = (max: number) => text(max).optional().default("");
const httpsUrl = z
  .string()
  .max(500)
  .refine((v) => {
    try {
      return new URL(v).protocol === "https:";
    } catch {
      return false;
    }
  }, "Debe ser una URL https://");
/** CTA target: the page's own form, or an https link. */
const ctaHref = z.union([z.literal("#formulario"), httpsUrl]);

export const LandingBlock = z.discriminatedUnion("type", [
  z.object({ type: z.literal("hero"), heading: text(120).pipe(z.string().min(3, "El titular es obligatorio.")), subheading: opt(300), ctaLabel: opt(40), ctaHref: ctaHref.optional().default("#formulario"), imageUrl: httpsUrl.optional().nullable(), imageAlt: opt(160) }),
  z.object({ type: z.literal("features"), heading: opt(120), items: z.array(z.object({ title: text(80).pipe(z.string().min(1)), text: opt(300) })).min(1).max(6) }),
  z.object({ type: z.literal("text"), heading: opt(120), body: text(4000).pipe(z.string().min(1)) }),
  z.object({ type: z.literal("faq"), heading: opt(120), items: z.array(z.object({ q: text(200).pipe(z.string().min(3)), a: text(1000).pipe(z.string().min(1)) })).min(1).max(12) }),
  z.object({ type: z.literal("cta"), heading: text(120).pipe(z.string().min(3)), text: opt(300), ctaLabel: text(40).pipe(z.string().min(2)), ctaHref: ctaHref.optional().default("#formulario") }),
  z.object({ type: z.literal("form"), heading: opt(120), text: opt(300), buttonLabel: opt(40) }),
]);
export type LandingBlock = z.infer<typeof LandingBlock>;

export const LandingContent = z.object({
  seo: z.object({ title: text(70).pipe(z.string().min(3, "El título SEO es obligatorio.")), description: opt(160) }),
  theme: z.object({ accent: z.string().regex(/^#[0-9a-fA-F]{6}$/, "Color en formato #RRGGBB.").default("#3f6212"), mode: z.enum(["light", "dark"]).default("light") }).default({ accent: "#3f6212", mode: "light" }),
  blocks: z.array(LandingBlock).min(1, "Añade al menos un bloque.").max(30),
});
export type LandingContent = z.infer<typeof LandingContent>;

export const LANDING_SLUG = z
  .string()
  .min(3)
  .max(60)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "Usa minúsculas, números y guiones (ej.: oferta-navidad).");

export const LANDING_LIMITS: Record<string, number> = { free: 1, starter: 5, growth: 20, pro: 50, agency: 200 };

/** A starting point the user edits (no invented claims, testimonials or figures). */
export function landingTemplate(brandName: string): LandingContent {
  return {
    seo: { title: (brandName.trim().length >= 3 ? brandName.trim() : `${brandName.trim()} · Inicio`).slice(0, 70), description: "" },
    theme: { accent: "#3f6212", mode: "light" },
    blocks: [
      { type: "hero", heading: `${brandName}: escribe aquí tu propuesta principal`.slice(0, 120), subheading: "Explica en una frase a quién ayudas y cómo.", ctaLabel: "Quiero información", ctaHref: "#formulario", imageUrl: null, imageAlt: "" },
      { type: "features", heading: "Qué ofrecemos", items: [{ title: "Beneficio 1", text: "Descríbelo con hechos comprobables." }, { title: "Beneficio 2", text: "" }, { title: "Beneficio 3", text: "" }] },
      { type: "form", heading: "Hablemos", text: "Déjanos tus datos y te respondemos.", buttonLabel: "Enviar" },
    ],
  };
}

// ── A/B statistics (two-proportion z-test; honest warnings) ─────────────────────────────────────
export const AB_MIN_VIEWS = 100;
export const AB_MIN_CONVERSIONS = 10;

function normCdf(x: number): number {
  // Abramowitz–Stegun 7.1.26
  const t = 1 / (1 + 0.3275911 * Math.abs(x) / Math.SQRT2);
  const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-(x * x) / 2);
  return x >= 0 ? (1 + y) / 2 : (1 - y) / 2;
}

export interface AbResult {
  a: { views: number; conversions: number; rate: number | null };
  b: { views: number; conversions: number; rate: number | null };
  /** Two-sided p-value of the difference in conversion rate; null when it cannot be computed. */
  pValue: number | null;
  relativeLift: number | null;
  verdict: "insufficient_data" | "no_significant_difference" | "a_better" | "b_better";
  warnings: string[];
}

export function abTest(a: { views: number; conversions: number }, b: { views: number; conversions: number }): AbResult {
  const rate = (x: { views: number; conversions: number }) => (x.views > 0 ? Math.min(1, x.conversions / x.views) : null);
  const ra = rate(a);
  const rb = rate(b);
  const warnings: string[] = [];
  const enough = a.views >= AB_MIN_VIEWS && b.views >= AB_MIN_VIEWS && a.conversions + b.conversions >= AB_MIN_CONVERSIONS;
  if (!enough) warnings.push(`Muestra insuficiente: hacen falta al menos ${AB_MIN_VIEWS} visitas por variante y ${AB_MIN_CONVERSIONS} conversiones en total antes de sacar conclusiones.`);
  let p: number | null = null;
  if (ra !== null && rb !== null) {
    const pool = (a.conversions + b.conversions) / (a.views + b.views);
    const se = Math.sqrt(pool * (1 - pool) * (1 / a.views + 1 / b.views));
    if (se > 0) p = Math.round(2 * (1 - normCdf(Math.abs((rb - ra) / se))) * 10000) / 10000;
  }
  const lift = ra && rb !== null ? Math.round(((rb - ra) / ra) * 1000) / 1000 : null;
  let verdict: AbResult["verdict"] = "insufficient_data";
  if (enough && p !== null) verdict = p < 0.05 ? (rb! > ra! ? "b_better" : "a_better") : "no_significant_difference";
  warnings.push("Revisar el resultado muchas veces y parar en cuanto «sale significativo» aumenta los falsos positivos: decide antes cuántas visitas necesitas.");
  warnings.push("Sin cookies, la variante se asigna por la conexión del visitante: alguien que cambie de red puede ver las dos.");
  return { a: { ...a, rate: ra }, b: { ...b, rate: rb }, pValue: p, relativeLift: lift, verdict, warnings };
}
