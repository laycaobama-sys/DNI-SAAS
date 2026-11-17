# ADR 0001 — Stack y versiones

- Estado: aceptado · Fecha: 2026-11-17

## Contexto
La arquitectura de referencia (`docs/spec/03_ARQUITECTURA_API_DATOS.md`) propone Next.js + NestJS/Fastify + Postgres/Supabase + Redis/BullMQ. El propietario exige que **todo** (deploy, base de datos y proyecto) viva en Cloudflare.

## Decisión
| Capa | Elegido | Versión |
|---|---|---|
| Runtime | Cloudflare Workers | compat. 2026-11-01, `nodejs_compat` |
| API | Hono | 4.13.19 |
| Validación | Zod | 4.6.7 |
| Front app | React + React Router (SPA en `/app`) | 19.3.1 / 8.5.1 |
| Build | Vite + Tailwind CSS | 8.3.8 / 4.3.5 |
| Landing | HTML estático + TS mínimo (sin framework) | — |
| Tests | Vitest | 5.1.0 |
| Lenguaje | TypeScript | **6.0.3** |
| Tooling | Wrangler 4.163, ESLint 10.15, typescript-eslint 8.72 |

## Desviaciones
- **Vite SPA en lugar de Next.js**: Workers Static Assets sirve el HTML estático (landing indexable con SEO/JSON-LD sin JS) y la SPA autenticada no necesita SSR (no indexable). Elimina un adaptador y reduce superficie.
- **TypeScript 6.0.3 y no la última**: typescript-eslint 8.x declara soporte `<6.1`.
- pnpm 11 con `minimumReleaseAge` activo: se resuelven versiones con al menos unos días de antigüedad (defensa ante paquetes comprometidos recién publicados). No se añadieron exclusiones.

## Consecuencias
Un único despliegue (`wrangler deploy`) publica API, landing y app. Ver ADR 0002–0005 para datos, colas y auth.
