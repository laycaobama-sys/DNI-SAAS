import { Hono, type Context } from "hono";
import { FEATURE_STATUS_LABEL, FEATURES } from "@dni/core";
import { bodyLimit } from "hono/body-limit";
import type { AppEnv, Deps } from "./env";
import { ApiError, problem } from "./lib/http";
import { log } from "./lib/util";
import { aiPrivacy, csrf, requestId, requireMembership, requirePlanModule, requireScope, requireUser, securityHeaders, session } from "./middleware";
import { admin } from "./routes/admin";
import { control } from "./routes/control";
import { platform } from "./routes/platform";
import { ai } from "./routes/ai";
import { aihub } from "./routes/aihub";
import { usage } from "./routes/usage";
import { content } from "./routes/content";
import { crm, crmPublic } from "./routes/crm";
import { landings, servePublicLanding } from "./routes/landings";
import { organic } from "./routes/organic";
import { automation } from "./routes/automation";
import { studio } from "./routes/studio";
import { agency } from "./routes/agency";
import { auth } from "./routes/auth";
import { billing, billingPublic, providerManifest, webhooks } from "./routes/billing";
import { insights } from "./routes/insights";
import { oauth } from "./routes/oauth";
import { analytics } from "./routes/analytics";
import { geo } from "./routes/geo";
import { reports } from "./routes/reports";
import { searchConsole } from "./routes/searchConsole";
import { registerPublicBlog, siteBlog } from "./routes/site-blog";
import { eventsPublic } from "./routes/events";
import { FALLBACK_404_HTML, SITE_CSP, SITE_SECURITY_HEADERS } from "./lib/site-headers";
import { org, orgsPublic } from "./routes/orgs";
import { work } from "./routes/work";

/** IndexNow key for dnigrowth.com (public; see https://www.indexnow.org/documentation). */
export const INDEXNOW_KEY = "c2d713b310de907a6ead8590e603ff8c";

/** Ownership files must answer on every host that has its own search-engine property. */
const OWNERSHIP_FILE = /^\/(google[0-9a-f]+\.html|BingSiteAuth\.xml|[0-9a-f]{32}\.txt)$/;

/**
 * Returns the 301 target when a GET for a public page arrives on a non-canonical variant
 * (workers.dev or www host, http, /index.html, /x.html, /x/), or null when the URL is canonical.
 * The JSON API keeps answering on any host (health checks, webhooks).
 */
export function canonicalRedirect(url: URL, canon: URL): string | null {
  const path = url.pathname;
  if (OWNERSHIP_FILE.test(path)) return null;
  if (path.startsWith("/api/") && path !== "/api/v1/auth/google/start") return null;
  let clean = path;
  if (clean === "/index.html") clean = "/";
  else if (/^\/(legal\/[a-z-]+|blog|blog\/[a-z0-9-]+|seguridad|precios)(\.html|\/)$/.test(clean)) clean = clean.replace(/(\.html|\/)$/, "");
  const offHost = url.host !== canon.host || url.protocol !== canon.protocol;
  if (!offHost && clean === path) return null;
  return `${canon.origin}${clean}${url.search}`;
}

export function createApp(deps: Deps) {
  const app = new Hono<AppEnv>();

  // One canonical URL per page (search engines flag duplicates otherwise): every public page and the
  // Google sign-in start answer only on APP_ORIGIN over https, without ".html" or trailing-slash variants.
  app.use("*", async (c, next) => {
    if (c.env.ENVIRONMENT !== "production" || (c.req.method !== "GET" && c.req.method !== "HEAD")) return next();
    const target = canonicalRedirect(new URL(c.req.url), new URL(c.env.APP_ORIGIN));
    return target ? c.redirect(target, 301) : next();
  });

  app.use("/api/*", requestId, securityHeaders, async (c, next) => {
    c.set("deps", deps);
    await next();
  });
  app.use("/api/*", bodyLimit({ maxSize: 1024 * 1024, onError: () => { throw new ApiError(413, "payload_too_large", "Petición demasiado grande."); } }));
  app.use("/api/*", csrf, session);

  app.get("/api/v1/health", (c) => c.json({ ok: true, environment: c.env.ENVIRONMENT, time: new Date().toISOString() }));
  app.get("/api/v1/providers", (c) => c.json({ items: providerManifest(c.env) }));

  app.route("/api/v1/auth", auth);
  app.route("/api/v1/auth", oauth);
  app.route("/api/v1/webhooks", webhooks);
  app.route("/api/v1", orgsPublic);
  app.get("/api/v1/public/features", (c) =>
    c.json(
      { items: FEATURES.map((f) => ({ key: f.key, label: f.label, status: f.status, statusLabel: FEATURE_STATUS_LABEL[f.status], summary: f.summary, ...(f.limit ? { limit: f.limit } : {}) })) },
      200,
      { "cache-control": "public, max-age=300" },
    ),
  );
  app.route("/api/v1/public", crmPublic);
  app.route("/api/v1/public", eventsPublic);
  app.route("/api/v1/public", billingPublic);

  // Every tenant route: authenticated user + active membership resolved from the path.
  const tenant = new Hono<AppEnv>();
  tenant.use("*", requireUser, requireMembership, requirePlanModule, aiPrivacy);
  tenant.route("/", org);
  tenant.route("/", work);
  tenant.route("/", insights);
  tenant.route("/", billing);
  tenant.route("/", ai);
  tenant.route("/", aihub);
  tenant.route("/", usage);
  tenant.route("/", content);
  tenant.route("/", siteBlog);
  tenant.route("/", searchConsole);
  tenant.route("/", analytics);
  tenant.route("/", geo);
  tenant.route("/", reports);
  tenant.route("/", crm);
  tenant.route("/", landings);
  tenant.route("/", organic);
  tenant.route("/", automation);
  tenant.route("/", studio);
  tenant.route("/", agency);
  tenant.get("/integrations", requireScope("integrations:read"), async (c) => {
    // Per-organization connection state overrides the platform-level availability.
    const { results } = await c.env.DB.prepare("SELECT provider, status, last_sync_at FROM integrations WHERE organization_id = ?")
      .bind(c.get("tenant").orgId)
      .all<{ provider: string; status: string; last_sync_at: string | null }>();
    const byProvider = new Map(results.map((r) => [r.provider, r]));
    const STATUS_NOTE: Record<string, string> = {
      connected: "Conectado (solo lectura).",
      reauth_required: "Google retiró el permiso: vuelve a conectar.",
      disconnected: "Desconectado: se conservan los datos ya importados.",
    };
    const items = providerManifest(c.env).map((p) => {
      const r = byProvider.get(p.key);
      if (!r) return p;
      return { ...p, status: r.status, note: `${STATUS_NOTE[r.status] ?? p.note}${r.last_sync_at ? ` Última sincronización: ${r.last_sync_at.slice(0, 16).replace("T", " ")} UTC.` : ""}` };
    });
    return c.json({ items });
  });
  app.route("/api/v1/orgs/:orgId", tenant);
  app.route("/api/v1/admin", control);
  app.route("/api/v1/admin", admin);
  app.route("/api/v1/platform", platform);

  // Development-only mailbox to complete email flows locally. 404 in every other environment.
  app.get("/api/v1/dev/mailbox", async (c) => {
    if (c.env.ENVIRONMENT !== "development" && c.env.ENVIRONMENT !== "test") throw new ApiError(404, "not_found", "No encontrado.");
    const email = (c.req.query("email") ?? "").toLowerCase();
    const { results } = await c.env.DB.prepare("SELECT to_email, subject, body, created_at FROM dev_mailbox WHERE to_email = ? ORDER BY created_at DESC LIMIT 10").bind(email).all();
    return c.json({ items: results });
  });

  app.all("/api/*", () => {
    throw new ApiError(404, "not_found", "Ruta no encontrada.");
  });

  app.onError((err, c) => {
    if (err instanceof ApiError) return problem(c, err);
    log("error", "unhandled", { path: c.req.path, requestId: c.get("requestId"), error: err instanceof Error ? err.message : String(err) });
    return problem(c, new ApiError(500, "internal_error", "Error interno. Inténtalo de nuevo."));
  });

  // Google Search Console ownership file (URL-prefix property). Served by the Worker so the exact
  // .html path answers 200 without the Static Assets extension redirect. The token is public.
  // Published landing pages (F5): /l/<organisation slug>/<page slug>. No cookies, own CSP with nonce.
  app.get("/l/:orgSlug/:slug", (c) => servePublicLanding(c));

  app.get("/google07bca8a276fd14a6.html", (c) => c.text("google-site-verification: google07bca8a276fd14a6.html", 200, { "content-type": "text/html; charset=utf-8" }));
  // Bing Webmaster Tools ownership token (public by design, not a credential).
  const BING_SITE_AUTH = ['<?xml version="1.0"?>', "<users>", "  <user>5CF73C5654422132BD89BBBD0FBE51A1</user>", "</users>", ""].join("\n");
  app.get("/BingSiteAuth.xml", (c) => c.body(BING_SITE_AUTH, 200, { "content-type": "application/xml; charset=utf-8" }));
  // IndexNow key file (public by design: it only proves the site owns the key used to ping search engines).
  app.get(`/${INDEXNOW_KEY}.txt`, (c) => c.text(INDEXNOW_KEY));

  // Public blog fed by Content Studio and the dynamic sitemap (ADR 0020).
  registerPublicBlog(app);

  // Non-API routes: static landing + SPA shell served from Workers Static Assets.
  app.get("*", async (c) => {
    const url = new URL(c.req.url);
    if (!c.env.ASSETS) return notFoundPage(c);
    if (url.pathname === "/app" || url.pathname.startsWith("/app/")) {
      const res = await c.env.ASSETS.fetch(new Request(new URL("/app/", url), c.req.raw));
      const h = new Headers(res.headers);
      h.set("cache-control", "no-store");
      h.set("x-robots-tag", "noindex, nofollow");
      h.set("x-frame-options", "DENY");
      h.set("x-content-type-options", "nosniff");
      h.set("referrer-policy", "strict-origin-when-cross-origin");
      h.set("content-security-policy", SITE_CSP);
      return new Response(res.body, { status: res.status, headers: h });
    }
    // The 404 page itself is never a 200 page.
    if (url.pathname === "/404" || url.pathname === "/404.html") return notFoundPage(c);
    const res = await c.env.ASSETS.fetch(c.req.raw);
    return res.status === 404 ? notFoundPage(c, res) : res;
  });

  /**
   * Custom 404 for unknown public pages (never /api, which answers problem+json, nor /app, the SPA):
   * dist/404.html (also what Static Assets serve with not_found_handling «404-page»), status 404, noindex
   * and the same security headers as every page.
   */
  async function notFoundPage(c: Context<AppEnv>, assetRes?: Response): Promise<Response> {
    const read = async (get: () => Promise<Response | null | undefined> | undefined) => {
      try {
        const r = await get();
        return r ? await r.text() : "";
      } catch {
        return "";
      }
    };
    // The asset layer's own 404 body (not_found_handling «404-page»), else dist/404.html, else the inline copy.
    const fromAssets = await read(async () => assetRes);
    const built = fromAssets.includes("data-not-found") ? fromAssets : await read(() => c.env.ASSETS?.fetch(new Request(new URL("/404", c.req.url))));
    const html = built.includes("data-not-found") ? built : FALLBACK_404_HTML;
    return new Response(c.req.method === "HEAD" ? null : html, {
      status: 404,
      headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-robots-tag": "noindex", ...SITE_SECURITY_HEADERS },
    });
  }

  return app;
}
