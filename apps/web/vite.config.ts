import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { legalTokens, loadLegalIdentity } from "./legal/legal-identity";

/**
 * Public site URL used for canonical, sitemap, robots, llms.txt and JSON-LD.
 * Single source of truth: vars.APP_ORIGIN in apps/api/wrangler.jsonc (SITE_URL env overrides).
 */
function appOriginFromWrangler(): string {
  const raw = readFileSync(resolve(import.meta.dirname, "../api/wrangler.jsonc"), "utf8");
  const m = /"APP_ORIGIN"\s*:\s*"([^"]+)"/.exec(raw);
  if (!m?.[1]) throw new Error("APP_ORIGIN missing in apps/api/wrangler.jsonc");
  return m[1];
}
const SITE_URL = (process.env.SITE_URL ?? appOriginFromWrangler()).replace(/\/$/, "");
const BUILD_DATE = new Date().toISOString().slice(0, 10);

/**
 * Owner identity for the legal pages (git-ignored local file; see legal/legal-identity.ts).
 * A local/production build without it fails, so a deploy can never ship empty legal pages.
 * CI (public repo, no personal data) builds with a visible "not configured" notice instead.
 */
const LEGAL_IDENTITY = loadLegalIdentity();
if (!LEGAL_IDENTITY && !process.env.CI && process.env.DNI_ALLOW_MISSING_LEGAL !== "1") {
  throw new Error("Falta apps/web/legal/legal-identity.local.json (datos del titular para las páginas legales). Copia legal-identity.example.json y complétalo.");
}
const LEGAL_TOKENS = legalTokens(LEGAL_IDENTITY);

function fillLegal(html: string): string {
  let out = html;
  for (const [token, value] of Object.entries(LEGAL_TOKENS)) out = out.replaceAll(token, value);
  if (/<!--LEGAL:|__LEGAL_/.test(out)) throw new Error("Página legal con un marcador de identidad sin sustituir.");
  return out;
}

function seoFiles(): Plugin {
  return {
    name: "dni-seo-files",
    transformIndexHtml: (html) => fillLegal(html.replaceAll("__SITE_URL__", SITE_URL).replaceAll("__BUILD_DATE__", BUILD_DATE)),
    generateBundle() {
      const pages = ["/", "/legal/privacidad", "/legal/aviso-legal", "/legal/condiciones", "/legal/eliminacion-datos"];
      this.emitFile({
        type: "asset",
        fileName: "sitemap.xml",
        source: `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${pages
          .map((p) => `  <url><loc>${SITE_URL}${p}</loc><lastmod>${BUILD_DATE}</lastmod></url>`)
          .join("\n")}\n</urlset>\n`,
      });
      this.emitFile({
        type: "asset",
        fileName: "robots.txt",
        source: `User-agent: *\nAllow: /\nDisallow: /app/\nDisallow: /api/\n\nSitemap: ${SITE_URL}/sitemap.xml\n`,
      });
      this.emitFile({
        type: "asset",
        fileName: "llms.txt",
        source: `# DNI Growth\n\n> Software SaaS de crecimiento digital con IA para pymes y agencias: auditoría SEO técnica, GEO (Generative Engine Optimization) y AEO (Answer Engine Optimization), perfil de marca verificable y plan de crecimiento editable. Parte de la familia de marcas DNI.\n\n## Qué hace hoy (disponible)\n- Auditoría pública y no intrusiva de una web a partir de su URL (respeta robots.txt): 31 reglas técnicas con evidencia por URL.\n- Perfil de marca extraído con fuente de cada dato y confirmación humana.\n- Plan de crecimiento de 30 días editable y exportable (Markdown/JSON).\n- Asesor de crecimiento con IA que responde usando los datos observados de tu auditoría (sin inventar métricas).\n- Creative Studio: generación de imágenes con IA para redes y web, con filtros de contenido.\n- Conexión de solo lectura con Google Search Console y Google Analytics 4: datos observados de tu propia cuenta, con fuente, fecha y advertencias.\n- Organizaciones multiempresa, roles y registro de auditoría.\n\n## En desarrollo (no disponible todavía)\n- Content Studio con publicación en CMS, monitor de visibilidad en IA, estudio de vídeo, landing pages, CRM, anuncios en Meta/Google con aprobación y límite de gasto.\n\n## Principios\n- Ninguna métrica sin fuente ni fecha. No se garantizan posiciones en buscadores ni menciones en motores de IA.\n- Nada se publica ni se gasta sin aprobación explícita.\n\n## Enlaces\n- [Inicio](${SITE_URL}/)\n- [Crear cuenta y auditar una web](${SITE_URL}/app/register)\n- [Privacidad](${SITE_URL}/legal/privacidad)\n- [Condiciones de uso](${SITE_URL}/legal/condiciones)\n- [Aviso legal](${SITE_URL}/legal/aviso-legal)\n`,
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), seoFiles()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
    rollupOptions: {
      input: {
        landing: resolve(import.meta.dirname, "index.html"),
        app: resolve(import.meta.dirname, "app/index.html"),
        privacidad: resolve(import.meta.dirname, "legal/privacidad.html"),
        avisoLegal: resolve(import.meta.dirname, "legal/aviso-legal.html"),
        condiciones: resolve(import.meta.dirname, "legal/condiciones.html"),
        eliminacionDatos: resolve(import.meta.dirname, "legal/eliminacion-datos.html"),
      },
    },
  },
  server: {
    port: 5173,
    proxy: { "/api": "http://localhost:8787" },
  },
});
