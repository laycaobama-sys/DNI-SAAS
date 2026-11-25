import { useEffect, useState, type FormEvent } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router";
import { AlertTriangle, Archive, CheckCircle2, Download, FileText, Globe, PenLine, RotateCcw, Save, Send, ShieldCheck, Sparkles } from "lucide-react";
import { api, ApiError, del, fmtDate, patch, post, timeAgo } from "../lib/api";
import { useApi } from "../lib/hooks";
import { WordPressCard } from "./wordpress";
import { ExternalCmsCard } from "./external-cms";
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
  brief?: {
    origin?: string;
    finding?: { ruleKey: string; title: string; severity: string; crawlId: string; origin: string; observedAt: string; urls: string[]; measurement: string; source: string };
  };
};
type DraftCheck = { key: string; level: "blocking" | "needs_ack"; message: string; samples: string[] };
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

type Block =
  | { t: "h"; level: number; text: string }
  | { t: "ul" | "ol"; items: string[] }
  | { t: "code"; text: string }
  | { t: "table"; rows: string[][] }
  | { t: "quote" | "p"; text: string }
  | { t: "hr" };

/** Splits Markdown into blocks. Nothing is ever turned into HTML: every block renders as React text. */
export function mdBlocks(md: string): Block[] {
  const out: Block[] = [];
  const lines = md.replace(/\r\n/g, "\n").split("\n");
  const cells = (row: string) =>
    row
      .trim()
      .replace(/^\||\|$/g, "")
      .split(/(?<!\\)\|/)
      .map((c) => c.trim().replace(/\\\|/g, "|"));
  for (let i = 0; i < lines.length; ) {
    const line = lines[i]!;
    if (!line.trim()) {
      i++;
      continue;
    }
    if (/^\s*```/.test(line)) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !/^\s*```/.test(lines[i]!)) body.push(lines[i++]!);
      i++;
      out.push({ t: "code", text: body.join("\n") });
      continue;
    }
    const h = /^(#{1,6})\s+(.*)$/.exec(line.trim());
    if (h) {
      out.push({ t: "h", level: h[1]!.length, text: h[2]! });
      i++;
      continue;
    }
    if (/^\s*(-{3,}|\*{3,})\s*$/.test(line)) {
      out.push({ t: "hr" });
      i++;
      continue;
    }
    const grab = (re: RegExp) => {
      const got: string[] = [];
      while (i < lines.length && re.test(lines[i]!)) got.push(lines[i++]!);
      return got;
    };
    if (/^\s*\|/.test(line)) {
      const rows = grab(/^\s*\|/)
        .filter((r) => !/^\s*\|?\s*:?-{2,}/.test(r))
        .map(cells);
      out.push({ t: "table", rows });
      continue;
    }
    if (/^\s*>/.test(line)) {
      out.push({ t: "quote", text: grab(/^\s*>/).map((l) => l.replace(/^\s*>\s?/, "")).join(" ") });
      continue;
    }
    if (/^\s*[-*•]\s+/.test(line)) {
      out.push({ t: "ul", items: grab(/^\s*([-*•]\s+|\s{2,}\S)/).map((l) => l.replace(/^(\s*)[-*•]\s+/, "$1")) });
      continue;
    }
    if (/^\s*\d+[.)]\s+/.test(line)) {
      out.push({ t: "ol", items: grab(/^\s*(\d+[.)]\s+|\s{2,}\S)/).map((l) => l.replace(/^(\s*)\d+[.)]\s+/, "$1")) });
      continue;
    }
    out.push({ t: "p", text: grab(/^(?!\s*(```|#{1,6}\s|[-*•]\s|\d+[.)]\s|>|\|)).+/).join("\n") });
  }
  return out;
}

/** Inline text: drops Markdown emphasis, shows links as «text (url)» and highlights what is left to fill in. */
function Inline({ text }: { text: string }) {
  const clean = text
    .replace(/\*\*|__/g, "")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/!?\[([^\]]*)\]\(([^)\s]+)\)/g, (_m, t: string, u: string) => (t ? `${t} (${u})` : u));
  return (
    <>
      {clean.split(/(\[(?:VERIFICAR|COMPLETAR)[^\]]*\])/g).map((part, i) =>
        /^\[(VERIFICAR|COMPLETAR)/.test(part) ? (
          <mark key={i} className="rounded bg-warn/15 px-1 text-ink">
            {part}
          </mark>
        ) : (
          part
        ),
      )}
    </>
  );
}

/** Read-only markdown preview rendered as plain React text (no HTML from the model or the editor is injected). */
export function Preview({ md }: { md: string }) {
  return (
    <div className="space-y-3 text-sm leading-relaxed">
      {mdBlocks(md).map((b, i) => {
        switch (b.t) {
          case "h":
            return (
              <p key={i} role="heading" aria-level={Math.min(b.level + 1, 6)} className={cx("font-semibold", b.level === 1 ? "text-xl" : b.level === 2 ? "pt-2 text-lg" : "text-base")}>
                <Inline text={b.text} />
              </p>
            );
          case "ul":
          case "ol": {
            const L = b.t;
            return (
              <L key={i} className={cx("space-y-1 pl-5", L === "ul" ? "list-disc" : "list-decimal")}>
                {b.items.map((l, j) => (
                  <li key={j} className={cx(/^\s{2,}/.test(l) && "ml-4 list-[circle]")}>
                    <Inline text={l.trim().replace(/^([-*•]|\d+[.)])\s+/, "")} />
                  </li>
                ))}
              </L>
            );
          }
          case "code":
            return (
              <pre key={i} className="overflow-x-auto rounded-xl bg-surface-2 p-3 font-mono text-xs">
                <code>{b.text}</code>
              </pre>
            );
          case "table":
            return (
              <div key={i} className="overflow-x-auto rounded-xl border border-line">
                <table className="w-full min-w-[480px] text-xs">
                  <thead className="bg-surface-2 text-left">
                    <tr>
                      {b.rows[0]?.map((c, j) => (
                        <th key={j} className="px-3 py-2 font-medium">
                          <Inline text={c} />
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {b.rows.slice(1).map((r, j) => (
                      <tr key={j} className="border-t border-line align-top">
                        {r.map((c, k) => (
                          <td key={k} className="break-words px-3 py-2">
                            <Inline text={c} />
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            );
          case "quote":
            return (
              <blockquote key={i} className="border-l-4 border-line pl-3 text-mute">
                <Inline text={b.text} />
              </blockquote>
            );
          case "hr":
            return <hr key={i} className="border-line" />;
          default:
            return (
              <p key={i} className="whitespace-pre-wrap">
                <Inline text={b.text} />
              </p>
            );
        }
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
  const [sp] = useSearchParams();
  const fromGeo = sp.get("from") === "geo";
  const [form, setForm] = useState(() => ({
    kind: sp.get("kind") ?? "blog_article",
    title: (sp.get("title") ?? "").slice(0, 200),
    keyword: (sp.get("keyword") ?? "").slice(0, 120),
    audience: "",
    angle: (sp.get("angle") ?? "").slice(0, 500),
    sources: "",
    brandId: sp.get("brandId") ?? "",
  }));
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
  /** Structured blank draft: no AI, no credits — works with the AI quota spent or switched off. */
  const createManual = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await post<Item>(`/orgs/${orgId}/content/manual`, {
        kind: form.kind,
        title: form.title,
        keyword: form.keyword,
        audience: form.audience,
        ...(form.brandId ? { brandId: form.brandId } : {}),
      });
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
      <div className="grid gap-6 xl:grid-cols-[380px_minmax(0,1fr)]">
        {canWrite ? (
          <Card title="Nuevo borrador">
            {fromGeo && (
              <div className="mb-3">
                <Notice title="Rellenado desde una recomendación GEO">Revisa el título, la palabra clave y el enfoque antes de generar. El borrador requiere revisión y aprobación humana; nada se publica solo.</Notice>
              </div>
            )}
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
                  {["insufficient_credits", "ai_daily_quota", "ai_unavailable", "selected_model_failed"].includes(error.code) && (
                    <p className="mt-2 text-sm text-mute">Mientras tanto puedes usar «Escribir a mano»: crea el borrador con su estructura, sin IA ni créditos.</p>
                  )}
                </div>
              )}
              <Button variant="primary" type="submit" loading={busy} disabled={form.title.trim().length < 3} className="w-full">
                <Sparkles className="size-4" aria-hidden /> {busy ? "Redactando… (puede tardar 30 s)" : "Generar borrador"}
              </Button>
              <Button type="button" disabled={busy || form.title.trim().length < 3} onClick={() => void createManual()} className="w-full">
                <PenLine className="size-4" aria-hidden /> Escribir a mano (sin IA ni créditos)
              </Button>
              <p className="text-xs text-mute">
                ¿Ya tienes una auditoría? Crea borradores de corrección desde sus{" "}
                <Link to={`/o/${orgId}/audits`} className="font-semibold text-accent-text hover:underline">
                  mejoras prioritarias
                </Link>
                , con la evidencia incluida.
              </p>
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
  const res = useApi<Item & { versions: Version[]; checks?: DraftCheck[] }>(`/orgs/${orgId}/content/${contentId}`);
  const [ack, setAck] = useState(false);
  const site = useApi<{ available: boolean; post: { slug: string; status: "published" | "unpublished"; url: string; contentVersion: number; publishedAt: string; updatedAt: string } | null }>(
    `/orgs/${orgId}/content/${contentId}/site-blog`,
  );
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
  const origin = it.brief?.origin;
  const finding = it.brief?.finding;
  const checks = it.checks ?? [];
  const blocking = checks.filter((x) => x.level === "blocking");
  const needsAck = checks.filter((x) => x.level === "needs_ack");
  const originTitle = origin === "audit_finding" ? "Borrador creado desde un hallazgo de tu auditoría" : origin === "manual" ? "Borrador escrito a mano" : "Borrador generado por IA";

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
      <Notice tone={it.status === "approved" ? "ok" : "info"} title={it.status === "approved" ? `Aprobado ${fmtDate(it.approvedAt)}` : originTitle}>
        {it.status === "approved" ? "Aprobado por una persona del equipo. Si lo editas, vuelve a borrador." : it.measurement}
        {it.provider && " Generado con IA DNI Growth."}
        {it.status !== "approved" && blocking.length > 0 && " Antes de aprobarlo hay que completar los campos marcados en amarillo."}
      </Notice>
      {it.reviewNote && it.status === "draft" && (
        <Notice tone="warn" title="Cambios solicitados">
          {it.reviewNote}
        </Notice>
      )}
      {error && <ErrorState error={error} onRetry={error.code === "version_conflict" ? () => void res.reload() : undefined} />}

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_300px]">
        <section className="min-w-0 rounded-3xl border border-line bg-surface p-4 sm:p-6" aria-label="Contenido">
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
          {it.status !== "approved" && it.status !== "archived" && (
            <Card title="Comprobaciones antes de aprobar" subtitle="Automáticas, sin IA. Se recalculan cada vez que guardas.">
              {checks.length === 0 ? (
                <p className="flex items-center gap-2 text-sm text-ok">
                  <CheckCircle2 className="size-4" aria-hidden /> Sin campos pendientes, promesas de resultados, cifras sin fuente ni precios sin verificar.
                </p>
              ) : (
                <ul className="space-y-3 text-sm">
                  {checks.map((x) => (
                    <li key={x.key} className={cx("rounded-xl border p-3", x.level === "blocking" ? "border-danger/40" : "border-warn/40")}>
                      <p className="flex items-start gap-2 font-medium">
                        <AlertTriangle className={cx("mt-0.5 size-4 shrink-0", x.level === "blocking" ? "text-danger" : "text-warn")} aria-hidden />
                        <span>
                          {x.message} <span className="text-xs font-normal text-mute">{x.level === "blocking" ? "Impide aprobar." : "Requiere tu confirmación."}</span>
                        </span>
                      </p>
                      {x.samples.length > 0 && (
                        <ul className="mt-2 space-y-1 pl-6 text-xs text-mute">
                          {x.samples.map((s) => (
                            <li key={s} className="break-words">
                              «{s}»
                            </li>
                          ))}
                        </ul>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          )}
          {finding && (
            <Card title="Hallazgo de origen" subtitle={`Observado el ${fmtDate(finding.observedAt)} · medida observada`}>
              <p className="text-sm font-medium">{finding.title}</p>
              <ul className="mt-2 space-y-1 text-xs text-mute">
                {finding.urls.slice(0, 5).map((u) => (
                  <li key={u} className="break-all">
                    {u}
                  </li>
                ))}
                {finding.urls.length > 5 && <li>y {finding.urls.length - 5} URL(s) más</li>}
                {finding.urls.length === 0 && <li>Todo el sitio ({finding.origin})</li>}
              </ul>
              <Link to={`/o/${orgId}/audits/${finding.crawlId}`} className="mt-3 inline-block text-sm font-semibold text-accent-text hover:underline">
                Ver la auditoría →
              </Link>
            </Card>
          )}
          <Card title="Flujo de aprobación">
            <div className="space-y-2">
              {canWrite && it.status === "draft" && (
                <Button className="w-full" variant="primary" disabled={dirty} loading={busy === "submit"} onClick={() => void act("submit", () => post(`${base}/submit`))}>
                  <Send className="size-4" aria-hidden /> Enviar a revisión
                </Button>
              )}
              {canWrite && it.status === "draft" && blocking.length > 0 && <p className="text-xs text-mute">Puedes enviarlo a revisión, pero no se podrá aprobar hasta resolver lo marcado como «Impide aprobar».</p>}
              {canApprove && it.status === "in_review" && (
                <>
                  {needsAck.length > 0 && blocking.length === 0 && (
                    <label className="flex items-start gap-2 rounded-xl border border-warn/40 p-3 text-sm">
                      <input type="checkbox" className="mt-1" checked={ack} onChange={(e) => setAck(e.target.checked)} />
                      <span>He revisado las cifras y precios señalados y son correctos. Quedará registrado en el historial.</span>
                    </label>
                  )}
                  <Button
                    className="w-full"
                    variant="primary"
                    disabled={blocking.length > 0 || (needsAck.length > 0 && !ack)}
                    loading={busy === "approve"}
                    onClick={() => void act("approve", () => post(`${base}/approve`, { note, acknowledgeChecks: needsAck.length > 0 && ack }).then(() => setAck(false)))}
                  >
                    <CheckCircle2 className="size-4" aria-hidden /> Aprobar
                  </Button>
                  {blocking.length > 0 && <p className="text-xs text-mute">No se puede aprobar todavía: devuélvelo a borrador con una nota para que se complete.</p>}
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
          {site.data?.available && it.kind === "blog_article" && (
            <Card title="Blog de dnigrowth.com" subtitle="Publica la versión aprobada. Las ediciones posteriores no cambian la página pública hasta que vuelvas a publicar.">
              {site.data.post?.status === "published" && (
                <p className="mb-3 text-sm">
                  Publicado:{" "}
                  <a href={site.data.post.url} target="_blank" rel="noopener noreferrer" className="break-all font-semibold text-accent-text hover:underline">
                    {site.data.post.url.replace(/^https?:\/\//, "")}
                  </a>
                  {site.data.post.contentVersion !== it.version && <span className="block text-xs text-warn">La página muestra la versión {site.data.post.contentVersion}; la actual es la {it.version}.</span>}
                </p>
              )}
              {it.status === "approved" && canApprove ? (
                <div className="space-y-2">
                  <Button
                    className="w-full"
                    variant="primary"
                    loading={busy === "publish"}
                    onClick={() =>
                      window.confirm("Se publicará en dnigrowth.com/blog, visible para cualquiera y para los buscadores. ¿Publicar?") &&
                      void act("publish", () => post(`${base}/site-blog`).then(() => site.reload()))
                    }
                  >
                    <Globe className="size-4" aria-hidden /> {site.data.post?.status === "published" ? "Actualizar publicación" : "Publicar en el blog"}
                  </Button>
                  {site.data.post?.status === "published" && (
                    <Button className="w-full" variant="ghost" loading={busy === "unpublish"} onClick={() => window.confirm("¿Retirar el artículo del blog? Dejará de ser visible.") && void act("unpublish", () => del(`${base}/site-blog`).then(() => site.reload()))}>
                      Retirar del blog
                    </Button>
                  )}
                </div>
              ) : (
                <p className="text-sm text-mute">{it.status === "approved" ? "Solo propietario, administración o marketing pueden publicar." : "Apruébalo primero: solo se publica contenido aprobado por una persona."}</p>
              )}
            </Card>
          )}
          <WordPressCard orgId={orgId} contentId={contentId} kind={it.kind} status={it.status} version={it.version} />
          <ExternalCmsCard orgId={orgId} contentId={contentId} kind={it.kind} status={it.status} version={it.version} />
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

