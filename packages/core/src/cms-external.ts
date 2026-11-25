import { z } from "zod";
import { normalizeWpSite } from "./cms";

/**
 * Publishing approved content outside WordPress: Ghost (Admin API key) and a generic signed webhook
 * (for Webflow, Make, Zapier, n8n or the customer's own backend). Same rules as WordPress: only approved
 * content, only roles with content:approve, audited and idempotent.
 */
export const EXTERNAL_CMS_PROVIDERS = ["ghost", "webhook"] as const;
export type ExternalCmsProvider = (typeof EXTERNAL_CMS_PROVIDERS)[number];
export const EXTERNAL_CMS_LABEL: Record<ExternalCmsProvider, string> = { ghost: "Ghost", webhook: "Webhook" };

/** Ghost Admin API key: «24 hex id»:«64 hex secret» (Ghost → Settings → Integrations → Add custom integration). */
export const GHOST_ADMIN_KEY_RE = /^[a-f0-9]{24}:[a-f0-9]{64}$/;

export const GhostConnectInput = z.object({
  apiUrl: z
    .string()
    .trim()
    .min(4)
    .max(300)
    .refine((v) => normalizeWpSite(v) !== null, "Escribe la dirección de tu Ghost con https:// (por ejemplo https://tublog.ghost.io)."),
  adminKey: z
    .string()
    .trim()
    .refine((v) => GHOST_ADMIN_KEY_RE.test(v), "La clave de la API de administración de Ghost tiene la forma id:secreto (24 y 64 caracteres)."),
});

export const WebhookConnectInput = z.object({
  url: z
    .url({ protocol: /^https$/, error: "La dirección del webhook tiene que empezar por https://." })
    .max(500),
});

export const ExternalPublishInput = z.object({ status: z.enum(["draft", "publish"]) });

/** Ghost site root from whatever the user pasted (admin URL, API URL or the blog URL). */
export function normalizeGhostSite(raw: string): string | null {
  const s = normalizeWpSite(raw.replace(/\/ghost(\/.*)?$/i, ""));
  return s;
}

/** Internal tag that lets a retry find the post it already created (Ghost hides «#» tags from readers). */
export const ghostInternalTag = (contentId: string) => `#dni-${contentId.replace(/-/g, "")}`;
export const ghostInternalTagSlug = (contentId: string) => `hash-dni-${contentId.replace(/-/g, "")}`;

/** Events sent to the generic webhook (documented in /openapi/webhook-publicacion.yaml). */
export const CMS_WEBHOOK_EVENTS = ["ping", "content.publish", "content.unpublish"] as const;
export type CmsWebhookEvent = (typeof CMS_WEBHOOK_EVENTS)[number];
