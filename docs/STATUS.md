# Estado del plan maestro — DNI Growth

Última revisión: **2026-11-23** · Producción: https://dnigrowth.com · Plan: [PLAN_DNI_GROWTH.md](PLAN_DNI_GROWTH.md) · Pasos de la titular: [BLOQUEOS.md](BLOQUEOS.md) · Detalle con pruebas: [IMPLEMENTATION_STATUS.md](IMPLEMENTATION_STATUS.md) · Cambios: [CHANGELOG.md](CHANGELOG.md)

Leyenda: **Hecho** (funciona de punta a punta y está verificado) · **Parcial** (existe una base que funciona; falta lo que se indica) · **Pendiente** (no empezado) · **Bloqueado** (depende de una acción externa o de la titular).

## Verificación de hoy en producción

- `pnpm verify`: lint, typecheck, **523 pruebas** (45 ficheros), build y escaneo de secretos en verde.
- **180 de 180** lecturas de la API responden 200 con la sesión de la administradora: 4 organizaciones (panel, miembros, marcas, auditorías, plan, contenido, Search Console, Analytics, GEO, informes, CRM, landings, SEO, automatizaciones, anuncios, medios, vídeo, agencia, facturación, IA, integraciones) y el panel de administración.
- Procesos en segundo plano de los últimos 7 días: 5 auditorías de web, 11 sincronizaciones de Search Console, 7 de Analytics y 5 muestreos GEO, **todos completados**; ninguna tarea atascada en la cola; correos entregados.
- Páginas públicas `/`, `/precios`, `/seguridad`, `/blog`, `/legal/*` → 200; `/no-existe` → 404; alias legales → 301.
- Stripe en modo prueba: catálogo, cupón, portal y webhook sincronizados; pago de Stripe abierto con el precio correcto (sin pagar).

## Fases

| Fase | Estado | Qué hay | Qué falta |
|---|---|---|---|
| 0 · Arreglos inmediatos de la web | **Hecho** | Fuente única de funciones y precios, analítica propia sin cookies, portada, `/seguridad`, 404, `llms.txt` con planes ([ADR 0021](adr/0021-analitica-producto-sin-cookies.md)) | — |
| 1 · Monetización | **Hecho en código · Bloqueado para cobrar** | Planes nuevos con anual, prueba de 7 días en Growth, aceptación de condiciones, portal, pausa, retención honesta, impagos con gracia, garantía medible de 90 días, `/precios`, embudo de cobros, alias legales, red de seguridad de fin de periodo ([ADR 0022](adr/0022-cobros-v2.md), [STRIPE_PLAN.md](STRIPE_PLAN.md)). Cuenta real DNI Growth-IA activa y limpia | La clave real de Stripe (solo la titular, [BLOQUEOS §1](BLOQUEOS.md)); revisión legal (§2); IVA con gestor (§3) |
| 2 · Activación | **Parcial** | Alta, verificación de email, confirmación de marca, conexión de Search Console y Analytics, auditoría completa con evidencia | Auditoría anónima con adelanto `/auditoria/{id}`, comparación con competidor, asistente de 6 pasos, emails de ayuda a 24 h / 72 h |
| 3 · Motor de contenido | **Parcial** | Content Studio: borradores con versiones, aprobación, revisión con IA gratuita, exportación, publicación en el blog propio | Calendario de 30 días desde Search Console, voz de marca, nota de calidad 0–100 con reescritura, detector de contenido que cae y de canibalización |
| 4 · Publicación e integraciones | **Parcial** | Exportación HTML/Markdown; publicación en el blog de dnigrowth.com | WordPress, Shopify, Webflow, Wix, Ghost, webhook genérico, publicación programada y reversión |
| 5 · SEO técnico que se corrige solo | **Parcial** | Auditor con reglas, prioridades y evidencia; brief por hallazgo; comparativa entre auditorías | Correcciones automáticas (requiere Fase 4), reglas nuevas (Core Web Vitals, hreflang…), rastreo semanal con alertas |
| 6 · Visibilidad en IA (GEO) | **Parcial** | Prompts seguidos con sugerencias, muestreo con la API oficial de Gemini (nivel gratuito), visibilidad con intervalo de confianza, recomendaciones | ChatGPT, Claude y Perplexity (claves de pago: presupuesto 0 €), sentimiento y alertas |
| 7 · Autoridad y enlaces seguros | **Parcial** | Vista de enlaces y exportación | Menciones sin enlace, enlaces rotos de la competencia, PR digital, envío desde el buzón del cliente |
| 8 · Social y vídeo | **Parcial** | Estudio de vídeo (proyectos, subtítulos SRT), estudio creativo de imágenes, medios | Carruseles desde artículo y calendario social; publicación directa **bloqueada** por la revisión de Meta ([BLOQUEOS §5](BLOQUEOS.md)) |
| 9 · Resultados e ingresos | **Parcial** | Panel con datos de Search Console y GA4 con fuente y fecha, informe de rendimiento, CRM con formularios y atribución | Panel «Tu mes con DNI Growth» completo, resumen semanal por email, informe mensual en PDF, casos verificados |
| 10 · Retención | **Parcial** | Cancelación honesta con encuesta y ofertas, pausa, exportación, emails de pago fallido y fin de prueba | Puntuación de salud, resto de emails del ciclo de vida, centro de ayuda, `/estado`, NPS |
| 11 · Web de marketing | **Parcial** | Portada, `/precios`, `/seguridad`, blog, legales, sitemap, `llms.txt`, Search Console y Bing verificados | Páginas por producto y sector, comparativas, herramientas gratuitas, guías, kit de anuncios |
| 12 · Motores de crecimiento | **Parcial** | Plan Agency con clientes, marca propia y permisos | Afiliados, referidos, API pública y servidor MCP |
| 13 · Operación interna | **Parcial** | Panel de administración (organizaciones, usuarios, IA, embudo, Stripe, auditoría), colas con reintentos y cola de mensajes muertos, límites de uso | MRR/LTV y margen por plan, alertas al móvil, copias diarias con prueba de restauración |
| 14 · Legal | **Parcial · revisión de abogado** | Privacidad, aviso legal, condiciones de uso y contratación con desistimiento y garantía, eliminación de datos | Revisión por abogado, DPA descargable, lista de subencargados aparte |

## Bloqueos activos (resumen)

1. **Stripe real:** falta guardar la clave secreta de DNI Growth-IA (2 minutos, solo la titular). Todo lo demás está listo y se configura solo.
2. **Abogado y gestor:** condiciones, garantía, privacidad e IVA.
3. **Google:** verificación del acceso a datos en revisión (4–6 semanas según Google); marca ya verificada.
4. **Meta:** la cuenta de desarrollador pide confirmar la identidad («actividad inusual»); después, verificación del negocio y revisión de la app.
5. **Claves de pago** (OpenAI, Anthropic, Perplexity, DataForSEO): no compradas por presupuesto 0 €; esas funciones no se venden como disponibles.
