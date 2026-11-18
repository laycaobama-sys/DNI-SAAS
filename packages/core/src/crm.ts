import { z } from "zod";

/**
 * F5 — Lead capture and CRM (pure rules shared by API and tests).
 * Public form input is untrusted DATA: it is validated, cleaned of control/bidi characters,
 * length-limited and never interpreted as instructions or HTML.
 */

export const LEAD_STAGES = ["new", "contacted", "qualified", "proposal", "won", "lost"] as const;
export type LeadStage = (typeof LEAD_STAGES)[number];
export const LEAD_STAGE_LABEL: Record<LeadStage, string> = {
  new: "Nuevo",
  contacted: "Contactado",
  qualified: "Cualificado",
  proposal: "Propuesta",
  won: "Ganado",
  lost: "Perdido",
};
export const LEAD_FORM_LIMITS: Record<string, number> = { free: 1, starter: 3, growth: 10, pro: 25, agency: 100 };

export const DEFAULT_CONSENT_TEXT =
  "Acepto que se traten mis datos para responder a mi solicitud, según la política de privacidad.";
export const DEFAULT_MARKETING_TEXT = "Quiero recibir comunicaciones comerciales (opcional, puedo darme de baja cuando quiera).";
export const DEFAULT_SUCCESS_MESSAGE = "Gracias. Hemos recibido tu mensaje y te responderemos lo antes posible.";

// eslint-disable-next-line no-control-regex
const CONTROL = new RegExp("[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f​-‏ -‮⁠-⁯﻿]", "g");
/** Single-line field: control/bidi characters removed, whitespace collapsed. */
export const cleanLine = (s: string) => s.replace(CONTROL, " ").replace(/\s+/g, " ").trim();
/** Multi-line field: keeps line breaks (max. 2 in a row). */
export const cleanMultiline = (s: string) =>
  s
    .replace(/\r\n?/g, "\n")
    .replace(CONTROL, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

export const normalizeEmail = (e: string) => cleanLine(e).toLowerCase();

const line = (max: number) => z.string().transform(cleanLine).pipe(z.string().max(max));
const optLine = (max: number) =>
  z
    .string()
    .optional()
    .transform((v) => (v === undefined ? undefined : cleanLine(v) || undefined))
    .pipe(z.string().max(max).optional());
/** Form checkboxes arrive as "on"/"true"/"1" (HTML form) or booleans (JSON). */
const checkbox = z
  .union([z.boolean(), z.string()])
  .optional()
  .transform((v) => v === true || v === "on" || v === "true" || v === "1");

/** What a public form may send. Unknown fields are ignored (never stored). */
export const LeadSubmission = z.object({
  name: line(120).pipe(z.string().min(2, "Escribe tu nombre.")),
  email: z
    .string()
    .transform(normalizeEmail)
    .pipe(z.email("Escribe un email válido.").max(254)),
  phone: optLine(40).refine((v) => v === undefined || /^[+()\d\s.-]{6,40}$/.test(v), "Teléfono no válido."),
  company: optLine(160),
  message: z
    .string()
    .optional()
    .transform((v) => (v === undefined ? undefined : cleanMultiline(v) || undefined))
    .pipe(z.string().max(3000, "Máximo 3.000 caracteres.").optional()),
  consent: checkbox,
  marketing: checkbox,
  // Anti-spam: honeypot (must stay empty) and the time the form was shown (ms since epoch).
  website: z.string().max(500).optional(),
  _t: z.union([z.string(), z.number()]).optional(),
  // Attribution (from the page URL; all optional and length-limited).
  page_url: optLine(1000),
  referrer: optLine(1000),
  utm_source: optLine(120),
  utm_medium: optLine(120),
  utm_campaign: optLine(200),
  utm_term: optLine(200),
  utm_content: optLine(200),
});
export type LeadSubmission = z.infer<typeof LeadSubmission>;

const URL_RE = /(https?:\/\/|www\.)\S+/gi;
export const MIN_FILL_MS = 2500;

/**
 * Cheap, explainable spam signals (no third-party tracking): honeypot filled, sent faster than a
 * human can type, too many links, or a link in the name. Any signal → the submission is dropped
 * silently (the bot gets the same «gracias» as a person) and only a counter is kept.
 */
export function spamSignals(s: Pick<LeadSubmission, "website" | "_t" | "message" | "name">, now = Date.now()): string[] {
  const out: string[] = [];
  if (s.website && s.website.trim()) out.push("honeypot");
  const t = s._t === undefined || s._t === "" ? NaN : Number(s._t);
  if (Number.isFinite(t) && t > 0 && now - t < MIN_FILL_MS) out.push("too_fast");
  if ((s.message?.match(URL_RE)?.length ?? 0) > 2) out.push("too_many_links");
  if (URL_RE.test(s.name)) out.push("link_in_name");
  URL_RE.lastIndex = 0;
  return out;
}

/** Only the host of a referrer is kept (never its path or query, which may hold personal data). */
export function referrerHost(ref: string | undefined, ownOrigin?: string): string | null {
  if (!ref) return null;
  try {
    const u = new URL(ref);
    if (u.protocol !== "https:" && u.protocol !== "http:") return null;
    if (ownOrigin && u.origin === ownOrigin) return null;
    return u.host.slice(0, 200);
  } catch {
    return null;
  }
}

/** Page URL without query/fragment (UTMs are stored apart; other parameters may hold personal data). */
export function pageUrlWithoutQuery(u: string | undefined): string | null {
  if (!u) return null;
  try {
    const x = new URL(u);
    if (x.protocol !== "https:" && x.protocol !== "http:") return null;
    return `${x.origin}${x.pathname}`.slice(0, 500);
  } catch {
    return null;
  }
}

/** Allowed origins of an embedded form: https only (http just for localhost), origin form, max 10. */
export const AllowedOrigins = z
  .array(z.string().max(200))
  .max(10)
  .transform((list, ctx) => {
    const out: string[] = [];
    for (const raw of list) {
      const v = raw.trim();
      if (!v) continue;
      try {
        const u = new URL(v);
        const local = u.hostname === "localhost" || u.hostname === "127.0.0.1";
        if (u.protocol !== "https:" && !(local && u.protocol === "http:")) throw new Error("scheme");
        if (!out.includes(u.origin)) out.push(u.origin);
      } catch {
        ctx.addIssue({ code: "custom", message: `Origen no válido: ${v.slice(0, 60)} (usa https://tudominio.es).` });
        return z.NEVER;
      }
    }
    return out;
  });

export const LEAD_CAVEATS = [
  "Los contactos son datos personales: solo los ven los roles con acceso al CRM (propietario, administración y responsable de marketing).",
  "La atribución (UTM, página y web de origen) es la que el navegador envió con el formulario; no se usan cookies ni píxeles de seguimiento.",
  "Si la misma persona envía el formulario varias veces, se actualiza su ficha (no se duplica) y queda en el historial.",
];
