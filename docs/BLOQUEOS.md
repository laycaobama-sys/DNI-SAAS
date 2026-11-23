# Bloqueos humanos — lo que solo puede hacer la titular

Última revisión: 2026-11-23. Ordenados por urgencia. Mientras tanto, todo lo afectado sigue funcionando en modo prueba o con el aviso correspondiente; ninguna pantalla muestra como «disponible» algo que dependa de estos pasos.

Reglas que siguen vigentes: nadie más que tú escribe claves, contraseñas o códigos; las claves se guardan con `wrangler secret put` y nunca se pegan en un chat.

---

## 1. URGENTE · Stripe en real con la cuenta «DNI Growth-IA» (2 minutos, un solo paso)

**Ya hecho y comprobado el 2026-11-23 (no tienes que tocarlo):**
- La cuenta **DNI Growth-IA** (`acct_1TnSMAJepRhBoIxa`) está **activa**: en *Configuración → Estado de la cuenta* figuran «Pagos» y «Payouts» activos y «No hay tareas activas para completar».
- Datos públicos ya son de DNI Growth: nombre comercial «DNI Growth», concepto en el extracto bancario «DNI GROWTH», web dnigrowth.com, soporte soporte@dnigrowth.com.
- Los 3 productos antiguos de RestoPanel están **archivados** (tenían 0 suscripciones). Se archivan, no se borran: se pueden reactivar.
- Los 2 webhooks antiguos que enviaban todos los eventos a resto-panel.com están **deshabilitados** (uno fallaba al 100 %). Así los pagos de DNI Growth no se envían a otro sistema.
- Las direcciones legales que Stripe muestra en el pago y en los recibos (`/terminos-y-condiciones`, `/politica-de-privacidad`, `/soporte`) daban 404: ahora redirigen a las páginas reales.
- En modo prueba se ha comprobado todo el circuito: catálogo sincronizado (4 planes × mensual/anual), cupón de retención, portal de cliente, webhook con 9 eventos y páginas de pago de Stripe con el precio correcto (Growth anual: 1.296 €, 108 €/mes, IVA calculado según la dirección).

**Lo único que falta, y solo puedes hacerlo tú** (la clave secreta nunca pasa por un chat):
1. En Stripe, arriba a la izquierda, elige **DNI Growth-IA** (sin «Entorno de prueba»).
2. **Desarrolladores → Claves de API → Clave secreta → Revelar** y cópiala. Empieza por `sk_live_`.
3. En PowerShell, en la carpeta `DNI SAASappsapi`:
   ```powershell
   npx.cmd wrangler secret put STRIPE_SECRET_KEY
   ```
   Pega la clave cuando te la pida y pulsa Intro.

**Qué hace la plataforma sola en el minuto siguiente** (sin desplegar nada):
- Lee el estado de la cuenta, crea los 4 productos («DNI Growth · Plan Starter/Growth/Pro/Agency») y los 8 precios (mensual y anual, en euros, IVA aparte), el IVA (Stripe Tax si está activo; si no, IVA español del 21 %), el cupón de retención, el portal de cliente y el webhook firmado. Todo queda en el historial de auditoría.
- Con `BILLING_ENABLED="auto"`, en cuanto Stripe confirma que la cuenta puede cobrar, el pago se abre al público y /precios cambia a «Pagos activos con Stripe».
- Comprobación: **Facturación → Stripe · administración** debe decir «DNI Growth-IA · puede cobrar».

Nota: tu organización «DNI GYM» tiene una suscripción Starter creada **en modo prueba** y ya cancelada (termina el 2026-12-18). Con la clave real, Stripe no enviará su aviso de fin; la plataforma la pasa sola a Free el 2026-12-20 (red de seguridad añadida el 2026-11-23). No hay que hacer nada.

## 2. URGENTE · Revisión legal antes del primer cobro real

Están redactadas, pero las debe revisar un abogado:
- `/legal/condiciones` (contratación, renovación, cancelación, renuncia al desistimiento al empezar el servicio, aviso de 30 días antes de cambiar precios).
- `/legal/garantia` (condiciones exactas de la garantía de 90 días).
- Política de privacidad.

El texto que acepta el cliente queda guardado con su versión (`termsVersion 2026-11-23`).

## 3. IMPORTANTE · IVA y facturas (decisión con tu gestor)

- **Por defecto:** IVA español del 21 % como tipo fijo en cada factura. Sirve para clientes en España.
- **Para clientes de otros países de la UE:** activa **Stripe Tax** en *Configuración → Impuestos*. Tiene coste (~0,5 % por transacción). En la siguiente sincronización la plataforma lo detecta y deja de usar el tipo fijo.
- Añade tu NIF en *Configuración → Facturas → Identificadores fiscales* para que aparezca en las facturas.
- Pregunta a tu gestor por VERI*FACTU.

## 4. EN CURSO · Google: verificación para leer Search Console y Analytics

Comprobado en Google Cloud (*Google Auth Platform → Centro de verificación*) el 2026-11-23:
- **Marca: verificada** ✅ (se muestra a los usuarios).
- **Acceso a datos: en revisión.** Superados «Requisitos de la página principal» y «Lineamientos de la marca» (19 nov). «Requisitos de la política de privacidad» está en revisión; después vienen «Funciones de la app», «Acceso a los datos adecuados» y «Permisos mínimos».
- Google indica que tarda **de 4 a 6 semanas** y que el equipo de Confianza y Seguridad escribe por correo si necesita algo. **Vigila tu correo y responde tú** si piden cambios.
- La política de privacidad ya incluye lo que Google exige (permiso `webmasters.readonly`, uso limitado, sin envío a la IA ni entrenamiento).

Mientras tanto la conexión ya funciona: las sincronizaciones diarias de Search Console y Analytics se completan (11 y 7 en los últimos 7 días). Cada cliente nuevo ve el aviso «app no verificada» hasta que Google termine. La garantía de 90 días necesita Search Console conectado.

## 5. BLOQUEADO · Meta: tu cuenta de desarrollador pide confirmación

El 2026-11-23, al abrir la revisión de la app, Meta muestra: «Confirmación de la cuenta requerida — Hemos detectado actividad inusual en esta cuenta de desarrollador». Solo tú puedes resolverlo (pide comprobar tu identidad):
1. Entra en developers.facebook.com con tu cuenta y pulsa **Confirmar cuenta**. Sigue los pasos que te pida.
2. Después, la revisión de la app necesita la verificación del negocio en Meta Business y los vídeos de cada permiso ([GUIA_APROBACIONES_GOOGLE_META.md](GUIA_APROBACIONES_GOOGLE_META.md)).

Hasta entonces, la publicación directa en Instagram y Facebook y los anuncios de Meta aparecen como «requiere aprobación externa» y no se venden como disponibles. No toques la «Clave secreta de la aplicación» en ningún chat.

## 6. Claves de API

| Clave | Estado | Coste | Paso |
|---|---|---|---|
| Stripe (clave real de DNI Growth-IA) | ❌ falta | comisión por cobro | Ver punto 1 |
| Gemini (monitor GEO y respaldo de IA) | ✅ guardada, nivel gratuito | 0 € | — |
| OpenRouter (modelos gratuitos) | ✅ guardada, solo modelos gratis y gasto máximo 0 $ | 0 € | — |
| Groq | ✅ guardada | 0 € | — |
| Google OAuth (Search Console y Analytics) | ✅ guardada | 0 € | — |
| Cifrado de datos y sal de IP | ✅ guardadas | 0 € | — |
| Cloudflare Turnstile y PageSpeed Insights | no hacen falta hoy | 0 € | El código actual no las usa; se pedirán solo cuando una función las necesite. |
| Anthropic, OpenAI, Perplexity | ❌ no compradas | de pago | Tu presupuesto es 0 €. El seguimiento de ChatGPT, Claude y Perplexity no se vende como disponible. |
| DataForSEO u otro de volumen de búsqueda | ❌ no comprado | de pago | Sin volumen de búsqueda licenciado no se muestran volúmenes. |
| Google Ads (developer token) | ❌ sin solicitar | 0 € (requiere aprobación de Google) | Requiere una cuenta de administrador de Google Ads y la aprobación del token. |

## 7. Vincular tu cuenta al Control Center (TOTP)

Pasos en [PENDIENTES_TITULAR.md §0](PENDIENTES_TITULAR.md). Ejecutas `node scripts/platform-claim.mjs` y pegas tú el código. Nunca en un chat.

## 8. Más adelante

- Shopify Partners y directorio de WordPress (publicación automática): requieren sus revisiones.
- Perfiles en G2, Capterra y Trustpilot.
- Vídeo demo de 90 s.
- Primeros clientes beta para casos verificados (nunca testimonios inventados).
- Forma jurídica definitiva y datos fiscales en el aviso legal y en las facturas.
