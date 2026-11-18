# ADR 0011 — Google Analytics 4 de solo lectura (F3)

- Estado: aceptado · Fecha: 2026-11-18 · Amplía [ADR 0010](0010-search-console-solo-lectura.md)

## Contexto
El backlog F3 pide «GA4 ingest seguro: datos por período, propiedad y timestamp». Search Console ya resolvió OAuth, cifrado, trabajos y panel; GA4 debe reutilizarlo sin debilitar nada y sin costes nuevos.

## Decisión
- **Plumbing común** (`lib/google.ts`, `routes/googleConnect.ts`): cada fuente de Google es una `GoogleDataSource` con su proveedor, su permiso, su prefijo AAD (`gsc`, `ga4`), su panel y su tipo de trabajo. Conectar, completar en el callback compartido y desconectar son el mismo código para ambas. El prefijo AAD de Search Console no cambia (hay un token en producción).
- **Consentimiento separado por fuente**: GA4 pide solo `openid email https://www.googleapis.com/auth/analytics.readonly`. Una organización puede conectar Search Console con una cuenta y Analytics con otra; cada una tiene su fila en `integrations`, su token cifrado y su revocación. El AAD liga cada sobre a fuente + organización + integración: intercambiar sobres entre integraciones los vuelve ilegibles (probado).
- **Propiedades permitidas**: Admin API `accountSummaries.list` (máx. 5 páginas × 200). Solo se aceptan nombres `properties/<dígitos>`; lo que la cuenta deja de listar pasa a `accessible = 0` y pierde la selección. Se revalida en cada sincronización. Si solo hay una propiedad se elige sola; si hay varias, elige la persona.
- **Datos** (Data API `runReport`, hosts fijos `analyticsadmin.googleapis.com` y `analyticsdata.googleapis.com`):
  - diarios (`date`): sesiones, usuarios, vistas, sesiones con interacción y eventos clave — 90 días la primera vez y 30 después;
  - **totales por periodo leídos de GA4** (28 días y los 28 anteriores, en una petición con dos rangos con nombre): los usuarios de un periodo están deduplicados por GA4, así que no se suman los diarios;
  - 25 canales (`sessionDefaultChannelGroup`) y 25 páginas de entrada (`landingPage`) del periodo actual.
  - Se guardan la zona horaria y la moneda que devuelve la API, y si el informe tuvo umbrales de privacidad o muestreo; el panel lo avisa.
- **Medición**: diarios, totales y filas principales `observed`; tasa de interacción `derived` (sesiones con interacción ÷ sesiones). Fuente, fecha de observación, periodo y advertencias en la respuesta y en cada tarjeta.
- **Trabajo** `ga4_sync` (cola + outbox, reintentos, cancelable, 0 créditos) y cron diario por propiedad seleccionada, igual que `gsc_sync`.
- Corrección de paso: los errores `409/502` de estas rutas devolvían el detalle en `code`, que pisaba el código del error; ahora va en `reason`.

## Consecuencias
- `analytics.readonly` también es un permiso sensible: mientras la app de Google no esté verificada, el consentimiento muestra el aviso de app no verificada y hay un tope de 100 usuarios. La verificación (gratuita) la solicita la titular; la política de privacidad ya describe el uso de los datos de Google y el uso limitado.
- Deben estar habilitadas la «Google Analytics Admin API» y la «Google Analytics Data API» en el proyecto de Google Cloud (lo están desde el 2026-11-18).
- Si la web no tiene la etiqueta de GA4, la sincronización termina bien con 0 filas y el panel lo explica; no se estima nada.
