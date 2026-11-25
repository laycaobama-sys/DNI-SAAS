# Changelog — DNI Growth

Formato: fecha, versión desplegada en Cloudflare y cambios visibles. Las pruebas de cada entrada están en [IMPLEMENTATION_STATUS.md](IMPLEMENTATION_STATUS.md) y el estado del plan en [STATUS.md](STATUS.md).

## 2026-11-25

### Páginas que pierden clics e informe mensual por email — versión `f14057fe`
- **Search Console → «Páginas que pierden clics»:** compara cada página en los últimos 28 días con los 28 anteriores. Avisa si pierde al menos 10 clics y un 30 % de los que tenía, y explica la causa probable: baja de posición, menos búsquedas, menos clics con las mismas búsquedas, o ya no aparece. Se calcula sin IA y estos datos no salen de la plataforma. La sincronización importa ahora 250 páginas (antes 25) y también el periodo anterior, con el mismo permiso de solo lectura.
- **Informe mensual por email** a propietarios y administradores, entre el día 1 y el 7 de cada mes. Incluye el trabajo hecho (auditorías, contenidos aprobados, envíos a la web y publicaciones en redes) y los clics e impresiones de Search Console con fuente. Solo compara con el mes anterior si hay los mismos días. Nunca se envía dos veces; las organizaciones sin nada que contar no reciben nada. Baja en un clic. Añadido a la política de privacidad.
- Migraciones `0026` y `0027` aditivas (copia previa `backups/dni-growth-db-pre-0026-20261125.sql`).

### Herramientas que leen tu web, landings, comparativa, guía, blog y Meta activo — versión `6c8906bc`
- **4 herramientas gratuitas más** en `/herramientas` (ya son 12): «¿Tu web está preparada para ChatGPT?» (12 comprobaciones), palabras clave frente a un competidor, comprobador de enlaces rotos e imagen al compartir. Leen la web desde nuestro servidor con protección SSRF y límites por IP y diarios ([ADR 0026](adr/0026-captacion-guia-herramientas-publicas-iptc.md)).
- **12 landings**: SEO con IA, GEO en ChatGPT, auditoría SEO gratis, SEO para WordPress, SEO para Shopify (publicación directa «En desarrollo»), agencias y 6 sectores (clínicas, despachos, e-commerce, restaurantes, inmobiliarias, reformas). Todas con preguntas frecuentes, datos estructurados y el aviso de que nadie puede garantizar una posición.
- **`/comparativa/babylovegrowth`**: 11 filas, cada una con enlace a su fuente y fecha de comprobación, una sección de en qué va por delante BabyLoveGrowth hoy y una dirección para pedir correcciones.
- **Guía «Cómo aparecer en ChatGPT (2027)»** a cambio del email con doble confirmación. El email se borra al confirmar salvo que pidan novedades; los registros sin confirmar se borran a los 7 días. Política de privacidad actualizada. Migración `0025` aditiva (copia previa hecha).
- **Imágenes creadas con IA marcadas** con el metadato IPTC «trainedAlgorithmicMedia» (PNG y JPEG).
- **Meta activo:** la titular guardó la clave de la app y `/estado` comprueba cada hora que Meta la acepta (9 comprobaciones).
- **Blog:** 10 borradores en revisión en la organización «DNI Growth». No se publica ninguno sin la aprobación de la titular.
- Seguridad: la huella del email de la guía usa HMAC con clave, para que no se pueda revertir probando una lista de emails.

### WordPress y herramientas gratuitas — versión `a1038509`
- **Publicación en WordPress** (Starter o superior, [ADR 0025](adr/0025-publicacion-externa-meta-y-wordpress.md), [guía](WORDPRESS.md)): se conecta con una contraseña de aplicación y solo envía contenido aprobado, como borrador o publicado. Envíos repetidos actualizan la misma entrada; un reintento tras un corte no la duplica; «Retirar» la pasa a borrador. Al desconectar se revoca la contraseña en WordPress. Probado contra un WordPress real (Playground).
- `/precios`: «Publicación en tu blog o CMS» pasa de «En desarrollo» a **Parcial** (WordPress sí; Shopify, Ghost y Webflow en desarrollo). Integraciones y la bienvenida (paso «Conecta tu CMS») lo reflejan.
- **`/herramientas`** con 8 herramientas gratuitas que funcionan en el navegador del visitante (nada se envía): robots.txt y bots de IA, llms.txt, JSON-LD, FAQ para AEO, vista previa en Google, sitemap, Open Graph y valor del tráfico. Cada una tiene su página indexable con datos estructurados, preguntas frecuentes y llamada a la auditoría gratuita. Están en el sitemap y enlazadas desde la portada, precios, blog y 404.
- Migración `0024` aditiva (copia previa `backups/dni-growth-db-pre-0024-20261125.sql`).

### Facebook e Instagram — versión `aec5e64b`
- Módulo **Redes sociales** (Starter o superior): conectar páginas de Facebook y cuentas profesionales de Instagram, escribir con imagen, aprobar y publicar solo a la hora programada. Botón de pausa, comprobación previa de las reglas de Instagram y nunca dos veces la misma publicación.
- **Parcial** hasta que la titular guarde la clave de la app de Meta y Meta apruebe la app ([BLOQUEOS §0](BLOQUEOS.md)). Hasta entonces la pantalla dice «Muy pronto» y `/precios` dice «En desarrollo».
- Migración `0023` aditiva (copia previa hecha).

### Confianza: `/estado`, copias diarias y auditoría propia — versión `6f914e1f`
- **`/estado`** público: 8 comprobaciones reales cada 5 minutos (web, API, auditoría, colas, pagos, Google, email y copias), con historial de 90 días. Aviso por email a la titular a la segunda caída seguida y al recuperarse.
- **Copia diaria de la base de datos** a R2 en la UE (30 días). Restauración real probada ([RESTAURACION.md](RESTAURACION.md)).
- Cada despliegue ejecuta la auditoría propia de dnigrowth.com y falla si baja de 100/100.

### Precios honestos y base profesional — commit `3fe5365`
- Lo que está «En desarrollo» se muestra como «Próximamente · incluida sin coste extra», nunca con ✓; un test lo impide.
- Requisitos de la garantía con su estado y qué hacer. Buzones por función, `/subencargados`, borrador de DPA (pendiente de abogado) y `security.txt`.

## 2026-11-24

### Cada plan abre lo que se paga y cobros sin fallos — versión `8015e5ff`
- Lo que vende `/precios` y lo que abre cada plan coinciden, y hay pruebas que lo comprueban fila a fila ([ADR 0024](adr/0024-planes-y-reconciliacion-stripe.md)).
- Free: un artículo con IA al mes. Starter: además Google Analytics, enlaces y vídeo. `/precios` separa Search Console (todos los planes) y Analytics (desde Starter).
- El plan solo se activa cuando Stripe confirma el pago; una prueba gratuita nunca aparece como pagada; un adeudo bancario pendiente no abre el plan hasta que se cobra.
- Si un aviso de Stripe se pierde: al volver del pago la página pregunta a Stripe y activa el plan; además, cada hora se revisan los pagos sin noticias y los periodos vencidos (renovados o cancelados). Solo lecturas; los créditos del plan se dan una sola vez.
- Inicio de sesión con Google con exactamente los permisos registrados en Google (`openid email`).
- Sin cambios de precios ni de límites; sin migración.

### Activación (Fase 2) — versión `4c47d2b4`
- Auditoría gratuita sin registro desde la portada: revisamos hasta 5 páginas públicas con las mismas reglas que el análisis completo, sin IA ni créditos. Límites por IP y diario, caché de 24 h por dominio.
- Página `/auditoria/{id}` con nota global y por áreas (Técnica, SEO, GEO/AEO) con su palabra («Bien», «Mejorable», «Urgente»), los 3 problemas que más pesan con evidencia y solución, «otros N problemas» al crear la cuenta, botones para compartir y comparación con un competidor. No se indexa.
- Al registrarse desde la auditoría, esta pasa a la cuenta y el análisis completo queda preparado con la misma web.
- Bienvenida de 6 pasos (marca, competidores, Google, CMS, modo de trabajo y primer artículo) con barra de progreso; el estado sale de los datos reales. Lista de activación en el panel.
- Correos de ayuda a las 24 h y 72 h del alta, una sola vez, solo si queda algo pendiente y con baja en un clic.
- Política de privacidad: auditoría gratuita (se borra a los 30 días si no se crea cuenta), correos de ayuda y almacenamiento local.
- Sin cambios: precios, planes y el resto de páginas. Migración `0021` solo añade tablas (copia previa de la base de datos).
- Lo que aún no está y la app lo dice: conexión con CMS (WordPress, Fase 4) y piloto automático real; la imagen social es fija.

### Stripe en real (2026-11-23, 22:35 UTC)
- La titular guardó la clave real de «DNI Growth-IA». La plataforma creó sola, en modo real, los 4 planes (mensual y anual), el portal de cliente, el IVA (Stripe Tax automático) y el webhook firmado.
- `/api/v1/public/pricing-status` → pagos abiertos al público.

## 2026-11-23

### Cobros (Fase 1) — versiones `14e84da0`, `d8403160`, `c91a496a` y siguiente
- Planes nuevos: Starter 49 €, Growth 129 € (7 días de prueba), Pro 249 € y Agency 449 € al mes; anual con 2 meses gratis. IVA aparte.
- Aceptación de condiciones obligatoria antes de pagar, con su versión guardada.
- Pausa de 1 a 3 meses, oferta de permanencia (30 % durante 2 meses, una vez y solo si el motivo es el precio) y bajada de plan; cancelar sigue a un clic.
- Impago: 7 días de gracia con el plan intacto y después Free sin borrar nada.
- Garantía medible de 90 días (Growth, Pro y Agency) con requisitos comprobables y continuidad (una pausa o el paso a Free la reinicia).
- Página `/precios` generada desde el catálogo, con comparativa honesta («Disponible» / «En desarrollo»), calculadora con los números del visitante y JSON-LD sin valoraciones.
- `BILLING_ENABLED="auto"`: el pago se abre al público solo con clave real y cuenta verificada por Stripe; estado público en `/api/v1/public/pricing-status`.
- El plan elegido en `/precios` se recuerda durante el alta y lleva a Facturación.
- Corregido: el nombre del cupón superaba los 40 caracteres de Stripe y la sincronización automática fallaba.
- Productos en Stripe con nombre legible («DNI Growth · Plan Growth»).
- Las direcciones legales que muestra Stripe (`/terminos-y-condiciones`, `/politica-de-privacidad`, `/soporte`) y alias cortos redirigen a las páginas reales.
- Red de seguridad: una suscripción cancelada al final del periodo pasa a Free 2 días después aunque no llegue el aviso de Stripe.
- Embudo de cobros en la analítica propia: prueba iniciada, suscripción, subida de plan, pausa y cancelación.
- Lista de proveedores: el monitor GEO aparece como conectado (antes figuraba como «previsto» aunque ya funcionaba).

### Stripe, cuenta real «DNI Growth-IA» (panel de Stripe)
- Comprobado: cuenta activa, pagos y payouts activos, sin tareas pendientes; datos públicos de DNI Growth.
- Archivados los 3 productos antiguos de RestoPanel (0 suscripciones).
- Deshabilitados los 2 webhooks antiguos hacia resto-panel.com.

### Web pública (Fase 0)
- Fuente única de funciones y precios para portada, `/precios`, `llms.txt` y JSON-LD.
- Analítica de producto propia, sin cookies ([ADR 0021](adr/0021-analitica-producto-sin-cookies.md)).
- Página `/seguridad` y página 404.
- Condiciones de uso y contratación (versión 2026-11-23) y garantía, pendientes de revisión por abogado.
