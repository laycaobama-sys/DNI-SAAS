# ADR 0015 — Captación de leads y CRM propio (F5)

Fecha: 2026-11-18 · Estado: aceptado

## Contexto
El flujo clave 3 del producto termina en «lead → CRM → ingresos atribuidos». La titular autorizó continuar con todo lo pendiente sin gastos nuevos. Requisitos del backlog (F5): captación antispam con validación, deduplicación y atribución UTM; pipeline con asignación, estado, historial y acceso por rol; consentimiento por finalidad. La web dnigrowth.com no tenía forma de contacto aparte del email.

## Decisión
1. **CRM propio en D1** (`lead_forms`, `leads`, `lead_events`, `crm_tasks`), multitenant con `organization_id` en cada consulta (guarda estática de SQL) y migración aditiva.
2. **Formulario público** `POST /api/v1/public/forms/:id/submit` (JSON o HTML sin JavaScript). Sin sesión ni CSRF (se envía desde webs de clientes), pero con: webs autorizadas por formulario (Origin; CORS solo para ellas), límites por IP/formulario/día, y antispam explicable sin cookies ni servicios de terceros (campo trampa, tiempo mínimo, exceso de enlaces). El spam recibe la misma respuesta que una persona y solo se cuenta.
3. **Consentimiento por finalidad**: casilla obligatoria para responder y casilla opcional, desmarcada, para comunicaciones comerciales; se guarda el texto aceptado y la fecha.
4. **Atribución sin rastreo**: UTM del enlace, página sin parámetros y solo el dominio de la web de origen.
5. **Deduplicación atómica** por (organización, email normalizado) con `INSERT … ON CONFLICT … RETURNING`; cada envío queda en el historial y se conservan las UTM del primer contacto.
6. **Privacidad**: los contactos solo los ven propietario, administración y responsable de marketing (`crm:read`); borrar (derecho de supresión) solo propietario y administración (`crm:delete`). Ni logs, ni auditoría, ni emails de aviso llevan datos personales (el aviso enlaza al CRM).
7. Turnstile de Cloudflare, WhatsApp y automatizaciones quedan fuera: requieren configuración, plantillas aprobadas u opt-in específicos.

## Consecuencias
- Los clientes pegan un formulario HTML en su web y reciben los contactos en su CRM; para esos datos DNI Growth es encargado del tratamiento (indicado en la política de privacidad).
- Los valores del pipeline los introduce el equipo; las cifras se marcan como observadas y excluyen contactos de prueba.
