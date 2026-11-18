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

## Secretos (los introduce el titular; nunca en el chat)
```bash
npx wrangler secret put GOOGLE_CLIENT_SECRET   # cliente OAuth web de Google
npx wrangler secret put OPENROUTER_API_KEY     # opcional: respaldo con modelos gratuitos
npx wrangler secret put GEMINI_API_KEY         # opcional: último respaldo
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
- Versión actual: `286b5a81-6ead-4114-928f-a566e48c4718` · anterior: `11831c6d-b194-4d2e-9810-d7631a9e0d1d`.
- Rollback de código: versión estable anterior `a3a5dc09-a3dc-4ec5-b161-7835f198558f` (guardia de privacidad sin el margen de razonamiento) o `286b5a81-6ead-4114-928f-a566e48c4718` (antes de la guardia): `npx wrangler rollback <id>` desde `apps/api`. La migración 0005 es aditiva: el código anterior la ignora, no hace falta revertirla.
- Copia de D1 previa a 0005: `backups/dni-growth-db-pre-0005-20261118-0019.sql` (fuera de git).
- Detener OpenRouter al instante: Centro de IA → «Detener OpenRouter (global)» (o `POST /api/v1/admin/ai/openrouter/kill-switch {"enabled":false}`). Tras una parada automática por cobro, revisar la cuenta de OpenRouter antes de «Quitar bloqueo de seguridad».
- Redirección www → apex: regla «Redirigir de WWW a raíz» en Reglas de redireccionamiento de la zona dnigrowth.com.
