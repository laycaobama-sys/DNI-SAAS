# Estado de la ampliación — DNI Growth

Última revisión: 2026-11-23 · Producción: https://dnigrowth.com (Worker `dni-growth`) · Pruebas: **453 en verde** (38 ficheros: core, API y web).

Este documento mapea cada punto de la especificación de ampliación (`ESPECIFICACION-CLAUDE-CODE.md`, tareas T01–T16 y conectores del §3) contra el código real: qué existe, dónde está, qué prueba lo cubre, qué falta y qué lo bloquea. Se actualiza en cada fase. El detalle verificado en producción está en [`../IMPLEMENTATION_STATUS.md`](../IMPLEMENTATION_STATUS.md).

Reglas que se aplican a todo lo de abajo: IA solo gratuita (Workers AI con tope, OpenRouter `:free`, Groq y Gemini en nivel gratuito), Stripe desactivado (`BILLING_ENABLED=false`), presupuesto 0 € para servicios nuevos, migraciones aditivas con copia previa de D1. Lo que depende de un proveedor de pago figura como **pendiente de proveedor**: no se muestran datos inventados en su lugar.

Leyenda: **REAL** (funciona de punta a punta con pruebas) · **PARCIAL** (parte real, hueco indicado) · **PENDIENTE DE PROVEEDOR** · **BLOQUEADO** (acción externa o de la titular) · **NO EMPEZADO**.

## Incremento 1 — dominio → auditoría con evidencia → borrador revisable → exportación

Estado: **REAL**, verificado en producción el 2026-11-23 (auditoría de dnigrowth.com en la organización DNI Growth, versión `39c1fb0f`). Funciona sin conectores y con la IA agotada: nada de este recorrido llama a la IA ni gasta créditos, salvo la propia auditoría.

| Tramo | Código | Pruebas |
|---|---|---|
| Dominio → rastreo seguro (SSRF, robots.txt, solo HTML) | `apps/api/src/jobs/analyze.ts`, `packages/core/src/ssrf.ts`, `robots.ts`, `extract.ts` | `ssrf.test.ts`, `seo.test.ts`, `journey.test.ts` («no non-HTML pages») |
| Hallazgos con evidencia por URL, tipo de página y peso (las legales nunca encabezan) | `packages/core/src/seo-rules.ts`, `organic.ts` (`classifyPage`) | `audit-quality.test.ts` (tipos y pesos, horas), `journey.test.ts` |
| og:image real: formato, tamaño y acceso | `packages/core/src/image-meta.ts`, regla `og_image_format` | `audit-quality.test.ts` (PNG/JPEG/WebP/SVG), `journey.test.ts` |
| Segundo indicador «Potencial orgánico» (medida derivada, con método y advertencias) | `packages/core/src/organic.ts` (`organicPotential`) | `audit-quality.test.ts` |
| Informe de auditoría MD/HTML (todos los planes, CSP estricta) | `packages/core/src/audit-report.ts`, `GET /crawls/:id/export` en `apps/api/src/routes/insights.ts` | `journey.test.ts` («exports the audit report…») |
| Brief por hallazgo sin guardar (todos los planes) | `packages/core/src/finding-draft.ts`, `GET /crawls/:id/findings/:rule/brief` | `journey.test.ts` |
| Borrador revisable desde un hallazgo (idempotente, 0 créditos) | `POST /content/from-finding` en `apps/api/src/routes/content.ts` | `journey.test.ts` («creates the draft without AI or credits…») |
| Borrador manual sin IA (alternativa con la IA agotada) | `POST /content/manual`, `manualDraftBody` | `journey.test.ts` («writes a manual draft…») |
| Comprobaciones antes de aprobar: campos pendientes y promesas **bloquean**; cifras sin fuente y precios sin verificar exigen confirmación **auditada** | `checkDraft` en `finding-draft.ts`, `transition()` en `content.ts` | `journey.test.ts`, `content.test.ts` |
| Exportación del borrador con evidencia, estado y origen | `GET /content/:id/export` | `journey.test.ts` |
| Interfaz: «Crear borrador de corrección», «Brief», «Informe HTML/Markdown», panel de comprobaciones, confirmación, hallazgo de origen, «Escribir a mano» | `apps/web/src/app/pages/insights.tsx`, `content.tsx` | `apps/web/test/ui-guards.test.tsx` (vista previa segura) |
| Aislamiento entre organizaciones en todo el recorrido | consultas con `organization_id` | `journey.test.ts` (404 cruzados) |

## Fallos B1–B15 (`AUDITORIA-APP-DNI-GROWTH.md`)

| Fallo | Estado | Arreglo | Prueba |
|---|---|---|---|
| B1 Asesor deja la app en blanco | REAL · verificado en producción | efectos con llaves (`scrollIntoView` devuelve Promise en Chrome) en `ai.tsx`, `geo.tsx`, `shell.tsx` | `apps/web/test/advisor.test.tsx`, guarda en `ui-guards.test.tsx` |
| B2 Un fallo de render tumba toda la app | REAL | `apps/web/src/app/errorboundary.tsx` por ruta (`shell.tsx`) y global (`main.tsx`) | `advisor.test.tsx` («ErrorBoundary»), `ui-guards.test.tsx` |
| B3 Plan con «fase F3» y tareas bloqueadas que ya están disponibles | REAL | `packages/core/src/plan.ts`; planes antiguos saneados al leer (`healLegacyPhaseBlocks`) | `flow.test.ts`, `journey.test.ts` («heals plans…»), `audit-quality.test.ts` |
| B4 Códigos internos en la interfaz | REAL | sin fase en módulos ni integraciones; etiquetas de acciones, conceptos y canales en español | `ui-guards.test.tsx` («no internal phase or backlog codes») |
| B5 llms.txt y no-HTML listados como páginas | REAL | `isHtml()` en `analyze.ts`; vista filtra rastreos antiguos | `journey.test.ts` |
| B6 og:image SVG no detectada | REAL · verificado en producción | `image-meta.ts`, regla `og_image_format` | `audit-quality.test.ts`, `journey.test.ts` |
| B7 Sin indicador de potencial orgánico | REAL | `organic.ts` | `audit-quality.test.ts` |
| B8 Páginas legales encabezan las mejoras | REAL · verificado en producción | pesos por tipo y orden «solo legales al final» | `audit-quality.test.ts`, `journey.test.ts` |
| B9 Asesor sin evidencia o con afirmaciones falsas | REAL | contexto con URLs + `validateAdvisorAnswer` (aviso visible) | `ai.test.ts`, `audit-quality.test.ts`, `advisor.test.tsx` |
| B10 Marca: theme-color como color, CTAs como temas, email de privacidad como contacto | REAL | `packages/core/src/brand.ts` (CSS, filtros, `emailRole`) | `audit-quality.test.ts` |
| B11 Límites de módulos no incluidos en el plan | REAL | `/entitlements` filtra por `planIncludes`; tarjetas de planes | `growth.test.ts` |
| B12 Conceptos del libro de créditos en inglés | REAL | `LEDGER_CONCEPT` en `org.tsx` | revisión de interfaz |
| B13 Auditar otro dominio sobrescribe la marca o choca con el límite | REAL · verificado en producción | elección de marca en `analyze.tsx`; `brand_kept` en `analyze.ts` | `journey.test.ts`, prueba en producción («la auditoría se guardará allí») |
| B14 Tarjetas del Command Center solapadas | REAL | rejillas `auto-fill/minmax` y `MetricCard` | revisión de interfaz |
| B15 Uso del asesor, perfil y plan fuera del registro | REAL | eventos `advisor.message`, `brand.profile_created`, `plan.created` | `ai.test.ts`, `journey.test.ts` |

## Fase 0 — web pública

| Punto | Estado | Código | Prueba |
|---|---|---|---|
| og:image PNG 1200×630 (con dimensiones, alt y `twitter:image`) | REAL · producción | `apps/web/public/og-dni-growth.png`, `apps/web/index.html` | `curl` → 200 `image/png`; la propia auditoría ya no lo marca |
| `/blog` funcional (vacío con mensaje honesto) alimentado por Content Studio | REAL · producción | `apps/api/src/routes/site-blog.ts`, `apps/web/blog.html`, migración `0018_site_blog.sql`, ADR 0020 | `site-blog.test.ts` |
| Sitemap dinámico (páginas, `/blog` y artículos con `lastmod`) | REAL · producción | `GET /sitemap.xml` en `site-blog.ts` | `site-blog.test.ts`, `curl` |
| RSS del blog | REAL · producción | `/blog/feed.xml` | `site-blog.test.ts` |
| Sin códigos internos en la interfaz | REAL | ver B4 | `ui-guards.test.tsx` |
| `llms.txt` al día con lo disponible | REAL · producción | `apps/web/vite.config.ts` | `curl` |
| Capturas reales y vídeo demo en la portada | NO EMPEZADO | — | requiere material de la titular |
| Pagos (Stripe Live) | BLOQUEADO | `BILLING_ENABLED=false` por decisión de la titular | — |

## Tareas T01–T16

| Tarea | Estado | Qué existe (código) | Pruebas | Hueco y cambio mínimo |
|---|---|---|---|---|
| **T01** Alta y contexto de marca | PARCIAL | auditoría → perfil de marca con fuente por dato y confirmación humana (`brand.ts`, `insights.ts` `/brands/:id/profile`), competidores y afirmaciones prohibidas | `flow.test.ts`, `audit-quality.test.ts` | falta asistente guardable paso a paso, ofertas con URL de prueba y precio estructurado, país/variante lingüística. Cambio: tabla `brand_offers` + pasos del asistente sobre el perfil actual |
| **T02** Investigación y clusters | PARCIAL | consultas reales de Search Console con intención y oportunidades, lista guardada, competencia por lectura pública (`organic.ts` `/keywords/*`, `searchConsole.ts`) | `growth.test.ts`, `searchconsole.test.ts` | **pendiente de proveedor** para volumen, dificultad y solapamiento de SERP (DataForSEO u otro licenciado). Falta el contraste con URLs existentes antes de proponer una nueva (canibalización) |
| **T03** Motor de contenido | PARCIAL | Content Studio: brief → borrador (IA o manual o desde hallazgo) → versiones → revisión → aprobación → exportación; comprobaciones previas; fuentes como DATOS (`content.ts`, `finding-draft.ts`) | `content.test.ts`, `journey.test.ts` | falta esquema intermedio, editor de metadatos y vista móvil/escritorio, reglas por idioma |
| **T04** Catálogo de productos | NO EMPEZADO | — | — | necesita conector de tienda (Shopify/WooCommerce) con clave de solo lectura del cliente |
| **T05** Publicación | PARCIAL | exportación MD/HTML; **publicación real en el blog propio** `dnigrowth.com/blog` con aprobación, auditoría e idempotencia (`site-blog.ts`) | `site-blog.test.ts` | faltan los CMS de clientes (WordPress primero): requiere credenciales del cliente y un entorno de pruebas |
| **T06** Refresco de contenido | NO EMPEZADO | base: comparación entre auditorías (`/seo/compare`) y GSC | `growth.test.ts` | diff por bloque con línea base y ventanas comparables |
| **T07** Paneles GSC, GA4 y muestras de modelos | REAL | `searchConsole.ts`, `analytics.ts`, `geo.ts` + monitor GEO con Gemini gratuito (muestreo con fecha, motor y denominador) | `searchconsole.test.ts`, `analytics.test.ts`, `geo.test.ts`, `geomonitor.test.ts` | más motores solo con API oficial y coste 0 |
| **T08** Auditoría técnica | REAL (base) | reglas deterministas con gravedad, evidencia, reparación y prioridad; informe exportable; comparación entre auditorías | `seo.test.ts`, `audit-quality.test.ts`, `journey.test.ts`, `growth.test.ts` | falta compartir informe con caducidad/revocación y «volver a comprobar» una sola regla |
| **T09** Colaboraciones editoriales | PARCIAL | registro manual/CSV de enlaces con comprobación vivo/perdido (`/backlinks`) | `growth.test.ts` | directorio voluntario. **Nunca** intercambio de enlaces; métricas de autoridad (DR) **pendientes de proveedor licenciado** |
| **T10** Bandeja Reddit/Quora | NO EMPEZADO | — | — | solo con búsqueda permitida o importación de URL; nunca publicación automática |
| **T11** Carruseles y redes | PARCIAL | Creative Studio (imágenes) y vídeo en el navegador (`studio.ts`) | `growth.test.ts` | publicación en Meta **bloqueada** hasta app y permisos aprobados; alternativa: exportar imágenes y texto |
| **T12** Google Business Profile | BLOQUEADO | — | — | requiere acceso aprobado a la Business Profile API |
| **T13** Agencia | REAL (base) | organizaciones cliente, herencia de plan, marca blanca (`agency.ts`) | `growth.test.ts`, `tenancy.test.ts` | dominio propio por cliente (Cloudflare for SaaS puede tener coste: requiere autorización) |
| **T14** Herramientas públicas, academias y MCP | NO EMPEZADO | la auditoría gratuita ya existe dentro de la app | — | herramientas públicas sin cuenta reutilizando el motor de reglas, con límites |
| **T15** Dependencias y propagación | NO EMPEZADO | — | — | — |
| **T16** Resultado comercial | PARCIAL | CRM con formularios, landings con UTM, atribución primer contacto (`crm.ts`, `landings.ts`, `/attribution`) | `crm.test.ts`, `landings.test.ts`, `growth.test.ts` | panel por artículo y URL con leads y ventas deduplicadas |

## Conectores (§3)

| Conector | Estado | Motivo |
|---|---|---|
| Blog alojado en `dnigrowth.com/blog` | REAL | Worker + D1, sin coste |
| Blog alojado en subdominio del cliente (Cloudflare for SaaS) | BLOQUEADO | puede tener coste: requiere autorización expresa |
| WordPress autoalojado / WordPress.com | NO EMPEZADO | credenciales del cliente y entorno de pruebas |
| Shopify, Webflow, Wix, Ghost, Framer, GoHighLevel, Duda, BigCommerce, Snapps | NO EMPEZADO | uno a uno, tras WordPress |
| API de lectura de artículos y webhook firmado | NO EMPEZADO | siguiente paso natural tras el blog propio |
| Catálogo Shopify/WooCommerce | NO EMPEZADO | ver T04 |
| Google Search Console / GA4 | REAL | solo lectura |
| Meta Ads / Google Ads | BLOQUEADO | aprobación de app y token de desarrollador |
| Proveedor de keywords/SERP y de autoridad (DR) | PENDIENTE DE PROVEEDOR | de pago: no se activa con presupuesto 0 € |
| Business Profile API | BLOQUEADO | acceso aprobado de Google |

## Siguiente incremento propuesto

1. **T05 — API de lectura y webhook firmado del blog** (sin coste): permite que cualquier web del cliente consuma sus artículos aprobados.
2. **T08 — informe compartible** con caducidad y revocación, y «volver a comprobar» una regla.
3. **T01 — ofertas estructuradas** con URL de prueba: alimentan las comprobaciones de precios del borrador.
