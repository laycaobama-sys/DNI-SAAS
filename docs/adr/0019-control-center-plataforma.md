# ADR 0019 — Control Center de plataforma: vinculación de la propietaria, MFA, cuotas por plan e «IA DNI Growth»

Fecha: 2026-11-20 · Estado: aceptado · Amplía ADR 0018

## Contexto
La titular pidió un Control Center solo para ella. Los requisitos:
- Ningún privilegio por coincidencia de email, sino una vinculación segura a su cuenta verificada.
- MFA, auditoría y acceso temporal de soporte.
- Poder suspender, borrar y restaurar organizaciones, siempre con marcha atrás.
- Topes de IA por organización, usuario y plan, con avisos y mejora de plan.
- Que el cliente no vea nunca qué IA hay detrás («IA DNI Growth»).
- Arreglar la versión móvil.
- Presupuesto 0 €: solo proveedores gratuitos.

## Decisión

### 1. Vinculación de la propietaria (`platform_claim_codes`, `platform_members`)
- El código de un solo uso lo genera `scripts/platform-claim.mjs` en el ordenador de la titular.
- La comprobación de identidad externa es su sesión de Cloudflare: solo quien controla la cuenta puede insertar un código.
- En D1 se guarda solo el SHA-256 del código. Caduca a los 30 minutos y es de un solo uso.
- Si ya existe una propietaria, cualquier código nuevo devuelve 409 `owner_exists`.
- La lista `PLATFORM_ADMIN_EMAILS` queda como **acceso provisional**, que solo permite leer. Toda acción crítica responde 401 `platform_claim_required` hasta que la titular se vincule, y desde ese momento la lista se ignora.

### 2. Segundo factor
- TOTP (RFC 6238, secreto cifrado con `ENCRYPTION_KEY`) y 10 códigos de recuperación de un solo uso, guardados como hash.
- Protección contra reutilización: `UPDATE … SET mfa_last_step = ? WHERE mfa_last_step < ? RETURNING`. Si dos peticiones llegan a la vez con el mismo código, solo una gana.
- La sesión de plataforma dura 12 h.
- Las acciones críticas exigen **step-up** (código reciente, de menos de 15 min): suspender, borrar, restaurar, renombrar, cambiar plan, límites, créditos, soporte, parada global de IA y cancelación de trabajos.

### 3. Mínimo privilegio
- Roles: `platform_owner`, `platform_admin`, `platform_support`, `platform_analyst`, cada uno con sus *scopes* en `@dni/core/platform-rbac`.
- Quien no es personal de plataforma recibe 404, para no revelar que la consola existe.

### 4. Ciclo de vida de organizaciones, siempre reversible
- **Suspender** → 423 en todas las rutas del cliente. No se muestra el motivo, que solo figura en la auditoría.
- **Borrar** es *soft delete*: 410, con 30 días para restaurar (`purge_after`). La propietaria de la organización también puede borrarla y restaurarla ella misma.
- El **purgado definitivo no está implementado** a propósito: borrar datos de verdad será una decisión aparte.
- Todo exige un motivo y queda auditado.

### 5. Soporte temporal
- Concesión de 1 a 24 h, con motivo y ticket.
- El acceso es **solo lectura** (rol `client_viewer`) y lleva un banner visible para quien lo usa.
- Se puede revocar en cualquier momento.

### 6. Cuotas de IA por plan
- Contadores atómicos por día UTC:
  - `plan:org:<org>`: organización
  - `plan:user:<org>:<user>`: cada usuario
  - `plan:img:<org>`: imágenes
- Se reservan antes de llamar al proveedor y se **liberan si la petición falla**.
- Al superar el tope, la respuesta es 429 con `upgradePlan` y `upgradeLimit`. No se cobra nada.
- La plataforma puede fijar topes por organización con caducidad (`organization_limit_overrides`).
- Hay una parada global (`platform_settings.ai_global_halt`) que detiene toda la IA sin desplegar.
- `GET /orgs/:id/usage` devuelve cada cuota con nivel (75 % aviso, 90 % crítico, 100 % agotado), hora de renovación y plan que la amplía.
- La web muestra un banner que se puede ocultar hasta el día siguiente, y los contadores en «Plan, límites y créditos».
- Una asignación total de una unidad que simplemente está en uso (el único asiento de Free) se muestra como «Completo», sin aviso diario.

### 7. «IA DNI Growth»
- El middleware `aiPrivacy` pasa por `scrubAi` todo el JSON de los espacios de cliente. Quita:
  - modelos
  - costes
  - intentos
  - proveedores (se reescriben como `dni_ai`)
  - nombres dentro de texto libre
- Solo el personal de plataforma ve los motores reales.
- `/ai/provider-status`, `/ai/models` y `/ai/preferences` son solo de plataforma.
- **Excepción GEO**: AI Visibility mide cómo responden asistentes públicos (Gemini). Ahí el nombre del motor es la *fuente de la métrica* y se mantiene, porque ocultarlo haría falsa la fuente. Los identificadores de modelo y las versiones sí se ocultan (`scrubModelIds`).
- La página legal de privacidad sigue listando los subencargados, como exige el RGPD.

### 8. Operaciones y BI
- Pestañas: IA (7 días por día, proveedor y plan, más el uso de hoy por organización), Operaciones (trabajos atascados >30 min, fallos, outbox, webhooks, recuentos de base de datos) y Auditoría (emails enmascarados).
- Cada bloque cita su fuente.
- R2 y las métricas del Worker no se muestran: necesitarían un token de API adicional.

### 9. Móvil
- `h-dvh` y menú lateral como `role=dialog`, con bloqueo de scroll y Escape.
- Cabecera sin `backdrop-blur` (causaba parpadeo) y con *safe-area*.
- `overflow-x: clip`, campos a 16 px por debajo de 768 px para que iOS no haga zoom, y botón de menú de 44 px.
- `theme-init.js` aplica el tema antes de pintar: evita el destello, y la CSP impide los scripts en línea.

## Consecuencias
- Dependencia nueva: `qrcode-generator@2.0.4` (MIT, sin red). Genera el QR en el navegador, así el secreto TOTP nunca sale a un servicio externo.
- Migración aditiva `0017_platform_control.sql`, con copia previa `backups/pre-0017-platform-20261120-0128.sql`.
- Pendiente de la titular: ejecutar el script de vinculación y activar el segundo factor. Hasta entonces la consola funciona en modo lectura.
