import { assertResolvesPublic, decryptJson, encryptJson, UrlBlockedError, validatePublicUrl } from "@dni/core";
import type { Deps, Env } from "../env";

/**
 * WordPress REST API client. The customer's site is untrusted: every request re-checks that the host is
 * public (SSRF guard, same rules as the crawler), redirects are NOT followed (a redirect could send the
 * Authorization header elsewhere), responses are size-capped and errors never echo the password.
 */
export class WpError extends Error {
  constructor(
    public readonly code: string,
    public readonly status = 0,
    /** WordPress's own message (no credentials), safe to show. */
    public readonly userMessage: string | null = null,
  ) {
    super(code);
  }
  /** Credentials no longer valid (password revoked, user removed or demoted). */
  get needsReauth() {
    return this.status === 401 || this.code === "rest_cannot_create" || this.code === "incorrect_password" || this.code === "invalid_username";
  }
  /** Outcome unknown: the request may have reached WordPress. */
  get unknownOutcome() {
    return this.code === "network_error" || this.code === "timeout" || /^http_5/.test(this.code);
  }
}

export interface WpCreds {
  /** REST root, e.g. https://site.com/wp-json/ or https://site.com/?rest_route=/ */
  api: string;
  user: string;
  pass: string;
}

const MAX_BODY = 1_500_000;

export const sealWpCreds = (env: Env, orgId: string, integrationId: string, c: WpCreds) => encryptJson(env.DATA_ENC_KEY!, c, `wordpress:${orgId}:${integrationId}`);
export const openWpCreds = (env: Env, orgId: string, integrationId: string, envelope: string) => decryptJson<WpCreds>(env.DATA_ENC_KEY!, envelope, `wordpress:${orgId}:${integrationId}`);
export const wpReady = (env: Env) => /^[0-9a-f]{64}$/i.test(env.DATA_ENC_KEY ?? "");

/** Builds the URL of a REST route for both permalink styles. */
export function wpRoute(api: string, route: string, query: Record<string, string> = {}): string {
  const r = route.replace(/^\//, "");
  const u = api.includes("rest_route=") ? new URL(`${api.split("?")[0]}?rest_route=/${r}`) : new URL(r, api.endsWith("/") ? api : `${api}/`);
  for (const [k, v] of Object.entries(query)) u.searchParams.set(k, v);
  return u.toString();
}

async function readCapped(res: Response): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY) {
      await reader.cancel();
      throw new WpError("response_too_large");
    }
    chunks.push(value);
  }
  const all = new Uint8Array(size);
  let o = 0;
  for (const ch of chunks) {
    all.set(ch, o);
    o += ch.byteLength;
  }
  return new TextDecoder().decode(all);
}

/** One request to the site. `auth` false for discovery (no credentials sent before the host is known to be WordPress). */
export async function wpFetch<T = any>(
  deps: Deps,
  url: string,
  opts: { method?: "GET" | "POST" | "DELETE"; creds?: Pick<WpCreds, "user" | "pass">; json?: unknown; timeoutMs?: number } = {},
): Promise<{ data: T; status: number; headers: Headers }> {
  let target: URL;
  try {
    target = validatePublicUrl(url);
    if (target.protocol !== "https:") throw new WpError("https_required");
    await assertResolvesPublic(target, deps.resolve);
  } catch (e) {
    if (e instanceof WpError) throw e;
    throw new WpError(e instanceof UrlBlockedError ? `blocked_${e.reason}` : "invalid_url");
  }
  const headers: Record<string, string> = { accept: "application/json", "user-agent": "DNIGrowth-WordPress/1.0 (+https://dnigrowth.com)" };
  if (opts.creds) headers.authorization = `Basic ${btoa(unescape(encodeURIComponent(`${opts.creds.user}:${opts.creds.pass.replace(/\s+/g, "")}`)))}`;
  let body: string | undefined;
  if (opts.json !== undefined) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(opts.json);
  }
  let res: Response;
  try {
    res = await deps.fetchImpl(target.toString(), { method: opts.method ?? "GET", headers, body, redirect: "manual", signal: AbortSignal.timeout(opts.timeoutMs ?? 20_000) });
  } catch (e) {
    throw new WpError(e instanceof Error && e.name === "TimeoutError" ? "timeout" : "network_error");
  }
  if (res.status >= 300 && res.status < 400) {
    await res.body?.cancel();
    throw new WpError("redirect", res.status);
  }
  const text = await readCapped(res);
  let data: any;
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    throw new WpError(res.ok ? "not_json" : `http_${res.status}`, res.status);
  }
  if (!res.ok) {
    const code = typeof data?.code === "string" ? data.code.slice(0, 60) : `http_${res.status}`;
    const msg = typeof data?.message === "string" ? data.message.replace(/<[^>]*>/g, "").slice(0, 200) : null;
    throw new WpError(code, res.status, msg);
  }
  return { data: data as T, status: res.status, headers: res.headers };
}

/**
 * Finds the REST root of a WordPress site: /wp-json/ first, then ?rest_route= (sites without pretty
 * permalinks). Confirms it is WordPress (wp/v2 namespace) before any credential is sent.
 */
export async function discoverWpApi(deps: Deps, site: string): Promise<{ api: string; name: string | null }> {
  const candidates = [`${site}/wp-json/`, `${site}/?rest_route=/`];
  let last: WpError | null = null;
  for (const api of candidates) {
    try {
      const { data } = await wpFetch<{ namespaces?: string[]; name?: string }>(deps, api, { timeoutMs: 15_000 });
      if (Array.isArray(data.namespaces) && data.namespaces.includes("wp/v2")) return { api, name: typeof data.name === "string" ? data.name.slice(0, 120) : null };
      last = new WpError("not_wordpress");
    } catch (e) {
      last = e instanceof WpError ? e : new WpError("network_error");
      if (last.code.startsWith("blocked_") || last.code === "https_required") throw last;
    }
  }
  throw last ?? new WpError("not_wordpress");
}

export interface WpMe {
  id: number;
  name?: string;
  capabilities?: Record<string, boolean>;
}

/** Checks the credentials and that the user can publish posts. */
export async function wpWhoAmI(deps: Deps, creds: WpCreds): Promise<WpMe> {
  const { data } = await wpFetch<WpMe>(deps, wpRoute(creds.api, "wp/v2/users/me", { context: "edit" }), { creds });
  return data;
}

export interface WpPost {
  id: number;
  link?: string;
  status?: string;
  content?: { raw?: string };
}

export const wpCreatePost = (deps: Deps, creds: WpCreds, post: Record<string, unknown>) => wpFetch<WpPost>(deps, wpRoute(creds.api, "wp/v2/posts"), { method: "POST", creds, json: post }).then((r) => r.data);
export const wpUpdatePost = (deps: Deps, creds: WpCreds, id: string, post: Record<string, unknown>) =>
  wpFetch<WpPost>(deps, wpRoute(creds.api, `wp/v2/posts/${encodeURIComponent(id)}`), { method: "POST", creds, json: post }).then((r) => r.data);

/** Posts with this slug in any status (needs edit context to see drafts and the raw body with our marker). */
export const wpFindBySlug = (deps: Deps, creds: WpCreds, slug: string) =>
  wpFetch<WpPost[]>(deps, wpRoute(creds.api, "wp/v2/posts", { slug, status: "publish,future,draft,pending,private", context: "edit", per_page: "10" }), { creds }).then((r) => (Array.isArray(r.data) ? r.data : []));

/** Revokes the Application Password in use (best effort, when the customer disconnects). */
export async function wpRevokeCurrentPassword(deps: Deps, creds: WpCreds): Promise<boolean> {
  try {
    const { data } = await wpFetch<{ uuid?: string }>(deps, wpRoute(creds.api, "wp/v2/users/me/application-passwords/introspect"), { creds });
    if (!data.uuid || !/^[0-9a-f-]{36}$/i.test(data.uuid)) return false;
    await wpFetch(deps, wpRoute(creds.api, `wp/v2/users/me/application-passwords/${data.uuid}`), { method: "DELETE", creds });
    return true;
  } catch {
    return false;
  }
}

/** Customer-language explanation of a WordPress error. */
export function wpFriendly(e: unknown): string {
  if (!(e instanceof WpError)) return "Error inesperado al hablar con WordPress.";
  if (e.code.startsWith("blocked_")) return "Esa dirección no es una web pública accesible desde internet.";
  switch (e.code) {
    case "https_required":
      return "Tu web tiene que usar https:// para conectar con seguridad.";
    case "redirect":
      return "Tu web redirige a otra dirección. Escribe la dirección final exacta (por ejemplo con o sin «www»).";
    case "not_wordpress":
    case "rest_no_route":
      return "No encontramos la API de WordPress en esa dirección. Comprueba que es la web de WordPress y que su API REST no está bloqueada por un plugin de seguridad.";
    case "timeout":
    case "network_error":
      return "Tu web no respondió a tiempo. Inténtalo de nuevo en unos minutos.";
    case "response_too_large":
    case "not_json":
      return "La respuesta de tu web no es la de la API de WordPress (puede que un plugin de caché o seguridad la esté cambiando).";
    case "incorrect_password":
    case "invalid_username":
    case "rest_not_logged_in":
      return "WordPress no aceptó el usuario o la contraseña de aplicación. Crea una nueva en Usuarios → Perfil → Contraseñas de aplicación.";
    case "rest_cannot_create":
    case "rest_cannot_edit":
    case "rest_cannot_publish":
      return "Ese usuario de WordPress no tiene permiso para publicar entradas. Usa un usuario con rol Editor o Administrador.";
    default:
      if (e.status === 401) return "WordPress no aceptó las credenciales. Vuelve a conectar con una contraseña de aplicación nueva.";
      if (e.status === 403) return "Tu WordPress (o un plugin de seguridad) bloqueó la petición.";
      return e.userMessage ? `WordPress: ${e.userMessage}` : `WordPress respondió con un error (${e.code}).`;
  }
}

/** «DNI Growth Connector» plugin on the customer's site, or null when it is not installed/active. */
export interface WpPluginStatus {
  plugin: "dni-growth-connector";
  version: string;
  seoPlugin: "yoast" | "rank-math" | null;
  llmsTxt: boolean;
  canLlmsTxt: boolean;
}
export async function wpPluginStatus(deps: Deps, creds: WpCreds): Promise<WpPluginStatus | null> {
  try {
    const { data } = await wpFetch<WpPluginStatus>(deps, wpRoute(creds.api, "dni-growth/v1/status"), { creds, timeoutMs: 10_000 });
    return data && data.plugin === "dni-growth-connector" ? data : null;
  } catch (e) {
    if (e instanceof WpError && (e.status === 404 || e.code === "rest_no_route")) return null;
    throw e;
  }
}
export interface WpFixResult {
  id: string;
  field: string;
  before: string;
  after: string;
  postId: number;
  url?: string;
  repeated?: boolean;
  reverted?: string;
}
export const wpPluginFix = (deps: Deps, creds: WpCreds, body: { field: string; value: string; url?: string; attachment_id?: number; ref: string }) =>
  wpFetch<WpFixResult>(deps, wpRoute(creds.api, "dni-growth/v1/fix"), { method: "POST", creds, json: body }).then((r) => r.data);
export const wpPluginRevert = (deps: Deps, creds: WpCreds, postId: number, fixId: string) =>
  wpFetch<WpFixResult>(deps, wpRoute(creds.api, "dni-growth/v1/fix/revert"), { method: "POST", creds, json: { post_id: postId, fix_id: fixId } }).then((r) => r.data);
export const wpPluginLlms = (deps: Deps, creds: WpCreds, content: string) =>
  wpFetch<{ before: string; after: string; url: string }>(deps, wpRoute(creds.api, "dni-growth/v1/llms"), { method: "POST", creds, json: { content } }).then((r) => r.data);
