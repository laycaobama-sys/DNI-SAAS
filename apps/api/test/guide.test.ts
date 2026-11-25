import { describe, expect, it } from "vitest";
import { guideMaintenance } from "../src/routes/guide";
import { createHarness } from "./helpers";

const API = "/api/v1/public/guide";

async function lastMail(h: ReturnType<typeof createHarness>, to: string) {
  return h.db.prepare("SELECT subject, body FROM dev_mailbox WHERE to_email = ? ORDER BY created_at DESC, rowid DESC LIMIT 1").bind(to).first<{ subject: string; body: string }>();
}
const confirmLink = (body: string) => {
  const m = body.match(/\/guia\/confirmar\?id=([0-9a-f-]{36})&t=([0-9a-f]{64})/);
  return { id: m![1]!, t: m![2]! };
};
const form = (o: Record<string, string>) => ({ body: new URLSearchParams(o).toString(), headers: { "content-type": "application/x-www-form-urlencoded" } });

describe("guide «Cómo aparecer en ChatGPT» with double opt-in", () => {
  it("sends a confirmation link; only the POST confirms; the email is erased without newsletter consent", async () => {
    const h = createHarness();
    const c = new h.Client();
    const r = await c.post(API, { email: "Ana@Ejemplo.es", newsletter: false });
    expect(r.status).toBe(202);
    const row = await h.db.prepare("SELECT id, status, email_enc, email_hash, consent_text FROM guide_signups").first<{ id: string; status: string; email_enc: string; email_hash: string; consent_text: string }>();
    expect(row).toMatchObject({ status: "pending" });
    expect(row!.email_enc).not.toContain("ana@");
    expect(row!.email_hash).not.toContain("ana");
    // The fingerprint is keyed: a plain SHA-256 of the email does not match it.
    const plain = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode("guide:ana@ejemplo.es"))), (b) => b.toString(16).padStart(2, "0")).join("");
    expect(row!.email_hash).not.toBe(plain);
    expect(row!.email_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(row!.consent_text).toContain("guía");
    const mail = await lastMail(h, "ana@ejemplo.es");
    expect(mail!.subject).toContain("Confirma");
    const { id, t } = confirmLink(mail!.body);

    // Opening the link (or a mail scanner prefetching it) does not confirm anything.
    const page = await c.get(`/guia/confirmar?id=${id}&t=${t}`);
    expect(page.status).toBe(200);
    expect(String(page.json)).toContain('method="post"');
    expect((await h.db.prepare("SELECT status FROM guide_signups").first("status"))).toBe("pending");

    // A wrong token does nothing.
    const bad = await h.app.request("/guia/confirmar", { method: "POST", ...form({ id, t: "0".repeat(64) }) }, h.env, h.ctx);
    expect(bad.status).toBe(410);

    const ok = await h.app.request("/guia/confirmar", { method: "POST", ...form({ id, t }) }, h.env, h.ctx);
    expect(ok.status).toBe(303);
    const read = ok.headers.get("location")!;
    expect(read).toMatch(/^\/guia\/leer\?k=[0-9a-f-]{36}\.[0-9a-f]{32}$/);
    const after = await h.db.prepare("SELECT status, email_enc, confirmed_at FROM guide_signups").first<{ status: string; email_enc: string | null; confirmed_at: string }>();
    expect(after).toMatchObject({ status: "confirmed", email_enc: null });
    // The guide link stays in their inbox.
    expect((await lastMail(h, "ana@ejemplo.es"))!.body).toContain("/guia/leer?k=");

    const guide = await c.get(read);
    expect(guide.status).toBe(200);
    expect(guide.headers.get("x-robots-tag")).toContain("noindex");
    expect(String(guide.json)).toContain("&amp;descargar=1");
    const dl = await c.get(`${read}&descargar=1`);
    expect(dl.headers.get("content-disposition")).toContain("guia-aparecer-en-chatgpt-2027.html");

    // A forged or tampered key does not open the guide, and the static file is never served directly.
    expect((await c.get(read.replace(/.$/, (x) => (x === "a" ? "b" : "a")))).status).toBe(404);
    expect((await c.get("/guia/contenido")).status).toBe(404);
  });

  it("keeps the email encrypted only with newsletter consent, and the unsubscribe link erases it", async () => {
    const h = createHarness();
    const c = new h.Client();
    await c.post(API, { email: "luis@ejemplo.es", newsletter: true });
    const { id, t } = confirmLink((await lastMail(h, "luis@ejemplo.es"))!.body);
    await h.app.request("/guia/confirmar", { method: "POST", ...form({ id, t }) }, h.env, h.ctx);
    const row = await h.db.prepare("SELECT status, newsletter, email_enc FROM guide_signups").first<{ status: string; newsletter: number; email_enc: string | null }>();
    expect(row).toMatchObject({ status: "confirmed", newsletter: 1 });
    expect(row!.email_enc).toBeTruthy();
    const unsub = (await lastMail(h, "luis@ejemplo.es"))!.body.match(/\/guia\/baja\?k=([0-9a-f-]{36}\.[0-9a-f]{32})/)![1]!;
    expect((await c.get(`/guia/baja?k=${unsub}`)).status).toBe(200);
    const done = await h.app.request("/guia/baja", { method: "POST", ...form({ k: unsub }) }, h.env, h.ctx);
    expect(done.status).toBe(200);
    expect(await h.db.prepare("SELECT status, email_enc, newsletter FROM guide_signups").first()).toMatchObject({ status: "unsubscribed", email_enc: null, newsletter: 0 });
  });

  it("answers the same for known emails, ignores bots, limits abuse and deletes unconfirmed signups after 7 days", async () => {
    const h = createHarness();
    const c = new h.Client();
    const a = await c.post(API, { email: "eva@ejemplo.es" }, { "cf-connecting-ip": "198.51.100.1" });
    const b = await c.post(API, { email: "eva@ejemplo.es" }, { "cf-connecting-ip": "198.51.100.2" });
    expect(b.json).toEqual(a.json);
    expect(await h.db.prepare("SELECT COUNT(*) AS n FROM guide_signups").first("n")).toBe(1);
    // Honeypot filled: same answer, nothing stored or sent.
    const bot = await c.post(API, { email: "bot@ejemplo.es", website: "http://spam" }, { "cf-connecting-ip": "198.51.100.3" });
    expect(bot.status).toBe(202);
    expect(await lastMail(h, "bot@ejemplo.es")).toBeNull();
    // Per-email limit (3 a day), whatever the IP.
    await c.post(API, { email: "eva@ejemplo.es" }, { "cf-connecting-ip": "198.51.100.4" });
    expect((await c.post(API, { email: "eva@ejemplo.es" }, { "cf-connecting-ip": "198.51.100.5" })).status).toBe(429);
    // Other origins are refused.
    expect((await c.post(API, { email: "x@ejemplo.es" }, { origin: "https://evil.example", "cf-connecting-ip": "198.51.100.6" })).status).toBe(403);
    // Unconfirmed for more than 7 days: deleted.
    await h.db.prepare("UPDATE guide_signups SET created_at = ?").bind(new Date(Date.now() - 8 * 86400_000).toISOString()).run();
    await guideMaintenance(h.env);
    expect(await h.db.prepare("SELECT COUNT(*) AS n FROM guide_signups").first("n")).toBe(0);
  });
});
