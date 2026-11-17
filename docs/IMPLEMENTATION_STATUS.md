# Estado de implementación — DNI Growth

Última actualización: 2026-11-17 · Despliegue: https://dni-growth.ibraguimova19.workers.dev (versión `1c8ad460`)

Leyenda: **REAL** = funciona y está probado · **PARCIAL** = funciona con límites declarados · **BLOQUEADO** = requiere credencial o aprobación externa · **PENDIENTE** = no implementado.

## F0 — Fundaciones

| Funcionalidad | Estado | Prueba |
|---|---|---|
| Monorepo pnpm (web, api, core), TS strict, Zod en fronteras | REAL | `pnpm typecheck`, `pnpm lint` en verde |
| Registro, verificación de email, login, logout, reset de contraseña | REAL (envío de email BLOQUEADO en prod) | `auth.test.ts` (10 tests); smoke local completo en navegador |
| Sesiones seguras, bloqueo por fallos, rate limiting, CSRF | REAL | `auth.test.ts`; prod: POST sin cabecera CSRF → 403 |
| Organizaciones, membresías, invitaciones, 9 roles + matriz de permisos | REAL | `tenancy.test.ts` (RBAC por rol), `flow.test.ts` (billing_admin no puede auditar) |
| Aislamiento multiempresa (FKs compuestas, guard SQL estático, IDOR) | REAL | `tenancy.test.ts`; ADR 0003 |
| Registro de auditoría inmutable con redacción de PII/secretos | REAL | trigger append-only probado; `security.test.ts` (redacción) |
| Trabajos en cola con outbox, reintentos, DLQ, cancelación, idempotencia | REAL | `flow.test.ts` (duplicados, backoff→DLQ, cancelación, Idempotency-Key); smoke local con Queues de miniflare |
| Créditos con reserva/liquidación/liberación y cuotas por plan | REAL | `flow.test.ts` (cuotas, liberación al fallar/cancelar) |
| Stripe checkout + webhooks firmados idempotentes | PARCIAL → BLOQUEADO | código y tests con firma real HMAC; sin claves devuelve 503 `provider_not_configured` |
| Landing SEO/GEO/AEO (JSON-LD, sitemap, robots, llms.txt) | REAL | prod: `/`, `/sitemap.xml`, `/robots.txt`, `/llms.txt` → 200 |
| Cabeceras de seguridad (CSP, HSTS, XFO, nosniff) | REAL | prod: `curl -I /app/` |
| CI (lint, typecheck, test, build, secret scan, audit) | REAL (aún no ejecutado en GitHub) | `.github/workflows/ci.yml`; local `pnpm verify` |

## F1 — Flujo 1: URL → análisis seguro → perfil de marca → plan priorizado

| Funcionalidad | Estado | Prueba |
|---|---|---|
| Validación SSRF (esquemas, puertos, IP literales en todas sus formas, DNS→IP privada, redirecciones) | REAL | `ssrf.test.ts`; `flow.test.ts` (DNS privado, redirección interna) |
| Rastreo público respetando robots.txt, sitemap del mismo origen, límites de páginas/tiempo/tamaño | REAL | `flow.test.ts` E2E; smoke local real contra `https://example.com` (completado, salud 71/100, 11 hallazgos) |
| 31 reglas técnicas SEO/GEO/AEO con evidencia por URL y priorización | REAL | `seo.test.ts` |
| Perfil de marca con fuente y confianza por dato; edición y confirmación humana | REAL | `flow.test.ts`; smoke local en navegador |
| Plan de 30 días editable (estado/semana), tareas bloqueadas honestas, export MD/JSON | REAL | `flow.test.ts`; smoke local |
| Dashboard con métricas que declaran fuente, tipo de medición y fecha; módulos no conectados = «no disponible» | REAL | smoke local escritorio y móvil |
| Rastreo en producción | PARCIAL — no verificado | requiere una cuenta verificada en prod (email bloqueado). Riesgo: límite de 10 ms de CPU del plan Workers Free (ADR 0002) |

## Pendiente (fases siguientes del backlog)
Content Studio y CMS (F2), keywords con proveedor licenciado (F2), Search Console/GA4 y monitor de visibilidad IA (F3), Creative/Video Studio (F4), Landings y CRM (F5), Meta Ads con Spend Guardian (F6), experimentos y atribución (F7), agencia/white label, 2FA y SSO (F8). En la app aparecen como «pronto» con su descripción y sin datos de ejemplo.

## Bloqueado por credenciales o aprobaciones externas
| Qué | Necesita |
|---|---|
| Envío de emails en producción | Clave de Resend + dominio remitente verificado (`RESEND_API_KEY`, `MAIL_FROM`) |
| Cobros | Cuenta Stripe: `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` y `stripe_price_id` por plan |
| Dominio propio | Dominio en Cloudflare para la ruta del Worker (cambiar `APP_ORIGIN` y `SITE_URL`) |
| Datos de Google | App OAuth de Google Cloud (Search Console/GA4) |
| Meta Ads / Google Ads | App de Meta con revisión (`ads_management`) / developer token de Google Ads |
| Textos legales definitivos | Datos fiscales del titular para `/legal/*` (hoy son borradores con marcadores) |
