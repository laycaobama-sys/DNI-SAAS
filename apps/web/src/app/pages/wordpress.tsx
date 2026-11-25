import { useState, type FormEvent } from "react";
import { Globe, Link2, Unlink } from "lucide-react";
import { can, CMS_STATE_LABEL, isRole, WP_PUBLISHABLE_KINDS, type CmsPublicationState } from "@dni/core";
import { ApiError, del, fmtDate, post } from "../lib/api";
import { useAuth } from "../lib/auth";
import { useApi } from "../lib/hooks";
import { Badge, Button, Card, Input, Notice } from "../ui";

interface Conn {
  status: "connected" | "reauth_required" | "disconnected" | string;
  site: string | null;
  connectedAt: string;
  lastError: string | null;
}
interface Pub {
  state: CmsPublicationState;
  url: string | null;
  postId: string | null;
  contentVersion: number | null;
  lastError: string | null;
  publishedAt: string | null;
  updatedAt: string;
}

const asErr = (e: unknown) => (e instanceof ApiError ? e : new ApiError(0, "unknown", "Error inesperado."));

/**
 * «Publicar en WordPress» card on a content item. Connecting needs integrations:manage; sending needs
 * content:approve and an approved item. The password is sent once to our API and never shown again.
 */
export function WordPressCard({ orgId, contentId, kind, status, version }: { orgId: string; contentId: string; kind: string; status: string; version: number }) {
  const { me } = useAuth();
  const role = me?.memberships.find((m) => m.id === orgId)?.role ?? "";
  const r = isRole(role) ? role : null;
  const canManage = !!r && can(r, "integrations:manage");
  const canApprove = !!r && can(r, "content:approve");
  const res = useApi<{ wordpress: Conn | null; publication: Pub | null }>(`/orgs/${orgId}/content/${contentId}/wordpress`);
  const [form, setForm] = useState({ siteUrl: "", username: "", appPassword: "" });
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<ApiError | null>(null);
  const [ok, setOk] = useState<string | null>(null);

  if (!(WP_PUBLISHABLE_KINDS as readonly string[]).includes(kind)) return null;
  if (res.error?.code === "plan_required")
    return (
      <Card title="Publicar en WordPress">
        <p className="text-sm text-mute">Incluido desde el plan Starter: conecta tu WordPress y publica lo aprobado sin copiar y pegar.</p>
      </Card>
    );
  if (res.loading || !res.data) return null;
  const conn = res.data.wordpress;
  const pub = res.data.publication;
  const connected = conn?.status === "connected";

  const run = async (key: string, fn: () => Promise<unknown>, done?: string) => {
    setBusy(key);
    setErr(null);
    setOk(null);
    try {
      await fn();
      if (done) setOk(done);
      await res.reload();
    } catch (e) {
      setErr(asErr(e));
      await res.reload();
    } finally {
      setBusy(null);
    }
  };

  const connect = (e: FormEvent) => {
    e.preventDefault();
    void run(
      "connect",
      async () => {
        await post(`/orgs/${orgId}/cms/wordpress`, form);
        setForm({ siteUrl: "", username: "", appPassword: "" });
        setOpen(false);
      },
      "WordPress conectado.",
    );
  };

  const send = (wpStatus: "draft" | "publish") => {
    const msg =
      wpStatus === "publish"
        ? `Se publicará en ${conn?.site ?? "tu WordPress"}, visible para cualquiera y para los buscadores. ¿Publicar?`
        : `Se guardará como borrador en ${conn?.site ?? "tu WordPress"} para que lo revises allí. ¿Enviar?`;
    if (!window.confirm(msg)) return;
    void run(wpStatus, () => post(`/orgs/${orgId}/content/${contentId}/wordpress`, { status: wpStatus }), wpStatus === "publish" ? "Publicado en WordPress." : "Guardado como borrador en WordPress.");
  };

  return (
    <Card title="Publicar en WordPress" subtitle={connected ? conn?.site ?? undefined : "Conecta tu web con una contraseña de aplicación de WordPress."}>
      <div className="space-y-3 text-sm">
        {err && <Notice tone="warn" title="No se pudo completar">{err.message}</Notice>}
        {ok && <Notice tone="ok">{ok}</Notice>}
        {conn?.status === "reauth_required" && <Notice tone="warn" title="Hay que volver a conectar">WordPress ya no acepta la contraseña de aplicación guardada (se revocó o cambió el usuario).</Notice>}

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
            {pub.contentVersion !== null && pub.contentVersion !== version && pub.state !== "failed" && <p className="mt-1 text-xs text-warn">WordPress tiene la versión {pub.contentVersion}; la actual es la {version}.</p>}
            {pub.state === "failed" && pub.lastError && <p className="mt-1 text-xs text-danger">{pub.lastError}</p>}
          </div>
        )}

        {connected && status === "approved" && canApprove && (
          <div className="space-y-2">
            <Button className="w-full" variant="primary" loading={busy === "publish"} disabled={!!busy} onClick={() => send("publish")}>
              <Globe className="size-4" aria-hidden /> {pub?.postId ? "Actualizar y publicar" : "Publicar ahora"}
            </Button>
            <Button className="w-full" loading={busy === "draft"} disabled={!!busy} onClick={() => send("draft")}>
              Enviar como borrador
            </Button>
            {pub?.postId && pub.state === "published" && (
              <Button
                className="w-full"
                variant="ghost"
                loading={busy === "unpublish"}
                disabled={!!busy}
                onClick={() => window.confirm("¿Retirar la entrada? Pasará a borrador en tu WordPress (no se borra).") && void run("unpublish", () => post(`/orgs/${orgId}/content/${contentId}/wordpress/unpublish`), "Retirada: ahora es un borrador en WordPress.")}
              >
                Retirar (pasar a borrador)
              </Button>
            )}
          </div>
        )}
        {connected && status !== "approved" && <p className="text-mute">Apruébalo primero: solo se envía a WordPress contenido aprobado por una persona.</p>}
        {connected && status === "approved" && !canApprove && <p className="text-mute">Solo propietario, administración o marketing pueden publicar.</p>}

        {canManage && (!connected || open) && (
          <form className="space-y-2" onSubmit={connect}>
            <p className="text-xs text-mute">
              En tu WordPress ve a <strong>Usuarios → Perfil → Contraseñas de aplicación</strong>, escribe «DNI Growth» y pulsa «Añadir». Copia aquí la contraseña que aparece (no es la de entrar a WordPress). Puedes revocarla allí cuando quieras.
            </p>
            <label className="block">
              <span className="font-medium">Dirección de tu web</span>
              <Input className="mt-1" required placeholder="https://tuweb.com" value={form.siteUrl} maxLength={300} onChange={(e) => setForm({ ...form, siteUrl: e.target.value })} />
            </label>
            <label className="block">
              <span className="font-medium">Usuario de WordPress</span>
              <Input className="mt-1" required autoComplete="off" value={form.username} maxLength={60} onChange={(e) => setForm({ ...form, username: e.target.value })} />
            </label>
            <label className="block">
              <span className="font-medium">Contraseña de aplicación</span>
              <Input className="mt-1" required type="password" autoComplete="new-password" placeholder="xxxx xxxx xxxx xxxx xxxx xxxx" value={form.appPassword} maxLength={40} onChange={(e) => setForm({ ...form, appPassword: e.target.value })} />
            </label>
            <Button type="submit" className="w-full" variant="primary" loading={busy === "connect"}>
              <Link2 className="size-4" aria-hidden /> {conn ? "Volver a conectar" : "Conectar WordPress"}
            </Button>
          </form>
        )}
        {!canManage && !connected && <p className="text-mute">Pide a una persona con rol Propietario o Administración que conecte el WordPress de la empresa.</p>}
        {canManage && connected && !open && (
          <div className="flex flex-wrap gap-3 text-xs">
            <button type="button" className="text-accent-text hover:underline" onClick={() => setOpen(true)}>
              Cambiar conexión
            </button>
            <button
              type="button"
              className="inline-flex items-center gap-1 text-danger hover:underline"
              onClick={() => window.confirm("¿Desconectar WordPress? Borramos la contraseña de aplicación e intentamos revocarla en tu web. Las entradas publicadas no se tocan.") && void run("disconnect", () => del(`/orgs/${orgId}/cms/wordpress`), "WordPress desconectado.")}
            >
              <Unlink className="size-3" aria-hidden /> Desconectar
            </button>
          </div>
        )}
      </div>
    </Card>
  );
}
