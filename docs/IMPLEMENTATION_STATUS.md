# Estado de implementación — DNI Growth

Última actualización: 2026-11-17 · Producción: https://dni-growth.ibraguimova19.workers.dev · versión `11831c6d-b194-4d2e-9810-d7631a9e0d1d` (Workers Paid, modelo Standard; ver [verificación de la cuenta](CLOUDFLARE_ACCOUNT_VERIFICATION.md)).

Leyenda:
- **VERIFICADO EN PRODUCCIÓN**: probado contra la URL pública con una respuesta comprobable.
- **VERIFICADO SOLO EN LOCAL**: tests automáticos y/o prueba manual en `wrangler dev`; en producción falta el paso indicado.
- **BLOQUEADO POR DOMINIO**: necesita un dominio propio.
- **BLOQUEADO POR PERMISOS**: necesita una acción, clave o aceptación del titular.
- **NO IMPLEMENTADO**.

Pruebas automáticas: `pnpm verify` → lint, typecheck, **144 tests** (71 de API: auth, OAuth, email, IA, tenancy, flujo F1 y billing), build y escaneo de secretos, todo en verde el 2026-11-17.

## F0 — Fundaciones

| Funcionalidad | Estado | Prueba |
|---|---|---|
| Monorepo pnpm, TS strict, Zod en fronteras | VERIFICADO SOLO EN LOCAL | `pnpm verify` |
| Registro, login, logout, bloqueo por fallos, rate limit | VERIFICADO EN PRODUCCIÓN (parcial) | prod: `POST /auth/login` sin CSRF → 403; `/auth/me` sin sesión → `user:null`; flujo completo en local |
| Verificación de email y reset de contraseña | BLOQUEADO POR DOMINIO | código y tests listos; en prod `/auth/options` → `emailDelivery: not_configured` y la UI lo dice sin enviar nada |
| **Email transaccional con Cloudflare Email Service** (binding `send_email`, outbox cifrado AES-GCM, reintentos con backoff, máx. 5 intentos → `dead`, idempotencia, purga del contenido) | VERIFICADO SOLO EN LOCAL · BLOQUEADO POR DOMINIO | `mail.test.ts` (11 tests: envío, sin texto plano en reposo, reintento, rechazo permanente, límite de intentos, idempotencia, concurrencia, manipulación del cifrado). Binding desplegado; envío off (`EMAIL_SENDING_ENABLED=false`) hasta incorporar un dominio. Resend eliminado del código |
| **Inicio de sesión y registro con Google** (OIDC + PKCE S256, state de un solo uso ligado a cookie, nonce, validación iss/aud/exp/email_verified, vinculación segura de cuentas) | VERIFICADO SOLO EN LOCAL · BLOQUEADO POR PERMISOS | `oauth.test.ts` (14 tests, incluida la toma de una cuenta prerregistrada). Proyecto «DNI Growth» creado en Google Cloud; falta aceptar la política de datos de Google, crear el cliente OAuth y guardar `GOOGLE_CLIENT_SECRET` |
| Organizaciones, invitaciones, 9 roles | VERIFICADO SOLO EN LOCAL | `tenancy.test.ts`, `flow.test.ts`, `mail.test.ts` (invitación por outbox) |
| Aislamiento multiempresa (FK compuestas, guard SQL estático, ahora también tablas de IA) | VERIFICADO SOLO EN LOCAL | `tenancy.test.ts`, `ai.test.ts` (conversaciones e imágenes de otro tenant → 404) |
| Límites por empresa: máx. 2 análisis simultáneos, 20 análisis/hora, cuotas IA | VERIFICADO SOLO EN LOCAL | `flow.test.ts` («at most 2 concurrent analyses»), `ai.test.ts` |
| Créditos: reserva atómica → liquidación + liberación; sin doble gasto concurrente | VERIFICADO SOLO EN LOCAL | `ai.test.ts` («concurrent requests cannot overspend») y prueba real en `wrangler dev` (ledger reserve/release/settle) |
| Stripe detrás de `BILLING_ENABLED=false` | VERIFICADO EN PRODUCCIÓN | prod: `POST /api/v1/webhooks/stripe` → 503 `billing_disabled` |
| Landing SEO/GEO/AEO, sitemap, robots, llms.txt | VERIFICADO EN PRODUCCIÓN | 200 en `/`, `/sitemap.xml`, `/robots.txt`, `/llms.txt` |
| Google Search Console | VERIFICADO EN PRODUCCIÓN | propiedad `https://dni-growth.ibraguimova19.workers.dev/` verificada (archivo HTML servido por el Worker); sitemap enviado, pendiente de primera lectura por Google |
| Cabeceras de seguridad (CSP, HSTS, XFO, nosniff) | VERIFICADO EN PRODUCCIÓN | `curl -I /app/login` |
| Configuración única de URL (`APP_ORIGIN` en `wrangler.jsonc` → cookies, OAuth, emails, sitemap) | VERIFICADO SOLO EN LOCAL | `vite.config.ts` lee `APP_ORIGIN`; `problem.type` usa URN (ningún dominio inventado) |
| CI en GitHub (lint, typecheck, tests, build, secret scan, audit) | VERIFICADO EN GITHUB | Actions run 44169626957 en verde (commit `85cfbbe`), añadido desde la web de GitHub |

## F1 — URL → análisis seguro → perfil de marca → plan

| Funcionalidad | Estado | Prueba |
|---|---|---|
| SSRF, robots.txt, 31 reglas, perfil de marca con fuentes, plan de 30 días | VERIFICADO SOLO EN LOCAL | `ssrf.test.ts`, `seo.test.ts`, `flow.test.ts` E2E; smoke real contra `https://example.com` |
| **F1 completo en producción** | **BLOQUEADO** | Requiere una cuenta verificada de forma legítima en producción. No se ha verificado ninguna cuenta editando la base de datos. Se desbloquea con Google (cliente OAuth) o con el dominio de email |

## IA (nuevo)

| Funcionalidad | Estado | Prueba |
|---|---|---|
| Asesor de crecimiento (chat con contexto de marca, auditoría y plan; datos de terceros tratados como DATOS) | VERIFICADO SOLO EN LOCAL con IA real | `ai.test.ts` (10 tests); en `wrangler dev` con Workers AI remoto: respuesta real de Gemma 4 y, ante fallo, respaldo automático a Mistral Small 3.1 |
| Respaldo automático Workers AI → OpenRouter (solo modelos `:free` a precio 0) → Gemini | VERIFICADO SOLO EN LOCAL · BLOQUEADO POR PERMISOS | tests con OpenRouter simulado (modelos de pago descartados, 429 → siguiente). Faltan `OPENROUTER_API_KEY` / `GEMINI_API_KEY` (opcionales) |
| Tope diario de gasto IA de la plataforma (0,10 USD ≈ asignación gratuita) | VERIFICADO SOLO EN LOCAL | test «respects the platform daily budget» |
| Creative Studio: imágenes FLUX.1 schnell → R2 (UE) servidas solo al tenant dueño | VERIFICADO SOLO EN LOCAL con IA real | imagen JPEG real de 662 KB en 3,4 s; 5 créditos liquidados; filtros de contenido |
| IA en producción con un usuario | BLOQUEADO | mismo motivo que F1: falta una cuenta verificada legítima. El endpoint responde 401 sin sesión (comprobado) |

## Responsive y botones
Comprobación automática de desbordamiento horizontal en 375 px (landing, legal, Command Center, Asesor, Creative, Facturación, Equipo, Integraciones, Nueva auditoría, Logs) y en 768 px: **0 desbordamientos**. Capturas en móvil del Asesor y del Creative Studio con imagen real. Módulos de fases futuras muestran «pronto» con descripción y sin datos inventados.

## NO IMPLEMENTADO (fases siguientes)
Content Studio + CMS (F2), keywords con proveedor licenciado (F2), Search Console/GA4 como fuente de datos dentro de la app y monitor de visibilidad IA (F3), Video Studio (F4), Landings y CRM (F5), Meta Ads con Spend Guardian (F6), experimentos (F7), agencia/white label, 2FA y SSO empresarial (F8), cobros con Stripe (ver [plan](STRIPE_PLAN.md)).

## Bloqueos que requieren al titular
| Bloqueo | Acción mínima |
|---|---|
| Dominio para email y marca | Comprar el dominio y añadirlo a Cloudflare; después: onboarding en Email Service, `MAIL_FROM`, `EMAIL_SENDING_ENABLED=true`, `APP_ORIGIN` |
| Google sign-in | Aceptar la política de datos de Google en el proyecto «DNI Growth», crear el cliente OAuth y ejecutar `npx wrangler secret put GOOGLE_CLIENT_SECRET` |
| OpenRouter / Gemini (opcionales) | `npx wrangler secret put OPENROUTER_API_KEY` y/o `GEMINI_API_KEY` |
| Stripe | Decidir activarlo (ver `STRIPE_PLAN.md`) |
| Textos legales definitivos | Datos fiscales del titular |
