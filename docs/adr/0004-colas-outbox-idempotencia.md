# ADR 0004 — Cloudflare Queues + outbox transaccional (en lugar de BullMQ)

- Estado: aceptado · Fecha: 2026-11-17

## Decisión
- Al pedir un análisis, **un único `db.batch` atómico** escribe: marca/sitio, `jobs`, reserva en `credit_ledger`, fila en `outbox_events`, `job_events` y `audit_logs`. O todo o nada.
- `dispatchOutbox` reclama cada fila (`UPDATE … WHERE status = 'pending'`, solo continúa si cambió una fila) y la envía a `JOBS_QUEUE`; si no hay binding (tests) usa `waitUntil`. El cron reintenta lo no despachado.
- El consumer reclama el job atómicamente (`UPDATE jobs SET state='running' … WHERE state='queued' RETURNING`): **entregas duplicadas no ejecutan dos veces** (test).
- Reintentos: backoff `15·2^(n-1)` s (máx. 600 s), 3 intentos; después `dead_lettered_at` + DLQ. Errores permanentes (URL bloqueada, SSRF) no se reintentan.
- Cancelación con checkpoints entre páginas; libera la reserva de créditos.
- **Idempotencia HTTP**: cabecera `Idempotency-Key` + `UNIQUE(organization_id, idempotency_key)` en `jobs`.
- **Créditos**: reservar → liquidar coste real → liberar resto; `source_event_id UNIQUE` + `INSERT OR IGNORE` impide dobles cargos; saldo = `SUM(amount)`.
- **Webhooks Stripe**: firma verificada sobre el cuerpo crudo, `UNIQUE(provider, provider_event_id)`; si el procesamiento falla se borra la marca para que el reintento de Stripe se procese.
