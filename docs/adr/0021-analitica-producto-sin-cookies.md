# ADR 0021 — Analítica de producto propia, sin cookies, y una sola fuente para la web pública

Fecha: 2026-11-23 · Estado: aceptada

## Contexto

La Fase 0 del plan comercial pide medir el embudo (auditoría → registro → bienvenida → conexiones → suscripción) sin herramientas de terceros ni banner de cookies, y que la portada, `llms.txt` y el menú de la app no puedan contradecirse sobre qué está disponible. La política del proyecto es 0 € en servicios nuevos, datos en la UE y ningún dato personal en registros.

## Decisiones

1. **Tabla propia `product_events`** (migración aditiva `0020_product_analytics.sql`): `id`, `organization_id` (NULL si no hay organización), `event`, `source` (`server` | `client`), `props_json` (≤ 512 caracteres), `path` (≤ 200), `visitor_hash` (32 hex o NULL) y `created_at`. **No hay columna para IP, email ni user agent.** No es una tabla de cliente: ningún tenant la lee; solo la consola de plataforma ve agregados.
2. **Sin cookies ni identificadores persistentes.** El «visitante» es `sha256(IP_HASH_SALT | día UTC | IP | user agent)` truncado a 32 hex: cambia cada día, no permite seguir a nadie entre días y la IP nunca se guarda. Sin `IP_HASH_SALT` en producción el código es NULL (un hash sin secreto se podría revertir probando todo IPv4). Con `Sec-GPC: 1` o `DNT: 1` tampoco se calcula. Base legal: interés legítimo (art. 6.1.f RGPD) para estadística agregada. No se guarda ni se lee nada en el dispositivo (solo lo que el navegador ya envía en cada petición), por eso no hay cookies que consentir según el art. 22.2 LSSI; conviene que el asesor legal de la titular lo confirme. Se informa en la política de privacidad (apartado «Estadística de uso, sin cookies»).
3. **Lista cerrada de eventos**: `audit_started`, `audit_teaser_viewed`, `signup`, `onboarding_step`, `gsc_connected`, `cms_connected`, `first_article_published`, `trial_started`, `subscribed`, `upgraded`, `canceled`, `paused`. Propiedades saneadas (máx. 6 claves `snake_case`; textos cortos sin `@`, URLs ni series de 6+ dígitos) y ruta sin origen, query ni fragmento, con UUID y números largos enmascarados.
4. **Dos orígenes, separados.** `trackEvent(db, …)` es reutilizable por cualquier flujo del backend, nunca lanza y devuelve si escribió. Los eventos que registra el servidor (`source = server`) son verificados. `POST /api/v1/public/events` acepta eventos declarados por nuestras páginas (`source = client`): sin sesión ni CSRF (como `sendBeacon`), cuerpo ≤ 2 KB, `Origin` propio, 60/10 min y 600/día por IP con hash (`ratelimit.ts`), sin organización y sin contar bots. La consola muestra ambos por separado.
5. **Instrumentado hoy** (servidor): `signup` (correo y Google, solo usuarios nuevos), `onboarding_step` (`email_verified`, `organization_created`), `gsc_connected` y `audit_started` (análisis nuevo, no repeticiones idempotentes); el formulario de la portada declara `audit_started` desde el navegador. El resto figura en la consola como «sin instrumentar», para que un cero no se lea como «nadie lo hizo».
6. **Retención de 13 meses** (395 días): el cron borra lo anterior (`purgeProductEvents`).
7. **`GET /api/v1/admin/funnel`** (7 y 30 días) protegido como el resto de `/admin`; devuelve solo agregados con `source`, `observedAt`, `measurement: observed` y advertencias. Tarjeta «Embudo» en la consola de plataforma.
8. **Una sola fuente de estado**: `FEATURES` (`packages/core/src/features.ts`) genera las etiquetas de la portada (y su verificación en `/api/v1/public/features`), `llms.txt` en el build (`buildLlmsTxt`) y las marcas «Parcial» del menú (`menuStatusBadge`). Pruebas que fallan si divergen.
9. **Una sola CSP** para la web pública (`apps/api/src/lib/site-headers.ts` = `apps/web/public/_headers`). No se añade `static.cloudflareinsights.com`: la web no carga el beacon de Cloudflare Web Analytics; una prueba exige que la CSP lo permita si y solo si alguna página lo carga.

## Consecuencias

- Sin coste, sin terceros, sin banner. La titular debe definir `IP_HASH_SALT` con `wrangler secret put` para contar visitantes-día en producción; sin él, los eventos se cuentan igual pero sin visitantes.
- Si en el panel de Cloudflare se activa Web Analytics con inyección automática, el beacon quedaría bloqueado por la CSP: hay que añadirlo a la vez en la página y en la CSP (la prueba lo exige).
- `cms_connected`, `first_article_published`, `trial_started`, `subscribed`, `upgraded`, `canceled`, `paused` y `audit_teaser_viewed` quedan por instrumentar: los de facturación se añadirán con la reforma de facturación en curso; los de CMS y avance público cuando existan esas funciones.
