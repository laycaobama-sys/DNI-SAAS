import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { AppEnv, Deps } from "./env";
import { ApiError, problem } from "./lib/http";
import { log } from "./lib/util";
import { csrf, requestId, requireMembership, requireScope, requireUser, securityHeaders, session } from "./middleware";
import { admin } from "./routes/admin";
import { ai } from "./routes/ai";
import { aihub } from "./routes/aihub";
import { content } from "./routes/content";
import { auth } from "./routes/auth";
import { billing, providerManifest, webhooks } from "./routes/billing";
import { insights } from "./routes/insights";
import { oauth } from "./routes/oauth";
import { searchConsole } from "./routes/searchConsole";
import { org, orgsPublic } from "./routes/orgs";
import { work } from "./routes/work";

export function createApp(deps: Deps) {
  const app = new Hono<AppEnv>();

  // Browser pages and the Google sign-in start live on the canonical origin only (cookies, OAuth state).
  app.use("*", async (c, next) => {
    if (c.env.ENVIRONMENT !== "production" || (c.req.method !== "GET" && c.req.method !== "HEAD")) return next();
    const url = new URL(c.req.url);
    const canon = new URL(c.env.APP_ORIGIN);
    const page = url.pathname === "/app" || url.pathname.startsWith("/app/") || url.pathname === "/api/v1/auth/google/start";
    if (page && url.host !== canon.host) return c.redirect(`${canon.origin}${url.pathname}${url.search}`, 301);
    return next();
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

  // Every tenant route: authenticated user + active membership resolved from the path.
  const tenant = new Hono<AppEnv>();
  tenant.use("*", requireUser, requireMembership);
  tenant.route("/", org);
  tenant.route("/", work);
  tenant.route("/", insights);
  tenant.route("/", billing);
  tenant.route("/", ai);
  tenant.route("/", aihub);
  tenant.route("/", content);
  tenant.route("/", searchConsole);
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
  app.route("/api/v1/admin", admin);

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
  app.get("/google07bca8a276fd14a6.html", (c) => c.text("google-site-verification: google07bca8a276fd14a6.html", 200, { "content-type": "text/html; charset=utf-8" }));

  // Non-API routes: static landing + SPA shell served from Workers Static Assets.
  app.get("*", async (c) => {
    if (!c.env.ASSETS) return c.text("Not found", 404);
    const url = new URL(c.req.url);
    if (url.pathname === "/app" || url.pathname.startsWith("/app/")) {
      const res = await c.env.ASSETS.fetch(new Request(new URL("/app/", url), c.req.raw));
      const h = new Headers(res.headers);
      h.set("cache-control", "no-store");
      h.set("x-frame-options", "DENY");
      h.set("x-content-type-options", "nosniff");
      h.set("referrer-policy", "strict-origin-when-cross-origin");
      h.set(
        "content-security-policy",
        "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data: https:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
      );
      return new Response(res.body, { status: res.status, headers: h });
    }
    return c.env.ASSETS.fetch(c.req.raw);
  });

  return app;
}
