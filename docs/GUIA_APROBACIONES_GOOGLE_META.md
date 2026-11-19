# Guía paso a paso: aprobaciones de Google y Meta

Actualizado: 2026-11-19. Los nombres de los menús de Google y Meta cambian a menudo; si uno no coincide, busca el texto más parecido.

Ya preparado en dnigrowth.com (no hace falta tocarlo):

| Requisito | URL |
|---|---|
| Página principal | https://dnigrowth.com/ |
| Política de privacidad (con sección «Datos de usuario de Google») | https://dnigrowth.com/legal/privacidad |
| Condiciones de uso | https://dnigrowth.com/legal/condiciones |
| Eliminación de datos (la pide Meta) | https://dnigrowth.com/legal/eliminacion-datos |
| Icono 1024×1024 (Meta) | https://dnigrowth.com/icon-1024.png |
| Logotipo 120×120 (Google, opcional) | https://dnigrowth.com/icon-120.png |

---

## A. Google: verificación de la app (Search Console y Analytics para clientes)

Coste: 0 €. Duración habitual de la revisión: de unos días a varias semanas.

### A1. Grabar el vídeo (2–3 minutos)
1. En Windows abre **Recortes** (Snipping Tool) → botón **Grabar** → «Nuevo» → selecciona toda la ventana del navegador. Alternativa: `Win + Alt + R` (Xbox Game Bar).
2. Usa un navegador con la **barra de direcciones visible** y la interfaz en español.
3. Sigue el guion de [GOOGLE_VERIFICATION.md](GOOGLE_VERIFICATION.md#vídeo-de-demostración-2-3-minutos):
   1. Abrir https://dnigrowth.com/, señalar el enlace «Privacidad» y entrar en la app.
   2. Search Console → «Conectar con Google (solo lectura)». En la pantalla de Google, **haz clic en la barra de direcciones** y desplázate para que se lea `client_id=` y `webmasters.readonly`. Concede el permiso, vuelve y elige **https://dnigrowth.com/**. Muestra el panel.
   3. Analytics → «Conectar con Google (solo lectura)», igual con `analytics.readonly`. **No elijas la propiedad de DNI GYM**: si no tienes una propiedad de GA4 de DNI Growth, enseña la lista y di (o escribe en pantalla) que se elige una propiedad propia.
   4. Enseña «Dejar de usar esta propiedad» y «Desconectar» con la casilla de borrar datos (no hace falta confirmarlo).
   5. Termina en la política de privacidad, sección 3 «Datos de usuario de Google».

### A2. Subir el vídeo
1. https://studio.youtube.com → **Crear → Subir vídeos**.
2. Título: «DNI Growth – Google OAuth demo (Search Console & Analytics, read-only)».
3. Visibilidad: **No listado**. Publicar y **copiar el enlace**.

### A3. Enviar a revisión
1. https://console.cloud.google.com/auth/data-access?project=dni-growth (Google Auth Platform → **Acceso a los datos**).
2. Pega el enlace en **«Vínculo de YouTube»** → **Guardar**. La justificación de los permisos ya está escrita y guardada.
3. Opcional: **Desarrollo de marca** → sube el logotipo `icon-120.png` (Google también lo revisa).
4. **Centro de verificación** (https://console.cloud.google.com/auth/verification?project=dni-growth) → **Enviar a revisión**. Si pide «Motivos de la apelación» por la política de privacidad, pega el texto de [GOOGLE_VERIFICATION.md](GOOGLE_VERIFICATION.md#texto-de-la-apelación-pegar-en-motivos-de-la-apelación-al-enviar).
5. Google escribe al correo de contacto del desarrollador. Responde siempre desde ese hilo. Si piden cambios, me pasas el texto y lo preparo.

> Consejo: envía primero solo Search Console y Analytics (ya está listo). El permiso de Google Ads se añade después, porque añadir permisos reinicia la revisión.

---

## B. Meta: anuncios en Facebook e Instagram (API de Marketing)

Coste: 0 € por la API (el gasto en anuncios es aparte y siempre pasa por tu aprobación y el Spend Guardian).

**Importante:** Meta solo aprueba el acceso avanzado (gestionar cuentas publicitarias de tus clientes) si en la revisión ve la app **usando** esos permisos. DNI Growth todavía no tiene la conexión con Meta: hoy crea borradores y los exporta. Por eso el orden es: tú haces B1–B3 → me das el **ID de la app** (es público, no es secreto) → yo programo la conexión → la probamos con tu propia cuenta publicitaria (acceso estándar, sin revisión) → grabas el vídeo → pides la revisión (B5).

### B1. Portfolio empresarial
1. https://business.facebook.com → crear un **portfolio empresarial** «DNI Growth» (o usar el que tengas).
2. Añade tu cuenta publicitaria o crea una nueva dentro del portfolio (no actives campañas).

### B2. Verificación de la empresa (con tu documentación)
1. Business Suite → **Configuración** → **Centro de seguridad** → **Verificación de la empresa** → «Iniciar verificación».
2. Datos: nombre legal (el tuyo, como persona física/autónomo), dirección, teléfono y web `https://dnigrowth.com`.
3. Documentos que suele aceptar Meta en España: certificado de situación censal de la AEAT o alta de autónomo con tu nombre y dirección, y/o una factura de suministro a tu nombre. El nombre y la dirección deben coincidir con lo que escribes.
4. Confirmación por correo de dominio (`hola@dnigrowth.com` llega a tu buzón), por teléfono o por DNS. Si eliges **DNS**, pásame el registro TXT y lo añado yo en Cloudflare.

### B3. Crear la app de Meta
1. https://developers.facebook.com/apps → **Crear app**.
2. Caso de uso: **«Crear y gestionar anuncios con la API de marketing»** (o tipo **Empresa**). Asocia el portfolio de B1.
3. **Configuración de la app → Básica**:
   - Nombre visible: DNI Growth · Correo de contacto: hola@dnigrowth.com
   - Dominios de la app: `dnigrowth.com`
   - URL de la política de privacidad: `https://dnigrowth.com/legal/privacidad`
   - URL de las condiciones: `https://dnigrowth.com/legal/condiciones`
   - Instrucciones de eliminación de datos: `https://dnigrowth.com/legal/eliminacion-datos`
   - Icono: sube `icon-1024.png` (descárgalo de https://dnigrowth.com/icon-1024.png)
   - Categoría: Empresa y páginas
4. Copia el **ID de la app** y envíamelo. El **secreto de la app NO me lo pegues**: cuando la conexión esté programada lo guardas tú con
   `npx.cmd wrangler secret put META_APP_SECRET`

### B4. Lo que hago yo cuando tenga el ID de la app
- Botón «Conectar Meta Ads» (inicio de sesión de Facebook, permisos `ads_read`, `ads_management`, `business_management`), token cifrado y desconexión con borrado.
- Lectura de cuentas publicitarias y del gasto real (sustituye el aviso «Gasto publicitario real: bloqueado»).
- Crear en Meta las campañas **aprobadas** en DNI Growth, siempre **en pausa**, respetando el Spend Guardian y con registro de auditoría. Activarlas lo haces tú.
- Actualizar la política de privacidad con el uso de datos de Meta (requisito de la revisión).

### B5. Revisión de la app (acceso avanzado)
1. developers.facebook.com → tu app → **Revisión de la app → Permisos y funciones** → solicita **acceso avanzado** para `ads_management`, `ads_read` y `business_management`.
2. Para cada permiso: descripción de uso (te la escribo) y un **vídeo** mostrando el inicio de sesión con Facebook, la elección de la cuenta publicitaria y la creación de una campaña en pausa desde DNI Growth.
3. Requisito previo: verificación de la empresa (B2) aprobada.

---

## C. Google Ads API

Coste: 0 €. Requiere conexión programada (igual que Meta) y añadir el permiso de Google Ads a la verificación de Google, por eso conviene hacerlo **después** de A.

1. Crear una **cuenta de administrador de Google Ads** (MCC): https://ads.google.com/home/tools/manager-accounts/ (gratis, sin campañas).
2. En esa cuenta: **Administrador → Centro de API** → acepta las condiciones → obtienes un **token de desarrollador** con acceso «Cuenta de prueba». No me lo pegues: se guarda con `npx.cmd wrangler secret put GOOGLE_ADS_DEVELOPER_TOKEN`.
3. Solicita **acceso básico** en el mismo Centro de API (formulario con la descripción de la herramienta y la web; te preparo el texto y el documento de diseño).
4. Yo activo la API de Google Ads en el proyecto `dni-growth`, programo la conexión (lectura de cuentas y gasto, campañas en pausa desde borradores aprobados) y añado el permiso `adwords` para una nueva revisión de Google.
