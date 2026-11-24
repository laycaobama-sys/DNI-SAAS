# Bloqueos humanos — lo que solo puede hacer la titular

Última revisión: 2026-11-24. Ordenados por urgencia. Mientras tanto, todo lo afectado sigue funcionando en modo prueba o con el aviso correspondiente; ninguna pantalla muestra como «disponible» algo que dependa de estos pasos.

Reglas que siguen vigentes: nadie más que tú escribe claves, contraseñas o códigos; las claves se guardan con `wrangler secret put` y nunca se pegan en un chat.

---

## 1. HECHO · Stripe en real con la cuenta «DNI Growth-IA» (2026-11-23)

Guardaste la clave real y la plataforma hizo sola el resto a las 22:35 UTC (comprobado el 2026-11-24):
- Cuenta **DNI Growth-IA** (`acct_1TnSMAJepRhBoIxa`) con cobros activos.
- En modo real: los 4 planes con precio mensual y anual («DNI Growth · Plan Starter/Growth/Pro/Agency»), el portal de cliente, el IVA y el webhook firmado hacia `https://dnigrowth.com/api/v1/webhooks/stripe`.
- Los pagos están **abiertos al público** (`/api/v1/public/pricing-status` → `paymentsOpen: true`).
- Siguen archivados los productos antiguos de RestoPanel y deshabilitados sus webhooks.

No tienes que hacer nada más aquí. Comprobación cuando quieras: **Facturación → Stripe · administración** debe decir «DNI Growth-IA · puede cobrar».

Nota: tu organización «DNI GYM» tiene una suscripción Starter creada **en modo prueba** y ya cancelada (termina el 2026-12-18). Con la clave real, Stripe no enviará su aviso de fin; la plataforma la pasa sola a Free el 2026-12-20. No hay que hacer nada.

## 2. URGENTE · Revisión legal antes del primer cobro real

Están redactadas, pero las debe revisar un abogado:
- `/legal/condiciones` (contratación, renovación, cancelación, renuncia al desistimiento al empezar el servicio, aviso de 30 días antes de cambiar precios).
- `/legal/garantia` (condiciones exactas de la garantía de 90 días).
- Política de privacidad.

El texto que acepta el cliente queda guardado con su versión (`termsVersion 2026-11-23`).

## 3. IMPORTANTE · IVA y facturas (decisión con tu gestor)

- **Hoy:** tu cuenta real tiene **Stripe Tax activo** y la plataforma lo detectó al sincronizar (2026-11-23): Stripe calcula el IVA según el país del cliente. Tiene coste (~0,5 % por cobro, sin cuota fija).
- **Si tu gestor prefiere el IVA español del 21 % fijo** (suficiente para clientes en España): desactiva Stripe Tax en *Configuración → Impuestos* y después pulsa **Sincronizar** en *Facturación → Stripe · administración*; la plataforma crea el tipo fijo del 21 % y lo usa en los pagos nuevos.
- Añade tu NIF en *Configuración → Facturas → Identificadores fiscales* para que aparezca en las facturas.
- Pregunta a tu gestor por VERI*FACTU.

## 4. URGENTE · Google: responder al correo del 21 de noviembre

Google envió el 21 nov «[Action Needed] Your Google APIs Verification Request» y **no sigue con la revisión hasta que se responda**. La respuesta está escrita y revisada punto por punto en [GOOGLE_VERIFICATION.md](GOOGLE_VERIFICATION.md) (permisos idénticos a los registrados desde la versión `8015e5ff`, vídeo accesible, acceso gratis sin tarjeta, política de privacidad completa). Se envía desde tu Gmail, como respuesta a ese mismo correo, en cuanto des el visto bueno.

Si Google contesta con el correo de su revisor, hay que invitarlo a la organización «Demo verificación Google» (ya tiene Analytics), como miembro con rol Analista.

Situación anterior:

Comprobado en Google Cloud (*Google Auth Platform → Centro de verificación*) el 2026-11-23:
- **Marca: verificada** ✅ (se muestra a los usuarios).
- **Acceso a datos: en revisión.** Superados «Requisitos de la página principal» y «Lineamientos de la marca» (19 nov). «Requisitos de la política de privacidad» está en revisión; después vienen «Funciones de la app», «Acceso a los datos adecuados» y «Permisos mínimos».
- Google indica que tarda **de 4 a 6 semanas** y que el equipo de Confianza y Seguridad escribe por correo si necesita algo. **Vigila tu correo y responde tú** si piden cambios.
- La política de privacidad ya incluye lo que Google exige (permiso `webmasters.readonly`, uso limitado, sin envío a la IA ni entrenamiento).

Mientras tanto la conexión ya funciona: las sincronizaciones diarias de Search Console y Analytics se completan (11 y 7 en los últimos 7 días). Cada cliente nuevo ve el aviso «app no verificada» hasta que Google termine. La garantía de 90 días necesita Search Console conectado.

## 5. BLOQUEADO · Meta: falta verificar la empresa

Comprobado el 2026-11-24: **la cuenta de desarrollador ya no pide confirmación** (la revisión de la app abre sin el aviso de «actividad inusual»). La app «DNI Growth» no tiene solicitudes enviadas.

El paso siguiente solo lo puedes dar tú, porque pide documentos de la empresa y es una decisión que Meta no deja deshacer:
1. En el panel de la app, «Conviértete en un proveedor de tecnología» → **Sí, soy proveedor de tecnología** (Meta avisa: «Esta decisión no se puede revocar»). No se ha pulsado.
2. Verificación de la empresa en Meta Business (documentos oficiales del negocio).
3. Revisión de la app con los vídeos de cada permiso ([GUIA_APROBACIONES_GOOGLE_META.md](GUIA_APROBACIONES_GOOGLE_META.md)).

Hasta entonces, la publicación directa en Instagram y Facebook y los anuncios de Meta aparecen como «requiere aprobación externa» y no se venden como disponibles. No toques la «Clave secreta de la aplicación» en ningún chat.

## 5 bis. Aviso · Cuenta antigua de Stripe

La cuenta antigua de Stripe (`acct_1Ucxx…`, la que no usa DNI Growth) tiene pendiente la verificación de identidad y los cobros suspendidos. **No afecta a DNI Growth**, que cobra con «DNI Growth-IA». Si ya no la usas, puedes dejarla así o cerrarla tú desde su panel.

## 6. Claves de API

| Clave | Estado | Coste | Paso |
|---|---|---|---|
| Stripe (clave real de DNI Growth-IA) | ✅ guardada, pagos abiertos | comisión por cobro | — |
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
