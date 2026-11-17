# Runbook de operación

Todos los comandos se ejecutan desde `apps/api` con Wrangler autenticado en la cuenta de Cloudflare. **Nunca** pegues secretos en el chat, en issues ni en commits.

## Recursos en Cloudflare
| Recurso | Nombre |
|---|---|
| Worker | `dni-growth` → https://dni-growth.ibraguimova19.workers.dev |
| D1 (UE) | `dni-growth-db` |
| Queues | `dni-growth-jobs`, DLQ `dni-growth-jobs-dlq` |
| Cron | cada minuto (outbox + recuperación) |

## Desplegar
```bash
pnpm db:migrate:remote     # desde la raíz; aplica migraciones nuevas
pnpm deploy                # build de la web + wrangler deploy
```
Antes de cada release: `pnpm verify`.

## Secretos
```bash
npx wrangler secret put RESEND_API_KEY
npx wrangler secret put MAIL_FROM            # p. ej. "DNI Growth <no-reply@tudominio.com>"
npx wrangler secret put STRIPE_SECRET_KEY
npx wrangler secret put STRIPE_WEBHOOK_SECRET
npx wrangler secret list
```
`IP_HASH_SALT` ya está configurado (valor aleatorio, no recuperable).

### Stripe
1. Crear un producto y precio mensual por plan (starter, growth, pro, agency).
2. Guardar cada `price_…` en D1:
   ```bash
   npx wrangler d1 execute DB --remote --command "UPDATE plans SET stripe_price_id = 'price_xxx' WHERE code = 'starter'"
   ```
3. Webhook → `https://<dominio>/api/v1/webhooks/stripe` con eventos `checkout.session.completed`, `customer.subscription.created|updated|deleted`.
4. Probar primero con claves `sk_test_…` y un pago de prueba.

## Verificar manualmente a un usuario (mientras no haya proveedor de email)
Solo para personas cuya identidad conoces:
```bash
npx wrangler d1 execute DB --remote --command "UPDATE users SET email_verified_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE email = 'persona@empresa.com' AND email_verified_at IS NULL"
```

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
3. Recompilar la web con `SITE_URL=https://growth.tudominio.com` y desplegar.

## Revertir
```bash
npx wrangler deployments list
npx wrangler rollback <version-id>
```
Las migraciones de D1 son solo hacia delante; D1 Time Travel permite restaurar la base de datos a un punto de los últimos 30 días.
