/**
 * Daily backup of the whole D1 database to R2 (bucket in the EU jurisdiction), kept 30 days.
 * Format: one gzip'd SQL file (schema + data) that restores with
 *   npx wrangler d1 execute <db> --local --file backup.sql
 * (procedure and the last restore test in docs/RESTAURACION.md). The bucket is private and these keys
 * (`backups/db/…`) are never referenced by any media row, so no route can ever serve them.
 */
import type { Env } from "../env";
import { getSetting, setSetting } from "./stripe";
import { log, nowIso, uuid } from "./util";

export const BACKUP_PREFIX = "backups/db/";
export const BACKUP_RETENTION_DAYS = 30;
const PAGE = 500;

const quote = (v: unknown): string => {
  if (v === null || v === undefined) return "NULL";
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : "NULL";
  if (typeof v === "bigint") return v.toString();
  if (v instanceof ArrayBuffer || ArrayBuffer.isView(v)) {
    const bytes = v instanceof ArrayBuffer ? new Uint8Array(v) : new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
    return `X'${[...bytes].map((b) => b.toString(16).padStart(2, "0")).join("")}'`;
  }
  if (Array.isArray(v)) return `X'${v.map((b: number) => (b & 255).toString(16).padStart(2, "0")).join("")}'`;
  return `'${String(v).replace(/'/g, "''")}'`;
};
const ident = (s: string) => `"${s.replace(/"/g, '""')}"`;

/** Full SQL dump (tables, then data, then indexes/triggers/views). */
export async function dumpDatabase(db: D1Database): Promise<{ sql: string; tables: number; rows: number }> {
  const { results: objects } = await db
    .prepare("SELECT type, name, sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY CASE type WHEN 'table' THEN 0 ELSE 1 END, name")
    .all<{ type: string; name: string; sql: string }>();
  const out: string[] = ["-- DNI Growth · copia de la base de datos", `-- ${nowIso()}`, "PRAGMA defer_foreign_keys = TRUE;"];
  let tables = 0;
  let rows = 0;
  const tableObjs = objects.filter((x) => x.type === "table");
  // Every table first (foreign keys may point to tables later in the alphabet), then the rows.
  for (const o of tableObjs) out.push(`${o.sql};`);
  for (const o of tableObjs) {
    tables++;
    for (let offset = 0; ; offset += PAGE) {
      const { results } = await db.prepare(`SELECT * FROM ${ident(o.name)} LIMIT ? OFFSET ?`).bind(PAGE, offset).all<Record<string, unknown>>();
      for (const r of results) {
        const cols = Object.keys(r);
        out.push(`INSERT INTO ${ident(o.name)} (${cols.map(ident).join(", ")}) VALUES (${cols.map((k) => quote(r[k])).join(", ")});`);
      }
      rows += results.length;
      if (results.length < PAGE) break;
    }
  }
  for (const o of objects.filter((x) => x.type !== "table")) out.push(`${o.sql};`);
  return { sql: `${out.join("\n")}\n`, tables, rows };
}

async function gzip(text: string): Promise<Uint8Array> {
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Cron: once a day (from 02:00 UTC) write today's backup and delete the ones older than 30 days. */
export async function dailyBackup(env: Env, opts: { force?: boolean; now?: Date } = {}): Promise<{ created: string | null; deleted: number }> {
  if (!env.MEDIA) return { created: null, deleted: 0 };
  const now = opts.now ?? new Date();
  const day = now.toISOString().slice(0, 10);
  if (!opts.force) {
    if (now.getUTCHours() < 2) return { created: null, deleted: 0 };
    if ((await getSetting(env.DB, "backup_last_day")) === day) return { created: null, deleted: 0 };
  }
  await setSetting(env.DB, "backup_last_day", day);
  const { sql, tables, rows } = await dumpDatabase(env.DB);
  const bytes = await gzip(sql);
  const key = `${BACKUP_PREFIX}${day}.sql.gz`;
  const hash = await sha256(bytes);
  await env.MEDIA.put(key, bytes, { httpMetadata: { contentType: "application/gzip" }, customMetadata: { kind: "db_backup", sha256: hash, tables: String(tables), rows: String(rows) } });
  await env.DB.prepare(
    `INSERT INTO db_backups (id, r2_key, tables, rows_total, bytes, sha256, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(r2_key) DO UPDATE SET tables = excluded.tables, rows_total = excluded.rows_total, bytes = excluded.bytes, sha256 = excluded.sha256, created_at = excluded.created_at, deleted_at = NULL`,
  )
    .bind(uuid(), key, tables, rows, bytes.byteLength, hash, nowIso())
    .run();
  // Retention: 30 days.
  const cutoff = new Date(now.getTime() - BACKUP_RETENTION_DAYS * 86_400_000).toISOString();
  const { results: old } = await env.DB.prepare("SELECT id, r2_key FROM db_backups WHERE deleted_at IS NULL AND created_at < ?").bind(cutoff).all<{ id: string; r2_key: string }>();
  for (const o of old) {
    if (!o.r2_key.startsWith(BACKUP_PREFIX)) continue;
    await env.MEDIA.delete(o.r2_key);
    await env.DB.prepare("UPDATE db_backups SET deleted_at = ? WHERE id = ?").bind(nowIso(), o.id).run();
  }
  log("info", "backup.created", { key, tables, rows, bytes: bytes.byteLength, deleted: old.length });
  return { created: key, deleted: old.length };
}
