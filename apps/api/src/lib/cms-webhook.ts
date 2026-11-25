import { decryptJson, encryptJson, signWebhook, type CmsWebhookEvent } from "@dni/core";
import type { Deps, Env } from "../env";
import { WpError, wpFetch } from "./wordpress";

/**
 * Generic publishing webhook: a signed POST to the customer's https endpoint (Webflow through Make or
 * Zapier, n8n, their own backend…). Signature header `x-dni-signature: t=<unix>,v1=<hex HMAC-SHA256 of
 * "<t>.<raw body>">` with the secret shown once at connection time. `x-dni-delivery` is stable across
 * retries of the same send, so receivers can drop duplicates. Contract: /openapi/webhook-publicacion.yaml.
 */
export interface WebhookCreds {
  url: string;
  secret: string;
}
export const sealWebhookCreds = (env: Env, orgId: string, integrationId: string, c: WebhookCreds) => encryptJson(env.DATA_ENC_KEY!, c, `cms-webhook:${orgId}:${integrationId}`);
export const openWebhookCreds = (env: Env, orgId: string, integrationId: string, envelope: string) => decryptJson<WebhookCreds>(env.DATA_ENC_KEY!, envelope, `cms-webhook:${orgId}:${integrationId}`);

export function newWebhookSecret(): string {
  const b = crypto.getRandomValues(new Uint8Array(32));
  return `whsec_${[...b].map((x) => x.toString(16).padStart(2, "0")).join("")}`;
}

/** Sends one event. Returns what the receiver reported back (optional `id` and https `url`). */
export async function deliverCmsWebhook(deps: Deps, creds: WebhookCreds, event: CmsWebhookEvent, deliveryId: string, data: Record<string, unknown>): Promise<{ id: string | null; url: string | null }> {
  const body = JSON.stringify({ event, deliveryId, sentAt: new Date().toISOString(), data });
  const r = await wpFetch<{ id?: unknown; url?: unknown } | null>(deps, creds.url, {
    method: "POST",
    rawJson: body,
    headers: { "x-dni-signature": await signWebhook(creds.secret, body), "x-dni-event": event, "x-dni-delivery": deliveryId },
    userAgent: "DNIGrowth-Webhooks/1.0 (+https://dnigrowth.com)",
    lenient: true,
    timeoutMs: 15_000,
  });
  const d = r.data && typeof r.data === "object" ? r.data : {};
  const id = typeof d.id === "string" || typeof d.id === "number" ? String(d.id).slice(0, 40) : null;
  const url = typeof d.url === "string" && /^https:\/\//.test(d.url) ? d.url.slice(0, 600) : null;
  return { id, url };
}

export function webhookFriendly(e: unknown): string {
  if (!(e instanceof WpError)) return "No se pudo entregar el webhook. Inténtalo de nuevo en unos minutos.";
  if (e.code === "https_required") return "La dirección del webhook tiene que usar https.";
  if (e.code.startsWith("blocked_") || e.code === "invalid_url") return "Esa dirección no es pública: no enviamos datos a redes internas.";
  if (e.code === "redirect") return "La dirección del webhook redirige a otra. Usa la dirección final.";
  if (e.code === "timeout") return "Tu servidor tardó más de 15 segundos en responder.";
  if (e.unknownOutcome) return "Tu servidor no confirmó la entrega. Vuelve a intentarlo: el envío lleva el mismo identificador para que no se duplique.";
  if (e.status) return `Tu servidor respondió con el código ${e.status}. Tiene que responder con un 2xx.`;
  return "No se pudo entregar el webhook. Inténtalo de nuevo en unos minutos.";
}
