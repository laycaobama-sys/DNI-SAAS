# ADR 0025 · Publicación externa: Facebook, Instagram y WordPress

Fecha: 2026-11-25 · Estado: aceptada

## Contexto
`/precios` vendía «Publicación en tu blog o CMS» y la titular pidió que los clientes conecten Facebook e Instagram para publicar de forma automática. Son efectos externos (publicar en la web o en las redes del cliente), así que CLAUDE.md exige autorización verificada, auditoría e idempotencia, y modo `APPROVAL_REQUIRED`.

## Decisión

### Común
- Solo se publica contenido **aprobado por una persona** con permiso `content:approve`. Cada envío queda en el historial (`audit_logs`) con quién lo aprobó.
- Las credenciales se guardan cifradas con AES-256-GCM. El dato adicional autenticado (AAD) ata cada credencial a su organización y a su fila: copiar una fila a otra organización no permite descifrarla. Nunca se devuelven al navegador ni se escriben en los registros.
- Ambas funciones están en el plan Starter y superiores (`MODULE_MIN_PLAN`), con una prueba que comprueba que lo que vende `/precios` coincide con lo que abre cada plan.

### Facebook e Instagram (Meta Graph API v27.0)
- Conexión con Facebook Login for Business. Si existe `META_LOGIN_CONFIG_ID`, se usa `config_id`; si no, la lista de permisos mínimos (`pages_show_list`, `pages_read_engagement`, `pages_manage_posts`, `instagram_basic`, `instagram_content_publish`, `business_management`).
- Se comprueban los permisos concedidos antes de guardar nada. El token de usuario de larga duración (unos 60 días) y el token de cada página se guardan cifrados. Cada llamada lleva `appsecret_proof`.
- Publicación desde el cron (cada minuto):
  - el post se reclama con un `UPDATE` condicional;
  - en Instagram se guarda el contenedor antes de publicar, así que reintentar retoma el mismo y no crea un post nuevo;
  - en Facebook, un resultado desconocido (error de red o 5xx) **no se reintenta solo**: el post se marca «Revisa tu página antes de reintentar»;
  - solo se reintentan los límites de uso.
- Interruptor de pausa por organización. Las llamadas de Meta a la retirada de permisos y al borrado de datos están firmadas con `signed_request`. La imagen se sirve a Meta con una URL firmada que caduca en 6 horas.
- Mientras Meta no conceda acceso avanzado (revisión de la app), solo pueden conectar las cuentas con un rol en la app. La función figura como **Parcial** con ese límite escrito.

### WordPress (API REST + contraseña de aplicación)
- El cliente crea una **contraseña de aplicación** en su WordPress (Usuarios → Perfil). No se pide nunca la contraseña de acceso.
- Solo se aceptan webs `https`. Cada petición pasa por la misma protección contra SSRF que el rastreador: host público, resolución DNS sin direcciones privadas y ninguna redirección seguida (una redirección podría llevarse la cabecera `Authorization` a otro sitio). Las respuestas tienen un tamaño máximo.
- Primero se comprueba la API sin credenciales: `/wp-json/` o `?rest_route=` en webs sin enlaces permanentes. Después, `users/me` comprueba que el usuario tiene `publish_posts`.
- Idempotencia:
  - una fila `cms_publications` por contenido, reclamada con escritura condicional (un doble clic devuelve 409);
  - el cuerpo del post lleva un marcador oculto `<!-- dni-growth:<id> -->`, de modo que un reintento tras un resultado desconocido busca por slug más marcador y **actualiza** el post en lugar de crear otro;
  - los envíos siguientes actualizan el mismo post.
- «Retirar» pasa el post a borrador en WordPress (reversible). DNI Growth nunca borra entradas del cliente. Al desconectar se revoca la contraseña de aplicación en WordPress (`application-passwords/introspect` + `DELETE`) y se borra la copia cifrada.

## Pruebas
- `social.test.ts` (12 casos).
- `cms.test.ts` (11 casos sobre una API de WordPress simulada).
- `wordpress-live.test.ts`: contra un **WordPress real** (WordPress Playground, PHP 8.3, última versión de WordPress), con la protección SSRF y la regla https activas. Se ejecuta con `WP_E2E_URL` (ver `docs/WORDPRESS.md`). Resultado el 2026-11-25: conectar, publicar, actualizar el mismo post sin duplicarlo y retirarlo a borrador.

## Pendiente
- Plugin «DNI Growth Connector» (metadatos de Yoast y Rank Math, JSON-LD, `llms.txt`, correcciones técnicas reversibles).
- Imagen destacada y categorías.
- Shopify, Ghost, Webflow y el webhook genérico.
- Publicación programada en WordPress (hoy es inmediata, tras aprobar).
