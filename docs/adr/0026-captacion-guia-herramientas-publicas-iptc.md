# ADR 0026 · Captación y retención: guía con doble confirmación, herramientas que leen webs ajenas, marca IPTC, páginas que pierden clics e informe mensual

Fecha: 2026-11-25 · Estado: aceptada

## Contexto
La Entrega 2 (B4) pedía una guía descargable a cambio del email, 4 herramientas gratuitas que necesitan leer una web pública desde nuestro servidor y que las imágenes creadas con IA se puedan identificar como sintéticas. Cada una toca un principio de CLAUDE.md: datos personales mínimos, defensa frente a SSRF y contenido web como **dato no fiable**, y transparencia sobre el contenido generado.

## Decisión

### Guía «Cómo aparecer en ChatGPT (2027)» con doble confirmación
- `POST /api/v1/public/guide` responde **siempre lo mismo** (202), exista o no el email, para no revelar quién está registrado. Campo trampa para bots: misma respuesta, no se guarda ni se envía nada.
- Límites: 5 por IP y hora, 3 por email y día y 300 al día en total.
- Tabla `guide_signups` (migración `0025`, aditiva): huella HMAC del email (`email_hash`), email cifrado con AES-256-GCM (`email_enc`), hash del token de confirmación, texto exacto del consentimiento, huella de la IP y fechas.
- El enlace del correo abre un **formulario**. Solo el `POST` confirma, así que un escáner de correo que abra el enlace no confirma nada.
- Al confirmar, se envía el enlace de lectura (`/guia/leer?k=id.hmac`). El email cifrado **se borra** salvo que la persona marcara la casilla de novedades; queda solo la huella como prueba del consentimiento.
- La guía estática (`/guia/contenido`) nunca se sirve directamente (404). Solo la sirve `/guia/leer` con una clave válida, con `noindex`.
- `/guia/baja` da de baja y borra el email cifrado. El cron borra los registros sin confirmar a los 7 días.
- Política de privacidad actualizada (`#guia`): finalidad, base (consentimiento), conservación. Pendiente de revisión por abogado.

### Herramientas que leen una web pública
- Herramientas: preparación para IA, palabras clave frente a un competidor, enlaces rotos e imagen al compartir.
- Rutas: `/api/v1/public/tools/*`. Solo aceptan peticiones del mismo origen.
- Límites: 30 por IP y hora, 120 por IP y día y 3000 al día en total. Palabras clave cuenta doble.
- Todas las lecturas pasan por `safeFetch`:
  - bloqueo de direcciones privadas y resolución DNS fijada;
  - redirecciones manuales revalidadas;
  - tamaño máximo, y para imágenes solo los primeros bytes.
- El comprobador de enlaces revisa como máximo 50, en tandas de 10 y con 3 a la vez (HEAD y, si falla, GET). No sigue redirecciones. 401, 403, 429 y 999 se muestran como «bloqueado», no como roto.
- El HTML ajeno solo se analiza como texto. No se ejecuta y no se envía a ningún modelo de IA, así que no hay superficie de inyección de instrucciones.
- Un Worker no puede pedirse a sí mismo por su dominio (error 522). Si la web analizada es dnigrowth.com, la petición se resuelve dentro del propio Worker (`selfFetch`).

### Marca IPTC en imágenes generadas con IA
- Antes de guardar en R2, cada imagen generada recibe metadatos XMP con `DigitalSourceType = trainedAlgorithmicMedia` (vocabulario IPTC) y la herramienta creadora:
  - en PNG, un fragmento `iTXt` tras `IHDR`;
  - en JPEG, `APP1` tras `APP0`.
- También queda marcada en R2 con `aiGenerated: "true"`. Es una ayuda para cumplir la obligación de marcar el contenido sintético (Reglamento de IA, art. 50). No sustituye a una marca de agua robusta: los metadatos se pueden quitar al recomprimir.

### Comprobación de Meta en `/estado`
- Una vez por hora se pide un token de aplicación a Meta (`client_credentials`) para saber si acepta la clave de la app. El token se descarta y nunca se guarda ni se registra.

### Páginas que pierden clics (Search Console)
- La sincronización hace **una consulta más** a la API de Search Console, con el mismo permiso de solo lectura: las páginas de los 28 días anteriores al periodo actual.
  - Se guardan en `gsc_page_prev` (migración `0026`).
  - Se importan 250 páginas por periodo (antes 25).
- La comparación es **determinista** (`decliningPages` en `@dni/core`). Marca una página si pierde al menos 10 clics y al menos un 30 % de los que tenía.
- Explica la causa probable: baja de posición, menos impresiones, menos clics con las mismas búsquedas, o ya no aparece.
  - «Ya no aparece» solo se dice si la lista actual está completa (menos de 250 filas). Si está recortada, la página podría estar justo debajo del corte.
- **No cambia el uso de los datos de Google:** se muestran a la propia organización, nunca se envían a un modelo de IA y se borran al desvincular la propiedad con «borrar datos».

### Informe mensual por email
- Lo envía el cron del día 1 al 7 de cada mes, desde las 07:00 UTC.
- Destinatarios: propietarios y administradores con email verificado que no se hayan dado de baja (`users.monthly_report_opt_out_at`).
- Antes de enviar se reclama una fila por organización, mes y persona en `monthly_report_sends` (migración `0027`). Así nunca se envía dos veces, aunque el cron se solape o el envío se repita.
- Contenido:
  - recuentos reales del mes (auditorías completadas, contenidos aprobados, envíos a la web, publicaciones en redes);
  - clics e impresiones observados de Search Console con su fuente.
- Solo se compara con el mes anterior si los dos meses tienen los mismos días de datos. Así no se muestra una subida o bajada falsa.
- Las organizaciones sin nada que contar no reciben correo.
- Base: interés legítimo, con baja en un clic. El GET solo confirma; el POST da de baja, así que los escáneres de enlaces no dan de baja a nadie. Añadido a la política de privacidad.

## Consecuencias
- Un email solo se guarda en claro el tiempo de enviar el correo, y cifrado solo con consentimiento para novedades.
- Las herramientas públicas tienen un coste acotado: lecturas de red con techo diario y sin llamadas a IA.
- Pruebas:
  - `guide.test.ts` (3);
  - `public-tools.test.ts` (5);
  - `site-tools.test.ts` (9);
  - `provenance.test.ts`;
  - `ai.test.ts` comprueba que la imagen guardada lleva la marca;
  - `status-backup.test.ts` cuenta 9 comprobaciones;
  - `declining.test.ts` (3), `searchconsole.test.ts` (16) y `monthly-report.test.ts` (2).
