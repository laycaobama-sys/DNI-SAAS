# ADR 0003 — Aislamiento multiempresa en D1 (sin RLS)

- Estado: aceptado · Fecha: 2026-11-17

## Contexto
CLAUDE.md exige `organization_id` + RLS forzada. D1 (SQLite) no tiene Row Level Security.

## Decisión — defensa en profundidad equivalente
1. **Toda tabla de cliente** tiene `organization_id NOT NULL` y `UNIQUE(organization_id, id)`.
2. **FKs compuestas** `(organization_id, x_id) REFERENCES x(organization_id, id)`: la base de datos rechaza enlazar un registro de otra organización (probado en `tenancy.test.ts`).
3. **Resolución del tenant en un único middleware** (`requireMembership`): la organización sale de la ruta `/orgs/:orgId` y se valida contra `memberships` del usuario autenticado; un no-miembro recibe **404** (no revela existencia).
4. **Toda consulta** filtra por `organization_id = ?` vinculado al tenant del middleware. Un **test estático** (`tenancy.test.ts › static SQL guard`) analiza todo el SQL de `apps/api/src` y falla si una consulta sobre tabla de cliente no filtra por `organization_id` (ya detectó y corrigió un fallo real en `invitations`).
5. **Tests IDOR** cruzados: un miembro de la org A no puede leer/editar/cancelar recursos de B ni adivinando IDs.
6. `audit_logs` y `credit_ledger` son **append-only** mediante triggers (UPDATE/DELETE abortan).

## Consecuencias
La garantía depende de código + tests, no del motor. Cualquier ruta nueva debe montarse bajo el router `tenant` y pasar el guard estático (CI lo ejecuta).
