# ADR 0028 · Publicación en Ghost y webhook de publicación firmado

- Estado: aceptado
- Fecha: 2026-11-25
- Relacionado: [ADR 0025](0025-publicacion-externa-meta-y-wordpress.md) (WordPress), [ADR 0027](0027-plugin-wordpress-correcciones-y-fuentes-propias.md)

## Contexto
La Entrega 2 pide un webhook genérico con documentación OpenAPI, Ghost y Webflow. Webflow publica en colecciones cuyos campos define cada web, así que una conexión directa exige que el cliente asigne campos y elija una colección. El webhook firmado cubre Webflow hoy a través de Make, Zapier o n8n, sin esa pantalla.

## Decisión
1. **Ghost** (plan Starter o superior):
   - Se conecta con la *Admin API key* de una integración personalizada. El JWT se firma con HS256, dura 5 minutos y lleva la audiencia `/admin/`.
   - Se comprueba con `GET /ghost/api/admin/site/` antes de guardar la clave, que se guarda cifrada y ligada a la organización.
   - Al publicar se envía el HTML seguro (`?source=html`), un extracto y un título y descripción SEO.
   - Cada entrada lleva una etiqueta interna `#dni-<id>`, invisible para los lectores. Si un reintento no sabe si se creó la entrada, la encuentra por esa etiqueta y no la duplica.
   - Las ediciones mandan el `updated_at` actual, como exige Ghost para detectar colisiones.
   - «Retirar» pasa la entrada a borrador. Nunca se borra nada.
2. **Webhook** (plan Starter o superior):
   - Destino: una dirección https pública. Se aplican las mismas protecciones que en WordPress: guarda SSRF y DNS, sin redirecciones, respuesta limitada y 15 s de espera máxima.
   - Al conectar se genera un secreto `whsec_…`, que se muestra una sola vez, y se envía un `ping` que tiene que recibir un 2xx.
   - Eventos: `content.publish` (HTML, Markdown, extracto, slug y JSON-LD Article) y `content.unpublish`.
   - Firma: `x-dni-signature: t=…,v1=HMAC-SHA256("t.cuerpo")`, con el mismo formato que los webhooks de reglas.
   - `x-dni-delivery` es igual en los reintentos del mismo envío, para que el receptor descarte duplicados.
   - Si el receptor responde con JSON con `id` y `url` (https), se guardan y se enseña el enlace.
   - Contrato OpenAPI 3.1 (`webhooks:`) publicado en `/openapi/webhook-publicacion.yaml`.
   - No se envían datos personales: ni emails ni nombres de quien aprueba.
3. Tabla nueva `cms_external_publications`, con migración aditiva `0029`. La CHECK de `cms_publications` solo admite `wordpress` y no se puede cambiar sin reconstruir la tabla.
4. Webflow directo y Shopify siguen **en desarrollo**.

## Pruebas
`apps/api/test/cms-external.test.ts` (4) contra un Ghost simulado que valida el JWT (kid, aud, exp y firma) y la colisión por `updated_at`, y contra un receptor que valida la firma. Cubre:
- clave inválida o rechazada;
- la clave nunca vuelve al navegador y se guarda cifrada;
- publicar, actualizar sin duplicar y retirar;
- un reintento tras una respuesta perdida no duplica;
- solo contenido aprobado, solo roles con `content:approve`, plan Free → 402 y aislamiento entre organizaciones;
- webhook: http e IP interna rechazados, firma válida, `deliveryId` estable, fallo 5xx, `unpublish` y desconexión que borra el secreto.

**No probado todavía contra un Ghost real.** La API simulada sigue la documentación oficial de la Admin API v5.
