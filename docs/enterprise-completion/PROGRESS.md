# Progreso de cierre — DNI Growth

Actualizado: 2026-11-19 · Producción `75a82608-7dfc-46a9-a0c2-ef4c8c2af3fa` · Pruebas: 375 en verde (26 ficheros).

Estados: **Disponible** (funciona de extremo a extremo), **Parcial** (funciona con un límite declarado), **BLOQUEADO EXTERNO** (depende de un tercero o de un gasto no autorizado).

| # | Bloque | Estado | Dónde |
|---|---|---|---|
| 1 | Constructor de landings por bloques, versiones, publicación y tests A/B | Disponible | Landing Pages y tests A/B ([ADR 0016](../adr/0016-landings-ab-automatizaciones.md)) |
| 2 | CRM + automatizaciones (reglas, tareas, webhooks firmados) + atribución | Disponible · atribución Parcial (valor declarado, sin ROAS) | CRM, Automatizaciones, Atribución ([ADR 0017](../adr/0017-modulos-crecimiento-sin-coste.md)) |
| 3 | Search Console / GA4 | Disponible para la propia web · clientes: BLOQUEADO EXTERNO (vídeo de verificación de Google) | Search Console, Analytics |
| 4 | Keywords y competencia gratis | Disponible (sin volumen/CPC: BLOQUEADO EXTERNO, proveedor de pago) | Keywords |
| 5 | Estudio de creatividades y vídeo | Disponible (render en el navegador) | Vídeo |
| 6 | Ads Manager sin gasto | Parcial (borradores + aprobación + Spend Guardian + exportación; publicar: BLOQUEADO EXTERNO, API de Meta/Google) | Ads |
| 7 | Experimentos + agencia / marca blanca | Disponible (dominio propio por cliente: BLOQUEADO EXTERNO, coste) | Landing Pages, Agencia y marca blanca |
| 8 | Validación y lanzamiento | Hecho: verify, migración con copia, despliegue, E2E en producción, ciclo de planes en Stripe modo prueba | [EVIDENCE.md](EVIDENCE.md) |

## BLOQUEADO EXTERNO
| Bloqueo | Qué falta | Quién |
|---|---|---|
| Cobros reales con Stripe | Activar la cuenta (KYC), clave `sk_live_…` con `wrangler secret put`, «Sincronizar», `BILLING_ENABLED="true"` | Titular |
| Search Console/Analytics para clientes | Vídeo de demostración y «Enviar a revisión» en Google Cloud | Titular |
| Publicar anuncios en Meta/Google Ads | Aprobación de sus API (revisión de app y de empresa) | Titular + Meta/Google |
| Volumen, CPC y dificultad de keywords | Proveedor de datos de pago (gasto no autorizado) | Titular |
| Dominio propio por cliente | Cloudflare for SaaS (puede tener coste) | Titular |
| Avisos por WhatsApp | Verificación de empresa en Meta y conversaciones de pago | Titular |
