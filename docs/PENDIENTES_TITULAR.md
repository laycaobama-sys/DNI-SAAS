# Pendientes de la titular (2026-11-20)

Tareas que solo puedes hacer tú porque necesitan tu sesión (Cloudflare, Meta, Google). Ninguna cuesta dinero.

---

## 0. Vincular tu cuenta al Control Center (5 minutos, gratis) — PENDIENTE

Hasta que lo hagas, el Control Center está en **acceso provisional**. Puedes verlo todo, pero suspender, borrar, cambiar planes, límites, créditos o parar la IA queda bloqueado. Así nadie gana privilegios solo por tener tu email.

1. En tu ordenador, abre una terminal en la carpeta `DNI SAAS` (con tu sesión de Cloudflare iniciada) y ejecuta:
   ```
   node scripts/platform-claim.mjs
   ```
2. Copia el código que aparece **en tu terminal**. Caduca en 30 minutos y solo sirve una vez. **No lo pegues en ningún chat ni correo**, tampoco aquí.
3. Abre https://dnigrowth.com/app/admin?tab=security con tu cuenta y pega el código en «Código de vinculación».
4. Escanea el QR con tu app de autenticación (Google Authenticator, Microsoft Authenticator, 1Password…) y escribe el código de 6 cifras.
5. Guarda los **10 códigos de recuperación** fuera del ordenador. Cada uno sirve una vez si pierdes el móvil.

Desde ese momento la lista de administradores por email deja de dar acceso. Si el código se filtra, vuelve a ejecutar el script: el anterior caduca solo.

---

## 1. Icono de la app en Meta: HECHO (2026-11-19)

Comprobado en Meta for Developers → Configuración → Básica: icono `icon-1024.png` subido, con privacidad, condiciones y eliminación de datos apuntando a dnigrowth.com.

**Archivo:** `apps/web/public/icon-1024.png` (1024 × 1024, PNG). También se descarga desde https://dnigrowth.com/icon-1024.png

1. Entra en https://developers.facebook.com/apps/ y abre la app **DNI Growth**.
2. Menú izquierdo: **Configuración de la app → Básica**.
3. En **Icono de la app (1024 × 1024)**, pulsa sobre el recuadro y elige `icon-1024.png`.
4. Baja hasta el final y pulsa **Guardar cambios**.

No toques el campo «Clave secreta de la aplicación».

---

## 2. Vídeo de demostración para Google: HECHO (2026-11-19)

Vídeo grabado y subido como no listado: https://youtu.be/iCyrb1Xcc1Q. El enlace está pegado en Google Auth Platform y la app está **enviada a revisión**. Solo queda esperar el correo de Google; si pide cambios, reenvíamelo. Detalle en [GOOGLE_VERIFICATION.md](GOOGLE_VERIFICATION.md).

Las instrucciones originales quedan debajo por si Google pide repetir el vídeo.

Google lo exige para aprobar que tus clientes conecten **Search Console** y **Analytics** sin el aviso «app no verificada». Dura 2–3 minutos y se sube a YouTube como **No listado** (solo lo ve quien tenga el enlace).

### Antes de grabar
- **Propiedad de Analytics de DNI Growth.** Hoy tu cuenta de Google solo tiene la de DNI GYM, y esa **no** debe aparecer elegida en el vídeo. Recomendado: crea una propiedad gratuita en https://analytics.google.com → Administrar → Crear → Propiedad, con el nombre «DNI Growth» y el sitio `https://dnigrowth.com`. No hace falta instalar nada en la web para el vídeo.
- **Cómo grabar en Windows (gratis):** abre **Clipchamp**, que viene con Windows, y elige *Grabar → Grabación de pantalla*. Otra opción es **Win + Alt + R** con la Xbox Game Bar. Graba **toda la ventana de Chrome**, con la barra de direcciones visible.
- Pon Chrome en español y cierra las pestañas que no tengan que ver (correo, DNI GYM, etc.).

### Guion (lo que se ve en el vídeo)
1. Abre **https://dnigrowth.com/**. Baja al pie de página y señala **Privacidad**. Entra en la app (ya con tu sesión iniciada).
2. **Search Console:** en el menú, **Search Console → Conectar con Google (solo lectura)**.
   - En la pantalla de Google, haz clic en la barra de direcciones para que se lea `client_id=…` y `webmasters.readonly`. Déjalo visible unos 3 segundos.
   - Elige tu cuenta. Si sale «Google no ha verificado esta app», pulsa *Configuración avanzada → Ir a DNI Growth* (es lo normal). Concede el permiso.
   - De vuelta en la app, elige **https://dnigrowth.com/**, nunca otra web. Pulsa sincronizar y enseña el panel: clics, impresiones, CTR, posición, consultas y páginas.
3. **Analytics:** en el menú, **Analytics (GA4) → Conectar con Google (solo lectura)**. Haz lo mismo y enseña que en la dirección aparece `analytics.readonly`. Elige la propiedad **DNI Growth** y enseña el panel. Si aún no tiene datos, no pasa nada: se ve que está conectado y vacío.
4. **Revocar:** pulsa **Desconectar**, marca la casilla de borrar los datos y confirma. Así Google ve que el usuario puede retirar el permiso.
5. Termina en **https://dnigrowth.com/legal/privacidad**, en la sección **«Datos de usuario de Google»**.

### Después de grabar
1. Sube el vídeo a YouTube con visibilidad **No listado** y copia el enlace.
2. Ve a https://console.cloud.google.com, proyecto **dni-growth**, y entra en **Google Auth Platform → Acceso a los datos**. Pega el enlace en **Vínculo de YouTube** y pulsa **Guardar**.
3. Ve a **Centro de verificación → Enviar a revisión**. Si te pide un texto de justificación o de apelación, ya está escrito en [GOOGLE_VERIFICATION.md](GOOGLE_VERIFICATION.md): cópialo tal cual.
4. Google responde por correo en unos días o semanas. Si pide cambios, reenvíame el correo y lo preparo.

---

## 3. Anuncios (AdSense)
Pendiente de tu decisión. Si decides ponerlos, necesitaré que crees la cuenta de AdSense con tu Google y aceptes sus condiciones. Yo preparo el banner de cookies (obligatorio en la UE) y los huecos solo en las páginas públicas, nunca dentro de la app.
