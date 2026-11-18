# Estado de implementación — DNI Growth

Última actualización: 2026-11-18 · Producción: **https://dnigrowth.com** (Worker `dni-growth`, versión `dd5caec3-b99f-4d80-ab49-ba871406cde5`; workers.dev redirige con 301 a dnigrowth.com) · Workers Paid, sin servicios de pago adicionales ([verificación de la cuenta](CLOUDFLARE_ACCOUNT_VERIFICATION.md)).

Leyenda:
- **VERIFICADO EN PRODUCCIÓN**: probado contra la URL pública con una respuesta comprobable.
- **VERIFICADO SOLO EN LOCAL**: tests automáticos y/o prueba manual en `wrangler dev`; en producción falta el paso indicado.
- **BLOQUEADO POR PERMISOS**: necesita una acción, clave o aceptación del titular.
- **NO IMPLEMENTADO**.

Pruebas automáticas: lint, typecheck, **242 tests** (117 core + 125 API), build y escaneo de secretos en verde el 2026-11-18 (CI de GitHub en verde).

Pruebas E2E en producción del 2026-11-18 con la cuenta verificada de la titular (organización propia, plan Free), ejecutadas desde el navegador contra https://dnigrowth.com; cada fila indica la respuesta observada.

## Dominio, correo y plataforma

| Funcionalidad | Estado | Prueba |
|---|---|---|
| Dominio `dnigrowth.com` + `www` como dominios personalizados del Worker (TLS automático) | VERIFICADO EN PRODUCCIÓN | `wrangler deploy` → `dnigrowth.com (custom domain)`, `www.dnigrowth.com (custom domain)`; `GET /api/v1/health` → 200 `environment: production` |
| `www` → apex 301 (regla de redirección gratuita, conserva ruta y query) | VERIFICADO EN PRODUCCIÓN | `curl https://www.dnigrowth.com/legal/privacidad?x=1` → 301 `https://dnigrowth.com/legal/privacidad?x=1` |
| workers.dev → dnigrowth.com (páginas de la app y login con Google) | VERIFICADO EN PRODUCCIÓN | `/app/login` en workers.dev → 301 a dnigrowth.com |
| Email Sending (SPF `include:_spf.mx.cloudflare.net`, DKIM `cf-bounce._domainkey`, DMARC `p=reject`) | VERIFICADO EN PRODUCCIÓN | DNS consultado por DoH; email de verificación **entregado**: la titular pulsó el enlace y su cuenta figura verificada |
| Email Routing hola@/soporte@/privacidad@/facturacion@ → buzón del titular | VERIFICADO EN PRODUCCIÓN | reglas activas en el panel de Cloudflare |
| Tope mensual de emails (`EMAIL_MONTHLY_CAP=2500` < 3.000 incluidos) | VERIFICADO SOLO EN LOCAL | `mail.ts` devuelve `monthly_cap_reached` sin enviar |
| Search Console `https://dnigrowth.com/` | VERIFICADO EN PRODUCCIÓN | propiedad verificada; `/sitemap.xml` en estado **«Correcto»**, 3 páginas descubiertas (leído el 2026-11-18) |
| Migración D1 0005 (aditiva) con copia previa | VERIFICADO EN PRODUCCIÓN | `backups/dni-growth-db-pre-0005-20261118-0019.sql`; `wrangler d1 migrations apply --remote` ✅ |

| Worker: errores y CPU | VERIFICADO EN PRODUCCIÓN | `wrangler tail`: peticiones `ok`, 0–1 ms de CPU, 0 excepciones; cron de cada minuto 7 ms de CPU |
| Coste observado 2026-11-18 | VERIFICADO EN PRODUCCIÓN | OpenRouter 0 USD (4 solicitudes); Workers AI 0,0013 USD estimados (incluido); email 2 envíos de 3.000/mes incluidos |

## F0 — Fundaciones

| Funcionalidad | Estado | Prueba |
|---|---|---|
| Monorepo pnpm, TS strict, Zod en fronteras (entradas de IA estrictas: no admiten `model`, `provider` ni precios) | VERIFICADO SOLO EN LOCAL | `pnpm verify` |
| Registro, verificación, login, sesión, logout, CSRF | VERIFICADO EN PRODUCCIÓN | registro + verificación por email + login de la titular; la sesión sobrevive a la recarga y su cookie no es accesible desde JS (HttpOnly); logout → 200 y después `/auth/me` sin usuario y ruta protegida → 401; petición sin cabecera CSRF → 403. Bloqueo por fallos y rate limit solo en local (no se fuerzan en producción para no bloquear cuentas reales) |
| Verificación de email | VERIFICADO EN PRODUCCIÓN | la titular verificó su cuenta con el enlace recibido |
| **Inicio de sesión con Google** (OIDC + PKCE S256, nonce, vinculación segura) | VERIFICADO EN PRODUCCIÓN | 2026-11-18: `/auth/google/start` → 302 a Google con `code_challenge_method=S256`, `nonce` y `prompt=select_account`; tras elegir la cuenta de la titular entra en su panel; `user_identities` registra `google` vinculado a su usuario existente (siguen 2 usuarios: sin duplicado) |
| Organizaciones, invitaciones, roles, aislamiento multiempresa | VERIFICADO EN PRODUCCIÓN (aislamiento) · LOCAL (invitaciones, roles) | prod: otra organización → 404 en `/dashboard` y `/content`; `tenancy.test.ts` (guard SQL estático ampliado a `content_items`, `content_versions`, `organization_ai_preferences`) |
| Créditos con reserva → liquidación/liberación | VERIFICADO EN PRODUCCIÓN | ledger: concesión 50 → auditoría −10, asesor −1 ×2, borrador −3, imagen −5 = **30**; cada operación reserva/libera/liquida una sola vez |
| Stripe detrás de `BILLING_ENABLED=false` | VERIFICADO EN PRODUCCIÓN | sin clave: webhook → 503 `billing_disabled` (versión 7c6037e5) |
| Stripe (modo prueba): sincronización de catálogo, portal y webhook | VERIFICADO EN PRODUCCIÓN | contra la cuenta «DNI Growth» (entorno de prueba): 4 productos/precios EUR creados (39/89/179/349), portal `bpc_…` y webhook `we_…` en `https://dnigrowth.com/api/v1/webhooks/stripe` con firma gestionada y cifrada; segunda sincronización → todo `kept`/`updated` (sin duplicados) |
| Stripe: checkout de prueba pagado | VERIFICADO EN PRODUCCIÓN | la titular pagó Starter con la tarjeta de prueba 4242: webhooks `customer.subscription.created` + `checkout.session.completed` procesados (03:10:14 UTC), plan Starter activo hasta 2026-12-18, `+500` créditos (`plan_upgrade`) concedidos **una sola vez** pese a recibir 2 eventos (saldo 27 → 527) |
| Stripe: una suscripción por organización | VERIFICADO EN PRODUCCIÓN | segundo checkout con la suscripción activa → `409 subscription_exists`; los cambios van por el portal |
| Stripe: portal de cliente | VERIFICADO EN PRODUCCIÓN | «Gestionar suscripción» → `200`, portal del entorno de prueba con plan, facturas y cancelación; auditoría `billing.portal_open` |
| Stripe: cancelación al final del periodo | VERIFICADO EN PRODUCCIÓN | cancelar en el portal → `customer.subscription.updated` procesado, el plan sigue activo hasta el 18 dic; migración 0007 (`cancel_at_period_end`, aditiva, copia previa en `backups/`): renovar → indicador 0; volver a cancelar → la app muestra «Cancelación programada… hasta el 18 de diciembre de 2026» (versión 73543193) |
| Stripe: plan según precio, cambio de plan con prorrateo, eventos antiguos/cruzados ignorados, past_due → Free, baja → Free | VERIFICADO SOLO EN LOCAL | `stripe.test.ts` (11, incluye cancelación programada y deshecha) |
| Cabeceras de seguridad (CSP, HSTS, XFO, nosniff) | VERIFICADO EN PRODUCCIÓN | `curl -I https://dnigrowth.com/` |

## F1 — URL → análisis → marca → plan

| Funcionalidad | Estado | Prueba |
|---|---|---|
| SSRF, robots.txt, 31 reglas | VERIFICADO SOLO EN LOCAL | `ssrf.test.ts`, `seo.test.ts` |
| **F1 en producción**: URL → auditoría → perfil de marca → plan 30 días → exportación | VERIFICADO EN PRODUCCIÓN | auditoría de `https://dnigym.com` (solo lectura de la web pública): job `completed`, 10 páginas, puntuación 79, 8 problemas (2 altos); perfil con hechos y fuente (JSON-LD); plan de 9 tareas; `GET /plans/:id/export` → 200 `text/markdown` |
| Confirmación humana del perfil de marca | PENDIENTE DE LA TITULAR | paso de revisión humana deliberado; se hace en la pantalla de Marca |

## IA — OpenRouter solo gratis + Workers AI ([detalle](OPENROUTER_INTEGRATION_STATUS.md))

| Funcionalidad | Estado | Prueba |
|---|---|---|
| Catálogo dinámico de OpenRouter (solo `:free` + `openrouter/free`, todos los precios = 0) | VERIFICADO EN PRODUCCIÓN | cron: `or_last_sync` 478 modelos revisados → 15 gratuitos guardados, 15 elegibles (13 verificados, 2 con fecha de fin) |
| Clave de OpenRouter en nivel gratuito y gasto 0 | VERIFICADO EN PRODUCCIÓN | `GET /api/v1/key` (desde el Worker): `is_free_tier: true`, `usage: 0`, límite gratuito 50/día → cuota de la app 45/día |
| Generación real con OpenRouter y coste 0 | VERIFICADO EN PRODUCCIÓN | Asesor → `baidu/ernie-5.5-flash-preview:free`, `reported_cost_usd = 0`, `cost_state = zero_confirmed`; el panel «Actividad de IA» muestra «0 USD (confirmado)»; uso facturado 0 |
| Modelos de pago bloqueados **antes** de enviar | VERIFICADO EN PRODUCCIÓN | 8 intentos → 422 (preferencia `openai/gpt-4o`, `gpt-4o-mini`, id falso `…:free`, `allowPaid`, inyección de `model`/`provider` en Asesor y Content, health-check admin de un modelo de pago); invocaciones antes = después (ninguna salió a la red) |
| Política FREE ONLY completa (402/401, coste > 0, router que sirve pago, 429, cuotas, concurrencia) | VERIFICADO SOLO EN LOCAL | `openrouter.test.ts` (37) + `ai-models.test.ts` (27); en producción no se provocan cobros ni 429 reales |
| Guardia de privacidad (datos sensibles solo en Workers AI) | VERIFICADO EN PRODUCCIÓN | pregunta con un DNI de ejemplo → `workers_ai` (gemma-4); registro `skipped sensitive_data:dni_nie` sin el valor; `privacy.test.ts` (17) |
| Modelos de razonamiento con margen de tokens | VERIFICADO EN PRODUCCIÓN | antes: ERNIE devolvía `truncated_empty` en artículos; tras el arreglo, contenido FAQ con ERNIE → 201, coste 0 confirmado |
| Centro de IA (estado, cuota, catálogo, estrategia, privacidad, actividad, panel de admin) | VERIFICADO SOLO EN LOCAL | `wrangler dev`: catálogo real de 15 modelos; sin desbordamiento en 375 px |
| Asesor: modelo servido, respaldo y «Usar respaldo automático» | VERIFICADO EN PRODUCCIÓN (modelo servido, respaldo automático) · LOCAL (botón «Usar respaldo») | `openrouter.test.ts` («manual model + policy ask») |
| Creative Studio (FLUX.1 schnell → R2 UE) | VERIFICADO EN PRODUCCIÓN | imagen generada en 3,5 s, 5 créditos, archivo servido en privado (`image/jpeg`, 786 KB, `cache-control: private`) |
| Gemini como último respaldo | NO EJERCITADO EN PRODUCCIÓN | secreto `GEMINI_API_KEY` presente (solo nombre comprobado); se omite en «privacidad primero» y en «solo Cloudflare» |

## F2 — Content Studio (nuevo)

| Funcionalidad | Estado | Prueba |
|---|---|---|
| Brief → borrador con IA (6 tipos), fuentes tratadas como DATOS, marcas [VERIFICAR] | VERIFICADO EN PRODUCCIÓN | `wrangler dev`: borrador real con Workers AI (Gemma 4); `content.test.ts` |
| Editor versionado con concurrencia optimista | VERIFICADO EN PRODUCCIÓN | dos guardados simultáneos → 200 + 409 `version_conflict` |
| Restaurar versión | VERIFICADO SOLO EN LOCAL | `content.test.ts` |
| Flujo borrador → revisión → aprobado, con auditoría | VERIFICADO EN PRODUCCIÓN (owner) · LOCAL (otros roles, devolver, archivar) | submit 200 → approve 200, estado `approved`, 2 versiones |
| Exportación MD/HTML saneado con aviso de borrador | VERIFICADO EN PRODUCCIÓN | borrador con «BORRADOR NO APROBADO»; aprobado: MD 200 sin aviso y con la edición, HTML 200 sin `<script>` |
| Revisión con IA (1 crédito) | VERIFICADO SOLO EN LOCAL | `content.test.ts` |
| Publicación en CMS | NO IMPLEMENTADO | requiere conectores de CMS del titular |

## F3 — Google Search Console (nuevo, [ADR 0010](adr/0010-search-console-solo-lectura.md))

| Funcionalidad | Estado | Prueba |
|---|---|---|
| Panel sin cuenta conectada: ausencia visible, ninguna cifra | VERIFICADO EN PRODUCCIÓN | `/app/o/…/search-console` (versión d5b448f0): «Sin cuenta de Search Console conectada… No estimamos ni inventamos clics» |
| OAuth de solo lectura y conexión | VERIFICADO EN PRODUCCIÓN | 2026-11-18: la titular concedió `webmasters.readonly` (antes, Google devolvió `403 access_denied` hasta añadirla como usuaria de prueba; la app de Google se publicó en producción el mismo día). Integración `connected`; auditoría `integration.connect` con la cuenta enmascarada |
| Token de actualización solo cifrado | VERIFICADO EN PRODUCCIÓN | `integration_secrets`: sobre `v1.` de 332 caracteres, sin forma de token de Google; la respuesta de `/search-console` no contiene ni el sobre ni ningún token |
| Propiedades permitidas | VERIFICADO EN PRODUCCIÓN | `sites.list` real: 4 propiedades `siteOwner`; ninguna se elige sola si hay varias; se eligió `https://dnigrowth.com/` (auditoría `integration.gsc_property_select`) |
| Sincronización (trabajo `gsc_sync`) | VERIFICADO EN PRODUCCIÓN | completado al primer intento en 5 s, 0 créditos, sin filas en el libro de créditos; Google devolvió **0 filas** del 2026-08-20 al 2026-11-17 (`dataState=final`) para dnigrowth.com, sitio recién añadido. El panel lo dice así, sin estimaciones |
| Panel con cifras (gráfico, tabla, consultas/páginas, comparación) | VERIFICADO SOLO EN LOCAL | `wrangler dev` con datos de prueba locales (`demo.example`, borrados después): gráfico de una sola serie con detalle al pasar el ratón, vista de tabla (58 días), sin desplazamiento horizontal en 375 px. En producción se verá cuando Google publique datos de la propiedad |
| Desconectar con revocación, `invalid_grant`, roles, aislamiento, cron diario | VERIFICADO SOLO EN LOCAL | `searchconsole.test.ts` (14): token nunca en claro en D1/auditoría/eventos, roles (editor/analista/lector 403), aislamiento entre organizaciones, sesión distinta y consentimiento parcial rechazados, `state` no reutilizable, `invalid_grant` → volver a conectar, cron diario idempotente, 0 créditos |

## F3 — Google Analytics 4 (nuevo, [ADR 0011](adr/0011-google-analytics-solo-lectura.md))

| Funcionalidad | Estado | Prueba |
|---|---|---|
| Migración 0009 (tablas `ga4_*`, índice de una conexión por organización) | VERIFICADO EN PRODUCCIÓN | aplicada el 2026-11-18 tras la copia `backups/dni-growth-db-pre-0009-20261118-1301.sql`; solo añade |
| Panel sin cuenta conectada: ausencia visible, ninguna cifra | VERIFICADO EN PRODUCCIÓN | `/app/o/…/analytics` (versión ab2bbe5a): «Sin cuenta de Google Analytics conectada… No estimamos ni inventamos visitas» |
| Inicio del OAuth de solo lectura | VERIFICADO EN PRODUCCIÓN (apertura) | «Conectar con Google» → `accounts.google.com` acepta la petición: `scope=openid email analytics.readonly`, `access_type=offline`, PKCE S256, callback `https://dnigrowth.com/api/v1/auth/google/callback`. Consentimiento pendiente de la titular |
| Conexión, token cifrado, propiedades permitidas, sincronización (diarios, totales por periodo, canales, páginas de entrada), umbrales/muestreo, desconectar con revocación, roles, aislamiento, cron | VERIFICADO SOLO EN LOCAL | `analytics.test.ts` (13): token nunca en claro, sobres intercambiados ilegibles, usuarios del periodo leídos de GA4 (no suma diaria), propiedad sin acceso no se elige ni se sincroniza, `invalid_grant` → volver a conectar, purga, 0 créditos |
| Política de privacidad: datos de usuario de Google y uso limitado | VERIFICADO EN PRODUCCIÓN (pendiente de revisión legal) | `https://dnigrowth.com/legal/privacidad` (versión bfe01bbc) muestra la sección «Datos de usuario de Google»: qué se lee con cada permiso, uso, cifrado, revocación y Limited Use; `llms.txt` lista Search Console y GA4 como disponibles |
| Search Console tras compartir el código con GA4 | VERIFICADO EN PRODUCCIÓN | versión bfe01bbc: `/search-console` 200, conexión `connected`, propiedad `https://dnigrowth.com/` conservada, sin token ni sobre en la respuesta |

## NO IMPLEMENTADO (fases siguientes)
Keywords con proveedor licenciado (F2), monitor de visibilidad IA (F3), Video Studio (F4), Landings y CRM (F5), Meta Ads con Spend Guardian (F6), experimentos (F7), agencia/white label, 2FA y SSO (F8), cobros con Stripe ([plan](STRIPE_PLAN.md)).

## Bloqueos que requieren al titular
| Bloqueo | Acción mínima |
|---|---|
| Confirmar el perfil de marca | Revisar los datos en la pantalla de Marca y confirmar |
| Search Console y Analytics para clientes | App de Google publicada en producción (2026-11-18) pero sin verificar: aviso de «app no verificada» y tope de 100 usuarios. Para quitarlo: solicitar en Google Auth Platform la verificación de `webmasters.readonly` y `analytics.readonly` (sin coste; Google pide un vídeo de demostración y la política de privacidad, ya actualizada) |
| Conectar Google Analytics | Pulsar «Conectar con Google» en Analytics, conceder el permiso de lectura y elegir la propiedad de DNI Growth (no la de otras marcas) |
| Stripe (cobros reales) | Modo prueba listo y verificado. Para cobrar: activar la cuenta «DNI Growth» (KYC), textos legales con datos fiscales, decidir IVA, guardar la clave `sk_live_…` con `wrangler secret put`, «Sincronizar» y `BILLING_ENABLED="true"` ([pasos](STRIPE_PLAN.md#3-antes-de-cobrar-dinero-real-decisión-de-la-titular)). La suscripción de prueba Starter queda con cancelación programada (sin dinero real) |
| Textos legales definitivos | Datos fiscales del titular |
