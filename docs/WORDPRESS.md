# Publicación en WordPress

Diseño y decisiones: [ADR 0025](adr/0025-publicacion-externa-meta-y-wordpress.md).

## Para el cliente
1. En su WordPress: **Usuarios → Perfil → Contraseñas de aplicación**. Escribe «DNI Growth» y pulsa «Añadir nueva contraseña de aplicación». WordPress la muestra una sola vez: 24 letras y números en grupos de 4.
2. En DNI Growth, abre un contenido. En la tarjeta **Publicar en WordPress**, escribe la dirección de la web (`https://…`), su usuario y esa contraseña. Solo pueden conectar las personas con rol Propietario o Administración.
3. Con el contenido aprobado: **Publicar ahora**, **Enviar como borrador**, **Actualizar y publicar** o **Retirar (pasar a borrador)**.

Requisitos:
- web con https;
- usuario con rol Editor o Administrador;
- API REST no bloqueada por un plugin de seguridad;
- plan Starter o superior.

## Prueba contra un WordPress real (sin Docker)
WordPress Playground ejecuta WordPress en Node:

```bash
mkdir wp-e2e && cd wp-e2e && npm init -y && npm install @wp-playground/cli@3.1.66
# blueprint.json: WP_ENVIRONMENT_TYPE=local, enlaces permanentes /%postname%/ y una contraseña de
# aplicación del usuario 1 escrita en wp-content/e2e-pass.txt (ver ADR 0025)
node node_modules/@wp-playground/cli/wp-playground.js server --port=9401 --blueprint=./blueprint.json
```

Después, desde `apps/api`:

```bash
WP_E2E_URL=http://127.0.0.1:9401 WP_E2E_USER=admin WP_E2E_PASS="$(curl -s http://127.0.0.1:9401/wp-content/e2e-pass.txt)" npx vitest run test/wordpress-live.test.ts
```

La prueba llega a la dirección local a través de un host https ficticio, así que la protección SSRF y la regla https del código siguen activas. Sin esas variables, la prueba se salta (CI).
