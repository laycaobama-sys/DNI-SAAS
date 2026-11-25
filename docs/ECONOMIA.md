# Economía por plan — coste, cuotas y margen

Fecha: 2026-11-23. Objetivo del plan: un margen bruto de **al menos el 70 %** por plan con costes reales medidos. Todos los importes son en euros y sin IVA.

## 1. Costes reales hoy (medidos)

| Concepto | Coste | Fuente |
|---|---|---|
| Cloudflare Workers Paid: Worker, D1, Queues, R2, cron, 3.000 emails/mes | ~5 USD/mes **fijo**, ya contratado | factura de Cloudflare |
| IA de texto: Workers AI con tope `AI_DAILY_BUDGET_USD = 0.10`, más OpenRouter, Groq y Gemini en nivel gratuito | 0 € variable (dentro de lo incluido) | `ai_usage` en D1; panel de cada proveedor |
| Email transaccional | 0 € (tope de 2.500/mes, por debajo de los 3.000 incluidos) | `EMAIL_MONTHLY_CAP` |
| Stripe: tarjeta europea estándar y Billing | ~1,5 % + 0,25 € más ~0,7 % por cobro | tarifa pública de Stripe; compruébala al activar |
| Stripe Tax (opcional, **no activado**) | ~0,5 % por cobro | tarifa pública de Stripe |

## 2. Margen por plan (cobro mensual, tarjeta UE)

| Plan | Precio | Comisión de Stripe | IA y infraestructura variables | Margen bruto |
|---|---|---|---|---|
| Starter | 49 € | 1,33 € | ~0 € | **97 %** |
| Growth | 129 € | 3,09 € | ~0 € | **98 %** |
| Pro | 249 € | 5,73 € | ~0 € | **98 %** |
| Agency | 449 € | 10,13 € | ~0 € | **98 %** |

El margen es tan alto porque toda la IA es gratuita. El límite real no es el dinero, sino la **capacidad de los niveles gratuitos**:
- Workers AI con un tope de 0,10 USD al día.
- La cuota diaria de Gemini y de los modelos gratuitos de OpenRouter.

Cuando se alcanza, el borrador o la consulta se detienen con un aviso y **sin cobrar**. Con más de unas decenas de clientes activos habrá que pasar a una IA de pago. Por eso las cuotas se han fijado para que, incluso pagando IA, el margen siga por encima del 70 %.

## 3. Coste estimado si se pasa a IA de pago (estimación, no medido)

Supuesto: unos 0,04 € por borrador de artículo de 1.500 palabras con un modelo de gama media, más su revisión.

| Plan | Artículos/mes | IA de contenido | Muestras GEO | Total estimado | Margen estimado |
|---|---|---|---|---|---|
| Starter | 8 | 0,32 € | 10 prompts al día ≈ 1,5 € | ~3,2 € | ~93 % |
| Growth | 30 | 1,20 € | 30 al día ≈ 4,5 € | ~8,8 € | ~93 % |
| Pro | 60 | 2,40 € | 100 al día ≈ 15 € | ~23 € | ~91 % |
| Agency | 450 (30 × 15 webs) | 18 € | 30 × 15 al día ≈ 68 € | ~96 € | ~79 % |

Revisa esta tabla con los precios reales del proveedor antes de contratarlo. En Agency, el seguimiento GEO es lo que más pesa.

## 4. Cuotas aplicadas (fuente: `plans.limits_json`, migración 0019)

| Plan | Webs | Usuarios | Auditorías/mes | Páginas/auditoría | Artículos IA/mes | Prompts GEO | Créditos/mes |
|---|---|---|---|---|---|---|---|
| Free | 1 | 1 | 3 | 10 | 1 | 10 | 50 |
| Starter | 1 | 1 | 20 | 100 | 8 | 50 | 500 |
| Growth | 1 | 3 | 60 | 250 | 30 | 150 | 1.500 |
| Pro | 3 | 10 | 200 | 500 | 60 | 400 | 4.000 |
| Agency | 15 | ilimitados | 600 | 500 | 450 | 1.500 | 10.000 |

Diferencias con el plan comercial:
- **Páginas por auditoría** con tope técnico de 500, frente a las 2.000 del plan (ADR 0022). La página de precios muestra el valor real.
- **Prompts GEO**: se mantienen las cuotas actuales, más altas que las del plan, porque el muestreo usa el nivel gratuito de Gemini con su propio tope diario.

## 5. Riesgos

- **Dependencia de los niveles gratuitos**: Google o OpenRouter pueden cambiar sus cuotas. Las llamadas se registran en `ai_usage` y el Control Center muestra el consumo diario.
- **Garantía de 90 días**: el reembolso total de 90 días de Growth es de 387 €. Solo se paga si se cumplen todos los requisitos y Search Console demuestra que las impresiones no subieron.

## Publicación externa y herramientas gratuitas (2026-11-25)
- **Facebook, Instagram y WordPress:** sus API no cobran por publicar. El coste para DNI Growth es CPU del Worker (cron cada minuto, que ya existía) y lecturas y escrituras en D1, dentro del plan Workers Paid. Coste marginal estimado: 0 €.
- **`/herramientas`:** las 8 herramientas funcionan en el navegador del visitante, como archivos estáticos sin llamadas a la API. No consumen IA ni CPU del Worker. Coste marginal: 0 €.
- **Copias diarias:** unos 107 KB comprimidos al día, 30 días conservados (unos 3 MB en R2), muy por debajo de los 10 GB incluidos. Coste: 0 €.
- **`/estado`:** 8 comprobaciones cada 5 minutos (unas 2.300 al día), dentro de las peticiones incluidas. Coste: 0 €.
