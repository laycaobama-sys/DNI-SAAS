/**
 * Security headers of every public HTML page. The same values live in apps/web/public/_headers (pages
 * served straight from Static Assets); a test fails if the two drift apart. The site loads no third-party
 * script (no Cloudflare Web Analytics beacon either: product analytics are our own, cookieless, at
 * /api/v1/public/events), so script-src and connect-src stay 'self'.
 */
export const SITE_CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self' data: https:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'";

export const SITE_SECURITY_HEADERS: Record<string, string> = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "strict-origin-when-cross-origin",
  "x-frame-options": "DENY",
  "permissions-policy": "camera=(), microphone=(), geolocation=(), interest-cohort=()",
  "strict-transport-security": "max-age=31536000; includeSubDomains",
  "content-security-policy": SITE_CSP,
};

/** Minimal 404 page for runs without the built assets (tests, local API only). Same links as dist/404.html. */
export const FALLBACK_404_HTML = `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Página no encontrada · DNI Growth</title><meta name="robots" content="noindex"></head><body><main id="main" data-not-found><h1>Esta página no existe</h1><ul><li><a href="/">Ir al inicio</a></li><li><a href="/app/register">Auditar mi web gratis</a></li><li><a href="/blog">Leer el blog</a></li><li><a href="/#precios">Ver los precios</a></li><li><a href="/#contacto">Escribirnos</a></li></ul></main></body></html>`;
