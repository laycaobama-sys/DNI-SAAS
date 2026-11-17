# DNI Growth

SaaS B2B multiempresa de crecimiento digital (SEO técnico, GEO, AEO, y en fases posteriores Ads, CRM y atribución), desplegado al 100 % en Cloudflare. Nombre interno del producto en las especificaciones: *GrowthOS AI*; marca comercial: **DNI Growth** (familia DNI, junto a DNI GYM y DNI DIRECTO 24/7).

- Producción: https://dni-growth.ibraguimova19.workers.dev
- Especificaciones: [`docs/spec/`](docs/spec/) · Estado real: [`docs/IMPLEMENTATION_STATUS.md`](docs/IMPLEMENTATION_STATUS.md) · Decisiones: [`docs/adr/`](docs/adr/) · Seguridad: [`docs/SECURITY.md`](docs/SECURITY.md) · Operación: [`docs/RUNBOOK.md`](docs/RUNBOOK.md) · API: [`docs/API.md`](docs/API.md)

## Arquitectura

```
apps/web     Landing estática (HTML + TS) + SPA React 19 en /app (Vite 8, Tailwind 4)
apps/api     Cloudflare Worker (Hono): API /api/v1, Queues consumer, cron, sirve los assets
packages/core  Dominio puro y testeado: RBAC, SSRF, robots.txt, sitemap, extracción, 31 reglas SEO/GEO, marca, plan, crypto, Zod
```

Un único Worker (`dni-growth`) con:
- **D1** `dni-growth-db` (jurisdicción UE) — base de datos; aislamiento por `organization_id` (ver ADR 0003).
- **Queues** `dni-growth-jobs` + DLQ `dni-growth-jobs-dlq` — trabajos de agentes con outbox transaccional.
- **Cron** cada minuto — drena el outbox y recupera trabajos atascados.
- **Static Assets** — landing, páginas legales y SPA.

## Requisitos

Node ≥ 24 (los tests usan `node:sqlite`), pnpm 11.

## Desarrollo local

```bash
pnpm install
cp apps/api/.dev.vars.example apps/api/.dev.vars
pnpm db:migrate          # D1 local
pnpm dev                 # build de la web + wrangler dev en http://localhost:8787
```

En local los emails van al buzón de desarrollo: `GET /api/v1/dev/mailbox?email=...` (solo `ENVIRONMENT=development|test`; 404 en producción).

## Verificación (obligatoria antes de merge/release)

```bash
pnpm verify              # lint + typecheck + tests + build + secret scan
pnpm security:scan       # secret scan + pnpm audit (prod, high)
```

## Despliegue (Cloudflare)

```bash
pnpm db:migrate:remote
pnpm deploy
```

Secretos (`wrangler secret put <NOMBRE>` desde `apps/api`): `IP_HASH_SALT` (configurado), `RESEND_API_KEY` + `MAIL_FROM` (pendiente), `STRIPE_SECRET_KEY` + `STRIPE_WEBHOOK_SECRET` (pendiente). Ver [RUNBOOK](docs/RUNBOOK.md).
