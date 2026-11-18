# OpenRouter en DNI Growth — estado y política SOLO GRATIS

**Política:** OpenRouter = exclusivamente modelos gratuitos. Gasto autorizado en OpenRouter: **0,00 USD**.
Variables desplegadas: `OPENROUTER_FREE_ONLY=true`, `ALLOW_PAID_MODELS=false`, `OPENROUTER_MAX_SPEND_USD=0`. Cualquier otro valor **bloquea** OpenRouter (fail-closed), no lo abre a modelos de pago.
La clave vive solo en los secretos de Cloudflare (`OPENROUTER_API_KEY`); nunca se devuelve al navegador ni se registra.

## Cómo se garantiza que no se usa un modelo de pago

1. **Catálogo** (`packages/core/src/ai-models.ts` → `classifyOpenRouterModel`): de `GET https://openrouter.ai/api/v1/models` solo se guardan ids que terminan en `:free` y `openrouter/free`. Es «GRATIS VERIFICADO» solo si `prompt` y `completion` existen y **todos** los componentes de `pricing` (request, image, web_search, internal_reasoning…) son exactamente 0, sin `overrides`, con salida de texto y endpoint de chat. Precio ausente o ilegible → PRECIO DESCONOCIDO (bloqueado). Un id sin `:free` a precio 0 no se considera gratuito.
2. **Preferencias**: `PATCH /ai/preferences` vuelve a comprobar el modelo en el servidor (422 `model_not_allowed`). Las entradas son `strictObject`: un campo `model`, `provider`, `allowPaid`… → 422.
3. **Puerta previa a cada llamada** (`freeGate`, evaluada dentro de `callOpenRouterChat`, el único código que llama a `/chat/completions`): lista permitida, `:free`, no retirado, clasificación verificada o restringida, precio revalidado en < 26 h, capacidades, contexto y pausa por fallos.
4. **En la petición**: `provider.max_price = {prompt:0, completion:0, request:0, image:0}` y `usage.include=true`.
5. **Después**: coste informado > 0 → parada global (`cobro_inesperado`); 402 → parada (`pago_requerido_402`, nunca se compran créditos); 401/403 → `clave_invalida`; modelo servido no gratuito → parada; subida del gasto de la clave (`/api/v1/key`) → `gasto_detectado_en_la_clave`.
6. **Sin respaldo de pago**: el respaldo es Workers AI (incluido en Workers Paid, tope 0,10 USD/día) y, al final, Gemini (se omite en «privacidad primero» y «solo Cloudflare»). Si todo falla → 503 honesto y el crédito se libera.

## Privacidad de los proveedores gratuitos
Los endpoints `:free` de OpenRouter y el nivel gratuito de Gemini pueden registrar o usar las solicitudes para entrenar. Condición de DNI Growth:
- **Guardia automática de datos sensibles** (`packages/core/src/privacy.ts` → `detectSensitiveData`): si lo que escribe el usuario contiene DNI/NIE (letra validada), IBAN (mod-97), tarjeta (Luhn), credenciales (claves `sk_…`, `AKIA…`, `AIza…`, claves privadas, «contraseña: …»), email o teléfono, la solicitud **no se envía** a OpenRouter ni a Gemini: se procesa solo en Workers AI (Cloudflare no entrena con los datos del cliente). Queda registrado en `ai_invocations` como `skipped` / `sensitive_data:<categorías>`, sin guardar el valor.
- **Modo «privacidad primero»** por empresa: además pide `data_collection: "deny"` y `zdr: true` a OpenRouter y omite Gemini.
- El prompt de sistema (instrucciones propias y perfil de marca a partir de la web pública) no activa la guardia; sí el texto del usuario, las fuentes pegadas y el historial.
- Pruebas: `packages/core/test/privacy.test.ts` (17) y «Privacy guard» en `openrouter.test.ts` (ninguna llamada a OpenRouter ni a Gemini con DNI, IBAN o contraseña; el valor no aparece en el registro).

## Cuotas
Contadores atómicos en D1 (`ai_quota_counters`): global por día (45, o el límite informado por OpenRouter − 5) y por minuto (15), por organización (20/día) y por usuario (10/día). Máximo 2 intentos de OpenRouter por solicitud; 429 → pausa global según `Retry-After`; 404/5xx/timeout → pausa del modelo.

## Estrategias por organización
`automatic_free` (ranking por resultados observados, sin benchmarks inventados) · `manual_free` (+ política de respaldo `auto`/`ask`) · `openrouter_free_router` · `cloudflare_only`. Interruptor por organización y **kill switch global** (`POST /api/v1/admin/ai/openrouter/kill-switch`) sin redesplegar.

## Endpoints
- `GET /api/v1/orgs/:org/ai/provider-status`, `GET …/ai/models`, `GET|PATCH …/ai/preferences`, `GET …/ai/usage`
- Admin de plataforma (404 para el resto): `GET /api/v1/admin/ai/overview`, `POST …/ai/models/sync` (6/h), `POST …/ai/openrouter/kill-switch`, `POST …/ai/openrouter/reset-halt`, `POST …/ai/models/health-check` (opt-in, 1 por modelo cada 24 h, máx. 10/día, 16 tokens)

## Registro
`ai_invocations`: tarea, estrategia, proveedor, modelo pedido y servido, estado, código de error, latencia, tokens, coste informado y `cost_state` (`zero_confirmed`, `zero_expected`, `billed`, `included`), respaldo. Cambios de catálogo en `ai_model_changes`.

## Pruebas (todas en verde)
- `packages/core/test/ai-models.test.ts` (27): componentes ocultos de precio, precio ausente, overrides, id sin `:free`, router, salida de imagen, fecha de fin, puerta previa, ranking, modelo servido, saneado.
- `apps/api/test/openrouter.test.ts` (33): rechazo de modelos de pago **sin ninguna llamada de red** (preferencias, inyección en la petición, manipulación directa de la base de datos, llamada directa a `callOpenRouterChat`), precio que cambia → bloqueo, instantánea caducada, variables inseguras, coste > 0, router que sirve un modelo de pago, 402/401, 429, 5xx, JSON inválido, sin clave, cuotas global/organización/usuario y concurrencia, kill switch, privacidad, permisos, aislamiento, y una prueba estática de que solo `lib/openrouter.ts` construye peticiones de chat.

## Estado en producción (2026-11-18)
| Comprobación | Resultado |
|---|---|
| Sincronización automática (cron) | 478 modelos revisados → 15 gratuitos guardados, 15 elegibles |
| Clave | `is_free_tier: true`, uso facturado 0 USD, 50 solicitudes gratuitas/día |
| Generación real con coste 0 confirmado | **Pendiente**: requiere una sesión de usuario en dnigrowth.com (cuenta del titular aún sin verificar) |
| Imágenes | OpenRouter no ofrece modelos gratuitos de imagen: se usan Workers AI (FLUX.1 schnell) |
