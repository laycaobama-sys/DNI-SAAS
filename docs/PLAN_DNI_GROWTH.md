# PLAN MAESTRO — DNI Growth
### Especificación para ejecutar con Claude Code

> Copia este archivo en la raíz de tu repositorio como `docs/PLAN_DNI_GROWTH.md`.
> Claude Code lo leerá completo y lo ejecutará por fases.

---

## 0. Contexto y objetivo

**DNI Growth** (https://dnigrowth.com) es un SaaS español de crecimiento digital con IA: SEO, GEO y AEO, anuncios, landing pages, CRM y estudio de vídeo. Hoy en producción tiene:

- Auditoría pública con 31 reglas.
- Perfil de marca y plan de 30 días.
- Asesor con IA.
- Creative Studio.
- Conexión de solo lectura con Search Console y GA4.
- Multiempresa con roles y registro de auditoría.
- Registro con Google o email.
- Portada estática en Cloudflare con CSP estricta.

**El competidor a superar es BabyLoveGrowth (BLG).** Lo que ofrece:

- **Grow, 99 $/mes:** 30 artículos al mes publicados automáticamente en WordPress, Shopify, Webflow, Wix y por API.
- **Red de intercambio de backlinks:** unos 5.000 sitios, con un valor que anuncian de "$800+/mes".
- **Prompts seguidos en IA:** 10 al día en ChatGPT, Claude y Gemini.
- **Social:** Reddit/Quora, carruseles de Instagram y Facebook, y Google Business Profile.
- **Captación y venta:** prueba de 3 días, garantía de 90 días, 17 casos de éxito, G2 4.6/5, 12 herramientas gratuitas, 7 idiomas, afiliados, marca blanca y MCP para Claude.
- **Scale, 399 $/mes:** 120 artículos y 4 mercados.

**Objetivo.** Que DNI Growth sea **mejor que BLG** en tres cosas:

1. **Resultados reales y verificables.** Datos de Search Console, no estimaciones de Ahrefs.
2. **Ingresos medidos.** Del clic a la venta, a través de nuestro CRM y nuestra atribución.
3. **Confianza.** Empresa y datos en la UE, euros con IVA, transparencia total y cumplimiento legal.

El resultado de negocio que buscamos: más registros, más conversión a pago, menos cancelaciones, y clientes que **ven cada mes, con datos, lo que han recibido por lo que pagan**.

---

## 1. Reglas innegociables

Aplican a todas las fases. Si una tarea choca con una regla, la regla gana: anótalo en `docs/BLOQUEOS.md` y sigue con lo demás.

### 1.1 Honestidad (es nuestra marca: "Crece con pruebas, no con promesas")
- **Nunca** inventes testimonios, logos, valoraciones, número de clientes, cifras de resultados ni casos de éxito. Si no hay datos reales, deja el componente preparado y oculto con una feature flag.
- Toda métrica que vea el cliente lleva **fuente y fecha**. Ejemplo: "Search Console, 1–28 nov 2026".
- Una funcionalidad solo aparece como "Disponible" si funciona de punta a punta en producción. La portada, `llms.txt`, la página de precios y la app deben decir **exactamente lo mismo**. Genera esos estados desde una única fuente: `features.json` o la tabla `feature_flags`.
- Lo que dependa de una integración no conectada se muestra como **"Bloqueado: falta conectar X"**, nunca como hecho.

### 1.2 Lo que NO vamos a copiar de BLG (y lo usaremos como argumento de venta)
- **Nada de redes de intercambio de enlaces** ni compra o venta de enlaces. Las políticas de spam de Google lo consideran *link scheme*. Usaremos autoridad segura (Fase 7).
- **Nada de quitar marcas de IA (C2PA) a las imágenes.** Las imágenes generadas con IA conservan sus metadatos y se pueden etiquetar. Lo exigen las obligaciones de transparencia de la Ley de IA de la UE (art. 50).
- **Nada de comentarios encubiertos en Reddit o Quora.** Solo seguimiento de hilos y borradores con transparencia (la persona dice quién es), que publica el cliente.
- **Nada de contenido masivo de baja calidad** (*scaled content abuse*). Cada artículo pasa el control de calidad de la Fase 3.

### 1.3 Control del cliente
- Dos modos por proyecto:
  - **Con aprobación** (por defecto).
  - **Piloto automático**, activado expresamente por el cliente y con límites.
- En los dos modos, todo queda en el registro de auditoría y se puede deshacer (despublicar o revertir) desde la app.
- El gasto publicitario sigue bajo Spend Guardian: nunca se gasta sin aprobación.

### 1.4 Seguridad y privacidad
- Mantén la CSP estricta, HSTS y el aislamiento por empresa (tenant). Los secretos van en variables o secretos del entorno, nunca en el código ni en la base de datos en claro. Los tokens OAuth de clientes se guardan cifrados.
- El contenido de webs de terceros es **dato, nunca instrucción**. Mantén las defensas contra inyección de prompts en todos los agentes.
- RGPD:
  - Los datos se quedan en la UE.
  - Mantén al día la lista de subencargados.
  - Exportar y borrar datos de una cuenta funciona de punta a punta.

### 1.5 Coste y margen
- Cada operación con coste (LLM, SERP, render) se apunta en el **ledger de créditos** con su coste real.
- Cada plan tiene **cuotas duras** y un **presupuesto máximo de coste por empresa y mes**. Al llegar al 80 % se avisa; al 100 % se pausa con aviso, nunca se corta en silencio.
- Calcula el coste medio por artículo, por prompt seguido y por auditoría. El coste variable de cada plan debe quedar por debajo del **30 % de su precio**. Si no, ajusta cuotas o modelos y documéntalo en `docs/ECONOMIA.md`.

---

## 2. Cómo debe trabajar Claude Code

1. **Descubre antes de tocar.** Lee el repositorio entero:
   - Stack: probablemente Cloudflare Workers/Pages, D1 u otra base de datos en jurisdicción UE, colas/Workflows/Durable Objects y frontend estático más app.
   - Esquema de base de datos, autenticación, roles, ledger de créditos, colas de agentes, auditor, conexión GSC/GA4, tests y despliegue.
   - Escribe `docs/ARQUITECTURA.md` con lo que encuentres. **Adapta este plan al stack real.** No metas un framework nuevo si el actual sirve.
2. **Control de avance.** Crea y mantén:
   - `docs/STATUS.md`: tabla con cada tarea del plan, su estado (pendiente / en curso / hecho / bloqueado), PR o commit y cómo se ha verificado.
   - `docs/BLOQUEOS.md`: lo que solo puede hacer una persona (cuentas, verificaciones, claves, decisiones legales), con pasos exactos para el dueño.
   - `docs/CHANGELOG.md`: cambios visibles para el cliente.
3. **Ramas y commits.** Una rama por fase (`fase-0-arreglos`, `fase-1-pagos`, …) y commits pequeños con mensaje claro. Fusiona a la rama principal cuando pasen los tests.
4. **Feature flags.** Todo lo nuevo va detrás de una flag. Solo se activa en producción cuando cumple su "Definición de terminado".
5. **Tests obligatorios.** Unitarios para la lógica, integración para APIs y colas, y Playwright de punta a punta para los flujos críticos: registro, auditoría, pago, generación y publicación, cancelación.
6. **Despliegue.** Primero a staging (si no existe, créalo). Ejecuta los tests de punta a punta contra staging. Si pasan, despliega a producción y vuelve a verificar con una prueba rápida (smoke test). Ten documentado el rollback.
7. **No te pares por bloqueos humanos.** Construye con un modo de prueba o simulado claramente marcado (Stripe en modo test, por ejemplo), apunta el bloqueo y pasa a la siguiente tarea.
8. **Prioridad:** dinero y conversión → valor entregado → retención → adquisición.

### Modelos de IA (configurables en un solo archivo, `config/ai.ts` o equivalente)
- **Redacción de artículos:** `claude-sonnet-5-5`.
- **Revisión de calidad y comprobación de hechos:** `claude-opus-5-5`, solo en los planes que lo cubran.
- **Clasificación, extracción y tareas baratas:** `claude-haiku-5-5`.
- Para el seguimiento de visibilidad en IA hacen falta las APIs de cada motor (Fase 6).
- Consulta la skill `claude-api` para ver parámetros, caché de prompts y herramientas. Usa caché de prompts para el perfil de marca y las guías de estilo.

---

## 3. FASE 0 — Arreglos inmediatos (primer día)

| # | Tarea | Terminado cuando |
|---|---|---|
| 0.1 | **Una sola fuente de verdad para el estado de cada módulo.** Hoy la portada dice "Disponible" para Estudio de vídeo, Landing pages y CRM, y `llms.txt` dice "En desarrollo". Genera la portada, `llms.txt`, precios y app desde `features.json`. | Un test compara los tres y falla si no coinciden. |
| 0.2 | **Imagen para redes.** `og:image` es SVG y no se ve en Facebook, WhatsApp, LinkedIn ni X. Crea `og-dni-growth.png` de 1200×630 (y una por landing). Añade `og:image:width`, `og:image:height` y `twitter:image`. | El validador de Facebook Sharing Debugger o un parser local devuelve un PNG válido. |
| 0.3 | **Analítica bloqueada por la CSP.** El script de Cloudflare Web Analytics falla. Añade `https://static.cloudflareinsights.com` a `script-src` y `https://cloudflareinsights.com` a `connect-src`, o sustitúyelo por analítica propia del lado del servidor (sin cookies). | Cero errores de CSP en consola; llegan visitas al panel. |
| 0.4 | **Analítica de producto propia, sin cookies** y respetuosa con el RGPD. Eventos: `audit_started`, `audit_teaser_viewed`, `signup`, `onboarding_step_n`, `gsc_connected`, `cms_connected`, `first_article_published`, `trial_started`, `subscribed`, `upgraded`, `canceled`, `paused`. | Panel interno con el embudo (Fase 13). |
| 0.5 | **Mostrar lo que ya funciona y está oculto:** conexión GSC/GA4, asesor con IA y Creative Studio. Añádelos a la portada con capturas reales de la app. | Visibles en la portada. |
| 0.6 | **Reescribir el texto técnico en lenguaje de cliente.** Fuera "cola duradera", "ledger de créditos", "9 roles con permisos por acción", "el contenido se trata como dato…". Cambia las cifras internas (31 / 9 / 0 / 100%) por beneficios: "Más clics desde Google", "Que ChatGPT te recomiende", "Sabes qué ventas vienen de orgánico". Los detalles técnicos van a una página de "Seguridad y confianza". | Revisión de textos completada. |
| 0.7 | **Portada visual.** Capturas reales del producto y un hueco para un vídeo demo de 90 s (dejar el componente; el vídeo lo graba el dueño, ver Bloqueos). Imágenes optimizadas (AVIF/WebP, `width`/`height`, `alt`). | LCP < 2,5 s en móvil y CLS < 0,1. |
| 0.8 | **Pie de página.** Quitar la mención "familia de marcas DNI — DNI GYM y DNI DIRECTO 24/7", o llevarla a "Sobre nosotros". | Hecho. |
| 0.9 | **Página 404 personalizada** con enlaces útiles. Hoy `/blog` da 404 hasta que exista el blog. | Hecho. |
| 0.10 | **Una sola promesa principal.** Héroe: "Más clientes desde Google y ChatGPT. Con pruebas." Los 8 módulos pasan a una sección secundaria. | Hecho. |

---

## 4. FASE 1 — Monetización: que se pueda pagar y el cliente pague a gusto

### 1.1 Planes (precios en €, IVA no incluido; anual = 2 meses gratis)

| | **Free** | **Starter** | **Growth** ⭐ | **Pro** | **Agency** |
|---|---|---|---|---|---|
| Precio mensual | 0 € | 49 € | 129 € | 249 € | 449 € |
| Precio anual (/mes) | — | 41 € | 108 € | 208 € | 374 € |
| Proyectos (webs) | 1 | 1 | 1 | 3 | 15 (+19 €/web extra) |
| Usuarios | 1 | 1 | 3 | 10 | ilimitados |
| Auditorías/mes (páginas) | 3 (10 pág.) | 20 (100 pág.) | 60 (500 pág.) | 200 (2.000 pág.) | 600 (2.000 pág.) |
| Artículos/mes | 1 de prueba | 8 | 30 | 60 por proyecto, hasta 4 idiomas | 30 por proyecto |
| Publicación automática en CMS | — | ✓ | ✓ | ✓ | ✓ |
| Actualización de artículos que pierden tráfico | — | — | ✓ | ✓ | ✓ |
| Prompts seguidos en IA | 3 (semanal) | 10 diarios | 30 diarios | 100 diarios | 30 por proyecto |
| Motores de IA seguidos | ChatGPT | ChatGPT, Gemini | ChatGPT, Claude, Gemini, Perplexity, AI Overviews | ídem | ídem |
| Correcciones técnicas automáticas (plugin o app) | — | ✓ | ✓ | ✓ | ✓ |
| Oportunidades de autoridad y enlaces | — | 10/mes | 40/mes | 120/mes | 40 por proyecto |
| Carruseles y vídeos sociales | — | 4/mes | 12/mes | 30/mes | 12 por proyecto |
| Atribución de clic a venta (CRM) | — | — | ✓ | ✓ | ✓ |
| Informe mensual en PDF | — | ✓ | ✓ | ✓, con tu marca | ✓ marca blanca |
| Portal de cliente con marca blanca | — | — | — | — | ✓ |
| Soporte | email | email 48 h | email 24 h | prioritario + 1 sesión/mes | prioritario + gestor |

- **Cuotas configurables** en `config/plans.ts`. Ajústalas tras calcular costes (regla 1.5) sin cambiar el precio publicado.
- **Packs extra de pago único:** +10 artículos (29 €), +50 prompts (19 €/mes).
- **Descuentos por volumen** para quien gestione varias webs: 2–4 webs −10 %, 5–9 −15 %, 10+ −20 %.

### 1.2 Implementación de pagos (Stripe)
- Stripe Billing con Checkout y **Customer Portal** (cambiar plan, cambiar tarjeta, descargar facturas, cancelar).
- **Stripe Tax** para el IVA de la UE. Validar el NIF/VAT intracomunitario (inversión del sujeto pasivo B2B). Facturas con todos los datos fiscales y numeración correlativa.
- **Webhooks** idempotentes: `checkout.session.completed`, `customer.subscription.created/updated/deleted`, `invoice.paid`, `invoice.payment_failed`, `customer.subscription.trial_will_end`. Cada evento sincroniza el plan, las cuotas y los permisos de la empresa.
- **Prueba gratis de 7 días del plan Growth**, con tarjeta. Aviso por email 3 días y 1 día antes de cobrar. Cancelación en 1 clic.
- **Cambios de plan prorrateados.** Una subida se aplica al instante; una bajada, al final del periodo.
- **Pausar suscripción** 1–3 meses (alternativa a cancelar).
- **Cobros fallidos (dunning):** Smart Retries de Stripe, 3 emails y un aviso en la app. Periodo de gracia de 7 días antes de bajar a Free, **sin borrar nada**.
- **Página de precios:**
  - Interruptor mensual/anual.
  - Tabla comparativa completa.
  - Calculadora de valor ("lo que te costaría una agencia o un redactor"; dato orientativo y marcado como tal).
  - Preguntas frecuentes de facturación.
  - Garantía visible.
- Quita los textos "Próximamente", "precios orientativos" y "cuando la pasarela esté verificada" en cuanto Stripe esté en vivo.

### 1.3 Garantía medible de 90 días (mejor que la de BLG, porque se puede verificar)
- **Condiciones:**
  - Plan Growth o superior, 90 días seguidos de suscripción.
  - Search Console conectado desde el día 1.
  - Al menos el 80 % de los artículos propuestos aprobados o publicados.
  - Correcciones técnicas críticas aplicadas.
- **Métrica:** impresiones orgánicas en Search Console de los últimos 28 días al cumplir el día 90, frente a los 28 días anteriores al alta. Si no han subido, se devuelve el importe pagado.
- **Comprobación automática:**
  - Un job diario evalúa a quién le toca.
  - La app enseña el progreso de la garantía (gráfica más los requisitos cumplidos).
  - Si procede, el cliente pide el reembolso con 1 clic. La devolución se hace vía Stripe y se registra.
- La página legal de la garantía la escribes tú con las condiciones exactas. Marca en `BLOQUEOS.md` que el dueño debe revisarla con un abogado.

**Terminado cuando:** un test de punta a punta en modo test de Stripe cubre alta, prueba gratis, cobro, subida, bajada, pausa, cobro fallido, cancelación y reembolso por garantía, y las cuotas cambian correctamente en cada paso.

---

## 5. FASE 2 — Activación: del primer clic al primer resultado en menos de 10 minutos

### 2.1 Auditoría sin registro (adelanto)
- El formulario del héroe lanza una auditoría **ligera y anónima**:
  - Límite de 5 páginas.
  - Protección contra abuso: limitación por IP y Cloudflare Turnstile.
  - Caché de 24 h por dominio.
- Muestra un **adelanto** en una página `/auditoria/{id}`:
  - Nota global de 0 a 100.
  - Nota SEO, nota GEO/AEO y nota técnica.
  - Los **3 problemas más importantes** con su evidencia.
  - Contador de "otros N problemas detectados".
- El informe completo y el plan de 30 días se desbloquean al crear cuenta. Al registrarse, la auditoría se asocia a la cuenta.
- **Botón "Compartir mi nota"**, con su imagen OG dinámica, para que se difunda.
- **Comparar con un competidor** (pide su URL): engancha mucho.

### 2.2 Onboarding guiado (asistente de 6 pasos con barra de progreso)
1. **Confirmar marca** (ya existe): público, tono, objetivo, país e idioma.
2. **Competidores:** sugeridos automáticamente desde las SERP; el cliente confirma 3–5.
3. **Conectar Search Console y GA4** (ya existe): explica en una línea por qué ("para medir resultados reales y activar la garantía").
4. **Conectar el CMS:** WordPress, Shopify, Webflow, Wix, Ghost, webhook o API (Fase 4).
5. **Elegir el modo:** "Con aprobación" o "Piloto automático", más la frecuencia de publicación.
6. **Primer artículo:** se genera al momento y queda listo para revisar o publicar.

Más:
- Checklist de activación visible en el panel hasta completarla.
- Emails de ayuda si se queda atascado en un paso: a las 24 h y a los 72 h.

**Terminado cuando:** un test de Playwright completa el flujo URL → adelanto → registro → onboarding → primer artículo, y la mediana de tiempo hasta el primer artículo es menor de 10 minutos.

---

## 6. FASE 3 — Motor de contenido (llegar a BLG y superarlo)

### 3.1 Estrategia a partir de datos reales
- **Fuentes:**
  - Search Console del cliente: consultas en posición 4–20 con impresiones altas, consultas sin página dedicada y páginas que caen.
  - Proveedor de SERP y palabras clave: DataForSEO o equivalente, configurable (ver Bloqueos).
  - Competidores confirmados en el onboarding.
  - Preguntas de "Otras preguntas de los usuarios" (People Also Ask).
  - Los prompts de IA seguidos (Fase 6).
- **Agrupación por intención** (clústeres de temas) y detección de canibalización.
- **Calendario de 30 días** que el cliente puede editar, arrastrar y reprogramar. Cada tema muestra por qué se propone (fuente, volumen, dificultad, oportunidad en Search Console) y su prioridad por impacto, esfuerzo y certeza (como ya hace el auditor).

### 3.2 Generación de artículos
- **Voz de marca:** se aprende de 3–5 URLs del cliente más el perfil de marca, y se guarda como guía de estilo (con caché de prompts).
- **Proceso por pasos, con cola y reintentos:**
  - Investigación de SERP (qué cubren los 10 primeros resultados).
  - Esquema del artículo.
  - Redacción.
  - Datos y fuentes citadas con enlace.
  - Sección de preguntas frecuentes.
  - JSON-LD (Article, FAQPage, HowTo o Product según el tipo).
  - Enlaces internos a páginas reales del sitio, a partir del rastreo.
  - Enlaces externos de autoridad.
  - Meta title y meta description.
  - Slug.
  - Imagen destacada e infografía (Creative Studio, con metadatos de IA conservados).
  - Texto alternativo (alt) de las imágenes.
  - Bloque de autor (E-E-A-T).
- **Información propia:** cada artículo debe incluir algo que la competencia no tiene, por ejemplo productos o servicios reales del cliente, precios del perfil de marca (solo si el cliente los confirmó), experiencia o casos. No se inventan datos.
- **Idiomas:** español, inglés, portugués, francés, italiano, alemán y catalán para empezar, ampliable. Localización por mercado en el plan Pro.

### 3.3 Control de calidad (nuestra diferencia: "cada afirmación con fuente")
- **Nota de calidad de 0 a 100, desglosada:**
  - Cobertura de la intención frente a la SERP.
  - Originalidad (similitud con la SERP y con el propio sitio < umbral).
  - Afirmaciones verificadas con fuente (un modelo revisor comprueba cada dato numérico o factual).
  - Legibilidad.
  - SEO on-page.
  - Preparación para citas en IA: respuestas directas y estructura extraíble.
- **Por debajo de 75:** se reescribe automáticamente hasta 2 veces. Si sigue por debajo, va a revisión manual y **no se publica en piloto automático**.
- **Ritmo de publicación seguro:** sin picos masivos en sitios nuevos; subida progresiva.
- Comprobación de duplicados contra todo lo publicado en el proyecto.

### 3.4 Mantenimiento: lo que BLG no hace
- **Detector de contenido que pierde tráfico:** cada semana, a partir de Search Console, detecta páginas que pierden clics o posición y propone (o aplica, en piloto automático) una actualización: datos, secciones nuevas y fecha.
- **Canibalización:** detecta varias URLs que compiten por la misma consulta y propone fusionarlas con redirecciones 301.
- **Huecos de enlazado interno:** páginas huérfanas o con pocos enlaces entrantes.

**Terminado cuando:** en staging, para un sitio de prueba, se generan 5 artículos con nota ≥ 75, todas las afirmaciones con fuente, JSON-LD válido, imágenes con alt y enlaces internos que funcionan (sin 404), y su coste real queda registrado en el ledger.

---

## 7. FASE 4 — Publicación automática e integraciones

- **WordPress:** contraseñas de aplicación más REST API.
  - Categorías, etiquetas, imagen destacada y estado (borrador o publicado).
  - **Plugin propio "DNI Growth Connector"** para correcciones técnicas (Fase 5), schema y llms.txt.
- **Shopify:** app (OAuth) con blog articles, metafields SEO, y título y descripción de productos y colecciones. Integración con el catálogo para que los artículos enlacen productos reales.
- **Webflow** (CMS API), **Wix** (Blog API), **Ghost** (Admin API).
- **Webhook genérico y API REST** documentada con OpenAPI, para cualquier CMS.
- **Exportación** a Markdown, HTML y DOCX.
- **Publicación programada:** goteo (1 al día) o por lotes. Si una publicación falla, se reintenta y se avisa.
- **Despublicar o revertir con 1 clic** desde la app.
- **Comprobación tras publicar:** la URL responde 200, es indexable y aparece en el sitemap. Envío de la URL a la Indexing API solo donde esté permitido; si no, IndexNow para Bing y Yandex.

**Terminado cuando:** hay tests de integración contra WordPress local (Docker) y una tienda de desarrollo de Shopify. Lo que no se pueda probar por falta de credenciales queda en `BLOQUEOS.md` con el modo de prueba marcado.

---

## 8. FASE 5 — SEO técnico que se corrige solo

- El auditor (31 reglas) pasa de **detectar** a **corregir**. Con el plugin de WordPress o la app de Shopify conectados:
  - Meta title y meta description que faltan o están duplicados.
  - Etiquetas canonical.
  - JSON-LD de Organization, LocalBusiness, Product, FAQ y Breadcrumb.
  - `llms.txt`.
  - Texto alternativo (alt) de imágenes.
  - Enlaces rotos (propone redirecciones).
- Cada corrección muestra el antes y el después, se registra y se puede revertir.
- **Amplía las reglas** a más de 50:
  - Core Web Vitals (vía PageSpeed Insights API).
  - Hreflang.
  - Paginación.
  - Cadenas de redirecciones.
  - Contenido escaso (thin content).
  - Acceso de bots de IA en robots.txt (GPTBot, ClaudeBot, PerplexityBot, Google-Extended…), con una recomendación explicada.
  - Entidad de marca: `sameAs` y coherencia NAP (nombre, dirección, teléfono).
- **Rastreo semanal automático** con alertas cuando algo empeora (página desindexada, error 5xx, noindex accidental).

---

## 9. FASE 6 — Visibilidad en IA (GEO): saber si la IA te recomienda

- **Prompts seguidos:** se sugieren automáticamente a partir del negocio, los competidores y Search Console. El cliente los edita.
- **Motores** (con las APIs oficiales y búsqueda web activada):
  - ChatGPT: OpenAI Responses API con `web_search`.
  - Claude: Anthropic API con la herramienta de búsqueda web.
  - Gemini: con grounding en Google Search.
  - Perplexity: Sonar API.
  - Google AI Overviews: a través del proveedor de SERP.
- **Métricas por prompt y motor:**
  - ¿Te menciona?
  - Posición dentro de la respuesta.
  - Sentimiento.
  - ¿Te enlaza?
  - Qué competidores aparecen.
  - **Qué fuentes cita** (para saber dónde hay que estar).
- **Cuota de presencia** frente a competidores, con su evolución.
- **Recomendaciones accionables:** "Perplexity cita estas 5 páginas para tu prompt; te falta un artículo comparativo y estar en el directorio X". Cada recomendación puede convertirse en tarea o artículo con 1 clic.
- **Alertas:** "Has empezado a aparecer en ChatGPT para «X»" (celebración) o "Has dejado de aparecer".
- Como los resultados de los LLM varían, haz varias ejecuciones por medición y muestra el porcentaje de apariciones, no un sí o no.

---

## 10. FASE 7 — Autoridad y enlaces, en versión segura

Nuestro argumento de venta: **"Enlaces que no te ponen en riesgo de penalización."**

- **Menciones de marca sin enlace:** búsqueda de páginas que nombran la marca sin enlazar, con un email de petición preparado.
- **Enlaces rotos de la competencia:** páginas que enlazan a URLs muertas de competidores, para ofrecer nuestro contenido como sustituto.
- **Páginas de recursos** y **directorios relevantes y locales** de calidad (citaciones con NAP coherente).
- **PR digital:** cada mes se detectan temas de actualidad del sector y se prepara una nota o un dato propio para periodistas, con lista de medios. Envío solo con aprobación.
- **Alianzas editoriales:** sugerencias de colaboraciones reales (artículos invitados en webs del sector), no intercambios automáticos.
- **Envío** desde el buzón del cliente conectado por OAuth (Gmail u Outlook), siempre con aprobación por email. Seguimiento de respuestas y de enlaces conseguidos.
- **Panel de autoridad:** dominios que enlazan (fuente: Search Console → Enlaces, más el proveedor), enlaces nuevos y perdidos.

---

## 11. FASE 8 — Social y vídeo (aprovechar lo que ya tenemos)

- **De artículo a carrusel** (Instagram, Facebook y LinkedIn) **y a vídeo corto** con el Estudio de vídeo que ya existe (9:16 con subtítulos). BLG solo hace carruseles.
- **Calendario social.** Publicación directa cuando Meta y LinkedIn aprueben la app (ver Bloqueos); mientras tanto, descarga con 1 clic y aviso de "listo para subir".
- **Reddit y Quora:** seguimiento de hilos relevantes que citan los LLM, y borrador de respuesta útil **con transparencia** (la persona dice quién es) para que el cliente la publique él mismo. Nunca publicamos nosotros.
- **Google Business Profile:** auditoría y sugerencias de publicaciones y respuestas a reseñas. Publicación directa cuando Google conceda acceso a la API (ver Bloqueos).

---

## 12. FASE 9 — Resultados e ingresos: que el cliente VEA lo que recibe por lo que paga

Es lo más importante para que el cliente siga pagando y esté a gusto.

### 9.1 Panel "Tu mes con DNI Growth" (pantalla de inicio)
- **Trabajo entregado:**
  - Artículos publicados.
  - Artículos actualizados.
  - Correcciones técnicas aplicadas.
  - Oportunidades de enlaces.
  - Prompts seguidos.
  - Piezas sociales.
  - Cada número enlaza a su detalle.
- **Resultados con fuente y fecha:**
  - Clics, impresiones y posición media (Search Console).
  - Sesiones orgánicas y conversiones (GA4).
  - Apariciones en IA.
  - Comparación con el periodo anterior y con el mes antes del alta.
- **Ingresos:** contactos y ventas atribuidos a tráfico orgánico (CRM y atribución actuales), en € declarados por el cliente y marcados como tal. **BLG no puede hacer esto.**
- **Valor estimado del tráfico:** clics × CPC medio de esas palabras, marcado como "estimación".
- **Uso del plan:** barras de cuota ("18 de 30 artículos"), fecha de renovación y botón de packs extra.

### 9.2 Informes automáticos
- **Resumen semanal por email:** 3 datos y 1 acción recomendada.
- **Informe mensual en PDF y email:** trabajo hecho, resultados, próximos pasos. Con marca del cliente en Pro y marca blanca en Agency.
- **Alertas de logros:** primer artículo en el top 10, primera mención en ChatGPT, récord de clics.

### 9.3 Casos de éxito verificados (prueba social real)
- Con consentimiento expreso del cliente (casilla y acuerdo), se genera una **página de caso de éxito pública** con la gráfica sacada **directamente de la API de Search Console** y el sello "Verificado por DNI Growth · datos de Google Search Console · fecha".
- **Sello embebible** opcional para la web del cliente (enlace hacia nosotros).
- Programa de incentivo: 1 mes gratis por caso publicado.

---

## 13. FASE 10 — Retención: que el cliente esté cómodo y no se vaya

- **Cancelación honesta en la app:**
  - 1 encuesta de motivo.
  - Ofertas según el motivo: pausar, bajar de plan o un descuento del 30 % durante 2 meses una sola vez.
  - Si aun así quiere irse, cancela sin trabas.
  - Sus datos se conservan 90 días para volver.
- **Exportar todo** (artículos, informes, datos) en cualquier momento. La confianza retiene más que el miedo.
- **Puntuación de salud por cliente** (uso, conexiones, resultados, pagos). Las cuentas en riesgo disparan emails de ayuda y una alerta interna.
- **Emails del ciclo de vida** (proveedor configurable: Resend o Postmark):
  - Bienvenida.
  - Ayuda por pasos de onboarding.
  - Fin de la prueba gratis.
  - Primer resultado.
  - Resumen semanal.
  - Informe mensual.
  - Cuota casi agotada.
  - Pago fallido.
  - Recuperación de exclientes a 30 y 60 días.
  - Todos con baja en 1 clic y respetando las preferencias de consentimiento.
- **Centro de ayuda:** documentación, vídeos cortos y estado del servicio (`/estado`).
- **Chat de soporte con IA** basado en la documentación y en los datos de la cuenta del cliente (el asesor actual, ampliado). Se pasa a una persona si no resuelve.
- **NPS** a los 30 y 90 días. Con NPS de 9–10, se invita a dejar reseña en G2, Capterra o Trustpilot.

---

## 14. FASE 11 — Web de marketing y adquisición

### 11.1 Arquitectura SEO de dnigrowth.com
- **Páginas de producto:**
  - `/seo-con-ia`
  - `/redactor-blog-ia`
  - `/geo-posicionar-en-chatgpt`
  - `/aeo`
  - `/auditoria-seo-gratis`
  - `/seguimiento-visibilidad-ia`
  - `/enlaces-seguros`
  - `/seo-shopify`
  - `/seo-wordpress`
  - `/seo-local`
  - `/para-agencias`
- **Páginas por sector:** clínicas, despachos, e-commerce, restaurantes, inmobiliarias, gimnasios, reformas…
- **Comparativas honestas:**
  - `/comparativa/babylovegrowth` (DNI Growth vs BabyLoveGrowth: datos públicos verificables con fecha, sin descalificar).
  - Otras herramientas de SEO con IA.
- **Blog** escrito **con nuestro propio motor** (lo usamos nosotros mismos y se nota en Search Console). Nuestra gráfica será nuestro primer caso verificado.
- **Internacionalización:** español primero, luego inglés, portugués, francés e italiano. Hreflang y sitemaps por idioma.
- **Sitemap índice** dinámico, schema en cada página y `llms.txt` y `llms-full.txt` actualizados automáticamente desde `features.json`.

### 11.2 Herramientas gratuitas (cada una es una landing de SEO y una forma de captar contactos)

Se pueden usar sin registro, con límite por IP, y terminan con una llamada a la acción hacia la auditoría completa o la prueba gratis:

1. Auditoría GEO / visibilidad en IA (1 prompt, 1 motor).
2. Generador de llms.txt.
3. Comprobador de robots.txt y bots de IA.
4. Comprobador de sitemap.
5. Generador de Schema/JSON-LD.
6. Vista previa del resultado en Google (snippet SERP).
7. Comprobador de H1 y meta.
8. Palabras clave que te faltan frente a un competidor.
9. Calculadora del valor de tu tráfico.
10. Comprobador de enlaces rotos (hasta 50 URLs).
11. Comprobador de imagen OG para redes.
12. Generador de preguntas frecuentes para AEO.

### 11.3 Recursos para captar contactos
- Guías descargables en español, a cambio del email (doble opt-in):
  - "Cómo aparecer en ChatGPT".
  - "SEO para Shopify 2027".
  - "SEO local para pymes".
- **Academia gratuita** con lecciones cortas (a partir de los mismos contenidos).

### 11.4 Prueba social (solo real)
- Componentes listos y ocultos con una flag hasta tener datos reales: testimonios, logos, valoraciones de G2/Trustpilot, contador de clientes **sacado de la base de datos** (no escrito a mano) y casos verificados (Fase 9.3).

### 11.5 Kit de anuncios (para captar como BLG, pero mejor)
- Genera en `marketing/ads/`:
  - 10 guiones de vídeo de 20–30 s con el fundador a cámara (gancho, problema, prueba, llamada a la acción).
  - 10 textos para Meta.
  - 5 creatividades estáticas con plantillas "Antes / Después" que **solo** se rellenan con datos verificados de Search Console.
  - Audiencias sugeridas.
  - Landing específica por anuncio con UTM.
- Píxel y Conversions API de Meta, y conversiones mejoradas de Google, **solo con consentimiento** (banner de cookies conforme si se añaden cookies de terceros).

---

## 15. FASE 12 — Motores de crecimiento

- **Programa de afiliados:** 30 % recurrente durante 12 meses, cookie de 60 días, panel del afiliado y pagos mensuales. Usa una herramienta integrada con Stripe o una implementación propia.
- **Referidos de clientes:** 1 mes gratis para quien invita y para el invitado.
- **Agencias con marca blanca** (plan Agency):
  - Portal de cliente con su dominio y su logo.
  - Precios propios para revender.
  - Informes con su marca.
  - Gestión de muchos clientes desde un solo panel.
  - Facturación consolidada.
- **API pública y servidor MCP** ("DNI Growth para Claude"): consultar auditorías, generar artículos y leer métricas desde Claude u otros asistentes. Atrae a usuarios avanzados y a agencias.
- **Integraciones de distribución:** marketplace de apps de Shopify y directorio de plugins de WordPress (el plugin Connector gratuito trae usuarios).

---

## 16. FASE 13 — Operación interna: métricas, costes y estabilidad

- **Panel de administración** (rol interno):
  - MRR, ARR, altas, cancelaciones, ARPA y LTV.
  - Conversión de prueba a pago y embudo completo (Fase 0.4).
  - **Coste real por empresa y margen por plan.**
  - Cuentas en riesgo, colas y jobs fallidos.
- **Observabilidad:** logs estructurados, alertas de errores (correo o Telegram al dueño), monitor de disponibilidad y página de estado.
- **Colas:** reintentos con espera creciente, cola de mensajes muertos (DLQ) y panel para reintentar trabajos.
- **Copias de seguridad** diarias de la base de datos con una prueba de restauración documentada.
- **Límites de uso** y protección contra abuso en todos los endpoints públicos.

---

## 17. FASE 14 — Legal y cumplimiento (España y UE)

Redacta o actualiza estos textos. Todos se marcan en `BLOQUEOS.md` como "revisión por abogado antes de publicar".

- **Condiciones de uso** de suscripción: renovación automática, cancelación, cambios de plan y de precio con 30 días de aviso, y garantía.
- **Derecho de desistimiento de consumidores:** 14 días, con la excepción de contenido o servicio digital iniciado con consentimiento expreso. Hay que recoger ese consentimiento en el checkout.
- **Política de privacidad**, lista de **subencargados** (Stripe, proveedor de email, proveedores de LLM y su ubicación, proveedor de SERP), **DPA** descargable para clientes B2B y registro de actividades.
- **Transparencia de IA:**
  - Aviso de que el contenido se genera con IA y lo revisa un sistema de calidad.
  - Las imágenes de IA conservan sus metadatos C2PA.
  - Opción de etiqueta visible en las imágenes.
- **Cookies:** banner conforme (rechazar igual de fácil que aceptar) solo si se usan cookies no esenciales.
- **Facturación:** revisar con un gestor la obligación de VERI*FACTU o equivalente según la forma jurídica y los plazos vigentes.
- **Accesibilidad:** WCAG 2.2 AA en la web y en la app (navegación con teclado, contraste y etiquetas).

---

## 18. Calidad transversal

- **Rendimiento:** LCP < 2,5 s, INP < 200 ms y CLS < 0,1 en móvil, en la portada y en las landings.
- **Lighthouse ≥ 95** en SEO, accesibilidad y buenas prácticas.
- **Pruebas de punta a punta** de los flujos críticos en cada despliegue.
- Textos revisados por un asistente de estilo: español de España, tuteo, frases cortas, sin jerga.
- **Móvil primero** en toda la app (hoy la portada móvil está bien; mantenerlo).

---

## 19. BLOQUEOS HUMANOS: lo que tiene que hacer el dueño

Claude Code los apunta en `docs/BLOQUEOS.md` con pasos detallados y sigue trabajando con modos de prueba.

- [ ] **Stripe:** activar la cuenta (datos fiscales y bancarios), activar Stripe Tax y pasar las claves live a los secretos del entorno.
- [ ] **Google Cloud:** verificar la pantalla de consentimiento OAuth para los permisos de Search Console y Analytics (permisos sensibles: revisión de Google, puede tardar semanas). Dominio verificado y política de privacidad enlazada.
- [ ] **Claves de API:**
  - Anthropic.
  - OpenAI (seguimiento de ChatGPT).
  - Google Gemini.
  - Perplexity.
  - Proveedor de SERP y palabras clave (DataForSEO o similar).
  - PageSpeed Insights.
  - Proveedor de email (Resend o Postmark).
  - Cloudflare Turnstile.
- [ ] **Shopify Partners:** crear la app y pasar la revisión (para el marketplace).
- [ ] **WordPress.org:** publicar el plugin (revisión del directorio).
- [ ] **Meta / LinkedIn / Google Business Profile:** revisión de apps para publicar directamente.
- [ ] **Gmail / Outlook OAuth** para enviar emails de contacto desde el buzón del cliente (verificación de Google).
- [ ] **Abogado:** revisar condiciones, garantía, privacidad, DPA y textos de IA.
- [ ] **Gestor:** facturación e IVA (VERI*FACTU).
- [ ] **Vídeo demo** de 90 s y vídeos para anuncios grabados por el fundador.
- [ ] **Perfiles en G2, Capterra y Trustpilot.**
- [ ] **Primeros 5–10 clientes beta** (gratis o con descuento a cambio de un caso verificado).
- [ ] Decidir la **forma jurídica y los datos fiscales** que aparecen en facturas y aviso legal.

---

## 20. Definición de terminado global

DNI Growth está listo para superar a BLG cuando:

1. Un visitante puede auditar su web **sin registrarse** y ver resultados reales en menos de 60 segundos.
2. Puede registrarse, empezar la prueba gratis, conectar Search Console y su CMS, y tener **su primer artículo de calidad publicado en menos de 10 minutos**.
3. En piloto automático, el sistema genera, revisa, publica, mantiene y mide contenido **sin intervención**, dentro de las cuotas y con todo registrado y reversible.
4. El cliente ve cada mes **qué se hizo, qué resultados hubo (con fuente) y cuánto le ha aportado en contactos y ventas**.
5. Pagar, subir de plan, pausar, cancelar y pedir la garantía funciona solo, sin intervención humana.
6. Ninguna funcionalidad aparece como "Disponible" sin funcionar, y ninguna cifra pública está inventada.
7. El margen bruto de cada plan es ≥ 70 % con costes reales medidos.
8. Todos los tests de punta a punta pasan en producción y hay alertas configuradas.
