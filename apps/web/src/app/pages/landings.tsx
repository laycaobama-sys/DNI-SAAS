import { useEffect, useState, type FormEvent } from "react";
import { useParams, useSearchParams } from "react-router";
import { ArrowDown, ArrowUp, ExternalLink, Eye, FlaskConical, History, LayoutTemplate, Plus, Trash2 } from "lucide-react";
import { ApiError, fmtDate, patch, post, put } from "../lib/api";
import { useApi } from "../lib/hooks";
import { Badge, Button, Card, EmptyState, ErrorState, Field, Input, Notice, PageHeader, Select, Spinner, Textarea, TextField, cx } from "../ui";
import { useOrgAccess } from "./org";

type Block =
  | { type: "hero"; heading: string; subheading: string; ctaLabel: string; ctaHref: string; imageUrl: string | null; imageAlt: string }
  | { type: "features"; heading: string; items: Array<{ title: string; text: string }> }
  | { type: "text"; heading: string; body: string }
  | { type: "faq"; heading: string; items: Array<{ q: string; a: string }> }
  | { type: "cta"; heading: string; text: string; ctaLabel: string; ctaHref: string }
  | { type: "form"; heading: string; text: string; buttonLabel: string };
type Content = { seo: { title: string; description: string }; theme: { accent: string; mode: "light" | "dark" }; blocks: Block[] };
type Page = {
  id: string;
  slug: string;
  name: string;
  status: "draft" | "published" | "unpublished" | "archived";
  form_id: string | null;
  noindex: boolean;
  draft_version_id: string | null;
  published_version_id: string | null;
  experiment_status: "none" | "running" | "stopped";
  variant_b_version_id: string | null;
  split_b: number;
  experiment_started_at: string | null;
  experiment_hypothesis: string | null;
  updated_at: string;
  published_at: string | null;
  url: string;
};
type Counts = { views: number; conversions: number };
type AbResult = { a: Counts & { rate: number | null }; b: Counts & { rate: number | null }; pValue: number | null; relativeLift: number | null; verdict: "insufficient_data" | "no_significant_difference" | "a_better" | "b_better"; warnings: string[] };
type Detail = {
  page: Page;
  draft: { id: string; version: number; content: Content } | null;
  versions: Array<{ id: string; version: number; note: string | null; created_at: string; created_by_name: string | null }>;
  stats: { since: string; measurement: string; a: Counts; b: Counts; test: AbResult | null; caveats: string[] };
};

const STATUS: Record<Page["status"], { label: string; tone: "ok" | "neutral" | "warn" }> = {
  draft: { label: "Borrador", tone: "neutral" },
  published: { label: "Publicada", tone: "ok" },
  unpublished: { label: "Despublicada", tone: "warn" },
  archived: { label: "Archivada", tone: "neutral" },
};
const BLOCK_LABEL: Record<Block["type"], string> = { hero: "Portada", features: "Ventajas", text: "Texto", faq: "Preguntas frecuentes", cta: "Llamada a la acción", form: "Formulario" };
const NEW_BLOCK: Record<Block["type"], () => Block> = {
  hero: () => ({ type: "hero", heading: "Tu propuesta principal", subheading: "", ctaLabel: "Quiero información", ctaHref: "#formulario", imageUrl: null, imageAlt: "" }),
  features: () => ({ type: "features", heading: "Ventajas", items: [{ title: "Ventaja", text: "" }] }),
  text: () => ({ type: "text", heading: "", body: "Escribe aquí." }),
  faq: () => ({ type: "faq", heading: "Preguntas frecuentes", items: [{ q: "¿Pregunta?", a: "Respuesta." }] }),
  cta: () => ({ type: "cta", heading: "¿Hablamos?", text: "", ctaLabel: "Contactar", ctaHref: "#formulario" }),
  form: () => ({ type: "form", heading: "Hablemos", text: "", buttonLabel: "Enviar" }),
};
const pct = (v: number | null | undefined) => (v === null || v === undefined ? "—" : `${(v * 100).toFixed(1).replace(".", ",")} %`);
const errMsg = (e: unknown) => (e instanceof ApiError ? e.message : "No se pudo completar la acción.");
const slugify = (s: string) =>
  s
    .normalize("NFD")
    .replace(new RegExp("[\u0300-\u036f]", "g"), "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);

export function LandingsPage() {
  const { orgId } = useParams();
  const [sp, setSp] = useSearchParams();
  const access = useOrgAccess(orgId);
  const base = `/orgs/${orgId}/landings`;
  const selected = sp.get("landing");
  const open = (id: string | null) => setSp((p) => (id ? p.set("landing", id) : p.delete("landing"), p));
  return (
    <>
      <PageHeader
        eyebrow="Captación · Landings y tests A/B"
        title="Landing pages"
        subtitle="Páginas por bloques con versiones, vista previa, publicación en tu dirección de DNI Growth, formulario del CRM y tests A/B con estadística honesta. Sin cookies de seguimiento."
      />
      {selected ? (
        <LandingEditor base={base} orgId={orgId!} id={selected} onBack={() => open(null)} canWrite={access.can("landings:write")} canPublish={access.can("landings:publish")} />
      ) : (
        <LandingList base={base} orgId={orgId!} onOpen={open} canWrite={access.can("landings:write")} />
      )}
    </>
  );
}

function LandingList({ base, orgId, onOpen, canWrite }: { base: string; orgId: string; onOpen: (id: string) => void; canWrite: boolean }) {
  const r = useApi<{ items: Array<Page & { last30: Counts }>; usage: { used: number; limit: number; plan: string } }>(base);
  const forms = useApi<{ items: Array<{ id: string; name: string; status: string }> }>(`/orgs/${orgId}/crm/forms`);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [slugTouched, setSlugTouched] = useState(false);
  const [formId, setFormId] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  if (r.error) return <ErrorState error={r.error} onRetry={r.reload} />;
  if (!r.data) return <Spinner />;
  const { items, usage } = r.data;
  const create = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      const res = await post<{ id: string }>(base, { name, slug, formId: formId || null });
      onOpen(res.id);
    } catch (x) {
      setErr(errMsg(x));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="space-y-4">
      <Card
        title="Tus landings"
        subtitle={`${usage.used} de ${usage.limit} en tu plan · visitas y conversiones de los últimos 30 días, contadas en el servidor (observado).`}
        actions={
          canWrite && usage.used < usage.limit ? (
            <Button variant="primary" onClick={() => setCreating((x) => !x)}>
              <Plus className="size-4" aria-hidden /> Nueva landing
            </Button>
          ) : undefined
        }
      >
        {creating && (
          <form onSubmit={create} className="mb-4 grid gap-3 rounded-2xl border border-line p-4 sm:grid-cols-2">
            <TextField
              label="Nombre interno"
              required
              value={name}
              maxLength={120}
              onChange={(e) => {
                setName(e.target.value);
                if (!slugTouched) setSlug(slugify(e.target.value));
              }}
            />
            <TextField label="Dirección (slug)" required value={slug} pattern="[a-z0-9]+(-[a-z0-9]+)*" minLength={3} maxLength={60} hint="Minúsculas, números y guiones." onChange={(e) => (setSlugTouched(true), setSlug(e.target.value))} />
            <Field label="Formulario del CRM" htmlFor="lp-form" hint="Los envíos llegan al CRM como contactos. Puedes elegirlo después.">
              <Select id="lp-form" value={formId} onChange={(e) => setFormId(e.target.value)}>
                <option value="">Sin formulario por ahora</option>
                {forms.data?.items
                  .filter((f) => f.status === "active")
                  .map((f) => (
                    <option key={f.id} value={f.id}>
                      {f.name}
                    </option>
                  ))}
              </Select>
            </Field>
            <div className="flex items-end gap-2">
              <Button variant="primary" type="submit" loading={busy}>
                Crear con plantilla
              </Button>
              <Button type="button" variant="ghost" onClick={() => setCreating(false)}>
                Cancelar
              </Button>
            </div>
            {err && <p className="text-sm text-danger sm:col-span-2">{err}</p>}
          </form>
        )}
        {items.length === 0 ? (
          <EmptyState icon={<LayoutTemplate className="size-6" aria-hidden />} title="Aún no hay landings">
            Crea una a partir de la plantilla: la editas por bloques, la previsualizas y la publicas cuando quieras.
          </EmptyState>
        ) : (
          <ul className="divide-y divide-line">
            {items.map((p) => (
              <li key={p.id} className="flex flex-wrap items-center justify-between gap-3 py-3 text-sm">
                <button type="button" className="min-w-0 text-left" onClick={() => onOpen(p.id)}>
                  <p className="font-medium">
                    {p.name} <Badge tone={STATUS[p.status].tone}>{STATUS[p.status].label}</Badge>
                    {p.experiment_status === "running" && (
                      <Badge tone="info" className="ml-1">
                        Test A/B en marcha
                      </Badge>
                    )}
                  </p>
                  <p className="break-all text-xs text-mute">{p.url}</p>
                </button>
                <div className="flex items-center gap-4 text-xs text-mute tabular-nums">
                  <span>{p.last30.views} visitas</span>
                  <span>{p.last30.conversions} conversiones</span>
                  <Button variant="ghost" onClick={() => onOpen(p.id)}>
                    Abrir
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

function LandingEditor({ base, orgId, id, onBack, canWrite, canPublish }: { base: string; orgId: string; id: string; onBack: () => void; canWrite: boolean; canPublish: boolean }) {
  const d = useApi<Detail>(`${base}/${id}`);
  const forms = useApi<{ items: Array<{ id: string; name: string; status: string }> }>(`/orgs/${orgId}/crm/forms`);
  const [content, setContent] = useState<Content | null>(null);
  const [baseVersion, setBaseVersion] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [note, setNote] = useState("");
  const [msg, setMsg] = useState<{ tone: "ok" | "warn"; text: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [tab, setTab] = useState<"edit" | "settings" | "versions" | "ab">("edit");

  useEffect(() => {
    if (d.data?.draft && (!dirty || d.data.draft.id !== baseVersion)) {
      setContent(d.data.draft.content);
      setBaseVersion(d.data.draft.id);
      setDirty(false);
    }
  }, [d.data?.draft?.id]);

  if (d.error) return <ErrorState error={d.error} onRetry={d.reload} />;
  if (!d.data || !content) return <Spinner />;
  const { page, versions, stats } = d.data;
  const edit = (c: Content) => (setContent(c), setDirty(true), setMsg(null));
  const setBlock = (i: number, b: Block) => edit({ ...content, blocks: content.blocks.map((x, j) => (j === i ? b : x)) });
  const move = (i: number, dir: -1 | 1) => {
    const blocks = [...content.blocks];
    const j = i + dir;
    if (j < 0 || j >= blocks.length) return;
    [blocks[i], blocks[j]] = [blocks[j]!, blocks[i]!];
    edit({ ...content, blocks });
  };
  const run = async (key: string, fn: () => Promise<unknown>, ok: string) => {
    setBusy(key);
    setMsg(null);
    try {
      await fn();
      setMsg({ tone: "ok", text: ok });
      await d.reload();
    } catch (e) {
      setMsg({ tone: "warn", text: errMsg(e) });
    } finally {
      setBusy(null);
    }
  };
  const save = () =>
    run(
      "save",
      async () => {
        await put(`${base}/${id}/content`, { content, note: note.trim() || undefined, baseVersionId: baseVersion });
        setDirty(false);
        setNote("");
      },
      "Versión guardada.",
    );
  const previewHref = (versionId?: string) => `/api/v1${base}/${id}/preview${versionId ? `?versionId=${versionId}` : ""}`;
  const published = versions.find((v) => v.id === page.published_version_id);
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Button variant="ghost" onClick={onBack}>
          ← Todas las landings
        </Button>
        <div className="flex flex-wrap gap-2">
          <a className="inline-flex min-h-10 items-center gap-2 rounded-full border border-line px-4 text-sm hover:bg-surface-2" href={previewHref()} target="_blank" rel="noopener">
            <Eye className="size-4" aria-hidden /> Vista previa{dirty ? " (última versión guardada)" : ""}
          </a>
          {page.status === "published" && (
            <a className="inline-flex min-h-10 items-center gap-2 rounded-full border border-line px-4 text-sm hover:bg-surface-2" href={page.url} target="_blank" rel="noopener">
              <ExternalLink className="size-4" aria-hidden /> Ver publicada
            </a>
          )}
        </div>
      </div>
      <Card
        title={
          <>
            {page.name} <Badge tone={STATUS[page.status].tone}>{STATUS[page.status].label}</Badge>
          </>
        }
        subtitle={
          <span className="break-all">
            {page.url}
            {published ? ` · publicada la versión ${published.version} (${fmtDate(page.published_at)})` : ""}
            {d.data.draft ? ` · editando sobre la versión ${d.data.draft.version}` : ""}
          </span>
        }
        actions={
          canPublish ? (
            <div className="flex flex-wrap gap-2">
              <Button
                variant="primary"
                disabled={dirty || page.experiment_status === "running"}
                title={dirty ? "Guarda antes de publicar" : page.experiment_status === "running" ? "Para el test A/B antes" : undefined}
                loading={busy === "publish"}
                onClick={() => run("publish", () => post(`${base}/${id}/publish`, {}), "Publicada. Ya es visible en su dirección.")}
              >
                Publicar última versión
              </Button>
              {page.status === "published" && (
                <Button variant="danger" loading={busy === "unpublish"} onClick={() => run("unpublish", () => post(`${base}/${id}/unpublish`, {}), "Despublicada: la dirección muestra «no disponible».")}>
                  Despublicar
                </Button>
              )}
            </div>
          ) : undefined
        }
      >
        {msg && <Notice tone={msg.tone}>{msg.text}</Notice>}
        <div role="tablist" aria-label="Secciones de la landing" className="mt-2 flex flex-wrap gap-2">
          {(
            [
              ["edit", "Contenido"],
              ["settings", "Ajustes"],
              ["versions", `Versiones (${versions.length})`],
              ["ab", "Resultados y test A/B"],
            ] as const
          ).map(([k, l]) => (
            <button key={k} role="tab" aria-selected={tab === k} type="button" onClick={() => setTab(k)} className={cx("min-h-10 rounded-full border px-4 text-sm", tab === k ? "border-ink bg-ink text-bg" : "border-line hover:bg-surface-2")}>
              {l}
            </button>
          ))}
        </div>
      </Card>

      {tab === "edit" && (
        <div className="space-y-4">
          <Card title="SEO y estilo">
            <div className="grid gap-3 sm:grid-cols-2">
              <TextField label="Título (pestaña y buscadores)" required maxLength={70} value={content.seo.title} disabled={!canWrite} onChange={(e) => edit({ ...content, seo: { ...content.seo, title: e.target.value } })} />
              <TextField label="Descripción" maxLength={160} value={content.seo.description} disabled={!canWrite} onChange={(e) => edit({ ...content, seo: { ...content.seo, description: e.target.value } })} />
              <Field label="Color principal" htmlFor="lp-accent" hint="Botones y detalles. El texto sobre él se ajusta solo para que se lea.">
                <div className="flex items-center gap-2">
                  <input id="lp-accent" type="color" className="h-10 w-14 rounded border border-line" value={content.theme.accent} disabled={!canWrite} onChange={(e) => edit({ ...content, theme: { ...content.theme, accent: e.target.value } })} />
                  <code className="text-sm">{content.theme.accent}</code>
                </div>
              </Field>
              <Field label="Modo" htmlFor="lp-mode">
                <Select id="lp-mode" value={content.theme.mode} disabled={!canWrite} onChange={(e) => edit({ ...content, theme: { ...content.theme, mode: e.target.value as "light" | "dark" } })}>
                  <option value="light">Claro</option>
                  <option value="dark">Oscuro</option>
                </Select>
              </Field>
            </div>
          </Card>
          {content.blocks.map((b, i) => (
            <Card
              key={i}
              title={`${i + 1}. ${BLOCK_LABEL[b.type]}`}
              actions={
                canWrite ? (
                  <div className="flex gap-1">
                    <Button variant="ghost" aria-label="Subir bloque" disabled={i === 0} onClick={() => move(i, -1)}>
                      <ArrowUp className="size-4" aria-hidden />
                    </Button>
                    <Button variant="ghost" aria-label="Bajar bloque" disabled={i === content.blocks.length - 1} onClick={() => move(i, 1)}>
                      <ArrowDown className="size-4" aria-hidden />
                    </Button>
                    <Button variant="ghost" aria-label="Quitar bloque" disabled={content.blocks.length === 1} onClick={() => edit({ ...content, blocks: content.blocks.filter((_, j) => j !== i) })}>
                      <Trash2 className="size-4" aria-hidden />
                    </Button>
                  </div>
                ) : undefined
              }
            >
              <BlockEditor b={b} idx={i} disabled={!canWrite} onChange={(nb) => setBlock(i, nb)} />
            </Card>
          ))}
          {canWrite && (
            <Card title="Añadir bloque">
              <div className="flex flex-wrap gap-2">
                {(Object.keys(NEW_BLOCK) as Block["type"][]).map((t) => (
                  <Button key={t} disabled={content.blocks.length >= 30} onClick={() => edit({ ...content, blocks: [...content.blocks, NEW_BLOCK[t]()] })}>
                    <Plus className="size-4" aria-hidden /> {BLOCK_LABEL[t]}
                  </Button>
                ))}
              </div>
              <div className="mt-4 grid gap-2 sm:grid-cols-[1fr_auto]">
                <Input aria-label="Nota de la versión (opcional)" placeholder="Nota de la versión (opcional): qué has cambiado" maxLength={200} value={note} onChange={(e) => setNote(e.target.value)} />
                <Button variant="primary" disabled={!dirty} loading={busy === "save"} onClick={save}>
                  Guardar versión
                </Button>
              </div>
              {dirty && <p className="mt-2 text-xs text-mute">Hay cambios sin guardar. Cada guardado crea una versión nueva; ninguna se pierde.</p>}
            </Card>
          )}
        </div>
      )}

      {tab === "settings" && <Settings base={base} page={page} forms={forms.data?.items ?? []} canWrite={canWrite} onSaved={d.reload} onArchived={onBack} />}

      {tab === "versions" && (
        <Card title="Historial de versiones" subtitle="Restaurar crea una versión nueva con el contenido antiguo (no se borra nada).">
          <ul className="divide-y divide-line">
            {versions.map((v) => (
              <li key={v.id} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
                <div>
                  <p className="font-medium">
                    <History className="mr-1 inline size-4" aria-hidden />
                    Versión {v.version} {v.id === page.published_version_id && <Badge tone="ok">Publicada (A)</Badge>} {v.id === page.variant_b_version_id && page.experiment_status !== "none" && <Badge tone="info">Variante B</Badge>}{" "}
                    {v.id === page.draft_version_id && <Badge>Última</Badge>}
                  </p>
                  <p className="text-xs text-mute">
                    {fmtDate(v.created_at)}
                    {v.created_by_name ? ` · ${v.created_by_name}` : ""}
                    {v.note ? ` · ${v.note}` : ""}
                  </p>
                </div>
                <div className="flex gap-2">
                  <a className="inline-flex min-h-9 items-center rounded-full px-3 text-sm text-mute hover:bg-surface-2" href={previewHref(v.id)} target="_blank" rel="noopener">
                    Ver
                  </a>
                  {canWrite && v.id !== page.draft_version_id && (
                    <Button variant="ghost" loading={busy === `restore-${v.id}`} onClick={() => run(`restore-${v.id}`, () => post(`${base}/${id}/versions/${v.id}/restore`, {}), `Restaurada la versión ${v.version} como nueva versión.`)}>
                      Restaurar
                    </Button>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </Card>
      )}

      {tab === "ab" && <Experiment base={base} id={id} page={page} versions={versions} stats={stats} canPublish={canPublish} busy={busy} run={run} />}
    </div>
  );
}

function BlockEditor({ b, idx, disabled, onChange }: { b: Block; idx: number; disabled: boolean; onChange: (b: Block) => void }) {
  const fid = (k: string) => `blk-${idx}-${k}`;
  const t = (label: string, key: string, value: string, max: number, extra: { required?: boolean; hint?: string } = {}) => (
    <TextField label={label} value={value} maxLength={max} required={extra.required} hint={extra.hint} disabled={disabled} onChange={(e) => onChange({ ...b, [key]: e.target.value } as Block)} />
  );
  const href = (value: string) => (
    <Field label="Destino del botón" htmlFor={fid("href")} hint="«#formulario» lleva al formulario de esta página; o una dirección https://">
      <Input id={fid("href")} value={value} maxLength={500} disabled={disabled} onChange={(e) => onChange({ ...b, ctaHref: e.target.value } as Block)} />
    </Field>
  );
  switch (b.type) {
    case "hero":
      return (
        <div className="grid gap-3 sm:grid-cols-2">
          {t("Titular", "heading", b.heading, 120, { required: true })}
          {t("Subtítulo", "subheading", b.subheading, 300)}
          {t("Texto del botón", "ctaLabel", b.ctaLabel, 40)}
          {href(b.ctaHref)}
          <TextField label="Imagen (URL https, opcional)" type="url" value={b.imageUrl ?? ""} disabled={disabled} maxLength={500} onChange={(e) => onChange({ ...b, imageUrl: e.target.value || null })} />
          {t("Texto alternativo de la imagen", "imageAlt", b.imageAlt, 160, { hint: "Describe la imagen para quien no la ve." })}
        </div>
      );
    case "features":
      return (
        <div className="space-y-3">
          {t("Título de la sección", "heading", b.heading, 120)}
          {b.items.map((it, j) => (
            <div key={j} className="grid gap-2 rounded-xl border border-line p-3 sm:grid-cols-[1fr_2fr_auto]">
              <Input aria-label={`Ventaja ${j + 1}: título`} value={it.title} maxLength={80} disabled={disabled} onChange={(e) => onChange({ ...b, items: b.items.map((x, k) => (k === j ? { ...x, title: e.target.value } : x)) })} />
              <Input aria-label={`Ventaja ${j + 1}: texto`} value={it.text} maxLength={300} disabled={disabled} onChange={(e) => onChange({ ...b, items: b.items.map((x, k) => (k === j ? { ...x, text: e.target.value } : x)) })} />
              <Button variant="ghost" aria-label={`Quitar ventaja ${j + 1}`} disabled={disabled || b.items.length === 1} onClick={() => onChange({ ...b, items: b.items.filter((_, k) => k !== j) })}>
                <Trash2 className="size-4" aria-hidden />
              </Button>
            </div>
          ))}
          <Button disabled={disabled || b.items.length >= 6} onClick={() => onChange({ ...b, items: [...b.items, { title: "Ventaja", text: "" }] })}>
            <Plus className="size-4" aria-hidden /> Añadir ventaja
          </Button>
        </div>
      );
    case "text":
      return (
        <div className="space-y-3">
          {t("Título", "heading", b.heading, 120)}
          <Field label="Texto" htmlFor={fid("body")} hint="Texto plano. Deja una línea en blanco para separar párrafos.">
            <Textarea id={fid("body")} rows={6} value={b.body} maxLength={4000} disabled={disabled} onChange={(e) => onChange({ ...b, body: e.target.value })} />
          </Field>
        </div>
      );
    case "faq":
      return (
        <div className="space-y-3">
          {t("Título de la sección", "heading", b.heading, 120)}
          {b.items.map((it, j) => (
            <div key={j} className="grid gap-2 rounded-xl border border-line p-3">
              <Input aria-label={`Pregunta ${j + 1}`} value={it.q} maxLength={200} disabled={disabled} onChange={(e) => onChange({ ...b, items: b.items.map((x, k) => (k === j ? { ...x, q: e.target.value } : x)) })} />
              <Textarea aria-label={`Respuesta ${j + 1}`} rows={3} value={it.a} maxLength={1000} disabled={disabled} onChange={(e) => onChange({ ...b, items: b.items.map((x, k) => (k === j ? { ...x, a: e.target.value } : x)) })} />
              <Button variant="ghost" className="justify-self-start" disabled={disabled || b.items.length === 1} onClick={() => onChange({ ...b, items: b.items.filter((_, k) => k !== j) })}>
                <Trash2 className="size-4" aria-hidden /> Quitar
              </Button>
            </div>
          ))}
          <Button disabled={disabled || b.items.length >= 12} onClick={() => onChange({ ...b, items: [...b.items, { q: "¿Pregunta?", a: "Respuesta." }] })}>
            <Plus className="size-4" aria-hidden /> Añadir pregunta
          </Button>
        </div>
      );
    case "cta":
      return (
        <div className="grid gap-3 sm:grid-cols-2">
          {t("Titular", "heading", b.heading, 120, { required: true })}
          {t("Texto", "text", b.text, 300)}
          {t("Texto del botón", "ctaLabel", b.ctaLabel, 40, { required: true })}
          {href(b.ctaHref)}
        </div>
      );
    case "form":
      return (
        <div className="grid gap-3 sm:grid-cols-3">
          {t("Título", "heading", b.heading, 120)}
          {t("Texto", "text", b.text, 300)}
          {t("Texto del botón", "buttonLabel", b.buttonLabel, 40)}
          <p className="text-xs text-mute sm:col-span-3">Los campos, el consentimiento y la política de privacidad salen del formulario del CRM elegido en «Ajustes».</p>
        </div>
      );
  }
}

function Settings({ base, page, forms, canWrite, onSaved, onArchived }: { base: string; page: Page; forms: Array<{ id: string; name: string; status: string }>; canWrite: boolean; onSaved: () => void; onArchived: () => void }) {
  const [f, setF] = useState({ name: page.name, slug: page.slug, formId: page.form_id ?? "", noindex: page.noindex });
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: "ok" | "warn"; text: string } | null>(null);
  const save = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setMsg(null);
    try {
      await patch(`${base}/${page.id}`, { name: f.name, slug: f.slug, formId: f.formId || null, noindex: f.noindex });
      setMsg({ tone: "ok", text: "Ajustes guardados." });
      onSaved();
    } catch (x) {
      setMsg({ tone: "warn", text: errMsg(x) });
    } finally {
      setBusy(false);
    }
  };
  const archive = async () => {
    if (!window.confirm("¿Archivar esta landing? Deja de contar en tu plan; las versiones y estadísticas se conservan.")) return;
    try {
      await patch(`${base}/${page.id}`, { status: "archived" });
      onArchived();
    } catch (x) {
      setMsg({ tone: "warn", text: errMsg(x) });
    }
  };
  return (
    <Card title="Ajustes">
      <form onSubmit={save} className="grid gap-3 sm:grid-cols-2">
        <TextField label="Nombre interno" required maxLength={120} value={f.name} disabled={!canWrite} onChange={(e) => setF({ ...f, name: e.target.value })} />
        <TextField
          label="Dirección (slug)"
          required
          minLength={3}
          maxLength={60}
          pattern="[a-z0-9]+(-[a-z0-9]+)*"
          value={f.slug}
          disabled={!canWrite}
          hint={page.status === "published" ? "Cambiarla rompe los enlaces que ya hayas compartido." : "Minúsculas, números y guiones."}
          onChange={(e) => setF({ ...f, slug: e.target.value })}
        />
        <Field label="Formulario del CRM" htmlFor="lp-set-form" hint="Obligatorio si la landing tiene un bloque de formulario.">
          <Select id="lp-set-form" value={f.formId} disabled={!canWrite} onChange={(e) => setF({ ...f, formId: e.target.value })}>
            <option value="">Sin formulario</option>
            {forms
              .filter((x) => x.status !== "archived")
              .map((x) => (
                <option key={x.id} value={x.id}>
                  {x.name}
                  {x.status === "paused" ? " (en pausa)" : ""}
                </option>
              ))}
          </Select>
        </Field>
        <label className="flex min-h-10 items-center gap-2 self-end text-sm">
          <input type="checkbox" checked={f.noindex} disabled={!canWrite} onChange={(e) => setF({ ...f, noindex: e.target.checked })} /> No indexar en buscadores (noindex)
        </label>
        {msg && (
          <div className="sm:col-span-2">
            <Notice tone={msg.tone}>{msg.text}</Notice>
          </div>
        )}
        {canWrite && (
          <div className="flex flex-wrap gap-2 sm:col-span-2">
            <Button variant="primary" type="submit" loading={busy}>
              Guardar ajustes
            </Button>
            {page.status !== "published" && (
              <Button type="button" variant="danger" onClick={archive}>
                Archivar
              </Button>
            )}
          </div>
        )}
      </form>
    </Card>
  );
}

const VERDICT: Record<AbResult["verdict"], { label: string; tone: "neutral" | "ok" | "warn" | "info" }> = {
  insufficient_data: { label: "Aún sin datos suficientes", tone: "neutral" },
  no_significant_difference: { label: "Sin diferencia significativa", tone: "warn" },
  a_better: { label: "A convierte mejor (p < 0,05)", tone: "ok" },
  b_better: { label: "B convierte mejor (p < 0,05)", tone: "ok" },
};

function Experiment({
  base,
  id,
  page,
  versions,
  stats,
  canPublish,
  busy,
  run,
}: {
  base: string;
  id: string;
  page: Page;
  versions: Detail["versions"];
  stats: Detail["stats"];
  canPublish: boolean;
  busy: string | null;
  run: (key: string, fn: () => Promise<unknown>, ok: string) => Promise<void>;
}) {
  const candidates = versions.filter((v) => v.id !== page.published_version_id);
  const [vb, setVb] = useState(candidates[0]?.id ?? "");
  const [split, setSplit] = useState(50);
  const [hyp, setHyp] = useState("");
  const t = stats.test;
  const row = (label: string, c: Counts, rate: number | null | undefined) => (
    <tr className="border-t border-line">
      <th scope="row" className="py-2 pr-4 text-left font-medium">
        {label}
      </th>
      <td className="py-2 pr-4 tabular-nums">{c.views}</td>
      <td className="py-2 pr-4 tabular-nums">{c.conversions}</td>
      <td className="py-2 tabular-nums">{rate !== undefined ? pct(rate) : pct(c.views ? c.conversions / c.views : null)}</td>
    </tr>
  );
  return (
    <div className="space-y-4">
      <Card title="Resultados" subtitle={`Desde ${fmtDate(stats.since)} · medición: observada (servidor, sin cookies).`}>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[420px] text-sm">
            <thead>
              <tr className="text-left text-xs text-mute">
                <th scope="col" className="pb-2 font-normal">
                  Variante
                </th>
                <th scope="col" className="pb-2 font-normal">
                  Visitas
                </th>
                <th scope="col" className="pb-2 font-normal">
                  Conversiones
                </th>
                <th scope="col" className="pb-2 font-normal">
                  Tasa
                </th>
              </tr>
            </thead>
            <tbody>
              {row(page.experiment_status === "none" ? "Publicada" : "A (publicada)", stats.a, t?.a.rate)}
              {page.experiment_status !== "none" && row("B", stats.b, t?.b.rate)}
            </tbody>
          </table>
        </div>
        {t && (
          <div className="mt-3 space-y-2 text-sm">
            <p>
              <Badge tone={VERDICT[t.verdict].tone}>{VERDICT[t.verdict].label}</Badge>
              <span className="ml-2 text-mute">
                p = {t.pValue === null ? "—" : t.pValue.toLocaleString("es-ES")} · diferencia relativa B frente a A: {t.relativeLift === null ? "—" : `${t.relativeLift > 0 ? "+" : ""}${(t.relativeLift * 100).toFixed(1).replace(".", ",")} %`}
              </span>
            </p>
            <ul className="list-disc space-y-1 pl-5 text-xs text-mute">
              {t.warnings.map((w) => (
                <li key={w}>{w}</li>
              ))}
            </ul>
          </div>
        )}
        <ul className="mt-3 list-disc space-y-1 pl-5 text-xs text-mute">
          {stats.caveats.map((c) => (
            <li key={c}>{c}</li>
          ))}
        </ul>
      </Card>

      <Card
        title={
          <>
            <FlaskConical className="mr-1 inline size-4" aria-hidden /> Test A/B
          </>
        }
        subtitle="A es la versión publicada; B, otra versión guardada. Cada visitante ve siempre la misma variante desde su conexión, sin cookies."
      >
        {page.experiment_status === "running" ? (
          <div className="space-y-3 text-sm">
            <p>
              En marcha desde {fmtDate(page.experiment_started_at)} · {100 - page.split_b} % A / {page.split_b} % B.
            </p>
            {page.experiment_hypothesis && <p className="text-mute">Hipótesis: {page.experiment_hypothesis}</p>}
            {canPublish && (
              <Button variant="danger" loading={busy === "stop"} onClick={() => run("stop", () => post(`${base}/${id}/experiment`, { action: "stop" }), "Test detenido: todos ven ya la variante A.")}>
                Detener test
              </Button>
            )}
          </div>
        ) : (
          <div className="space-y-3 text-sm">
            {page.experiment_status === "stopped" && page.variant_b_version_id && (
              <div className="flex flex-wrap items-center gap-2 rounded-xl border border-line p-3">
                <span>Último test detenido.{page.experiment_hypothesis ? ` Hipótesis: ${page.experiment_hypothesis}` : ""}</span>
                {canPublish && page.published_version_id !== page.variant_b_version_id && (
                  <Button loading={busy === "promote"} onClick={() => run("promote", () => post(`${base}/${id}/experiment`, { action: "promote_b" }), "La variante B es ahora la versión publicada.")}>
                    Publicar la variante B
                  </Button>
                )}
              </div>
            )}
            {page.status !== "published" ? (
              <Notice tone="info">Publica la landing para poder empezar un test A/B.</Notice>
            ) : candidates.length === 0 ? (
              <Notice tone="info">Guarda otra versión con el cambio que quieras probar (por ejemplo, otro titular) para usarla como variante B.</Notice>
            ) : canPublish ? (
              <form
                className="grid gap-3 sm:grid-cols-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  void run("start", () => post(`${base}/${id}/experiment`, { action: "start", variantBVersionId: vb, split, hypothesis: hyp }), "Test A/B en marcha.");
                }}
              >
                <Field label="Variante B" htmlFor="ab-vb">
                  <Select id="ab-vb" value={vb} onChange={(e) => setVb(e.target.value)}>
                    {candidates.map((v) => (
                      <option key={v.id} value={v.id}>
                        Versión {v.version}
                        {v.note ? ` · ${v.note}` : ""}
                      </option>
                    ))}
                  </Select>
                </Field>
                <Field label={`Tráfico a B: ${split} %`} htmlFor="ab-split">
                  <input id="ab-split" type="range" min={5} max={95} step={5} value={split} onChange={(e) => setSplit(Number(e.target.value))} className="w-full accent-[var(--accent)]" />
                </Field>
                <div className="sm:col-span-2">
                  <Field label="Hipótesis" htmlFor="ab-hyp" hint="Qué cambias, por qué y qué esperas. Decide antes cuántas visitas necesitas y no pares el test al primer resultado.">
                    <Textarea id="ab-hyp" required minLength={10} maxLength={500} value={hyp} onChange={(e) => setHyp(e.target.value)} placeholder="Si el titular habla del resultado en vez del servicio, más visitantes dejarán sus datos." />
                  </Field>
                </div>
                <div className="sm:col-span-2">
                  <Button variant="primary" type="submit" loading={busy === "start"}>
                    Empezar test
                  </Button>
                </div>
              </form>
            ) : (
              <p className="text-mute">Solo propietario, administración y responsable de marketing pueden empezar tests.</p>
            )}
          </div>
        )}
      </Card>
    </div>
  );
}
