import { Hono, type Context } from "hono";
import { z } from "zod";
import { checkDraft, markdownToSafeHtml } from "@dni/core";
import type { AppEnv } from "../env";
import { auditStmt } from "../lib/audit";
import { ApiError, assertUuid, notFound, parseBody } from "../lib/http";
import { SITE_SECURITY_HEADERS } from "../lib/site-headers";
import { nowIso, uuid } from "../lib/util";
import { requireScope } from "../middleware";

/**
 * Public blog at APP_ORIGIN/blog (ADR 0020), fed by Content Studio: only APPROVED articles of the site's own
 * organisation (vars.SITE_BLOG_ORG_ID), published by a person with content:approve. The public page is a
 * snapshot of the approved version, rendered with the same safe Markdown renderer as the exports.
 */

/** Public pages listed in the sitemap besides the blog posts. */
export const SITE_PAGES = ["/", "/precios", "/blog", "/seguridad", "/legal/garantia", "/legal/privacidad", "/legal/aviso-legal", "/legal/condiciones", "/legal/eliminacion-datos", "/subencargados", "/legal/encargo-tratamiento", "/estado", "/herramientas", "/herramientas/robots-txt-bots-ia", "/herramientas/generador-llms-txt", "/herramientas/generador-schema", "/herramientas/generador-faq-aeo", "/herramientas/vista-previa-google", "/herramientas/comprobador-sitemap", "/herramientas/etiquetas-open-graph", "/herramientas/calculadora-valor-trafico", "/herramientas/preparada-para-ia", "/herramientas/palabras-clave-competidor", "/herramientas/comprobador-enlaces-rotos", "/herramientas/comprobador-imagen-compartir"];

interface PostRow {
  id: string;
  organization_id: string;
  content_item_id: string;
  content_version: number;
  slug: string;
  title: string;
  description: string;
  body_md: string;
  status: "published" | "unpublished";
  published_at: string;
  updated_at: string;
}

const ENT: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const esc = (s: string) => s.replace(/[&<>"']/g, (ch) => ENT[ch]!);
const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{1,78}[a-z0-9])$/;
const day = (iso: string) => new Date(iso).toLocaleDateString("es-ES", { day: "numeric", month: "long", year: "numeric", timeZone: "Europe/Madrid" });

/** URL slug from a title: ASCII, lowercase, hyphenated, 3–80 characters, cut on a word boundary. */
export function blogSlug(title: string): string {
  const base = title
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const cut = base.length > 80 ? base.slice(0, 80).replace(/-[^-]*$/, "") : base;
  return cut.length >= 3 ? cut : `articulo-${cut || "nuevo"}`.slice(0, 80);
}

/** Plain-text summary for meta description and the list: first paragraph that is not a heading or list. */
export function blogDescription(md: string): string {
  const para =
    md
      .replace(/```[\s\S]*?```/g, "")
      .split(/\n{2,}/)
      .map((b) => b.trim())
      .find((b) => b && !/^(#|[-*>|]|\d+[.)])/.test(b)) ?? "";
  const text = para
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[*_`]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > 160 ? `${text.slice(0, 157).replace(/\s\S*$/, "")}…` : text;
}

/** The article body without its own leading H1 (the page already shows the title as H1). */
const bodyWithoutTitle = (md: string) => md.replace(/^\s*#\s+[^\n]*\n+/, "");

/** Same security headers as the static pages (lib/site-headers.ts ↔ apps/web/public/_headers). */
export const PAGE_HEADERS = { "content-type": "text/html; charset=utf-8", ...SITE_SECURITY_HEADERS };

/** Minimal shell for tests and local runs without the built assets. */
const FALLBACK_SHELL = `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Blog · DNI Growth</title><meta name="description" content=""><link rel="canonical" href=""><meta property="og:type" content="website"><meta property="og:title" content=""><meta property="og:description" content=""><meta property="og:url" content=""></head><body><main id="main" class="legal blog" data-blog-main></main></body></html>`;

/** The built blog.html (header, footer, hashed CSS) is the template; the Worker fills title, meta and main. */
export async function shell(c: Context<AppEnv>): Promise<string> {
  if (!c.env.ASSETS) return FALLBACK_SHELL;
  try {
    const res = await c.env.ASSETS.fetch(new Request(new URL("/blog", c.req.url)));
    const html = res.ok ? await res.text() : "";
    return html.includes("data-blog-main") ? html : FALLBACK_SHELL;
  } catch {
    return FALLBACK_SHELL;
  }
}

export function fill(tpl: string, p: { title: string; description: string; canonical: string; main: string; ogType: "website" | "article"; jsonLd: unknown; noindex?: boolean }): string {
  const ld = JSON.stringify(p.jsonLd).replace(/</g, "\\u003c");
  return tpl
    .replace(/<title>[^<]*<\/title>/, `<title>${esc(p.title)}</title>`)
    .replace(/<meta name="description" content="[^"]*"/, `<meta name="description" content="${esc(p.description)}"`)
    .replace(/<link rel="canonical" href="[^"]*"/, `<link rel="canonical" href="${esc(p.canonical)}"`)
    .replace(/<meta property="og:type" content="[^"]*"/, `<meta property="og:type" content="${p.ogType}"`)
    .replace(/<meta property="og:title" content="[^"]*"/, `<meta property="og:title" content="${esc(p.title)}"`)
    .replace(/<meta property="og:description" content="[^"]*"/, `<meta property="og:description" content="${esc(p.description)}"`)
    .replace(/<meta property="og:url" content="[^"]*"/, `<meta property="og:url" content="${esc(p.canonical)}"`)
    .replace("</head>", `${p.noindex ? '<meta name="robots" content="noindex">' : ""}<script type="application/ld+json">${ld}</script></head>`)
    .replace(/(<main[^>]*data-blog-main[^>]*>)[\s\S]*?(<\/main>)/, `$1${p.main}$2`);
}

const publishedPosts = (db: D1Database, limit = 100) =>
  db
    .prepare("SELECT slug, title, description, published_at, updated_at FROM site_blog_posts WHERE status = 'published' ORDER BY published_at DESC LIMIT ?")
    .bind(limit)
    .all<Pick<PostRow, "slug" | "title" | "description" | "published_at" | "updated_at">>();

/** Public routes: /blog, /blog/feed.xml, /blog/:slug and the dynamic /sitemap.xml. */
export function registerPublicBlog(app: Hono<AppEnv>) {
  app.get("/blog", async (c) => {
    const origin = c.env.APP_ORIGIN.replace(/\/$/, "");
    const { results } = await publishedPosts(c.env.DB);
    const intro =
      "<h1>Blog</h1><p class=\"blog-lead\">Guías prácticas de SEO técnico, GEO y AEO para pymes y agencias. Cada artículo nace en nuestro propio Content Studio y lo revisa y aprueba una persona antes de publicarse, con sus fuentes.</p>";
    const list = results.length
      ? `<ul class="blog-list">${results
          .map(
            (p) =>
              `<li><article><h2><a href="/blog/${esc(p.slug)}">${esc(p.title)}</a></h2>${p.description ? `<p>${esc(p.description)}</p>` : ""}<p class="blog-meta"><time datetime="${esc(p.published_at)}">${esc(day(p.published_at))}</time></p></article></li>`,
          )
          .join("")}</ul>`
      : `<div class="blog-empty" role="status"><p><strong>Todavía no hemos publicado artículos.</strong> Preferimos tardar a publicar textos en serie: cada guía la redacta Content Studio, la revisa una persona y lleva sus fuentes.</p></div>
<h2>Qué vas a encontrar aquí</h2>
<ul>
<li><strong>Cómo aparecer en ChatGPT y otros asistentes:</strong> qué mira cada asistente, qué es el archivo llms.txt y cómo comprobar si te citan, sin prometer resultados.</li>
<li><strong>SEO técnico paso a paso:</strong> títulos, descripciones, enlaces canónicos, datos estructurados y velocidad, con ejemplos reales de auditorías.</li>
<li><strong>Search Console para principiantes:</strong> qué significan clics, impresiones, CTR y posición media, y qué decisiones tomar con ellos.</li>
<li><strong>SEO local en España y para tiendas online:</strong> fichas, reseñas, páginas de categoría y producto.</li>
<li><strong>GEO frente a SEO:</strong> en qué se parecen, en qué no y por qué ninguna herramienta puede garantizar posiciones.</li>
</ul>
<h2>Cómo escribimos</h2>
<p>Cada artículo explica de dónde sale cada dato, separa lo observado de lo estimado y se revisa cuando cambian las reglas de Google o de los asistentes. No compramos enlaces ni publicamos contenido generado sin revisión.</p>
<p>Mientras llegan los primeros artículos, puedes <a href="/#auditar">auditar tu web gratis en unos segundos</a>, ver <a href="/precios">los planes y lo que incluye cada uno</a> o leer <a href="/seguridad">cómo protegemos tus datos</a>.</p>`;
    const html = fill(await shell(c), {
      title: "Blog · DNI Growth",
      description: "Guías de SEO técnico, GEO y AEO revisadas por una persona y con fuentes. Sin promesas de posiciones.",
      canonical: `${origin}/blog`,
      ogType: "website",
      main: `${intro}${list}<p class="blog-feed"><a href="/blog/feed.xml">Suscribirse por RSS</a></p>`,
      jsonLd: {
        "@context": "https://schema.org",
        "@type": "Blog",
        "@id": `${origin}/blog#blog`,
        name: "Blog de DNI Growth",
        url: `${origin}/blog`,
        inLanguage: "es-ES",
        publisher: { "@id": `${origin}/#org` },
        blogPost: results.map((p) => ({ "@type": "BlogPosting", headline: p.title, url: `${origin}/blog/${p.slug}`, datePublished: p.published_at, dateModified: p.updated_at })),
      },
    });
    return c.body(html, 200, { ...PAGE_HEADERS, "cache-control": "public, max-age=300" });
  });

  app.get("/blog/feed.xml", async (c) => {
    const origin = c.env.APP_ORIGIN.replace(/\/$/, "");
    const { results } = await publishedPosts(c.env.DB, 50);
    const items = results
      .map(
        (p) =>
          `<item><title>${esc(p.title)}</title><link>${origin}/blog/${esc(p.slug)}</link><guid isPermaLink="true">${origin}/blog/${esc(p.slug)}</guid><pubDate>${new Date(p.published_at).toUTCString()}</pubDate><description>${esc(p.description)}</description></item>`,
      )
      .join("");
    const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<rss version="2.0"><channel><title>Blog de DNI Growth</title><link>${origin}/blog</link><description>Guías de SEO técnico, GEO y AEO revisadas por una persona.</description><language>es-es</language>${items}</channel></rss>\n`;
    return c.body(xml, 200, { "content-type": "application/rss+xml; charset=utf-8", "cache-control": "public, max-age=300", "x-content-type-options": "nosniff" });
  });

  app.get("/blog/:slug", async (c) => {
    const origin = c.env.APP_ORIGIN.replace(/\/$/, "");
    const slug = c.req.param("slug");
    const post = SLUG_RE.test(slug) ? await c.env.DB.prepare("SELECT * FROM site_blog_posts WHERE slug = ? AND status = 'published'").bind(slug).first<PostRow>() : null;
    const tpl = await shell(c);
    if (!post) {
      const html = fill(tpl, {
        title: "Artículo no encontrado · DNI Growth",
        description: "Este artículo no existe o ya no está publicado.",
        canonical: `${origin}/blog`,
        ogType: "website",
        noindex: true,
        main: '<h1>Artículo no encontrado</h1><p>Este artículo no existe o ya no está publicado.</p><p><a href="/blog">Volver al blog</a></p>',
        jsonLd: { "@context": "https://schema.org", "@type": "WebPage", name: "Artículo no encontrado" },
      });
      return c.body(html, 404, { ...PAGE_HEADERS, "cache-control": "no-store" });
    }
    const url = `${origin}/blog/${post.slug}`;
    const main = `<article class="post"><p class="blog-meta"><a href="/blog">← Blog</a> · <time datetime="${esc(post.published_at)}">${esc(day(post.published_at))}</time>${post.updated_at.slice(0, 10) !== post.published_at.slice(0, 10) ? ` · actualizado el <time datetime="${esc(post.updated_at)}">${esc(day(post.updated_at))}</time>` : ""}</p><h1>${esc(post.title)}</h1>${markdownToSafeHtml(bodyWithoutTitle(post.body_md))}<p class="blog-review">Revisado y aprobado por una persona del equipo de DNI Growth antes de publicarse. Ningún contenido garantiza posiciones en buscadores ni menciones en motores de IA.</p></article>`;
    const html = fill(tpl, {
      title: `${post.title} · Blog de DNI Growth`,
      description: post.description || "Artículo del blog de DNI Growth.",
      canonical: url,
      ogType: "article",
      main,
      jsonLd: {
        "@context": "https://schema.org",
        "@type": "BlogPosting",
        headline: post.title,
        description: post.description,
        url,
        mainEntityOfPage: url,
        datePublished: post.published_at,
        dateModified: post.updated_at,
        inLanguage: "es-ES",
        image: `${origin}/og-dni-growth.png`,
        author: { "@id": `${origin}/#org` },
        publisher: { "@id": `${origin}/#org` },
        isPartOf: { "@id": `${origin}/blog#blog` },
      },
    });
    return c.body(html, 200, { ...PAGE_HEADERS, "cache-control": "public, max-age=300" });
  });

  app.get("/sitemap.xml", async (c) => {
    const origin = c.env.APP_ORIGIN.replace(/\/$/, "");
    const { results } = await publishedPosts(c.env.DB, 5000);
    const latest = results[0]?.updated_at;
    const urls = [
      ...SITE_PAGES.map((p) => `  <url><loc>${origin}${p}</loc>${p === "/blog" && latest ? `<lastmod>${latest.slice(0, 10)}</lastmod>` : ""}</url>`),
      ...results.map((p) => `  <url><loc>${origin}/blog/${esc(p.slug)}</loc><lastmod>${p.updated_at.slice(0, 10)}</lastmod></url>`),
    ];
    const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join("\n")}\n</urlset>\n`;
    return c.body(xml, 200, { "content-type": "application/xml; charset=utf-8", "cache-control": "public, max-age=300", "x-content-type-options": "nosniff" });
  });
}

/* ---------------------------------------------------------------------------------------------- */

const PublishInput = z.strictObject({
  slug: z
    .string()
    .trim()
    .regex(SLUG_RE, "Usa solo minúsculas, números y guiones (3–80 caracteres).")
    .optional(),
});

const isSiteOrg = (c: Context<AppEnv>) => !!c.env.SITE_BLOG_ORG_ID && c.get("tenant").orgId === c.env.SITE_BLOG_ORG_ID;
const postView = (origin: string, p: PostRow | null) =>
  p ? { slug: p.slug, status: p.status, title: p.title, contentVersion: p.content_version, publishedAt: p.published_at, updatedAt: p.updated_at, url: `${origin.replace(/\/$/, "")}/blog/${p.slug}` } : null;

/** Tenant routes (mounted under /orgs/:orgId): publish an approved article to the site's own blog. */
export const siteBlog = new Hono<AppEnv>();

siteBlog.get("/content/:contentId/site-blog", requireScope("content:read"), async (c) => {
  if (!isSiteOrg(c)) return c.json({ available: false, post: null });
  const id = assertUuid(c.req.param("contentId"), "Contenido");
  const post = await c.env.DB.prepare("SELECT * FROM site_blog_posts WHERE organization_id = ? AND content_item_id = ?").bind(c.get("tenant").orgId, id).first<PostRow>();
  return c.json({ available: true, post: postView(c.env.APP_ORIGIN, post) });
});

siteBlog.post("/content/:contentId/site-blog", requireScope("content:approve"), async (c) => {
  if (!isSiteOrg(c)) throw new ApiError(403, "site_blog_unavailable", "Solo la organización propietaria del sitio puede publicar en su blog.");
  const t = c.get("tenant");
  const db = c.env.DB;
  const id = assertUuid(c.req.param("contentId"), "Contenido");
  const input = await parseBody(c, PublishInput);
  const item = await db
    .prepare("SELECT id, kind, title, body_md, status, version FROM content_items WHERE organization_id = ? AND id = ?")
    .bind(t.orgId, id)
    .first<{ id: string; kind: string; title: string; body_md: string; status: string; version: number }>();
  if (!item) throw notFound("Contenido");
  if (item.kind !== "blog_article") throw new ApiError(422, "site_blog_kind", "Solo los artículos de blog se publican en el blog.");
  if (item.status !== "approved") throw new ApiError(409, "not_approved", "Publica solo contenido aprobado: envíalo a revisión y apruébalo antes.");
  // Defence in depth: approval already blocked these, but the public page must never carry them.
  const blocking = checkDraft(item.body_md).filter((x) => x.level === "blocking");
  if (blocking.length) throw new ApiError(422, "draft_checks_failed", blocking.map((x) => x.message).join(" "), { checks: blocking });

  const existing = await db.prepare("SELECT * FROM site_blog_posts WHERE content_item_id = ?").bind(id).first<PostRow>();
  let slug = input.slug ?? existing?.slug ?? blogSlug(item.title);
  const clash = await db.prepare("SELECT content_item_id FROM site_blog_posts WHERE slug = ? AND content_item_id <> ?").bind(slug, id).first<{ content_item_id: string }>();
  if (clash) {
    if (input.slug) throw new ApiError(409, "slug_taken", "Ya hay otro artículo con esa dirección. Elige otra.");
    slug = `${slug.slice(0, 71)}-${id.slice(0, 8)}`;
  }
  const now = nowIso();
  const description = blogDescription(bodyWithoutTitle(item.body_md));
  const stmt = existing
    ? db
        .prepare("UPDATE site_blog_posts SET slug = ?, title = ?, description = ?, body_md = ?, content_version = ?, status = 'published', published_by = ?, published_at = CASE WHEN status = 'published' THEN published_at ELSE ? END, updated_at = ? WHERE id = ?")
        .bind(slug, item.title, description, item.body_md, item.version, t.userId, now, now, existing.id)
    : db
        .prepare("INSERT INTO site_blog_posts (id, organization_id, content_item_id, content_version, slug, title, description, body_md, status, published_by, published_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'published', ?, ?, ?)")
        .bind(uuid(), t.orgId, id, item.version, slug, item.title, description, item.body_md, t.userId, now, now);
  await db.batch([
    stmt,
    auditStmt(db, { organizationId: t.orgId, actorUserId: t.userId, action: "site_blog.publish", entityType: "content_item", entityId: id, before: existing ? { slug: existing.slug, status: existing.status, version: existing.content_version } : null, after: { slug, version: item.version }, requestId: c.get("requestId") }),
  ]);
  const post = await db.prepare("SELECT * FROM site_blog_posts WHERE content_item_id = ?").bind(id).first<PostRow>();
  return c.json({ available: true, post: postView(c.env.APP_ORIGIN, post) }, existing ? 200 : 201);
});

siteBlog.delete("/content/:contentId/site-blog", requireScope("content:approve"), async (c) => {
  if (!isSiteOrg(c)) throw new ApiError(403, "site_blog_unavailable", "Solo la organización propietaria del sitio puede publicar en su blog.");
  const t = c.get("tenant");
  const id = assertUuid(c.req.param("contentId"), "Contenido");
  const existing = await c.env.DB.prepare("SELECT * FROM site_blog_posts WHERE organization_id = ? AND content_item_id = ?").bind(t.orgId, id).first<PostRow>();
  if (!existing) throw notFound("Publicación");
  if (existing.status === "published") {
    await c.env.DB.batch([
      c.env.DB.prepare("UPDATE site_blog_posts SET status = 'unpublished', updated_at = ? WHERE id = ?").bind(nowIso(), existing.id),
      auditStmt(c.env.DB, { organizationId: t.orgId, actorUserId: t.userId, action: "site_blog.unpublish", entityType: "content_item", entityId: id, before: { slug: existing.slug }, after: { status: "unpublished" }, requestId: c.get("requestId") }),
    ]);
  }
  const post = await c.env.DB.prepare("SELECT * FROM site_blog_posts WHERE id = ?").bind(existing.id).first<PostRow>();
  return c.json({ available: true, post: postView(c.env.APP_ORIGIN, post) });
});
