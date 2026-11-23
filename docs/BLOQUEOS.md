# Bloqueos humanos — lo que solo puede hacer la titular

Última revisión: 2026-11-23. Ordenados por urgencia. Mientras tanto, todo lo afectado sigue funcionando en modo prueba o con el aviso correspondiente; ninguna pantalla muestra como «disponible» algo que dependa de estos pasos.

Reglas que siguen vigentes: nadie más que tú escribe claves, contraseñas o códigos; las claves se guardan con `wrangler secret put` y nunca se pegan en un chat.

---

## 1. URGENTE · Stripe en real con la cuenta «DNI Growth-IA» (5 minutos)

**Estado comprobado el 2026-11-23:**
- Cuenta **DNI Growth-IA** (`acct_1TnSMAJepRhBoIxa`): sin suscripciones. Tiene 3 productos antiguos activos («RestoPanel Starter / Professional / Enterprise»).
- La plataforma guarda hoy la clave de **prueba** de otra cuenta («DNI Growth», `acct_1Ucxx…`). Esa cuenta **no puede cobrar**: Stripe no pudo verificar la identidad y pide un documento que coincida con los datos. No hay que tocarla: la sustituye DNI Growth-IA.

**Qué haces tú:**
1. En Stripe, arriba a la izquierda, elige **DNI Growth-IA**. Comprueba que **no** está activado «Entorno de prueba».
2. Ve a **Desarrolladores → Claves de API → Clave secreta → Revelar** y cópiala. Empieza por `sk_live_`.
3. En tu ordenador abre PowerShell en la carpeta `DNI SAAS\apps\api` y ejecuta:
   ```powershell
   npx.cmd wrangler secret put STRIPE_SECRET_KEY
   ```
   Pega la clave cuando te la pida y pulsa Intro. **No la pegues en ningún chat.**

**Qué hace la plataforma sola**, en el minuto siguiente, sin desplegar nada:
- Lee el estado de la cuenta (`charges_enabled`).
- Crea los 4 productos y los 8 precios: mensual y anual de Starter 49 €, Growth 129 €, Pro 249 € y Agency 449 €. Todos en euros y sin IVA.
- Crea el IVA del 21 % (o usa Stripe Tax si lo activas), el cupón de retención (30 % durante 2 meses), el portal de cliente y el webhook firmado.
- Todo queda registrado en el historial de auditoría.
- Con `BILLING_ENABLED="auto"`, el botón de pago se abre al público **solo** si Stripe confirma que la cuenta puede cobrar. Si no, la app dice «Stripe todavía está verificando la cuenta» y no cobra nada.

**Después (1 clic, en la app):** ve a **Facturación → Stripe · administración**.
- Comprueba «Cuenta de Stripe: DNI Growth-IA · puede cobrar».
- Pulsa **«Archivar 3 producto(s)»** para retirar los productos de RestoPanel. Se archivan, no se borran, y se pueden reactivar.

Si Stripe pide algo más (documento, cuenta bancaria, datos fiscales), aparece en el aviso amarillo del inicio de su panel; solo tú puedes completarlo.

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

Enviada a revisión el 2026-11-19, con vídeo y justificación ([GOOGLE_VERIFICATION.md](GOOGLE_VERIFICATION.md)). Solo queda esperar el correo de Google. Si pide cambios, reenvíalo.

Mientras tanto, la conexión funciona, pero cada cliente ve el aviso «app no verificada». La garantía de 90 días necesita Search Console conectado.

## 5. EN CURSO · Meta: revisión de la app

Necesita la verificación del negocio en Meta Business y los vídeos de cada permiso ([GUIA_APROBACIONES_GOOGLE_META.md](GUIA_APROBACIONES_GOOGLE_META.md)). Hasta entonces, la publicación directa en Instagram y Facebook y los anuncios aparecen como «en desarrollo».

No toques la «Clave secreta de la aplicación» en ningún chat.

## 6. Claves de API

| Clave | Estado | Coste | Paso |
|---|---|---|---|
| Gemini (monitor GEO) | ✅ guardada, nivel gratuito | 0 € | — |
| OpenRouter (modelos gratuitos) | ✅ guardada | 0 € | — |
| Groq | ✅ guardada | 0 € | — |
| Cloudflare Turnstile (anti-abuso de la auditoría sin registro) | ❌ falta | 0 € | Cloudflare → Turnstile → Añadir widget (`dnigrowth.com`, modo «Gestionado») → `npx.cmd wrangler secret put TURNSTILE_SECRET_KEY` |
| PageSpeed Insights | ❌ falta | 0 € | console.cloud.google.com → proyecto dni-growth → APIs → «PageSpeed Insights API» → Credenciales → Clave restringida a esa API → `npx.cmd wrangler secret put PAGESPEED_API_KEY` |
| Anthropic, OpenAI, Perplexity | ❌ no compradas | de pago | Tu presupuesto es 0 €. El seguimiento de ChatGPT, Claude y Perplexity aparece como «en desarrollo» y no se vende como disponible. |
| DataForSEO u otro de volumen de búsqueda | ❌ no comprado | de pago | Igual: sin volumen de búsqueda licenciado no se muestran volúmenes. |

## 7. Vincular tu cuenta al Control Center (TOTP)

Pasos en [PENDIENTES_TITULAR.md §0](PENDIENTES_TITULAR.md). Ejecutas `node scripts/platform-claim.mjs` y pegas tú el código. Nunca en un chat.

## 8. Más adelante

- Shopify Partners y directorio de WordPress (publicación automática): requieren sus revisiones.
- Perfiles en G2, Capterra y Trustpilot.
- Vídeo demo de 90 s.
- Primeros clientes beta para casos verificados (nunca testimonios inventados).
- Forma jurídica definitiva y datos fiscales en el aviso legal y en las facturas.
