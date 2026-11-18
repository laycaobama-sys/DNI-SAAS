# ADR 0013 — Monitor GEO con Gemini en el nivel gratuito

Fecha: 2026-11-18 · Estado: aceptado

## Contexto
La biblioteca de prompts (ADR 0012) necesitaba muestras reales de respuestas de motores de IA. La titular autorizó **solo Gemini gratuito** («SOLO GEMINI GRATIS») y pidió probar `gemini-3.8-flash`. Regla permanente: no activar nada que pueda generar gastos sin su autorización. El proyecto de Google de la clave («IA APP») está en **Nivel gratuito** en AI Studio, sin cuenta de facturación vinculada: Google no puede cobrar estas llamadas.

Hechos comprobados en la documentación oficial (aistudio.google.com/docs/pricing y /deprecations, 2026-11-18):
- La búsqueda de Google («grounding») en el nivel gratuito solo existe para Gemini 2.5 Flash / Flash-Lite (500 peticiones/día compartidas). Para Gemini 3.x figura como «Not available» en el nivel gratuito.
- `gemini-3.8-flash` y `gemini-3.5-flash-lite` tienen nivel gratuito.

Comprobado en producción con la clave real:
- `gemini-2.5-flash-lite` devolvió **404** a esta clave (no se le ofrece al proyecto).
- `gemini-3.8-flash` con búsqueda devuelve **429 «You exceeded your current quota»**: la cuota gratuita de búsqueda es cero. Sin búsqueda responde, pero a menudo devuelve **503 «high demand»**.

## Decisión
- Modelo configurable por variable (no secreta): `GEMINI_MODEL` (por defecto `gemini-3.8-flash`) y respaldo opcional `GEMINI_FALLBACK_MODEL` (`gemini-3.5-flash-lite`, también gratuito).
- Cada ejecución pide primero **con** búsqueda. Si Google la rechaza (400 o 429 de cuota cero), esa misma pregunta se repite **sin** búsqueda y el resto de la ejecución sigue sin ella. Cada muestra guarda `grounded` y el método (`…+google_search:v1` o `…:v1`).
- Errores 5xx/red: dos reintentos cortos (5 s y 15 s). Si persisten, o si el modelo principal agota su propia cuota (429), la pregunta pasa al modelo de respaldo, que se usa para el resto de la ejecución. Cada muestra guarda **el modelo que respondió de verdad**.
- La ejecución se detiene tras 3 preguntas seguidas con error temporal (`gemini_unavailable`), si el respaldo también agota la cuota (`gemini_quota`) o al alcanzar los topes diarios propios (40 muestras por organización, 150 en la plataforma; cada llamada cuenta). Los 404/401/403 son definitivos: 1 llamada y fin.
- Se guarda un extracto del mensaje de error de Google de como máximo 300 caracteres, sin claves (`AIza…` se redacta), en los eventos del trabajo.
- Visibilidad: la tasa de citas solo se calcula sobre respuestas **con** búsqueda. Si no hay ninguna, se muestra «—» con la explicación, nunca «0 %». La «Fuente» lista los modelos que respondieron.

## Consecuencias
- Con el nivel gratuito actual las respuestas reflejan el **conocimiento del modelo**, sin fuentes. La pantalla y las advertencias lo dicen. Medir citas de la web exige búsqueda, que requeriría un modelo 2.5 accesible o el nivel de pago; esto último **no se activa sin autorización expresa de la titular**.
- El nivel gratuito permite a Google usar el contenido enviado. Por eso la política de privacidad lo informa y la interfaz pide no incluir datos personales en las preguntas.
- Con la demanda actual, una ejecución puede tardar ~1 min por pregunta o pararse por saturación. Lo pendiente queda para la siguiente ejecución: primero las preguntas que llevan más tiempo sin muestra.
