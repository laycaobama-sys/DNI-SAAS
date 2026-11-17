# GROWTHOS AI — Auditoría competitiva y PRD Enterprise
**Versión:** 1.0 | **Corte de investigación:** 17-11-2026 | **Estado:** propuesta de producto, no software desarrollado

## 0. Método y grado de certeza
- Fuentes verificadas: webs oficiales, tarifas, documentación pública, condiciones de servicio, guías de integración y documentación oficial de API.
- No se accedió a cuentas privadas ni al código fuente de BabyLoveGrowth o Adscena. `/es/dashboard/overview` no pudo consultarse directamente; la documentación de `/docs/dashboard/overview` es pública. `app.adscena.es/inicio` redirige al acceso.
- Etiquetas de certeza: **[V]** verificado en fuente pública; **[D]** aparece en documentación comercial, sin prueba técnica independiente; **[H]** hipótesis / oportunidad no verificada de ausencia; **[P]** propuesta original para nuestro producto.
- No replicar marcas, logos, bases de datos, diseños pixel-perfect ni código protegido. Usar patrones de producto generales y crear identidad, UX y código propios.
- Fuentes primarias al final del documento. Las cifras comerciales corresponden al momento de consulta y podrían variar.

## 1. Resumen ejecutivo
Crear GrowthOS AI (nombre provisional), SaaS multi-tenant de crecimiento que conecta descubrimiento de clientes, SEO/GEO/AEO, investigación competitiva, generación y actualización de contenidos, campañas de pago, estudio creativo de vídeo, landing pages, conversiones, CRM, atribución y reporting. Diferenciación: operar mediante **motor de experimentación y resultados**, no por volumen de piezas; toda recomendación debe tener evidencia, coste estimado, riesgo, propietario, aprobación, reversión y medición posterior.

**ICP principal:** autónomos, pymes, ecommerce, SaaS, agencias de marketing con varios clientes. **ICP secundario:** franquicias/multisede y equipos internacionales. **Buyer jobs:** quiero clientes, no aprender 8 herramientas; quiero controlar la inversión; quiero verificar si la IA realmente mejora ventas; quiero comparar campañas y oportunidades orgánicas.

**North Star:** margen de contribución o ingresos atribuibles verificables por cliente activo, con incertidumbre de atribución explícita. **Métricas de apoyo:** nuevos clientes cualificados, CPA/CAC, ROAS, CVR, tasa de publicación aprobada, tiempo hasta primer valor, retención, coste por trabajo de IA, satisfacción, crecimiento orgánico, visibilidad por motor y calidad editorial.

## 2. Auditoría funcional: BabyLoveGrowth
### 2.1 Elementos públicos verificados
1. [V] Onboarding y extracción del contexto de marca, productos, público objetivo, mercados y competidores, con confirmación/corrección por el usuario.
2. [V] Dashboard Overview: actividad diaria del agente, navegación temporal entre días, acciones planificadas, artículo destacado y explicación de por qué se eligió, logros con pruebas, origen del tráfico y checklist de configuración.
3. [V] Plan editorial por calendario: dificultad de keyword, volumen, cambios de temas, eliminación, adición de keywords e instrucciones por artículo; contenidos previamente publicados editables.
4. [V] Investigación y agrupación de palabras clave SERP; estrategia de contenidos por tópicos, intención y mercados.
5. [V] Artículos AEO/SEO en 50+ idiomas; enlaces internos, FAQ, JSON-LD, imágenes e infografías; tono de marca, CTA y catálogo de productos; puntuación de calidad 0–100.
6. [V] Personalización: índice, resumen rápido, TL;DR, enlaces recomendados, esquema de artículo, estilo de inglés/citas, tipo de artículo, longitud y días de generación.
7. [V] Publicación automática: WordPress, WordPress.com, Shopify, Webflow, Wix, Ghost, Framer, GoHighLevel, Duda, BigCommerce, Snapps, Next.js Blog y rutas vía API/Webhooks / alojamiento de blog por subdominio; otras conexiones documentadas con herramientas no-code.
8. [V] Integración Search Console y GA4: clics, impresiones, posición, CTR, tráfico de IA, usuarios, sesiones, top páginas/canales y filtros.
9. [V] Tracking de marca en respuestas de modelos: prompts por intención, visibilidad, menciones, sentimiento, tendencias, competidores, fuentes citadas y respuestas detalladas; muestra de modelos depende de plan/soporte.
10. [V] Auditoría técnica periódica: page speed, schema, robots, sitemap, llms.txt, HTTPS, etiquetas title/description, canónicas, H1, enlaces rotos, imágenes, CWV, gaps de contenido y score compuesto; prompts de corrección exportables.
11. [V] Mejora de artículos existentes ligada a rendimiento GSC y configuración de hasta dos días de mejora semanales.
12. [V] Intercambio contextual de backlinks basado en créditos y afinidad de sector, con historial de recibidos/cedidos y control de Domain Rating.
13. [V] Agentes sociales de oportunidades Reddit y Quora; planificación/publicación de carruseles en Instagram/Facebook.
14. [V] Catálogo de productos Shopify/WooCommerce, importación manual, archivo, feeds XML y Google/Facebook; asociación de productos a piezas.
15. [V] Soporte para agencias / white-label, gestión de clientes y distintas vistas del dashboard.

### 2.2 Tarifas públicas de referencia
- Grow: **99 €/mes** según su página consultada; 30 artículos/mes, 10 prompts de IA rastreados, 1 asiento. La página indica facturación anual; revisar modalidad antes de contratar.
- Scale: **399 €/mes** en la página consultada; 120 artículos/mes, hasta 4 idiomas/mercados, 50 prompts de IA, plazas ilimitadas, soporte superior.
- Existen descuentos/otras monedas según landing, campaña y modalidad. No presentar el precio de tabla como precio universal.

### 2.3 Mejoras propuestas frente al enfoque público
- [P] Unir contenido/SEO con gasto publicitario y oportunidades de negocio, ventas y margen en un funnel verificado.
- [P] Atribución observable y explícita: orgánico, paid, referidos, visitas directas; modelado vs medido, no afirmar que una mención IA equivale a un clic o una venta.
- [P] Política editorial de evidencia: fuente, fecha, nivel de certeza, revisión humana, regla de caducidad; no atribuir rankings al software sin experimentación.
- [P] Backlink governance: evitar esquemas recíprocos automáticos diseñados para manipular rankings; relaciones editoriales reales, PR digital, menciones ganadas, `rel=sponsored`/`nofollow` cuando corresponda.
- [P] Auditoría y *fix deploy* con diff, PR, staging, rollback y permisos. Ningún script ciego que sobreescriba un sitio ajeno.
- [P] Comparación incremental de prompts AEO con diseño de muestras, intervalos, país, fecha, modelo/version, variabilidad y capturas permitidas.

## 3. Auditoría funcional: Adscena
### 3.1 Elementos públicos verificados
1. [V] Entrada por URL; extracción de propuesta de valor, servicios y estilo de marca.
2. [V] Propuesta automatizada de producto/oferta y objetivos de captación.
3. [V] Generación de campaña como conjunto: scripts, vídeos verticales con locución, banners, copys, landing + formulario.
4. [V] Revisión, solicitud de cambios y aprobación de piezas antes de publicar.
5. [V] Integración Meta: vincular cuenta comercial; preparar publicaciones en Facebook/Instagram, elegir público, zona, presupuesto y confirmar lanzamiento.
6. [V] Dashboard de campaña con inversión, clics y leads/contactos.
7. [V] Formularios y recepción de leads; notificaciones por WhatsApp.
8. [V] Seguimiento de desgaste creativo, avisos y sustitución de creatividades aprobadas cuando se habilita.
9. [V] Presupuesto diario y sistema de recargas/autorecarga en uno de sus canales públicos.
10. [V] Gestión de facturación/plan; prueba y reglas de gasto según modalidad.
11. [V] Orientación a negocios locales, campañas para solar, inmuebles, eventos y otros servicios.

### 3.2 Precios: ADVERTENCIA DE INCONSISTENCIA PÚBLICA
- `adscena.es/precios` refleja prueba **0 € con 300 créditos y 30 € publicitarios**, Amateur **99 €/mes / 800 créditos**, Pro **199 €/mes / 2.000 créditos**; costes publicados: 3 fotos 30 créditos, carrusel 50, vídeo 150, e inversión en Meta más comisión del 15%. Créditos sin gastar no se acumulan según esa página.
- `adscena.io` comunica **99 €/mes + publicidad + 15 % gestión**, con hasta 3 vídeos, 9 banners y una landing al preparar; piezas extra: vídeo 10 €, banner 2 €, landing 5 €.
- Las condiciones en `app.adscena.es/condiciones` hablan de prueba de 7 días en el texto consultado. Otros resúmenes públicos hablan de 3 días: se debe verificar la oferta contractual exacta al registrarse.
- **Conclusión:** no comparar como si la estructura fuese inmutable o idéntica en todas las páginas/canales.

### 3.3 Mejoras propuestas
- [P] Publicidad MULTICANAL en lugar de solo Meta: Meta, Google Ads, TikTok Ads, LinkedIn Ads y Microsoft Ads por adaptadores y habilitación gradual.
- [P] Creatividades editables en línea, storyboard, timeline de vídeo, variantes de hook, subtítulos, voz, tamaños, tono y A/B testing.
- [P] CRM nativo con pipeline, calificación, deduplicación, consentimiento y seguimiento de ventas reales; no quedarse en lead.
- [P] ROAS y coste real con impuestos, comisiones, generación y margen, separados del gasto en medios.
- [P] Experimentos con hipótesis, control, métricas mínimas y alertas de poca muestra; no declarar ganadores por CTR aislado.
- [P] Políticas de presupuesto: topes diarios/mensuales, límite de variación, aprobación, kill switch, anomalías, undo y registro de auditoría.
- [P] Landing CRO con mapas de eventos consentidos, A/B y personalización contextual no invasiva.

## 4. Otros competidores verificados y qué estudiar
| Plataforma | Evidencia pública principal | Patrón útil a implementar con UX propia |
|---|---|---|
| Semrush | Site Audit, Position Tracking, AI Visibility y análisis de competidores | Visión holística SEO + IA + competencia |
| Ahrefs | Site Explorer, Keywords Explorer, Brand Radar, Site Audit | Profundidad de investigación orgánica y share of voice |
| Search Atlas / OTTO | Diagnóstico y despliegue automatizable de correcciones SEO | Motor de remediaciones con revisión, diff y reversión |
| Surfer | Editor semántico, mapas tópicos, seguimiento IA, enriquecimiento | Edición guiada por cobertura y calidad, sin keyword stuffing |
| OtterlyAI / Peec | Monitorización de prompts y citas por buscador | Metodología de benchmark reproducible y geo-idioma |
| AdCreative.ai | Generación, comparación, puntuación e inteligencia competitiva creativa | Evaluación de creatividades y biblioteca de variantes |
| Creatify | URL-to-video, guion, voz, avatar/UGC, vídeo comercial | Producción audiovisual parametrizada y exportable |
| Madgicx | AI ads management, reglas, diagnóstico y aprobación/autonomía | Recomendaciones con límites y posibilidad de ejecución supervisada |
| Smartly | Orquestación creativa, medios y medición publicitaria | Operación y reporting multicuenta Enterprise |
| Motion | Etiquetado creativo y detección de patrones ganadores | Analítica de conceptos/escenas/hooks, no solo anuncios individuales |
| Foreplay | Biblioteca de anuncios, seguimiento de competidores y briefs | Investigación permitida de anuncios públicos y repositorio de inspiración |
| Unbounce | Landing builder, experimentación A/B y Smart Traffic | Optimización de páginas basada en conversiones |
| Metricool | Publicaciones, analytics, planificación y publicidad multicanal | Calendario omnicanal y reporting social |

**Precaución:** la ausencia de un módulo en la web comercial de un competidor NO prueba que carezca de él. Nuestro diferencial es la ejecución integrada, transparencia y profundidad, no la afirmación de que nadie más lo ofrece.

## 5. Mapa de producto exhaustivo
Cada módulo deberá incluir: permisos RBAC, control por plan, estados `draft/review/approved/active/paused/failed/archived`, audit log, consumo de créditos, acciones testables, accesibilidad, localización, APIs y exportación.

### M00 — Plataforma base, negocio y equipo
- Registro email/OAuth, verificación y MFA opcional/obligatorio Enterprise.
- Organizaciones/workspaces, marcas, sitios, ubicaciones y cuentas publicitarias; invitaciones y pertenencia multiorganización.
- Roles: Platform SuperAdmin, Organization Owner, Admin, Marketing Manager, Editor, Analyst, Client Viewer, Billing Admin; roles custom Enterprise.
- Onboarding por URL, asistente conversacional, checklist, tutorial, plantilla por industria, preguntas cuando falten datos.
- Brand kit: logos, variantes, tipografías licenciadas, colores, voz, idiomas, público, restricciones, políticas, competidores, objetivos, calendarios y fuentes válidas.
- Assets con permisos de uso/fecha de licencia, versiones, búsqueda y deduplicación; carpetas, tags y aprobación.
- Multimoneda, I18n, zonas horarias, formatos legales, accesibilidad y dark/light mode.
- Buscador global, comandos, actividad, centros de notificaciones, SLA y estado de integraciones.

### M01 — Website & Business Intelligence
- Introducir dominio/URL, verificar propiedad antes de operaciones con impacto; análisis público permitido sin reclamar propiedad.
- Rastreador SSRF-safe: sitemap, robots, navegación, metadatos, títulos, schema, OpenGraph, CWV, estructura, imágenes, enlaces y contenidos.
- Clasificación sector/mercado, servicios, propuesta, USP, precios **solo si son visibles**, requisitos legales y warnings.
- Mapa de páginas/contenidos, árbol de navegación, productos, catálogos, canales, CTAs y páginas de conversión.
- Competidores sugeridos: añadir/quitar dominios; diferenciar competidor SEO vs comercial vs publicidad.
- Diagnóstico priorizado impacto × esfuerzo × certeza, evidencia por URL y fuente.

### M02 — SEO Técnico
- Crawl configurable bajo rate limiting y robots, filtros por estado e indexabilidad, sitemap, redirects, canonicals, hreflang, enlaces rotos, robots, schema, alt text, headings, duplicados, titles/meta, Orphan pages, JS rendering y performance.
- GSC, Bing Webmaster Tools y GA4: OAuth, scopes mínimos, tokens en vault, backfill incremental, mapeo por propiedad.
- Score con pesos transparentes, hallazgos trazables, tendencia histórica y separación error/advertencia/oportunidad.
- Soluciones sugeridas: PR para repos git, patches CMS con revisión, export CSV/JSON, diff y revert; nunca desplegar en producción sin permiso.
- SEO internacional, local, ecommerce, imágenes, vídeo, noticias y páginas programáticas legítimas.
- Guardarraíl: sitemaps/URL Inspection no garantizan indexación; no usar Google Indexing API para URLs genéricas.

### M03 — Keyword Research, Competidores y SERP
- Keywords por país/idioma/dispositivo; volumen, dificultad de fuente conectada, tendencia, intención, CPC cuando disponible, SERP features, oportunidad.
- Clustering semántico, canibalización, content gap, topical map, matriz producto × persona × etapa del embudo.
- Seguimiento posiciones, share of voice orgánico, comparación de páginas, backlinks, competencia publicitaria pública y alertas de movimientos relevantes.
- Proveedor de datos enchufable: licencias y cuotas; nada de simular volumen ni dificultad si no hay proveedor.

### M04 — GEO/AEO / AI Search Intelligence
- Biblioteca de prompts de intención educativa/comparativa/transaccional, marca, producto, sector, geografía.
- Ejecutores por motores **solo mediante mecanismos permitidos por cada proveedor**; registrar modelo, versión, región aproximada, fecha, configuración y respuesta cuando licitada.
- Métricas calculables: frecuencia de mención, share of voice por conjunto de prompts, sentimiento con revisión, dominio citado, cita directa, posición textual y variabilidad.
- Análisis de gaps vs competidores con citas y explicación; separar aparición sintética de tráfico referidor real.
- Experimentos pre/post con grupos comparables, tamaño de muestra y advertencia estadística; no garantías de recomendación.
- Recomendador de páginas de autoridad, FAQs genuinas, páginas de producto, evidencias, fuentes y relaciones editoriales.

### M05 — Content Studio / Autoblog
- Calendario editorial 30/60/90 días y formato Kanban; web articles, newsletters, social, vídeo, landings, casos de uso.
- Flujo: brief → fuentes → esquema → borrador → revisión factual → SEO → accesibilidad → brand QA → aprobación → publicación → medición → refresh.
- Editor rico con markdown/HTML, preview multidispositivo, versiones y cambios comparados; metadata, canonical, OG, imagen, esquema compatible, internal linking, CTA, alt text.
- Content scoring por rúbrica auditable, detección de afirmaciones no verificadas, duplicación y contenido sin valor; bibliografía.
- Soporte CMS adaptador (WordPress, Shopify, Webflow, Ghost, Wix, Framer, headless, Next.js, generic API/webhooks) por iteraciones verificadas.
- Auto-publicación opcional por dominio, contenido y riesgo; scheduled + retries idempotentes, rollback y reporte de estado real.
- Traducción/localización con transcreación y revisión; no producir cientos de páginas sin valor.

### M06 — Backlinks y autoridad editorial
- Discovery de menciones sin enlace, relaciones PR, socios de contenido legítimos, páginas de recursos, directorios pertinentes y perfil de backlinks.
- Cualificación: relevancia, calidad editorial, riesgo spam, nofollow/sponsored/ugc, tráfico referidor medido.
- Outreach draft + revisión humana, gestión de relaciones; NO granjas de enlaces ni intercambio masivo con finalidad manipuladora.
- Alertas de enlaces caídos, menciones de marca, desautorización solo como guía experta, informes de cobertura.

### M07 — Creative Studio (imágenes, banners, carruseles)
- Brief/objetivo, brand kit, biblioteca de anuncios, referencia autorizada, generación con IA mediante proveedor configurable.
- Editor con capas y export editable cuando sea posible (JSON del proyecto + SVG/canvas), plantillas originales, resize 1:1/4:5/9:16/16:9.
- Headlines, variantes CTA, overlays, visual hierarchy, safe areas, contraste WCAG, legibilidad móvil y puntuación heurística.
- Render previews por canal y tests de overflow/safe zones; conservar derechos y licencias de recursos.
- Batch variations y scoring explicable **estimado**, no declarar probabilidad real de ventas sin dataset.

### M08 — Motion / Video Ad Studio
- URL-to-video, script-to-video, image-to-video por proveedor autorizado, storyboard con escenas, hooks y CTA variantes.
- Editor de timeline: voz IA, locuciones naturales licenciadas, audio, subtítulos karaoke, animación tipográfica, B-roll, motion graphics, música con derechos, sonido, transiciones, keyframes y logotipo.
- Render MP4/WebM via Remotion+FFmpeg en workers aislados; 9:16, 16:9, 1:1; subtítulos SRT/VTT; miniatura asignable por pieza; versiones.
- Preview A/V web reproducible, validación loudness/no clipping, safe margins, frames negros, silencios, sincronía, contraste, duración, resolución, CTA y copyright.
- Avatares/rostros solo con permiso, transparencia cuando proceda, no suplantación ni testimonios inventados.
- Modelo coste por segundo/minuto/render, créditos bloqueados al reservar y conciliados al finalizar.

### M09 — Ads Campaign Manager
- Canal 1 Meta Ads autorizado; conectores posteriores: Google Ads, TikTok Ads, LinkedIn Ads, Microsoft Ads cuando permisos/aprobaciones estén disponibles.
- Campañas/ad sets/ads, objetivos, audiencias permitidas, ubicaciones, creatividades, copy, eventos, público geográfico, calendario, presupuestos y aprobación.
- Planificador de medios según CPA deseado y presupuesto; estimaciones con escenarios conservador/base/optimista, no promesas.
- Estado de integración y límites visibles; modo simulación cuando faltan credenciales. Nunca botón 'publicado' si la plataforma no confirmó.
- Guardias de gasto con políticas por usuario, techo diario/mensual, alertas, doble aprobación y kill switch.
- A/B creativo con umbrales mínimos, atribución de evento, ventanas compatibles, métricas spend/impressions/clicks/CTR/CPC/CPM/leads/CPL/sales/CPA/ROAS.
- Recomendaciones de pausado, sustitución, escalado basadas en evidencia; ejecución por consentimiento expreso.

### M10 — Landing & CRO Studio
- Editor visual de bloques drag/drop, landing por oferta/segmento, formularios y multi-step, subdominio propio, dominios personalizados verificados, certificados HTTPS.
- Plantillas propias para restaurantes, SaaS, ecommerce, servicios, fitness, inmuebles, eventos, etc.; CMS SEO técnicamente correcto.
- Experimentos A/B, tráfico por variantes, eventos de conversión, heatmaps **solo con consentimiento y proveedor compatible**.
- Captura de lead con CRM, anti-spam/recaptcha equivalente, dedup, consentimiento por finalidad, email/WhatsApp transaccionales donde proceda.
- Velocidad/Core Web Vitals, accesibilidad AA, mobile-first, caching, analytics UTM, preview y rollback.

### M11 — CRM, Sales y automatización
- Contactos, empresas, leads, pipeline por etapas, propietario, scoring explicable, tareas, actividad, fuentes, etiquetas y campos personalizados.
- Captación por formularios, Meta lead forms autorizados, webhooks, CSV, ecommerce y WhatsApp Business API con consentimiento y política vigente.
- Automatizaciones: lead → deduplicar → asignar → notificar → tarea → seguimiento → cita → oferta → compra → customer feedback.
- Consent ledger, políticas de retención, exportación/eliminación, supresión, preferencias y derecho de oposición; IA propone mensajes, humano aprueba campañas masivas.
- Integraciones CRM externas HubSpot, Salesforce, Pipedrive mediante permisos, habilitación gradual.

### M12 — Analytics & Attribution
- Data model unificado con eventos first-party consentidos (sin fingir cobertura absoluta), UTMs, conversiones GA4, GSC, Ads, ecommerce/Stripe/CRM.
- Segmentación por organización, marca, campaña, creatividad, contenido, canal, país, dispositivo, período y cohorte.
- Atribución configurable last non-direct / first / assisted cuando exista suficiente cobertura; reglas, ventana y datos faltantes visibles.
- Métricas comerciales verificadas: revenue, gross profit, ad spend, software fees, AI compute, CPL, CAC, LTV, payback, MER.
- Reports PDF/CSV/JSON y enlaces de vista limitada, alertas Slack/email/WhatsApp con los permisos adecuados.
- Modelos de experimentación con control y reportes de confianza en vez de causalidad inventada.

### M13 — Agent Orchestrator
- Agent Director planificador, Research Analyst, SEO Auditor, GEO Analyst, Content Editor, Fact Checker, Visual Director, Video Producer, Media Buyer, CRO Optimizer, CRM Assistant, Financial Analyst, Compliance Sentinel y QA Reviewer.
- Tareas por cola, scheduling, presupuesto máximo IA por job, límites, idempotencia, memoria por tenant, evidencia, observabilidad y reproducción.
- Planner produce plan JSON validado; cada agente devuelve artefacto + evidencias + costes + riesgos + estado; ejecutor solo con permisos concedidos.
- Clasificación de tareas: lectura (bajo), borrador (medio), publicar/cambiar presupuesto/borrar (alto); aprobación explícita para alto riesgo.
- Prompt-injection defense: web externa es dato no instrucciones; nunca permitir URL analizar → secretos, publicación o gastos.

### M14 — Agency / White Label
- Agencia master y subclientes con aislamiento, portal limitado y branding por cliente, dominios propios, informes personalizados y SLA.
- Facturación agency, reparto créditos/sedes, team utilization, clientes activos y profitability.
- Permisos delegados, flujos de aprobación del cliente, audit trail exportable.

### M15 — Enterprise + plataforma
- SSO/SAML opcional, SCIM, MFA, RBAC/ABAC, registros de acceso, IP allowlist opcional, sesiones, secrets rotation.
- DPA/RGPD, residencia de datos configurable sujeta a infraestructura, subprocesadores, retención, DSAR, consentimiento granular.
- Facturación Stripe, pago por uso, créditos con ledger inmutable, reintentos y reconciliación webhook; no contabilidad por números actualizados a mano.
- SLA/SLO, alertas/incident response, PITR backups, auditoría de dependencias, WAF, rate limiting, tenant quota y observabilidad.
- App API pública con claves scopeadas, OpenAPI, webhooks firmados y MCP **solo para lectura por defecto** y acciones de alto riesgo con confirmación externa.

## 6. Diferenciadores competitivos: 15 apuestas (propuestas, no exclusividades demostradas)
1. **Growth Graph:** conocimiento unificado marca → temas → contenidos → anuncios → leads → oportunidades → ventas → margen.
2. **AI Spend Guardian:** coste máximo por campaña, medio, modelo y usuario; approval escalonado y parada de emergencia.
3. **Proof-First Analytics:** cada tarjeta permite abrir fuente, muestra, fecha, limitaciones y cálculo.
4. **Opportunity Marketplace:** ranking por impacto económico estimado, probabilidad/certeza y esfuerzo, con supuestos editables.
5. **Creative DNA:** indexar componentes de anuncios (hook, duración, CTA, visual, locución) para aprender de resultados propios con comparaciones responsables.
6. **Brand Consistency Engine:** detecta promesas no respaldadas, tono incorrecto, logos/colores, claims sensibles y derechos.
7. **Closed-Loop Experiments:** hipótesis → variantes → aprobación → medición → aprendizaje → plan siguiente.
8. **Unified Local Growth:** SEO local, anuncios geográficos, landings por sede, citas y ventas, con configuración de negocios multipunto.
9. **Agent Activity Replay:** acción, input, output, modelo, costes, fuentes, usuario autorizador y posibilidad de revertir.
10. **Bring Your Own AI Provider:** múltiples proveedores y rutas, control de costes/calidad/fallback; sin dependencia total de uno.
11. **Conversion Repair Bot:** detects funnel breaks (formulario, píxel, checkout, eventos) y crea tareas o PR reversibles.
12. **Adaptive Budget Planner:** simula asignación orgánico/pago/producción bajo objetivos y restricciones, nunca ejecuta sin permiso.
13. **Privacy-Aware CRM:** consentimiento granular, retención y posibilidad de eliminar registros verificablemente.
14. **Explainable GEO Tracking:** muestras/fechas/idioma/versiones y diferenciación entre citas y visitas reales.
15. **Agency Profitability Cockpit:** costes de herramientas + compute + publicidad + equipo vs ingresos por cliente.

## 7. Flujo principal y pantallas
### Navegación
- Inicio / Growth Command Center
- Proyectos y Marcas
- Auditoría web
- SEO técnico
- Keywords y competencia
- AI Visibility (GEO/AEO)
- Content Studio
- Backlinks / Authority
- Creative Studio
- Video Studio
- Ads Manager
- Landing Pages
- Experiments / CRO
- CRM / Leads
- Analytics & Revenue
- AI Agent Center
- Automatizaciones
- Integraciones
- Equipo y accesos
- Facturación y créditos
- Agency / White Label
- Ajustes / Legal / Data Privacy / Logs

### Onboarding: 12 pasos de producto (no 12 formularios largos)
1. Registro, correo y workspace.
2. URL del negocio; análisis SOLO LECTURA.
3. Vista del conocimiento extraído y banderas de información incierta.
4. Confirmación de identidad, objetivos y público.
5. Creación de Brand Kit.
6. Propuesta de competencia y mercados.
7. Diagnóstico inicial; mostrar quick wins verificados.
8. Elegir foco: tráfico, leads, ventas o reputación.
9. Integraciones optativas y capacidades disponibles sin ellas.
10. Propuesta de plan con coste previo, prioridades y riesgos.
11. Aprobación de primer contenido, creatividad o landing demo.
12. Activación controlada de automatizaciones y reportes.

### Dashboard ejecutivo
Cards: ingresos atribuidos medidos, gasto total (medio + fees + IA), leads cualificados, coste por adquisición, tráfico SEO, visibilidad IA con incertidumbre, tareas de agentes, alertas, experimentos, próximos entregables y gasto presupuestado vs comprometido vs real. Cada dato enlaza a evidencia, no usar números de demostración en producción.

## 8. Priorización por fases (secuencia, no promesa de fechas)
**F0 Fundaciones**: repo, CI, UI design system, auth, organizaciones, RLS, roles, Stripe sandbox, observabilidad, demos. Gate: no fuga multi-tenant.
**F1 URL→Audit→Plan**: crawler seguro, brand extraction con confirmación, diagnóstico SEO, prioridades y dashboard con datos reales/demo rotulados. Gate: 10 dominios autorizados rastreados sin SSRF.
**F2 Content Engine**: keyword sources, topics, editor, evidence, versionado, export, WordPress publicado solo tras autorización. Gate: un artículo listo, indexabilidad técnica auditada, rollback.
**F3 GA4/GSC/GEO**: OAuth, ingest, métricas, prompt sampling y auditoría de cambios. Gate: fuente de cada cifra y marca temporal.
**F4 Creative Studio y Video**: plantillas, generación, storyboard, voice, subtítulos, render async, QA. Gate: 3 formatos reproducibles y assets con licencias.
**F5 Landing & CRM**: formularios seguros, consentimiento, tracking eventos, pipeline y automatización. Gate: lead desde landing a CRM sin pérdida ni duplicación.
**F6 Meta Ads**: OAuth/scopes, creative library, aprobación y lanzamiento con spend guardian. Gate: sandbox/test y luego cuenta real con consentimiento, logs e idempotencia.
**F7 Conversion & Experiments**: atribución parcial/real, tests A/B, márgenes y recomendaciones con supuestos. Gate: analítica reconciliada, no causalidad ficticia.
**F8 Agency & Enterprise**: white-label, multi-org, API/MCP, SSO opcional, export DPA, SLA. Gate: auditoría de seguridad y permisos.
**F9 Más canales**: Google Ads, TikTok, LinkedIn, Microsoft, marketplaces; cada integración se entrega solo después de validación de permisos/políticas.

## 9. Precios para NUESTRA plataforma (hipótesis de posicionamiento)
No son precios de mercado confirmados ni márgenes garantizados. Validar con costes de tokens, vídeo, ads APIs, hosting, soporte y willingness-to-pay.
| Plan propuesto | Cuota propuesta | Enfoque | Límites ejemplificativos |
|---|---:|---|---|
| Free Audit | 0 € | adquisición orgánica | 1 auditoría limitada, sin publicación ni anuncios, sin generación costosa ilimitada |
| Starter | 39 €/mes | un negocio | 1 marca, 1 usuario, SEO/AEO básico, créditos pequeños, CRM básico |
| Growth | 89 €/mes | pyme | 3 marcas, 3 usuarios, marketing creativo y contenidos con cuota |
| Pro | 179 €/mes | campañas intensivas | 10 marcas, 10 usuarios, automatizaciones, CRM/ads, más créditos |
| Agency | 349 €/mes | agencias | clientes, white-label limitado, aprobación de cliente, asignación de consumos |
| Enterprise | contrato | gran empresa | SSO, subprocesamiento/región, SLA, soporte, API, roles custom |

**Crucial:** gasto publicitario siempre separado, AI vídeo con créditos por uso, IVA/impuestos visibles, límites de costes duros. Pricing debe ser configurable por plan, sin valores hardcodeados en componentes.

## 10. Estrategia de mercado
- **Wedge inicial**: 'Pega tu URL, descubre 10 mejoras y genera tu primera campaña con landing + pieza + medición' con prueba gratuita económicamente limitada.
- ICP 1: pymes locales que necesitan leads; ICP 2: SaaS/ecommerce que quieren SEO+AEO; ICP 3: agencia con subclientes.
- Diferenciar por visibilidad económica, no por afirmaciones como 'primer puesto garantizado' o '100% automático'.
- Canales: SEO problem-based con herramientas gratuitas auditables, casos reales consensuados, demos, tutoriales, asociarse con agencias, referidos.
- Activación: primera auditoría validada, primer proyecto aprobado, primera publicación exitosa, primer lead registrado, primera conversión enlazada.
- Retención: informe económico semanal, alertas claras, insights de pruebas, editor con control total, calidad de soporte.
- Unidad económica: MRR, margen bruto por plan, coste IA por cuenta, churn mensual, CAC, recuperación CAC, cohortes, ratio abuso free tier.

## 11. Riesgos que cambian el proyecto
1. **Disponibilidad de API**: Meta/Google/TikTok/LinkedIn exigen permisos y, en ciertos casos, revisión de apps. Sin credenciales no afirmar integración activa.
2. **SEO spam**: Google prohíbe contenido masivo creado para manipular resultados y ciertos esquemas de intercambio de enlaces. Evitar clones de esquemas de backlinks automáticos.
3. **Atribución limitada**: cookies, bloqueadores, consentimientos, cambios de API y tráfico directo dificultan medir ventas exactas.
4. **Coste audiovisual**: vídeos ultrarrealistas + voz/composición no pueden prometerse gratis o ilimitados; medir por proveedor y job.
5. **Regulación UE**: RGPD, ePrivacy/cookies, conservación de datos, contacto comercial, Ley de IA y transparencia en materiales sintéticos cuando aplique.
6. **Prompt injection/SSRF**: una página web rastreada puede intentar ordenar a la IA mostrar secretos o realizar operaciones. Tratarla como entrada hostil.
7. **Propiedad intelectual**: generar diseño y código propios; inspiración en patrones de UX no equivale a licencia para copiar elementos protegidos.
8. **Seguridad multi-tenant**: pérdida de aislamiento y tokens publicitarios = incidentes graves.

## 12. Criterios de aceptación globales
- Ningún dato sensible de una organización visible por otra (pruebas RLS y E2E).
- Ningún cambio real de campaña, presupuesto, publicación, borrado o correo masivo sin scopes, autorización y log.
- Cada insight tiene: `source`, `observed_at`, `confidence`, `method`, `sample_size` si corresponde.
- Nunca fingir un estado 'activo' cuando un job falló o un proveedor no confirmó.
- Cada gasto de IA reserva presupuesto antes del trabajo y liquida el coste real; reintentos idempotentes.
- Cualquier automatización con efectos externos tiene dry-run, límites, audit log y rollback donde técnicamente proceda.
- Crawler bloquea localhost, IP privadas, metadata cloud, redirects peligrosas y escaneos no autorizados.
- Sitemaps, CMS, CTA, meta y JSON-LD pasan tests automáticos básicos; no prometer ranking.
- Consentimiento/tracking: no cargar píxeles no esenciales antes de una base jurídica válida.
- Calidad frontend: WCAG 2.2 AA como objetivo, mobile-first, LCP/INP/CLS controlados, loading/error/empty states.
- Tests unitarios, integración, contrato de API, E2E, seguridad; deploy reversible, backups y monitoreo.

## 13. URLs públicas verificadas (selección)
**Investigación de las dos plataformas:**
- https://www.babylovegrowth.ai/docs/dashboard/overview
- https://www.babylovegrowth.ai/docs/dashboard/analytics
- https://www.babylovegrowth.ai/docs/dashboard/content-plan
- https://www.babylovegrowth.ai/docs/dashboard/technical-audit
- https://www.babylovegrowth.ai/docs/dashboard/settings
- https://www.babylovegrowth.ai/docs/dashboard/backlinks
- https://www.babylovegrowth.ai/en/pricing
- https://adscena.es/
- https://adscena.es/precios
- https://adscena.io/
- https://app.adscena.es/condiciones
- https://app.adscena.es/inicio

**Competidores estudiados:**
- https://www.semrush.com/kb/1493-ai-visibility-toolkit
- https://ahrefs.com/all
- https://help.ahrefs.com/en/articles/11064852-what-is-brand-radar-and-how-to-use-it
- https://help.searchatlas.com/hc/searchatlas-help/articles/1786755570-how-to-set-up-ai-seo
- https://docs.surferseo.com/en/articles/7859434-what-is-surfer
- https://otterly.ai/llm-info/
- https://www.adcreative.ai/
- https://help.creatify.ai/en/collections/15631647-creative-tools
- https://academy.madgicx.com/lessons/what-is-madgicx
- https://docs.smartly.io/docs/introduction-to-smartly
- https://motionapp.com/
- https://www.foreplay.co/faq
- https://unbounce.com/product/features/
- https://metricool.com/ai-tools-social-media/

**Normas y APIs:**
- https://developers.google.com/search/docs/essentials/spam-policies
- https://developers.google.com/search/docs/fundamentals/using-gen-ai-content
- https://developers.google.com/search/apis/indexing-api/v3/using-api
- https://developers.facebook.com/docs/business-management-apis/2tier-bm-solution/get-started/
- https://developers.google.com/google-ads/api/docs/get-started/onboarding
- https://www.aepd.es/preguntas-frecuentes/17-internet-y-redes-sociales/FAQ-1707-importancia-de-las-cookies-en-la-proteccion-de-datos
- https://digital-strategy.ec.europa.eu/en/policies/guidelines-ai-transparency-obligations
- https://owasp.org/projects/top-10-for-large-language-model-applications
