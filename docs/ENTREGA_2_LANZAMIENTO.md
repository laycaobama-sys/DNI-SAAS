# Entrega 2 para Claude Code: lanzamiento público de DNI Growth

> **Cómo usarlo:** pega este archivo completo en Claude Code, dentro del repositorio de dnigrowth, en modo "auto". Guárdalo también como `docs/ENTREGA_2_LANZAMIENTO.md`.

---

Eres el ingeniero principal de DNI Growth. Sigues ejecutando `docs/PLAN_DNI_GROWTH.md`. Este documento **tiene prioridad sobre el orden de fases del plan**: recoge una auditoría externa de producción hecha el 25 nov 2026 y fija qué hace falta para abrir el SaaS al público como producto profesional.

**AUTORIZACIÓN:** la titular te autoriza a trabajar de forma autónoma (código, migraciones, tests, despliegues a staging y producción con tests en verde, configuración de Cloudflare y Stripe por API) sin pedir confirmación.

**Lo que sigue siendo solo de la titular** (anótalo en `docs/BLOQUEOS.md` y no lo hagas):
- Clics irreversibles en paneles de terceros.
- Escribir claves o contraseñas.
- Aceptar contratos o condiciones en su nombre.
- Gastar dinero.
- Enviar correos en su nombre a terceros nuevos.
- Firmar o aprobar textos legales.

Mantén igual que hasta ahora tus reglas de honestidad: nada "Disponible" sin funcionar y ninguna cifra o testimonio inventado.

---

## A. Resultado de la verificación externa (25 nov 2026)

### Funciona y está bien (no lo rompas)
- **Auditoría gratuita sin registro:** de punta a punta en ~12 s. Muestra nota, 3 problemas, "compartir", "compárate con un competidor" y CTA al informe completo. Sin errores de red ni de JavaScript.
- **Registro de estados coherente:** portada, `llms.txt` y `/precios` dicen lo mismo en todos los módulos.
- **Precios:** `/precios` con mensual/anual, comparativa con columna "Estado hoy", calculadora y FAQ de facturación. Sin desbordamiento horizontal en móvil.
- **Stripe en real:** `paymentsOpen: true`.
- **Imagen OG en PNG.** Portada reescrita en lenguaje de cliente. `/seguridad`, `/blog` con RSS y sitemap actualizado.
- **Aviso legal** completo según la LSSI. Garantía con condiciones exactas y medición con Search Console. Términos versionados.

### Problemas encontrados (por gravedad)

| # | Gravedad | Problema | Evidencia |
|---|---|---|---|
| P1 | **Bloqueante** | Los planes de pago dependen de **IA gratuita**: Gemini en nivel gratuito, modelos gratuitos de OpenRouter y Groq. `/precios` lo dice literalmente ("Content Studio redacta con IA gratuita"). | Riesgos: (a) límites de uso diarios que dejan sin servicio a clientes que pagan; (b) en los niveles gratuitos el proveedor puede usar las entradas para mejorar sus productos, y los términos de la API de Gemini restringen el nivel gratuito para servicios ofrecidos a usuarios del EEE, Suiza y Reino Unido (**compruébalo en los términos vigentes**); (c) contradice la promesa "enterprise" y la política de privacidad si no se declara; (d) suena mal a quien paga 129 €. |
| P2 | **Bloqueante** | La tabla de precios marca **✓ en planes de pago para funciones "En desarrollo"**: publicación en CMS, correcciones técnicas automáticas, actualización de artículos que pierden tráfico. | Se cobra por algo que aún no existe. Riesgo de reclamaciones de consumo y reembolsos. |
| P3 | **Bloqueante** | `/legal/garantia` muestra en público "Texto pendiente de revisión por un abogado antes del primer cobro real", con los pagos ya abiertos. | Resta confianza. La revisión es tarea de la titular (B1). |
| P4 | Alta | La **garantía exige** "correcciones técnicas críticas aplicadas" y "80 % de artículos propuestos aprobados o publicados", pero la publicación en CMS y las correcciones automáticas están en desarrollo. | El cliente tiene que poder cumplir los requisitos con lo que hoy existe, y entenderlo. |
| P5 | Media | Cloudflare **inyecta su beacon de Web Analytics** y la CSP lo bloquea en todas las páginas (error en consola). El aviso legal dice "sin analítica". | Error en consola en `/`, `/precios`, `/blog`, `/seguridad` y `/legal/*`. |
| P6 | Media | **La auditoría de nuestra propia web no saca 100** ("en casa del herrero"). | Nota 92: título de la portada de 67 caracteres; meta description de 173 en `/precios` y `/seguridad`; sin JSON-LD en `/seguridad` y `/legal/privacidad`; y 1 problema más que se ve en el informe completo. |
| P7 | Media | **Blog vacío** ("Todavía no hemos publicado artículos") pero incluido en el sitemap. | `/blog` |
| P8 | Media | **No existen** `/herramientas`, `/estado` ni `/comparativa/babylovegrowth` (404). La portada sigue **sin capturas reales ni vídeo**. | Pierdes captación orgánica y conversión. |
| P9 | Baja | Todo el contacto va a `privacidad@dnigrowth.com` (soporte, facturación, legal). Las páginas legales no tienen `og:image`. | Imagen poco profesional. |
| P10 | Aviso | En Google Auth Platform figura el dominio autorizado `composio.dev`, que no es nuestro. | Ver C3. |

---

## B. Tareas en orden

Cada tarea tiene su "Terminado cuando". Actualiza `docs/STATUS.md` al cerrar cada una.

### B0. Corrección de textos y precios (hoy, antes que nada más)

1. **P2: Tabla de precios honesta.**
   - En las columnas de cada plan, toda función "En desarrollo" se muestra como **"Próximamente · incluida sin coste extra"**, nunca ✓.
   - Revisa también por API las **descripciones de producto y precio en Stripe**, el texto del Checkout, los emails y la página de Facturación de la app: nada promete funciones en desarrollo.
   - Genera todo desde el registro de estados que ya existe.
   - *Terminado cuando:* un test falla si una función con estado ≠ Disponible/Parcial aparece con ✓ en algún plan o texto de pago.
2. **P1 (parte de texto):** quita "IA gratuita" de todos los textos públicos. Explica qué modelos y proveedores se usan en la página de subencargados (B2.4).
3. **P4: Requisitos de la garantía alcanzables con lo que existe hoy.**
   - "Correcciones críticas aplicadas" se comprueba con la siguiente auditoría, la haga a mano el cliente o la herramienta.
   - "Artículos aprobados" se cuenta en Content Studio, sin publicación en CMS.
   - Muestra en Facturación una **lista de requisitos con estado y qué hacer** en cada uno.
   - **No cambies el sentido de las condiciones:** si hace falta cambiar el texto legal, prepara la nueva versión en un borrador (`termsVersion` nueva) y apúntalo en BLOQUEOS para la revisión del abogado. Las suscripciones ya existentes conservan la versión aceptada.
4. **P3:** no quites la nota "pendiente de revisión" hasta que la titular confirme en `BLOQUEOS.md` que el abogado lo ha revisado. Cuando lo confirme, quítala de todas las páginas legales y publica la versión revisada.

### B1. IA de pago fiable para clientes de pago (P1)

1. **Router de proveedores** por plan, en un único archivo de configuración:
   - **Planes de pago:** proveedor de pago con términos de no-entrenamiento y procesamiento adecuado para el RGPD. Por defecto, la API de Gemini en nivel de pago (Flash para redactar y Pro o Flash para revisar), porque ya está integrada y la clave existe. Se activa en cuanto la titular habilite la facturación del proyecto (BLOQUEO B-IA).
   - **Plan Free:** solo proveedores cuyos términos permitan usarlos con usuarios del EEE. Si ninguno gratuito lo permite, limita el Free a funciones sin IA (auditoría, informe, plan) más un número muy bajo de consultas en el nivel de pago, con tope de coste.
   - Respaldo automático entre proveedores, con reintentos y espera creciente. Si falla todo, la tarea queda en cola y se avisa al cliente; nunca falla en silencio.
   - Anthropic y OpenAI quedan preparados en el router y desactivados hasta que haya claves (de pago, no compradas).
2. **Techo de gasto:**
   - Presupuesto mensual global (variable `AI_MONTHLY_BUDGET_EUR`, por defecto 30 €) y presupuesto por organización según el plan (regla 1.5 del plan).
   - Al 80 %: alerta a la titular. Al 100 %: degradar a modelos más baratos; nunca superar el techo global.
   - El coste real de cada llamada va al ledger.
3. **Monitor de visibilidad en IA:** debe usar el mismo router y el nivel de pago en los planes de pago.
4. **Comprobación de límites:** prueba de carga en staging con 50 artículos seguidos. Debe completarse sin errores de cuota y registrar el coste medio por artículo en `docs/ECONOMIA.md`.
5. *Terminado cuando:* (a) ningún cliente de pago usa niveles gratuitos; (b) `docs/ECONOMIA.md` muestra el margen por plan con costes reales; (c) la página de subencargados lista cada proveedor de IA con ubicación y finalidad.

### B2. Base profesional y "enterprise"

1. **P5:** desactiva por la API de Cloudflare la inyección automática de Web Analytics (RUM) en la zona, para que coincida con "sin analítica de terceros". Mantén la analítica propia sin cookies.
   - *Terminado cuando:* cero errores en consola en todas las páginas públicas (test de Playwright que recorre el sitemap).
2. **P6:** corrige los problemas que nuestra propia auditoría detecta en dnigrowth.com.
   - *Terminado cuando:* la auditoría gratuita de dnigrowth.com da **100/100** y un test de CI lo comprueba en cada despliegue.
3. **P9: buzones por función:** `soporte@`, `facturacion@`, `legal@` y `privacidad@` (Cloudflare Email Routing hacia el buzón de la titular). Cambia cada texto al buzón que le corresponde. Añade `og:image` a las páginas legales.
4. **Página `/subencargados`** (Cloudflare, Stripe, proveedores de IA, Google APIs y email) con ubicación, finalidad y fecha. **DPA descargable** (borrador pendiente de abogado, marcado como tal). Enlázalo desde privacidad y seguridad.
5. **Seguridad de cuentas:**
   - 2FA con TOTP opcional para usuarios y obligatoria para propietarios de organizaciones en Pro y Agency.
   - Sesiones activas visibles con opción de cerrarlas.
   - Exportación del registro de auditoría (CSV).
   - `/.well-known/security.txt`.
6. **Página `/estado`:**
   - Comprobaciones sintéticas cada 5 minutos (cron de Workers): portada, API, auditoría anónima de prueba contra una página propia, webhook de Stripe (último evento recibido), colas, y sincronización de Search Console y Analytics.
   - Historial de 90 días y alertas a la titular (email o Telegram si existe).
7. **Copias de seguridad:** exportación diaria de la base de datos a R2 (jurisdicción UE), conservada 30 días, más una **prueba de restauración documentada** en `docs/RESTAURACION.md`.
8. **Emails transaccionales:**
   - Comprueba que existen y funcionan: bienvenida, aviso de fin de prueba (3 días y 1 día antes), pago fallido, cancelación, garantía y resumen semanal.
   - Si no hay proveedor, deja integrado Resend (su nivel gratuito basta para empezar), con la DNS (SPF, DKIM y DMARC) configurada por API en Cloudflare. La creación de la cuenta y la clave quedan en BLOQUEOS.
   - Activa en Stripe por API los emails de recibos y de aviso de fin de prueba.
9. *Terminado cuando:* todo lo anterior tiene test o comprobación sintética, y `docs/STATUS.md` lo refleja.

### B3. Entregar lo que se vende: de "En desarrollo" a "Disponible"

Ninguna de estas tareas necesita aprobación de terceros.

1. **Publicación en WordPress:**
   - Conexión con contraseñas de aplicación y la REST API.
   - **Plugin "DNI Growth Connector"** descargable como zip desde la propia app (no hace falta el directorio de WordPress.org). Incluye publicar y despublicar, imagen destacada, categorías, metadatos SEO compatibles con Yoast y Rank Math, JSON-LD y `llms.txt`.
   - Tests contra WordPress en Docker.
   - Cuando funcione de punta a punta, cambia su estado a **Disponible** en el registro.
2. **Webhook genérico y API** con documentación OpenAPI, más **Ghost** y **Webflow** (con token del cliente).
3. **Shopify:** conexión con el token de una app creada por el propio comerciante, por la vía que Shopify permita hoy (compruébala en su documentación vigente). Artículos de blog más metadatos SEO de productos y colecciones. La app pública del marketplace queda en BLOQUEOS.
4. **Correcciones técnicas automáticas** a través del plugin: títulos, metas, canonical, JSON-LD, `alt` e `llms.txt`. Cada una con el antes y el después, registrada y reversible.
5. **Artículos que pierden tráfico:** detección semanal con los datos de Search Console ya sincronizados.
   - **Importante:** la política de privacidad y la verificación de Google declaran que los datos de Google **nunca se envían a modelos de IA**. Mantenlo así.
   - La detección es **determinista** (sin IA). El cliente ve la propuesta y, si quiere reescribir, el LLM recibe **solo el contenido público de su página**, nunca los datos de Search Console.
   - No cambies el uso de datos de Google mientras dure la verificación.
6. **Informe mensual por email,** automático, con el trabajo hecho y los resultados con fuente.
7. *Terminado cuando:* para cada función, test de punta a punta en staging, estado actualizado en el registro y entrada en `CHANGELOG.md`. Solo entonces deja de aparecer como "Próximamente".

### B4. Captación: que llegue gente nueva cada día

1. **`/herramientas` con 12 herramientas gratuitas** (lista en la sección 11.2 del plan):
   - Cada una con su landing indexable, schema y límite por IP.
   - Terminan con una CTA hacia la auditoría.
   - Sin IA de pago en las herramientas anónimas (deterministas), salvo tope de coste.
2. **Landings:**
   - De producto: `/seo-con-ia`, `/geo-posicionar-en-chatgpt`, `/auditoria-seo-gratis`, `/seo-wordpress`, `/seo-shopify`, `/para-agencias`.
   - **6 de sector:** clínicas, despachos, e-commerce, restaurantes, inmobiliarias, reformas.
   - Con contenido útil real, no plantillas vacías.
3. **`/comparativa/babylovegrowth`:**
   - Datos públicos verificables con fecha y fuente: precios en USD frente a EUR con IVA, empresa en EE. UU. frente a la UE, red de intercambio de enlaces frente a enlaces seguros, imágenes sin C2PA frente a transparencia de IA.
   - Tono respetuoso y sin afirmaciones que no se puedan probar.
4. **Portada:**
   - **Capturas reales** de la app, sacadas con Playwright de la organización "Demo verificación Google" sin datos de terceros.
   - **Vídeo demo de 60–90 s** grabado con Playwright más subtítulos (y voz sintética opcional), mostrando URL → auditoría → plan → borrador → Search Console.
   - Imágenes en AVIF/WebP con `width`, `height` y `alt`.
   - *Terminado cuando:* LCP < 2,5 s en móvil.
5. **Blog:**
   - Prepara en Content Studio **10 borradores** (temas: cómo aparecer en ChatGPT, llms.txt, AEO para pymes, SEO para Shopify, SEO local en España, auditoría técnica paso a paso, datos estructurados, Search Console para principiantes, GEO frente a SEO, cómo elegir una herramienta de SEO con IA).
   - El blog dice "revisado por una persona": **no publiques ninguno sin la aprobación de la titular** en la app. Apúntalo en BLOQUEOS como tarea de 30–60 minutos.
   - Al aprobarse, se publican con un ritmo de 2 por semana.
6. **Captación de contactos:** guía descargable "Cómo aparecer en ChatGPT (2027)" a cambio del email, con doble opt-in.
7. **Programa de referidos:** 1 mes gratis para quien invita y para el invitado, con un cupón de Stripe automático. El programa de afiliados va después.

### B5. Calidad continua
- **Test de punta a punta nocturno en producción (smoke):** auditoría anónima, login de una cuenta de prueba, Checkout de Stripe en una cuenta de test separada (no en la real), y lectura de precios y estados.
- **Lighthouse ≥ 95** (SEO, accesibilidad, buenas prácticas) en portada, precios y herramientas, comprobado en CI.
- **Accesibilidad WCAG 2.2 AA** en la app: teclado, contraste y etiquetas.

---

## C. Notas para BLOQUEOS.md (actualízalo con esto)

1. **B-IA (nuevo, urgente):** activar la facturación del proyecto de Google Cloud para usar Gemini en nivel de pago, con un **presupuesto y alerta de 30 €/mes**. Al principio el coste esperado es bajo y lo cubre el primer cliente de pago. Sin esto, la recomendación técnica es no vender planes de pago con artículos incluidos.
2. **Abogado (sigue urgente):** condiciones, garantía, privacidad, subencargados y DPA. Los pagos ya están abiertos.
3. **Google Auth Platform: `composio.dev`.**
   - Cuando termine la verificación, revisa en *Clientes → URI de redirección autorizadas* si algún cliente OAuth redirige a composio.dev.
   - Si DNI Growth no lo usa, quita el dominio para que nadie ajeno pueda recibir tokens de tu app.
   - Si se usó para conectar tu Gmail a un asistente, usa un cliente OAuth separado para eso.
   - No lo toques mientras la verificación está abierta.
4. **Meta, "proveedor de tecnología":** solo hace falta si DNI Growth va a publicar o gestionar anuncios **en cuentas de tus clientes** (es el plan). Es irreversible y lo decide la titular. Después vienen la verificación de empresa y la revisión de la app.
5. **Resend** (si no hay proveedor de email): crear la cuenta y guardar la clave con `wrangler secret put`.
6. **Revisión de los 10 borradores del blog.**
7. **Valorar un domicilio profesional o una sociedad** para no publicar el domicilio particular en el aviso legal y las facturas (decisión de la titular con su gestor).
8. **TOTP del Control Center**, **Stripe Tax o IVA fijo**, **NIF en Stripe** y **VERI*FACTU**: siguen como estaban.

---

## D. Definición de "listo para el público"

1. Cero ✓ en precios para funciones que no estén Disponibles o Parciales con su límite explicado.
2. Ningún cliente de pago depende de un nivel gratuito de IA, y hay un techo de gasto activo.
3. Nuestra auditoría de dnigrowth.com da 100/100, sin errores en consola.
4. Funcionan de punta a punta con test: auditoría anónima, registro, prueba gratis, pago, cambio de plan, pausa, cancelación, garantía (con datos simulados en staging), conexión de Search Console, borrador y publicación en WordPress.
5. Existen `/estado`, copias de seguridad con restauración probada, emails transaccionales y alertas.
6. Las herramientas gratuitas y las landings están publicadas e indexables. El blog tiene al menos 4 artículos aprobados por la titular.
7. `docs/BLOQUEOS.md` actualizado y ordenado por urgencia.

**Al terminar cada bloque (B0…B5)**, escribe un resumen corto: qué está en producción, cómo lo verificaste (enlace o test) y qué tiene que hacer la titular.

Empieza ya por B0.
