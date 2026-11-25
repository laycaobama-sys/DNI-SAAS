# ADR 0027 · Plugin «DNI Growth Connector», correcciones reversibles en WordPress y fuentes propias

- Estado: aceptado
- Fecha: 2026-11-25
- Relacionado: [ADR 0025](0025-publicacion-externa-meta-y-wordpress.md) (publicación en WordPress), [WORDPRESS.md](../WORDPRESS.md)

## Contexto
La Entrega 2 pide aplicar correcciones técnicas en la web del cliente (título, descripción, canónica, JSON-LD, `alt` y `llms.txt`) con el antes y el después, registradas y reversibles. La API REST estándar de WordPress no deja escribir metadatos protegidos (los que empiezan por `_`) ni servir `/llms.txt`, y Yoast SEO y Rank Math guardan sus valores en campos propios.

También: la portada tenía 53 en rendimiento de Lighthouse por un desenfoque de 60 px animado y por cargar fuentes de Google (un tercero más en la política de privacidad y en la CSP).

## Decisión
1. **Plugin propio, opcional y gratuito**, servido por el Worker en `/descargas/dni-growth-connector.zip`. El zip se construye al vuelo desde el código fuente en `apps/api/src/lib/wp-plugin-source.ts` (formato «stored», bytes reproducibles, `packages/core/src/zip.ts`). Se instala subiéndolo en WordPress. Publicarlo en el directorio de WordPress.org queda para más adelante (revisión de ellos).
2. El plugin **solo actúa con los permisos del usuario conectado** (contraseña de aplicación):
   - `edit_post` para cada página, entrada o imagen;
   - `manage_options` para `llms.txt`.

   No crea usuarios, no abre rutas sin autenticar y no guarda claves.
3. **Correcciones reversibles:**
   - DNI Growth reserva primero una fila en `wp_fixes` (estado `applying`) y llama al plugin con su id como clave de idempotencia (`ref`).
   - El plugin guarda el antes y el después en `_dni_fix_log` (últimas 50 por página).
   - «Deshacer» restaura el valor anterior y una segunda llamada no cambia nada.
   - Cada aplicación y cada vuelta atrás queda en `audit_logs` con quién la aprobó.
   - Solo los roles con `content:approve` aplican o deshacen.
   - Límite: 60 por hora y organización.
   - La URL tiene que ser del WordPress conectado. Si no lo es, se responde 422 sin llamar a WordPress.
4. **Compatibilidad con Yoast SEO y Rank Math:** si uno está activo, el plugin copia título, descripción y canónica en sus campos y deja que ellos los impriman. Si no, los imprime el plugin. El JSON-LD lo imprime siempre el plugin, codificado con `JSON_HEX_TAG`, para que no pueda cerrar la etiqueta `<script>`.
5. **Al publicar** un artículo, si el plugin está activo, se envían también su título SEO, su descripción y un JSON-LD `Article`.
6. **Fuentes propias:**
   - Inter, Instrument Serif y JetBrains Mono, con licencia OFL, se sirven desde dnigrowth.com vía `@fontsource` 5.3.0 y solo con el subconjunto latino.
   - Google Fonts sale de la CSP y de las páginas.
   - El fondo de la portada deja de animar un `filter: blur(60px)`.
7. **Comprobaciones nocturnas** en GitHub Actions (`.github/workflows/nightly.yml`, 03:30 UTC):
   - `scripts/smoke-prod.mjs`;
   - la auditoría propia;
   - `scripts/lighthouse-check.mjs`, con un mínimo de 95 en SEO, accesibilidad y buenas prácticas en `/`, `/precios` y `/herramientas`.

   El rendimiento se vigila con un umbral bajo porque varía mucho entre máquinas.

## Pruebas
- `apps/api/test/cms.test.ts`, con un WordPress simulado:
  - descarga del zip;
  - publicar sin plugin;
  - metadatos al publicar con plugin;
  - aplicar, auditar y deshacer;
  - `alt`, JSON-LD inválido, otra web y URL que WordPress rechaza;
  - `llms.txt` y roles.
- `pnpm wp:plugin-test` ejecuta el plugin en un **WordPress real** (WordPress Playground) con PHP 8.3 y 7.4, con 28 comprobaciones en verde:
  - rutas REST e idempotencia;
  - salida en `<head>` con el JSON-LD escapado;
  - canónica única;
  - `llms.txt`;
  - copia en Yoast;
  - roles Editor, Colaborador y anónimo;
  - desinstalación.

## Consecuencias
- «Correcciones técnicas en tu web» pasa a **Parcial**: funciona en WordPress con el plugin y una aprobación por corrección. Aún no se aplica sola desde cada hallazgo de la auditoría ni en otros CMS.
- Si el cliente borra el plugin, lo publicado sigue igual. Al desinstalarlo se borran sus datos: `llms.txt` y los campos `_dni_*`. Los valores copiados en Yoast o Rank Math se quedan.
