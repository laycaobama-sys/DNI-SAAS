# Cobros con Stripe: estado, cómo funciona y cuánto cuesta

Última revisión: 2026-11-24. Decisiones de diseño en [ADR 0022](adr/0022-cobros-v2.md); lo que queda para la titular (abogado e IVA) en [BLOQUEOS.md §2–§3](BLOQUEOS.md).

## Estado

| Pieza | Estado | Prueba |
|---|---|---|
| Cuenta real **DNI Growth-IA** (`acct_1TnSMAJepRhBoIxa`) | Activa: pagos y payouts activos, sin tareas pendientes | Panel de Stripe → Estado de la cuenta, 2026-11-23 |
| Productos antiguos de RestoPanel en esa cuenta | Archivados (0 suscripciones) | Catálogo de productos → «Archivados» |
| Webhooks antiguos hacia resto-panel.com | Deshabilitados | Workbench → Webhooks → «Deshabilitado» |
| Datos públicos (nombre, extracto, web, soporte) | DNI Growth / «DNI GROWTH» / dnigrowth.com | Configuración → Datos de la empresa |
| URL legales que muestra Stripe | Redirigen con 301 a `/legal/condiciones`, `/legal/privacidad` y `/#contacto` | `curl -I https://dnigrowth.com/terminos-y-condiciones` → 301 |
| Clave en el Worker | **Real** (cuenta «DNI Growth-IA»), guardada por la titular con `wrangler secret put` el 2026-11-23 | Ajuste `stripe_account_live`: `chargesEnabled: true`, `detailsSubmitted: true` (22:35 UTC) |
| Catálogo en modo real | 4 planes × mensual y anual, cupón, portal (`bpc_…`) y webhook firmado (9 eventos) sincronizados solos por el cron | Ajustes `stripe_catalog_signature_live`, `stripe_portal_config_live` y `stripe_webhook_endpoint_live` → `https://dnigrowth.com/api/v1/webhooks/stripe`, 2026-11-23 22:35 UTC |
| IVA en modo real | Stripe Tax automático (la cuenta lo tiene activo; ~0,5 % por cobro) | `stripe_tax_mode_live = automatic`. Para pasar al 21 % fijo: desactivar Stripe Tax y pulsar «Sincronizar» ([BLOQUEOS §3](BLOQUEOS.md)) |
| Pagos para el público | **Abiertos** | `GET /api/v1/public/pricing-status` → `{"paymentsOpen":true}` (2026-11-24) |
| Primer cobro real | Sin datos todavía | No se usan tarjetas de prueba en producción |
| Catálogo en modo prueba | 4 planes × mensual y anual, cupón, portal y webhook (9 eventos) sincronizados | `POST /api/v1/admin/billing/stripe/sync` → 200; auditoría `platform.stripe_catalog_sync` 2026-11-23 17:32 |
| Pago en modo prueba | Stripe Checkout abre con el precio correcto (Growth anual 1.296 €, 108 €/mes, IVA según dirección) | 3 sesiones creadas por la administradora en la organización «PRUEBA Stripe planes (modo test)»; ninguna pagada |

## Planes (precios sin IVA)

| Plan | Mensual | Anual (2 meses gratis) | Prueba | Garantía 90 días |
|---|---|---|---|---|
| Free | 0 € | — | — | — |
| Starter | 49 € | 492 € (41 €/mes) | — | — |
| Growth | 129 € | 1.296 € (108 €/mes) | 7 días | Sí |
| Pro | 249 € | 2.496 € (208 €/mes) | — | Sí |
| Agency | 449 € | 4.488 € (374 €/mes) | — | Sí |

Fuente única: `packages/core/src/pricing.ts` (web pública, /precios, JSON-LD, app y Stripe salen de ahí).

## Cómo funciona

| Pieza | Qué hace |
|---|---|
| Clave | `STRIPE_SECRET_KEY` solo en los secretos de Cloudflare. Nunca se muestra ni se registra. |
| Acceso | `BILLING_ENABLED="auto"`: con clave de prueba solo las administradoras de la plataforma pueden abrir el pago; con clave real el pago se abre al público **solo** cuando Stripe confirma `charges_enabled`. Estado público en `GET /api/v1/public/pricing-status`. |
| Sincronización automática | El cron, en el minuto siguiente a guardar una clave (y cada hora si cambian precios o eventos), crea o actualiza productos `dni_growth_<plan>` («DNI Growth · Plan X»), precios por `lookup_key` (mensual y anual), IVA, cupón de retención, portal de cliente y webhook firmado (secreto cifrado en D1). Idempotente: no duplica nada; un precio nuevo archiva el anterior y los clientes conservan el suyo. |
| IVA | Stripe Tax si la cuenta lo tiene activo; si no, tipo fijo IVA España 21 % creado por la plataforma. Precios con IVA aparte. |
| Checkout | Stripe Checkout en español, aceptación de condiciones obligatoria (versión guardada), dirección y NIF-IVA. Una suscripción por organización; la prueba de 7 días solo una vez por organización. |
| Portal | Cambiar de plan o de periodo (las subidas al momento con prorrateo, las bajadas al final del periodo), tarjeta, facturas y cancelación al final del periodo. |
| Retención honesta | Pausa de 1 a 3 meses, oferta del 30 % durante 2 meses solo si el motivo es el precio y una sola vez, bajada de plan; cancelar siempre a un clic. |
| Impagos | 7 días de gracia con el plan intacto; después Free sin borrar nada; se recupera al pagar. |
| Red de seguridad | Una suscripción cancelada al final del periodo pasa a Free 2 días después aunque no llegue el aviso de Stripe. |
| Webhooks | Firma verificada sobre el cuerpo crudo, cada evento una sola vez, se ignoran los de otro modo (real/prueba) y los antiguos que llegan tarde. |
| Pruebas | `apps/api/test/stripe.test.ts` (25), `billing` web (5), `pricing` core y web. |

## Lo que cuesta Stripe (sin cuota mensual)

Solo comisión por pago (tarifas públicas orientativas para España; compruébalas en stripe.com/es/pricing):

| Concepto | Comisión aproximada | Ejemplo Growth mensual (129 €) |
|---|---|---|
| Tarjeta europea estándar | 1,5 % + 0,25 € | 2,19 € |
| Stripe Billing (suscripciones) | ~0,7 % | 0,90 € |
| Stripe Tax (opcional) | ~0,5 % | 0,65 € |

Margen detallado en [ECONOMIA.md](ECONOMIA.md).
