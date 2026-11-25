import { z } from "zod";
import { imageInfo } from "./image-meta";

/**
 * Publishing to Facebook Pages and Instagram professional accounts (Meta Graph API, Facebook Login for
 * Business). Rules checked BEFORE anything is sent to Meta, so a post never fails for a reason we could
 * have told the user while writing it. Limits from Meta's content-publishing docs (checked 2026-11-25).
 */
export const META_GRAPH_VERSION = "v27.0";

/** Minimal permissions: list Pages, publish on them and publish to the linked Instagram account. */
export const META_SCOPES = ["pages_show_list", "pages_read_engagement", "pages_manage_posts", "instagram_basic", "instagram_content_publish", "business_management"] as const;

export type SocialNetwork = "facebook" | "instagram";
export const SOCIAL_NETWORK_LABEL: Record<SocialNetwork, string> = { facebook: "Página de Facebook", instagram: "Instagram" };

export const IG_CAPTION_MAX = 2200;
export const IG_HASHTAGS_MAX = 30;
export const IG_MENTIONS_MAX = 20;
export const FB_MESSAGE_MAX = 5000;
export const IG_IMAGE_MAX_BYTES = 8_000_000;
export const IG_MIN_WIDTH = 320;
/** Instagram accepts aspect ratios between 4:5 (0.8) and 1.91:1. */
export const IG_RATIO_MIN = 0.8;
export const IG_RATIO_MAX = 1.91;
/** Meta's limit is 100 API posts per Instagram account per 24 h; we stop well before it. */
export const IG_DAILY_POSTS = 25;

export type SocialPostStatus = "draft" | "pending_approval" | "approved" | "publishing" | "published" | "failed" | "cancelled";
export const SOCIAL_STATUS_LABEL: Record<SocialPostStatus, string> = {
  draft: "Borrador",
  pending_approval: "Pendiente de aprobar",
  approved: "Aprobado · programado",
  publishing: "Publicando",
  published: "Publicado",
  failed: "Error al publicar",
  cancelled: "Cancelado",
};

export const SocialPostInput = z.object({
  accountId: z.string().uuid(),
  caption: z.string().trim().max(FB_MESSAGE_MAX).default(""),
  link: z
    .string()
    .trim()
    .max(2000)
    .url()
    .refine((u) => /^https:\/\//i.test(u), "El enlace debe empezar por https://")
    .optional()
    .or(z.literal("").transform(() => undefined)),
  mediaId: z.string().uuid().optional().nullable(),
  /** ISO date-time; empty = as soon as it is approved. */
  scheduledAt: z.string().datetime({ offset: true }).optional().nullable(),
});
export type SocialPostInput = z.infer<typeof SocialPostInput>;

export interface SocialMediaFacts {
  contentType: string;
  bytes: number;
  /** First bytes of the file (enough for the header): width and height are read from them. */
  head: Uint8Array;
}

const count = (s: string, re: RegExp) => (s.match(re) ?? []).length;

/**
 * Problems that would make Meta reject the post (or that we refuse on purpose), in plain Spanish.
 * Empty list = ready to submit.
 */
export function socialPostProblems(network: SocialNetwork, p: { caption: string; link?: string | null; media?: SocialMediaFacts | null }): string[] {
  const out: string[] = [];
  const caption = p.caption ?? "";
  if (network === "instagram") {
    if (!p.media) out.push("Instagram necesita una imagen.");
    if (caption.length > IG_CAPTION_MAX) out.push(`El texto de Instagram admite como máximo ${IG_CAPTION_MAX} caracteres (tiene ${caption.length}).`);
    const tags = count(caption, /(^|\s)#[\p{L}\p{N}_]+/gu);
    if (tags > IG_HASHTAGS_MAX) out.push(`Instagram admite como máximo ${IG_HASHTAGS_MAX} hashtags (hay ${tags}).`);
    const mentions = count(caption, /(^|\s)@[\w.]+/g);
    if (mentions > IG_MENTIONS_MAX) out.push(`Instagram admite como máximo ${IG_MENTIONS_MAX} menciones (hay ${mentions}).`);
    if (p.link) out.push("Instagram no permite enlaces en las publicaciones: quita el enlace o ponlo en el texto (no será clicable).");
    if (p.media) {
      if (p.media.contentType !== "image/jpeg") out.push("Instagram solo acepta imágenes JPG. Sube la imagen en JPG.");
      if (p.media.bytes > IG_IMAGE_MAX_BYTES) out.push("La imagen supera los 8 MB que admite Instagram.");
      const info = imageInfo(p.media.head, p.media.contentType);
      if (info.width && info.height) {
        const ratio = info.width / info.height;
        if (info.width < IG_MIN_WIDTH) out.push(`La imagen mide ${info.width} px de ancho; Instagram pide al menos ${IG_MIN_WIDTH} px.`);
        if (ratio < IG_RATIO_MIN - 0.005 || ratio > IG_RATIO_MAX + 0.005)
          out.push(`La proporción de la imagen (${info.width}×${info.height}) no la acepta Instagram: debe estar entre 4:5 (vertical) y 1,91:1 (horizontal).`);
      } else if (p.media.contentType === "image/jpeg") out.push("No se pudo leer el tamaño de la imagen. Vuelve a exportarla en JPG.");
    }
  } else {
    if (!caption.trim() && !p.link && !p.media) out.push("Escribe un texto, añade un enlace o una imagen.");
    if (caption.length > FB_MESSAGE_MAX) out.push(`El texto admite como máximo ${FB_MESSAGE_MAX} caracteres.`);
    if (p.media && p.link) out.push("En Facebook publica o una imagen o un enlace (con su vista previa), no los dos a la vez.");
    if (p.media && !["image/jpeg", "image/png"].includes(p.media.contentType)) out.push("Facebook acepta imágenes JPG o PNG.");
  }
  return out;
}
