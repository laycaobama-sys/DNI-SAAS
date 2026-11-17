# ADR 0008 — Inicio de sesión con Google (OIDC)

- Estado: aceptado · Fecha: 2026-11-17

## Decisión
- Flujo authorization code + PKCE S256, `scope=openid email profile`, `prompt=select_account`.
- `state` aleatorio de 32 bytes: cookie HttpOnly `dni_oauth_state` (Path `/api/v1/auth/google`, 10 min) y fila `oauth_states` por SHA-256, consumida con `DELETE … RETURNING` (un solo uso). `nonce` comprobado en el ID token.
- ID token obtenido directamente del endpoint de tokens de Google por TLS con el secreto del cliente (OIDC Core §3.1.3.7); se validan `iss`, `aud`, `exp`, `nonce` y `email_verified=true`.
- Vinculación: identidad conocida → login; email existente verificado → se vincula; email existente **no** verificado → se vincula, se marca verificado, se **desactiva la contraseña** (`oauth$disabled`), se revocan sesiones y tokens y se audita (defensa contra cuentas prerregistradas); si no existe → usuario nuevo verificado sin contraseña utilizable.
- Redirección final solo a rutas `/app/...` validadas (sin redirección abierta).
- Configuración: `GOOGLE_CLIENT_ID` (var) + `GOOGLE_CLIENT_SECRET` (secreto); URI `${APP_ORIGIN}/api/v1/auth/google/callback`.

## Consecuencias
- Google desbloquea la validación de F1 en producción sin dominio de email (cuenta verificada de forma legítima).
- Un usuario creado con Google puede fijar contraseña con «¿Has olvidado tu contraseña?» cuando haya email.
