# Verificación de la app de Google (DNI Growth)

Proyecto de Google Cloud: `dni-growth` · Google Auth Platform · app **publicada (producción)**, sin verificar.
Mientras no esté verificada: aviso «Google no ha verificado esta app» en el consentimiento y tope de **100 usuarios** con permisos sensibles. La verificación no tiene coste.

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
