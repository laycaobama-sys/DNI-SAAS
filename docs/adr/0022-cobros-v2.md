# ADR 0022 — Cobros v2: catálogo único, anual, prueba, pausa, retención y garantía de 90 días

- Fecha: 2026-11-23
- Estado: aceptada
- Contexto: plan comercial `docs/PLAN_DNI_GROWTH.md`, Fase 1 y la parte de cancelación de la Fase 10.

## Decisión

1. **Una sola fuente de precios**: `packages/core/src/pricing.ts`. De ahí salen:
   - `PLAN_OFFERS`: Free 0 €, Starter 49 €, Growth 129 €, Pro 249 €, Agency 449 €. El anual equivale a 10 mensualidades; el precio por mes se publica redondeado a la baja.
   - `PRICING_ROWS`: la tabla comparativa, con el estado *disponible / parcial / en desarrollo* de cada fila.
   - Los motivos de cancelación, el cupón de retención y las reglas de la garantía.

   La migración `0019_billing_v2.sql` copia precios y cuotas a la tabla `plans`. Un test comprueba que ambos coinciden.
2. **Stripe se configura solo** a partir de la clave. El cron llama a `maybeAutoSyncStripe` como mucho una vez por hora, o en cuanto cambia el catálogo (firma `catalogSignature`).
   - Productos con id fijo y precios con `lookup_key`: idempotente.
   - IVA: Stripe Tax si la cuenta lo tiene activo; si no, un tipo manual del 21 % para España.
   - Cupón `dni_growth_retencion_30_2m`, portal de cliente y webhook. El secreto del webhook se guarda cifrado.

   El panel de administración permite forzar la sincronización y archivar (nunca borrar) los productos ajenos.
3. **Apertura de pagos** con `BILLING_ENABLED`:
   - `"auto"`: con una clave real, el checkout se abre al público solo si `/v1/account` dice `charges_enabled = true`. Con una clave de prueba, solo lo usan los administradores.
   - `"true"`: lo fuerza.
   - `"false"`: lo cierra.
4. **Contratación**:
   - El checkout exige `acceptTerms: true`. La aceptación queda auditada con la versión de las condiciones y la petición de inicio inmediato (renuncia informada al desistimiento).
   - Prueba de 7 días solo en Growth, con tarjeta y una sola vez por organización. Si no hay método de pago, la suscripción se cancela al terminar la prueba.
   - Las subidas de plan se prorratean al momento y las bajadas se aplican al final del periodo (configurado en el portal).
5. **Retención honesta**: una encuesta de motivo y como mucho una oferta, según el motivo:
   - Descuento del 30 % durante 2 meses, una sola vez.
   - Pausa de 1 a 3 meses (`pause_collection` *void*; mientras dura, la organización usa el plan Free).
   - Bajar de plan.

   Cancelar siempre está a un clic y se puede deshacer hasta el final del periodo.
6. **Impagos**: `past_due` mantiene el plan durante 7 días de gracia, con avisos por email y en la app. Después pasa a Free sin borrar nada. `invoice.paid` lo restaura.
7. **Garantía de 90 días**: `evaluateGuarantee` es una función pura. Las impresiones se leen de `gsc_daily_metrics`, con un mínimo de 20 días con datos en cada ventana de 28; si faltan datos, nunca se da como superada ni como reembolsable. El reembolso es de 1 clic:
   - Se devuelven las facturas pagadas a través de `invoice_payments` y `refunds`.
   - Se cancela la suscripción.
   - Queda registrado en `guarantee_claims` (una vez por organización) y en la auditoría.

## Desviaciones respecto al plan

- **Páginas por auditoría**: 250 en Growth y 500 en Pro y Agency, frente a 500 y 2.000 en el plan. El rastreador actual tiene un límite técnico de 500 páginas por trabajo (tiempo de CPU del Worker). La tabla pública lo dice.
- **Artículos al mes**: la cuota se aplica a los borradores con IA (`content_items.kind = 'blog_article'` con proveedor). Los escritos a mano no cuentan.
- **Packs extra y descuentos por volumen**: no implementados. No se anuncian.
- **Stripe Smart Retries y emails de impago**: los reintentos los hace Stripe con la configuración de la cuenta. Nosotros enviamos un email por fallo y uno al vencer la gracia, no tres.

## Consecuencias

- Para cobrar en real basta con guardar la clave `sk_live_` de la cuenta elegida (ver `docs/BLOQUEOS.md` §1).
- Cambiar un precio se hace en `pricing.ts` más una migración. El cron crea el precio nuevo y archiva el anterior; los clientes actuales conservan el suyo.
- Pruebas: `apps/api/test/stripe.test.ts`, `packages/core/test/pricing.test.ts` y `apps/web/test/billing.test.tsx`.
