# Verificación de la app de Google (DNI Growth)

Proyecto de Google Cloud: `dni-growth` · Google Auth Platform · app **publicada (producción)**, sin verificar.
Mientras no esté verificada: aviso «Google no ha verificado esta app» en el consentimiento y tope de **100 usuarios** con permisos sensibles. La verificación no tiene coste.

## Estado (2026-11-19, noche): ENVIADO A REVISIÓN

- **Vídeo de demostración:** https://youtu.be/iCyrb1Xcc1Q (YouTube, visibilidad «Oculto/No listado», 6:04). Grabado con FFmpeg sobre Chrome real. Muestra la portada y el pie con Privacidad, el consentimiento con `client_id` en la barra de direcciones, Search Console (`webmasters.readonly`) con la propiedad `https://dnigrowth.com/`, Analytics (`analytics.readonly`) con la propiedad GA4 **DNI Growth** (ID 565232679, creada para esto), el diálogo «Desconectar» y la sección «Datos de usuario de Google» de la política.
- Se grabó en una organización aparte, **«Demo verificación Google»** (69d8481f-…, plan interno growth), que queda conectada. Así no se tocaron las conexiones de DNI GYM. En el vídeo se abre el diálogo «Desconectar», pero no se confirma: revocar el permiso de Google retira la autorización entera del usuario y cortaría también las conexiones de DNI GYM. Esto se explica en «Información adicional».
- En el vídeo aparecen barras de aviso de Chrome (depuración de la extensión). También se explica en «Información adicional».
- Enlace pegado en «Acceso a los datos → Vínculo de YouTube» y guardado.
- Cuestionario respondido con «No» en las cuatro preguntas: uso personal, uso interno, solo pruebas y complemento SMTP de WordPress. Se marcaron las dos confirmaciones.
- **Centro de verificación:** «El acceso a los datos de tu app está en proceso de revisión». Google responde por correo; si pide cambios, ver abajo.
- Observación: entre los dominios autorizados figura `composio.dev`, que no es nuestro. No se tocó para no reiniciar la verificación de marca. Si Google lo cuestiona, se quita.

## Estado (2026-11-19)

- **Marca verificada y publicada** (Centro de verificación: «Se verificó la información de tu marca y se muestra a los usuarios»).
- En «Acceso a los datos» Google clasifica ahora `webmasters.readonly` como no sensible; el único permiso sensible es `analytics.readonly`. El vídeo sigue siendo obligatorio para él.
- El enlace de «Condiciones del Servicio» apunta a `/legal/aviso-legal`; se deja así para no reiniciar la verificación de marca (las condiciones están enlazadas desde ahí).

## Estado (2026-11-18)

| Paso | Estado |
|---|---|
| Información de marca (nombre, correo, página principal, privacidad, condiciones, dominios autorizados) | Completa |
| Página principal enlaza la política de privacidad | Sí (`/legal/privacidad` y `/legal/aviso-legal` desde `https://dnigrowth.com/`) |
| Política de privacidad con uso de datos de Google y Limited Use | Publicada (sección «Datos de usuario de Google») |
| Permisos declarados en «Acceso a los datos» | `openid`, `userinfo.email` (no sensibles); `webmasters.readonly`, `analytics.readonly` (sensibles) |
| Justificación de los permisos sensibles | Escrita y guardada en «Acceso a los datos» (texto abajo) |
| Verificación de la marca | Comprobación automática de Google: **rechazada dos veces** por «la política de privacidad no tiene suficiente contenido» (la primera con la versión breve; la segunda ya con la política completa de 13 apartados, legible para Google con código 200). Se resuelve con la apelación incluida en el envío final (texto abajo) |
| Logotipo | No subido (opcional; si se sube, también lo revisa Google) |
| **Vídeo de demostración (YouTube)** | **Pendiente de la titular** |
| Enviar a revisión en el «Centro de verificación» | Pendiente: tras verificar la marca y pegar el enlace del vídeo |

## Vídeo de demostración (2-3 minutos)

Google exige un vídeo en YouTube (puede ser «No listado») que muestre el flujo OAuth completo y cómo se usan los datos de cada permiso. Requisitos: idioma de la interfaz visible, URL del navegador visible, y en la pantalla de consentimiento debe verse el **ID de cliente** (se ve en la barra de direcciones al abrir el consentimiento: parámetro `client_id`).

Guion:
1. Abrir `https://dnigrowth.com/`, mostrar el enlace a la política de privacidad y entrar en la app (sesión iniciada).
2. **Search Console**: menú «Search Console» → «Conectar con Google (solo lectura)».
   - En la pantalla de Google, ampliar la barra de direcciones para que se lea `client_id=…` y `scope=…webmasters.readonly`.
   - Elegir la cuenta, aceptar el aviso de app no verificada (es normal que salga) y conceder el permiso.
   - Volver a la app: «Search Console conectado». Elegir **https://dnigrowth.com/** (nunca otra marca). Mostrar la sincronización y el panel (clics, impresiones, CTR, posición, consultas y páginas, advertencias y fuente).
3. **Analytics**: menú «Analytics (GA4)» → «Conectar con Google (solo lectura)». Mismo procedimiento con `analytics.readonly`; elegir la propiedad de DNI Growth y mostrar el panel (sesiones, usuarios, vistas, eventos clave, canales y páginas de entrada).
4. Mostrar «Dejar de usar esta propiedad» y «Desconectar» (con la casilla de borrar datos) para enseñar la revocación.
5. Terminar en la política de privacidad, sección «Datos de usuario de Google».

Subir a YouTube como «No listado», copiar el enlace y pegarlo en Google Auth Platform → **Acceso a los datos** → «Vínculo de YouTube» → Guardar. Después: **Centro de verificación → Enviar a revisión**.

> Para el paso 3 hace falta una propiedad de GA4 de DNI Growth. Hoy la cuenta conectada solo ve `dni-gym-c6fa2` (DNI GYM), que **no** se debe elegir. Si no existe una propiedad de GA4 para dnigrowth.com, el vídeo puede mostrar la lista de propiedades y explicar que se elige una propia.

## Justificación guardada (Acceso a los datos)

> DNI Growth (https://dnigrowth.com) is a B2B growth dashboard. Each scope has its own consent, requested only when an organization admin clicks Connect, for read-only reporting inside that organization's workspace. webmasters.readonly: sites.list shows which Search Console properties the account can read (the admin explicitly picks one; nothing is auto-selected) and searchAnalytics.query imports daily clicks, impressions, CTR and position plus the top 25 queries and pages, shown with source and date. analytics.readonly: Admin API accountSummaries.list lists readable GA4 properties and Data API runReport imports aggregated daily sessions, users, views, engaged sessions and key events plus top channels and landing pages. No narrower scope covers these reads; we never write to Google. Refresh tokens are encrypted (AES-256-GCM); data is never sold, used for ads or sent to AI models; users can disconnect (we revoke the token) and purge data anytime.

## Texto de la apelación (pegar en «Motivos de la apelación» al enviar)

> The privacy policy at https://dnigrowth.com/legal/privacidad is a complete, static HTML page in Spanish (about 1,800 words, 13 sections): data collected, a dedicated "Datos de usuario de Google" section describing exactly what each scope (openid, email, webmasters.readonly, analytics.readonly) reads, how it is used, stored (AES-256-GCM), revoked and deleted, an explicit Limited Use statement linking the Google API Services User Data Policy, purposes and legal bases, AI processing (Google data is never sent to AI), processors, international transfers, retention periods, cookies, security, minors, user rights and changes. It is linked from the homepage footer. We believe the automated check failed to parse the Spanish content.

## Si Google pide cambios
- Responder al correo de Google desde la dirección de contacto del desarrollador configurada en Google Auth Platform.
- Cualquier cambio de permisos en el código exige actualizar «Acceso a los datos», la política de privacidad y este documento.
