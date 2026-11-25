import { useMemo, useState } from "react";
import { useParams, useSearchParams } from "react-router";
import { can, FB_MESSAGE_MAX, IG_CAPTION_MAX, IG_HASHTAGS_MAX, isRole, SOCIAL_NETWORK_LABEL, SOCIAL_STATUS_LABEL, type SocialNetwork, type SocialPostStatus } from "@dni/core";
import { ApiError, del, fmtDate, post, put } from "../lib/api";
import { useAuth } from "../lib/auth";
import { useApi } from "../lib/hooks";
import { Badge, Button, Card, EmptyState, ErrorState, Field, Input, Notice, PageHeader, Select, Spinner, Textarea, UpgradeLink } from "../ui";

interface Account {
  id: string;
  network: SocialNetwork;
  name: string;
  username: string | null;
  status: string;
}
interface PostItem {
  id: string;
  accountId: string;
  caption: string;
  link: string | null;
  mediaId: string | null;
  mediaUrl: string | null;
  status: SocialPostStatus;
  scheduledAt: string | null;
  reviewNote: string | null;
  externalUrl: string | null;
  lastError: string | null;
  publishedAt: string | null;
  version: number;
  createdAt: string;
}
interface Data {
  configured: boolean;
  connection: { status: string; connectedAt: string; lastSyncAt: string | null; lastError: string | null } | null;
  accounts: Account[];
  posts: PostItem[];
}

const ERRORS: Record<string, string> = {
  meta_denied: "Has cancelado la conexión en Facebook o no diste permiso.",
  scope_not_granted: "Facebook no concedió el permiso para publicar. Vuelve a conectar y deja marcadas las páginas y los permisos.",
  state_mismatch: "La conexión caducó o se abrió en otra pestaña. Inténtalo de nuevo.",
  state_expired: "La conexión caducó (10 minutos). Inténtalo de nuevo.",
  session_mismatch: "Inicia sesión con la misma cuenta que empezó la conexión.",
  forbidden: "Tu rol no permite gestionar integraciones.",
  not_configured: "La conexión con Facebook e Instagram aún no está activa en DNI Growth.",
};
const errorText = (code: string) => ERRORS[code] ?? (code.startsWith("accounts_") ? "Conectado, pero Facebook no devolvió tus páginas. Pulsa «Actualizar cuentas»." : `No se pudo conectar (${code}).`);

const TONE: Record<SocialPostStatus, "ok" | "warn" | "danger" | "neutral" | "info"> = {
  draft: "neutral",
  pending_approval: "warn",
  approved: "info",
  publishing: "info",
  published: "ok",
  failed: "danger",
  cancelled: "neutral",
};

const emptyForm = { accountId: "", caption: "", link: "", mediaId: "", scheduledAt: "" };
/** datetime-local (local time) → ISO with offset; empty = as soon as it is approved. */
const toIso = (v: string) => (v ? new Date(v).toISOString() : null);

export function SocialPage() {
  const { orgId = "" } = useParams();
  const [params] = useSearchParams();
  const { me } = useAuth();
  const role = me?.memberships.find((m) => m.id === orgId)?.role ?? "";
  const r = isRole(role) ? role : null;
  const canWrite = !!r && can(r, "content:write");
  const canApprove = !!r && can(r, "content:approve");
  const canManage = !!r && can(r, "integrations:manage");
  const { data, error, loading, reload } = useApi<Data>(`/orgs/${orgId}/social`, { pollMs: 15000, pollWhile: (d) => d.posts.some((p) => p.status === "approved" || p.status === "publishing") });
  const media = useApi<{ uploads: Array<{ id: string; kind: string; content_type: string; name: string; url: string }> }>(`/orgs/${orgId}/media`);
  const [form, setForm] = useState(emptyForm);
  const [editing, setEditing] = useState<PostItem | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<ApiError | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const [confirmOff, setConfirmOff] = useState(false);

  const accounts = useMemo(() => (data?.accounts ?? []).filter((a) => a.status === "active"), [data]);
  const account = accounts.find((a) => a.id === form.accountId) ?? null;
  const images = (media.data?.uploads ?? []).filter((u) => u.kind === "image");
  const run = async (key: string, fn: () => Promise<unknown>, done?: string) => {
    setErr(null);
    setOk(null);
    setBusy(key);
    try {
      await fn();
      if (done) setOk(done);
      await reload();
    } catch (e) {
      setErr(e as ApiError);
    } finally {
      setBusy(null);
    }
  };

  if (loading && !data) return <Spinner />;
  if (error) return error.code === "plan_required" ? <UpgradeLink error={error} /> : <ErrorState error={error} onRetry={reload} />;
  if (!data) return null;

  const conn = data.connection;
  const connected = !!conn && (conn.status === "connected" || conn.status === "paused");
  const metaError = params.get("meta_error");
  const hashtags = (form.caption.match(/(^|\s)#[\p{L}\p{N}_]+/gu) ?? []).length;
  const max = account?.network === "instagram" ? IG_CAPTION_MAX : FB_MESSAGE_MAX;

  const connect = () =>
    run("connect", async () => {
      const res = await post<{ url: string }>(`/orgs/${orgId}/social/connect`);
      if (res.url.startsWith("https://www.facebook.com/")) window.location.assign(res.url);
    });
  const save = () =>
    run(
      "save",
      async () => {
        const body = { accountId: form.accountId, caption: form.caption, link: form.link || "", mediaId: form.mediaId || null, scheduledAt: toIso(form.scheduledAt) };
        if (editing) await put(`/orgs/${orgId}/social/posts/${editing.id}`, { ...body, expectedVersion: editing.version });
        else await post(`/orgs/${orgId}/social/posts`, body);
        setForm({ ...emptyForm, accountId: form.accountId });
        setEditing(null);
      },
      "Borrador guardado. Envíalo a aprobación cuando esté listo.",
    );
  const edit = (p: PostItem) => {
    setEditing(p);
    setForm({ accountId: p.accountId, caption: p.caption, link: p.link ?? "", mediaId: p.mediaId ?? "", scheduledAt: p.scheduledAt ? new Date(new Date(p.scheduledAt).getTime() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 16) : "" });
    window.scrollTo({ top: 0, behavior: "smooth" });
  };
  const accName = (id: string) => {
    const a = data.accounts.find((x) => x.id === id);
    return a ? `${SOCIAL_NETWORK_LABEL[a.network]} · ${a.username ? `@${a.username}` : a.name}` : "Cuenta";
  };

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Creatividad"
        title="Redes sociales"
        subtitle="Prepara publicaciones para tu página de Facebook y tu cuenta profesional de Instagram. Nada se publica sin que una persona con permiso lo apruebe."
      />
      {metaError ? <Notice tone="warn" title="No se completó la conexión">{errorText(metaError)}</Notice> : null}
      {params.get("meta") === "connected" && !metaError ? <Notice tone="ok" title="Conectado con Facebook">Ya puedes preparar publicaciones para las cuentas que elegiste.</Notice> : null}
      {err ? <Notice tone="warn" title="No se pudo completar">{err.message}</Notice> : null}
      {ok ? <Notice tone="ok">{ok}</Notice> : null}

      <Card
        title="Conexión con Facebook e Instagram"
        subtitle="Con Facebook Login for Business: tú eliges qué páginas y cuentas de Instagram compartes. Puedes retirar el acceso aquí o desde la configuración de Facebook."
        actions={
          canManage && data.configured ? (
            <div className="flex flex-wrap gap-2">
              <Button variant={connected ? "secondary" : "primary"} loading={busy === "connect"} onClick={connect}>
                {connected ? "Volver a conectar" : "Conectar con Facebook"}
              </Button>
              {connected ? (
                <Button loading={busy === "refresh"} onClick={() => run("refresh", () => post(`/orgs/${orgId}/social/refresh`), "Cuentas actualizadas.")}>
                  Actualizar cuentas
                </Button>
              ) : null}
            </div>
          ) : null
        }
      >
        {!data.configured ? (
          <Notice tone="info" title="Muy pronto">
            La conexión con Facebook e Instagram está construida y la estamos activando. Mientras tanto puedes preparar tus piezas en Video Studio y Creative Studio.
          </Notice>
        ) : !conn || conn.status === "disconnected" ? (
          <EmptyState title="Sin cuentas conectadas">
            Conecta tu página de Facebook. Si tu cuenta de Instagram es profesional y está vinculada a esa página, aparecerá también. Meta todavía está revisando la app de DNI Growth: hasta que la apruebe, solo pueden conectarse las cuentas autorizadas en ella.
          </EmptyState>
        ) : (
          <div className="space-y-3">
            <p className="text-sm">
              Estado:{" "}
              {conn.status === "paused" ? <Badge tone="warn">En pausa: no se publica nada</Badge> : conn.status === "reauth_required" ? <Badge tone="danger">Hay que volver a conectar</Badge> : <Badge tone="ok">Conectado</Badge>}{" "}
              · desde {fmtDate(conn.connectedAt)}
              {conn.lastSyncAt ? ` · cuentas actualizadas ${fmtDate(conn.lastSyncAt)}` : ""}
            </p>
            {data.accounts.length ? (
              <ul className="grid gap-2 sm:grid-cols-2">
                {data.accounts.map((a) => (
                  <li key={a.id} className="rounded-xl border border-line p-3 text-sm">
                    <span className="font-semibold">{a.username ? `@${a.username}` : a.name}</span>
                    <span className="block text-xs text-mute">{SOCIAL_NETWORK_LABEL[a.network]}{a.status !== "active" ? " · sin acceso" : ""}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-mute">Facebook no ha devuelto ninguna página en la que puedas publicar.</p>
            )}
            <div className="flex flex-wrap gap-2">
              {canApprove && (conn.status === "connected" || conn.status === "paused") ? (
                <Button loading={busy === "pause"} onClick={() => run("pause", () => post(`/orgs/${orgId}/social/pause`, { paused: conn.status !== "paused" }), conn.status === "paused" ? "Publicaciones reanudadas." : "Publicaciones en pausa.")}>
                  {conn.status === "paused" ? "Reanudar publicaciones" : "Pausar todas las publicaciones"}
                </Button>
              ) : null}
              {canManage ? (
                confirmOff ? (
                  <>
                    <Button variant="danger" loading={busy === "off"} onClick={() => run("off", () => del(`/orgs/${orgId}/social/connection`), "Desconectado. Las publicaciones pendientes se han cancelado.").then(() => setConfirmOff(false))}>
                      Sí, desconectar
                    </Button>
                    <Button onClick={() => setConfirmOff(false)}>No</Button>
                  </>
                ) : (
                  <Button variant="ghost" onClick={() => setConfirmOff(true)}>
                    Desconectar
                  </Button>
                )
              ) : null}
            </div>
          </div>
        )}
      </Card>

      {canWrite && accounts.length ? (
        <Card title={editing ? "Editar publicación" : "Nueva publicación"} subtitle="Se guarda como borrador. Después la envías a aprobación y, una vez aprobada, se publica sola a la hora elegida.">
          <div className="grid gap-4">
            <Field label="Cuenta" htmlFor="soc-acc">
              <Select id="soc-acc" value={form.accountId} onChange={(e) => setForm({ ...form, accountId: e.target.value, link: "" })}>
                <option value="">Elige una cuenta</option>
                {accounts.map((a) => (
                  <option key={a.id} value={a.id}>
                    {SOCIAL_NETWORK_LABEL[a.network]} · {a.username ? `@${a.username}` : a.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field
              label="Texto"
              htmlFor="soc-text"
              hint={`${form.caption.length}/${max} caracteres${account?.network === "instagram" ? ` · ${hashtags}/${IG_HASHTAGS_MAX} hashtags` : ""}`}
              error={form.caption.length > max ? "Demasiado largo para esta red." : undefined}
            >
              <Textarea id="soc-text" rows={6} value={form.caption} onChange={(e) => setForm({ ...form, caption: e.target.value })} />
            </Field>
            {account?.network === "facebook" ? (
              <Field label="Enlace (opcional)" htmlFor="soc-link" hint="Facebook muestra la vista previa del enlace. No se puede combinar con imagen.">
                <Input id="soc-link" type="url" placeholder="https://" value={form.link} onChange={(e) => setForm({ ...form, link: e.target.value })} />
              </Field>
            ) : null}
            <Field label={account?.network === "instagram" ? "Imagen (obligatoria, JPG)" : "Imagen (opcional)"} htmlFor="soc-img" hint="Sube imágenes en Video Studio › Biblioteca. Instagram pide JPG con proporción entre 4:5 y 1,91:1.">
              <Select id="soc-img" value={form.mediaId} onChange={(e) => setForm({ ...form, mediaId: e.target.value })}>
                <option value="">Sin imagen</option>
                {images.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name} ({m.content_type.replace("image/", "").toUpperCase()})
                  </option>
                ))}
              </Select>
            </Field>
            {form.mediaId ? <img src={images.find((m) => m.id === form.mediaId)?.url} alt="Vista previa de la imagen elegida" className="max-h-56 w-auto rounded-xl border border-line" /> : null}
            <Field label="Fecha y hora (opcional)" htmlFor="soc-when" hint="Vacío: se publica en cuanto se apruebe. Máximo 75 días.">
              <Input id="soc-when" type="datetime-local" value={form.scheduledAt} onChange={(e) => setForm({ ...form, scheduledAt: e.target.value })} />
            </Field>
            <div className="flex flex-wrap gap-2">
              <Button variant="primary" loading={busy === "save"} disabled={!form.accountId || form.caption.length > max} onClick={save}>
                {editing ? "Guardar cambios" : "Guardar borrador"}
              </Button>
              {editing ? (
                <Button
                  onClick={() => {
                    setEditing(null);
                    setForm(emptyForm);
                  }}
                >
                  Cancelar edición
                </Button>
              ) : null}
            </div>
          </div>
        </Card>
      ) : null}

      <Card title="Publicaciones" subtitle="Cada paso queda en el registro de auditoría: quién la escribió, quién la aprobó y cuándo se publicó.">
        {!data.posts.length ? (
          <p className="text-sm text-mute">Todavía no hay publicaciones.</p>
        ) : (
          <ul className="divide-y divide-line">
            {data.posts.map((p) => (
              <li key={p.id} className="flex flex-col gap-2 py-4 sm:flex-row sm:items-start sm:justify-between">
                <div className="min-w-0 space-y-1">
                  <p className="text-xs text-mute">
                    {accName(p.accountId)} · {p.publishedAt ? `publicada ${fmtDate(p.publishedAt)}` : p.scheduledAt ? `programada ${fmtDate(p.scheduledAt)}` : `creada ${fmtDate(p.createdAt)}`}
                  </p>
                  <p className="line-clamp-3 whitespace-pre-line text-sm">{p.caption || p.link || "(solo imagen)"}</p>
                  <Badge tone={TONE[p.status]}>{SOCIAL_STATUS_LABEL[p.status]}</Badge>
                  {p.lastError ? <p className="text-xs text-danger">{p.lastError}</p> : null}
                  {p.reviewNote ? <p className="text-xs text-mute">Nota de revisión: {p.reviewNote}</p> : null}
                  {p.externalUrl ? (
                    <a className="text-xs underline" href={p.externalUrl} target="_blank" rel="noopener noreferrer">
                      Ver publicación
                    </a>
                  ) : null}
                </div>
                <div className="flex shrink-0 flex-wrap gap-2">
                  {canWrite && ["draft", "failed", "cancelled"].includes(p.status) ? <Button onClick={() => edit(p)}>Editar</Button> : null}
                  {canWrite && p.status === "draft" ? (
                    <Button variant="primary" loading={busy === `sub${p.id}`} onClick={() => run(`sub${p.id}`, () => post(`/orgs/${orgId}/social/posts/${p.id}/submit`), "Enviada a aprobación.")}>
                      Enviar a aprobación
                    </Button>
                  ) : null}
                  {canApprove && p.status === "pending_approval" ? (
                    <>
                      <Button variant="primary" loading={busy === `ok${p.id}`} onClick={() => run(`ok${p.id}`, () => post(`/orgs/${orgId}/social/posts/${p.id}/review`, { decision: "approve", expectedVersion: p.version }), "Aprobada: se publicará a su hora.")}>
                        Aprobar
                      </Button>
                      <Button loading={busy === `no${p.id}`} onClick={() => run(`no${p.id}`, () => post(`/orgs/${orgId}/social/posts/${p.id}/review`, { decision: "reject", expectedVersion: p.version }), "Devuelta a borrador.")}>
                        Rechazar
                      </Button>
                    </>
                  ) : null}
                  {canWrite && ["draft", "pending_approval", "approved"].includes(p.status) ? (
                    <Button variant="ghost" loading={busy === `can${p.id}`} onClick={() => run(`can${p.id}`, () => post(`/orgs/${orgId}/social/posts/${p.id}/cancel`), "Cancelada.")}>
                      Cancelar
                    </Button>
                  ) : null}
                  {canWrite && ["draft", "failed", "cancelled"].includes(p.status) ? (
                    <Button variant="ghost" loading={busy === `del${p.id}`} onClick={() => run(`del${p.id}`, () => del(`/orgs/${orgId}/social/posts/${p.id}`), "Borrada.")}>
                      Borrar
                    </Button>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
