# Verificación de la app de Google (DNI Growth)

Proyecto de Google Cloud: `dni-growth` · Google Auth Platform · app **publicada (producción)**, sin verificar.
Mientras no esté verificada: aviso «Google no ha verificado esta app» en el consentimiento y tope de **100 usuarios** con permisos sensibles. La verificación no tiene coste.

## Estado (2026-11-24): RESPUESTA ENVIADA, A LA ESPERA DE GOOGLE

**Enviada el 2026-11-24 a la 1:55 (hora de España)** desde el Gmail de la titular, como respuesta al mismo correo (destinatario: la dirección de respuesta de «API OAuth Dev Verification»). Gmail confirmó «Mensaje enviado». Si Google responde con el correo de su revisor, hay que invitarlo a la organización «Demo verificación Google» con rol Analista.

Antecedente:

El 21 nov llegó «[Action Needed] Your Google APIs Verification Request» (equipo *Third Party Data Safety*): una lista de comprobación y la frase «You must reply to this email … in order to proceed with the review». **La revisión no avanza hasta que se responda.**

Revisado punto por punto antes de responder (2026-11-24, versión `8015e5ff`):
- **Permisos idénticos a los registrados:** el inicio de sesión ahora pide solo `openid email` (antes pedía también `profile`, que no estaba registrado); las conexiones piden `openid email` + `webmasters.readonly` o `analytics.readonly`. Comprobado en producción: `GET /api/v1/auth/google/start` → 302 con `scope=openid+email`.
- **Vídeo:** https://youtu.be/iCyrb1Xcc1Q accesible («No listado»).
- **Acceso sin bloqueos:** registro con Google, gratis, sin tarjeta ni teléfono. Search Console funciona en el plan Free; Analytics es del plan Starter, así que la respuesta ofrece abrirles el acceso sin coste (invitándoles a la organización «Demo verificación Google», que ya tiene Analytics).
- **Política de privacidad:** cubre acceso, uso, transferencia, protección, conservación y borrado de los datos de Google, y la declaración de uso limitado.
- No hay permisos restringidos (no hace falta CASA), ni de Workspace/Photos, ni de escritura o borrado.

Texto de la respuesta (responder al mismo correo, desde la cuenta de contacto del desarrollador):

> Hello Third Party Data Safety Team,
>
> Thank you for the checklist. We have audited project dni-growth (1028756015912) against every item and confirm compliance. Summary and updates:
>
> 1. Scopes and least privilege. The app requests exactly the scopes registered in the Cloud Console: openid and userinfo.email for "Sign in with Google" (we just removed an unregistered "profile" request, so sign-in now asks only for "openid email"); webmasters.readonly when an organization admin clicks "Connect Search Console"; analytics.readonly when they click "Connect Google Analytics". Each scope is requested incrementally, only on that explicit action, and all of them are read-only: we never write to or delete anything in the user's Google account. All features are live in production at https://dnigrowth.com. No narrower scope supports listing the user's properties and reading their aggregated reports.
> 2. Demo video: https://youtu.be/iCyrb1Xcc1Q (unlisted). It shows the consent screen with the client_id and the requested scope in the address bar, the property selection, the imported data for each scope and the disconnect option.
> 3. App access. No test credentials are needed: anyone can sign up with "Sign in with Google" for free, with no credit card and no phone verification. Step by step:
>    a) Open https://dnigrowth.com and click "Crear cuenta gratis" (or go to https://dnigrowth.com/app/register) and continue with Google.
>    b) Create an organization (any name and website).
>    c) Search Console (available on the free plan): left menu "Search Console" > "Conectar con Google (solo lectura)" > grant access > pick a property > "Sincronizar ahora".
>    d) Google Analytics: left menu "Analytics (GA4)" > "Conectar con Google (solo lectura)" > grant access > pick a GA4 property. This module belongs to our paid plans; to avoid any payment requirement, reply with the Google account you will use and we will add it within 24 hours to our review organization ("Demo verificación Google"), which has Analytics enabled at no cost.
> 4. Privacy policy (https://dnigrowth.com/legal/privacidad, section "Datos de usuario de Google"): it states exactly which data each scope reads, how it is used (only to show the user's own reports inside their workspace), that it is never sold, transferred to advertisers or data brokers, used for advertising or sent to AI models, how it is protected (refresh tokens encrypted with AES-256-GCM, strict per-organization isolation), how long it is kept and how users disconnect and delete it, plus our Limited Use statement linking the Google API Services User Data Policy.
> 5. We do not use restricted scopes, Workspace, Photos or Data Portability APIs, so CASA and the AI/ML training restrictions for those APIs do not apply; in any case, Google user data is never used to train or improve AI models.
>
> Yes, we confirm that the application complies with all the requirements above. Please let us know if you need anything else.
>
> Best regards,
> DNI Growth

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
