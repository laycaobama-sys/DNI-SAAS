import { describe, expect, it } from "vitest";
import { dispatchEmail, drainEmailOutbox, mailMode, sendMail, type EmailBinding } from "../src/lib/mail";
import { createHarness } from "./helpers";

const KEY = "ab".repeat(32);

/** Fake Cloudflare `send_email` binding: records calls, can be told to fail. */
function fakeBinding(behaviour: { fail?: string | null } = {}) {
  const sent: Array<{ to: string; subject: string; text?: string; html?: string; from: unknown }> = [];
  const binding: EmailBinding & { sent: typeof sent; behaviour: typeof behaviour } = {
    sent,
    behaviour,
    async send(msg) {
      if (behaviour.fail) throw new Error(behaviour.fail);
      sent.push(msg);
      return { messageId: `msg-${sent.length}` };
    },
  };
  return binding;
}

function prodHarness(binding = fakeBinding()) {
  const h = createHarness();
  Object.assign(h.env, { ENVIRONMENT: "production", EMAIL: binding, MAIL_FROM: "no-reply@example.test", EMAIL_SENDING_ENABLED: "true", DATA_ENC_KEY: KEY });
  return { h, binding };
}

const row = (h: ReturnType<typeof createHarness>) =>
  h.db.prepare("SELECT * FROM email_outbox ORDER BY created_at DESC LIMIT 1").first<Record<string, unknown>>();

describe("Transactional email (Cloudflare Email Service + durable outbox)", () => {
  it("modes: dev mailbox in test, not_configured in production without binding/flag/key", () => {
    const h = createHarness();
    expect(mailMode(h.env)).toBe("dev_mailbox");
    h.env.ENVIRONMENT = "production";
    expect(mailMode(h.env)).toBe("not_configured");
    Object.assign(h.env, { EMAIL: fakeBinding(), MAIL_FROM: "no-reply@example.test" });
    expect(mailMode(h.env)).toBe("not_configured"); // sending domain not confirmed yet
    h.env.EMAIL_SENDING_ENABLED = "true";
    expect(mailMode(h.env)).toBe("enabled");
  });

  it("register sends through the send_email binding and stores no plaintext at rest", async () => {
    const { h, binding } = prodHarness();
    const r = await new h.Client().post("/api/v1/auth/register", { email: "Ana@Cliente.es", password: "Sup3rSecretPass", name: "Ana" });
    expect(r.status).toBe(202);
    expect(r.json.delivery).toBe("sent");
    expect(binding.sent).toHaveLength(1);
    expect(binding.sent[0]!.to).toBe("ana@cliente.es");
    expect(binding.sent[0]!.from).toEqual({ email: "no-reply@example.test", name: "DNI Growth" });
    expect(binding.sent[0]!.text).toMatch(/\/app\/verify\?token=[0-9a-f]{64}/);
    expect(binding.sent[0]!.html).toContain("Confirmar correo");
    const o = (await row(h))!;
    expect(o).toMatchObject({ status: "accepted", provider: "cloudflare_email", provider_message_id: "msg-1", payload_enc: null, kind: "verify_email" });
    expect(JSON.stringify(o)).not.toContain("ana@cliente.es");
    expect(o.to_masked).not.toBe("ana@cliente.es");
  });

  it("existing and new emails get the same response (no enumeration)", async () => {
    const { h, binding } = prodHarness();
    const c = new h.Client();
    const a = await c.post("/api/v1/auth/register", { email: "x@y.es", password: "Sup3rSecretPass", name: "X" });
    const b = await c.post("/api/v1/auth/register", { email: "x@y.es", password: "Sup3rSecretPass", name: "X" });
    expect(a.json).toEqual(b.json);
    expect(binding.sent).toHaveLength(1);
  });

  it("transient failure → retried by the cron with backoff; payload stays encrypted meanwhile", async () => {
    const { h, binding } = prodHarness(fakeBinding({ fail: "upstream timeout" }));
    const r = await new h.Client().post("/api/v1/auth/register", { email: "r@y.es", password: "Sup3rSecretPass", name: "R" });
    expect(r.json.delivery).toBe("sent"); // platform mode, identical for every user
    let o = (await row(h))!;
    expect(o).toMatchObject({ status: "failed", attempts: 1, last_error_code: "provider_error" });
    expect(String(o.payload_enc)).toMatch(/^v1\./);
    expect(String(o.payload_enc)).not.toContain("r@y.es");
    expect(new Date(String(o.next_attempt_at)).getTime()).toBeGreaterThan(Date.now());

    // Not due yet → the cron does nothing.
    binding.behaviour.fail = null;
    await drainEmailOutbox(h.env);
    expect(binding.sent).toHaveLength(0);

    await h.db.prepare("UPDATE email_outbox SET next_attempt_at = '2000-01-01T00:00:00.000Z'").run();
    await drainEmailOutbox(h.env);
    o = (await row(h))!;
    expect(o).toMatchObject({ status: "accepted", attempts: 2, payload_enc: null });
    expect(binding.sent).toHaveLength(1);
  });

  it("permanent rejection (unverified sender) goes straight to dead and purges the payload", async () => {
    const { h } = prodHarness(fakeBinding({ fail: "sender domain not verified" }));
    await new h.Client().post("/api/v1/auth/register", { email: "d@y.es", password: "Sup3rSecretPass", name: "D" });
    expect(await row(h)).toMatchObject({ status: "dead", last_error_code: "provider_rejected", payload_enc: null });
  });

  it("bounded retries: after max_attempts the message is dead", async () => {
    const { h } = prodHarness(fakeBinding({ fail: "timeout" }));
    await new h.Client().post("/api/v1/auth/register", { email: "m@y.es", password: "Sup3rSecretPass", name: "M" });
    for (let i = 0; i < 6; i++) {
      await h.db.prepare("UPDATE email_outbox SET next_attempt_at = '2000-01-01T00:00:00.000Z'").run();
      await drainEmailOutbox(h.env);
    }
    expect(await row(h)).toMatchObject({ status: "dead", attempts: 5, payload_enc: null });
  });

  it("idempotency key: the same logical email is queued and sent once", async () => {
    const { h, binding } = prodHarness();
    const msg = { to: "i@y.es", subject: "Hola", text: "t" };
    expect(await sendMail(h.env, msg, { kind: "notification", idempotencyKey: "k1" })).toBe("accepted");
    expect(await sendMail(h.env, msg, { kind: "notification", idempotencyKey: "k1" })).toBe("queued");
    expect(binding.sent).toHaveLength(1);
    expect(await h.db.prepare("SELECT COUNT(*) AS n FROM email_outbox").first("n")).toBe(1);
  });

  it("an accepted message cannot be claimed and sent again (concurrent dispatch)", async () => {
    const { h, binding } = prodHarness(fakeBinding({ fail: "timeout" }));
    await sendMail(h.env, { to: "c@y.es", subject: "s", text: "t" }, { kind: "notification", idempotencyKey: "c1" });
    binding.behaviour.fail = null;
    await h.db.prepare("UPDATE email_outbox SET next_attempt_at = '2000-01-01T00:00:00.000Z'").run();
    const id = (await row(h))!.id as string;
    const results = await Promise.all([dispatchEmail(h.env, id), dispatchEmail(h.env, id), drainEmailOutbox(h.env)]);
    expect(results.filter((r) => r === "accepted")).toHaveLength(1);
    expect(binding.sent).toHaveLength(1);
  });

  it("production without DATA_ENC_KEY refuses to queue (never stores links unencrypted)", async () => {
    const { h, binding } = prodHarness();
    delete h.env.DATA_ENC_KEY;
    expect(await sendMail(h.env, { to: "k@y.es", subject: "s", text: "t" }, { kind: "notification", idempotencyKey: "k" })).toBe("not_configured");
    expect(binding.sent).toHaveLength(0);
    expect(await h.db.prepare("SELECT COUNT(*) AS n FROM email_outbox").first("n")).toBe(0);
  });

  it("a tampered payload is not sent (AES-GCM authentication) and is dead-lettered", async () => {
    const { h, binding } = prodHarness(fakeBinding({ fail: "timeout" }));
    await sendMail(h.env, { to: "t@y.es", subject: "s", text: "t" }, { kind: "notification", idempotencyKey: "t1" });
    binding.behaviour.fail = null;
    const o = (await row(h))!;
    const tampered = String(o.payload_enc).replace(/.$/, (ch) => (ch === "0" ? "1" : "0"));
    await h.db.prepare("UPDATE email_outbox SET payload_enc = ?, next_attempt_at = '2000-01-01T00:00:00.000Z'").bind(tampered).run();
    await drainEmailOutbox(h.env);
    expect(await row(h)).toMatchObject({ status: "dead", last_error_code: "decrypt_failed" });
    expect(binding.sent).toHaveLength(0);
  });

  it("invitations go through the outbox with the organization scope", async () => {
    const h = createHarness();
    const owner = await h.signup("owner@luna.es");
    const orgId = await h.createOrg(owner, "Luna");
    await h.db.prepare("UPDATE organizations SET plan_code = 'growth' WHERE id = ?").bind(orgId).run();
    const r = await owner.post(`/api/v1/orgs/${orgId}/invitations`, { email: "inv@luna.es", role: "editor" });
    expect(r.status).toBe(201);
    expect(r.json.delivery).toBe("dev_mailbox");
    expect(await h.db.prepare("SELECT organization_id, kind, status FROM email_outbox WHERE kind = 'invitation'").first()).toEqual({ organization_id: orgId, kind: "invitation", status: "accepted" });
  });
});
