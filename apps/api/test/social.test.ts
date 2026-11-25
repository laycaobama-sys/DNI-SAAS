import { describe, expect, it } from "vitest";
import { hmacSha256Hex, META_GRAPH_VERSION, socialPostProblems } from "@dni/core";
import { publishDueSocialPosts } from "../src/lib/social-publish";
import { socialMediaUrl } from "../src/lib/meta";
import { createHarness } from "./helpers";

const KEY = "0123456789abcdef".repeat(4);
const APP_SECRET = ["test", "meta", "secret"].join("-");
const USER_TOKEN = ["user", "token", "long"].join("-");
const PAGE_TOKEN = ["page", "token", "value"].join("-");
const G = `https://graph.facebook.com/${META_GRAPH_VERSION}`;

/** 1080×1080 JPEG header (enough for the size check). */
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x04, 0x38, 0x04, 0x38, 0x03, ...new Array(40).fill(0)]);
const WIDE_JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x01, 0x00, 0x08, 0x00, 0x03, ...new Array(40).fill(0)]); // 2048×256

interface Fake {
  igStatus: string[];
  feedFails?: "network" | "ratelimit" | "token";
  permissions?: string[];
}

function setup(fake: Partial<Fake> = {}) {
  const h = createHarness();
  Object.assign(h.env, { META_APP_ID: "123456", META_APP_SECRET: APP_SECRET, DATA_ENC_KEY: KEY });
  const state: Fake = { igStatus: ["FINISHED"], ...fake };
  const calls: Array<{ method: string; url: string; body: string; auth: string | null }> = [];
  const store = new Map<string, Uint8Array>();
  h.env.MEDIA = {
    put: async (k: string, v: Uint8Array) => void store.set(k, v),
    get: async (k: string, o?: { range?: { length: number } }) => {
      const v = store.get(k);
      if (!v) return null;
      const bytes = o?.range ? v.slice(0, o.range.length) : v;
      return { body: bytes, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) };
    },
    delete: async (k: string) => void store.delete(k),
  } as unknown as R2Bucket;
  const realFetch = h.deps.fetchImpl;
  h.deps.fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (!url.startsWith(G)) return realFetch(input, init);
    const method = init?.method ?? "GET";
    const body = String(init?.body ?? "");
    const auth = new Headers(init?.headers).get("authorization");
    calls.push({ method, url, body, auth });
    const u = new URL(url);
    const path = u.pathname.replace(`/${META_GRAPH_VERSION}`, "");
    if (path === "/oauth/access_token") {
      if (u.searchParams.get("grant_type") === "fb_exchange_token") return Response.json({ access_token: USER_TOKEN, expires_in: 5183944 });
      return Response.json({ access_token: "short-token" });
    }
    if (path === "/me") return Response.json({ id: "9001", name: "Titular" });
    if (path === "/me/permissions" && method === "GET")
      return Response.json({ data: (state.permissions ?? ["pages_show_list", "pages_manage_posts", "pages_read_engagement", "instagram_basic", "instagram_content_publish"]).map((p) => ({ permission: p, status: "granted" })) });
    if (path === "/me/permissions" && method === "DELETE") return Response.json({ success: true });
    if (path === "/me/accounts")
      return Response.json({
        data: [
          { id: "111", name: "Mi Página", access_token: PAGE_TOKEN, tasks: ["CREATE_CONTENT", "MANAGE"], instagram_business_account: { id: "222", username: "minegocio" } },
          { id: "333", name: "Página sin permiso", access_token: "x", tasks: ["ANALYZE"] },
        ],
      });
    if (path === "/111/feed" || path === "/111/photos") {
      if (state.feedFails === "network") throw new Error("ECONNRESET");
      if (state.feedFails === "ratelimit") return Response.json({ error: { code: 4, message: "Application request limit reached" } }, { status: 400 });
      if (state.feedFails === "token") return Response.json({ error: { code: 190, type: "OAuthException", message: "Error validating access token" } }, { status: 400 });
      return path === "/111/photos" ? Response.json({ id: "photo1", post_id: "111_555" }) : Response.json({ id: "111_444" });
    }
    if (path === "/222/media") return Response.json({ id: "container-1" });
    if (path === "/container-1") return Response.json({ status_code: state.igStatus.shift() ?? "FINISHED" });
    if (path === "/222/media_publish") return Response.json({ id: "ig-media-1" });
    if (path === "/ig-media-1") return Response.json({ permalink: "https://www.instagram.com/p/abc/" });
    return Response.json({ error: { code: 100, message: "unknown path" } }, { status: 400 });
  }) as typeof fetch;

  async function ownerOrg(plan = "starter", email = "owner@example.com") {
    const owner = await h.signup(email);
    const orgId = await h.createOrg(owner, "Org Social", plan);
    return { owner, orgId };
  }

  async function connect(client: InstanceType<typeof h.Client>, orgId: string, q = "code=authcode") {
    const r = await client.post(`/api/v1/orgs/${orgId}/social/connect`);
    expect(r.status).toBe(200);
    const loc = new URL(r.json.url);
    const stateCookie = /dni_meta_state=([0-9a-f]{64})/.exec(r.headers.get("set-cookie") ?? "")?.[1];
    const cb = await h.app.request(`/api/v1/auth/meta/callback?state=${loc.searchParams.get("state")}&${q}`, { headers: { cookie: `dni_meta_state=${stateCookie}; ${client.cookie}`, "cf-connecting-ip": "203.0.113.7" } }, h.env, h.ctx);
    return { loc, cb, location: cb.headers.get("location") ?? "" };
  }

  async function image(orgId: string, bytes = JPEG, type = "image/jpeg") {
    const id = crypto.randomUUID();
    const key = `media/${orgId}/uploads/${id}`;
    store.set(key, bytes);
    await h.db.prepare("INSERT INTO media_uploads (id, organization_id, r2_key, kind, content_type, bytes, name, rights_confirmed, created_at) VALUES (?, ?, ?, 'image', ?, ?, 'foto.jpg', 1, ?)").bind(id, orgId, key, type, bytes.byteLength, new Date().toISOString()).run();
    return id;
  }

  async function accountsOf(client: InstanceType<typeof h.Client>, orgId: string) {
    const g = await client.get(`/api/v1/orgs/${orgId}/social`);
    return { fb: g.json.accounts.find((a: any) => a.network === "facebook"), ig: g.json.accounts.find((a: any) => a.network === "instagram"), data: g.json };
  }

  async function approved(client: InstanceType<typeof h.Client>, orgId: string, body: Record<string, unknown>) {
    const c = await client.post(`/api/v1/orgs/${orgId}/social/posts`, body);
    expect(c.status).toBe(201);
    const s = await client.post(`/api/v1/orgs/${orgId}/social/posts/${c.json.id}/submit`);
    expect(s.status).toBe(200);
    const a = await client.post(`/api/v1/orgs/${orgId}/social/posts/${c.json.id}/review`, { decision: "approve", expectedVersion: s.json.version });
    expect(a.status).toBe(200);
    expect(a.json.status).toBe("approved");
    return c.json.id as string;
  }

  return { h, calls, state, ownerOrg, connect, image, accountsOf, approved, store };
}

describe("Meta: Facebook + Instagram publishing", () => {
  it("connects with Facebook Login, keeps only encrypted tokens and lists publishable Pages + Instagram", async () => {
    const { h, calls, ownerOrg, connect, accountsOf } = setup();
    const { owner, orgId } = await ownerOrg();
    const { loc, location } = await connect(owner, orgId);
    expect(loc.origin + loc.pathname).toBe(`https://www.facebook.com/${META_GRAPH_VERSION}/dialog/oauth`);
    expect(loc.searchParams.get("redirect_uri")).toBe("http://localhost:8787/api/v1/auth/meta/callback");
    expect(loc.searchParams.get("scope")).toContain("instagram_content_publish");
    expect(location).toBe(`/app/o/${orgId}/social?meta=connected&cuentas=2`);
    const { fb, ig } = await accountsOf(owner, orgId);
    expect(fb.name).toBe("Mi Página");
    expect(ig.username).toBe("minegocio");
    // The Page without CREATE_CONTENT/MANAGE is not offered.
    expect((await accountsOf(owner, orgId)).data.accounts).toHaveLength(2);
    // Tokens: never in plain text in the database, never in the API answer.
    const dump = JSON.stringify(h.db.raw.prepare("SELECT * FROM social_accounts").all()) + JSON.stringify(h.db.raw.prepare("SELECT * FROM integration_secrets").all());
    expect(dump).not.toContain(PAGE_TOKEN);
    expect(dump).not.toContain(USER_TOKEN);
    expect(JSON.stringify((await accountsOf(owner, orgId)).data)).not.toContain(PAGE_TOKEN);
    // Every call with a token carries appsecret_proof and the token travels in the header, not the URL.
    for (const c of calls.filter((x) => x.auth)) {
      expect(c.url + c.body).toContain(`appsecret_proof=${await hmacSha256Hex(APP_SECRET, c.auth!.replace("Bearer ", ""))}`);
      expect(c.url).not.toContain(PAGE_TOKEN);
    }
  });

  it("refuses the connection when Facebook did not grant the publishing permission", async () => {
    const { ownerOrg, connect } = setup({ permissions: ["pages_show_list"] });
    const { owner, orgId } = await ownerOrg();
    expect((await connect(owner, orgId)).location).toContain("meta_error=scope_not_granted");
  });

  it("is part of the Starter plan and of the roles that may use it", async () => {
    const { h, ownerOrg, connect } = setup();
    const free = await ownerOrg("free", "free@example.com");
    expect((await free.owner.get(`/api/v1/orgs/${free.orgId}/social`)).status).toBe(402);
    const { owner, orgId } = await ownerOrg("growth");
    await connect(owner, orgId);
    const viewer = await h.invite(owner, orgId, "viewer@example.com", "client_viewer");
    expect((await viewer.post(`/api/v1/orgs/${orgId}/social/connect`)).status).toBe(403);
    expect((await viewer.post(`/api/v1/orgs/${orgId}/social/pause`, { paused: true })).status).toBe(403);
  });

  it("publishes an approved Facebook post once, at its time, and records who approved it", async () => {
    const { h, calls, ownerOrg, connect, accountsOf, approved } = setup();
    const { owner, orgId } = await ownerOrg();
    await connect(owner, orgId);
    const { fb } = await accountsOf(owner, orgId);
    const future = await approved(owner, orgId, { accountId: fb.id, caption: "Mañana abrimos", scheduledAt: new Date(Date.now() + 3_600_000).toISOString() });
    const now = await approved(owner, orgId, { accountId: fb.id, caption: "Hola", link: "https://dnigrowth.com/precios" });
    expect(await publishDueSocialPosts(h.env, h.deps)).toEqual({ published: 1, failed: 0 });
    expect(await publishDueSocialPosts(h.env, h.deps)).toEqual({ published: 0, failed: 0 });
    expect(calls.filter((c) => c.url.includes("/111/feed"))).toHaveLength(1);
    const posts = (await accountsOf(owner, orgId)).data.posts;
    expect(posts.find((p: any) => p.id === now).status).toBe("published");
    expect(posts.find((p: any) => p.id === now).externalUrl).toBe("https://www.facebook.com/111_444");
    expect(posts.find((p: any) => p.id === future).status).toBe("approved");
    const audit = h.db.raw.prepare("SELECT action, approved_by FROM audit_logs WHERE entity_id = ? ORDER BY created_at").all(now) as Array<{ action: string; approved_by: string | null }>;
    expect(audit.map((a) => a.action)).toEqual(["social.post_create", "social.post_submit", "social.post_approve", "social.post_published"]);
    expect(audit.at(-1)!.approved_by).toBeTruthy();
  });

  it("checks Instagram rules before approval and publishes through a container, resuming it without duplicates", async () => {
    const { h, calls, ownerOrg, connect, accountsOf, approved, image } = setup({ igStatus: ["IN_PROGRESS", "FINISHED"] });
    const { owner, orgId } = await ownerOrg();
    await connect(owner, orgId);
    const { ig } = await accountsOf(owner, orgId);
    // No image → refused before reaching Meta.
    const noImg = await owner.post(`/api/v1/orgs/${orgId}/social/posts`, { accountId: ig.id, caption: "Sin foto" });
    const sub = await owner.post(`/api/v1/orgs/${orgId}/social/posts/${noImg.json.id}/submit`);
    expect(sub.status).toBe(422);
    expect(sub.json.title).toContain("Instagram necesita una imagen");
    // Wrong proportion → refused too.
    const wide = await owner.post(`/api/v1/orgs/${orgId}/social/posts`, { accountId: ig.id, caption: "Panorámica", mediaId: await image(orgId, WIDE_JPEG) });
    expect((await owner.post(`/api/v1/orgs/${orgId}/social/posts/${wide.json.id}/submit`)).json.title).toContain("proporción");
    const id = await approved(owner, orgId, { accountId: ig.id, caption: "Nueva carta #otoño", mediaId: await image(orgId) });
    expect(await publishDueSocialPosts(h.env, h.deps)).toEqual({ published: 0, failed: 0 }); // image still processing
    expect((await accountsOf(owner, orgId)).data.posts.find((p: any) => p.id === id).status).toBe("publishing");
    expect(await publishDueSocialPosts(h.env, h.deps)).toEqual({ published: 1, failed: 0 });
    expect(calls.filter((c) => c.url.endsWith("/222/media"))).toHaveLength(1);
    expect(calls.filter((c) => c.url.endsWith("/222/media_publish"))).toHaveLength(1);
    const p = (await accountsOf(owner, orgId)).data.posts.find((x: any) => x.id === id);
    expect(p.status).toBe("published");
    expect(p.externalUrl).toBe("https://www.instagram.com/p/abc/");
    // Meta downloaded the image from our signed URL.
    const imgUrl = new URLSearchParams(calls.find((c) => c.url.endsWith("/222/media"))!.body).get("image_url")!;
    expect(imgUrl).toMatch(/^http:\/\/localhost:8787\/api\/v1\/public\/social-media\//);
    const anon = new h.Client();
    expect((await anon.get(new URL(imgUrl).pathname)).status).toBe(200);
    expect((await anon.get(new URL(imgUrl).pathname.replace(/[0-9a-f]{32}\.jpg$/, `${"0".repeat(32)}.jpg`))).status).toBe(404);
  });

  it("never posts while paused (kill switch)", async () => {
    const { h, calls, ownerOrg, connect, accountsOf, approved } = setup();
    const { owner, orgId } = await ownerOrg();
    await connect(owner, orgId);
    const { fb } = await accountsOf(owner, orgId);
    await approved(owner, orgId, { accountId: fb.id, caption: "Hola" });
    expect((await owner.post(`/api/v1/orgs/${orgId}/social/pause`, { paused: true })).status).toBe(200);
    await publishDueSocialPosts(h.env, h.deps);
    expect(calls.filter((c) => c.url.includes("/111/feed"))).toHaveLength(0);
    await owner.post(`/api/v1/orgs/${orgId}/social/pause`, { paused: false });
    expect((await publishDueSocialPosts(h.env, h.deps)).published).toBe(1);
  });

  it("does not retry a Facebook post whose outcome is unknown, but retries rate limits later", async () => {
    const net = setup({ feedFails: "network" });
    const a = await net.ownerOrg();
    await net.connect(a.owner, a.orgId);
    const id = await net.approved(a.owner, a.orgId, { accountId: (await net.accountsOf(a.owner, a.orgId)).fb.id, caption: "Hola" });
    expect((await publishDueSocialPosts(net.h.env, net.h.deps)).failed).toBe(1);
    const p = (await net.accountsOf(a.owner, a.orgId)).data.posts.find((x: any) => x.id === id);
    expect(p.status).toBe("failed");
    expect(p.lastError).toContain("Revisa tu página");

    const rl = setup({ feedFails: "ratelimit" });
    const b = await rl.ownerOrg();
    await rl.connect(b.owner, b.orgId);
    const id2 = await rl.approved(b.owner, b.orgId, { accountId: (await rl.accountsOf(b.owner, b.orgId)).fb.id, caption: "Hola" });
    await publishDueSocialPosts(rl.h.env, rl.h.deps);
    const p2 = (await rl.accountsOf(b.owner, b.orgId)).data.posts.find((x: any) => x.id === id2);
    expect(p2.status).toBe("approved");
    expect(Date.parse(p2.scheduledAt)).toBeGreaterThan(Date.now() + 10 * 60_000);
  });

  it("marks the connection for re-authorisation when Meta rejects the token", async () => {
    const { h, ownerOrg, connect, accountsOf, approved } = setup({ feedFails: "token" });
    const { owner, orgId } = await ownerOrg();
    await connect(owner, orgId);
    await approved(owner, orgId, { accountId: (await accountsOf(owner, orgId)).fb.id, caption: "Hola" });
    await publishDueSocialPosts(h.env, h.deps);
    const d = (await accountsOf(owner, orgId)).data;
    expect(d.connection.status).toBe("reauth_required");
    expect(d.posts[0].lastError).toContain("Vuelve a conectar");
  });

  it("another organisation cannot see, approve or publish this organisation's posts", async () => {
    const { h, ownerOrg, connect, accountsOf } = setup();
    const { owner, orgId } = await ownerOrg();
    await connect(owner, orgId);
    const c = await owner.post(`/api/v1/orgs/${orgId}/social/posts`, { accountId: (await accountsOf(owner, orgId)).fb.id, caption: "Privado" });
    const other = await ownerOrg("starter", "other@example.com");
    expect((await other.owner.get(`/api/v1/orgs/${orgId}/social`)).status).toBe(404);
    expect((await other.owner.post(`/api/v1/orgs/${other.orgId}/social/posts/${c.json.id}/submit`)).status).toBe(404);
    expect((await other.owner.get(`/api/v1/orgs/${other.orgId}/social`)).json.posts).toHaveLength(0);
    // Another org's account cannot be used to post either.
    const fbId = (await accountsOf(owner, orgId)).fb.id;
    expect((await other.owner.post(`/api/v1/orgs/${other.orgId}/social/posts`, { accountId: fbId, caption: "x" })).status).toBe(404);
    expect(h).toBeTruthy();
  });

  it("Meta deauthorize callback: valid signature removes tokens and cancels pending posts; forged one is refused", async () => {
    const { h, ownerOrg, connect, accountsOf, approved } = setup();
    const { owner, orgId } = await ownerOrg();
    await connect(owner, orgId);
    await approved(owner, orgId, { accountId: (await accountsOf(owner, orgId)).fb.id, caption: "Hola", scheduledAt: new Date(Date.now() + 3_600_000).toISOString() });
    const b64u = (s: string | Uint8Array) => btoa(typeof s === "string" ? s : String.fromCharCode(...s)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    const payload = b64u(JSON.stringify({ algorithm: "HMAC-SHA256", user_id: "9001", issued_at: 1 }));
    const sigHex = await hmacSha256Hex(APP_SECRET, payload);
    const sig = b64u(Uint8Array.from(sigHex.match(/../g)!.map((x) => parseInt(x, 16))));
    const send = (sr: string) => h.app.request("/api/v1/webhooks/meta/deauthorize", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: `signed_request=${encodeURIComponent(sr)}` }, h.env, h.ctx);
    expect((await send(`${sig.slice(0, -2)}AA.${payload}`)).status).toBe(400);
    expect((await send(`${sig}.${payload}`)).status).toBe(200);
    const d = (await accountsOf(owner, orgId)).data;
    expect(d.connection.status).toBe("disconnected");
    expect(d.posts[0].status).toBe("cancelled");
    expect(h.db.raw.prepare("SELECT COUNT(*) AS n FROM integration_secrets").get()).toEqual({ n: 0 });
    expect(h.db.raw.prepare("SELECT COUNT(*) AS n FROM social_accounts WHERE token_enc IS NOT NULL").get()).toEqual({ n: 0 });
  });

  it("signed media URLs expire and only serve approved posts", async () => {
    const { h, ownerOrg, connect, accountsOf, image } = setup();
    const { owner, orgId } = await ownerOrg();
    await connect(owner, orgId);
    const c = await owner.post(`/api/v1/orgs/${orgId}/social/posts`, { accountId: (await accountsOf(owner, orgId)).fb.id, caption: "x", mediaId: await image(orgId) });
    const anon = new h.Client();
    const url = await socialMediaUrl(h.env, orgId, c.json.id);
    expect((await anon.get(new URL(url).pathname)).status).toBe(404); // still a draft
    const expired = await socialMediaUrl(h.env, orgId, c.json.id, -10);
    expect((await anon.get(new URL(expired).pathname)).status).toBe(404);
  });
});

describe("socialPostProblems", () => {
  it("applies each network's rules", () => {
    expect(socialPostProblems("facebook", { caption: "" })).toEqual(["Escribe un texto, añade un enlace o una imagen."]);
    expect(socialPostProblems("facebook", { caption: "Hola" })).toEqual([]);
    expect(socialPostProblems("instagram", { caption: `${"#a ".repeat(31)}`, media: { contentType: "image/jpeg", bytes: 1000, head: JPEG } })[0]).toContain("30 hashtags");
    expect(socialPostProblems("instagram", { caption: "x", media: { contentType: "image/png", bytes: 1000, head: new Uint8Array() } }).join(" ")).toContain("JPG");
    expect(socialPostProblems("instagram", { caption: "x", link: "https://a.es", media: { contentType: "image/jpeg", bytes: 1000, head: JPEG } }).join(" ")).toContain("enlaces");
    expect(socialPostProblems("instagram", { caption: "x".repeat(2201), media: { contentType: "image/jpeg", bytes: 1000, head: JPEG } }).join(" ")).toContain("2200");
  });
});
