# Seguridad — DNI Growth

## Modelo de amenazas resumido
| Amenaza | Control | Prueba |
|---|---|---|
| Acceso entre empresas (IDOR) | tenant desde la ruta + membresía; FKs compuestas; guard SQL estático; 404 a no miembros | `tenancy.test.ts` |
| Escalada de privilegios | matriz RBAC central (`packages/core/src/rbac.ts`); nadie asigna un rol ≥ al suyo salvo el propietario; siempre queda un propietario | `tenancy.test.ts` |
| SSRF / DNS rebinding | ver abajo | `ssrf.test.ts`, `flow.test.ts` |
| CSRF | cabecera `x-dni-csrf` + comprobación de `Origin`; cookie SameSite=Lax | `auth.test.ts` |
| Robo de sesión | token opaco, solo hash en BD, HttpOnly/Secure, caducidad deslizante + absoluta, revocación en reset | `auth.test.ts` |
| Fuerza bruta / enumeración | bloqueo 5 fallos/15 min, rate limit por IP hasheada, respuestas idénticas | `auth.test.ts` |
| Doble cobro / doble ejecución | idempotencia HTTP, claim atómico de jobs, ledger con `source_event_id UNIQUE`, webhooks únicos | `flow.test.ts` |
| Inyección de prompts desde webs rastreadas | el contenido rastreado es **dato**: hoy no se envía a ningún LLM; las reglas son deterministas | — |
| Fuga de secretos/PII en logs | `redact()` en logs y auditoría; secretos solo como Workers Secrets; `scripts/secret-scan.mjs` en CI | `security.test.ts` |
| XSS / clickjacking | React escapa por defecto; CSP `script-src 'self'`; `frame-ancestors 'none'` | cabeceras en prod |

## SSRF — detalle y riesgo residual
1. Solo `http`/`https`, puertos 80/443, sin credenciales en la URL, longitud máxima, sin caracteres de control.
2. IP literales rechazadas si son privadas/reservadas en cualquier notación (decimal, hex, octal, IPv4-mapped IPv6).
3. Nombres bloqueados: `localhost`, `*.local`, `*.internal`, `*.test`, metadatos de nubes, etc.
4. Resolución DNS por DoH (cloudflare-dns.com) y **todas** las A/AAAA deben ser públicas.
5. Redirecciones manuales con número máximo, revalidando cada salto (URL, DNS y mismo origen en el rastreo).
6. Timeout por petición, tamaño máximo leído en streaming, lista blanca de tipos de contenido.

**Riesgo residual**: `fetch` en Workers vuelve a resolver el nombre tras nuestra comprobación (no podemos fijar la IP), así que un rebinding con TTL muy bajo es teóricamente posible. Mitigación: los Workers salen por la red pública de Cloudflare y no tienen acceso a una red interna propia; no hay metadatos de instancia alcanzables. Se documenta como aceptado.

## Pendiente
2FA/WebAuthn, SSO, rotación automática de `IP_HASH_SALT`, Turnstile en registro si aparece abuso, pentest externo. **No se declara ninguna certificación** (ISO 27001, SOC 2, ENS) — no existen.

## Reportar una vulnerabilidad
Escribir al propietario del repositorio; no abrir issues públicos con detalles explotables.
