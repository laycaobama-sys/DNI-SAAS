# ADR 0023 — Activación (Fase 2): auditoría gratuita sin registro, bienvenida guiada y correos de ayuda

- Fecha: 2026-11-24
- Estado: aceptada
- Contexto: plan comercial `docs/PLAN_DNI_GROWTH.md`, Fase 2. Objetivo: que un visitante vea valor real (su nota y sus problemas con evidencia) antes de crear la cuenta, y que después sepa qué hacer en sus primeros días.

## Decisión

1. **Auditoría gratuita sin cuenta** (`POST /api/v1/public/audits`, página `/auditoria/{id}`):
   - Mismo rastreador y mismas reglas que el análisis completo (`jobs/crawl.ts`, compartido con `jobs/analyze.ts`), limitado a **5 páginas** públicas. Sin IA y sin créditos: coste 0 €.
   - Mismas defensas que el análisis: solo URL públicas (sin IP, redes internas ni puertos raros; DNS revisado en cada salto), `robots.txt`, tiempo máximo y tamaño máximo. El contenido de la web es **dato**, nunca instrucciones.
   - Límites: 6 por hora y 20 al día por IP (código de IP con sal, nunca la IP), tope global de 400 al día (`public_audit_daily_cap`), solo desde el propio dominio (cabecera `Origin`).
   - Caché de 24 h por dominio: si alguien repite la misma web, recibe una copia del resultado ya hecho, sin volver a rastrear.
   - Cola propia (`{kind: "public_audit"}`) con toma atómica (`queued → running`), 3 intentos, reenvío de las perdidas y caducidad de las atascadas desde el cron. Sin cola, se ejecuta en segundo plano en la propia petición.
   - Las auditorías anónimas se borran a los 30 días; las que pasan a una cuenta se conservan.
2. **Notas por área** (`packages/core/src/public-audit.ts`): nota global = salud de la auditoría completa; Técnica, SEO y GEO/AEO = 100 × (1 − puntos perdidos / máximo), con pesos por gravedad (crítica 20, alta 10, media 5, baja 2). Cada regla cuenta una vez; no cuentan las páginas legales ni el volumen de contenido. Tipo de medida: **derivada** (se dice en la página, con su método). Junto al número va siempre una palabra («Bien», «Mejorable», «Urgente»).
3. **Adelanto, no informe completo**: la página pública muestra las 3 incidencias que más pesan con evidencia y solución, y «otros N problemas». La lista completa y el plan de 30 días se ven al crear la cuenta (gratis, sin tarjeta). La página es `noindex, nofollow` y `no-store`; cualquiera con el enlace la ve (es lo que permite compartirla).
4. **Comparación con un competidor** (`POST /audits/:id/compare`, `?vs=`): se audita igual y en fila aparte (`compare_of`, `is_competitor`); nunca se modifica la auditoría original. No se compara una web consigo misma.
5. **Paso a la cuenta**: `/app/register?audit=ID` guarda el id en el navegador (`dni.pendingAudit`). Al crear la organización, `POST /orgs/:id/public-audits/:auditId/claim` la asocia (si otra organización ya la tenía, se copia), borra el código de IP y deja el análisis completo precargado. Queda en el historial de auditoría.
6. **Bienvenida de 6 pasos** (`/o/:id/bienvenida`, `GET /orgs/:id/activation`, `PUT /orgs/:id/onboarding`): marca, competidores, Google, CMS, modo de trabajo y primer artículo. El estado sale de los **datos reales**, no de casillas; solo se pueden dejar para más tarde competidores, Google y CMS. Lo que aún no existe lo dice:
   - CMS: «En desarrollo» (WordPress todavía no está; se exporta en HTML/Markdown).
   - Piloto automático: se guarda la preferencia, pero **todo sigue esperando aprobación** hasta que exista con límites, consentimiento, interruptor de parada y auditoría.
   - Primer artículo: «Desde Starter» en el plan Free.
   El panel muestra la lista hasta que no queda ningún paso pendiente.
7. **Correos de ayuda** a las 24 h y 72 h del alta (`lib/lifecycle.ts`), solo para cuentas creadas después de activar la función (`lifecycle_emails_since`), una vez por persona y tipo, nunca con más de 48 h de retraso y solo si queda algo pendiente. Baja en un clic con enlace firmado (GET muestra la confirmación, POST la aplica) y respetada para siempre.
8. **Eventos** de la analítica propia: `audit_started` (servidor, `from: public`) y `audit_teaser_viewed` (página).

## Consecuencias

- Migración aditiva `0021_activation.sql` (3 tablas nuevas y una columna en `users`), con copia previa de D1.
- Privacidad actualizada: auditoría gratuita (30 días), correos de ayuda y almacenamiento local `dni.pendingAudit`.
- Pendiente y dicho en la interfaz: imagen social dinámica con la nota (hoy imagen fija con título y descripción dinámicos), conexión con CMS (Fase 4) y piloto automático real.
- Pruebas: `apps/api/test/activation.test.ts` (10) y `packages/core/test/public-audit.test.ts` (5).
