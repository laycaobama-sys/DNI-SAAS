# ADR 0005 — Autenticación propia (en lugar de Supabase Auth)

- Estado: aceptado · Fecha: 2026-11-17

## Decisión
- Contraseñas: PBKDF2-SHA256, 100 000 iteraciones (máximo soportado por WebCrypto en Workers), sal aleatoria de 16 bytes, comparación en tiempo constante. Mínimo 12 caracteres con letras y números.
- Sesiones: token aleatorio de 32 bytes en cookie `dni_session` (HttpOnly, SameSite=Lax, Path=/; Secure fuera de desarrollo); en D1 solo se guarda su SHA-256. Caducidad deslizante de 7 días con tope absoluto de 30.
- Verificación de email y reset de contraseña: tokens de un solo uso, hasheados, con caducidad; el reset revoca todas las sesiones.
- Anti-enumeración: registro, reenvío y reset responden igual exista o no el email.
- Bloqueo de cuenta tras 5 fallos (15 min) + rate limiting por IP (hash con `IP_HASH_SALT`) en D1.
- CSRF: toda petición no-GET exige `x-dni-csrf: 1` y, si llega cabecera `Origin`, que sea el propio origen o `APP_ORIGIN` (los webhooks quedan exentos y se autentican por firma).

## Pendiente
- 2FA (TOTP/WebAuthn) y SSO/SAML para planes Enterprise (fase F8).
- Proveedor de email real (Resend) — sin él, en producción los correos **no** se envían y la UI lo dice.
