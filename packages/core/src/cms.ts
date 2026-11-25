import { z } from "zod";

/**
 * Publishing approved content to the customer's own WordPress through its REST API, authenticated with
 * an Application Password the customer creates in WordPress (Users → Profile → Application Passwords).
 * The customer's normal login password is never asked for. HTTPS only: WordPress itself refuses
 * Application Passwords over plain HTTP outside local development.
 */
export const WP_APP_PASSWORD_RE = /^[A-Za-z0-9]{4}( ?[A-Za-z0-9]{4}){5}$/;

/** Normalises the address the customer types: https, no query/hash, no trailing slash, no /wp-admin. */
export function normalizeWpSite(raw: string): string | null {
  let u: URL;
  try {
    u = new URL(/^https?:\/\//i.test(raw.trim()) ? raw.trim() : `https://${raw.trim()}`);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" || u.username || u.password || (u.port && u.port !== "443")) return null;
  const path = u.pathname
    .replace(/\/(wp-admin|wp-login\.php|wp-json)(\/.*)?$/i, "")
    .replace(/\/+$/, "");
  return `https://${u.hostname.toLowerCase()}${path}`;
}

export const WordPressConnectInput = z.object({
  siteUrl: z
    .string()
    .trim()
    .min(4)
    .max(300)
    .refine((v) => normalizeWpSite(v) !== null, "Escribe la dirección de tu web con https:// (por ejemplo https://tuweb.com)."),
  username: z.string().trim().min(1).max(60),
  appPassword: z
    .string()
    .trim()
    .refine((v) => WP_APP_PASSWORD_RE.test(v), "La contraseña de aplicación tiene 24 letras y números (WordPress la muestra en grupos de 4)."),
});
export type WordPressConnectInput = z.infer<typeof WordPressConnectInput>;

export const WordPressPublishInput = z.object({
  /** «draft» leaves it as a draft in WordPress for a last look there; «publish» makes it public. */
  status: z.enum(["draft", "publish"]),
});

/** Content kinds that make sense as a WordPress post. */
export const WP_PUBLISHABLE_KINDS = ["blog_article", "faq_aeo", "landing_copy"] as const;

export type CmsPublicationState = "publishing" | "published" | "draft" | "unpublished" | "failed";
export const CMS_STATE_LABEL: Record<CmsPublicationState, string> = {
  publishing: "Enviando…",
  published: "Publicado",
  draft: "Borrador en WordPress",
  unpublished: "Retirado (borrador)",
  failed: "Error",
};

/** Hidden marker placed in the post body so a retry finds the post it already created instead of duplicating it. */
export const wpMarker = (contentId: string) => `<!-- dni-growth:${contentId} -->`;

/** URL-safe slug in Spanish: no accents, lowercase, hyphens, max 80. */
export function wpSlug(title: string): string {
  return (
    title
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .replace(/ñ/g, "n")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80)
      .replace(/-+$/, "") || "articulo"
  );
}
