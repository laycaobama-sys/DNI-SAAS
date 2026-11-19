# Estado de implementación — DNI Growth

Última actualización: 2026-11-19 · Producción: **https://dnigrowth.com** (Worker `dni-growth`, versión `75a82608-7dfc-46a9-a0c2-ef4c8c2af3fa`; workers.dev redirige con 301 a dnigrowth.com) · Workers Paid, sin servicios de pago adicionales ([verificación de la cuenta](CLOUDFLARE_ACCOUNT_VERIFICATION.md)).

Leyenda:
- **VERIFICADO EN PRODUCCIÓN**: probado contra la URL pública con una respuesta comprobable.
- **VERIFICADO SOLO EN LOCAL**: tests automáticos y/o prueba manual en `wrangler dev`; en producción falta el paso indicado.
- **BLOQUEADO POR PERMISOS**: necesita una acción, clave o aceptación del titular.
- **NO IMPLEMENTADO**.

Pruebas automáticas: lint, typecheck, **375 tests** (26 ficheros, core + API), build y escaneo de secretos en verde el 2026-11-19 (`pnpm -s verify`, código de salida 0).

Pruebas E2E en producción del 2026-11-18 con la cuenta verificada de la titular (organización propia, plan Free), ejecutadas desde el navegador contra https://dnigrowth.com; cada fila indica la respuesta observada.

## Dominio, correo y plataforma

| Funcionalidad | Estado | Prueba |
|---|---|---|
| Dominio `dnigrowth.com` + `www` como dominios personalizados del Worker (TLS automático) | VERIFICADO EN PRODUCCIÓN | `wrangler deploy` → `dnigrowth.com (custom domain)`, `www.dnigrowth.com (custom domain)`; `GET /api/v1/health` → 200 `environment: production` |
| `www` → apex 301 (regla de redirección gratuita, conserva ruta y query) | VERIFICADO EN PRODUCCIÓN | `curl https://www.dnigrowth.com/legal/privacidad?x=1` → 301 `https://dnigrowth.com/legal/privacidad?x=1` |
| workers.dev → dnigrowth.com (páginas de la app y login con Google) | VERIFICADO EN PRODUCCIÓN | `/app/login` en workers.dev → 301 a dnigrowth.com |
| Email Sending (SPF `include:_spf.mx.cloudflare.net`, DKIM `cf-bounce._domainkey`, DMARC `p=reject`) | VERIFICADO EN PRODUCCIÓN | DNS consultado por DoH; email de verificación **entregado**: la titular pulsó el enlace y su cuenta figura verificada |
| Email Routing hola@/soporte@/privacidad@/facturacion@ → buzón del titular | VERIFICADO EN PRODUCCIÓN | reglas activas en el panel de Cloudflare |
| Tope mensual de emails (`EMAIL_MONTHLY_CAP=2500` < 3.000 incluidos) | VERIFICADO SOLO EN LOCAL | `mail.ts` devuelve `monthly_cap_reached` sin enviar |
| Search Console `https://dnigrowth.com/` | VERIFICADO EN PRODUCCIÓN | propiedad verificada; `/sitemap.xml` en estado **«Correcto»**, 3 páginas descubiertas (leído el 2026-11-18) |
| Migración D1 0005 (aditiva) con copia previa | VERIFICADO EN PRODUCCIÓN | `backups/dni-growth-db-pre-0005-20261118-0019.sql`; `wrangler d1 migrations apply --remote` ✅ |

| Worker: errores y CPU | VERIFICADO EN PRODUCCIÓN | `wrangler tail`: peticiones `ok`, 0–1 ms de CPU, 0 excepciones; cron de cada minuto 7 ms de CPU |
| Coste observado 2026-11-18 | VERIFICADO EN PRODUCCIÓN | OpenRouter 0 USD (4 solicitudes); Workers AI 0,0013 USD estimados (incluido); email 2 envíos de 3.000/mes incluidos |

## F0 — Fundaciones

| Funcionalidad | Estado | Prueba |
|---|---|---|
| Monorepo pnpm, TS strict, Zod en fronteras (entradas de IA estrictas: no admiten `model`, `provider` ni precios) | VERIFICADO SOLO EN LOCAL | `pnpm verify` |
| Registro, verificación, login, sesión, logout, CSRF | VERIFICADO EN PRODUCCIÓN | registro + verificación por email + login de la titular; la sesión sobrevive a la recarga y su cookie no es accesible desde JS (HttpOnly); logout → 200 y después `/auth/me` sin usuario y ruta protegida → 401; petición sin cabecera CSRF → 403. Bloqueo por fallos y rate limit solo en local (no se fuerzan en producción para no bloquear cuentas reales) |
| Verificación de email | VERIFICADO EN PRODUCCIÓN | la titular verificó su cuenta con el enlace recibido |
| **Inicio de sesión con Google** (OIDC + PKCE S256, nonce, vinculación segura) | VERIFICADO EN PRODUCCIÓN | 2026-11-18: `/auth/google/start` → 302 a Google con `code_challenge_method=S256`, `nonce` y `prompt=select_account`; tras elegir la cuenta de la titular entra en su panel; `user_identities` registra `google` vinculado a su usuario existente (siguen 2 usuarios: sin duplicado) |
| Organizaciones, invitaciones, roles, aislamiento multiempresa | VERIFICADO EN PRODUCCIÓN (aislamiento) · LOCAL (invitaciones, roles) | prod: otra organización → 404 en `/dashboard` y `/content`; `tenancy.test.ts` (guard SQL estático ampliado a `content_items`, `content_versions`, `organization_ai_preferences`) |
| Créditos con reserva → liquidación/liberación | VERIFICADO EN PRODUCCIÓN | ledger: concesión 50 → auditoría −10, asesor −1 ×2, borrador −3, imagen −5 = **30**; cada operación reserva/libera/liquida una sola vez |
| Stripe detrás de `BILLING_ENABLED=false` | VERIFICADO EN PRODUCCIÓN | sin clave: webhook → 503 `billing_disabled` (versión 7c6037e5) |
| Stripe (modo prueba): sincronización de catálogo, portal y webhook | VERIFICADO EN PRODUCCIÓN | contra la cuenta «DNI Growth» (entorno de prueba): 4 productos/precios EUR creados (39/89/179/349), portal `bpc_…` y webhook `we_…` en `https://dnigrowth.com/api/v1/webhooks/stripe` con firma gestionada y cifrada; segunda sincronización → todo `kept`/`updated` (sin duplicados) |
| Stripe: checkout de prueba pagado | VERIFICADO EN PRODUCCIÓN | la titular pagó Starter con la tarjeta de prueba 4242: webhooks `customer.subscription.created` + `checkout.session.completed` procesados (03:10:14 UTC), plan Starter activo hasta 2026-12-18, `+500` créditos (`plan_upgrade`) concedidos **una sola vez** pese a recibir 2 eventos (saldo 27 → 527) |
| Stripe: una suscripción por organización | VERIFICADO EN PRODUCCIÓN | segundo checkout con la suscripción activa → `409 subscription_exists`; los cambios van por el portal |
| Stripe: portal de cliente | VERIFICADO EN PRODUCCIÓN | «Gestionar suscripción» → `200`, portal del entorno de prueba con plan, facturas y cancelación; auditoría `billing.portal_open` |
| Stripe: cancelación al final del periodo | VERIFICADO EN PRODUCCIÓN | cancelar en el portal → `customer.subscription.updated` procesado, el plan sigue activo hasta el 18 dic; migración 0007 (`cancel_at_period_end`, aditiva, copia previa en `backups/`): renovar → indicador 0; volver a cancelar → la app muestra «Cancelación programada… hasta el 18 de diciembre de 2026» (versión 73543193) |
| Stripe: plan según precio, cambio de plan con prorrateo, eventos antiguos/cruzados ignorados, past_due → Free, baja → Free | VERIFICADO SOLO EN LOCAL | `stripe.test.ts` (11, incluye cancelación programada y deshecha) |
| Cabeceras de seguridad (CSP, HSTS, XFO, nosniff) | VERIFICADO EN PRODUCCIÓN | `curl -I https://dnigrowth.com/` |

## F1 — URL → análisis → marca → plan

| Funcionalidad | Estado | Prueba |
|---|---|---|
| SSRF, robots.txt, 31 reglas | VERIFICADO SOLO EN LOCAL | `ssrf.test.ts`, `seo.test.ts` |
| **F1 en producción**: URL → auditoría → perfil de marca → plan 30 días → exportación | VERIFICADO EN PRODUCCIÓN | auditoría de `https://dnigym.com` (solo lectura de la web pública): job `completed`, 10 páginas, puntuación 79, 8 problemas (2 altos); perfil con hechos y fuente (JSON-LD); plan de 9 tareas; `GET /plans/:id/export` → 200 `text/markdown` |
| Confirmación humana del perfil de marca | PENDIENTE DE LA TITULAR | paso de revisión humana deliberado; se hace en la pantalla de Marca |

## IA — OpenRouter solo gratis + Workers AI ([detalle](OPENROUTER_INTEGRATION_STATUS.md))

| Funcionalidad | Estado | Prueba |
|---|---|---|
| Catálogo dinámico de OpenRouter (solo `:free` + `openrouter/free`, todos los precios = 0) | VERIFICADO EN PRODUCCIÓN | cron: `or_last_sync` 478 modelos revisados → 15 gratuitos guardados, 15 elegibles (13 verificados, 2 con fecha de fin) |
| Clave de OpenRouter en nivel gratuito y gasto 0 | VERIFICADO EN PRODUCCIÓN | `GET /api/v1/key` (desde el Worker): `is_free_tier: true`, `usage: 0`, límite gratuito 50/día → cuota de la app 45/día |
| Generación real con OpenRouter y coste 0 | VERIFICADO EN PRODUCCIÓN | Asesor → `baidu/ernie-5.5-flash-preview:free`, `reported_cost_usd = 0`, `cost_state = zero_confirmed`; el panel «Actividad de IA» muestra «0 USD (confirmado)»; uso facturado 0 |
| Modelos de pago bloqueados **antes** de enviar | VERIFICADO EN PRODUCCIÓN | 8 intentos → 422 (preferencia `openai/gpt-4o`, `gpt-4o-mini`, id falso `…:free`, `allowPaid`, inyección de `model`/`provider` en Asesor y Content, health-check admin de un modelo de pago); invocaciones antes = después (ninguna salió a la red) |
| Política FREE ONLY completa (402/401, coste > 0, router que sirve pago, 429, cuotas, concurrencia) | VERIFICADO SOLO EN LOCAL | `openrouter.test.ts` (37) + `ai-models.test.ts` (27); en producción no se provocan cobros ni 429 reales |
| Guardia de privacidad (datos sensibles solo en Workers AI) | VERIFICADO EN PRODUCCIÓN | pregunta con un DNI de ejemplo → `workers_ai` (gemma-4); registro `skipped sensitive_data:dni_nie` sin el valor; `privacy.test.ts` (17) |
| Modelos de razonamiento con margen de tokens | VERIFICADO EN PRODUCCIÓN | antes: ERNIE devolvía `truncated_empty` en artículos; tras el arreglo, contenido FAQ con ERNIE → 201, coste 0 confirmado |
| Centro de IA (estado, cuota, catálogo, estrategia, privacidad, actividad, panel de admin) | VERIFICADO SOLO EN LOCAL | `wrangler dev`: catálogo real de 15 modelos; sin desbordamiento en 375 px |
| Asesor: modelo servido, respaldo y «Usar respaldo automático» | VERIFICADO EN PRODUCCIÓN (modelo servido, respaldo automático) · LOCAL (botón «Usar respaldo») | `openrouter.test.ts` («manual model + policy ask») |
| Creative Studio (FLUX.1 schnell → R2 UE) | VERIFICADO EN PRODUCCIÓN | imagen generada en 3,5 s, 5 créditos, archivo servido en privado (`image/jpeg`, 786 KB, `cache-control: private`) |
| Gemini como último respaldo | NO EJERCITADO EN PRODUCCIÓN | secreto `GEMINI_API_KEY` presente (solo nombre comprobado); se omite en «privacidad primero» y en «solo Cloudflare» |

## IA — Servicio central 100 % gratuito ([ADR 0014](adr/0014-ia-gratuita-y-recomendaciones-geo.md))
| Elemento | Estado | Prueba |
|---|---|---|
| Un único servicio (`apps/api/src/lib/ai.ts`) para Asesor, Content Studio e imágenes; orden «automático»: Workers AI → Groq (si hay clave) → Gemini (si hay clave) → OpenRouter `:free` | VERIFICADO EN PRODUCCIÓN | Asesor de la org «DNI Growth» respondido por `workers_ai` (`@cf/google/gemma-4-26b-a4b-it`, razonamiento desactivado) en 8,3 s: 727 tokens de entrada, 386 de salida, 0,000189 USD ≈ 17 neuronas |
| Modelo pedido `@cf/meta/llama-3.1-8b-instruct-fp8-fast` | NO DISPONIBLE | no figura en `wrangler ai models list --json` (solo `-fp8`, retirada el 2026-11-20); se usa gemma-4-26b y, de respaldo, `@cf/zai-org/glm-4.7-flash`. Cambiable sin código con la variable `WORKERS_AI_TEXT_MODEL` |
| Tope duro de Workers AI ≤ 0,10 USD/día (≈ 9.091 neuronas < 10.000 gratuitas) | VERIFICADO EN PRODUCCIÓN | la cuenta está en Workers Paid: por encima de 10.000 neuronas/día Cloudflare cobraría. `AI_DAILY_BUDGET_USD` se recorta a 0,10 aunque se configure más; el Centro de IA muestra «N / 9091 neuronas hoy» |
| Mensaje claro al agotar el cupo diario (`ai_daily_quota`, 503, «Se renueva cada día a las 00:00 UTC… No se ha cobrado ningún crédito») | VERIFICADO SOLO EN LOCAL | `aiservice.test.ts`; en producción no se agota a propósito |
| Caché de respuestas 24 h por organización (D1 `ai_response_cache`, clave SHA-256; datos sensibles nunca se guardan) | VERIFICADO EN PRODUCCIÓN | migración 0012 con copia previa `backups/dni-growth-db-pre-0012-20261118-2014.sql`; la misma pregunta repetida → «respuesta reutilizada» en 1,5 s y registro `provider=cache`; el cron borra lo caducado; aislamiento entre organizaciones en tests |
| Groq (`openai/gpt-oss-20b`, razonamiento «low», tope `GROQ_DAILY_REQUESTS=900` < 1.000/día gratuitas) | VERIFICADO EN PRODUCCIÓN | clave puesta por la titular. «Probar conexión» (admin): `llama-3.1-8b-instant` → 404 (solo plan Enterprise de Groq); tras el cambio, `openai/gpt-oss-20b` responde en 448 ms. Modelo configurable con `GROQ_TEXT_MODEL` |
| «Probar conexión» por proveedor (solo administración; 1 petición mínima, sin caché ni respaldo, máx. 20/día, auditado sin la clave) | VERIFICADO EN PRODUCCIÓN | Workers AI 841 ms (gemma-4), Gemini 1.206 ms (gemini-3.5-flash-lite), Groq 448 ms; `aiservice.test.ts` |
| Gemini texto (`gemini-3.5-flash-lite`, tope `GEMINI_TEXT_DAILY=100`, se omite con «privacidad primero») | VERIFICADO SOLO EN LOCAL | `aiservice.test.ts` (respaldos, topes, solo Cloudflare, datos sensibles) |
| `max_tokens` limitado (`MAX_OUTPUT_TOKENS=2500`) | VERIFICADO SOLO EN LOCAL | tests |

## F2 — Content Studio (nuevo)

| Funcionalidad | Estado | Prueba |
|---|---|---|
| Brief → borrador con IA (6 tipos), fuentes tratadas como DATOS, marcas [VERIFICAR] | VERIFICADO EN PRODUCCIÓN | `wrangler dev`: borrador real con Workers AI (Gemma 4); `content.test.ts` |
| Editor versionado con concurrencia optimista | VERIFICADO EN PRODUCCIÓN | dos guardados simultáneos → 200 + 409 `version_conflict` |
| Restaurar versión | VERIFICADO SOLO EN LOCAL | `content.test.ts` |
| Flujo borrador → revisión → aprobado, con auditoría | VERIFICADO EN PRODUCCIÓN (owner) · LOCAL (otros roles, devolver, archivar) | submit 200 → approve 200, estado `approved`, 2 versiones |
| Exportación MD/HTML saneado con aviso de borrador | VERIFICADO EN PRODUCCIÓN | borrador con «BORRADOR NO APROBADO»; aprobado: MD 200 sin aviso y con la edición, HTML 200 sin `<script>` |
| Revisión con IA (1 crédito) | VERIFICADO SOLO EN LOCAL | `content.test.ts` |
| Publicación en CMS | NO IMPLEMENTADO | requiere conectores de CMS del titular |

## F3 — Google Search Console (nuevo, [ADR 0010](adr/0010-search-console-solo-lectura.md))

| Funcionalidad | Estado | Prueba |
|---|---|---|
| Panel sin cuenta conectada: ausencia visible, ninguna cifra | VERIFICADO EN PRODUCCIÓN | `/app/o/…/search-console` (versión d5b448f0): «Sin cuenta de Search Console conectada… No estimamos ni inventamos clics» |
| OAuth de solo lectura y conexión | VERIFICADO EN PRODUCCIÓN | 2026-11-18: la titular concedió `webmasters.readonly` (antes, Google devolvió `403 access_denied` hasta añadirla como usuaria de prueba; la app de Google se publicó en producción el mismo día). Integración `connected`; auditoría `integration.connect` con la cuenta enmascarada |
| Token de actualización solo cifrado | VERIFICADO EN PRODUCCIÓN | `integration_secrets`: sobre `v1.` de 332 caracteres, sin forma de token de Google; la respuesta de `/search-console` no contiene ni el sobre ni ningún token |
| Propiedades permitidas | VERIFICADO EN PRODUCCIÓN | `sites.list` real: 4 propiedades `siteOwner`; ninguna se elige sola si hay varias; se eligió `https://dnigrowth.com/` (auditoría `integration.gsc_property_select`) |
| Sincronización (trabajo `gsc_sync`) | VERIFICADO EN PRODUCCIÓN | completado al primer intento en 5 s, 0 créditos, sin filas en el libro de créditos; Google devolvió **0 filas** del 2026-08-20 al 2026-11-17 (`dataState=final`) para dnigrowth.com, sitio recién añadido. El panel lo dice así, sin estimaciones |
| Panel con cifras (gráfico, tabla, consultas/páginas, comparación) | VERIFICADO SOLO EN LOCAL | `wrangler dev` con datos de prueba locales (`demo.example`, borrados después): gráfico de una sola serie con detalle al pasar el ratón, vista de tabla (58 días), sin desplazamiento horizontal en 375 px. En producción se verá cuando Google publique datos de la propiedad |
| Desconectar con revocación, `invalid_grant`, roles, aislamiento, cron diario | VERIFICADO SOLO EN LOCAL | `searchconsole.test.ts` (14): token nunca en claro en D1/auditoría/eventos, roles (editor/analista/lector 403), aislamiento entre organizaciones, sesión distinta y consentimiento parcial rechazados, `state` no reutilizable, `invalid_grant` → volver a conectar, cron diario idempotente, 0 créditos |

## F3 — Google Analytics 4 (nuevo, [ADR 0011](adr/0011-google-analytics-solo-lectura.md))

| Funcionalidad | Estado | Prueba |
|---|---|---|
| Migración 0009 (tablas `ga4_*`, índice de una conexión por organización) | VERIFICADO EN PRODUCCIÓN | aplicada el 2026-11-18 tras la copia `backups/dni-growth-db-pre-0009-20261118-1301.sql`; solo añade |
| Panel sin cuenta conectada: ausencia visible, ninguna cifra | VERIFICADO EN PRODUCCIÓN | `/app/o/…/analytics` (versión ab2bbe5a): «Sin cuenta de Google Analytics conectada… No estimamos ni inventamos visitas» |
| OAuth de solo lectura y conexión | VERIFICADO EN PRODUCCIÓN | 2026-11-18 13:03: la titular concedió `analytics.readonly`; integración `connected` con `scopes=[analytics.readonly]`; la respuesta de `/analytics` no contiene token ni sobre |
| Propiedades permitidas (Admin API real) | VERIFICADO EN PRODUCCIÓN | `accountSummaries.list` devolvió 1 propiedad: `dni-gym-c6fa2` (cuenta «Default Account for Firebase»), es decir, **de DNI GYM**; la cuenta no tiene ninguna propiedad de GA4 de DNI Growth |
| Sincronización real `ga4_sync` (Data API) | VERIFICADO EN PRODUCCIÓN — con incidencia corregida | la versión ab2bbe5a eligió sola esa única propiedad y el cron la sincronizó a las 13:14 (1.er intento, 7 s, 0 créditos: 3 días, 3 canales, 5 páginas de entrada). Incumplía la regla de no tocar DNI GYM: en la versión b4fd58a3 ya **nunca se elige una propiedad automáticamente** (GA4 y Search Console), se añadió «Dejar de usar esta propiedad» con borrado opcional, y los trabajos revalidan la selección. Se desmarcó la propiedad desde el panel con borrado: consulta de solo lectura en D1 → 0 filas en `ga4_daily_metrics`/`ga4_period_totals`/`ga4_top_rows`, 0 propiedades elegidas, 0 trabajos pendientes; auditoría `integration.ga4_property_deselect` con `dataPurged: true` |
| Panel con cifras de una propiedad propia | BLOQUEADO (falta propiedad) | hace falta una propiedad de GA4 de DNI Growth con la etiqueta instalada en dnigrowth.com |
| Desconectar con revocación, `invalid_grant`, roles, aislamiento, cron, dejar de usar con purga | VERIFICADO SOLO EN LOCAL | `analytics.test.ts` (13): token nunca en claro, sobres intercambiados ilegibles, usuarios del periodo leídos de GA4 (no suma diaria), propiedad sin acceso no se elige ni se sincroniza, `invalid_grant` → volver a conectar, purga, 0 créditos |
| Política de privacidad completa (incluye datos de usuario de Google y uso limitado) | VERIFICADO EN PRODUCCIÓN (pendiente de revisión jurídica) | versión 88f00104: 13 apartados. Responsable del tratamiento completado desde la configuración legal centralizada (ver fila siguiente) |
| Configuración legal centralizada (Aviso legal, Privacidad, Condiciones) | VERIFICADO EN PRODUCCIÓN (pendiente de revisión jurídica) | versión 74c3b3ef, publicada tras la aprobación expresa de la titular de los datos visibles (2026-11-18); correo mostrado `privacidad@dnigrowth.com` (Email Routing) a elección de la titular. Producción: las 3 páginas 200 sin cookies; NIF/NIE y domicilio presentes solo en aviso legal y privacidad (0 en portada, `llms.txt` y sitemap); `mailto:`/`tel:` correctos; sin desbordamiento a 375 px. Detalle técnico: identidad del titular en `apps/web/legal/legal-identity.local.json` (excluido de git: el repositorio es público) e inyectada al compilar por `legal/legal-identity.ts`; la compilación de producción falla si falta y si queda un marcador sin sustituir; en CI se compila con un aviso visible «no configurado». NIF/NIE y domicilio solo aparecen en `/legal/aviso-legal` y `/legal/privacidad` (no en la portada, JSON-LD, `llms.txt`, sitemap, API ni registros). `wrangler dev`: las 3 páginas 200, sin cookies, `mailto:`/`tel:` correctos, sin desbordamiento a 375 px; enlaces legales en el pie de la portada, registro, inicio de sesión y panel |
| Condiciones de uso (`/legal/condiciones`) | VERIFICADO EN PRODUCCIÓN (pendiente de revisión jurídica) | nueva: servicio, cuenta, plan gratuito y **planes de pago no contratables** mientras `BILLING_ENABLED=false`, uso aceptable, contenido e IA, terceros, responsabilidad, baja por correo, cambios y ley aplicable; el registro remite a ellas |
| Permisos declarados en Google Auth Platform | VERIFICADO EN PRODUCCIÓN | «Acceso a los datos»: `openid`, `userinfo.email`, `webmasters.readonly`, `analytics.readonly` con justificación guardada; ver [GOOGLE_VERIFICATION.md](GOOGLE_VERIFICATION.md) |
| Search Console tras compartir el código con GA4 | VERIFICADO EN PRODUCCIÓN | versión bfe01bbc: `/search-console` 200, conexión `connected`, propiedad `https://dnigrowth.com/` conservada, sin token ni sobre en la respuesta |

## F3 — Biblioteca de prompts GEO (nuevo, [ADR 0012](adr/0012-biblioteca-prompts-geo.md))
| Elemento | Estado | Prueba |
|---|---|---|
| Migración 0010 `tracked_prompts` + límite `trackedPrompts` por plan | VERIFICADO EN PRODUCCIÓN | copia previa `backups/dni-growth-db-pre-0010-20261118-1519.sql`; migración aplicada; consulta de solo lectura: límites 10/50/150/400/1500 y 0 filas |
| API (listar, crear pregunta × motor, editar, pausar, archivar, restaurar, sugerencias, exportar CSV/JSON) | VERIFICADO SOLO EN LOCAL | `geo.test.ts` (13 tests): duplicados normalizados, validación de motor/idioma/país, limpieza de caracteres de control y bidi, límite del plan y guarda en la misma transacción, roles (lector/analista no escriben), aislamiento entre organizaciones (404), CSV contra inyección de fórmulas, sugerencias sin inventar ni usar la calle; tabla añadida a la guarda estática de SQL |
| Pantalla «AI Visibility (GEO)» | VERIFICADO EN PRODUCCIÓN (solo lectura) | versión 34d73cb4: carga sin errores de consola ni desbordamiento; catálogo de 6 motores con estado (API oficial / sin API, manual), aviso de que no hay muestreo, uso 0/50, biblioteca vacía. **No se crearon preguntas en producción**: la única marca de la organización de la titular es DNI GYM, que no se toca, y el plan solo admite una marca |
| Preguntas en producción (marca DNI Growth) | VERIFICADO EN PRODUCCIÓN | organización «DNI Growth» (separada de DNI GYM): 8 preguntas Gemini es-ES/ES (4 sugerencias aceptadas + 4 manuales), uso 8/10; las sugerencias se añaden todas (comprobado tras recargar) |

## F3 — Monitor GEO con Gemini gratuito (nuevo, [ADR 0013](adr/0013-monitor-geo-gemini-gratis.md))
| Elemento | Estado | Prueba |
|---|---|---|
| Migración 0011 `ai_response_samples` | VERIFICADO EN PRODUCCIÓN | copia previa `backups/dni-growth-db-pre-0011-20261118-1608.sql`; aditiva; tabla en la guarda estática de SQL multitenant |
| Trabajo `geo_sample` (cola + outbox), topes diarios 40/organización y 150/plataforma, auditoría `geo.sample_run` | VERIFICADO EN PRODUCCIÓN | `geomonitor.test.ts` (17 tests). Producción: trabajos completados con eventos; contador «Hoy: N de 40» actualizado por cada llamada |
| Modelo configurable `GEMINI_MODEL=gemini-3.8-flash` + respaldo `GEMINI_FALLBACK_MODEL=gemini-3.5-flash-lite` (ambos nivel gratuito, sin facturación vinculada) | VERIFICADO EN PRODUCCIÓN | a petición de la titular. `gemini-2.5-flash-lite` → 404 para esta clave (registrado). `gemini-3.8-flash` con búsqueda → 429 de cuota cero → se repite sin búsqueda; con 503 «high demand» → 2 reintentos y respaldo. Muestras correctas guardadas con `model=gemini-3.5-flash-lite`, `grounded=0`, método `gemini-api:generateContent:v1` |
| Respuestas sin búsqueda etiquetadas; tasa de citas solo sobre respuestas con búsqueda; «Fuente» con los modelos que respondieron | VERIFICADO EN PRODUCCIÓN | pantalla: «1 de 3 · 33 % · observado», citas «—» con explicación, desglose por intención, periodo y fuente; sin errores de consola |
| Paradas seguras | VERIFICADO SOLO EN LOCAL | 404/401/403: 1 llamada y fallo definitivo; 3 errores temporales seguidos: `gemini_unavailable`; cuota agotada también en el respaldo: `gemini_quota`; extracto del error de Google ≤ 300 caracteres sin claves |
| Sondeo de progreso tras pulsar «Muestrear ahora» (también Search Console y Analytics) | VERIFICADO EN PRODUCCIÓN | antes la barra se quedaba en 0 % porque el sondeo solo se encadenaba desde la carga inicial; ahora sigue a los datos actuales (`useApi`) |
| Limitación conocida | — | con el nivel gratuito no hay búsqueda de Google para los modelos 3.x: las respuestas reflejan el conocimiento del modelo, sin fuentes. El nivel gratuito sufre saturación (503) en horas punta; lo pendiente se muestrea en la siguiente ejecución |

## F3 — Recomendaciones GEO explicables, intervalos e informes ([ADR 0014](adr/0014-ia-gratuita-y-recomendaciones-geo.md))
| Elemento | Estado | Prueba |
|---|---|---|
| Visibilidad comparable con intervalo de Wilson al 95 % (global, por intención y por competidor) | VERIFICADO EN PRODUCCIÓN | marca DNI Growth: «2 de 7 · 28,6 % · margen 95 %: 8–64 %»; `geo-recs.test.ts` comprueba valores de referencia (2/7 → 0,082–0,641) |
| Recomendaciones deterministas (sin IA ni coste): hueco observado → página existente / nueva / todo el sitio, con prueba, método y limitaciones | VERIFICADO EN PRODUCCIÓN | `GET /brands/:id/geo/recommendations`: 7 recomendaciones basadas en 7 respuestas y la auditoría de 5 páginas; las preguntas de marca apuntan a la portada; botón «Crear borrador» rellena Content Studio. `reports.test.ts` verifica 0 llamadas de red |
| Informe de rendimiento exportable (pantalla «Informes», JSON, CSV, PDF por impresión) | VERIFICADO EN PRODUCCIÓN | versión `b9cf00ee-01f9-4f00-a6a0-c1d17d0e12a1`: CSV 200 `text/csv; charset=utf-8`, `attachment; filename="informe-dnigrowth.com-2026-11-18.csv"`, 26 líneas con fuente, periodo, tipo de medida y nota por fila; Search Console y Analytics «not_connected» (correcto: no conectados en esta org); estilos de impresión activos (menú y cabecera ocultos, tema claro); sin desbordamiento a 390 px |
| CSV contra inyección de fórmulas, exportación auditada (`report.export`) y limitada (30/h), aislamiento entre organizaciones | VERIFICADO SOLO EN LOCAL | `reports.test.ts` (6 tests) |
| Pantalla GEO a 390 px | VERIFICADO EN PRODUCCIÓN | antes 757 px de ancho por un `sr-only` absoluto de la tabla; ahora 390 = 390; enlaces con color de texto accesible (#3f6212) |

## F5 — Captación de leads y CRM (nuevo, [ADR 0015](adr/0015-captacion-leads-crm.md))
| Elemento | Estado | Prueba |
|---|---|---|
| Migración 0013 (`lead_forms`, `leads`, `lead_events`, `crm_tasks`, límite `leadForms` por plan) | VERIFICADO EN PRODUCCIÓN | copia previa `backups/dni-growth-db-pre-0013-20261118-2155.sql`; aditiva; tablas en la guarda estática de SQL multitenant |
| Formulario de contacto real en dnigrowth.com (con y sin JavaScript) → CRM de la organización «DNI Growth» | VERIFICADO EN PRODUCCIÓN | envío desde la portada con UTM de prueba → mensaje «Gracias…»; contacto guardado con UTM `verificacion/prueba/crm-e2e`, página sin parámetros, consentimiento (texto y fecha); aviso a la titular por email `accepted` **sin datos de la persona**. El contacto de prueba se marcó como prueba y después se borró (200; quedan 0) |
| Antispam sin cookies ni terceros (campo trampa, tiempo mínimo, enlaces, límites por IP/formulario/día) y webs autorizadas | VERIFICADO EN PRODUCCIÓN | campo trampa → «gracias» pero no se guarda (contador `spam_blocked`=1); sin consentimiento → 422 `consent_required`; origen no autorizado → 403 y preflight sin cabeceras CORS; el resto de la API sigue exigiendo CSRF (403) |
| Deduplicación por email, historial completo, etapas, valor, responsable, notas y tareas | VERIFICADO EN PRODUCCIÓN (etapa, tareas, prueba) · LOCAL (resto) | historial `submitted → updated → stage_changed → task_created ×2`; `crm.test.ts` (13) y `core/crm.test.ts` (5) |
| Roles (solo propietario, administración y marketing ven contactos; solo propietario/administración borran), aislamiento entre organizaciones | VERIFICADO SOLO EN LOCAL | `crm.test.ts`: editor/analista/lector 403; responsable sin acceso al CRM → 422; otra organización 404 en leer, cambiar, exportar y borrar |
| Exportación CSV (auditada, contra fórmulas) y derecho de supresión | VERIFICADO EN PRODUCCIÓN | CSV 200 `contactos-2026-11-18.csv`; borrado 200 con auditoría `lead.erase` solo con ids |
| Política de privacidad actualizada (formulario de contacto, plazos y formularios de clientes como encargado) | VERIFICADO EN PRODUCCIÓN | `/legal/privacidad#contacto` |
| Borrado de un contacto cancela su respuesta automática pendiente | VERIFICADO EN PRODUCCIÓN | tras borrar el contacto de prueba, su envío programado pasó a `dead` / `lead_erased` y se eliminó la copia cifrada (consulta de estado sin datos personales) |
| Pendiente F5 | NO IMPLEMENTADO | dominio propio por cliente para las landings (Cloudflare for SaaS, puede tener coste) y avisos por WhatsApp (verificación de empresa en Meta y conversaciones de pago) |

## F5 — Landing pages por bloques · F7 — Tests A/B · F5 — Automatizaciones de seguimiento (nuevo, [ADR 0016](adr/0016-landings-ab-automatizaciones.md))
| Elemento | Estado | Prueba |
|---|---|---|
| Migración 0014 (`landing_pages`, `landing_versions`, `landing_stats_daily`, `crm_automations`, `crm_automation_runs`, `leads.landing_id/landing_variant`, límite `landingPages` 1/5/20/50/200) | VERIFICADO EN PRODUCCIÓN | copia previa `backups/dni-growth-db-pre-0014-20261118-235930.sql`; aditiva; tablas añadidas a la guarda estática multitenant |
| Constructor por bloques (portada, ventajas, texto, preguntas, llamada a la acción, formulario), SEO, color y modo; versiones con bloqueo optimista y restauración | VERIFICADO EN PRODUCCIÓN | landing «Prueba E2E (test)» creada desde la plantilla; versión 2 «Variante B (prueba)» guardada desde la interfaz; contenido solo texto (todo se escapa), solo enlaces `https://` o `#formulario` |
| Vista previa privada y publicación en `dnigrowth.com/l/<organización>/<slug>` | VERIFICADO EN PRODUCCIÓN | vista previa 200 con `noindex`, banner y `form-action 'none'`; publicada → página pública con CSP con nonce, 1 solo script, sin cookies, sin desbordamiento a 572 px; despublicada → 404 |
| Formulario del CRM en la landing con UTM y atribución a la landing | VERIFICADO EN PRODUCCIÓN | envío real desde la landing → contacto con UTM `verificacion/prueba/landing-e2e`; visita 1 y conversión 1 en la variante A (medición observada, sin robots ni HEAD) |
| Test A/B (hipótesis obligatoria, reparto 5–95 %, asignación estable por conexión sin cookies, prueba z de dos proporciones, mínimos de 100 visitas por variante y 10 conversiones, avisos de «mirar demasiado») | VERIFICADO EN PRODUCCIÓN (iniciar, medir, detener) · LOCAL (reparto, promover B) | test iniciado desde la interfaz con la versión 2; veredicto «Aún sin datos suficientes»; detenido. `landings.test.ts` (40 conexiones: misma variante al repetir, ambas variantes vistas, promover B) y `core/landing.test.ts` |
| Respuesta automática al contacto nuevo (asunto/mensaje con `{nombre}`, «responder a» propio, horas de silencio en hora de Madrid, tope 50/día, una sola vez por contacto, nunca con spam) | VERIFICADO EN PRODUCCIÓN (programación en horas de silencio) · LOCAL (envío inmediato) | contacto enviado a las 00:09 → ejecución `scheduled` hasta las 08:00 de Madrid; pruebas locales: un solo email aunque reenvíe, nada con spam, nada si está desactivada |
| Tarea automática de seguimiento para el equipo | VERIFICADO EN PRODUCCIÓN | tarea «Llamar o escribir al nuevo contacto» con vencimiento a 24 h creada al llegar el contacto |
| Roles y aislamiento | VERIFICADO SOLO EN LOCAL | editor edita pero no publica (403); analista solo lee; otra organización 404; límite de plan 402; automatizaciones solo con `forms:manage` |
| Limpieza de la prueba en producción | HECHO | test detenido, landing despublicada (404) y archivada (0 de 1 usadas), automatizaciones desactivadas y contacto de prueba borrado |

## Módulos de crecimiento sin coste (nuevo, [ADR 0017](adr/0017-modulos-crecimiento-sin-coste.md))
Versión `75a82608`, migración 0015 aplicada con copia previa `backups/dni-growth-db-pre-0015-20261119.sql` (aditiva, 42 sentencias; tablas nuevas en la guarda estática multitenant). Pruebas E2E del 2026-11-19 en la organización «DNI Growth»; los datos de prueba se borraron después.

| Elemento | Estado | Prueba |
|---|---|---|
| SEO técnico: comparación entre auditorías (nuevos, resueltos, persistentes, delta de salud), estado por incidencia, CSV | VERIFICADO EN PRODUCCIÓN | `/seo/overview` y `/seo/compare` → 200 con la auditoría real de dnigrowth.com; `growth.test.ts` |
| Keywords: consultas reales de Search Console con intención y oportunidades, términos del sitio, lista guardada, CSV; **sin volumen, CPC ni dificultad inventados** (marcados «no disponible») | VERIFICADO EN PRODUCCIÓN | `/keywords/overview` → 200; palabra clave de prueba creada y borrada |
| Competencia: lectura educada (robots.txt, 30/día, anti-SSRF) y huecos de términos | VERIFICADO EN PRODUCCIÓN | `example.com` → 201; `127.0.0.1` → 422 `unsafe_url` |
| Autoridad / backlinks: registro manual o CSV, comprobación de enlace vivo/perdido/bloqueado, límite por plan | VERIFICADO EN PRODUCCIÓN | página de ayuda de iana.org → enlace a `/domains` **vivo**, ancla «Domains». Limitación: un Worker no puede leer páginas de su propia zona (dnigrowth.com → HTTP 522), así que esas comprobaciones muestran «error» |
| Automatizaciones (contacto nuevo, cambio de etapa, tarea vencida → crear tarea, mover etapa, asignar, avisar al equipo sin datos personales, webhook firmado con reintentos y cola muerta) y simulación | VERIFICADO EN PRODUCCIÓN (reglas, tarea, simulación, límite 402) · LOCAL (firma, reintentos, cola muerta) | regla creó la tarea «[PRUEBA E2E] Llamar en 1 h»; tercera regla en Free → 402; la simulación solo coincidió tras «Ganado» con valor 1.500 |
| Atribución primer contacto por origen, campaña, landing o formulario (CSV) | VERIFICADO EN PRODUCCIÓN | contacto de prueba excluido; avisos «valor declarado, no cobro verificado», sin ROAS |
| Ads sin gasto: borradores, anuncios, envío, aprobación con separación de funciones, Spend Guardian (interruptor de corte activo por defecto), exportación con UTM | VERIFICADO EN PRODUCCIÓN | sin anuncios → bloqueado; aprobación bloqueada por interruptor y tope; con tope → aprobada; exportación con `utm_source=meta&utm_medium=paid_social&utm_campaign=prueba-e2e-navidad`; archivada y Guardian restablecido |
| Medios (derechos confirmados, lista blanca MIME + bytes mágicos, 5/15 MB) | VERIFICADO EN PRODUCCIÓN | sin derechos 422, archivo falso 415, PNG 201 servido con `nosniff`; borrado |
| Estudio de vídeo en el navegador (escenas, subtítulos SRT, render MP4/WebM sin coste de servidor) | VERIFICADO EN PRODUCCIÓN | MP4 720×1280, 10 s, 131.705 bytes; SRT correcto; proyecto archivado |
| Agencia: organizaciones cliente (Pro 5 / Agency 50), herencia del plan de la agencia, marca blanca (nombre, logo, color, pie de informes) | VERIFICADO EN PRODUCCIÓN (límites por plan) · LOCAL (crear cliente, herencia, marca) | con Pro → `clientOrgs` 5 y marca blanca 200; con Agency → 50; con Free → 0. Dominio propio por cliente: bloqueado por coste |
| Panel: KPIs con fuente o acción siguiente (tráfico orgánico, visibilidad IA, ingresos atribuidos, plan de anuncios) | VERIFICADO EN PRODUCCIÓN | visibilidad IA 29 % observada; resto con acción («Conectar Search Console», «Ver el CRM», «Preparar una campaña») |
| Menú sin etiquetas «pronto»; rutas antiguas `/m/<módulo>` redirigen | VERIFICADO EN PRODUCCIÓN | capturas de la app |

## Stripe en modo prueba: planes que se activan de verdad
| Paso (2026-11-19, organización «PRUEBA Stripe planes (modo test)», cliente de prueba sin datos personales, cobro por factura sin tarjeta) | Estado | Prueba |
|---|---|---|
| Crear suscripción Starter 39 € | VERIFICADO EN PRODUCCIÓN (modo test) | webhook `evt_1UdJZT…` → plan `starter`, landings 5, reglas 10 |
| Cambiar a Growth 89 € | VERIFICADO EN PRODUCCIÓN (modo test) | `evt_1UdJbu…` → `growth`, 3 asientos, landings 20, reglas 30 |
| Cambiar a Pro 179 € | VERIFICADO EN PRODUCCIÓN (modo test) | `evt_1UdJcy…` → `pro`, 10 asientos, 5 clientes, marca blanca |
| Cambiar a Agency 349 € | VERIFICADO EN PRODUCCIÓN (modo test) | `evt_1UdJdq…` → `agency`, 25 asientos, 50 clientes |
| Cancelar | VERIFICADO EN PRODUCCIÓN (modo test) | `evt_1UdJeK…` → `free/canceled`, límites Free |

## Marca DNI Growth (producción)
| Elemento | Estado | Prueba |
|---|---|---|
| Organización y marca «DNI Growth» (dnigrowth.com) | VERIFICADO EN PRODUCCIÓN | org `9fe0d8cc…`, auditoría completada (5 páginas, salud 94/100) |
| Perfil de marca revisado y confirmado | VERIFICADO EN PRODUCCIÓN | versión 2 confirmada: rechazados la variante de nombre con eslogan, 5 titulares H2 que no eran servicios y el teléfono; público, tono, objetivo «Leads / contactos» y afirmación prohibida «Garantizar posiciones en Google o menciones en motores de IA»; sin competidores inventados |
| Avisos del perfil que ya se resolvieron | VERIFICADO SOLO EN LOCAL | el aviso «varias variantes del nombre» y «Información no encontrada» se ocultan cuando ya están resueltos (antes seguían visibles tras rechazar/rellenar) |

## BLOQUEADO EXTERNO (no depende del código)
Cobros reales con Stripe (verificación KYC de la titular), conexión de clientes a Search Console/Analytics (vídeo de verificación de Google), publicación y gasto real en Meta/Google Ads (aprobación de sus API), volúmenes y CPC de keywords (proveedor de pago), dominio propio por cliente (Cloudflare for SaaS, coste), avisos por WhatsApp (verificación de empresa en Meta y conversaciones de pago), 2FA/SSO (fase F8).

## Bloqueos que requieren al titular
| Bloqueo | Acción mínima |
|---|---|
| Search Console y Analytics para clientes | App publicada; permisos y justificación declarados; marca enviada a verificación. Falta: **vídeo de demostración en YouTube** (guion en [GOOGLE_VERIFICATION.md](GOOGLE_VERIFICATION.md)) y «Enviar a revisión» |
| GA4 de la propia web de DNI Growth | La cuenta de Google conectada solo ve la propiedad de DNI GYM. Para tener datos de dnigrowth.com hay que crear una propiedad de GA4 (acepta las condiciones de Google Analytics la titular) e instalar la etiqueta con banner de consentimiento de cookies; hoy la web no usa cookies de analítica |
| Stripe (cobros reales) | Modo prueba listo y verificado. Para cobrar: activar la cuenta «DNI Growth» (KYC), textos legales con datos fiscales, decidir IVA, guardar la clave `sk_live_…` con `wrangler secret put`, «Sincronizar» y `BILLING_ENABLED="true"` ([pasos](STRIPE_PLAN.md#3-antes-de-cobrar-dinero-real-decisión-de-la-titular)). Ciclo completo de planes probado en modo test el 2026-11-19 (Starter → Growth → Pro → Agency → cancelada) |
| Textos legales definitivos | Revisión jurídica de Aviso legal, Privacidad y Condiciones; condiciones de contratación (precio con impuestos, renovación, desistimiento) antes de activar cobros; baja de cuenta autoservicio (hoy por correo) |
