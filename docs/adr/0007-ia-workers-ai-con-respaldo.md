# ADR 0007 — IA: Workers AI con respaldo OpenRouter (gratis) y Gemini

- Estado: aceptado · Fecha: 2026-11-17

## Contexto
El titular quiere IA de texto e imágenes sin coste, con cambio automático si un modelo falla. La clave de Gemini de otra app es un secreto de Worker: no se puede leer ni copiar (es correcto que así sea). No existe ninguna app «Data Engine» con un asesor en la cuenta; el asesor se ha construido aquí.

## Decisión
- Orden de texto: Workers AI `@cf/google/gemma-4-26b-a4b-it` (modelo de razonamiento: presupuesto de salida ampliado) → `@cf/mistralai/mistral-small-3.1-24b-instruct` → `@cf/meta/llama-4-scout-17b-16e-instruct` → OpenRouter, solo modelos con todos los precios a 0 (catálogo público cacheado 6 h, máx. 4 intentos) → Gemini `gemini-flash-latest`.
- Imágenes: Workers AI `@cf/black-forest-labs/flux-1-schnell` (1024×1024) → modelos gratuitos de OpenRouter con salida de imagen, si hay clave. Se valida que los bytes sean PNG/JPEG/WebP antes de guardar en R2 (UE).
- Modelos con retirada anunciada (2026-11-20) excluidos.
- Coste: tope diario de plataforma `AI_DAILY_BUDGET_USD` (0,10 USD ≈ asignación gratuita diaria de Workers AI) contabilizado en `ai_usage_daily`; al agotarse se salta Workers AI. Para el cliente: créditos con reserva atómica (1 por respuesta, 5 por imagen), liberados si falla.
- Seguridad: datos de terceros como `<datos>` saneados; sin herramientas ni acciones con efectos externos; filtro de prompts de imagen.

## Consecuencias
- Sin claves de OpenRouter/Gemini el respaldo es solo entre modelos de Workers AI.
- Los modelos gratuitos de OpenRouter cambian a menudo y pueden tener límites estrictos; por eso se leen del catálogo en vivo en vez de fijarlos.
- El plan gratuito de Gemini puede usar los datos enviados para mejorar productos de Google: no enviar datos personales por esa vía en clientes reales sin clave de pago.
