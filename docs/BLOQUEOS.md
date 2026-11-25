# Bloqueos humanos — lo que solo puede hacer la titular

Última revisión: 2026-11-25. Ordenados por urgencia. Mientras tanto, todo lo afectado sigue funcionando en modo prueba o con el aviso correspondiente; ninguna pantalla muestra como «disponible» algo que dependa de estos pasos.

Reglas que siguen vigentes: nadie más que tú escribe claves, contraseñas o códigos; las claves se guardan con `wrangler secret put` y nunca se pegan en un chat.

---

## 0. HECHO · Clave de la app de Meta guardada (2026-11-25)

Guardaste `META_APP_SECRET` con wrangler. Comprobado el mismo día: `/estado` → «Facebook e Instagram» en verde, «Meta acepta las credenciales de la app» (la comprobación se repite cada hora). La pantalla **Redes sociales** ya ofrece «Conectar con Facebook». Con tu cuenta (tienes un rol en la app) puedes conectar tus páginas y publicar. Para que **cualquier cliente** pueda conectar las suyas falta lo del apartado 5; hasta entonces `/precios` sigue diciendo «En desarrollo».

## 1. HECHO · Stripe en real con la cuenta «DNI Growth-IA» (2026-11-23)

Guardaste la clave real y la plataforma hizo sola el resto a las 22:35 UTC (comprobado el 2026-11-24):
- Cuenta **DNI Growth-IA** (`acct_1TnSMAJepRhBoIxa`) con cobros activos.
- En modo real: los 4 planes con precio mensual y anual («DNI Growth · Plan Starter/Growth/Pro/Agency»), el portal de cliente, el IVA y el webhook firmado hacia `https://dnigrowth.com/api/v1/webhooks/stripe`.
- Los pagos están **abiertos al público** (`/api/v1/public/pricing-status` → `paymentsOpen: true`).
- Siguen archivados los productos antiguos de RestoPanel y deshabilitados sus webhooks.

No tienes que hacer nada más aquí. Comprobación cuando quieras: **Facturación → Stripe · administración** debe decir «DNI Growth-IA · puede cobrar».

Nota: tu organización «DNI GYM» tiene una suscripción Starter creada **en modo prueba** y ya cancelada (termina el 2026-12-18). Con la clave real, Stripe no enviará su aviso de fin; la plataforma la pasa sola a Free el 2026-12-20. No hay que hacer nada.

## 2. HECHO · Revisión legal (2026-11-25)

La titular confirma que revisó con su abogado las condiciones, la garantía, la privacidad (también los apartados nuevos de la guía y del informe mensual), el contrato de encargo del tratamiento y `/subencargados`. Se han quitado de la web los avisos de «pendiente de revisión por un abogado». Si el abogado pide cambios de redacción, se aplican sobre los textos actuales.

## 3. IMPORTANTE · IVA y facturas (decisión con tu gestor)

- **Hoy:** tu cuenta real tiene **Stripe Tax activo** y la plataforma lo detectó al sincronizar (2026-11-23): Stripe calcula el IVA según el país del cliente. Tiene coste (~0,5 % por cobro, sin cuota fija).
- **Si tu gestor prefiere el IVA español del 21 % fijo** (suficiente para clientes en España): desactiva Stripe Tax en *Configuración → Impuestos* y después pulsa **Sincronizar** en *Facturación → Stripe · administración*; la plataforma crea el tipo fijo del 21 % y lo usa en los pagos nuevos.
- Añade tu NIF en *Configuración → Facturas → Identificadores fiscales* para que aparezca en las facturas.
- Pregunta a tu gestor por VERI*FACTU.

## 4. EN CURSO · Google: respuesta enviada, esperando a Google

Google pidió el 21 nov que confirmáramos su lista de requisitos («[Action Needed] Your Google APIs Verification Request»). La respuesta se **envió el 2026-11-24 a la 1:55** desde tu Gmail, con tu autorización ([texto en GOOGLE_VERIFICATION.md](GOOGLE_VERIFICATION.md)): permisos idénticos a los registrados desde la versión `8015e5ff`, vídeo, acceso gratis sin tarjeta y política de privacidad. Ahora le toca a Google.

Si Google contesta con el correo de su revisor, hay que invitarlo a la organización «Demo verificación Google» (ya tiene Analytics), como miembro con rol Analista.

Situación anterior:

Comprobado en Google Cloud (*Google Auth Platform → Centro de verificación*) el 2026-11-23:
- **Marca: verificada** ✅ (se muestra a los usuarios).
- **Acceso a datos: en revisión.** Superados «Requisitos de la página principal» y «Lineamientos de la marca» (19 nov). «Requisitos de la política de privacidad» está en revisión; después vienen «Funciones de la app», «Acceso a los datos adecuados» y «Permisos mínimos».
- Google indica que tarda **de 4 a 6 semanas** y que el equipo de Confianza y Seguridad escribe por correo si necesita algo. **Vigila tu correo y responde tú** si piden cambios.
- La política de privacidad ya incluye lo que Google exige (permiso `webmasters.readonly`, uso limitado, sin envío a la IA ni entrenamiento).

Mientras tanto la conexión ya funciona: las sincronizaciones diarias de Search Console y Analytics se completan (11 y 7 en los últimos 7 días). Cada cliente nuevo ve el aviso «app no verificada» hasta que Google termine. La garantía de 90 días necesita Search Console conectado.

## 5. EN CURSO · Meta: app publicada; para abrir Facebook e Instagram a todos los clientes

Hecho el 2026-11-24:
- **La cuenta de desarrollador ya no pide confirmación** (la revisión de la app abre sin el aviso de «actividad inusual»).
- **App «DNI Growth» publicada** (modo producción): Meta indicó «Se ha completado toda la configuración obligatoria» y después «Tu aplicación se ha publicado correctamente»; la alerta «Cambio del modo de la aplicación» lo confirma. Se puede volver a modo desarrollo con «Anular publicación».

Pendiente:
1. En el panel de la app, «Conviértete en un proveedor de tecnología» → **Sí, soy proveedor de tecnología**. Meta avisa: «Esta decisión no se puede revocar». El sistema de seguridad del asistente bloqueó este clic por ser irreversible, así que no se ha pulsado.
2. Verificación de la empresa en Meta Business (documentos oficiales del negocio).
3. Revisión de la app con los vídeos de cada permiso ([GUIA_APROBACIONES_GOOGLE_META.md](GUIA_APROBACIONES_GOOGLE_META.md)).

4. En la revisión de la app, pide **acceso avanzado** para `pages_show_list`, `pages_read_engagement`, `pages_manage_posts`, `instagram_basic`, `instagram_content_publish` y `business_management`, con un vídeo por permiso. El vídeo muestra conectar desde dnigrowth.com, elegir la página, escribir, aprobar y ver la publicación.

Hecho el 2026-11-25: los permisos están «listos para las pruebas» y las URL de inicio de sesión, retirada de permisos y borrado de datos están guardadas. El panel de Meta no dejó crear una «configuración» de inicio de sesión para empresas (la página no carga); la app usa la lista de permisos, que funciona igual.

Hasta entonces, la publicación en Instagram y Facebook aparece en `/precios` como «En desarrollo» y en el módulo como Parcial, y los anuncios de Meta como «requiere aprobación externa». No se venden como disponibles. No toques la «Clave secreta de la aplicación» en ningún chat.

## 5 bis. Aviso · Cuenta antigua de Stripe

La cuenta antigua de Stripe (`acct_1Ucxx…`, la que no usa DNI Growth) tiene pendiente la verificación de identidad y los cobros suspendidos. **No afecta a DNI Growth**, que cobra con «DNI Growth-IA». Si ya no la usas, puedes dejarla así o cerrarla tú desde su panel.

## 6. Claves de API

| Clave | Estado | Coste | Paso |
|---|---|---|---|
| Stripe (clave real de DNI Growth-IA) | ✅ guardada, pagos abiertos | comisión por cobro | — |
| Gemini (monitor GEO y respaldo de IA) | ✅ guardada, nivel gratuito | 0 € | — |
| OpenRouter (modelos gratuitos) | ✅ guardada, solo modelos gratis y gasto máximo 0 $ | 0 € | — |
| Groq | ✅ guardada | 0 € | — |
| Google OAuth (Search Console y Analytics) | ✅ guardada | 0 € | — |
| Cifrado de datos y sal de IP | ✅ guardadas | 0 € | — |
| Cloudflare Turnstile y PageSpeed Insights | no hacen falta hoy | 0 € | El código actual no las usa; se pedirán solo cuando una función las necesite. |
| Anthropic, OpenAI, Perplexity | ❌ no compradas | de pago | Tu presupuesto es 0 €. El seguimiento de ChatGPT, Claude y Perplexity no se vende como disponible. |
| DataForSEO u otro de volumen de búsqueda | ❌ no comprado | de pago | Sin volumen de búsqueda licenciado no se muestran volúmenes. |
| Google Ads (developer token) | ❌ sin solicitar | 0 € (requiere aprobación de Google) | Requiere una cuenta de administrador de Google Ads y la aprobación del token. |

## 7. Vincular tu cuenta al Control Center (TOTP)

Pasos en [PENDIENTES_TITULAR.md §0](PENDIENTES_TITULAR.md). Ejecutas `node scripts/platform-claim.mjs` y pegas tú el código. Nunca en un chat.

## 7 bis. Notas de la Entrega 2 (25 nov)

1. **IA en nivel gratuito (decisión tuya del 25 nov):** seguimos con proveedores gratuitos hasta que entren pagos. Riesgo: las condiciones de la API gratuita de Gemini no permiten usarla para servir a usuarios del Espacio Económico Europeo, y Google puede usar lo enviado para mejorar sus productos. Cuando haya ingresos, activa la facturación del proyecto de Google Cloud con un presupuesto y una alerta de 30 €/mes. El código ya tiene techos de gasto.
2. **Abogado:** HECHO (la titular lo revisó con su abogado el 25 nov).
3. **Google Auth Platform: `composio.dev`:** cuando termine la verificación, mira en *Clientes → URI de redirección autorizadas* si algún cliente OAuth redirige a composio.dev. Si DNI Growth no lo usa, quítalo. No lo toques mientras la verificación siga abierta.
4. **Blog: 10 borradores esperando tu revisión.** En la organización «DNI Growth» → **Contenido**, filtro «En revisión»: cómo aparecer en ChatGPT, llms.txt, AEO para pymes, SEO para Shopify, SEO local en España, auditoría técnica paso a paso, datos estructurados, Search Console para principiantes, GEO frente a SEO y cómo elegir una herramienta de SEO con IA. Pasan el control del editor (sin cifras sin fuente, sin promesas, sin precios). Léelos, cambia lo que quieras y pulsa «Aprobar» en cada uno (30–60 minutos). Ninguno se publica sin tu aprobación. Copia de los textos en `docs/blog-borradores/articulos.json`.
5. **Domicilio profesional o sociedad:** decide con tu gestor si quieres evitar que tu domicilio particular aparezca en el aviso legal y en las facturas.
6. **TOTP del Control Center, Stripe Tax o IVA fijo, NIF en Stripe y VERI*FACTU:** siguen como estaban.
7. **Abogado, también la guía (HECHO):** la política de privacidad tiene un apartado nuevo para la guía «Cómo aparecer en ChatGPT» (doble confirmación, email borrado al confirmar salvo que acepten novedades, borrado a los 7 días si no confirman). Inclúyelo en la revisión.
8. **Correo de prueba de la guía:** se probó el registro con soporte@dnigrowth.com. Si no confirmas ese correo, el registro se borra solo a los 7 días. No hay que hacer nada.
9. **Comparativa con BabyLoveGrowth:** los datos están comprobados el 25 nov 2026 con enlace a su fuente. Revísalos cada 2–3 meses o si nos escriben una corrección (la página da soporte@dnigrowth.com para eso).

## 8. Más adelante

- Shopify (app pública en su tienda de apps) y el directorio de plugins de WordPress: requieren sus revisiones. La publicación en WordPress **ya funciona** sin el directorio, con una contraseña de aplicación, y el plugin «DNI Growth Connector» se descarga desde dnigrowth.com y se sube a mano.
- Perfiles en G2, Capterra y Trustpilot.
- Vídeo demo de 90 s.
- Primeros clientes beta para casos verificados (nunca testimonios inventados).
- Forma jurídica definitiva y datos fiscales en el aviso legal y en las facturas.
