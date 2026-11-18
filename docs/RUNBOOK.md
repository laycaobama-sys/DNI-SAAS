# Runbook de operación

Todos los comandos se ejecutan desde `apps/api` con Wrangler autenticado en la cuenta de Cloudflare. **Nunca** pegues secretos en el chat, en issues ni en commits.

## Recursos en Cloudflare
| Recurso | Nombre |
|---|---|
| Worker | `dni-growth` → https://dni-growth.ibraguimova19.workers.dev |
| D1 (UE) | `dni-growth-db` |
| Queues | `dni-growth-jobs`, DLQ `dni-growth-jobs-dlq` |
| Cron | cada minuto (outbox de trabajos, cola de emails, recuperación) |
| R2 (UE) | `dni-growth-media` (imágenes generadas) |
| Workers AI | binding `AI` (tope diario `AI_DAILY_BUDGET_USD`) |
| Email Service | binding `EMAIL`; envío desactivado hasta tener dominio |

## Desplegar
```bash
pnpm db:migrate:remote     # desde la raíz; aplica migraciones nuevas
pnpm deploy                # build de la web + wrangler deploy
```
Antes de cada release: `pnpm verify`.

## Configuración (un solo sitio)
Variables públicas en `apps/api/wrangler.jsonc` → `vars`: `APP_ORIGIN` (de ella salen cookies, redirección OAuth, enlaces de email, canonical y sitemap), `EMAIL_SENDING_ENABLED`, `MAIL_FROM`, `GOOGLE_CLIENT_ID`, `BILLING_ENABLED`, `AI_DAILY_BUDGET_USD`.

## Datos legales del titular
- Fuente única: `apps/web/legal/legal-identity.local.json` (copia de `legal-identity.example.json`). Está en `.gitignore` porque el repositorio es público: no se sube nunca.
- `pnpm build` en local falla si el archivo falta; en CI (`CI=true`) se compila con el aviso «datos del titular no configurados». Desplegar siempre desde una máquina que tenga el archivo.
- Solo se usa en `/legal/aviso-legal`, `/legal/privacidad` y `/legal/condiciones` (marcadores `<!--LEGAL:...-->` y `__LEGAL_...__`).

## Secretos (los introduce el titular; nunca en el chat)
```bash
npx wrangler secret put GOOGLE_CLIENT_SECRET   # cliente OAuth web de Google
npx wrangler secret put OPENROUTER_API_KEY     # opcional: respaldo con modelos gratuitos
npx wrangler secret put GEMINI_API_KEY         # opcional: monitor GEO y respaldo de texto
npx wrangler secret put GROQ_API_KEY           # opcional: respaldo gratuito de Workers AI (openai/gpt-oss-20b)
npx wrangler secret put STRIPE_SECRET_KEY      # solo cuando se active Stripe
npx wrangler secret put STRIPE_WEBHOOK_SECRET
npx wrangler secret list
```
Ya configurados (aleatorios, no recuperables): `IP_HASH_SALT`, `DATA_ENC_KEY` (cifra la cola de emails; si se rota, los emails pendientes pasan a `dead`).

## Activar el email (Cloudflare Email Service)
1. Tener el dominio en Cloudflare (DNS gestionado por Cloudflare).
2. Panel → Compute → Email Service → Email Sending → incorporar el dominio y aceptar los registros DNS (SPF/DKIM) que propone.
3. En `wrangler.jsonc`: `"MAIL_FROM": "no-reply@tudominio"`, `"EMAIL_SENDING_ENABLED": "true"`, y `APP_ORIGIN` al dominio final.
4. `pnpm deploy` y registrar una cuenta de prueba propia: el email debe llegar y `email_outbox` mostrar `accepted`.
```bash
npx wrangler d1 execute DB --remote --command "SELECT kind, status, attempts, last_error_code, created_at FROM email_outbox ORDER BY created_at DESC LIMIT 20"
```
`accepted` significa que Cloudflare aceptó el mensaje, no que llegó a la bandeja.

## Activar Google
1. Google Cloud → proyecto **DNI Growth** → Google Auth Platform: completar la marca y aceptar la política de datos.
2. Clientes → Crear cliente → Aplicación web. Origen: `APP_ORIGIN`. URI de redirección: `<APP_ORIGIN>/api/v1/auth/google/callback`.
3. Copiar el ID de cliente en `vars.GOOGLE_CLIENT_ID` y guardar el secreto con `npx wrangler secret put GOOGLE_CLIENT_SECRET`.
4. Público: en modo «Prueba» solo entran los usuarios de prueba añadidos; para abrirlo a todos, «Publicar app» (scopes básicos `openid email profile`, sin revisión de Google).
5. Al cambiar de dominio, añadir el nuevo origen y URI de redirección en el cliente.

## IA
- Estado y gasto del día: `GET /api/v1/orgs/<org>/ai/status` o
  `npx wrangler d1 execute DB --remote --command "SELECT * FROM ai_usage_daily ORDER BY day DESC LIMIT 10"`
- Fallos por modelo en logs: evento `ai.model_failed`.
- Orden «automático»: Workers AI (gemma-4-26b → glm-4.7-flash) → Groq (si hay clave) → Gemini (si hay clave) → OpenRouter `:free`. Datos sensibles: solo Workers AI.
- Tope de Workers AI: `AI_DAILY_BUDGET_USD` (máx. 0,10 USD ≈ 9.091 neuronas/día, por debajo de las 10.000 gratuitas; la cuenta está en Workers Paid). Cambiar de modelo sin código: variable `WORKERS_AI_TEXT_MODEL`.
- Comprobar cada proveedor sin esperar a un fallo: Centro de IA → «Probar conexión» (solo administración, máx. 20/día).
- Topes de respaldo: `GROQ_DAILY_REQUESTS` (900; Groq gratis = 1.000/día), `GROQ_TEXT_MODEL` (por defecto `openai/gpt-oss-20b`), `GEMINI_TEXT_DAILY` (100). Caché 24 h en `ai_response_cache` (el cron borra lo caducado).

## Stripe (solo cuando se active `BILLING_ENABLED`)
1. Crear un producto y precio mensual por plan (starter, growth, pro, agency).
2. Guardar cada `price_…` en D1:
   ```bash
   npx wrangler d1 execute DB --remote --command "UPDATE plans SET stripe_price_id = 'price_xxx' WHERE code = 'starter'"
   ```
3. Webhook → `https://<dominio>/api/v1/webhooks/stripe` con eventos `checkout.session.completed`, `customer.subscription.created|updated|deleted`.
4. Probar primero con claves `sk_test_…` y un pago de prueba.

## Trabajos atascados o en DLQ
```bash
npx wrangler d1 execute DB --remote --command "SELECT id, state, attempts, failure_code, dead_lettered_at FROM jobs WHERE state IN ('queued','running') OR dead_lettered_at IS NOT NULL ORDER BY created_at DESC LIMIT 20"
```
El cron recupera leases vencidos. Un job en DLQ ya liberó sus créditos; el usuario puede relanzar desde la app («Volver a intentar»).

## Logs
```bash
npx wrangler tail dni-growth --format pretty
```
Los logs son JSON con datos sensibles redactados.

## Dominio propio
1. Añadir el dominio a Cloudflare.
2. En `wrangler.jsonc` añadir `"routes": [{ "pattern": "growth.tudominio.com", "custom_domain": true }]` y cambiar `APP_ORIGIN`.
3. `pnpm deploy` (la web toma `APP_ORIGIN` de `wrangler.jsonc`). Actualizar Google OAuth y Search Console con el nuevo origen.

## Revertir
```bash
npx wrangler deployments list
npx wrangler rollback <version-id>
```
Las migraciones de D1 son solo hacia delante; D1 Time Travel permite restaurar la base de datos a un punto de los últimos 30 días:
```bash
npx wrangler d1 time-travel info dni-growth-db
npx wrangler d1 time-travel restore dni-growth-db --bookmark=<marcador>
```
Copias exportadas antes de cada migración en `backups/` (fuera de git).

## Despliegue 2026-11-18 (dominio + Model Hub + Content Studio)
- Versión actual (CRM y formulario de contacto, migración 0013): `c43757da-16be-468f-ab26-8f41001a2f41`. Copia previa a 0013: `backups/dni-growth-db-pre-0013-20261118-2155.sql`. Variable nueva (no secreta): `SITE_CONTACT_FORM_ID` = formulario «Contacto web dnigrowth.com» de la organización DNI Growth. Para cerrar el formulario sin desplegar: CRM → Formularios → «Pausar». Migración aditiva: revertir el código no requiere tocar la base de datos.
- Versión anterior (IA gratuita centralizada + recomendaciones GEO + informes, migración 0012): `b9cf00ee-01f9-4f00-a6a0-c1d17d0e12a1`. Anteriores del mismo día: `7bd521b9…`, `c7b15032…`, `9843c6aa…`. Copia previa a 0012: `backups/dni-growth-db-pre-0012-20261118-2014.sql`. Variables nuevas (no secretas): `GROQ_DAILY_REQUESTS=1000`, `GEMINI_TEXT_MODEL=gemini-3.5-flash-lite`, `GEMINI_TEXT_DAILY=100`. Secreto opcional `GROQ_API_KEY` (lo pone la titular). Migración aditiva: revertir el código no requiere tocar la base de datos.
- Versión actual: `286b5a81-6ead-4114-928f-a566e48c4718` · anterior: `11831c6d-b194-4d2e-9810-d7631a9e0d1d`.
- Versión anterior (monitor GEO con Gemini gratuito, migración 0011): `d2b1cc65-5d2d-4f4a-94b7-825c57451e0c`. Copia previa `backups/dni-growth-db-pre-0011-20261118-1608.sql`. Variables nuevas (no secretas): `GEMINI_MODEL=gemini-3.8-flash`, `GEMINI_FALLBACK_MODEL=gemini-3.5-flash-lite`; secreto existente `GEMINI_API_KEY` (lo pone la titular con `wrangler secret put`). Para pausar el muestreo sin desplegar código: `GEO_SAMPLES_DAILY_GLOBAL=0`. Migración aditiva: revertir el código no requiere tocar la base de datos.
- Versión anterior (biblioteca de prompts GEO, migración 0010): `34d73cb4-a04a-45a0-b495-d36df5d5bd18` · anterior `74c3b3ef-27cc-4ce9-aa7b-5fe1f8525528`. La migración es aditiva: revertir el código no requiere tocar la base de datos.
- Versión configuración legal centralizada + condiciones de uso: `74c3b3ef-27cc-4ce9-aa7b-5fe1f8525528` · anterior `88f00104-f0e8-4b76-b92e-2693fb18af44` (sin migración).
- Versión política de privacidad completa: `88f00104-f0e8-4b76-b92e-2693fb18af44` · anterior `b4fd58a3-6282-4c8a-af4b-3db82534a95b` (sin selección automática de propiedades de Google; sin migración).
- Versión GA4 + política con datos de Google: `bfe01bbc-dae4-4b30-bbb9-c24ef4cae12c` · anterior `ab2bbe5a-6081-4e35-886e-83cbba110f67`.
- Versión con Google Analytics 4 (F3): `ab2bbe5a-6081-4e35-886e-83cbba110f67` · anterior `dd5caec3-b99f-4d80-ab49-ba871406cde5` (compatible con la migración 0009: solo añade tablas e índice). Copia previa: `backups/dni-growth-db-pre-0009-20261118-1301.sql`.
- Versión anterior (ajustes del panel de Search Console): `dd5caec3-b99f-4d80-ab49-ba871406cde5` · anterior `d5b448f0-41dd-4306-8680-592b0972e630`.
- Versión con Search Console (F3): `d5b448f0-41dd-4306-8680-592b0972e630` · anterior `73543193-44d6-4e24-a483-9e0337c910d2` (compatible con la migración 0008: solo añade tablas y columnas). Copia previa: `backups/dni-growth-db-pre-0008-20261118-1158.sql`.
- Versión con Stripe completo y cancelación programada: `73543193-44d6-4e24-a483-9e0337c910d2` · anterior `88123eb7-3969-4089-9d66-92914ebe3c83` (compatible con la migración 0007: la columna nueva tiene valor por defecto).
- Copia de D1 previa a 0007: `backups/dni-growth-db-pre-0007-20261118-0321.sql` (fuera de git).
- Rollback de código más antiguo: `1c75f4dd-bbe3-4728-9355-317fce11062b` (antes de Stripe reforzado; compatible con la migración 0006, que solo añade columnas y una tabla) o `a3a5dc09-a3dc-4ec5-b161-7835f198558f`: `npx wrangler rollback <id>` desde `apps/api`. La migración 0005 es aditiva: el código anterior la ignora, no hace falta revertirla.
- Copia de D1 previa a 0005: `backups/dni-growth-db-pre-0005-20261118-0019.sql` (fuera de git).
- Detener OpenRouter al instante: Centro de IA → «Detener OpenRouter (global)» (o `POST /api/v1/admin/ai/openrouter/kill-switch {"enabled":false}`). Tras una parada automática por cobro, revisar la cuenta de OpenRouter antes de «Quitar bloqueo de seguridad».
- Redirección www → apex: regla «Redirigir de WWW a raíz» en Reglas de redireccionamiento de la zona dnigrowth.com.
