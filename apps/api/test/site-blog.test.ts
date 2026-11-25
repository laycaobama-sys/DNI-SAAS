import { describe, expect, it } from "vitest";
import { blogDescription, blogSlug } from "../src/routes/site-blog";
import { createHarness } from "./helpers";

/** Public blog at /blog fed by Content Studio (ADR 0020): only approved articles of the site's own org. */
async function setup() {
  const h = createHarness();
  const owner = await h.signup("owner@dnigrowth.test", "Titular");
  const orgId = await h.createOrg(owner, "DNI Growth", "agency");
  h.env.SITE_BLOG_ORG_ID = orgId;
  const O = `/api/v1/orgs/${orgId}`;
  const anon = new h.Client();
  return { h, owner, orgId, O, anon };
}

async function approvedArticle(owner: Awaited<ReturnType<typeof setup>>["owner"], O: string, title: string, body: string) {
  const m = await owner.post(`${O}/content/manual`, { kind: "blog_article", title });
  expect(m.status).toBe(201);
  const C = `${O}/content/${m.json.id}`;
  expect((await owner.patch(C, { bodyMd: body, expectedVersion: 1 })).status).toBe(200);
  expect((await owner.post(`${C}/submit`)).status).toBe(200);
  expect((await owner.post(`${C}/approve`, { note: "Revisado" })).status).toBe(200);
  return { id: m.json.id as string, C };
}

const BODY = [
  "# Cómo preparar la imagen social de tu web",
  "",
  "La imagen que ven redes y mensajería sale de la etiqueta og:image. Debe ser PNG o JPG de 1200×630.",
  "",
  "## Pasos",
  "- Exporta la imagen en PNG.",
  "- Declárala en la cabecera.",
  "",
  "<script>alert('x')</script> [trampa](javascript:alert(1))",
].join("\n");

describe("public blog and dynamic sitemap", () => {
  it("serves an empty but working blog and a sitemap that lists it", async () => {
    const { anon } = await setup();
    const blog = await anon.get("/blog");
    expect(blog.status).toBe(200);
    expect(blog.headers.get("content-type")).toContain("text/html");
    expect(blog.json).toContain("Todavía no hemos publicado artículos");
    expect(blog.json).toContain('"@type":"Blog"');
    expect(blog.headers.get("content-security-policy")).toContain("script-src 'self'");
    const map = await anon.get("/sitemap.xml");
    expect(map.status).toBe(200);
    expect(map.headers.get("content-type")).toContain("application/xml");
    // Even empty, the blog page carries real content (what we will publish and how), never a thin page.
    expect(blog.json).toContain("Qué vas a encontrar aquí");
    expect(blog.json).not.toContain('content="noindex"');
    for (const p of ["/", "/blog", "/legal/privacidad", "/legal/aviso-legal", "/legal/condiciones", "/legal/eliminacion-datos"]) expect(map.json).toContain(`<loc>http://localhost:8787${p}</loc>`);
    expect((await anon.get("/blog/no-existe")).status).toBe(404);
    expect((await anon.get("/blog/feed.xml")).json).toContain("<rss version=\"2.0\">");
  });

  it("publishes only approved articles, as a sanitised snapshot, and unpublishes them", async () => {
    const { h, owner, O, anon } = await setup();
    // A draft cannot be published.
    const draft = await owner.post(`${O}/content/manual`, { kind: "blog_article", title: "Borrador sin aprobar" });
    expect((await owner.post(`${O}/content/${draft.json.id}/site-blog`)).status).toBe(409);
    // Only blog articles go to the blog.
    const faq = await owner.post(`${O}/content/manual`, { kind: "faq_aeo", title: "Preguntas frecuentes" });
    expect((await owner.post(`${O}/content/${faq.json.id}/site-blog`)).json.code).toBe("site_blog_kind");

    const { id, C } = await approvedArticle(owner, O, "Cómo preparar la imagen social de tu web", BODY);
    const pub = await owner.post(`${C}/site-blog`);
    expect(pub.status).toBe(201);
    expect(pub.json.post).toMatchObject({ slug: "como-preparar-la-imagen-social-de-tu-web", status: "published", contentVersion: 2 });
    // Idempotent: publishing again updates the same post.
    expect((await owner.post(`${C}/site-blog`)).status).toBe(200);
    expect((await h.db.prepare("SELECT COUNT(*) AS n FROM site_blog_posts").first<{ n: number }>())!.n).toBe(1);

    const page = await anon.get("/blog/como-preparar-la-imagen-social-de-tu-web");
    expect(page.status).toBe(200);
    expect(page.json).toContain("<h1>Cómo preparar la imagen social de tu web</h1>");
    expect(page.json.match(/<h1>/g)).toHaveLength(1);
    expect(page.json).toContain('"@type":"BlogPosting"');
    expect(page.json).toContain("Revisado y aprobado por una persona");
    expect(page.json).not.toMatch(/<script>alert/);
    expect(page.json).not.toContain('href="javascript:');
    expect((await anon.get("/blog")).json).toContain('href="/blog/como-preparar-la-imagen-social-de-tu-web"');
    const map = (await anon.get("/sitemap.xml")).json as string;
    expect(map).toContain("<loc>http://localhost:8787/blog/como-preparar-la-imagen-social-de-tu-web</loc><lastmod>");
    expect((await anon.get("/blog/feed.xml")).json).toContain("<title>Cómo preparar la imagen social de tu web</title>");

    // Editing after publication does not change the public page until it is republished.
    await owner.patch(C, { bodyMd: `${BODY}\n\nPárrafo nuevo sin revisar.` });
    expect((await anon.get("/blog/como-preparar-la-imagen-social-de-tu-web")).json).not.toContain("Párrafo nuevo sin revisar");
    expect((await owner.post(`${C}/site-blog`)).status).toBe(409);

    const off = await owner.del(`${C}/site-blog`);
    expect(off.json.post.status).toBe("unpublished");
    expect((await anon.get("/blog/como-preparar-la-imagen-social-de-tu-web")).status).toBe(404);
    expect((await anon.get("/sitemap.xml")).json).not.toContain("/blog/como-preparar");
    const actions = (await h.db.prepare("SELECT action FROM audit_logs WHERE entity_id = ? ORDER BY created_at").bind(id).all<{ action: string }>()).results.map((r) => r.action);
    expect(actions).toEqual(expect.arrayContaining(["site_blog.publish", "site_blog.unpublish"]));
  });

  it("is limited to the site organisation and to approvers", async () => {
    const { h, owner, orgId, O } = await setup();
    const { C } = await approvedArticle(owner, O, "Guía de datos estructurados", "# Guía\n\nTexto revisado con fuentes propias.");
    const editor = await h.invite(owner, orgId, "editor@dnigrowth.test", "editor");
    expect((await editor.post(`${C}/site-blog`)).status).toBe(403);
    // Any other organisation (even Agency) cannot publish on the site blog.
    const other = await h.signup("otra@agencia.test", "Otra");
    const otherOrg = await h.createOrg(other, "Agencia", "agency");
    const r = await other.post(`/api/v1/orgs/${otherOrg}/content/manual`, { kind: "blog_article", title: "Intento ajeno" });
    expect((await other.post(`/api/v1/orgs/${otherOrg}/content/${r.json.id}/site-blog`)).json.code).toBe("site_blog_unavailable");
    expect((await other.get(`/api/v1/orgs/${otherOrg}/content/${r.json.id}/site-blog`)).json).toEqual({ available: false, post: null });
    // Nor touch our content through its own org id.
    expect((await other.post(`${C}/site-blog`)).status).toBe(404);
  });

  it("builds stable slugs and plain descriptions", () => {
    expect(blogSlug("¿Qué es GEO? Guía práctica 2026")).toBe("que-es-geo-guia-practica-2026");
    expect(blogSlug("ab")).toMatch(/^articulo-/);
    expect(blogSlug("palabra ".repeat(30)).length).toBeLessThanOrEqual(80);
    expect(blogDescription("## Título\n\nTexto con **negrita** y [un enlace](https://x.es).\n\nOtro.")).toBe("Texto con negrita y un enlace.");
  });
});
