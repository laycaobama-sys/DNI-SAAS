import { describe, expect, it } from "vitest";
import { decryptJson, hmacSha256Hex } from "@dni/core";
import { ghostToken } from "../src/lib/ghost";
import { createHarness } from "./helpers";

const KEY = "0123456789abcdef".repeat(4);
const GHOST = "https://blog.panaderia-luna.es";
const GHOST_KEY = `${"a1".repeat(12)}:${"b2".repeat(32)}`;
const HOOK = "https://hooks.panaderia-luna.es/dni";

const b64urlDecode = (s: string) => JSON.parse(atob(s.replace(/-/g, "+").replace(/_/g, "/")));

interface GhostPost {
  id: string;
  title: string;
  html: string;
  status: string;
  slug: string;
  tags: string[];
  updated_at: string;
}

/** In-memory Ghost Admin API + a webhook receiver that checks signatures. */
function setup() {
  const h = createHarness({ dns: { "intranet.example.com": ["10.0.0.5"] } });
  Object.assign(h.env, { DATA_ENC_KEY: KEY });
  const ghost = { posts: new Map<string, GhostPost>(), next: 1, failAfterCreate: false, jwtOk: 0 };
  const hook = { events: [] as Array<{ event: string; delivery: string; body: any; validSig: boolean }>, secret: "", status: 200, reply: { id: "wf-1", url: "https://www.panaderia-luna.es/blog/pan" } as unknown };
  const realFetch = h.deps.fetchImpl;
  h.deps.fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const method = init?.method ?? "GET";
    const headers = new Headers(init?.headers);
    const body = String(init?.body ?? "");
    if (url.startsWith(HOOK)) {
      const sig = headers.get("x-dni-signature") ?? "";
      const m = sig.match(/^t=(\d+),v1=([0-9a-f]{64})$/);
      const validSig = !!m && hook.secret !== "" && (await hmacSha256Hex(hook.secret, `${m[1]}.${body}`)) === m[2];
      const j = JSON.parse(body);
      hook.events.push({ event: headers.get("x-dni-event")!, delivery: headers.get("x-dni-delivery")!, body: j, validSig });
      if (j.event === "ping") return new Response("ok", { status: 200 });
      return hook.status === 200 ? Response.json(hook.reply) : new Response("boom", { status: hook.status });
    }
    if (!url.startsWith(`${GHOST}/ghost/api/admin/`)) return realFetch(input, init);
    // JWT: HS256 signed with the hex-decoded secret, kid = key id, audience /admin/, 5 minutes.
    const token = (headers.get("authorization") ?? "").replace(/^Ghost /, "");
    const [hd, pl] = token.split(".");
    const head = b64urlDecode(hd!);
    const claims = b64urlDecode(pl!);
    const expected = await ghostToken(GHOST_KEY, claims.iat);
    if (head.kid !== GHOST_KEY.split(":")[0] || claims.aud !== "/admin/" || claims.exp - claims.iat !== 300 || token !== expected)
      return Response.json({ errors: [{ message: "Invalid token", type: "UnauthorizedError" }] }, { status: 401 });
    ghost.jwtOk++;
    const u = new URL(url);
    const path = u.pathname.replace("/ghost/api/admin", "");
    const out = (p: GhostPost) => ({ id: p.id, url: `${GHOST}/${p.slug}/`, status: p.status, updated_at: p.updated_at });
    if (path === "/site/") return Response.json({ site: { title: "Panadería Luna", version: "5.100" } });
    if (path === "/posts/" && method === "GET") {
      const tag = (u.searchParams.get("filter") ?? "").replace(/^tag:/, "");
      return Response.json({ posts: [...ghost.posts.values()].filter((p) => p.tags.includes(tag)).map(out) });
    }
    if (path === "/posts/" && method === "POST") {
      expect(u.searchParams.get("source")).toBe("html");
      const p = JSON.parse(body).posts[0];
      const post: GhostPost = { id: `g${ghost.next++}`, title: p.title, html: p.html, status: p.status, slug: p.slug, tags: (p.tags ?? []).map((x: { name: string }) => x.name.replace(/^#/, "hash-")), updated_at: `2026-11-25T10:00:0${ghost.next}.000Z` };
      ghost.posts.set(post.id, post);
      if (ghost.failAfterCreate) {
        ghost.failAfterCreate = false;
        throw new Error("ECONNRESET");
      }
      return Response.json({ posts: [out(post)] }, { status: 201 });
    }
    const m = path.match(/^\/posts\/([^/]+)\/$/);
    if (m) {
      const cur = ghost.posts.get(m[1]!);
      if (!cur) return Response.json({ errors: [{ message: "Post not found", type: "NotFoundError" }] }, { status: 404 });
      if (method === "GET") return Response.json({ posts: [out(cur)] });
      const p = JSON.parse(body).posts[0];
      if (p.updated_at !== cur.updated_at) return Response.json({ errors: [{ type: "UpdateCollisionError" }] }, { status: 409 });
      Object.assign(cur, { title: p.title ?? cur.title, html: p.html ?? cur.html, status: p.status ?? cur.status, updated_at: new Date().toISOString() });
      return Response.json({ posts: [out(cur)] });
    }
    return Response.json({ errors: [{ type: "NotFoundError" }] }, { status: 404 });
  }) as typeof fetch;

  async function ownerOrg(plan = "starter", email = "owner@panaderia-luna.es") {
    const owner = await h.signup(email);
    const orgId = await h.createOrg(owner, "Panadería Luna", plan);
    return { owner, orgId, O: `/api/v1/orgs/${orgId}` };
  }
  async function approvedArticle(owner: Awaited<ReturnType<typeof ownerOrg>>["owner"], O: string, title = "Cómo conservar el pan de masa madre") {
    const id = (await owner.post(`${O}/content/manual`, { kind: "blog_article", title })).json.id as string;
    const row = (await owner.get(`${O}/content/${id}`)).json;
    await owner.patch(`${O}/content/${id}`, { title, bodyMd: `# ${title}\n\nGuárdalo envuelto en un paño de algodón y lejos del frigorífico.\n\n## En resumen\n\nUn paño y una panera bastan.`, expectedVersion: row.version });
    expect((await owner.post(`${O}/content/${id}/submit`)).status).toBe(200);
    expect((await owner.post(`${O}/content/${id}/approve`, { acknowledgeChecks: true })).status).toBe(200);
    return id;
  }
  return { h, ghost, hook, ownerOrg, approvedArticle };
}

describe("Ghost publishing", () => {
  it("connects with an Admin API key (JWT), keeps it sealed, publishes once, updates and retires to draft", async () => {
    const { h, ghost, ownerOrg, approvedArticle } = setup();
    const { owner, orgId, O } = await ownerOrg();
    expect((await owner.post(`${O}/cms/ghost`, { apiUrl: GHOST, adminKey: "no-es-una-clave" })).status).toBe(422);
    const bad = await owner.post(`${O}/cms/ghost`, { apiUrl: GHOST, adminKey: `${"a1".repeat(12)}:${"ff".repeat(32)}` });
    expect(bad.status).toBe(422);
    expect(bad.json.title).toContain("Ghost no acepta la clave");

    const r = await owner.post(`${O}/cms/ghost`, { apiUrl: `${GHOST}/ghost/`, adminKey: GHOST_KEY });
    expect(r.status, JSON.stringify(r.json)).toBe(201);
    expect(r.json.ghost).toMatchObject({ status: "connected", target: GHOST });
    expect(JSON.stringify(r.json)).not.toContain("b2b2");
    const sec = await h.db.prepare("SELECT s.ciphertext, i.id FROM integration_secrets s JOIN integrations i ON i.id = s.integration_id WHERE s.organization_id = ? AND i.provider = 'ghost'").bind(orgId).first<{ ciphertext: string; id: string }>();
    expect(sec!.ciphertext).not.toContain("b2b2");
    expect(await decryptJson(KEY, sec!.ciphertext, `ghost:${orgId}:${sec!.id}`)).toMatchObject({ site: GHOST, key: GHOST_KEY });

    const id = await approvedArticle(owner, O);
    const p1 = await owner.post(`${O}/content/${id}/external/ghost`, { status: "publish" });
    expect(p1.status, JSON.stringify(p1.json)).toBe(200);
    expect(p1.json.publication).toMatchObject({ state: "published", url: `${GHOST}/como-conservar-el-pan-de-masa-madre/` });
    expect(ghost.posts.size).toBe(1);
    const post = [...ghost.posts.values()][0]!;
    expect(post.html).toContain("paño de algodón");
    expect(post.html).not.toContain("<h1");

    // Second send updates the same post (with Ghost's collision check), never a second one.
    const p2 = await owner.post(`${O}/content/${id}/external/ghost`, { status: "draft" });
    expect(p2.json.publication.state).toBe("draft");
    expect(ghost.posts.size).toBe(1);

    const un = await owner.post(`${O}/content/${id}/external/ghost/unpublish`);
    expect(un.status, JSON.stringify(un.json)).toBe(200);
    expect(un.json.publication.state).toBe("unpublished");
    expect(post.status).toBe("draft");
    const audit = await h.db.prepare("SELECT COUNT(*) AS n FROM audit_logs WHERE organization_id = ? AND action LIKE 'cms.ghost_%'").bind(orgId).first<{ n: number }>();
    expect(audit!.n).toBe(4); // connect, publish ×2, unpublish
  });

  it("a retry after a lost answer finds the post by its internal tag instead of duplicating it", async () => {
    const { ghost, ownerOrg, approvedArticle } = setup();
    const { owner, O } = await ownerOrg();
    await owner.post(`${O}/cms/ghost`, { apiUrl: GHOST, adminKey: GHOST_KEY });
    const id = await approvedArticle(owner, O);
    ghost.failAfterCreate = true;
    const lost = await owner.post(`${O}/content/${id}/external/ghost`, { status: "publish" });
    expect(lost.status).toBe(502);
    expect(lost.json.title).toContain("no se duplicará");
    const retry = await owner.post(`${O}/content/${id}/external/ghost`, { status: "publish" });
    expect(retry.status, JSON.stringify(retry.json)).toBe(200);
    expect(ghost.posts.size).toBe(1);
  });

  it("only approved content, only roles with content:approve, and from the Starter plan", async () => {
    const { h, ownerOrg, approvedArticle } = setup();
    const free = await ownerOrg("free", "free@panaderia-luna.es");
    expect((await free.owner.post(`${free.O}/cms/ghost`, { apiUrl: GHOST, adminKey: GHOST_KEY })).status).toBe(402);

    const { owner, orgId, O } = await ownerOrg("growth");
    await owner.post(`${O}/cms/ghost`, { apiUrl: GHOST, adminKey: GHOST_KEY });
    const draft = (await owner.post(`${O}/content/manual`, { kind: "blog_article", title: "Sin aprobar" })).json.id;
    expect((await owner.post(`${O}/content/${draft}/external/ghost`, { status: "publish" })).status).toBe(409);
    const id = await approvedArticle(owner, O);
    const editor = await h.invite(owner, orgId, "editor@panaderia-luna.es", "editor");
    expect((await editor.post(`${O}/content/${id}/external/ghost`, { status: "publish" })).status).toBe(403);
    expect((await editor.post(`${O}/cms/ghost`, { apiUrl: GHOST, adminKey: GHOST_KEY })).status).toBe(403);
    // Another organisation cannot see or send this content.
    const other = await ownerOrg("starter", "otra@ejemplo.es");
    expect((await other.owner.post(`${other.O}/content/${id}/external/ghost`, { status: "publish" })).status).toBe(404);
  });
});

describe("Generic webhook", () => {
  it("connects only to public https endpoints, shows the secret once and signs every event", async () => {
    const { h, hook, ownerOrg, approvedArticle } = setup();
    const { owner, orgId, O } = await ownerOrg();
    expect((await owner.post(`${O}/cms/webhook`, { url: "http://hooks.panaderia-luna.es/dni" })).status).toBe(422);
    const internal = await owner.post(`${O}/cms/webhook`, { url: "https://intranet.example.com/hook" });
    expect(internal.status).toBe(422);
    expect(hook.events).toHaveLength(0);

    // The receiver only learns the secret from our answer; capture it to verify the ping retroactively.
    const r = await owner.post(`${O}/cms/webhook`, { url: HOOK });
    expect(r.status, JSON.stringify(r.json)).toBe(201);
    expect(r.json.secret).toMatch(/^whsec_[0-9a-f]{64}$/);
    hook.secret = r.json.secret;
    expect(hook.events[0]!.event).toBe("ping");
    expect((await owner.get(`${O}/cms/external`)).json.webhook).toMatchObject({ status: "connected", target: HOOK });
    expect(JSON.stringify((await owner.get(`${O}/cms/external`)).json)).not.toContain("whsec_");

    const id = await approvedArticle(owner, O);
    const p = await owner.post(`${O}/content/${id}/external/webhook`, { status: "publish" });
    expect(p.status, JSON.stringify(p.json)).toBe(200);
    expect(p.json.publication).toMatchObject({ state: "published", url: "https://www.panaderia-luna.es/blog/pan", externalId: "wf-1" });
    const ev = hook.events.at(-1)!;
    expect(ev).toMatchObject({ event: "content.publish", validSig: true });
    expect(ev.body.data).toMatchObject({ contentId: id, status: "publish", title: "Cómo conservar el pan de masa madre", slug: "como-conservar-el-pan-de-masa-madre" });
    expect(ev.body.data.html).toContain("paño de algodón");
    expect(ev.body.data.jsonld["@type"]).toBe("Article");
    expect(JSON.stringify(ev.body)).not.toContain("owner@");

    // A failure is reported and stored; the retry carries the same delivery id (receivers can deduplicate).
    hook.status = 500;
    const f = await owner.post(`${O}/content/${id}/external/webhook`, { status: "draft" });
    expect(f.status).toBe(502);
    expect(f.json.title).toContain("no confirmó la entrega");
    hook.status = 200;
    await owner.post(`${O}/content/${id}/external/webhook`, { status: "draft" });
    const [a, b] = hook.events.slice(-2);
    expect(a!.delivery).toBe(b!.delivery);

    const un = await owner.post(`${O}/content/${id}/external/webhook/unpublish`);
    expect(un.json.publication.state).toBe("unpublished");
    expect(hook.events.at(-1)).toMatchObject({ event: "content.unpublish", validSig: true });

    expect((await owner.del(`${O}/cms/webhook`)).status).toBe(200);
    expect((await owner.get(`${O}/cms/external`)).json.webhook).toBeNull();
    const left = await h.db.prepare("SELECT COUNT(*) AS n FROM integration_secrets WHERE organization_id = ?").bind(orgId).first<{ n: number }>();
    expect(left!.n).toBe(0);
  });
});
