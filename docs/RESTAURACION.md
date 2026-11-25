# Copias de seguridad y restauración de la base de datos

## Qué se copia y cuándo

- **Qué:** la base de datos D1 completa (`dni-growth-db`): todas las tablas, sus filas, índices y disparadores, en un único archivo SQL comprimido (`.sql.gz`).
- **Cuándo:** una vez al día, a partir de las 02:00 UTC. Lo hace el cron del Worker (`apps/api/src/lib/backup.ts`, función `dailyBackup`).
- **Dónde:** bucket R2 `dni-growth-media`, jurisdicción UE, en `backups/db/AAAA-MM-DD.sql.gz`. El bucket es privado y ninguna ruta de la aplicación sirve esas claves.
- **Cuánto tiempo:** 30 días. Las copias más antiguas se borran solas.
- **Registro:** tabla `db_backups`, con clave, número de tablas y filas, tamaño, SHA-256 y fecha.
- **Vigilancia:** la página pública [/estado](https://dnigrowth.com/estado) marca en rojo «Copias de seguridad» si la última copia tiene más de 26 horas. Si falla dos veces seguidas, avisa por correo a los titulares de la plataforma.

Además, antes de cada migración se hace una exportación manual con `wrangler d1 export`, que se guarda en `backups/` en el equipo de la titular. Esa carpeta está fuera de git.

## Cómo restaurar

1. Descargar la copia del día que interese:
   ```
   cd apps/api
   npx wrangler r2 object get dni-growth-media/backups/db/2026-11-25.sql.gz --remote --jurisdiction eu --file copia.sql.gz
   ```
2. Comprobar que el SHA-256 del archivo coincide con el de `db_backups` (`sha256sum copia.sql.gz`).
3. Descomprimir: `gunzip -k copia.sql.gz`.
4. **Primero en local, nunca directamente en producción.** Restaurar en una base local aislada:
   ```
   npx wrangler d1 execute dni-growth-db --local --persist-to ./restauracion --file copia.sql --yes
   ```
   Wrangler ejecuta el archivo como un lote. El archivo empieza con `PRAGMA defer_foreign_keys = TRUE`, así que las claves externas se comprueban al final.
5. Comparar el número de filas de las tablas principales (`users`, `organizations`, `subscriptions`, `audit_logs`, `d1_migrations`) con lo esperado. Pasar `PRAGMA foreign_key_check` y `PRAGMA integrity_check`.
6. Restaurar en producción solo si la titular lo decide por escrito, porque es una acción irreversible. Se haría en una base D1 **nueva**: se crea, se carga la copia con `--remote --file` y se cambia el `database_id` en `wrangler.jsonc`. Nunca se borra la base actual sin hacerle antes una exportación.
7. Borrar los archivos locales de la copia en cuanto termine la prueba, porque contienen datos personales.

## Última prueba real de restauración

**25-11-2026.** Copia `backups/db/2026-11-25.sql.gz` (106.961 bytes, creada a las 13:08 UTC por el cron en producción).

| Comprobación | Producción | Copia restaurada en local |
|---|---|---|
| SHA-256 del archivo | `611d5ff0…f10b8cd` (en `db_backups`) | `611d5ff0…f10b8cd` (calculado tras descargar) |
| Tablas | 87 | 87 |
| `users` | 4 | 4 |
| `organizations` | 6 | 6 |
| `subscriptions` | 6 | 6 |
| `audit_logs` (hasta la hora de la copia) | 151 | 151 |
| `d1_migrations` | 22 | 22 |
| `PRAGMA foreign_key_check` | — | sin errores |
| `PRAGMA integrity_check` | — | `ok` |

Los archivos locales de la prueba se borraron al terminar. La prueba automática `apps/api/test/status-backup.test.ts` repite este proceso en cada `pnpm verify`: genera la copia, la carga en una base vacía y compara las filas.

**Próxima prueba recomendada:** una vez al mes, añadiendo una fila a la tabla de arriba.
