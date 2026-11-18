# Estado de implementación — DNI Growth

Última actualización: 2026-11-18 · Producción: **https://dnigrowth.com** (Worker `dni-growth`, versión `88123eb7-3969-4089-9d66-92914ebe3c83`; workers.dev redirige con 301 a dnigrowth.com) · Workers Paid, sin servicios de pago adicionales ([verificación de la cuenta](CLOUDFLARE_ACCOUNT_VERIFICATION.md)).

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
| Stripe: checkout de prueba | VERIFICADO EN PRODUCCIÓN (apertura) | «Contratar este plan» (Starter) → Stripe Checkout del entorno de prueba «Suscribirse a DNI Growth Starter 39,00 € por mes». Pago con tarjeta de prueba pendiente de la titular |
| Stripe: una suscripción por organización, plan según precio, eventos antiguos/cruzados ignorados, past_due → Free | VERIFICADO SOLO EN LOCAL | `stripe.test.ts` (11) |
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

## NO IMPLEMENTADO (fases siguientes)
Keywords con proveedor licenciado (F2), Search Console/GA4 dentro de la app y monitor de visibilidad IA (F3), Video Studio (F4), Landings y CRM (F5), Meta Ads con Spend Guardian (F6), experimentos (F7), agencia/white label, 2FA y SSO (F8), cobros con Stripe ([plan](STRIPE_PLAN.md)).

## Bloqueos que requieren al titular
| Bloqueo | Acción mínima |
|---|---|
| Confirmar el perfil de marca | Revisar los datos en la pantalla de Marca y confirmar |
| Stripe | Crear la cuenta «DNI Growth» en Stripe (decidido: no usar «RestoPanel»); después se configura en modo prueba y la titular guarda `STRIPE_SECRET_KEY` y `STRIPE_WEBHOOK_SECRET` con `wrangler secret put`. `BILLING_ENABLED=false` hasta su autorización |
| Textos legales definitivos | Datos fiscales del titular |
