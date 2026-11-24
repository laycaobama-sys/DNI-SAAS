# ADR 0024 — Cada plan abre lo que vende /precios y reconciliación de cobros con Stripe

- Fecha: 2026-11-24
- Estado: aceptada
- Contexto: con los pagos reales abiertos, un cliente debe recibir exactamente lo que paga, y un pago no puede quedarse sin plan porque se pierda un aviso de Stripe. Antes de este cambio, la tabla de `/precios` y la matriz de módulos (`MODULE_MIN_PLAN`) no coincidían en algunos puntos: Free vendía «Visibilidad en IA» y Starter vendía Analytics, enlaces y vídeo que la API solo abría desde Growth.

## Decisión

1. **Una sola verdad comprobada por pruebas.** `packages/core/test/plan-access.test.ts` recorre cada fila de `PRICING_ROWS` que corresponde a un módulo y exige que `planIncludes(plan, módulo)` sea `true` si la celda vende algo y `false` si dice «—», y que ningún plan superior tenga menos que uno inferior. `apps/api/test/plan-modules.test.ts` exige que los límites de `plans.limits_json` sean al menos lo que vende la tabla y que los precios coincidan con `PLAN_OFFERS`. Si alguien cambia la tabla o la matriz sin cambiar la otra, las pruebas fallan.
2. **Matriz ajustada a lo publicado** (sin tocar precios ni límites numéricos):
   - Content Studio en todos los planes; Free con 1 artículo con IA al mes (`articlesPerMonth`).
   - Desde Starter: SEO técnico, keywords, visibilidad en IA, landings, informes, enlaces, vídeo y Google Analytics.
   - Desde Growth: estudio creativo, automatizaciones y atribución. Pro: anuncios. Agency: modo agencia.
   - `/precios` separa «Google Search Console (solo lectura)» (todos los planes) y «Google Analytics 4 (solo lectura)» (desde Starter); «Visibilidad en IA» ya no figura en Free.
3. **El plan solo se abre si Stripe confirma el pago.** En `checkout.session.completed`: `payment_status = paid` → activo; `no_payment_required` → prueba (`trialing`); cualquier otro (p. ej. adeudo bancario pendiente) → `incomplete`, sin abrir el plan hasta que llegue `customer.subscription.updated` con `active`. Si el aviso de la suscripción llegó antes, se conserva su estado (una prueba nunca se muestra como pagada).
4. **Reconciliación con Stripe** (`reconcileStripe`), solo lecturas (GET), idempotente:
   - Checkouts de las últimas 48 h (id `cs_…` guardado en la auditoría `billing.checkout_start`) sin actualización posterior de la suscripción: se lee la sesión y, si está completa, la suscripción, y se aplica con las mismas reglas que el webhook.
   - Suscripciones cuyo periodo o prueba terminó hace más de 6 h sin noticias: se leen de Stripe y se aplica lo que diga (renovada, impagada o cancelada → Free).
   - Nunca se aplica una suscripción cuyo `metadata.organization_id` sea de otra organización; las que Stripe no conoce (404) se dejan a la red de seguridad de fin de periodo.
   - Cron: como mucho una vez por hora (`billing_reconcile_last`). A demanda: `POST /orgs/:id/billing/sync` (permiso `billing:read`, 12 por hora), que la página de Facturación llama al volver de Stripe Checkout (hasta 4 veces, cada 4 s). Solo informa del estado si la suscripción es de Stripe, para no mostrar «Plan activado» en Free.
   - Cada corrección queda en la auditoría como `billing.reconciled`; los créditos del plan se conceden una sola vez.
5. **Inicio de sesión con Google con exactamente los permisos registrados**: `openid email` (se quitó `profile`, que no estaba registrado). El nombre visible es la parte del correo antes de «@»; la política de privacidad lo dice.

## Consecuencias

- Sin migración: la tabla `plans` no cambia.
- Pruebas nuevas: 6 de «Money safety» en `stripe.test.ts` (prueba gratuita en cualquier orden, pago bancario pendiente, aviso perdido con créditos una sola vez, renovación y cancelación sin aviso, suscripción desconocida o ajena, límite horario y sin clave), Free sin «Plan activado», y las de coherencia tabla ↔ matriz ↔ límites.
- Coste: 0 €. Solo lecturas a la API de Stripe, limitadas a 20 por consulta y una vez por hora.
