# ADR 0006 — Email transaccional con Cloudflare Email Service y outbox cifrado

- Estado: aceptado · Fecha: 2026-11-17 · Sustituye la mención a Resend del ADR 0005

## Contexto
El titular exige que toda la infraestructura esté en Cloudflare y que el email no use Resend. Los emails de verificación, reset e invitación contienen enlaces de un solo uso.

## Decisión
- Proveedor `CloudflareEmailProvider` sobre el binding oficial `send_email` (`env.EMAIL.send({from,to,subject,text,html})`), detrás de la interfaz `TransactionalEmailProvider` (tests sin red con un binding falso).
- Outbox durable `email_outbox`: destinatario como SHA-256 + máscara; mensaje cifrado con AES-256-GCM (`DATA_ENC_KEY`, AAD = id de la fila); clave de idempotencia única; intento inmediato y reintentos por cron con backoff exponencial (1 min → 1 h), máximo 5 intentos → `dead`; errores de configuración (remitente o dominio no verificado) → `dead` sin reintentar; el contenido se purga al aceptarse o al morir.
- `EMAIL_SENDING_ENABLED` debe ser `"true"` y `MAIL_FROM` pertenecer a un dominio incorporado en Email Sending. Sin eso, el modo es `not_configured`: no se encola nada y la UI lo explica.
- La respuesta del registro expone el **modo de la plataforma**, nunca un resultado por usuario (sin enumeración).

## Consecuencias
- El envío real queda **bloqueado por dominio** hasta que el titular compre uno y lo incorpore.
- `accepted` = aceptado por Cloudflare; no prueba la entrega en bandeja.
- Rotar `DATA_ENC_KEY` deja como `dead` los emails pendientes (aceptable: son enlaces que se pueden volver a pedir).
