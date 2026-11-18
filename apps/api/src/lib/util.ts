import { redact, sha256Hex } from "@dni/core";
import type { Env } from "../env";

export const uuid = () => crypto.randomUUID();
export const nowIso = (d = new Date()) => d.toISOString();
export const addSeconds = (s: number, d = new Date()) => new Date(d.getTime() + s * 1000).toISOString();
export const monthKey = (d = new Date()) => d.toISOString().slice(0, 7);
export const monthStartIso = (d = new Date()) => `${monthKey(d)}-01T00:00:00.000Z`;

export async function hashIp(env: Env, ip: string | undefined | null): Promise<string | null> {
  if (!ip) return null;
  return (await sha256Hex(`${env.IP_HASH_SALT ?? "dev-salt"}:${ip}`)).slice(0, 32);
}

export function parseJson<T>(s: string | null | undefined, fallback: T): T {
  if (!s) return fallback;
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
}

/** Structured JSON logs. All payloads are redacted (no tokens, secrets or emails in clear). */
export function log(level: "info" | "warn" | "error", event: string, data: Record<string, unknown> = {}) {
  const line = JSON.stringify({ ts: nowIso(), level, event, ...redact(data) });
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  // eslint-disable-next-line no-console -- structured logs go to Workers Logs
  else console.log(line);
}

export function slugify(s: string): string {
  return (
    s
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 40) || "org"
  );
}

/** Runs D1 statements in batches (each batch is atomic in D1). */
export async function batchChunks(db: D1Database, stmts: D1PreparedStatement[], size = 50) {
  for (let i = 0; i < stmts.length; i += size) await db.batch(stmts.slice(i, i + size));
}

/** CSV with BOM (Excel-friendly) and a spreadsheet formula-injection guard (cells starting with = + - @ tab CR). */
export function toCsv(header: string[], rows: unknown[][]): string {
  const cell = (v: unknown) => {
    let s = v === null || v === undefined ? "" : String(v);
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
    return /[",\n\r;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return String.fromCharCode(0xfeff) + [header.map(cell).join(","), ...rows.map((r) => r.map(cell).join(","))].join("\r\n") + "\r\n";
}
