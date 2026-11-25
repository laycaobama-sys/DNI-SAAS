import { useState, type FormEvent } from "react";
import { Download, Globe, Link2, Undo2, Unlink, Wrench } from "lucide-react";
import { can, CMS_STATE_LABEL, isRole, WP_FIX_FIELDS, WP_FIX_LABEL, WP_PUBLISHABLE_KINDS, type CmsPublicationState, type WpFixField } from "@dni/core";
import { ApiError, del, fmtDate, post } from "../lib/api";
import { useAuth } from "../lib/auth";
import { useApi } from "../lib/hooks";
import { Badge, Button, Card, ErrorState, Input, Notice, Select, Spinner, Textarea } from "../ui";

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

/* ── «DNI Growth Connector»: plugin status, reversible technical fixes and llms.txt ───────────────── */

interface PluginInfo {
  latest: { version: string; download: string };
  installed: { version: string; seoPlugin: string | null; llmsTxt: boolean; canLlmsTxt: boolean } | null;
  connected: boolean;
  outdated?: boolean;
}
interface Fix {
  id: string;
  field: string;
  label: string;
  url: string | null;
  attachmentId: number | null;
  before: string | null;
  after: string;
  state: "applying" | "applied" | "failed" | "reverted";
  error: string | null;
  createdAt: string;
  revertedAt: string | null;
}
const FIX_STATE: Record<Fix["state"], { label: string; tone: "ok" | "danger" | "info" | "neutral" }> = {
  applied: { label: "Aplicada", tone: "ok" },
  reverted: { label: "Deshecha", tone: "neutral" },
  failed: { label: "No se aplicó", tone: "danger" },
  applying: { label: "Aplicando", tone: "info" },
};
const SEO_PLUGIN: Record<string, string> = { yoast: "Yoast SEO", "rank-math": "Rank Math" };
const FIELD_HINT: Record<WpFixField, string> = {
  title: "Hasta 60 caracteres. Sustituye el título que ve Google para esa página.",
  description: "Entre 120 y 160 caracteres. El texto que aparece bajo el título en Google.",
  canonical: "La dirección https buena de esa página, si hay copias con otra URL.",
  jsonld: "Un objeto JSON de schema.org (por ejemplo LocalBusiness o FAQPage).",
  alt: "Describe la imagen en pocas palabras para personas que no la ven y para buscadores.",
  llms: "",
};
const clip = (s: string | null, n = 90) => (!s ? "(vacío)" : s.length > n ? `${s.slice(0, n)}…` : s);

/** Panel on Integraciones: download the plugin, see whether it is active, apply and undo fixes. */
export function WordPressPluginPanel({ orgId }: { orgId: string }) {
  const { me } = useAuth();
  const role = me?.memberships.find((m) => m.id === orgId)?.role ?? "";
  const r = isRole(role) ? role : null;
  const canApprove = !!r && can(r, "content:approve");
  const info = useApi<PluginInfo>(`/orgs/${orgId}/cms/wordpress/plugin`);
  const fixes = useApi<{ fixes: Fix[] }>(info.data?.installed ? `/orgs/${orgId}/cms/wordpress/fixes` : null);
  const [form, setForm] = useState<{ field: (typeof WP_FIX_FIELDS)[number]; url: string; attachmentId: string; value: string }>({ field: "description", url: "", attachmentId: "", value: "" });
  const [llms, setLlms] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<ApiError | null>(null);
  const [ok, setOk] = useState<string | null>(null);

  if (info.error?.code === "plan_required")
    return (
      <Card title="Correcciones técnicas en WordPress">
        <p className="text-sm text-mute">Incluido desde el plan Starter: con el plugin «DNI Growth Connector» aplicas títulos, descripciones, datos estructurados y llms.txt en tu WordPress, y los deshaces con un clic.</p>
      </Card>
    );
  if (info.loading && !info.data) return <Spinner />;
  const d = info.data;
  const installed = d?.installed ?? null;

  const run = async (key: string, fn: () => Promise<unknown>, done: string) => {
    setBusy(key);
    setErr(null);
    setOk(null);
    try {
      await fn();
      setOk(done);
      await Promise.all([info.reload(), fixes.reload()]);
    } catch (e) {
      setErr(asErr(e));
      await fixes.reload();
    } finally {
      setBusy(null);
    }
  };

  const apply = (e: FormEvent) => {
    e.preventDefault();
    const body =
      form.field === "alt"
        ? { field: form.field, attachmentId: Number(form.attachmentId), value: form.value }
        : { field: form.field, url: form.url.trim(), value: form.value };
    const where = form.field === "alt" ? `la imagen ${form.attachmentId}` : form.url.trim();
    if (!window.confirm(`Se cambiará «${WP_FIX_LABEL[form.field]}» en ${where}. Guardamos el valor anterior para poder deshacerlo. ¿Aplicar?`)) return;
    void run(
      "fix",
      async () => {
        await post(`/orgs/${orgId}/cms/wordpress/fixes`, body);
        setForm({ ...form, value: "" });
      },
      "Corrección aplicada en tu WordPress.",
    );
  };

  const saveLlms = (e: FormEvent) => {
    e.preventDefault();
    if (!window.confirm("Se sustituirá el llms.txt de tu web. Guardamos el anterior para poder deshacerlo. ¿Guardar?")) return;
    void run(
      "llms",
      async () => {
        await post(`/orgs/${orgId}/cms/wordpress/llms`, { content: llms });
        setLlms("");
      },
      "llms.txt actualizado en tu WordPress.",
    );
  };

  return (
    <Card
      title="Correcciones técnicas en WordPress"
      subtitle="Plugin «DNI Growth Connector»: aplica cambios de SEO técnico en tu web con tu aprobación, y deshazlos con un clic."
      actions={
        <a href={d?.latest.download ?? "/descargas/dni-growth-connector.zip"} className="inline-flex items-center gap-1 text-sm font-semibold text-accent-text hover:underline" download>
          <Download className="size-4" aria-hidden /> Descargar plugin {d?.latest.version ? `v${d.latest.version}` : ""}
        </a>
      }
    >
      <div className="space-y-4 text-sm">
        {err && <Notice tone="warn" title="No se pudo completar">{err.message}</Notice>}
        {ok && <Notice tone="ok">{ok}</Notice>}
        <ErrorState error={info.error && info.error.code !== "plan_required" ? info.error : null} onRetry={info.reload} />

        {d && !d.connected && <p className="text-mute">Primero conecta tu WordPress desde cualquier contenido aprobado («Publicar en WordPress»). Después instala el plugin.</p>}
        {d?.connected && !installed && (
          <ol className="list-decimal space-y-1 pl-5 text-mute">
            <li>Descarga el plugin con el enlace de arriba (es un archivo .zip).</li>
            <li>En tu WordPress: <strong>Plugins → Añadir nuevo → Subir plugin</strong>, elige el .zip y pulsa «Instalar ahora».</li>
            <li>Pulsa «Activar» y vuelve aquí: lo detectamos solo.</li>
          </ol>
        )}
        {installed && (
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone="ok">Plugin activo · v{installed.version}</Badge>
            {installed.seoPlugin && <Badge tone="info">Sincroniza con {SEO_PLUGIN[installed.seoPlugin] ?? installed.seoPlugin}</Badge>}
            {d?.outdated && <Badge tone="warn">Hay una versión nueva: descárgala y súbela de nuevo</Badge>}
          </div>
        )}

        {installed && canApprove && (
          <form className="space-y-2 rounded-xl border border-line p-3" onSubmit={apply}>
            <p className="font-medium">Aplicar una corrección</p>
            <label className="block">
              <span className="text-xs text-mute">Qué cambiar</span>
              <Select className="mt-1" value={form.field} onChange={(e) => setForm({ ...form, field: e.target.value as (typeof WP_FIX_FIELDS)[number] })}>
                {WP_FIX_FIELDS.map((f) => (
                  <option key={f} value={f}>
                    {WP_FIX_LABEL[f]}
                  </option>
                ))}
              </Select>
            </label>
            {form.field === "alt" ? (
              <label className="block">
                <span className="text-xs text-mute">Número de la imagen (en WordPress: Medios → abre la imagen → el número que sale en la dirección «item=»)</span>
                <Input className="mt-1" required inputMode="numeric" pattern="[0-9]+" value={form.attachmentId} onChange={(e) => setForm({ ...form, attachmentId: e.target.value })} />
              </label>
            ) : (
              <label className="block">
                <span className="text-xs text-mute">Página o entrada de tu web</span>
                <Input className="mt-1" required type="url" placeholder="https://tuweb.com/servicios/" maxLength={2000} value={form.url} onChange={(e) => setForm({ ...form, url: e.target.value })} />
              </label>
            )}
            <label className="block">
              <span className="text-xs text-mute">Nuevo valor · {FIELD_HINT[form.field]}</span>
              {form.field === "jsonld" ? (
                <Textarea className="mt-1 font-mono text-xs" required value={form.value} maxLength={20000} onChange={(e) => setForm({ ...form, value: e.target.value })} />
              ) : (
                <Input className="mt-1" required value={form.value} maxLength={form.field === "description" ? 320 : 2000} onChange={(e) => setForm({ ...form, value: e.target.value })} />
              )}
            </label>
            <Button type="submit" variant="primary" loading={busy === "fix"} disabled={!!busy}>
              <Wrench className="size-4" aria-hidden /> Aplicar en WordPress
            </Button>
          </form>
        )}

        {installed && canApprove && (
          <form className="space-y-2 rounded-xl border border-line p-3" onSubmit={saveLlms}>
            <p className="font-medium">llms.txt de tu web</p>
            {installed.canLlmsTxt ? (
              <>
                <p className="text-xs text-mute">Un resumen en texto para asistentes de IA, servido en /llms.txt. {installed.llmsTxt ? "Tu web ya tiene uno: lo sustituirás." : "Ahora mismo tu web no tiene."}</p>
                <Textarea className="font-mono text-xs" required minLength={10} maxLength={100000} placeholder={"# Nombre de tu empresa\n\n> Qué haces, para quién y dónde."} value={llms} onChange={(e) => setLlms(e.target.value)} />
                <Button type="submit" loading={busy === "llms"} disabled={!!busy}>
                  Guardar llms.txt
                </Button>
              </>
            ) : (
              <p className="text-xs text-mute">Para cambiar llms.txt, el usuario de WordPress conectado debe ser Administrador.</p>
            )}
          </form>
        )}
        {installed && !canApprove && <p className="text-mute">Solo propietario, administración o marketing pueden aplicar o deshacer correcciones.</p>}

        {installed && (fixes.data?.fixes.length ?? 0) > 0 && (
          <div>
            <p className="mb-2 font-medium">Historial</p>
            <ul className="divide-y divide-line rounded-xl border border-line">
              {fixes.data!.fixes.map((f) => (
                <li key={f.id} className="space-y-1 p-3">
                  <p className="flex flex-wrap items-center gap-2">
                    <Badge tone={FIX_STATE[f.state].tone}>{FIX_STATE[f.state].label}</Badge>
                    <span className="font-medium">{f.label}</span>
                    <span className="text-xs text-mute">{fmtDate(f.createdAt)}</span>
                  </p>
                  {f.url && <p className="break-all text-xs text-mute">{f.url.replace(/^https?:\/\//, "")}</p>}
                  {f.attachmentId && <p className="text-xs text-mute">Imagen {f.attachmentId}</p>}
                  {f.state !== "failed" && (
                    <p className="break-words text-xs">
                      <span className="text-mute">Antes:</span> {clip(f.before)} <span className="text-mute">→ Ahora:</span> {clip(f.after)}
                    </p>
                  )}
                  {f.state === "failed" && <p className="text-xs text-danger">WordPress no aceptó el cambio ({f.error ?? "error"}).</p>}
                  {f.state === "applied" && canApprove && (
                    <Button
                      variant="ghost"
                      loading={busy === f.id}
                      disabled={!!busy}
                      onClick={() => window.confirm("¿Deshacer? Se restaura el valor anterior en tu WordPress.") && void run(f.id, () => post(`/orgs/${orgId}/cms/wordpress/fixes/${f.id}/revert`), "Corrección deshecha.")}
                    >
                      <Undo2 className="size-4" aria-hidden /> Deshacer
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </Card>
  );
}
