import { describe, expect, it } from "vitest";
import { decryptJson, normalizeWpSite, wpMarker, wpSlug } from "@dni/core";
import { wpRoute } from "../src/lib/wordpress";
import { createHarness } from "./helpers";

const KEY = "0123456789abcdef".repeat(4);
const APP_PASS = ["abcd", "EFGH", "ijkl", "MNOP", "qrst", "UV12"].join(" ");
const SITE = "https://blog.panaderia-luna.es";

interface WpState {
  pretty: boolean;
  capabilities: Record<string, boolean>;
  failCreate?: "network_after_write" | "auth" | "rest_cannot_create";
  posts: Map<number, { id: number; slug: string; status: string; title: string; content: string; excerpt: string }>;
  nextId: number;
  revoked: boolean;
}

/** In-memory WordPress REST API (wp/v2 posts, users/me, application-passwords introspect). */
function setup(opts: Partial<WpState> = {}) {
  const h = createHarness({ dns: { "intranet.example.com": ["10.0.0.5"] } });
  Object.assign(h.env, { DATA_ENC_KEY: KEY });
  const wp: WpState = { pretty: true, capabilities: { publish_posts: true, edit_posts: true }, posts: new Map(), nextId: 100, revoked: false, ...opts };
  const calls: Array<{ method: string; url: string; auth: string | null; body: string }> = [];
  const realFetch = h.deps.fetchImpl;
  h.deps.fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (!url.startsWith(SITE)) return realFetch(input, init);
    const method = init?.method ?? "GET";
    const auth = new Headers(init?.headers).get("authorization");
    const body = String(init?.body ?? "");
    calls.push({ method, url, auth, body });
    const u = new URL(url);
    let route: string | null = null;
    if (wp.pretty && u.pathname.startsWith("/wp-json/")) route = u.pathname.slice("/wp-json".length);
    else if (u.searchParams.get("rest_route")) route = u.searchParams.get("rest_route");
    if (route === null) return new Response("<html>not found</html>", { status: 404, headers: { "content-type": "text/html" } });
    const authed = auth === `Basic ${btoa(`editora:${APP_PASS.replace(/ /g, "")}`)}` && !wp.revoked;
    if (route === "/" || route === "") return Response.json({ name: "Panadería Luna", namespaces: ["oembed/1.0", "wp/v2"] });
    if (!authed) return Response.json({ code: "incorrect_password", message: "The provided password is an invalid application password." }, { status: 401 });
    if (route === "/wp/v2/users/me") return Response.json({ id: 7, name: "Editora", capabilities: wp.capabilities });
    if (route === "/wp/v2/users/me/application-passwords/introspect") return Response.json({ uuid: "6a1f6b50-0000-4000-8000-000000000001", name: "DNI Growth" });
    if (route.startsWith("/wp/v2/users/me/application-passwords/") && method === "DELETE") {
      wp.revoked = true;
      return Response.json({ deleted: true });
    }
    if (route === "/wp/v2/posts" && method === "GET") {
      const slug = u.searchParams.get("slug");
      return Response.json([...wp.posts.values()].filter((p) => p.slug === slug).map((p) => ({ id: p.id, status: p.status, link: `${SITE}/${p.slug}/`, content: { raw: p.content } })));
    }
    const save = (id: number | null) => {
      const j = JSON.parse(body) as Record<string, string>;
      const prev = id ? wp.posts.get(id) : undefined;
      if (id && !prev) return Response.json({ code: "rest_post_invalid_id", message: "Invalid post ID." }, { status: 404 });
      const p = { id: id ?? wp.nextId++, slug: j.slug ?? prev!.slug, status: j.status ?? prev!.status, title: j.title ?? prev!.title, content: j.content ?? prev!.content, excerpt: j.excerpt ?? prev!.excerpt };
      wp.posts.set(p.id, p);
      return Response.json({ id: p.id, status: p.status, link: p.status === "publish" ? `${SITE}/${p.slug}/` : `${SITE}/?p=${p.id}` }, { status: id ? 200 : 201 });
    };
    if (route === "/wp/v2/posts" && method === "POST") {
      if (wp.failCreate === "rest_cannot_create") return Response.json({ code: "rest_cannot_create", message: "Sorry, you are not allowed to create posts as this user." }, { status: 403 });
      if (wp.failCreate === "auth") return Response.json({ code: "incorrect_password", message: "bad" }, { status: 401 });
      const r = save(null);
      if (wp.failCreate === "network_after_write") {
        wp.failCreate = undefined;
        throw new Error("ECONNRESET");
      }
      return r;
    }
    const m = route.match(/^\/wp\/v2\/posts\/(\d+)$/);
    if (m && method === "POST") return save(Number(m[1]));
    return Response.json({ code: "rest_no_route", message: "No route was found matching the URL and request method." }, { status: 404 });
  }) as typeof fetch;

  async function ownerOrg(plan = "starter", email = "owner@panaderia-luna.es") {
    const owner = await h.signup(email);
    const orgId = await h.createOrg(owner, "Panadería Luna", plan);
    return { owner, orgId, O: `/api/v1/orgs/${orgId}` };
  }
  async function approvedArticle(owner: Awaited<ReturnType<typeof ownerOrg>>["owner"], O: string, title = "Cómo conservar el pan de masa madre") {
    const created = await owner.post(`${O}/content/manual`, { kind: "blog_article", title });
    const id = created.json.id as string;
    const row = (await owner.get(`${O}/content/${id}`)).json;
    await owner.patch(`${O}/content/${id}`, { title, bodyMd: `# ${title}\n\nGuárdalo envuelto en un paño de algodón y lejos del frigorífico.\n\n## En resumen\n\nUn paño y una panera bastan.`, expectedVersion: row.version });
    expect((await owner.post(`${O}/content/${id}/submit`)).status).toBe(200);
    const ap = await owner.post(`${O}/content/${id}/approve`, { acknowledgeChecks: true });
    expect(ap.status, JSON.stringify(ap.json)).toBe(200);
    return id;
  }
  const connect = (owner: Awaited<ReturnType<typeof ownerOrg>>["owner"], O: string, extra: Record<string, string> = {}) =>
    owner.post(`${O}/cms/wordpress`, { siteUrl: `${SITE}/wp-admin/`, username: "editora", appPassword: APP_PASS, ...extra });
  return { h, wp, calls, ownerOrg, approvedArticle, connect };
}

describe("WordPress: connection", () => {
  it("connects with an Application Password, stores it encrypted and never returns it", async () => {
    const { h, calls, ownerOrg, connect } = setup();
    const { owner, orgId, O } = await ownerOrg();
    const r = await connect(owner, O);
    expect(r.status, JSON.stringify(r.json)).toBe(201);
    expect(r.json.wordpress).toMatchObject({ status: "connected", site: SITE });
    expect(JSON.stringify(r.json)).not.toContain("abcd");
    // Discovery (no credentials) happens before any authenticated call.
    expect(calls[0]).toMatchObject({ method: "GET", auth: null, url: `${SITE}/wp-json/` });
    const sec = await h.db.prepare("SELECT s.ciphertext, i.id FROM integration_secrets s JOIN integrations i ON i.id = s.integration_id WHERE s.organization_id = ? AND i.provider = 'wordpress'").bind(orgId).first<{ ciphertext: string; id: string }>();
    expect(sec!.ciphertext).not.toContain("abcd");
    const opened = await decryptJson<{ user: string; pass: string; api: string }>(KEY, sec!.ciphertext, `wordpress:${orgId}:${sec!.id}`);
    expect(opened).toMatchObject({ user: "editora", api: `${SITE}/wp-json/` });
    // Bound to its organisation: the same ciphertext does not open under another org.
    await expect(decryptJson(KEY, sec!.ciphertext, `wordpress:other-org:${sec!.id}`)).rejects.toThrow();
    const audit = await h.db.prepare("SELECT after_redacted FROM audit_logs WHERE organization_id = ? AND action = 'cms.wordpress_connect'").bind(orgId).first<{ after_redacted: string }>();
    expect(audit!.after_redacted).not.toContain("abcd");
  });

  it("works without pretty permalinks (?rest_route=) and refuses wrong passwords and users who cannot publish", async () => {
    const plain = setup({ pretty: false });
    const a = await plain.ownerOrg();
    const ok = await plain.connect(a.owner, a.O);
    expect(ok.status, JSON.stringify(ok.json)).toBe(201);

    const s = setup({ capabilities: { publish_posts: false, edit_posts: true } });
    const b = await s.ownerOrg("starter", "b@panaderia-luna.es");
    const weak = await s.connect(b.owner, b.O);
    expect(weak.status).toBe(403);
    expect(weak.json.code).toBe("wordpress_cannot_publish");
    const bad = await s.connect(b.owner, b.O, { appPassword: "zzzz zzzz zzzz zzzz zzzz zzzz" });
    expect(bad.status).toBe(422);
    expect(bad.json.title).toMatch(/contraseña de aplicación/);
  });

  it("blocks private hosts, plain http and malformed passwords before sending anything", async () => {
    const { h, calls, ownerOrg } = setup();
    const { owner, O } = await ownerOrg();
    const priv = await owner.post(`${O}/cms/wordpress`, { siteUrl: "https://intranet.example.com", username: "a", appPassword: APP_PASS });
    expect(priv.status).toBe(422);
    expect(priv.json.title).toMatch(/no es una web pública/);
    const local = await owner.post(`${O}/cms/wordpress`, { siteUrl: "https://localhost", username: "a", appPassword: APP_PASS });
    expect(local.status).toBe(422);
    expect((await owner.post(`${O}/cms/wordpress`, { siteUrl: "http://blog.panaderia-luna.es", username: "a", appPassword: APP_PASS })).status).toBe(422);
    expect((await owner.post(`${O}/cms/wordpress`, { siteUrl: SITE, username: "a", appPassword: "mi-contraseña-normal" })).status).toBe(422);
    expect(calls.length).toBe(0);
    expect(h.fetchLog.some((u) => u.includes("intranet") || u.includes("localhost"))).toBe(false);
  });

  it("is a Starter feature and only Owner/Admin connect it", async () => {
    const { h, ownerOrg, connect } = setup();
    const free = await ownerOrg("free", "free@panaderia-luna.es");
    const r = await connect(free.owner, free.O);
    expect(r.status).toBe(402);
    expect(r.json).toMatchObject({ code: "plan_required", requiredPlan: "starter" });
    const g = await ownerOrg("growth", "g@panaderia-luna.es");
    const editor = await h.invite(g.owner, g.orgId, "editor@panaderia-luna.es", "editor");
    expect((await connect(editor, g.O)).status).toBe(403);
  });

  it("disconnecting revokes the Application Password in WordPress and deletes our copy", async () => {
    const { h, wp, ownerOrg, connect } = setup();
    const { owner, orgId, O } = await ownerOrg();
    await connect(owner, O);
    const d = await owner.del(`${O}/cms/wordpress`);
    expect(d.json).toMatchObject({ ok: true, revokedInWordPress: true });
    expect(wp.revoked).toBe(true);
    expect(await h.db.prepare("SELECT COUNT(*) AS n FROM integration_secrets WHERE organization_id = ?").bind(orgId).first()).toMatchObject({ n: 0 });
    expect((await owner.get(`${O}/cms`)).json.wordpress.status).toBe("disconnected");
  });
});

describe("WordPress: publishing", () => {
  it("publishes only approved content, once, then updates the same post and can withdraw it to draft", async () => {
    const { h, wp, calls, ownerOrg, approvedArticle, connect } = setup();
    const { owner, orgId, O } = await ownerOrg();
    await connect(owner, O);
    const draft = await owner.post(`${O}/content/manual`, { kind: "blog_article", title: "Borrador sin aprobar" });
    expect((await owner.post(`${O}/content/${draft.json.id}/wordpress`, { status: "publish" })).json.code).toBe("not_approved");

    const id = await approvedArticle(owner, O);
    const first = await owner.post(`${O}/content/${id}/wordpress`, { status: "publish" });
    expect(first.status, JSON.stringify(first.json)).toBe(200);
    expect(first.json.publication).toMatchObject({ state: "published", url: `${SITE}/como-conservar-el-pan-de-masa-madre/`, postId: "100" });
    const post = wp.posts.get(100)!;
    expect(post.slug).toBe("como-conservar-el-pan-de-masa-madre");
    expect(post.content).toContain(wpMarker(id));
    expect(post.content).not.toContain("<h1>"); // the title is the WordPress title, not repeated in the body
    expect(post.content).toContain("<h2>");
    expect(post.excerpt).toMatch(/paño de algodón/);

    // Second send updates the same post (no duplicate).
    const again = await owner.post(`${O}/content/${id}/wordpress`, { status: "publish" });
    expect(again.status).toBe(200);
    expect(wp.posts.size).toBe(1);
    expect(calls.filter((c) => c.method === "POST" && /\/wp\/v2\/posts$/.test(new URL(c.url).pathname)).length).toBe(1);

    const off = await owner.post(`${O}/content/${id}/wordpress/unpublish`);
    expect(off.json.publication.state).toBe("unpublished");
    expect(wp.posts.get(100)!.status).toBe("draft");
    const actions = (await h.db.prepare("SELECT action FROM audit_logs WHERE organization_id = ? AND action LIKE 'cms.%' ORDER BY created_at, rowid").bind(orgId).all<{ action: string }>()).results.map((r) => r.action);
    expect(actions).toEqual(["cms.wordpress_connect", "cms.wordpress_publish", "cms.wordpress_publish", "cms.wordpress_unpublish"]);
  });

  it("a retry after an unknown outcome finds the post it already created instead of duplicating it", async () => {
    const { wp, ownerOrg, approvedArticle, connect } = setup({ failCreate: "network_after_write" });
    const { owner, O } = await ownerOrg();
    await connect(owner, O);
    const id = await approvedArticle(owner, O);
    const first = await owner.post(`${O}/content/${id}/wordpress`, { status: "draft" });
    expect(first.status).toBe(502);
    expect(first.json.title).toMatch(/no se duplicará/);
    expect(wp.posts.size).toBe(1); // it did reach WordPress
    const retry = await owner.post(`${O}/content/${id}/wordpress`, { status: "draft" });
    expect(retry.status, JSON.stringify(retry.json)).toBe(200);
    expect(retry.json.publication).toMatchObject({ state: "draft", postId: "100" });
    expect(wp.posts.size).toBe(1);
  });

  it("only approvers publish; a revoked password marks the connection for reconnection", async () => {
    const { h, wp, ownerOrg, approvedArticle, connect } = setup();
    const { owner, orgId, O } = await ownerOrg("growth");
    await connect(owner, O);
    const id = await approvedArticle(owner, O);
    const editor = await h.invite(owner, orgId, "editor@panaderia-luna.es", "editor");
    expect((await editor.post(`${O}/content/${id}/wordpress`, { status: "publish" })).status).toBe(403);
    wp.revoked = true;
    const r = await owner.post(`${O}/content/${id}/wordpress`, { status: "publish" });
    expect(r.status).toBe(502);
    expect((await owner.get(`${O}/cms`)).json.wordpress.status).toBe("reauth_required");
    expect((await owner.post(`${O}/content/${id}/wordpress`, { status: "publish" })).json.code).toBe("wordpress_reauth");
  });

  it("concurrent sends of the same item create one post", async () => {
    const { wp, ownerOrg, approvedArticle, connect } = setup();
    const { owner, O } = await ownerOrg();
    await connect(owner, O);
    const id = await approvedArticle(owner, O);
    const results = await Promise.all([owner.post(`${O}/content/${id}/wordpress`, { status: "publish" }), owner.post(`${O}/content/${id}/wordpress`, { status: "publish" })]);
    for (const r of results) expect([200, 409]).toContain(r.status);
    expect(results.some((r) => r.status === 200)).toBe(true);
    expect(wp.posts.size).toBe(1);
  });

  it("is tenant-isolated: another organisation cannot see or publish an item", async () => {
    const { ownerOrg, approvedArticle, connect } = setup();
    const a = await ownerOrg("starter", "a@panaderia-luna.es");
    const b = await ownerOrg("starter", "b@otra.es");
    await connect(a.owner, a.O);
    const id = await approvedArticle(a.owner, a.O);
    expect([403, 404]).toContain((await b.owner.get(`${a.O}/content/${id}/wordpress`)).status);
    expect((await b.owner.post(`${b.O}/content/${id}/wordpress`, { status: "publish" })).status).toBe(404);
  });
});

describe("WordPress helpers", () => {
  it("normalises addresses and builds routes for both permalink styles", () => {
    expect(normalizeWpSite("tuweb.com")).toBe("https://tuweb.com");
    expect(normalizeWpSite("https://TuWeb.com/blog/wp-admin/post.php?x=1")).toBe("https://tuweb.com/blog");
    expect(normalizeWpSite("http://tuweb.com")).toBeNull();
    expect(normalizeWpSite("https://user:pw@tuweb.com")).toBeNull();
    expect(normalizeWpSite("https://tuweb.com:8443")).toBeNull();
    expect(wpRoute("https://a.es/wp-json/", "wp/v2/posts", { slug: "x" })).toBe("https://a.es/wp-json/wp/v2/posts?slug=x");
    expect(wpRoute("https://a.es/?rest_route=/", "wp/v2/posts/5")).toBe("https://a.es/?rest_route=/wp/v2/posts/5");
    expect(wpSlug("¿Qué es el SEO técnico? Guía 2027")).toBe("que-es-el-seo-tecnico-guia-2027");
  });
});
