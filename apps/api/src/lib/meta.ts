import { decryptJson, encryptJson, hmacSha256Hex, META_GRAPH_VERSION, timingSafeEqual } from "@dni/core";
import type { Deps, Env } from "../env";

/**
 * Meta Graph API plumbing for Facebook Pages + Instagram publishing. Every call goes to the fixed host
 * graph.facebook.com, carries `appsecret_proof` (Meta then rejects a leaked token used without our app
 * secret) and never logs or returns a token. Errors become MetaApiError with a sanitized code.
 */
const GRAPH = `https://graph.facebook.com/${META_GRAPH_VERSION}`;
export const META_DIALOG = `https://www.facebook.com/${META_GRAPH_VERSION}/dialog/oauth`;

export const metaReady = (env: Env) => !!env.META_APP_ID && !!env.META_APP_SECRET && /^[0-9a-f]{64}$/i.test(env.DATA_ENC_KEY ?? "");

export class MetaApiError extends Error {
  constructor(
    public readonly code: string,
    public readonly status = 0,
    /** Meta's own user-facing message (no tokens), safe to show. */
    public readonly userMessage: string | null = null,
  ) {
    super(code);
  }
  /** Token expired, revoked or password changed: the user has to connect again. */
  get needsReauth() {
    // 190 invalid/expired token · 102 session · 10/200 permission withdrawn.
    return /^meta_(190|102|10|200)(_|$)/.test(this.code);
  }
}

const proof = (env: Env, token: string) => hmacSha256Hex(env.META_APP_SECRET!, token);

export async function graph<T = any>(
  env: Env,
  deps: Deps,
  path: string,
  opts: { method?: "GET" | "POST" | "DELETE"; token?: string; params?: Record<string, string> } = {},
): Promise<T> {
  const method = opts.method ?? "GET";
  const params = new URLSearchParams(opts.params ?? {});
  if (opts.token) params.set("appsecret_proof", await proof(env, opts.token));
  const url = new URL(`${GRAPH}${path}`);
  const headers: Record<string, string> = { accept: "application/json" };
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  let body: string | undefined;
  if (method === "GET" || method === "DELETE") url.search = params.toString();
  else {
    headers["content-type"] = "application/x-www-form-urlencoded";
    body = params.toString();
  }
  let res: Response;
  try {
    res = await deps.fetchImpl(url.toString(), { method, headers, body, redirect: "manual", signal: AbortSignal.timeout(25_000) });
  } catch {
    throw new MetaApiError("network_error");
  }
  const text = await res.text();
  let json: any;
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = {};
  }
  if (!res.ok || json.error) {
    const e = json.error ?? {};
    const code = typeof e.code === "number" ? `meta_${e.code}` : `http_${res.status}`;
    const sub = typeof e.error_subcode === "number" ? `_${e.error_subcode}` : "";
    const userMsg = typeof e.error_user_msg === "string" ? e.error_user_msg.slice(0, 200) : null;
    throw new MetaApiError(`${code}${sub}`.slice(0, 40), res.status, userMsg);
  }
  return json as T;
}

/** Server-side code → short-lived user token → long-lived user token (~60 days). */
export async function exchangeCode(env: Env, deps: Deps, code: string, redirectUri: string): Promise<{ token: string; expiresIn: number | null }> {
  const short = await graph<{ access_token: string }>(env, deps, "/oauth/access_token", {
    params: { client_id: env.META_APP_ID!, client_secret: env.META_APP_SECRET!, redirect_uri: redirectUri, code },
  });
  const long = await graph<{ access_token: string; expires_in?: number }>(env, deps, "/oauth/access_token", {
    params: { grant_type: "fb_exchange_token", client_id: env.META_APP_ID!, client_secret: env.META_APP_SECRET!, fb_exchange_token: short.access_token },
  });
  return { token: long.access_token, expiresIn: typeof long.expires_in === "number" ? long.expires_in : null };
}

export interface MetaPage {
  id: string;
  name: string;
  access_token?: string;
  tasks?: string[];
  instagram_business_account?: { id: string; username?: string; name?: string };
}

/** Pages the user manages (with a Page token each) and the Instagram professional account linked to each. */
export async function listPages(env: Env, deps: Deps, userToken: string): Promise<MetaPage[]> {
  const out: MetaPage[] = [];
  let after: string | null = null;
  for (let i = 0; i < 5; i++) {
    const params: Record<string, string> = { fields: "id,name,access_token,tasks,instagram_business_account{id,username,name}", limit: "100" };
    if (after) params.after = after;
    const r: { data?: MetaPage[]; paging?: { cursors?: { after?: string }; next?: string } } = await graph(env, deps, "/me/accounts", { token: userToken, params });
    out.push(...(r.data ?? []));
    after = r.paging?.next ? (r.paging.cursors?.after ?? null) : null;
    if (!after) break;
  }
  return out;
}

export const canPublishOnPage = (p: MetaPage) => !p.tasks || p.tasks.includes("CREATE_CONTENT") || p.tasks.includes("MANAGE");

// ── Token envelopes (AES-256-GCM, AAD binds organization + row) ─────────────────────────────────────
export const sealUserToken = (env: Env, orgId: string, integrationId: string, token: string, expiresAt: string | null) =>
  encryptJson(env.DATA_ENC_KEY!, { t: token, exp: expiresAt }, `meta-user:${orgId}:${integrationId}`);
export const openUserToken = (env: Env, orgId: string, integrationId: string, env_: string) =>
  decryptJson<{ t: string; exp: string | null }>(env.DATA_ENC_KEY!, env_, `meta-user:${orgId}:${integrationId}`);
export const sealPageToken = (env: Env, orgId: string, accountId: string, token: string) => encryptJson(env.DATA_ENC_KEY!, { t: token }, `meta-page:${orgId}:${accountId}`);
export const openPageToken = async (env: Env, orgId: string, accountId: string, env_: string) =>
  (await decryptJson<{ t: string }>(env.DATA_ENC_KEY!, env_, `meta-page:${orgId}:${accountId}`)).t;

// ── Publishing ─────────────────────────────────────────────────────────────────────────────────────
export async function publishFacebook(env: Env, deps: Deps, pageId: string, pageToken: string, p: { caption: string; link?: string | null; imageUrl?: string | null }) {
  if (p.imageUrl) {
    const r = await graph<{ id: string; post_id?: string }>(env, deps, `/${pageId}/photos`, { method: "POST", token: pageToken, params: { url: p.imageUrl, ...(p.caption ? { message: p.caption } : {}), published: "true" } });
    const postId = r.post_id ?? r.id;
    return { id: postId, url: `https://www.facebook.com/${postId}` };
  }
  const r = await graph<{ id: string }>(env, deps, `/${pageId}/feed`, { method: "POST", token: pageToken, params: { ...(p.caption ? { message: p.caption } : {}), ...(p.link ? { link: p.link } : {}) } });
  return { id: r.id, url: `https://www.facebook.com/${r.id}` };
}

export const createIgContainer = (env: Env, deps: Deps, igId: string, token: string, imageUrl: string, caption: string) =>
  graph<{ id: string }>(env, deps, `/${igId}/media`, { method: "POST", token, params: { image_url: imageUrl, ...(caption ? { caption } : {}) } }).then((r) => r.id);

export const igContainerStatus = (env: Env, deps: Deps, containerId: string, token: string) =>
  graph<{ status_code?: string }>(env, deps, `/${containerId}`, { token, params: { fields: "status_code" } }).then((r) => r.status_code ?? "UNKNOWN");

export async function igPublish(env: Env, deps: Deps, igId: string, token: string, containerId: string) {
  const r = await graph<{ id: string }>(env, deps, `/${igId}/media_publish`, { method: "POST", token, params: { creation_id: containerId } });
  let url: string | null;
  try {
    url = (await graph<{ permalink?: string }>(env, deps, `/${r.id}`, { token, params: { fields: "permalink" } })).permalink ?? null;
  } catch {
    url = null;
  }
  return { id: r.id, url };
}

// ── Meta callbacks (deauthorize / data deletion): signed_request = base64url(sig).base64url(payload) ───
const b64urlToBytes = (s: string) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(s.length / 4) * 4, "=")), (ch) => ch.charCodeAt(0));
export async function parseSignedRequest(secret: string, signed: string): Promise<{ user_id?: string; algorithm?: string } | null> {
  const [sig, payload] = signed.split(".");
  if (!sig || !payload || signed.length > 4096) return null;
  try {
    const expected = await hmacSha256Hex(secret, payload);
    const got = [...b64urlToBytes(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
    if (!timingSafeEqual(expected, got)) return null;
    const data = JSON.parse(new TextDecoder().decode(b64urlToBytes(payload))) as { user_id?: string; algorithm?: string };
    if (data.algorithm && data.algorithm.toUpperCase() !== "HMAC-SHA256") return null;
    return data;
  } catch {
    return null;
  }
}

// ── Signed, expiring public URL so Meta can download the image of an approved post ───────────────────
const mediaKey = (env: Env) => `social-media:${env.DATA_ENC_KEY}`;
export async function socialMediaUrl(env: Env, orgId: string, postId: string, ttlSeconds = 6 * 3600): Promise<string> {
  const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
  const sig = (await hmacSha256Hex(mediaKey(env), `${orgId}.${postId}.${exp}`)).slice(0, 32);
  return `${env.APP_ORIGIN.replace(/\/$/, "")}/api/v1/public/social-media/${orgId}/${postId}/${exp}/${sig}.jpg`;
}
export async function verifySocialMediaSig(env: Env, orgId: string, postId: string, exp: string, sig: string): Promise<boolean> {
  if (!/^\d{10}$/.test(exp) || Number(exp) < Date.now() / 1000 || !env.DATA_ENC_KEY) return false;
  const expected = (await hmacSha256Hex(mediaKey(env), `${orgId}.${postId}.${exp}`)).slice(0, 32);
  return timingSafeEqual(expected, sig);
}
