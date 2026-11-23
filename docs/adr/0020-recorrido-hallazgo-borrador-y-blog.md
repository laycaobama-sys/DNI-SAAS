# ADR 0020 — Recorrido hallazgo → borrador revisable → exportación, y blog propio alimentado por Content Studio

Fecha: 2026-11-23 · Estado: aceptada

## Contexto

La especificación de ampliación exige que el recorrido «dominio → auditoría con evidencia → borrador revisable → exportación» funcione **sin conectores y con la IA agotada**, y que la web pública tenga un blog funcional, un sitemap dinámico y una `og:image` en PNG. La política del proyecto es IA solo gratuita, Stripe desactivado y 0 € en servicios nuevos.

## Decisiones

1. **El borrador desde un hallazgo es determinista.** `buildFindingDraft` (core) construye el texto a partir de la evidencia guardada en el rastreo: qué se observó, por qué importa, cambio propuesto con huecos `[COMPLETAR]`/`[VERIFICAR]`, cómo comprobarlo y un anexo de evidencia (URL, tipo de página, dato observado, fuente y fecha). No usa IA ni créditos, así que funciona con la cuota agotada. Es idempotente por `(crawlId, ruleKey)`.
2. **Se reutiliza Content Studio** (sin migración): el borrador es un `content_item` con `source = 'human'`, `credits = 0`, `provider = NULL` y `brief_json.origin = 'audit_finding'`. El tipo se elige con `kindForRule` entre los existentes.
3. **Comprobaciones antes de aprobar**, deterministas: campos sin completar y promesas de resultados **bloquean**; cifras sin fuente y precios que no figuran en las ofertas de la marca solo se aprueban con confirmación explícita, que queda en el registro (`acknowledgedChecks`). Se aplican a todos los borradores, también a los generados con IA.
4. **Exportar no depende del plan.** El informe de auditoría y el brief de cada hallazgo se descargan en todos los planes, Free incluido. Guardar borradores editables sigue siendo Content Studio (Starter o superior), según la matriz de planes vigente.
5. **Blog propio en el Worker.** `/blog`, `/blog/:slug` y `/blog/feed.xml` se renderizan en el Worker sobre la plantilla `blog.html` del build (con el CSS hasheado), así que no hace falta otra infraestructura ni coste. Solo la organización del sitio (`vars.SITE_BLOG_ORG_ID`) publica, solo artículos **aprobados**, solo con `content:approve` y siempre con registro. La página pública es una **instantánea** de la versión aprobada (tabla `site_blog_posts`, migración aditiva 0018): editar después en Content Studio no cambia la web hasta volver a publicar. El HTML sale del mismo renderizador seguro que las exportaciones.
6. **El sitemap pasa al Worker** (`/sitemap.xml`): incluye las páginas públicas, `/blog` y cada artículo con `lastmod`. El build ya no lo emite.
7. **`og:image` en PNG 1200×630**, generada una vez a partir del SVG de marca con herramientas locales. El SVG se conserva como fuente.

## Consecuencias

- El recorrido completo funciona en producción sin conectores ni IA (`journey.test.ts`, `site-blog.test.ts`).
- Publicar en CMS de clientes (WordPress y demás) sigue pendiente: requiere sus credenciales y un entorno de pruebas.
- El aviso a buscadores tras publicar (IndexNow) queda como mejora: es gratuito, pero es un efecto externo que se añadirá con su propia prueba.
