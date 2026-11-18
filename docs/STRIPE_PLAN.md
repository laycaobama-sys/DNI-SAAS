# Cobros con Stripe: estado, cómo funciona y cuánto cuesta

Cuenta de Stripe: **«DNI Growth»** (separada de «RestoPanel», decisión de la titular del 2026-11-18). Hoy se trabaja en su **entorno de prueba**: nadie paga dinero real.

## 1. Cómo funciona (implementado y desplegado)
| Pieza | Qué hace |
|---|---|
| Clave | `STRIPE_SECRET_KEY` solo en los secretos de Cloudflare (la guarda la titular con `wrangler secret put`). Nunca se muestra ni se registra. |
| Modo | `sk_test_…` → **solo administradores de la plataforma** pueden abrir el pago (prueba en producción sin que el público vea un pago ficticio). `BILLING_ENABLED="true"` → pagos abiertos a todos. `sk_live_…` sin `BILLING_ENABLED` → nada se puede cobrar. |
| Catálogo | Botón «Sincronizar productos, precios y portal» (Facturación → panel de administración) o `POST /api/v1/admin/billing/stripe/sync`: crea productos con id fijo (`dni_growth_<plan>`), precios mensuales en EUR sin IVA con `lookup_key`, y el **portal de cliente**. Idempotente: repetirlo no duplica nada; si cambia un precio, crea uno nuevo y archiva el anterior (los clientes actuales conservan su precio). |
| Webhook | La sincronización registra `https://dnigrowth.com/api/v1/webhooks/stripe` (eventos `checkout.session.completed`, `customer.subscription.created/updated/deleted`). Su secreto de firma, que Stripe entrega una sola vez, se guarda **cifrado** (AES-256-GCM con `DATA_ENC_KEY`) y nunca sale del servidor. Si la titular prefiere su propio endpoint, basta con `STRIPE_WEBHOOK_SECRET` y la plataforma no crea otro. |
| Checkout | Stripe Checkout en español, dirección de facturación y NIF-IVA, códigos promocionales, email del usuario. **Una sola suscripción por organización** (409 si ya existe: los cambios van por el portal). |
| Portal | «Gestionar suscripción»: cambiar de plan, tarjeta, facturas, cancelar al final del periodo. Si hay una cancelación programada, la app la muestra con la fecha en que se pasa a Free. |
| Webhooks | Firma verificada sobre el cuerpo crudo, cada evento se procesa una vez, se ignoran eventos de modo cruzado (real/prueba) y eventos antiguos que llegan tarde; el plan se deduce del precio contratado; `past_due`/impago → plan Free hasta que se pague; créditos del plan una sola vez por mes. |
| Pruebas | `apps/api/test/stripe.test.ts` (11) + `flow.test.ts` (4). En producción (entorno de prueba, 2026-11-18): pago con 4242, créditos una sola vez, 409 en el segundo checkout, portal, cancelar/renovar/cancelar reflejado en la app. |

## 2. Lo que cuesta Stripe (sin cuota mensual)
Stripe no cobra alta ni mensualidad: solo una comisión por cada pago. Tarifas públicas orientativas para España (compruébalas en stripe.com/es/pricing al activar):

| Concepto | Comisión aproximada | Ejemplo Starter (39 €) |
|---|---|---|
| Tarjeta europea estándar | 1,5 % + 0,25 € | 0,84 € |
| Tarjeta del Reino Unido | 2,5 % + 0,25 € | 1,23 € |
| Tarjeta internacional | ~3,25 % + 0,25 € | 1,52 € |
| Stripe Billing (suscripciones) | ~0,7 % | 0,27 € |
| Stripe Tax (opcional, **no activado**) | ~0,5 % | 0,20 € |

## 3. Antes de cobrar dinero real (decisión de la titular)
1. Activar la cuenta «DNI Growth» en Stripe (datos fiscales y bancarios, KYC) — solo la titular.
2. Textos legales definitivos con datos fiscales: condiciones de contratación, cancelación y reembolso (hoy el portal enlaza `/legal/privacidad` y `/legal/aviso-legal`, que son borradores).
3. IVA: decidir Stripe Tax o gestor (hoy los precios son «sin IVA» y Stripe Tax no está activado).
4. Guardar la clave real: `npx wrangler secret put STRIPE_SECRET_KEY` con `sk_live_…`, pulsar «Sincronizar» (crea el catálogo y el webhook reales) y, solo entonces, `BILLING_ENABLED="true"` en `wrangler.jsonc` + despliegue.

## 4. Estrategia comercial sugerida (sin presupuesto)
- Auditoría gratuita (Free: 3/mes) como gancho; Asesor IA e imágenes consumen créditos.
- Empezar mostrando Starter (39 €) y Growth (89 €); Pro y Agency bajo petición.
- Servicio «hecho por ti» (auditoría + plan explicado en una llamada) como ingreso rápido.
- Garantía de 14 días en el primer mes (reembolso con un clic en Stripe).

Ninguna cifra de ventas está garantizada: precios orientativos (`migrations/0003_seed_plans.sql`) y comisiones públicas que pueden cambiar.
