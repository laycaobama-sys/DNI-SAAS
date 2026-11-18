# ADR 0010 — Google Search Console de solo lectura (F3)

- Estado: aceptado · Fecha: 2026-11-18

## Contexto
El backlog F3 pide «OAuth GSC seguro: lectura de propiedad permitida, refresh y desconectar» y un panel de clics e impresiones con «datos observados; ausencia visible sin cuenta conectada». La arquitectura original habla de un almacén de secretos externo; en Cloudflare no se contrata ningún servicio adicional (sin costes nuevos).

## Decisión
- **Scope mínimo**: `openid email https://www.googleapis.com/auth/webmasters.readonly`, `access_type=offline`, `prompt=consent select_account`, PKCE S256, `state` de un solo uso y `nonce`. Si el usuario desmarca el permiso de Search Console (consentimiento granular) no se guarda nada (`scope_not_granted`).
- **Mismo callback** que el inicio de sesión (`/api/v1/auth/google/callback`, ya registrado en Google): la fila `oauth_states` (proveedor `google_gsc`) lleva `organization_id` y `user_id`; el callback exige que la sesión sea la del usuario que inició la conexión y que siga teniendo `integrations:manage` en esa organización.
- **Token de actualización cifrado** en D1 (`integration_secrets`): sobre AES-256-GCM con `DATA_ENC_KEY` (secreto del Worker) y AAD `gsc:<org>:<integración>` — una fila copiada a otra organización no se puede descifrar. `integrations.secret_ref` apunta a la fila; el token nunca se devuelve por la API ni se registra. Los access tokens viven solo en memoria durante una sincronización. Desviación respecto a «vault externo»: mismo patrón ya usado para el secreto del webhook de Stripe y los correos en cola; la clave está fuera de la base de datos.
- **Solo propiedades permitidas**: se guardan las de `sites.list`; solo `siteOwner`, `siteFullUser` y `siteRestrictedUser` se pueden elegir y sincronizar; el permiso se revalida en cada sincronización.
- **Sincronización como trabajo duradero** (`gsc_sync`, cola + outbox, reintentos, cancelable, 0 créditos): 90 días la primera vez y 30 después (`dataState=final`), más las 25 consultas y páginas principales de 28 días. El cron programa una actualización diaria por propiedad seleccionada (clave idempotente por día).
- **Desconectar**: revocación en Google (mejor esfuerzo), borrado del token cifrado y estado `disconnected`; los datos observados se conservan salvo que se pida `purge=true`. `invalid_grant` → `reauth_required`.
- **Hosts fijos** (`oauth2.googleapis.com`, `www.googleapis.com`); la URL de la propiedad se valida y se codifica como segmento de ruta: sin superficie SSRF.
- **Medición**: diarios y filas principales `observed`; totales del periodo `derived` (suma; CTR = clics/impresiones; posición ponderada por impresiones), con fuente, fecha de observación, periodo y advertencias.

## Consecuencias
- El permiso `webmasters.readonly` es «sensible» para Google: mientras la app no pase la verificación de Google, la pantalla de consentimiento muestra el aviso de app no verificada y el uso queda limitado (usuarios de prueba o hasta 100 usuarios nuevos). Para abrirlo a todos los clientes hay que solicitar la verificación del permiso en Google Auth Platform (decisión y trámite de la titular; sin coste).
- La «Google Search Console API» debe estar habilitada en el proyecto de Google Cloud; si no, la conexión se guarda y el panel explica el error hasta pulsar «Actualizar propiedades».
