# Arquitectura de DNI Growth

Mapa del repositorio para quien llega nuevo. El detalle de cada decisión está en `docs/adr/`.

## Vista general

```
Navegador ──► dnigrowth.com (Cloudflare, dominio propio del Worker «dni-growth»)
               │
               ├─ Recursos estáticos (apps/web/dist): landing, /precios, /seguridad, /blog, legales y la SPA /app
               │     (el Worker se ejecuta antes en las rutas de la lista run_worker_first de wrangler.jsonc)
               │
               └─ Worker Hono (apps/api/src)
                    ├─ /api/v1/*  API REST (Zod en las fronteras, CSRF, sesiones HttpOnly, RBAC por organización)
                    ├─ /blog, /sitemap.xml, /llms.txt     renderizados en el Worker desde D1
                    ├─ queue consumer «dni-growth-jobs»   rastreos, IA, envíos (reintentos y cola de mensajes fallidos)
                    └─ cron cada minuto                   outbox, recuperación de trabajos, muestreo GEO,
                                                          auto-sincronización con Stripe y mantenimiento de cobros
```

| Recurso | Uso |
|---|---|
| D1 `dni-growth-db` (jurisdicción UE) | Todos los datos. Cada registro de cliente lleva `organization_id`. |
| R2 `dni-growth-media` (UE, privado) | Imágenes y vídeos generados, servidos solo por rutas con comprobación de organización. |
| Queues | Trabajos de fondo idempotentes. |
| Workers AI más OpenRouter, Groq y Gemini gratuitos | IA con tope de gasto diario (`AI_DAILY_BUDGET_USD`). |
| Email Service | Correos transaccionales con tope mensual. |
| Stripe | Cobros: Checkout, portal, webhooks firmados. |

## Paquetes

| Carpeta | Contenido |
|---|---|
| `packages/core` | Lógica pura y compartida, sin E/S: contratos Zod (`contracts.ts`), RBAC, reglas SEO y GEO, defensa SSRF, cifrado AEAD, catálogo comercial (`pricing.ts`), módulos por plan (`plan-access.ts`), estado de cada funcionalidad (`features.ts`). |
| `apps/api` | Worker: rutas en `src/routes/*`, servicios en `src/lib/*`, trabajos en `src/jobs`, migraciones SQL en `migrations/`, tests de integración con D1 local (Miniflare) en `test/`. |
| `apps/web` | Vite + React 19 + Tailwind 4. Contiene la landing y las páginas públicas en HTML estático (`index.html`, `legal/*.html`, …) y la SPA en `src/app/*`. |
| `scripts/` | Utilidades de la titular, como `platform-claim.mjs`. |
| `docs/` | Estado, ADR, guías de la titular, runbook y plan. |

## Reglas transversales

- **Multiempresa:** cada consulta filtra por `organization_id`. El acceso se comprueba con RBAC (`requireOrgPermission`) y hay tests entre empresas.
- **Efectos externos** (publicar, gastar, enviar, cobrar, borrar): autorización, auditoría (`audit_logs`), clave de idempotencia y, si procede, *outbox*.
- **Métricas:** cada una indica fuente, fecha de observación, periodo y tipo (observada, derivada, estimada o demo).
- **Contenido de terceros:** las páginas rastreadas y las respuestas de IA son datos, nunca instrucciones.
- **Secretos:** se guardan con `wrangler secret put`. Los secretos de terceros (webhook de Stripe, tokens OAuth) van cifrados con `DATA_ENC_KEY`.

## Cobros (resumen; detalle en ADR 0022)

```
pricing.ts ──► migración 0019 (plans) ──► cron: maybeAutoSyncStripe ──► Stripe: productos, precios, IVA, cupón, portal, webhook
                                                                            │
App /o/:org/billing ──► POST /billing/checkout {plan, intervalo, acceptTerms} ──► Stripe Checkout
                                                                            │
Stripe ──► POST /api/v1/webhooks/stripe (firma verificada, idempotente) ──► subscriptions y organizations.plan_code
cron ──► billingMaintenance: fin del periodo de gracia → Free; recordatorios de fin de prueba
```

## Calidad

- `pnpm.cmd -s verify` ejecuta lint, typecheck, los tests (core, api, web), el build y el escaneo de secretos.
- `pnpm.cmd -s deploy` hace el build web y `wrangler deploy`.
- Antes de cada migración: copia de D1 (`wrangler d1 export … --output ../../../backups/…`). Las migraciones siempre son aditivas.
