# Cobros con Stripe: qué se hará y cuánto cuesta

Estado: **desactivado** (`BILLING_ENABLED=false`). El código ya existe (checkout, webhooks firmados e idempotentes, ledger de créditos), pero nada cobra hasta que lo decidas. No hace falta presupuesto para empezar.

## 1. Lo que cuesta Stripe (sin cuota mensual)
Stripe no cobra alta ni mensualidad: solo una comisión por cada pago que entra. Tarifas públicas orientativas para una empresa en España (compruébalas en stripe.com/es/pricing el día que actives):

| Concepto | Comisión aproximada | Ejemplo con el plan Starter (39 €) |
|---|---|---|
| Tarjeta europea estándar | 1,5 % + 0,25 € | 0,84 € → recibes ~38,16 € |
| Tarjeta del Reino Unido | 2,5 % + 0,25 € | 1,23 € |
| Tarjeta internacional | ~3,25 % + 0,25 € | 1,52 € |
| Stripe Billing (suscripciones recurrentes) | ~0,7 % del importe facturado | 0,27 € |
| Stripe Tax (opcional, calcula el IVA) | ~0,5 % por transacción | 0,20 € |

Con un Starter cobrado a un cliente europeo te quedan unos **37,9 €** (≈97 %). Tu único coste fijo sigue siendo Cloudflare (5 USD/mes, ya pagado).

## 2. Lo que necesitas antes de cobrar (requisitos legales, no técnicos)
1. **Estar dado de alta para facturar** (autónomo o sociedad) y tener una cuenta bancaria a tu nombre o al de la empresa: Stripe verifica tu identidad (KYC) y paga en esa cuenta.
2. **IVA**: a empresas de la UE con NIF-IVA, factura sin IVA con inversión del sujeto pasivo; a particulares de otros países de la UE, el IVA de su país (régimen OSS); en España, 21 %. Stripe Tax lo automatiza, o lo lleva tu gestor.
3. **Textos legales** con tus datos fiscales: condiciones de contratación, política de cancelación y reembolso, privacidad (hoy son borradores en `/legal/*`).
4. **Dominio propio** (lo vas a comprar): Stripe y los clientes confían más, y el email de recibos sale de tu dominio.

## 3. Lo que haré cuando digas «activa Stripe» (unas 2 horas de trabajo)
1. Tú creas la cuenta de Stripe y me dices que ya está; **las claves las pegas tú** con `npx wrangler secret put STRIPE_SECRET_KEY` y `STRIPE_WEBHOOK_SECRET` (nunca en el chat).
2. Empezamos en **modo prueba** (`sk_test_…`): creo los productos y precios mensuales (Starter, Growth, Pro, Agency) y guardo cada `price_…` en la tabla `plans`.
3. Registro el webhook en `https://<tu-dominio>/api/v1/webhooks/stripe` (eventos `checkout.session.completed` y `customer.subscription.*`).
4. Pongo `BILLING_ENABLED=true`, despliego y hago un pago de prueba con la tarjeta de prueba de Stripe: la suscripción debe aparecer activa, el plan y los créditos subir una sola vez aunque Stripe repita el evento, y la cancelación debe devolver la cuenta a Free.
5. Solo cuando todo lo anterior esté verde, cambiamos a claves `sk_live_…`. El primer cobro real lo autorizas tú.
6. Activo el **portal de cliente de Stripe** (cambiar tarjeta, descargar facturas, cancelar) para no tener que gestionar eso a mano.

## 4. Estrategia para ganar rápido sin presupuesto
- **Producto de entrada que ya funciona**: la auditoría gratuita (Free: 3 análisis/mes) es el gancho. Quien la usa ve sus problemas reales y el plan de 30 días; el Asesor IA y las imágenes consumen créditos, que es lo que empuja a pagar.
- **Empieza con 2 planes, no 5**: Starter 39 €/mes y Growth 89 €/mes. Pro y Agency se activan cuando un cliente lo pida. Menos opciones = decisión más rápida.
- **Precio anual con 2 meses gratis** (390 € y 890 €): cobras por adelantado, lo que te da caja inmediata.
- **Servicio «hecho por ti» con la herramienta**: vende a negocios locales (como DNI GYM y su entorno) una auditoría + plan explicado en una llamada por un pago único de 150–300 €, usando DNI Growth. Es el ingreso más rápido: no depende de tráfico orgánico y cada cliente puede convertirse en suscripción.
- **Sin anuncios de pago al principio**: canales gratuitos (tus redes, contactos de DNI GYM y DNI DIRECTO, grupos de empresarios locales, LinkedIn) y el propio blog/auditoría pública para SEO.
- **Garantía simple**: 14 días de devolución en el primer mes; reduce el miedo a pagar y Stripe permite reembolsar con un clic.
- Coste variable por cliente casi nulo: la IA tiene tope diario y créditos; el resto está incluido en Workers Paid. Por eso casi todo lo que cobres (menos ~3 % de Stripe e impuestos) es margen.

Ninguna cifra de ventas está garantizada: son precios orientativos (definidos en `migrations/0003_seed_plans.sql`, editables) y comisiones públicas que pueden cambiar.
