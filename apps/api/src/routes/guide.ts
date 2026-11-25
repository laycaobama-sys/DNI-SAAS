import { decryptJson, encryptJson, hmacSha256Hex, sha256Hex, timingSafeEqual } from "@dni/core";
import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import type { AppEnv, Env } from "../env";
import { ApiError, parseBody } from "../lib/http";
import { emailHtml, encKey, sendMail } from "../lib/mail";
import { rateLimit } from "../lib/ratelimit";
import { SITE_SECURITY_HEADERS } from "../lib/site-headers";
import { hashIp, log, nowIso, uuid } from "../lib/util";

/**
 * Free guide «Cómo aparecer en ChatGPT (2027)» in exchange for an email, with double opt-in (ADR 0026).
 * 1. POST /api/v1/public/guide: always the same answer (no way to tell if an email is known); sends a
 *    confirmation link. Limits per IP, per email and per day for the whole platform.
 * 2. /guia/confirmar shows a button; only the POST confirms, so mail scanners that open links do not.
 * 3. /guia/leer?k=… serves the guide (link signed per signup). Without the optional newsletter consent the
 *    email is erased on confirmation and only its hash stays as proof of consent.
 * 4. /guia/baja deletes the email and stops any future email.
 */
export const GUIDE_KEY = "chatgpt-2027";
export const GUIDE_CONSENT = {
  guide: "Quiero recibir por email el enlace a la guía «Cómo aparecer en ChatGPT (2027)».",
  newsletter: "Además, acepto recibir como máximo un email al mes con novedades y consejos de DNI Growth (opcional; puedo darme de baja cuando quiera).",
} as const;

const IP_PER_HOUR = 5;
const EMAIL_PER_DAY = 3;
const GLOBAL_PER_DAY = 300;
const PENDING_DAYS = 7;

const PAGE_HEADERS = { "content-type": "text/html; charset=utf-8", ...SITE_SECURITY_HEADERS, "cache-control": "no-store", "x-robots-tag": "noindex, nofollow" };

const signKey = (env: Env) => `guide:${env.DATA_ENC_KEY ?? env.IP_HASH_SALT ?? "dev-only-key"}`;
const sign = async (env: Env, purpose: "read" | "unsub", id: string) => (await hmacSha256Hex(signKey(env), `${purpose}:${id}`)).slice(0, 32);
export const readKey = async (env: Env, id: string) => `${id}.${await sign(env, "read", id)}`;
export const unsubKey = async (env: Env, id: string) => `${id}.${await sign(env, "unsub", id)}`;

async function verifyKey(env: Env, purpose: "read" | "unsub", key: string | undefined): Promise<string | null> {
  const m = /^([0-9a-f-]{36})\.([0-9a-f]{32})$/.exec(key ?? "");
  if (!m) return null;
  return timingSafeEqual(await sign(env, purpose, m[1]!), m[2]!) ? m[1]! : null;
}

const origin = (env: Env) => env.APP_ORIGIN.replace(/\/$/, "");
const esc = (s: string) => s.replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[ch]!);

function simplePage(title: string, inner: string): string {
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex, nofollow"><title>${esc(title)} · DNI Growth</title>
<style>body{margin:0;background:#0b0b0c;color:#f5f5f4;font:17px/1.6 Inter,Arial,sans-serif}main{max-width:560px;margin:0 auto;padding:64px 20px}h1{font-size:28px;line-height:1.25}a{color:#e8e8ee}button,.btn{display:inline-block;font:700 16px Inter,Arial,sans-serif;background:#b4ff4d;color:#0b0b0c;border:0;border-radius:999px;padding:14px 22px;cursor:pointer;text-decoration:none}p.note{color:#9a9aa6;font-size:14px}</style></head>
<body><main id="main"><p><a href="/">DNI Growth</a></p>${inner}</main></body></html>`;
}

// ── 1. Sign up ────────────────────────────────────────────────────────────────────────────────────
export const guideApi = new Hono<AppEnv>();

const SignupInput = z.strictObject({
  email: z.string().trim().toLowerCase().email().max(254),
  newsletter: z.boolean().default(false),
  /** Honeypot: hidden field that people never fill. */
  website: z.string().max(200).optional(),
});

guideApi.post(
  "/guide",
  bodyLimit({
    maxSize: 2048,
    onError: () => {
      throw new ApiError(413, "payload_too_large", "Petición demasiado grande.");
    },
  }),
  async (c) => {
    const reqOrigin = c.req.header("origin");
    if (reqOrigin && reqOrigin !== new URL(c.req.url).origin && reqOrigin !== c.env.APP_ORIGIN) throw new ApiError(403, "origin_not_allowed", "Origen no permitido.");
    const input = await parseBody(c, SignupInput);
    const done = () => c.json({ ok: true, message: "Revisa tu correo: te hemos enviado un enlace para confirmar. Si no lo ves en unos minutos, mira en la carpeta de spam o promociones." }, 202);
    if (input.website) return done(); // bot: same answer, nothing stored
    const db = c.env.DB;
    const ip = (await hashIp(c.env, c.req.header("cf-connecting-ip"))) ?? "noip";
    await rateLimit(db, `guide:ip:${ip}`, IP_PER_HOUR, 3600);
    const emailHash = await sha256Hex(`guide:${input.email}`);
    await rateLimit(db, `guide:email:${emailHash}`, EMAIL_PER_DAY, 86400);
    try {
      await rateLimit(db, "guide:global", GLOBAL_PER_DAY, 86400);
    } catch (e) {
      if (e instanceof ApiError && e.status === 429) throw new ApiError(429, "guide_daily_cap", "Hoy hemos enviado el máximo de guías. Vuelve a intentarlo mañana.", e.extra);
      throw e;
    }
    const key = encKey(c.env);
    if (!key) throw new ApiError(503, "mail_not_configured", "El envío de correos no está disponible ahora mismo.");
    const existing = await db
      .prepare("SELECT id, status FROM guide_signups WHERE guide = ? AND email_hash = ?")
      .bind(GUIDE_KEY, emailHash)
      .first<{ id: string; status: string }>();
    const now = nowIso();
    const token = [...crypto.getRandomValues(new Uint8Array(32))].map((b) => b.toString(16).padStart(2, "0")).join("");
    const consent = input.newsletter ? `${GUIDE_CONSENT.guide} ${GUIDE_CONSENT.newsletter}` : GUIDE_CONSENT.guide;
    const id = existing?.id ?? uuid();
    const emailEnc = await encryptJson(key, input.email, `guide:${id}`);
    if (!existing) {
      await db
        .prepare("INSERT INTO guide_signups (id, guide, email_hash, email_enc, newsletter, status, confirm_hash, consent_text, ip_hash, created_at) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?)")
        .bind(id, GUIDE_KEY, emailHash, emailEnc, input.newsletter ? 1 : 0, await sha256Hex(token), consent, ip, now)
        .run();
    } else if (existing.status === "confirmed") {
      // Already confirmed: send the guide link again (to that same inbox only); keep the earlier consent.
      await mailReadLink(c.env, id, input.email);
      return done();
    } else {
      // Pending or unsubscribed: start a new confirmation with the consent given now.
      await db
        .prepare("UPDATE guide_signups SET email_enc = ?, newsletter = ?, status = 'pending', confirm_hash = ?, consent_text = ?, ip_hash = ?, created_at = ?, confirmed_at = NULL, unsubscribed_at = NULL WHERE id = ?")
        .bind(emailEnc, input.newsletter ? 1 : 0, await sha256Hex(token), consent, ip, now, id)
        .run();
    }
    const link = `${origin(c.env)}/guia/confirmar?id=${id}&t=${token}`;
    await sendMail(
      c.env,
      {
        to: input.email,
        subject: "Confirma tu email para recibir la guía",
        html: emailHtml("Confirma tu email", ["Has pedido la guía «Cómo aparecer en ChatGPT y otros asistentes de IA (edición 2027)».", "Pulsa el botón para confirmar que este email es tuyo y abrir la guía. El enlace caduca en 7 días."], { label: "Confirmar y ver la guía", url: link }),
        text: `Has pedido la guía «Cómo aparecer en ChatGPT (2027)». Confirma tu email y ábrela aquí (caduca en 7 días):\n${link}\n\nSi no has sido tú, ignora este correo: no te escribiremos más.`,
      },
      { kind: "notification", idempotencyKey: `guide:confirm:${id}:${now}` },
    );
    return done();
  },
);

async function mailReadLink(env: Env, id: string, email: string) {
  const link = `${origin(env)}/guia/leer?k=${await readKey(env, id)}`;
  const unsub = `${origin(env)}/guia/baja?k=${await unsubKey(env, id)}`;
  await sendMail(
    env,
    {
      to: email,
      subject: "Tu guía: cómo aparecer en ChatGPT (2027)",
      html: emailHtml("Aquí tienes tu guía", ["Este es tu enlace personal a la guía «Cómo aparecer en ChatGPT y otros asistentes de IA (edición 2027)». Puedes leerla, descargarla o guardarla en PDF.", `Si no quieres que guardemos tu email, puedes borrarlo aquí: ${unsub}`], { label: "Abrir la guía", url: link }),
      text: `Tu guía «Cómo aparecer en ChatGPT (2027)»:\n${link}\n\nPara borrar tu email: ${unsub}`,
    },
    { kind: "notification", idempotencyKey: `guide:read:${id}:${nowIso().slice(0, 13)}` },
  );
}

// ── 2–4. Pages outside /api (listed in run_worker_first: /guia/*) ─────────────────────────────────
async function guideHtml(c: Context<AppEnv>): Promise<string> {
  if (!c.env.ASSETS) return "<!doctype html><html lang=\"es\"><head><title>Guía</title></head><body><main><h1>Cómo aparecer en ChatGPT y otros asistentes de IA</h1><a href=\"?descargar=1\" data-download>Descargar la guía</a></main></body></html>";
  const res = await c.env.ASSETS.fetch(new Request(new URL("/guia/contenido", c.req.url)));
  return res.ok ? res.text() : "";
}

export function registerGuidePages(app: Hono<AppEnv>, notFoundPage: (c: Context<AppEnv>) => Promise<Response>) {
  // The guide itself is only served through a signed link (never straight from the static files).
  app.get("/guia/contenido", (c) => notFoundPage(c));
  app.get("/guia/contenido.html", (c) => notFoundPage(c));
  app.get("/guia", (c) => c.redirect("/guia-como-aparecer-en-chatgpt", 301));
  app.get("/guia/confirmar", async (c) => {
    const id = c.req.query("id") ?? "";
    const t = c.req.query("t") ?? "";
    if (!/^[0-9a-f-]{36}$/.test(id) || !/^[0-9a-f]{64}$/.test(t)) return notFoundPage(c);
    return c.body(
      simplePage(
        "Confirma tu email",
        `<h1>Confirma tu email</h1><p>Pulsa el botón para confirmar que quieres recibir la guía «Cómo aparecer en ChatGPT (2027)».</p>
<form method="post" action="/guia/confirmar"><input type="hidden" name="id" value="${esc(id)}"><input type="hidden" name="t" value="${esc(t)}"><button type="submit">Confirmar y ver la guía</button></form>
<p class="note">Si no has pedido la guía, cierra esta página: no haremos nada con tu email y lo borraremos en ${PENDING_DAYS} días.</p>`,
      ),
      200,
      PAGE_HEADERS,
    );
  });

  app.post("/guia/confirmar", async (c) => {
    const reqOrigin = c.req.header("origin");
    if (reqOrigin && reqOrigin !== new URL(c.req.url).origin && reqOrigin !== c.env.APP_ORIGIN) return c.body("Origen no permitido.", 403);
    const form = await c.req.parseBody().catch(() => ({}) as Record<string, unknown>);
    const id = String(form.id ?? "");
    const t = String(form.t ?? "");
    const fail = () => c.body(simplePage("Enlace no válido", `<h1>Este enlace ya no es válido</h1><p>Puede que haya caducado (duran ${PENDING_DAYS} días) o que ya lo hayas usado. Pide la guía otra vez: es gratis.</p><p><a class="btn" href="/guia-como-aparecer-en-chatgpt">Pedir la guía</a></p>`), 410, PAGE_HEADERS);
    if (!/^[0-9a-f-]{36}$/.test(id) || !/^[0-9a-f]{64}$/.test(t)) return fail();
    const db = c.env.DB;
    const row = await db
      .prepare("SELECT id, status, confirm_hash, newsletter, email_enc, created_at FROM guide_signups WHERE id = ?")
      .bind(id)
      .first<{ id: string; status: string; confirm_hash: string; newsletter: number; email_enc: string | null; created_at: string }>();
    if (!row || !timingSafeEqual(row.confirm_hash, await sha256Hex(t))) return fail();
    if (row.status === "pending") {
      if (Date.now() - Date.parse(row.created_at) > PENDING_DAYS * 86400_000) return fail();
      // Keep the guide link in their inbox (before the email is erased).
      const email = row.email_enc ? await decryptGuideEmail(c.env, id, row.email_enc) : null;
      if (email) await mailReadLink(c.env, id, email);
      // Without newsletter consent the email is no longer needed: erase it, keep the hash as proof of consent.
      const upd = await db
        .prepare(`UPDATE guide_signups SET status = 'confirmed', confirmed_at = ?, email_enc = CASE WHEN newsletter = 1 THEN email_enc ELSE NULL END WHERE id = ? AND status = 'pending'`)
        .bind(nowIso(), id)
        .run();
      if (upd.meta.changes) log("info", "guide.confirmed", { newsletter: row.newsletter === 1 });
    } else if (row.status !== "confirmed") return fail();
    return c.redirect(`/guia/leer?k=${await readKey(c.env, id)}`, 303);
  });

  app.get("/guia/leer", async (c) => {
    const id = await verifyKey(c.env, "read", c.req.query("k"));
    if (!id) return notFoundPage(c);
    const row = await c.env.DB.prepare("SELECT status FROM guide_signups WHERE id = ?").bind(id).first<{ status: string }>();
    if (row?.status !== "confirmed") return notFoundPage(c);
    const k = await readKey(c.env, id);
    let html = (await guideHtml(c)).replace('href="?descargar=1"', `href="/guia/leer?k=${k}&amp;descargar=1"`);
    if (c.req.query("descargar") === "1") {
      html = html.replace(/<div class="actions"[^]*?<\/div>/, "");
      return c.body(html, 200, { ...PAGE_HEADERS, "content-disposition": 'attachment; filename="guia-aparecer-en-chatgpt-2027.html"' });
    }
    return c.body(html, 200, PAGE_HEADERS);
  });

  app.get("/guia/baja", async (c) => {
    const k = c.req.query("k") ?? "";
    if (!(await verifyKey(c.env, "unsub", k))) return notFoundPage(c);
    return c.body(
      simplePage("Borrar mi email", `<h1>Borrar mi email</h1><p>Borraremos tu email de la lista de la guía y no te escribiremos más.</p><form method="post" action="/guia/baja"><input type="hidden" name="k" value="${esc(k)}"><button type="submit">Borrar mi email</button></form>`),
      200,
      PAGE_HEADERS,
    );
  });

  app.post("/guia/baja", async (c) => {
    const form = await c.req.parseBody().catch(() => ({}) as Record<string, unknown>);
    const id = await verifyKey(c.env, "unsub", String(form.k ?? ""));
    if (!id) return notFoundPage(c);
    await c.env.DB.prepare("UPDATE guide_signups SET status = 'unsubscribed', email_enc = NULL, newsletter = 0, unsubscribed_at = ? WHERE id = ?").bind(nowIso(), id).run();
    return c.body(simplePage("Email borrado", "<h1>Hecho</h1><p>Hemos borrado tu email. No te escribiremos más.</p>"), 200, PAGE_HEADERS);
  });
}

/** Cron: unconfirmed signups are deleted after 7 days (the email was never confirmed as theirs). */
export async function guideMaintenance(env: Env) {
  const cutoff = new Date(Date.now() - PENDING_DAYS * 86400_000).toISOString();
  await env.DB.prepare("DELETE FROM guide_signups WHERE status = 'pending' AND created_at < ?").bind(cutoff).run();
}

async function decryptGuideEmail(env: Env, id: string, enc: string): Promise<string | null> {
  const key = encKey(env);
  return key ? decryptJson<string>(key, enc, `guide:${id}`).catch(() => null) : null;
}
