# Changelog — DNI Growth

Formato: fecha, versión desplegada en Cloudflare y cambios visibles. Las pruebas de cada entrada están en [IMPLEMENTATION_STATUS.md](IMPLEMENTATION_STATUS.md) y el estado del plan en [STATUS.md](STATUS.md).

## 2026-11-24

### Activación (Fase 2) — versión `4c47d2b4`
- Auditoría gratuita sin registro desde la portada: revisamos hasta 5 páginas públicas con las mismas reglas que el análisis completo, sin IA ni créditos. Límites por IP y diario, caché de 24 h por dominio.
- Página `/auditoria/{id}` con nota global y por áreas (Técnica, SEO, GEO/AEO) con su palabra («Bien», «Mejorable», «Urgente»), los 3 problemas que más pesan con evidencia y solución, «otros N problemas» al crear la cuenta, botones para compartir y comparación con un competidor. No se indexa.
- Al registrarse desde la auditoría, esta pasa a la cuenta y el análisis completo queda preparado con la misma web.
- Bienvenida de 6 pasos (marca, competidores, Google, CMS, modo de trabajo y primer artículo) con barra de progreso; el estado sale de los datos reales. Lista de activación en el panel.
- Correos de ayuda a las 24 h y 72 h del alta, una sola vez, solo si queda algo pendiente y con baja en un clic.
- Política de privacidad: auditoría gratuita (se borra a los 30 días si no se crea cuenta), correos de ayuda y almacenamiento local.
- Sin cambios: precios, planes y el resto de páginas. Migración `0021` solo añade tablas (copia previa de la base de datos).
- Lo que aún no está y la app lo dice: conexión con CMS (WordPress, Fase 4) y piloto automático real; la imagen social es fija.

### Stripe en real (2026-11-23, 22:35 UTC)
- La titular guardó la clave real de «DNI Growth-IA». La plataforma creó sola, en modo real, los 4 planes (mensual y anual), el portal de cliente, el IVA (Stripe Tax automático) y el webhook firmado.
- `/api/v1/public/pricing-status` → pagos abiertos al público.

## 2026-11-23

### Cobros (Fase 1) — versiones `14e84da0`, `d8403160`, `c91a496a` y siguiente
- Planes nuevos: Starter 49 €, Growth 129 € (7 días de prueba), Pro 249 € y Agency 449 € al mes; anual con 2 meses gratis. IVA aparte.
- Aceptación de condiciones obligatoria antes de pagar, con su versión guardada.
- Pausa de 1 a 3 meses, oferta de permanencia (30 % durante 2 meses, una vez y solo si el motivo es el precio) y bajada de plan; cancelar sigue a un clic.
- Impago: 7 días de gracia con el plan intacto y después Free sin borrar nada.
- Garantía medible de 90 días (Growth, Pro y Agency) con requisitos comprobables y continuidad (una pausa o el paso a Free la reinicia).
- Página `/precios` generada desde el catálogo, con comparativa honesta («Disponible» / «En desarrollo»), calculadora con los números del visitante y JSON-LD sin valoraciones.
- `BILLING_ENABLED="auto"`: el pago se abre al público solo con clave real y cuenta verificada por Stripe; estado público en `/api/v1/public/pricing-status`.
- El plan elegido en `/precios` se recuerda durante el alta y lleva a Facturación.
- Corregido: el nombre del cupón superaba los 40 caracteres de Stripe y la sincronización automática fallaba.
- Productos en Stripe con nombre legible («DNI Growth · Plan Growth»).
- Las direcciones legales que muestra Stripe (`/terminos-y-condiciones`, `/politica-de-privacidad`, `/soporte`) y alias cortos redirigen a las páginas reales.
- Red de seguridad: una suscripción cancelada al final del periodo pasa a Free 2 días después aunque no llegue el aviso de Stripe.
- Embudo de cobros en la analítica propia: prueba iniciada, suscripción, subida de plan, pausa y cancelación.
- Lista de proveedores: el monitor GEO aparece como conectado (antes figuraba como «previsto» aunque ya funcionaba).

### Stripe, cuenta real «DNI Growth-IA» (panel de Stripe)
- Comprobado: cuenta activa, pagos y payouts activos, sin tareas pendientes; datos públicos de DNI Growth.
- Archivados los 3 productos antiguos de RestoPanel (0 suscripciones).
- Deshabilitados los 2 webhooks antiguos hacia resto-panel.com.

### Web pública (Fase 0)
- Fuente única de funciones y precios para portada, `/precios`, `llms.txt` y JSON-LD.
- Analítica de producto propia, sin cookies ([ADR 0021](adr/0021-analitica-producto-sin-cookies.md)).
- Página `/seguridad` y página 404.
- Condiciones de uso y contratación (versión 2026-11-23) y garantía, pendientes de revisión por abogado.
