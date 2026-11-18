# ADR 0016 — Landings por bloques, tests A/B y automatizaciones de seguimiento

Fecha: 2026-11-19 · Estado: aceptado

## Contexto
F5 pide un constructor de landings conectado al CRM y automatizaciones de seguimiento; F7 pide tests A/B con hipótesis, muestra mínima y avisos de significancia. Restricciones: sin costes nuevos, sin cookies de seguimiento, contenido de terceros tratado como datos, efectos externos auditados.

## Decisión
- **Contenido por bloques en JSON validado con Zod**, nunca HTML: el servidor escapa todo; solo imágenes `https://` y enlaces `https://` o `#formulario`. Cada guardado crea una versión (bloqueo optimista con `baseVersionId`); restaurar crea otra versión.
- **Publicación en `dnigrowth.com/l/<slug de organización>/<slug>`**, servida por el Worker con CSP estricta (un script con nonce, `connect-src 'self'`, sin terceros), sin cookies y `no-store`. Publicar/despublicar requiere `landings:publish` y queda auditado. Un bloque de formulario exige un formulario activo del CRM.
- **Medición agregada** en `landing_stats_daily` (vistas y conversiones por día, variante y versión), sin filas por visitante. Se excluyen robots declarados y peticiones HEAD. Conversión = envío válido (no spam) del formulario de la propia landing.
- **A/B sin cookies**: la variante se elige con el hash salado de la IP (`% 100 < split_b`), estable por conexión. Prueba z de dos proporciones con p bilateral; veredicto solo con ≥100 visitas por variante y ≥10 conversiones; avisos permanentes sobre mirar resultados repetidamente y cambios de red. Mientras hay test no se puede publicar otra versión.
- **Automatizaciones** por formulario, desactivadas por defecto y configurables solo con `forms:manage`: respuesta automática (solo contactos nuevos, una vez por contacto vía `crm_automation_runs` único, tope 50/día, horas de silencio en Europe/Madrid usando `email_outbox.next_attempt_at`, idempotencia `auto-reply:<automatización>:<contacto>`) y tarea de seguimiento. Borrar un contacto cancela su respuesta pendiente y elimina la copia cifrada.

## Consecuencias
- Coste cero: todo corre en el Worker y D1 existentes; el correo usa el cupo mensual ya limitado.
- Dominio propio por cliente (Cloudflare for SaaS) queda fuera: puede tener coste y requiere decisión de la titular.
- Sin cookies, una persona que cambia de red puede ver ambas variantes; se documenta en los avisos.
