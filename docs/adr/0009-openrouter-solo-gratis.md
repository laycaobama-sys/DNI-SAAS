# ADR 0009 — OpenRouter solo con modelos gratuitos

Fecha: 2026-11-18 · Estado: aceptada

## Contexto
El titular exige que DNI Growth no consuma nunca modelos de pago en OpenRouter (gasto autorizado 0,00 USD), aunque la cuenta tenga saldo. OpenRouter publica precios por componente y modelos `:free` con límites diarios compartidos por clave.

## Decisión
- Lista permitida derivada del catálogo oficial: solo ids `:free` y `openrouter/free` con todos los componentes de precio a 0. Lo desconocido se bloquea.
- Un único punto de salida (`callOpenRouterChat`) que revalida la lista justo antes de cada petición y envía `provider.max_price = 0`.
- Paradas globales automáticas ante cualquier señal de cobro; la reanudación es manual por un administrador de plataforma.
- Respaldo en Workers AI (incluido en el plan), no en modelos de pago.
- Variables de política fail-closed: un valor distinto de los seguros desactiva OpenRouter.

## Consecuencias
- Menor disponibilidad (límite de 50 solicitudes/día de la clave gratuita, 20/min): se reparte con cuotas por plataforma, organización y usuario, y se cae a Workers AI.
- Sin generación de imágenes en OpenRouter (no hay modelos gratuitos de imagen).
- Cambiar la política requiere una nueva ADR y un cambio de código revisado; no basta con una variable.
