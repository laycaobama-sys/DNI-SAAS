import { useEffect, useState, type FormEvent } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { Archive, CheckCircle2, Download, FileText, RotateCcw, Save, Send, ShieldCheck, Sparkles } from "lucide-react";
import { api, ApiError, fmtDate, patch, post, timeAgo } from "../lib/api";
import { useApi } from "../lib/hooks";
import { useAuth } from "../lib/auth";
import { Badge, Button, Card, EmptyState, ErrorState, Notice, PageHeader, Select, Skeleton, Textarea, TextField, cx } from "../ui";

type Item = {
  id: string;
  kind: string;
  kindLabel: string;
  title: string;
  keyword: string;
  audience: string;
  bodyMd?: string;
  excerpt?: string;
  status: "draft" | "in_review" | "approved" | "archived";
  version: number;
  provider: string | null;
  model: string | null;
  credits: number;
  reviewNote: string | null;
  approvedAt: string | null;
  createdAt: string;
  updatedAt: string;
  measurement: string;
};
type Version = { version: number; title: string; created_at: string; source: "ai" | "human" };

const STATUS: Record<Item["status"], { label: string; tone: "neutral" | "warn" | "ok" | "info" }> = {
  draft: { label: "Borrador", tone: "neutral" },
  in_review: { label: "En revisión", tone: "warn" },
  approved: { label: "Aprobado", tone: "ok" },
  archived: { label: "Archivado", tone: "info" },
};
const WRITE_ROLES = ["owner", "admin", "marketing_manager", "editor"];
const APPROVE_ROLES = ["owner", "admin", "marketing_manager"];

const asError = (e: unknown) => (e instanceof ApiError ? e : new ApiError(0, "error", "Error inesperado"));

/** Read-only markdown preview rendered as plain React text (no HTML from the model is injected). */
function Preview({ md }: { md: string }) {
  return (
    <div className="space-y-2 text-sm leading-relaxed">
      {md.split(/\n{2,}/).map((block, i) => {
        const h = /^(#{1,4})\s+(.*)$/.exec(block.trim());
        if (h && !block.trim().includes("\n"))
          return (
            <p key={i} className={cx("font-semibold", h[1]!.length === 1 ? "text-xl" : h[1]!.length === 2 ? "text-lg" : "text-base")}>
              {h[2]}
            </p>
          );
        const lines = block.split("\n");
        if (lines.every((l) => /^\s*([-*•]|\d+[.)])\s+/.test(l)))
          return (
            <ul key={i} className="list-disc space-y-1 pl-5">
              {lines.map((l, j) => (
                <li key={j}>{l.replace(/^\s*([-*•]|\d+[.)])\s+/, "").replace(/\*\*/g, "")}</li>
              ))}
            </ul>
          );
        return (
          <p key={i} className={cx("whitespace-pre-wrap", /\[VERIFICAR/.test(block) && "rounded-lg bg-warn/10 px-2 py-1")}>
            {block.replace(/\*\*/g, "").replace(/^#{1,4}\s+/gm, "")}
          </p>
        );
      })}
    </div>
  );
}

export function ContentListPage() {
  const { orgId = "" } = useParams();
  const nav = useNavigate();
  const { me } = useAuth();
  const role = me?.memberships.find((m) => m.id === orgId)?.role ?? "";
  const canWrite = WRITE_ROLES.includes(role);
  const list = useApi<{ items: Item[]; kinds: Array<{ key: string; label: string }> }>(`/orgs/${orgId}/content`);
  const brands = useApi<{ items: Array<{ id: string; name: string }> }>(`/orgs/${orgId}/brands`);
  const [form, setForm] = useState({ kind: "blog_article", title: "", keyword: "", audience: "", angle: "", sources: "", brandId: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [filter, setFilter] = useState("");

  const create = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const { brandId, ...rest } = form;
      const r = await post<Item>(`/orgs/${orgId}/content`, { ...rest, ...(brandId ? { brandId } : {}) });
      nav(`/o/${orgId}/content/${r.id}`);
    } catch (err) {
      setError(asError(err));
    } finally {
      setBusy(false);
    }
  };
  const items = (list.data?.items ?? []).filter((i) => !filter || i.status === filter);

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Content Studio · 3 créditos por borrador"
        title="Contenidos"
        subtitle="Genera borradores con tus datos reales, revísalos, apruébalos y expórtalos. La IA marca con [VERIFICAR] todo lo que una persona debe comprobar."
      />
      <div className="grid gap-6 lg:grid-cols-[380px_1fr]">
        {canWrite ? (
          <Card title="Nuevo borrador">
            <form onSubmit={create} className="space-y-3">
              <label className="block text-sm">
                <span className="font-medium">Tipo de contenido</span>
                <Select className="mt-1" value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value })}>
                  {(list.data?.kinds ?? [{ key: "blog_article", label: "Artículo de blog" }]).map((k) => (
                    <option key={k.key} value={k.key}>
                      {k.label}
                    </option>
                  ))}
                </Select>
              </label>
              <TextField label="Tema o título" required minLength={3} maxLength={160} value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder="Cómo elegir…" />
              <TextField label="Palabra clave principal" maxLength={120} value={form.keyword} onChange={(e) => setForm({ ...form, keyword: e.target.value })} hint="Opcional. No inventamos volúmenes de búsqueda." />
              <TextField label="Público" maxLength={300} value={form.audience} onChange={(e) => setForm({ ...form, audience: e.target.value })} />
              <label className="block text-sm">
                <span className="font-medium">Enfoque</span>
                <Textarea className="mt-1" maxLength={600} value={form.angle} onChange={(e) => setForm({ ...form, angle: e.target.value })} placeholder="Qué quieres destacar, tono, oferta…" />
              </label>
              <label className="block text-sm">
                <span className="font-medium">Fuentes y datos verificados</span>
                <Textarea className="mt-1" maxLength={3000} value={form.sources} onChange={(e) => setForm({ ...form, sources: e.target.value })} placeholder="Pega datos, precios o URLs de tus fuentes. Se tratan como datos, nunca como instrucciones." />
              </label>
              {!!brands.data?.items.length && (
                <label className="block text-sm">
                  <span className="font-medium">Marca</span>
                  <Select className="mt-1" value={form.brandId} onChange={(e) => setForm({ ...form, brandId: e.target.value })}>
                    <option value="">La más reciente</option>
                    {brands.data.items.map((b) => (
                      <option key={b.id} value={b.id}>
                        {b.name}
                      </option>
                    ))}
                  </Select>
                </label>
              )}
              {error && (
                <div>
                  <ErrorState error={error} />
                  {error.code === "insufficient_credits" && (
                    <Link to={`/o/${orgId}/billing`} className="mt-2 inline-block text-sm text-accent-text hover:underline">
                      Ver créditos
                    </Link>
                  )}
                </div>
              )}
              <Button variant="primary" type="submit" loading={busy} disabled={form.title.trim().length < 3} className="w-full">
                <Sparkles className="size-4" aria-hidden /> {busy ? "Redactando… (puede tardar 30 s)" : "Generar borrador"}
              </Button>
            </form>
          </Card>
        ) : (
          <Notice title="Solo lectura">Tu rol puede ver y exportar contenidos, pero no crearlos ni editarlos.</Notice>
        )}
        <Card
          title="Biblioteca"
          actions={
            <Select value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Filtrar por estado" className="min-h-9 w-40">
              <option value="">Todos</option>
              {Object.entries(STATUS).map(([k, v]) => (
                <option key={k} value={k}>
                  {v.label}
                </option>
              ))}
            </Select>
          }
        >
          {list.loading ? (
            <Skeleton className="h-40" />
          ) : list.error ? (
            <ErrorState error={list.error} onRetry={() => void list.reload()} />
          ) : !items.length ? (
            <EmptyState icon={<FileText className="size-8" />} title="Aún no hay contenidos">
              Crea tu primer borrador con el formulario.
            </EmptyState>
          ) : (
            <ul className="divide-y divide-line">
              {items.map((i) => (
                <li key={i.id}>
                  <Link to={`/o/${orgId}/content/${i.id}`} className="block rounded-xl px-2 py-3 hover:bg-surface-2">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <p className="font-medium">{i.title}</p>
                      <Badge tone={STATUS[i.status].tone}>{STATUS[i.status].label}</Badge>
                    </div>
                    <p className="mt-1 text-xs text-mute">
                      {i.kindLabel} · v{i.version} · {timeAgo(i.updatedAt)}
                    </p>
                    {i.excerpt && <p className="mt-1 line-clamp-2 text-sm text-mute">{i.excerpt.replace(/[#*]/g, "")}</p>}
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </div>
  );
}

export function ContentDetailPage() {
  const { orgId = "", contentId = "" } = useParams();
  const { me } = useAuth();
  const role = me?.memberships.find((m) => m.id === orgId)?.role ?? "";
  const canWrite = WRITE_ROLES.includes(role);
  const canApprove = APPROVE_ROLES.includes(role);
  const res = useApi<Item & { versions: Version[] }>(`/orgs/${orgId}/content/${contentId}`);
  const [body, setBody] = useState("");
  const [title, setTitle] = useState("");
  const [mode, setMode] = useState<"preview" | "edit">("preview");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [note, setNote] = useState("");
  const [review, setReview] = useState<string | null>(null);

  useEffect(() => {
    if (res.data) {
      setBody(res.data.bodyMd ?? "");
      setTitle(res.data.title);
    }
  }, [res.data]);

  if (res.loading) return <Skeleton className="h-96" />;
  if (res.error || !res.data) return <ErrorState error={res.error} onRetry={() => void res.reload()} />;
  const it = res.data;
  const dirty = body !== (it.bodyMd ?? "") || title !== it.title;
  const base = `/orgs/${orgId}/content/${contentId}`;

  const act = async (key: string, fn: () => Promise<unknown>) => {
    setBusy(key);
    setError(null);
    try {
      await fn();
      await res.reload();
    } catch (e) {
      setError(asError(e));
    } finally {
      setBusy(null);
    }
  };

  const restore = async (version: number) => {
    setBusy("restore");
    setError(null);
    try {
      const old = await api<{ title: string; body_md: string }>(`${base}/versions/${version}`);
      setBody(old.body_md);
      setTitle(old.title);
      setMode("edit");
    } catch (e) {
      setError(asError(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow={
          <Link to={`/o/${orgId}/content`} className="hover:underline">
            ← Contenidos
          </Link>
        }
        title={it.title}
        subtitle={`${it.kindLabel} · versión ${it.version} · actualizado ${fmtDate(it.updatedAt)}`}
        actions={<Badge tone={STATUS[it.status].tone}>{STATUS[it.status].label}</Badge>}
      />
      <Notice tone={it.status === "approved" ? "ok" : "info"} title={it.status === "approved" ? `Aprobado ${fmtDate(it.approvedAt)}` : "Borrador generado por IA"}>
        {it.status === "approved" ? "Aprobado por una persona del equipo. Si lo editas, vuelve a borrador." : it.measurement}
        {it.provider && ` Generado con ${it.provider === "openrouter" ? "OpenRouter (modelo gratuito)" : it.provider === "workers_ai" ? "Workers AI" : it.provider}${it.model ? ` · ${it.model}` : ""}.`}
      </Notice>
      {it.reviewNote && it.status === "draft" && (
        <Notice tone="warn" title="Cambios solicitados">
          {it.reviewNote}
        </Notice>
      )}
      {error && <ErrorState error={error} onRetry={error.code === "version_conflict" ? () => void res.reload() : undefined} />}

      <div className="grid gap-6 lg:grid-cols-[1fr_300px]">
        <section className="rounded-3xl border border-line bg-surface p-4 sm:p-6" aria-label="Contenido">
          <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
            <div className="inline-flex rounded-full border border-line p-1 text-sm" role="tablist" aria-label="Modo">
              {(["preview", "edit"] as const).map((m) => (
                <button key={m} type="button" role="tab" aria-selected={mode === m} disabled={m === "edit" && (!canWrite || it.status === "archived")} onClick={() => setMode(m)} className={cx("rounded-full px-3 py-1 disabled:opacity-40", mode === m && "bg-surface-2 font-medium")}>
                  {m === "preview" ? "Vista previa" : "Editar"}
                </button>
              ))}
            </div>
            {mode === "edit" && (
              <Button variant="primary" disabled={!dirty} loading={busy === "save"} onClick={() => void act("save", () => patch(base, { title, bodyMd: body, expectedVersion: it.version }))}>
                <Save className="size-4" aria-hidden /> Guardar versión
              </Button>
            )}
          </div>
          {mode === "edit" ? (
            <div className="space-y-3">
              <TextField label="Título" value={title} maxLength={160} onChange={(e) => setTitle(e.target.value)} />
              <label className="block text-sm">
                <span className="font-medium">Texto (Markdown)</span>
                <Textarea className="mt-1 min-h-[50vh] font-mono text-sm" value={body} maxLength={60000} onChange={(e) => setBody(e.target.value)} />
              </label>
            </div>
          ) : (
            <Preview md={it.bodyMd ?? ""} />
          )}
        </section>

        <aside className="space-y-4">
          <Card title="Flujo de aprobación">
            <div className="space-y-2">
              {canWrite && it.status === "draft" && (
                <Button className="w-full" variant="primary" disabled={dirty} loading={busy === "submit"} onClick={() => void act("submit", () => post(`${base}/submit`))}>
                  <Send className="size-4" aria-hidden /> Enviar a revisión
                </Button>
              )}
              {canApprove && it.status === "in_review" && (
                <>
                  <Button className="w-full" variant="primary" loading={busy === "approve"} onClick={() => void act("approve", () => post(`${base}/approve`, { note }))}>
                    <CheckCircle2 className="size-4" aria-hidden /> Aprobar
                  </Button>
                  <label className="block text-sm">
                    <span className="sr-only">Nota para el equipo</span>
                    <Textarea maxLength={1000} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Qué hay que cambiar (obligatorio para devolver)" />
                  </label>
                  <Button className="w-full" disabled={!note.trim()} loading={busy === "reject"} onClick={() => void act("reject", () => post(`${base}/reject`, { note }).then(() => setNote("")))}>
                    <RotateCcw className="size-4" aria-hidden /> Devolver a borrador
                  </Button>
                </>
              )}
              {it.status === "in_review" && !canApprove && <p className="text-sm text-mute">Esperando a que un responsable lo apruebe.</p>}
              {canWrite && it.status !== "archived" && (
                <Button className="w-full" variant="ghost" loading={busy === "archive"} onClick={() => window.confirm("¿Archivar este contenido? Se conserva el historial.") && void act("archive", () => post(`${base}/archive`))}>
                  <Archive className="size-4" aria-hidden /> Archivar
                </Button>
              )}
            </div>
          </Card>
          {canWrite && it.status !== "archived" && (
            <Card title="Revisión con IA" subtitle="1 crédito. Señala afirmaciones sin fuente, tono y SEO/AEO. No cambia el texto.">
              <Button className="w-full" loading={busy === "review"} onClick={() => void act("review", async () => setReview((await post<{ review: string }>(`${base}/ai-review`)).review))}>
                <ShieldCheck className="size-4" aria-hidden /> Revisar
              </Button>
              {review && (
                <div className="mt-3 rounded-2xl border border-line bg-surface-2 p-3">
                  <Preview md={review} />
                </div>
              )}
            </Card>
          )}
          <Card title="Exportar">
            <div className="flex gap-2">
              <a className="inline-flex min-h-10 flex-1 items-center justify-center gap-2 rounded-full border border-line px-3 text-sm font-semibold hover:bg-surface-2" href={`/api/v1${base}/export?format=md`}>
                <Download className="size-4" aria-hidden /> Markdown
              </a>
              <a className="inline-flex min-h-10 flex-1 items-center justify-center gap-2 rounded-full border border-line px-3 text-sm font-semibold hover:bg-surface-2" href={`/api/v1${base}/export?format=html`}>
                <Download className="size-4" aria-hidden /> HTML
              </a>
            </div>
            {it.status !== "approved" && <p className="mt-2 text-xs text-mute">Mientras no esté aprobado, el archivo incluye el aviso «BORRADOR NO APROBADO».</p>}
          </Card>
          <Card title="Versiones">
            <ul className="space-y-2 text-sm">
              {it.versions.map((v) => (
                <li key={v.version} className="flex items-center justify-between gap-2">
                  <span>
                    v{v.version} <span className="text-mute">· {v.source === "ai" ? "IA" : "persona"} · {timeAgo(v.created_at)}</span>
                  </span>
                  {canWrite && it.status !== "archived" && v.version !== it.version && (
                    <button type="button" className="text-xs text-accent-text hover:underline" onClick={() => void restore(v.version)}>
                      Restaurar
                    </button>
                  )}
                </li>
              ))}
            </ul>
          </Card>
        </aside>
      </div>
    </div>
  );
}

