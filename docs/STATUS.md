# Estado del plan maestro — DNI Growth

Última revisión: **2026-11-25** · Producción: https://dnigrowth.com (versión `a1038509`) · Plan: [PLAN_DNI_GROWTH.md](PLAN_DNI_GROWTH.md) · Pasos de la titular: [BLOQUEOS.md](BLOQUEOS.md) · Detalle con pruebas: [IMPLEMENTATION_STATUS.md](IMPLEMENTATION_STATUS.md) · Cambios: [CHANGELOG.md](CHANGELOG.md)

Leyenda: **Hecho** (funciona de punta a punta y está verificado) · **Parcial** (existe una base que funciona; falta lo que se indica) · **Pendiente** (no empezado) · **Bloqueado** (depende de una acción externa o de la titular).

## Verificación en producción

**2026-11-25 (Entrega 2: confianza, redes, WordPress y herramientas; versiones `6f914e1f`, `aec5e64b`, `a1038509`):**
- `pnpm verify`: lint, typecheck, **588 pruebas** (2 saltadas: las que necesitan un WordPress real o variables de producción), build y escaneo de secretos en verde.
- Cada despliegue ejecuta la auditoría propia de dnigrowth.com: **100/100**.
- `/estado`: 8 comprobaciones en verde. Copia diaria `backups/db/2026-11-25.sql.gz` (106.961 bytes) creada en R2 y **restaurada de verdad** en una base local, con las filas comparadas.
- WordPress: prueba de punta a punta contra un **WordPress real** (Playground, PHP 8.3, última versión) con las rutas de la app: conectar, publicar, actualizar la misma entrada sin duplicar y retirar a borrador.
- `/herramientas` y sus 8 páginas → 200, en el sitemap; `.html` y la barra final redirigen a la URL canónica. Herramientas probadas en producción sin errores de consola.
- Migraciones `0022`, `0023` y `0024` aplicadas, cada una tras su copia de la base de datos.
- Meta: casos de uso Páginas e Instagram añadidos y URL de redirección, de retirada de permisos y de borrado de datos guardadas en la app. Falta la clave de la app ([BLOQUEOS §0](BLOQUEOS.md)).

**2026-11-24 (cobros sin fallos, versión `8015e5ff`):**
- `pnpm verify`: lint, typecheck, **548 pruebas**, build y escaneo de secretos en verde.
- `/precios`, portada, inicio de sesión, privacidad y `/api/v1/health` → 200; `/precios` con Search Console (todos) y Analytics (desde Starter); Google pide solo `openid email` al iniciar sesión.
- Reconciliación con Stripe ejecutada por el cron a las 00:31 UTC; suscripciones de producción coherentes con su plan.
- Google: respuesta al correo de verificación del 21 nov enviada el 2026-11-24.
- Meta: la cuenta de desarrollador ya no pide confirmación y la app «DNI Growth» está publicada (modo producción); falta ser proveedor de tecnología y verificar la empresa.

**2026-11-24 (Fase 2):**
- `pnpm verify`: lint, typecheck, **539 pruebas** (47 ficheros), build y escaneo de secretos en verde.
- Copia de la base de datos antes de migrar; migración `0021` aplicada (solo añade tablas).
- Auditoría gratuita de dnigrowth.com desde la portada: completada al primer intento (92/100) y comparada con example.com (71/100). Caché de 24 h, rechazo de otras webs (403) y de direcciones internas (422) comprobados.
- Páginas públicas, `/api/v1/health`, verificación de Google, `robots.txt` y `sitemap.xml` → 200; cron sin errores durante 70 s de registros.
- Stripe en real: `pricing-status` → pagos abiertos; cuenta «DNI Growth-IA» con cobros activos.

**2026-11-23:**
- **180 de 180** lecturas de la API responden 200 con la sesión de la administradora: 4 organizaciones (panel, miembros, marcas, auditorías, plan, contenido, Search Console, Analytics, GEO, informes, CRM, landings, SEO, automatizaciones, anuncios, medios, vídeo, agencia, facturación, IA, integraciones) y el panel de administración.
- Procesos en segundo plano de los últimos 7 días: 5 auditorías de web, 11 sincronizaciones de Search Console, 7 de Analytics y 5 muestreos GEO, **todos completados**; ninguna tarea atascada en la cola; correos entregados.
- Clave real de Stripe guardada por la titular: catálogo, portal, IVA y webhook en modo real sincronizados solos a las 22:35 UTC.

## Fases

| Fase | Estado | Qué hay | Qué falta |
|---|---|---|---|
| 0 · Arreglos inmediatos de la web | **Hecho** | Fuente única de funciones y precios, analítica propia sin cookies, portada, `/seguridad`, 404, `llms.txt` con planes ([ADR 0021](adr/0021-analitica-producto-sin-cookies.md)) | — |
| 1 · Monetización | **Hecho · pagos reales abiertos** | Planes nuevos con anual, prueba de 7 días en Growth, aceptación de condiciones, portal, pausa, retención honesta, impagos con gracia, garantía medible de 90 días, `/precios`, embudo de cobros, alias legales, red de seguridad de fin de periodo ([ADR 0022](adr/0022-cobros-v2.md), [STRIPE_PLAN.md](STRIPE_PLAN.md)). Cuenta real DNI Growth-IA activa, clave real guardada y pagos abiertos al público desde el 2026-11-23 | Revisión legal ([BLOQUEOS §2](BLOQUEOS.md)); IVA con gestor (§3); primer cobro real |
| 2 · Activación | **Hecho** | Auditoría gratuita sin registro (5 páginas, límites por IP, caché de 24 h) con adelanto `/auditoria/{id}`: nota global, Técnica, SEO y GEO/AEO, 3 problemas con evidencia y «otros N»; compartir y comparar con un competidor; al registrarse la auditoría pasa a la cuenta; bienvenida de 6 pasos con barra de progreso y lista en el panel; correos de ayuda a 24 h y 72 h con baja en un clic ([ADR 0023](adr/0023-activacion-fase-2.md)) | Dependen de otras fases y la app lo dice: CMS (Fase 4), piloto automático real; imagen social con la nota |
| 3 · Motor de contenido | **Parcial** | Content Studio: borradores con versiones, aprobación, revisión con IA gratuita, exportación, publicación en el blog propio | Calendario de 30 días desde Search Console, voz de marca, nota de calidad 0–100 con reescritura, detector de contenido que cae y de canibalización |
| 4 · Publicación e integraciones | **Parcial** | Exportación HTML/Markdown; blog de dnigrowth.com; **WordPress** con contraseña de aplicación, sin duplicados y con retirada a borrador ([ADR 0025](adr/0025-publicacion-externa-meta-y-wordpress.md)) | Plugin «DNI Growth Connector» (Yoast/Rank Math, JSON-LD, llms.txt), imagen destacada, publicación programada en WordPress, Shopify, Webflow, Ghost, webhook genérico |
| 5 · SEO técnico que se corrige solo | **Parcial** | Auditor con reglas, prioridades y evidencia; brief por hallazgo; comparativa entre auditorías | Correcciones automáticas (requiere Fase 4), reglas nuevas (Core Web Vitals, hreflang…), rastreo semanal con alertas |
| 6 · Visibilidad en IA (GEO) | **Parcial** | Prompts seguidos con sugerencias, muestreo con la API oficial de Gemini (nivel gratuito), visibilidad con intervalo de confianza, recomendaciones | ChatGPT, Claude y Perplexity (claves de pago: presupuesto 0 €), sentimiento y alertas |
| 7 · Autoridad y enlaces seguros | **Parcial** | Vista de enlaces y exportación | Menciones sin enlace, enlaces rotos de la competencia, PR digital, envío desde el buzón del cliente |
| 8 · Social y vídeo | **Parcial** | Estudio de vídeo (proyectos, subtítulos SRT), estudio creativo de imágenes, medios | Publicación programada en Facebook e Instagram **construida** (aprobación, pausa, sin duplicados); se activa con la clave de la app de Meta y se abre a todos tras la revisión de Meta ([BLOQUEOS §0 y §5](BLOQUEOS.md)). Faltan carruseles desde artículo y calendario social |
| 9 · Resultados e ingresos | **Parcial** | Panel con datos de Search Console y GA4 con fuente y fecha, informe de rendimiento, CRM con formularios y atribución | Panel «Tu mes con DNI Growth» completo, resumen semanal por email, informe mensual en PDF, casos verificados |
| 10 · Retención | **Parcial** | Cancelación honesta con encuesta y ofertas, pausa, exportación, emails de pago fallido y fin de prueba | Puntuación de salud, resto de emails del ciclo de vida (los de 24 h y 72 h ya están), centro de ayuda, NPS. `/estado` ya está publicado |
| 11 · Web de marketing | **Parcial** | Portada, `/precios`, `/seguridad`, blog, legales, sitemap, `llms.txt`, Search Console y Bing verificados | `/herramientas` con 8 herramientas gratuitas publicada. Faltan 4 herramientas (GEO con 1 pregunta, palabras clave frente a un competidor, enlaces rotos, imagen OG por URL), páginas por producto y sector, `/comparativa`, guías, capturas y vídeo, kit de anuncios |
| 12 · Motores de crecimiento | **Parcial** | Plan Agency con clientes, marca propia y permisos | Afiliados, referidos, API pública y servidor MCP |
| 13 · Operación interna | **Parcial** | Panel de administración (organizaciones, usuarios, IA, embudo, Stripe, auditoría), colas con reintentos y cola de mensajes muertos, límites de uso | MRR/LTV y margen por plan, alertas al móvil. Copias diarias con restauración probada y `/estado` con alertas por email ya están |
| 14 · Legal | **Parcial · revisión de abogado** | Privacidad, aviso legal, condiciones de uso y contratación con desistimiento y garantía, eliminación de datos | Revisión por abogado, DPA descargable, lista de subencargados aparte |

## Bloqueos activos (resumen)

1. **Abogado y gestor:** condiciones, garantía, privacidad e IVA (Stripe ya cobra en real).
2. **Google:** verificación del acceso a datos en revisión (4–6 semanas según Google); marca ya verificada.
3. **Meta:** la titular tiene que guardar la clave de la app (`META_APP_SECRET`); después, proveedor de tecnología, verificación del negocio y revisión de la app.
4. **Claves de pago** (OpenAI, Anthropic, Perplexity, DataForSEO): no compradas por presupuesto 0 €; esas funciones no se venden como disponibles.
