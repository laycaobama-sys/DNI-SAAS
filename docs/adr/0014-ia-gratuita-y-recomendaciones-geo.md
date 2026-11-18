# ADR 0014 — Servicio de IA gratuito centralizado, recomendaciones GEO explicables e informes

Fecha: 2026-11-18 · Estado: aceptado

## Contexto
La titular pidió un único servicio de IA 100 % gratuito basado en Workers AI con el modelo `@cf/meta/llama-3.1-8b-instruct-fp8-fast`, respaldo opcional con Groq o Gemini, caché, límite de tokens y un mensaje claro al agotar la cuota diaria. Regla permanente: no activar nada que amplíe gastos sin su autorización. También pidió terminar F3: recomendaciones GEO explicables, menciones comparables e informes exportables.

Hechos comprobados el 2026-11-18:
- `wrangler ai models list --json`: `llama-3.1-8b-instruct-fp8-fast` **no existe** en el catálogo; la variante `-fp8` se retira el 2026-11-20.
- Workers AI: 10.000 neuronas gratuitas al día (reinicio 00:00 UTC), 0,011 USD por 1.000 neuronas adicionales. La cuenta está en **Workers Paid**, así que el exceso **sí se facturaría**: la afirmación «imposible que te cobren» no es cierta sin un tope.
- Groq `llama-3.1-8b-instant`: modelo de producción, API compatible con OpenAI.

## Decisión
1. **Workers AI primero** con `@cf/google/gemma-4-26b-a4b-it` y respaldo `@cf/zai-org/glm-4.7-flash` (razonamiento desactivado con `chat_template_kwargs.enable_thinking=false`). Configurable con `WORKERS_AI_TEXT_MODEL`.
2. **Tope duro**: el presupuesto diario se recorta a 0,10 USD (≈ 9.091 neuronas), por debajo de lo gratuito. Al agotarse: error `ai_daily_quota` en español con la hora de renovación y sin descontar créditos.
3. Cascada transparente: Groq (si existe `GROQ_API_KEY`, tope diario) → Gemini texto (si existe `GEMINI_API_KEY`, tope diario, nunca con «privacidad primero») → OpenRouter solo `:free`. Los datos sensibles solo van a Workers AI.
4. **Caché** en D1 (`ai_response_cache`, 24 h, por organización, clave SHA-256 de la petición completa); los datos sensibles no se guardan. Se eligió D1 en vez de KV para no crear recursos nuevos y mantener el aislamiento multitenant con la guarda estática de SQL.
5. **Recomendaciones GEO deterministas** (`packages/core/src/geo-recs.ts`): sin IA, sin coste. Cada recomendación enlaza el hueco observado (muestra concreta) con una página existente de la auditoría, una página nueva o una señal del sitio (JSON-LD Organization, llms.txt solo si la auditoría prueba que faltan), e incluye método y limitaciones (una sola muestra, respuestas sin búsqueda, reglas no causales). Nunca prometen posiciones ni menciones.
6. **Intervalos de Wilson al 95 %** para que las tasas de mención sean comparables con muestras pequeñas.
7. **Informe exportable** (JSON/CSV; PDF mediante la impresión del navegador, sin dependencias nuevas): cada fila con fuente, periodo, tipo de medida y nota; secciones no conectadas lo dicen; CSV protegido contra inyección de fórmulas; exportaciones auditadas y limitadas.

## Consecuencias
- Coste esperado 0: Workers AI dentro del cupo gratuito por diseño; Groq/Gemini/OpenRouter en niveles gratuitos.
- Con mucha demanda el cupo se agota y el usuario ve el mensaje de renovación; ampliar requiere decisión expresa de la titular.
- El PDF depende del diálogo de impresión del navegador.
