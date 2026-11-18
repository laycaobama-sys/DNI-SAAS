# ADR 0012 — Biblioteca de prompts GEO (sin respuestas simuladas)

Fecha: 2026-11-18 · Estado: aceptado

## Contexto
El backlog F3 pide una «Biblioteca de prompts: preguntas, motor, intención, idioma y región» como base del monitor de visibilidad en IA. El PRD exige consultar motores «solo mediante mecanismos permitidos por cada proveedor», y la constitución del proyecto prohíbe métricas falsas y presentar la visibilidad en IA como algo continuo o garantizado.

## Decisión
- Tabla `tracked_prompts` (migración 0010, aditiva): una fila por pregunta × motor × idioma × país, con intención (educativa, comparativa, transaccional), tipo (marca, producto, sector, geografía), zona opcional, estado activo/pausado, origen (manual o sugerencia aceptada) y archivado lógico. Índice único parcial sobre la pregunta normalizada (sin mayúsculas, tildes ni puntuación) para las filas activas.
- Catálogo de motores con estado honesto: `gemini_api`, `openai_api`, `perplexity_api`, `claude_api` (API oficial; se muestrearán solo con clave y presupuesto aprobados por la titular) y `google_ai_overviews`, `chatgpt_app` (sin API oficial: **no se rastrean ni se automatizan**; quedan para revisión manual).
- Límite por plan `trackedPrompts` (10/50/150/400/1500) guardado en `plans.limits_json`; se comprueba antes y **dentro** de cada INSERT (no se supera con peticiones concurrentes).
- Sugerencias deterministas a partir del perfil de marca (nombre, productos, sector schema.org, zona, competidores, público): sin IA, sin coste, sin guardar nada hasta que una persona las acepta; lo que falta se informa, no se inventa. Nunca se usa la calle del domicilio, solo la ciudad.
- Permisos: lectura y exportación con `brand:read`; altas, cambios, archivado y restauración con `brand:write`; todo auditado (`geo.prompts_create`, `geo.prompt_update`, `geo.prompt_archive`, `geo.prompt_restore`).
- Exportación CSV (con protección contra inyección de fórmulas) y JSON; declaran que no contienen respuestas.

## Consecuencias
- La pantalla «AI Visibility (GEO)» no muestra ningún porcentaje de visibilidad hasta que exista el muestreo real (siguiente ítem: monitor por APIs válidas, con fecha, motor, idioma, región y versión de modelo de cada muestra).
- Activar un motor de pago requiere autorización expresa de la titular (regla de no ampliar gastos).
