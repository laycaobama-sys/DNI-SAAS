# Estado de implementación — DNI Growth

Última actualización: 2026-11-18 · Producción: **https://dnigrowth.com** (Worker `dni-growth`, versión `286b5a81-6ead-4114-928f-a566e48c4718`; workers.dev redirige con 301 a dnigrowth.com) · Workers Paid, sin servicios de pago adicionales ([verificación de la cuenta](CLOUDFLARE_ACCOUNT_VERIFICATION.md)).

Leyenda:
- **VERIFICADO EN PRODUCCIÓN**: probado contra la URL pública con una respuesta comprobable.
- **VERIFICADO SOLO EN LOCAL**: tests automáticos y/o prueba manual en `wrangler dev`; en producción falta el paso indicado.
- **BLOQUEADO POR PERMISOS**: necesita una acción, clave o aceptación del titular.
- **NO IMPLEMENTADO**.

Pruebas automáticas: lint, typecheck, **210 tests** (100 core + 110 API), build y escaneo de secretos en verde el 2026-11-18.

## Dominio, correo y plataforma

| Funcionalidad | Estado | Prueba |
|---|---|---|
| Dominio `dnigrowth.com` + `www` como dominios personalizados del Worker (TLS automático) | VERIFICADO EN PRODUCCIÓN | `wrangler deploy` → `dnigrowth.com (custom domain)`, `www.dnigrowth.com (custom domain)`; `GET /api/v1/health` → 200 `environment: production` |
| `www` → apex 301 (regla de redirección gratuita, conserva ruta y query) | VERIFICADO EN PRODUCCIÓN | `curl https://www.dnigrowth.com/legal/privacidad?x=1` → 301 `https://dnigrowth.com/legal/privacidad?x=1` |
| workers.dev → dnigrowth.com (páginas de la app y login con Google) | VERIFICADO EN PRODUCCIÓN | `/app/login` en workers.dev → 301 a dnigrowth.com |
| Email Sending (DKIM `cf-bounce`, return-path, DMARC `p=reject`) | VERIFICADO EN PRODUCCIÓN | `POST /auth/resend-verification` al titular → outbox `accepted` por `cloudflare_email` con `provider_message_id`. «accepted» ≠ entregado: la llegada al buzón la confirma el titular |
| Email Routing hola@/soporte@/privacidad@/facturacion@ → buzón del titular | VERIFICADO EN PRODUCCIÓN | reglas activas en el panel de Cloudflare |
| Tope mensual de emails (`EMAIL_MONTHLY_CAP=2500` < 3.000 incluidos) | VERIFICADO SOLO EN LOCAL | `mail.ts` devuelve `monthly_cap_reached` sin enviar |
| Search Console `https://dnigrowth.com/` | VERIFICADO EN PRODUCCIÓN (propiedad) · PENDIENTE DE GOOGLE (sitemap) | propiedad verificada automáticamente con el archivo HTML; sitemap enviado el 2026-11-18. Googlebot obtiene `/sitemap.xml` con 200 y `application/xml`; Search Console muestra «No se ha podido obtener» justo tras el envío, pendiente de su lectura real |
| Migración D1 0005 (aditiva) con copia previa | VERIFICADO EN PRODUCCIÓN | `backups/dni-growth-db-pre-0005-20261118-0019.sql`; `wrangler d1 migrations apply --remote` ✅ |

## F0 — Fundaciones

| Funcionalidad | Estado | Prueba |
|---|---|---|
| Monorepo pnpm, TS strict, Zod en fronteras (entradas de IA estrictas: no admiten `model`, `provider` ni precios) | VERIFICADO SOLO EN LOCAL | `pnpm verify` |
| Registro, login, logout, bloqueo por fallos, rate limit | VERIFICADO EN PRODUCCIÓN (parcial) | prod: CSRF → 403, `/auth/me` sin sesión → `user:null`; flujo completo en local |
| Verificación de email | VERIFICADO EN PRODUCCIÓN (envío) | email de verificación aceptado por Cloudflare; falta que el titular pulse el enlace |
| **Inicio de sesión con Google** (OIDC + PKCE S256, nonce, vinculación segura) | BLOQUEADO POR PERMISOS | cliente OAuth «DNI Growth Web» creado (`GOOGLE_CLIENT_ID` desplegado). Falta `npx wrangler secret put GOOGLE_CLIENT_SECRET` por el titular |
| Organizaciones, invitaciones, roles, aislamiento multiempresa | VERIFICADO SOLO EN LOCAL | `tenancy.test.ts` (guard SQL estático ampliado a `content_items`, `content_versions`, `organization_ai_preferences`) |
| Créditos con reserva → liquidación/liberación | VERIFICADO SOLO EN LOCAL | `ai.test.ts`, `content.test.ts` |
| Stripe detrás de `BILLING_ENABLED=false` | VERIFICADO EN PRODUCCIÓN | webhook → 503 `billing_disabled` |
| Cabeceras de seguridad (CSP, HSTS, XFO, nosniff) | VERIFICADO EN PRODUCCIÓN | `curl -I https://dnigrowth.com/` |

## F1 — URL → análisis → marca → plan

| Funcionalidad | Estado | Prueba |
|---|---|---|
| SSRF, robots.txt, 31 reglas, perfil de marca, plan de 30 días | VERIFICADO SOLO EN LOCAL | `ssrf.test.ts`, `seo.test.ts`, `flow.test.ts` |
| **F1 completo en producción** | BLOQUEADO POR PERMISOS | la cuenta del titular existe pero no está verificada; se desbloquea al pulsar el enlace del email (ya enviado) o con Google. No se verifica ninguna cuenta editando la base de datos |

## IA — OpenRouter solo gratis + Workers AI ([detalle](OPENROUTER_INTEGRATION_STATUS.md))

| Funcionalidad | Estado | Prueba |
|---|---|---|
| Catálogo dinámico de OpenRouter (solo `:free` + `openrouter/free`, todos los precios = 0) | VERIFICADO EN PRODUCCIÓN | cron: `or_last_sync` 478 modelos revisados → 15 gratuitos guardados, 15 elegibles (13 verificados, 2 con fecha de fin) |
| Clave de OpenRouter en nivel gratuito y gasto 0 | VERIFICADO EN PRODUCCIÓN | `GET /api/v1/key` (desde el Worker): `is_free_tier: true`, `usage: 0`, límite gratuito 50/día → cuota de la app 45/día |
| Política FREE ONLY (rechazo antes de llamar, `max_price = 0`, parada global ante coste/402/401/modelo no verificable, cuotas atómicas) | VERIFICADO SOLO EN LOCAL | `openrouter.test.ts` (33) + `ai-models.test.ts` (27). Generación real en producción pendiente de una sesión de usuario |
| Centro de IA (estado, cuota, catálogo, estrategia, privacidad, actividad, panel de admin) | VERIFICADO SOLO EN LOCAL | `wrangler dev`: catálogo real de 15 modelos; sin desbordamiento en 375 px |
| Asesor: modelo servido, respaldo y «Usar respaldo automático» | VERIFICADO SOLO EN LOCAL | `openrouter.test.ts` («manual model + policy ask») |
| Creative Studio (FLUX.1 schnell → R2 UE) | VERIFICADO SOLO EN LOCAL con IA real | sin cambios |
| Gemini como último respaldo | BLOQUEADO EN PRODUCCIÓN HASTA SESIÓN | secreto `GEMINI_API_KEY` presente (solo nombre comprobado); se omite en «privacidad primero» y en «solo Cloudflare» |

## F2 — Content Studio (nuevo)

| Funcionalidad | Estado | Prueba |
|---|---|---|
| Brief → borrador con IA (6 tipos), fuentes tratadas como DATOS, marcas [VERIFICAR] | VERIFICADO SOLO EN LOCAL con IA real | `wrangler dev`: borrador real con Workers AI (Gemma 4); `content.test.ts` |
| Editor versionado con concurrencia optimista, restaurar versión | VERIFICADO SOLO EN LOCAL | `content.test.ts` (dos guardados simultáneos → 200 + 409) |
| Flujo borrador → revisión → aprobado/devuelto → archivado, con auditoría y permisos | VERIFICADO SOLO EN LOCAL | `content.test.ts`; prueba local submit → approve |
| Revisión con IA (1 crédito) y exportación MD/HTML saneado con aviso de borrador | VERIFICADO SOLO EN LOCAL | `content.test.ts`; exportación local sin `<script>` |
| Publicación en CMS | NO IMPLEMENTADO | requiere conectores de CMS del titular |

## NO IMPLEMENTADO (fases siguientes)
Keywords con proveedor licenciado (F2), Search Console/GA4 dentro de la app y monitor de visibilidad IA (F3), Video Studio (F4), Landings y CRM (F5), Meta Ads con Spend Guardian (F6), experimentos (F7), agencia/white label, 2FA y SSO (F8), cobros con Stripe ([plan](STRIPE_PLAN.md)).

## Bloqueos que requieren al titular
| Bloqueo | Acción mínima |
|---|---|
| Verificar la cuenta de producción | Abrir el email «Verifica tu correo en DNI Growth» y pulsar el enlace |
| Google sign-in | `npx wrangler secret put GOOGLE_CLIENT_SECRET` (desde `apps/api`) con el secreto del cliente «DNI Growth Web» |
| Prueba real de generación gratuita | Iniciar sesión en dnigrowth.com en el navegador integrado para lanzar 1 solicitud y comprobar coste 0 |
| Stripe | Decisión de activarlo; las claves las guarda el titular con `wrangler secret put` |
| Textos legales definitivos | Datos fiscales del titular |
