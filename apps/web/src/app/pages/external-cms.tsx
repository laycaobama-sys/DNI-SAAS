import { useState, type FormEvent } from "react";
import { Globe, Link2, Unlink } from "lucide-react";
import { can, CMS_STATE_LABEL, EXTERNAL_CMS_LABEL, isRole, WP_PUBLISHABLE_KINDS, type CmsPublicationState, type ExternalCmsProvider } from "@dni/core";
import { ApiError, del, fmtDate, post } from "../lib/api";
import { useAuth } from "../lib/auth";
import { useApi } from "../lib/hooks";
import { Badge, Button, Card, Input, Notice } from "../ui";

interface Conn {
  status: string;
  target: string | null;
  connectedAt: string;
  lastError: string | null;
}
interface Pub {
  state: CmsPublicationState;
  url: string | null;
  externalId: string | null;
  contentVersion: number | null;
  lastError: string | null;
  publishedAt: string | null;
}
type Data = Record<ExternalCmsProvider, { connection: Conn | null; publication: Pub | null }>;

const asErr = (e: unknown) => (e instanceof ApiError ? e : new ApiError(0, "unknown", "Error inesperado."));

/**
 * «Publicar en Ghost o en un webhook» on a content item: Ghost with an Admin API key, or any system (Webflow
 * through Make/Zapier, n8n, own backend) through a signed webhook. Same rules as WordPress.
 */
export function ExternalCmsCard({ orgId, contentId, kind, status, version }: { orgId: string; contentId: string; kind: string; status: string; version: number }) {
  const { me } = useAuth();
  const role = me?.memberships.find((m) => m.id === orgId)?.role ?? "";
  const r = isRole(role) ? role : null;
  const canManage = !!r && can(r, "integrations:manage");
  const canApprove = !!r && can(r, "content:approve");
  const res = useApi<Data>(`/orgs/${orgId}/content/${contentId}/external`);
  const [tab, setTab] = useState<ExternalCmsProvider>("ghost");
  const [ghostForm, setGhostForm] = useState({ apiUrl: "", adminKey: "" });
  const [hookUrl, setHookUrl] = useState("");
  const [secret, setSecret] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<ApiError | null>(null);
  const [ok, setOk] = useState<string | null>(null);

  if (!(WP_PUBLISHABLE_KINDS as readonly string[]).includes(kind)) return null;
  if (res.error?.code === "plan_required")
    return (
      <Card title="Publicar en Ghost o con un webhook">
        <p className="text-sm text-mute">Incluido desde el plan Starter: publica lo aprobado en Ghost o envíalo firmado a cualquier sistema (Webflow con Make o Zapier, n8n o tu propio servidor).</p>
      </Card>
    );
  if (res.loading || !res.data) return null;
  const cur = res.data[tab];
  const conn = cur.connection;
  const pub = cur.publication;
  const connected = conn?.status === "connected";
  const label = EXTERNAL_CMS_LABEL[tab];

  const run = async (key: string, fn: () => Promise<unknown>, done?: string) => {
    setBusy(key);
    setErr(null);
    setOk(null);
    try {
      await fn();
      if (done) setOk(done);
    } catch (e) {
      setErr(asErr(e));
    } finally {
      await res.reload();
      setBusy(null);
    }
  };

  const connectGhost = (e: FormEvent) => {
    e.preventDefault();
    void run("connect", async () => {
      await post(`/orgs/${orgId}/cms/ghost`, ghostForm);
      setGhostForm({ apiUrl: "", adminKey: "" });
    }, "Ghost conectado.");
  };
  const connectHook = (e: FormEvent) => {
    e.preventDefault();
    void run("connect", async () => {
      const out = await post<{ secret: string }>(`/orgs/${orgId}/cms/webhook`, { url: hookUrl });
      setSecret(out.secret);
      setHookUrl("");
    }, "Webhook conectado: tu servidor respondió a la prueba.");
  };
  const send = (s: "draft" | "publish") => {
    const where = conn?.target ?? label;
    const msg = tab === "ghost"
      ? s === "publish" ? `Se publicará en ${where}, visible para cualquiera. ¿Publicar?` : `Se guardará como borrador en ${where}. ¿Enviar?`
      : `Se enviará a ${where} con estado «${s === "publish" ? "publicar" : "borrador"}». ¿Enviar?`;
    if (!window.confirm(msg)) return;
    void run(s, () => post(`/orgs/${orgId}/content/${contentId}/external/${tab}`, { status: s }), tab === "ghost" ? (s === "publish" ? "Publicado en Ghost." : "Guardado como borrador en Ghost.") : "Enviado al webhook.");
  };

  return (
    <Card title="Publicar en Ghost o con un webhook" subtitle="Para Webflow, usa el webhook con Make, Zapier o n8n.">
      <div className="space-y-3 text-sm">
        <div role="tablist" aria-label="Destino" className="flex gap-2">
          {(["ghost", "webhook"] as const).map((p) => (
            <button
              key={p}
              type="button"
              role="tab"
              aria-selected={tab === p}
              className={`rounded-full border px-3 py-1 text-xs font-semibold ${tab === p ? "border-accent bg-accent/10 text-accent-text" : "border-line text-mute hover:bg-surface-2"}`}
              onClick={() => {
                setTab(p);
                setErr(null);
                setOk(null);
              }}
            >
              {EXTERNAL_CMS_LABEL[p]}
              {res.data![p].connection?.status === "connected" ? " · conectado" : ""}
            </button>
          ))}
        </div>
        {err && <Notice tone="warn" title="No se pudo completar">{err.message}</Notice>}
        {ok && <Notice tone="ok">{ok}</Notice>}
        {secret && tab === "webhook" && (
          <Notice tone="info" title="Copia ahora el secreto de firma">
            <span className="block break-all font-mono text-xs">{secret}</span>
            <span className="mt-1 block text-xs">No lo volveremos a mostrar. Úsalo para comprobar la cabecera x-dni-signature. Si lo pierdes, vuelve a conectar el webhook.</span>
          </Notice>
        )}
        {conn?.status === "reauth_required" && <Notice tone="warn" title="Hay que volver a conectar">Ghost ya no acepta la clave guardada.</Notice>}
        {connected && <p className="break-all text-xs text-mute">Destino: {conn?.target}</p>}

        {pub && (
          <div className="rounded-xl border border-line p-3">
            <p className="flex flex-wrap items-center gap-2">
              <Badge tone={pub.state === "published" ? "ok" : pub.state === "failed" ? "danger" : "info"}>{CMS_STATE_LABEL[pub.state]}</Badge>
              {pub.publishedAt && <span className="text-xs text-mute">desde {fmtDate(pub.publishedAt)}</span>}
            </p>
            {pub.url && (
              <a href={pub.url} target="_blank" rel="noopener noreferrer" className="mt-2 block break-all font-semibold text-accent-text hover:underline">
                {pub.url.replace(/^https?:\/\//, "")}
              </a>
            )}
            {pub.contentVersion !== null && pub.contentVersion !== version && pub.state !== "failed" && <p className="mt-1 text-xs text-warn">{label} tiene la versión {pub.contentVersion}; la actual es la {version}.</p>}
            {pub.state === "failed" && pub.lastError && <p className="mt-1 text-xs text-danger">{pub.lastError}</p>}
          </div>
        )}

        {connected && status === "approved" && canApprove && (
          <div className="space-y-2">
            <Button className="w-full" variant="primary" loading={busy === "publish"} disabled={!!busy} onClick={() => send("publish")}>
              <Globe className="size-4" aria-hidden /> {pub?.externalId || pub?.state === "published" ? "Actualizar y publicar" : "Publicar ahora"}
            </Button>
            <Button className="w-full" loading={busy === "draft"} disabled={!!busy} onClick={() => send("draft")}>
              Enviar como borrador
            </Button>
            {pub && (pub.state === "published" || pub.state === "draft") && (tab === "webhook" || pub.externalId) && (
              <Button
                className="w-full"
                variant="ghost"
                loading={busy === "unpublish"}
                disabled={!!busy}
                onClick={() =>
                  window.confirm(tab === "ghost" ? "¿Retirar? La entrada pasará a borrador en Ghost (no se borra)." : "¿Retirar? Se enviará el aviso content.unpublish a tu servidor.") &&
                  void run("unpublish", () => post(`/orgs/${orgId}/content/${contentId}/external/${tab}/unpublish`), "Retirado.")
                }
              >
                Retirar
              </Button>
            )}
          </div>
        )}
        {connected && status !== "approved" && <p className="text-mute">Apruébalo primero: solo se envía contenido aprobado por una persona.</p>}
        {connected && status === "approved" && !canApprove && <p className="text-mute">Solo propietario, administración o marketing pueden publicar.</p>}

        {canManage && !connected && tab === "ghost" && (
          <form className="space-y-2" onSubmit={connectGhost}>
            <p className="text-xs text-mute">
              En Ghost ve a <strong>Ajustes → Integraciones → Añadir integración personalizada</strong>, llámala «DNI Growth» y copia aquí su <strong>Admin API key</strong>. Puedes borrar la integración allí cuando quieras.
            </p>
            <label className="block">
              <span className="font-medium">Dirección de tu Ghost</span>
              <Input className="mt-1" required placeholder="https://tublog.ghost.io" value={ghostForm.apiUrl} maxLength={300} onChange={(e) => setGhostForm({ ...ghostForm, apiUrl: e.target.value })} />
            </label>
            <label className="block">
              <span className="font-medium">Admin API key</span>
              <Input className="mt-1" required type="password" autoComplete="off" value={ghostForm.adminKey} maxLength={100} onChange={(e) => setGhostForm({ ...ghostForm, adminKey: e.target.value })} />
            </label>
            <Button type="submit" className="w-full" variant="primary" loading={busy === "connect"}>
              <Link2 className="size-4" aria-hidden /> Conectar Ghost
            </Button>
          </form>
        )}
        {canManage && !connected && tab === "webhook" && (
          <form className="space-y-2" onSubmit={connectHook}>
            <p className="text-xs text-mute">
              Escribe la dirección https que recibirá los avisos firmados (por ejemplo, un webhook de Make o Zapier que cree el artículo en Webflow). Enviamos una prueba y tu servidor tiene que responder con un 2xx.{" "}
              <a className="text-accent-text hover:underline" href="/openapi/webhook-publicacion.yaml" target="_blank" rel="noopener noreferrer">
                Formato de los avisos (OpenAPI)
              </a>
            </p>
            <label className="block">
              <span className="font-medium">Dirección del webhook</span>
              <Input className="mt-1" required type="url" placeholder="https://hook.eu1.make.com/…" value={hookUrl} maxLength={500} onChange={(e) => setHookUrl(e.target.value)} />
            </label>
            <Button type="submit" className="w-full" variant="primary" loading={busy === "connect"}>
              <Link2 className="size-4" aria-hidden /> Conectar webhook
            </Button>
          </form>
        )}
        {!canManage && !connected && <p className="text-mute">Pide a una persona con rol Propietario o Administración que conecte {label}.</p>}
        {canManage && connected && (
          <button
            type="button"
            className="inline-flex items-center gap-1 text-xs text-danger hover:underline"
            onClick={() => window.confirm(`¿Desconectar ${label}? Borramos la clave guardada. Lo ya publicado no se toca.`) && void run("disconnect", () => del(`/orgs/${orgId}/cms/${tab}`), `${label} desconectado.`)}
          >
            <Unlink className="size-3" aria-hidden /> Desconectar
          </button>
        )}
      </div>
    </Card>
  );
}
