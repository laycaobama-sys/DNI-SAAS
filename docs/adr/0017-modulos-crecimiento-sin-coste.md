# ADR 0017 — Módulos de crecimiento sin coste: SEO orgánico, reglas, Ads en borrador, vídeo en el navegador y agencia

Fecha: 2026-11-19 · Estado: aceptado

## Contexto
El menú mostraba «pronto» en SEO técnico, Keywords, Backlinks, Vídeo, Ads, Automatizaciones y Agencia. La regla de la titular es no contratar ni ampliar gastos, no inventar métricas y no ejecutar efectos externos de alto riesgo sin autorización y auditoría.

## Decisión
- **SEO y keywords con datos propios**: comparación entre auditorías propias; keywords desde las consultas reales de Search Console y los términos del sitio. Volumen, CPC y dificultad se muestran como «no disponible» (requieren un proveedor de pago). La competencia se lee con `safeFetch` (anti-SSRF, robots.txt, 30 lecturas/día por organización) y solo se calculan huecos de términos.
- **Backlinks verificables**: la organización registra enlaces (uno a uno o CSV) y el Worker comprueba si la página de origen sigue enlazando (vivo/perdido/bloqueado/error). No hay índice de enlaces de terceros. Limitación: un Worker no puede leer su propia zona (HTTP 522).
- **Motor de reglas** (`lib/rules.ts`): disparadores contacto nuevo, cambio de etapa y tarea vencida; acciones crear tarea, mover etapa, asignar, aviso al equipo **sin datos personales** y webhook firmado (`x-dni-signature`, secreto cifrado mostrado una vez, redirecciones manuales, 8 s, reintentos 1 min → 12 h y cola muerta). Idempotencia con `automation_runs UNIQUE(rule_id, trigger_ref)`; un cambio de etapa hecho por una regla no vuelve a disparar reglas.
- **Ads solo como borradores**: campañas con presupuesto propuesto, anuncios, envío, aprobación con separación de funciones (salvo propietaria) y Spend Guardian con interruptor de corte activo por defecto; la salida es una exportación JSON con UTM. No hay conexión a Meta/Google Ads hasta que aprueben sus API: bloqueo externo.
- **Vídeo renderizado en el navegador** (canvas + MediaRecorder → MP4/WebM, audio opcional por WebAudio), subtítulos SRT y medios propios en R2 con derechos confirmados, lista blanca MIME + bytes mágicos y límites de tamaño. Coste de servidor cero.
- **Agencia**: organizaciones cliente (Pro 5, Agency 50) que heredan el plan de la agencia cuando su plan propio es Free; marca blanca (nombre, logo https, color, pie de informes) en Pro/Agency. Dominio propio por cliente bloqueado por coste.
- **Panel** con KPIs que citan su fuente o, si no hay datos, la acción siguiente; nada de cifras de relleno.

## Consecuencias
- Coste adicional cero: todo corre en el Worker, D1 y R2 existentes.
- Las funciones que dependen de terceros figuran como «Parcial» en la web pública con el motivo (ads, atribución con valor declarado).
- Stripe en modo prueba se verificó con suscripciones reales de prueba (Starter → Growth → Pro → Agency → cancelada) que cambian los límites vía webhook firmado.
