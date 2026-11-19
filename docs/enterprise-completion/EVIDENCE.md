# Evidencias — DNI Growth (2026-11-19)

Todas las pruebas se hicieron contra https://dnigrowth.com con datos marcados como prueba que después se borraron o archivaron. No se usaron tarjetas ni dinero real.

## Calidad
- `pnpm -s verify` → código 0: lint, typecheck, **375 tests / 26 ficheros**, build, escaneo de secretos «sin credenciales detectadas».
- `apps/api/test/growth.test.ts` (11 pruebas): comparación SEO, keywords/competencia/SSRF, backlinks, reglas (límites, condiciones, simulación, 403 para lectura), firma/reintentos/cola muerta de webhooks, atribución, flujo de Ads, vídeo, subida de medios, agencia/marca blanca/límites por plan, KPIs del panel.
- `apps/api/test/tenancy.test.ts`: tablas nuevas en la guarda estática (`organization_id` obligatorio).

## Base de datos
- Copia `backups/dni-growth-db-pre-0015-20261119.sql` antes de migrar; `0015_growth_modules.sql` aplicada (aditiva, 42 sentencias).

## Producción — módulos (organización «DNI Growth»)
| Prueba | Resultado observado |
|---|---|
| Endpoints nuevos (SEO, keywords, backlinks, reglas, atribución, ads, medios, vídeo, agencia, branding, entitlements) | 200 |
| Competencia `example.com` / `127.0.0.1` | 201 / 422 `unsafe_url` |
| Backlink desde página de ayuda de iana.org | vivo, ancla «Domains» |
| Regla «contacto nuevo → tarea» | tarea «[PRUEBA E2E] Llamar en 1 h» creada; 3.ª regla en Free → 402 |
| Ads | sin anuncios → bloqueado; aprobación bloqueada por interruptor y tope; con tope → 200; exportación con UTM; archivada |
| Medios | sin derechos 422; archivo falso 415; PNG 201 con `nosniff` |
| Vídeo | MP4 720×1280, 10 s, 131.705 bytes; SRT correcto |
| Panel | visibilidad IA 29 % (observada); resto con acción siguiente |
| Ruta de verificación de Google `/google07bca8a276fd14a6.html` | 200 |

## Producción — Stripe en modo prueba
Organización «PRUEBA Stripe planes (modo test)» (`4b634821…`), cliente de prueba `planes-test@example.com`, cobro por factura (sin tarjeta), metadatos `organization_id` y `plan_code`.

| Evento firmado | Auditoría | Plan y límites en la app |
|---|---|---|
| `evt_1UdJZT…` creada Starter 39 € | `billing.subscription_sync` | starter · landings 5 · reglas 10 · créditos 500 |
| `evt_1UdJbu…` → Growth 89 € | `billing.subscription_sync` | growth · 3 asientos · landings 20 · reglas 30 |
| `evt_1UdJcy…` → Pro 179 € | `billing.subscription_sync` | pro · 10 asientos · 5 clientes · marca blanca 200 |
| `evt_1UdJdq…` → Agency 349 € | `billing.subscription_sync` | agency · 25 asientos · 50 clientes |
| `evt_1UdJeK…` cancelada | `billing.subscription_canceled` | free/canceled · límites Free |

## Limitaciones conocidas
- Un Worker no puede leer páginas de su propia zona (HTTP 522): comprobar backlinks hacia otras webs.
- Sin cookies, en un test A/B una persona que cambia de red puede ver ambas variantes.
