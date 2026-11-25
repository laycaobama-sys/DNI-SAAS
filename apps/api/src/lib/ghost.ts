import { decryptJson, encryptJson } from "@dni/core";
import type { Deps, Env } from "../env";
import { WpError, wpFetch } from "./wordpress";

/**
 * Ghost Admin API client (https://ghost.org/docs/admin-api/). Auth: a short-lived JWT (HS256, 5 minutes,
 * audience /admin/) signed with the custom integration's Admin API key. Same transport as WordPress:
 * SSRF guard, https only, no redirects, capped responses, errors never echo the key.
 */
export interface GhostCreds {
  /** Site root, e.g. https://blog.example.com */
  site: string;
  /** «id:secret» */
  key: string;
}
export interface GhostPost {
  id: string;
  url?: string;
  status: string;
  updated_at: string;
}

export const sealGhostCreds = (env: Env, orgId: string, integrationId: string, c: GhostCreds) => encryptJson(env.DATA_ENC_KEY!, c, `ghost:${orgId}:${integrationId}`);
export const openGhostCreds = (env: Env, orgId: string, integrationId: string, envelope: string) => decryptJson<GhostCreds>(env.DATA_ENC_KEY!, envelope, `ghost:${orgId}:${integrationId}`);

const b64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
const b64urlJson = (v: unknown) => b64url(new TextEncoder().encode(JSON.stringify(v)));
const hexBytes = (hex: string) => new Uint8Array(hex.match(/../g)!.map((h) => parseInt(h, 16)));

/** JWT for the Admin API. Exported for tests. */
export async function ghostToken(key: string, now = Math.floor(Date.now() / 1000)): Promise<string> {
  const [id, secret] = key.split(":") as [string, string];
  const head = `${b64urlJson({ alg: "HS256", typ: "JWT", kid: id })}.${b64urlJson({ iat: now, exp: now + 300, aud: "/admin/" })}`;
  const k = await crypto.subtle.importKey("raw", hexBytes(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(head)));
  return `${head}.${b64url(sig)}`;
}

const adminUrl = (site: string, path: string, query: Record<string, string> = {}) => {
  const u = new URL(`${site.replace(/\/$/, "")}/ghost/api/admin/${path.replace(/^\//, "")}`);
  for (const [k, v] of Object.entries(query)) u.searchParams.set(k, v);
  return u.toString();
};

async function ghostFetch<T>(deps: Deps, creds: GhostCreds, path: string, opts: { method?: "GET" | "POST" | "PUT"; json?: unknown; query?: Record<string, string> } = {}): Promise<T> {
  const r = await wpFetch<T>(deps, adminUrl(creds.site, path, opts.query), {
    method: opts.method,
    json: opts.json,
    headers: { authorization: `Ghost ${await ghostToken(creds.key)}`, "accept-version": "v5.0" },
    userAgent: "DNIGrowth-Ghost/1.0 (+https://dnigrowth.com)",
  });
  return r.data;
}

export const ghostSite = (deps: Deps, creds: GhostCreds) => ghostFetch<{ site?: { title?: string; url?: string; version?: string } }>(deps, creds, "site/");

const fields = "id,url,status,updated_at";
export async function ghostFindByTag(deps: Deps, creds: GhostCreds, tagSlug: string): Promise<GhostPost | null> {
  const r = await ghostFetch<{ posts?: GhostPost[] }>(deps, creds, "posts/", { query: { filter: `tag:${tagSlug}`, limit: "1", fields } });
  return r.posts?.[0] ?? null;
}
export async function ghostGetPost(deps: Deps, creds: GhostCreds, id: string): Promise<GhostPost> {
  const r = await ghostFetch<{ posts: GhostPost[] }>(deps, creds, `posts/${encodeURIComponent(id)}/`, { query: { fields } });
  return r.posts[0]!;
}
export async function ghostCreatePost(deps: Deps, creds: GhostCreds, post: Record<string, unknown>): Promise<GhostPost> {
  const r = await ghostFetch<{ posts: GhostPost[] }>(deps, creds, "posts/", { method: "POST", json: { posts: [post] }, query: { source: "html" } });
  return r.posts[0]!;
}
/** Ghost requires the post's current updated_at on every edit (collision detection). */
export async function ghostUpdatePost(deps: Deps, creds: GhostCreds, id: string, post: Record<string, unknown>): Promise<GhostPost> {
  const cur = await ghostGetPost(deps, creds, id);
  const r = await ghostFetch<{ posts: GhostPost[] }>(deps, creds, `posts/${encodeURIComponent(id)}/`, { method: "PUT", json: { posts: [{ ...post, updated_at: cur.updated_at }] }, query: { source: "html" } });
  return r.posts[0]!;
}

export function ghostFriendly(e: unknown): string {
  if (!(e instanceof WpError)) return "No se pudo hablar con Ghost. Inténtalo de nuevo en unos minutos.";
  if (e.code === "https_required") return "Ghost tiene que usar https.";
  if (e.code.startsWith("blocked_") || e.code === "invalid_url") return "Esa dirección no es una web pública.";
  if (e.code === "redirect") return "La dirección redirige a otra. Escribe la dirección final de tu Ghost (la que ves al abrir el panel de administración).";
  if (e.status === 401 || e.status === 403) return "Ghost no acepta la clave. Crea una integración personalizada en Ghost (Ajustes → Integraciones) y copia su «Admin API key».";
  if (e.status === 404) return "No encontramos la API de administración de Ghost en esa dirección.";
  if (e.status === 422) return "Ghost no aceptó el contenido. Revisa el título y el texto e inténtalo de nuevo.";
  if (e.unknownOutcome) return "Ghost no respondió. Vuelve a intentarlo: si la entrada ya se creó la encontraremos y no se duplicará.";
  return "Ghost respondió con un error. Inténtalo de nuevo en unos minutos.";
}
