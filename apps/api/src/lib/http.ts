import type { Context } from "hono";
import type { ZodType } from "zod";
import type { AppEnv } from "../env";

/** RFC 9457 problem+json errors. Messages are safe for end users (Spanish). */
export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

export const notFound = (what = "Recurso") => new ApiError(404, "not_found", `${what} no encontrado.`);
export const forbidden = (msg = "No tienes permiso para esta acción.") => new ApiError(403, "forbidden", msg);
export const unauthorized = () => new ApiError(401, "unauthorized", "Inicia sesión para continuar.");

export function problem(c: Context<AppEnv>, err: ApiError) {
  return c.body(
    JSON.stringify({
      // URN instead of a URL: no hardcoded domain that we do not own (RFC 9457 allows any URI).
      type: `urn:dni-growth:problem:${err.code}`,
      title: err.message,
      status: err.status,
      code: err.code,
      requestId: c.get("requestId"),
      ...err.extra,
    }),
    err.status as 400,
    { "content-type": "application/problem+json; charset=utf-8" },
  );
}

export async function parseBody<T>(c: Context<AppEnv>, schema: ZodType<T>): Promise<T> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    throw new ApiError(400, "invalid_json", "El cuerpo de la petición no es JSON válido.");
  }
  const r = schema.safeParse(raw);
  if (!r.success) {
    throw new ApiError(422, "validation_error", "Datos no válidos.", {
      errors: r.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
    });
  }
  return r.data;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function assertUuid(v: string | undefined, what = "Recurso"): string {
  if (!v || !UUID_RE.test(v)) throw notFound(what);
  return v.toLowerCase();
}
