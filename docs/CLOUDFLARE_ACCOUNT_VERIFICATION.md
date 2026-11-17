# Verificación de la cuenta de Cloudflare

Fecha de la comprobación: 2026-11-17. Método: lectura en el panel autenticado de Cloudflare (solo lectura, sin cambios de facturación) y `wrangler` con la cuenta del titular.
Cuenta: `6a41…78a0` (identificador parcialmente oculto). No se han copiado datos de facturación, direcciones ni métodos de pago.

## Suscripción
| Comprobación | Resultado | Evidencia |
|---|---|---|
| Plan Workers | **Workers Paid activo** (no se ha vuelto a contratar) | Panel → Facturación → Suscripciones: «Workers Paid — se renueva el 13 dic 2026» |
| Otras suscripciones existentes | R2 Paid, Images/Stream Basic, Observability | Mismo listado (no se han modificado) |
| Modelo de uso del Worker `dni-growth` | **Standard** (inferido) | Ajustes del Worker → «Precios» muestra solo «Límite de tiempo de CPU (ms)». No existe selector Bundled/Unbound: las cuentas Workers Paid actuales usan el modelo Standard (facturación por solicitudes + CPU) |
| Límite de CPU por invocación | Valor por defecto (30 s) | Campo vacío en el panel. No se ha subido: el rastreo cabe con margen y subirlo sin necesidad solo aumenta el riesgo de coste |
| Límites de gasto | No modificados | Cambiar límites de coste puede cortar todos los Workers; requiere decisión del titular |

## Recursos de DNI Growth
| Recurso | Nombre | Notas |
|---|---|---|
| Worker | `dni-growth` | https://dni-growth.ibraguimova19.workers.dev · observabilidad activada |
| D1 | `dni-growth-db` | Jurisdicción UE · migraciones 0001–0004 aplicadas · Time Travel activo |
| Queues | `dni-growth-jobs` + DLQ `dni-growth-jobs-dlq` | 3 reintentos y luego DLQ |
| Cron | `* * * * *` | outbox de trabajos, cola de emails y recuperación |
| R2 | `dni-growth-media` | **Jurisdicción UE**, privado; creado el 2026-11-17 para imágenes generadas |
| Workers AI | binding `AI` | Asesor (Gemma 4 → Mistral Small 3.1 → Llama 4 Scout) e imágenes (FLUX.1 schnell) |
| Email Service | binding `EMAIL` (`send_email`) | Desplegado; **envío desactivado** (`EMAIL_SENDING_ENABLED=false`) hasta tener dominio |
| Secretos | `IP_HASH_SALT`, `DATA_ENC_KEY` | Valores aleatorios generados por tubería, nunca mostrados |

Recursos de otros proyectos de la cuenta (DNI GYM, DNI DIRECTO 24/7, `dni-directos-media`, dominio `dnigym.com`): **no se han tocado**.

## Estimación de coste mensual con el uso actual
| Concepto | Incluido en Workers Paid (5 USD) | Uso previsto en lanzamiento | Coste extra esperado |
|---|---|---|---|
| Solicitudes y CPU de Workers | 10 M solicitudes y 30 M ms de CPU al mes | muy por debajo | 0 USD |
| D1 | 25.000 M filas leídas y 50 M escritas al mes; 5 GB | muy por debajo | 0 USD |
| Queues | 1 M operaciones al mes | muy por debajo | 0 USD |
| R2 | 10 GB y operaciones de nivel gratuito | < 1 GB | 0 USD |
| Workers AI | 10.000 neuronas/día gratis | limitado en código a 0,10 USD/día (`AI_DAILY_BUDGET_USD`) ≈ asignación gratuita | ~0 USD; máximo teórico ≈ 3 USD/mes si se agota cada día |
| Email Service | Beta pública; consulta el precio vigente en el panel antes de activarlo | 0 (desactivado) | 0 USD hoy |

Cifras de inclusión tomadas de la documentación pública de precios de Cloudflare a la fecha. Son estimaciones, no una factura.

## Rollback
- Versión anterior del Worker: `1c8ad460-4b40-4c82-b4e6-6a68cda88aad` (`npx wrangler rollback <id>`).
- Copias de D1 antes de migrar: `backups/d1-dni-growth-20261117T192051Z.sql` y `backups/d1-dni-growth-20261117T200005Z-pre0004.sql` (fuera de git).
- D1 Time Travel, marcador previo a 0004: `00000002-0000000a-00005126-37abe1058f5224919aa947f1565afe77`.
