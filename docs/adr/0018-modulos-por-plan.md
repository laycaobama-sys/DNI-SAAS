# ADR 0018 — Módulos por plan, uso justo de IA y consola de plataforma

Fecha: 2026-11-19 · Estado: aceptado · Sustituye en parte a ADR 0017 (agencia en Pro)

## Contexto
La titular pidió que cada cliente vea solo lo que paga (Free solo lo gratuito, Starter sin Growth/Pro, Pro sin Agencia), que la IA siga siendo usable por plan sin agotar las cuotas gratuitas, y un panel de administración con control total para ella.

## Decisión
- **Una sola matriz** en `@dni/core/plan-access` (`MODULE_MIN_PLAN`), compartida por la API y la web:
  - Free: base (Command Center, auditoría y plan de 30 días, Asesor IA, Search Console, CRM/leads, equipo, integraciones y logs).
  - Starter: SEO técnico, keywords, AI Visibility (GEO), Content Studio, landings y tests A/B, informes.
  - Growth: backlinks/authority, Creative Studio, vídeo, automatizaciones, atribución, Analytics (GA4).
  - Pro: Ads Manager.
  - Agency: organizaciones cliente y marca blanca (`clientOrgs` de Pro pasa a 0, migración 0016).
- **La API decide**: `requirePlanModule` responde 402 `plan_required` con `{module, requiredPlan, currentPlan}`. `DELETE` nunca se bloquea (derecho de supresión); los datos se conservan al bajar de plan. La web solo muestra el candado (`PlanLockedPanel`); no es la barrera de seguridad.
- **Uso justo de IA por plan** (peticiones/día por organización, día UTC, las respuestas de caché no cuentan): Free 10, Starter 60, Growth 150, Pro 300, Agency 600. Error 429 `ai_plan_daily_limit` sin cobrar créditos. Se suma al tope global de Workers AI (0,10 $/día) y a los modelos solo gratuitos.
- **Administradora de plataforma**: ve todos los módulos (con aviso) y puede activar «Ver como cliente» para comprobar exactamente lo que ve un cliente. Consola `/app/admin` con usuarios, organizaciones, suscripciones (modo test etiquetado), IA, trabajos y actividad; cada cifra cita su fuente y hora.
- **Asignación interna de plan** (`POST /admin/organizations/:id/plan`): solo administradores, motivo obligatorio, auditada `platform.plan_assign`, 30/h, y 409 si Stripe está facturando esa organización (Stripe manda).

## Por qué cinco niveles y no tres
Se valoró reducir a 2–3 planes. Se mantienen Free + 4 de pago porque cada nivel añade un bloque claro (orgánico → crecimiento → pago → agencia) y los precios ya existen en Stripe; esconder un nivel más adelante es un cambio de catálogo, no de código. Si se quiere simplificar, la opción recomendada es ocultar Pro y mover Ads a Growth o a Agency.

## Consecuencias
- Los tests de API crean organizaciones con el plan que necesitan; hay pruebas de cada plan × módulo, del bypass de administración, de la asignación interna y del 409 con Stripe.
- Ciclo real verificado en Stripe modo test (Starter → Pro → Agency → cancelada) con el panel en «Ver como cliente».
