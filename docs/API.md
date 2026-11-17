# API v1 — referencia

Base: `/api/v1`. JSON; errores en `application/problem+json` (`type`, `title`, `status`, `code`, `requestId`, y `errors[]` en validación).
Toda petición que no sea GET requiere la cabecera `x-dni-csrf: 1` (salvo webhooks). Autenticación por cookie `dni_session`.
Las rutas `/orgs/:orgId/*` exigen sesión con email verificado y membresía activa (404 si no eres miembro) y el permiso indicado.

> Contrato OpenAPI formal: pendiente (desviación documentada; los esquemas Zod de `packages/core/src/contracts.ts` son la fuente de verdad).

## Público
| Método | Ruta | Notas |
|---|---|---|
| GET | `/health` | estado y entorno |
| GET | `/providers` | estado honesto de cada integración |
| POST | `/webhooks/stripe` | firma `Stripe-Signature` obligatoria; idempotente por `event.id` |

## Autenticación
| Método | Ruta | Cuerpo |
|---|---|---|
| POST | `/auth/register` | `{name,email,password}` → 202 `{delivery: sent\|not_configured}` |
| POST | `/auth/verify-email` | `{token}` |
| POST | `/auth/resend-verification` | `{email}` (respuesta idéntica exista o no) |
| POST | `/auth/login` | `{email,password}` |
| POST | `/auth/logout` | — |
| POST | `/auth/password-reset/request` | `{email}` |
| POST | `/auth/password-reset/confirm` | `{token,password}` (revoca todas las sesiones) |
| GET | `/auth/me` | usuario + membresías |
| POST | `/orgs` | `{name}` → crea organización (tú = propietario) |
| POST | `/invitations/accept` | `{token}` |

## Organización (`/orgs/:orgId`)
| Método | Ruta | Permiso |
|---|---|---|
| GET | `/` | `org:read` (devuelve rol y permisos efectivos) |
| GET | `/dashboard` | `org:read` (métricas con `measurement`, `source`, `observedAt`, `limitations`) |
| GET | `/members` | `members:read` |
| POST | `/invitations` | `members:invite` `{email,role}` |
| DELETE | `/invitations/:invId` | `members:invite` |
| PATCH | `/members/:memberId` | `members:manage` `{role}` |
| DELETE | `/members/:memberId` | `members:manage` |
| GET | `/audit-logs?before=` | `audit:read` (paginado por cursor) |
| GET | `/integrations` | `integrations:read` |
| GET | `/brands` · POST `/brands` | `brand:read` · `brand:write` |
| POST | `/sites/analyze` | `site:analyze` · cabecera `Idempotency-Key` · `{url, brandId?, brandName?}` → 202 `{jobId}`; 422 `url_blocked`, 402 `plan_limit`/`insufficient_credits` |
| GET | `/jobs` · `/jobs/:jobId` | `jobs:read` |
| POST | `/jobs/:jobId/cancel` · `/jobs/:jobId/retry` | `jobs:control` · `site:analyze` |
| GET | `/crawls` · `/crawls/:crawlId` | `audit_results:read` |
| GET/PUT | `/brands/:brandId/profile` | `brand:read` / `brand:write` (editar devuelve el perfil a borrador) |
| POST | `/brands/:brandId/profile/confirm` | `brand:confirm` (422 si falta nombre, público u objetivo) |
| GET | `/plans/:planId` · `/plans/:planId/export?format=md\|json` | `plan:read` |
| PATCH | `/plans/:planId/tasks/:taskId` | `plan:write` (409 si la tarea está bloqueada) |
| GET | `/billing` · POST `/billing/checkout` | `billing:read` · `billing:manage` (503 si Stripe no está configurado) |
