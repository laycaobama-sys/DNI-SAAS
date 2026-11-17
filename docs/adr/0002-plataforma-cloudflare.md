# ADR 0002 — Plataforma Cloudflare

- Estado: aceptado · Fecha: 2026-11-17

## Decisión
Un único Worker `dni-growth` con:
- **Workers Static Assets** (`apps/web/dist`), `run_worker_first` solo para `/api/*` y `/app/*` (la SPA recibe CSP y `no-store` desde el Worker).
- **D1** `dni-growth-db` creada con `--jurisdiction eu` (id `1d423865-…`).
- **Queues** `dni-growth-jobs` (consumer `max_batch_size: 1`, `max_retries: 3`) con DLQ `dni-growth-jobs-dlq`.
- **Cron** `* * * * *`: drena outbox, recupera trabajos con lease vencido, purga ventanas de rate-limit.
- **Workers Logs** (`observability.enabled`), logs JSON redactados.

## Alternativas descartadas
- Pages + Functions: Cloudflare recomienda Workers con Static Assets para proyectos nuevos.
- Hyperdrive + Postgres externo: rompe el requisito "todo en Cloudflare".

## Riesgos abiertos
- **Límite de CPU**: en el plan Workers Free el límite es de 10 ms de CPU por invocación; el parseo HTML de un rastreo puede superarlo. Recomendado **Workers Paid** antes de clientes reales (no verificado en producción, ver IMPLEMENTATION_STATUS).
- D1 tiene un límite de 10 GB por base de datos; con crecimiento se fragmentará por cliente o se archivarán `crawl_pages` antiguas en R2.
