import { useMemo, useState } from "react";
import { Link, useParams } from "react-router";
import { ArrowRight, Check, Download, ExternalLink, FileSearch, Lock, Plus, Trash2, X } from "lucide-react";
import { ApiError, fmtDate, patch, post, put, timeAgo } from "../lib/api";
import { useApi } from "../lib/hooks";
import { Badge, Button, Card, cx, EmptyState, ErrorState, Input, Notice, PageHeader, Select, SEVERITY, SeverityBadge, Spinner, Textarea } from "../ui";

export function AuditsPage() {
  const { orgId } = useParams();
  const { data, error, loading, reload } = useApi<any>(`/orgs/${orgId}/crawls`);
  return (
    <>
      <PageHeader eyebrow="Auditoría web" title="Auditorías" actions={<Link className="inline-flex min-h-10 items-center rounded-full bg-accent px-4 text-sm font-semibold text-accent-ink" to={`/o/${orgId}/analyze`}>Nueva auditoría</Link>} />
      <ErrorState error={error} onRetry={reload} />
      {loading && !data ? (
        <Spinner />
      ) : !data?.items.length ? (
        <EmptyState icon={<FileSearch className="size-8" />} title="Sin auditorías" action={<Link className="text-sm font-semibold text-accent-text" to={`/o/${orgId}/analyze`}>Auditar una web →</Link>} />
      ) : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {data.items.map((c: any) => (
            <Link key={c.id} to={c.status === "completed" ? `/o/${orgId}/audits/${c.id}` : `/o/${orgId}/jobs/${c.job_id}`} className="group rounded-2xl border border-line bg-surface p-5 transition hover:border-accent-text/40">
              <div className="flex items-start justify-between gap-2">
                <p className="truncate font-medium">{new URL(c.origin).hostname}</p>
                <Badge tone={c.status === "completed" ? "ok" : c.status === "failed" ? "danger" : "info"}>{c.status === "completed" ? "Completada" : c.status === "failed" ? "Fallida" : c.status === "cancelled" ? "Cancelada" : "En curso"}</Badge>
              </div>
              <p className="mt-4 font-serif text-5xl tabular-nums">{c.health_score ?? "—"}<span className="font-sans text-sm text-mute">/100</span></p>
              <p className="mt-2 text-sm text-mute">
                {c.pages_count} páginas · {c.issues_count} hallazgos · {timeAgo(c.started_at)}
              </p>
            </Link>
          ))}
        </div>
      )}
    </>
  );
}

export function AuditDetailPage() {
  const { orgId, crawlId } = useParams();
  const { data, error, loading, reload } = useApi<any>(`/orgs/${orgId}/crawls/${crawlId}`);
  const [sev, setSev] = useState("all");
  const [tab, setTab] = useState<"opps" | "issues" | "pages">("opps");
  const [openIssue, setOpenIssue] = useState<string | null>(null);
  const issues = useMemo(() => (data?.issues ?? []).filter((i: any) => sev === "all" || i.severity === sev), [data, sev]);
  if (loading && !data) return <Spinner />;
  if (error) return <ErrorState error={error} onRetry={reload} />;
  const c = data.crawl;
  return (
    <>
      <PageHeader
        eyebrow={`Auditoría · ${fmtDate(c.completed_at ?? c.started_at)}`}
        title={new URL(c.origin).hostname}
        subtitle={`${c.pages_count} páginas analizadas de un máximo de ${c.pages_limit}. ${c.verification_status === "verified" ? "Propiedad verificada." : "Propiedad no verificada: solo análisis público de solo lectura."}`}
        actions={
          <>
            <Link className="inline-flex min-h-10 items-center rounded-full border border-line px-4 text-sm font-semibold hover:bg-surface-2" to={`/o/${orgId}/brands/${c.brand_id}`}>Marca</Link>
            {data.planId && (
              <Link className="inline-flex min-h-10 items-center gap-2 rounded-full bg-accent px-4 text-sm font-semibold text-accent-ink" to={`/o/${orgId}/plans/${data.planId}`}>
                Plan de 30 días <ArrowRight className="size-4" />
              </Link>
            )}
          </>
        }
      />
      <div className="mb-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-5">
        <div className="rounded-2xl border border-line bg-surface p-4">
          <p className="text-sm text-mute">Salud técnica</p>
          <p className="mt-1 font-serif text-5xl tabular-nums">{c.health_score}<span className="font-sans text-sm text-mute">/100</span></p>
          <p className="mt-2 text-xs text-mute">{c.health_method}</p>
        </div>
        {[
          ["robots.txt", c.robots_found],
          ["Sitemap XML", c.sitemap_found],
          ["HTTPS", c.served_over_https],
          ["llms.txt (opcional)", c.llms_txt_found],
        ].map(([k, v]) => (
            <div key={k as string} className="rounded-2xl border border-line bg-surface p-4">
              <p className="text-sm text-mute">{k}</p>
              <p className={cx("mt-2 flex items-center gap-2 text-lg font-semibold", v ? "text-ok" : "text-danger")}>{v ? <Check className="size-5" /> : <X className="size-5" />} {v ? "Detectado" : "No detectado"}</p>
              {k === "Sitemap XML" && v ? <p className="text-xs text-mute">{c.sitemap_url_count} URLs</p> : null}
            </div>
          ))}
      </div>

      <div role="tablist" className="mb-4 inline-flex rounded-full border border-line bg-surface p-1 text-sm">
        {(
          [
            ["opps", `Top mejoras (${c.opportunities.length})`],
            ["issues", `Hallazgos (${data.issues.length})`],
            ["pages", `Páginas (${data.pages.length})`],
          ] as const
        ).map(([k, l]) => (
          <button key={k} role="tab" aria-selected={tab === k} onClick={() => setTab(k)} className={cx("rounded-full px-4 py-1.5 font-medium", tab === k ? "bg-accent text-accent-ink" : "text-mute hover:text-ink")}>
            {l}
          </button>
        ))}
      </div>

      {tab === "opps" && (
        <ol className="space-y-3">
          {c.opportunities.map((o: any, i: number) => (
            <li key={o.ruleKey} className="rounded-2xl border border-line bg-surface p-5">
              <div className="flex flex-wrap items-start gap-3">
                <span className="font-serif text-3xl leading-none text-accent-text tabular-nums">{String(i + 1).padStart(2, "0")}</span>
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <h3 className="font-semibold">{o.title}</h3>
                    <SeverityBadge s={o.severity} />
                    <Badge>{o.category}</Badge>
                  </div>
                  <p className="mt-1 text-sm text-mute">{o.fix}</p>
                  <p className="mt-2 text-xs text-mute">
                    Impacto {o.impact}/5 · Esfuerzo {o.effort}/5 · Certeza {Math.round(o.certainty * 100)}% · Puntuación {o.score} · {o.affectedCount ? `${o.affectedCount} URL(s)` : "todo el sitio"}
                  </p>
                </div>
              </div>
            </li>
          ))}
          {c.opportunities.length === 0 && <EmptyState title="No hemos encontrado mejoras prioritarias" />}
        </ol>
      )}

      {tab === "issues" && (
        <Card
          title="Hallazgos con evidencia"
          actions={
            <label className="flex items-center gap-2 text-sm">
              <span className="text-mute">Severidad</span>
              <Select value={sev} onChange={(e) => setSev(e.target.value)} className="w-36 py-1.5">
                <option value="all">Todas</option>
                {Object.entries(SEVERITY).map(([k, v]) => (
                  <option key={k} value={k}>
                    {v.label}
                  </option>
                ))}
              </Select>
            </label>
          }
        >
          <ul className="divide-y divide-line">
            {issues.map((i: any) => (
              <li key={i.id} className="py-3">
                <button className="flex w-full flex-wrap items-center gap-2 text-left" onClick={() => setOpenIssue(openIssue === i.id ? null : i.id)} aria-expanded={openIssue === i.id}>
                  <SeverityBadge s={i.severity} />
                  <span className="font-medium">{i.title}</span>
                  <span className="min-w-0 flex-1 truncate text-sm text-mute">{i.url ?? "Todo el sitio"}</span>
                </button>
                {openIssue === i.id && (
                  <div className="mt-3 space-y-2 rounded-xl bg-surface-2 p-3 text-sm">
                    <p>{i.fix}</p>
                    <p className="text-xs text-mute">Regla: <code className="font-mono">{i.rule_key}</code></p>
                    <pre className="overflow-x-auto whitespace-pre-wrap break-all rounded-lg bg-bg p-3 font-mono text-xs">{JSON.stringify(i.evidence, null, 2)}</pre>
                  </div>
                )}
              </li>
            ))}
            {issues.length === 0 && <li className="py-6 text-center text-sm text-mute">No hay hallazgos con este filtro.</li>}
          </ul>
        </Card>
      )}

      {tab === "pages" && (
        <div className="overflow-x-auto rounded-2xl border border-line bg-surface">
          <table className="w-full min-w-[760px] text-sm">
            <thead className="border-b border-line text-left text-xs text-mute">
              <tr>
                <th className="px-4 py-3 font-medium">URL</th>
                <th className="px-4 py-3 font-medium">HTTP</th>
                <th className="px-4 py-3 font-medium">Título</th>
                <th className="px-4 py-3 font-medium">H1</th>
                <th className="px-4 py-3 font-medium">Palabras</th>
                <th className="px-4 py-3 font-medium">ms</th>
              </tr>
            </thead>
            <tbody>
              {data.pages.map((p: any) => (
                <tr key={p.id} className="border-b border-line align-top last:border-0">
                  <td className="max-w-[260px] px-4 py-3">
                    <a href={p.final_url} target="_blank" rel="noopener noreferrer nofollow" className="inline-flex items-center gap-1 break-all hover:underline">
                      {new URL(p.final_url).pathname} <ExternalLink className="size-3 shrink-0" />
                    </a>
                  </td>
                  <td className="px-4 py-3 tabular-nums">{p.status_code}</td>
                  <td className="max-w-[240px] px-4 py-3">{p.title ?? <span className="text-danger">—</span>}</td>
                  <td className="max-w-[200px] px-4 py-3">{p.h1 ?? <span className="text-danger">—</span>}</td>
                  <td className="px-4 py-3 tabular-nums">{p.word_count ?? "—"}</td>
                  <td className="px-4 py-3 tabular-nums">{p.duration_ms}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="mt-6">
        <Notice title="Metodología y límites">
          <p>Fuente: {data.methodology.source}.</p>
          <ul className="mt-1 list-disc pl-4">
            {data.methodology.limitations.map((l: string) => (
              <li key={l}>{l}</li>
            ))}
          </ul>
          {c.skipped.length > 0 && <p className="mt-1">{c.skipped.length} URL(s) omitidas (robots.txt, errores o redirecciones fuera del dominio).</p>}
        </Notice>
      </div>
    </>
  );
}

export function BrandsPage() {
  const { orgId } = useParams();
  const { data, error, loading, reload } = useApi<any>(`/orgs/${orgId}/brands`);
  return (
    <>
      <PageHeader eyebrow="Proyectos y marcas" title="Marcas" subtitle="Cada marca tiene un perfil centralizado que usan todos los módulos y agentes." />
      <ErrorState error={error} onRetry={reload} />
      {loading && !data ? (
        <Spinner />
      ) : !data?.items.length ? (
        <EmptyState title="Sin marcas" action={<Link className="text-sm font-semibold text-accent-text" to={`/o/${orgId}/analyze`}>Crea una auditando su web →</Link>} />
      ) : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {data.items.map((b: any) => (
            <Link key={b.id} to={`/o/${orgId}/brands/${b.id}`} className="rounded-2xl border border-line bg-surface p-5 hover:border-accent-text/40">
              <div className="flex items-start justify-between gap-2">
                <p className="font-serif text-3xl leading-none">{b.name}</p>
                {b.confirmed_at ? <Badge tone="ok">Confirmada</Badge> : <Badge tone="warn">Por confirmar</Badge>}
              </div>
              <p className="mt-2 text-sm text-mute">{b.origin ?? b.domain ?? "Sin sitio"}</p>
            </Link>
          ))}
        </div>
      )}
    </>
  );
}

const METHOD_LABEL: Record<string, string> = { "json-ld": "JSON-LD", meta: "Meta tag", "open-graph": "Open Graph", heading: "Encabezado", link: "Enlace", html: "HTML", title: "Título", user: "Añadido por ti" };

export function BrandPage() {
  const { orgId, brandId } = useParams();
  const { data, error, loading, reload } = useApi<any>(`/orgs/${orgId}/brands/${brandId}/profile`);
  const [draft, setDraft] = useState<any>(null);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<{ tone: "ok" | "warn"; text: string } | null>(null);
  const [apiErr, setApiErr] = useState<ApiError | null>(null);
  const p = draft ?? data?.profile;

  if (loading && !data) return <Spinner />;
  if (error) return <ErrorState error={error} onRetry={reload} />;
  if (!data.profile)
    return (
      <>
        <PageHeader eyebrow="Perfil de marca" title={data.brand.name} />
        <EmptyState title="Aún no hay perfil" action={<Link className="text-sm font-semibold text-accent-text" to={`/o/${orgId}/analyze`}>Audita su web para extraerlo →</Link>}>
          El perfil se genera a partir de la web pública y luego lo validas tú.
        </EmptyState>
      </>
    );

  // Warnings and "missing" are stored at extraction time; hide the ones the user has already resolved.
  const liveFacts = (key: string) => p.facts.filter((f: any) => f.key === key && f.status !== "rejected").length;
  const warnings: string[] = p.warnings.filter((w: string) => !(w.startsWith("Hay varias variantes del nombre") && liveFacts("name") <= 1));
  const resolved: Record<string, boolean> = {
    name: liveFacts("name") > 0,
    description: liveFacts("description") > 0,
    audience: !!p.audience?.trim(),
    tone: !!p.tone?.trim(),
    objective: !!p.objective,
  };
  const missing: any[] = p.missing.filter((m: any) => !resolved[m.key]);

  const edit = (fn: (d: any) => void) => {
    const d = structuredClone(p);
    fn(d);
    setDraft(d);
    setMsg(null);
  };
  const save = async () => {
    setSaving(true);
    setApiErr(null);
    try {
      await put(`/orgs/${orgId}/brands/${brandId}/profile`, {
        facts: p.facts,
        audience: p.audience,
        tone: p.tone,
        objective: p.objective,
        prohibitedClaims: p.prohibitedClaims,
        competitors: p.competitors,
      });
      setDraft(null);
      await reload();
      setMsg({ tone: "ok", text: "Cambios guardados. Recuerda confirmar el perfil." });
    } catch (e) {
      setApiErr(e as ApiError);
    } finally {
      setSaving(false);
    }
  };
  const confirm = async () => {
    setApiErr(null);
    try {
      if (draft) await save();
      await post(`/orgs/${orgId}/brands/${brandId}/profile/confirm`);
      await reload();
      setMsg({ tone: "ok", text: "Perfil confirmado. Los agentes usarán estos datos como fuente de verdad." });
    } catch (e) {
      setApiErr(e as ApiError);
    }
  };

  return (
    <>
      <PageHeader
        eyebrow={`Perfil de marca · versión ${p.version}`}
        title={data.brand.name}
        subtitle="Revisa lo que hemos extraído de la web pública. Cada dato indica su fuente. Rechaza lo incorrecto y completa lo que falta."
        actions={
          <>
            <Button onClick={save} loading={saving} disabled={!draft}>
              Guardar
            </Button>
            <Button variant="primary" onClick={confirm}>
              {p.confirmedAt ? "Reconfirmar" : "Confirmar perfil"}
            </Button>
          </>
        }
      />
      <div className="mb-4 space-y-3">
        {p.confirmedAt && !draft && <Notice tone="ok">Confirmado por {p.confirmedByName ?? "un miembro"} el {fmtDate(p.confirmedAt)}. Si lo editas tendrás que reconfirmarlo.</Notice>}
        {msg && <Notice tone={msg.tone}>{msg.text}</Notice>}
        {apiErr && <ErrorState error={apiErr} />}
        {warnings.map((w: string) => (
          <Notice key={w} tone="warn">{w}</Notice>
        ))}
      </div>
      <div className="grid gap-6 xl:grid-cols-[1fr_420px]">
        <Card title="Hechos extraídos" subtitle={`${p.facts.filter((f: any) => f.status !== "rejected").length} aceptados · fuente: auditoría ${p.sourceCrawlId?.slice(0, 8) ?? "—"}`}>
          <ul className="divide-y divide-line">
            {p.facts.map((f: any, idx: number) => (
              <li key={f.id} className={cx("flex flex-wrap items-start gap-3 py-3", f.status === "rejected" && "opacity-50")}>
                <div className="min-w-0 flex-1">
                  <p className="text-xs text-mute">{f.label}</p>
                  <Input
                    aria-label={f.label}
                    value={f.value}
                    disabled={f.status === "rejected"}
                    onChange={(e) =>
                      edit((d) => {
                        d.facts[idx].value = e.target.value;
                        if (d.facts[idx].status === "extracted") d.facts[idx].status = "edited";
                      })
                    }
                    className="mt-1"
                  />
                  <p className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-mute">
                    <Badge tone={f.confidence === "high" ? "ok" : f.confidence === "medium" ? "info" : "neutral"}>{f.confidence === "high" ? "Alta" : f.confidence === "medium" ? "Media" : "Baja"}</Badge>
                    {METHOD_LABEL[f.method] ?? f.method}
                    {f.sourceUrl && (
                      <a className="inline-flex items-center gap-0.5 hover:underline" href={f.sourceUrl} target="_blank" rel="noopener noreferrer nofollow">
                        · fuente <ExternalLink className="size-3" />
                      </a>
                    )}
                    {f.status === "edited" && <Badge tone="warn">Editado</Badge>}
                  </p>
                </div>
                <Button variant="ghost" aria-label={f.status === "rejected" ? "Restaurar" : "Rechazar"} onClick={() => edit((d) => (d.facts[idx].status = d.facts[idx].status === "rejected" ? "extracted" : "rejected"))}>
                  {f.status === "rejected" ? "Restaurar" : <Trash2 className="size-4" />}
                </Button>
              </li>
            ))}
          </ul>
          <div className="mt-3 flex flex-wrap gap-2">
            {!p.facts.some((f: any) => f.key === "name" && f.status !== "rejected") && (
              <Button
                variant="primary"
                onClick={() => edit((d) => d.facts.unshift({ id: `u${Date.now()}`, key: "name", label: "Nombre de la marca", value: data.brand.name, sourceUrl: null, method: "user", confidence: "high", status: "added" }))}
              >
                <Plus className="size-4" /> Añadir nombre de marca
              </Button>
            )}
            <Button onClick={() => edit((d) => d.facts.push({ id: `u${Date.now()}`, key: "custom", label: "Dato añadido", value: "Nuevo dato", sourceUrl: null, method: "user", confidence: "high", status: "added" }))}>
              <Plus className="size-4" /> Añadir dato
            </Button>
          </div>
        </Card>
        <div className="space-y-6">
          <Card title="Lo que solo tú sabes" subtitle="Nunca lo inferimos automáticamente.">
            <div className="space-y-4">
              <label className="block space-y-1.5 text-sm">
                <span className="font-medium">Público objetivo *</span>
                <Textarea value={p.audience} maxLength={2000} onChange={(e) => edit((d) => (d.audience = e.target.value))} placeholder="Ej.: pymes de servicios en Madrid que buscan captar clientes online" />
              </label>
              <label className="block space-y-1.5 text-sm">
                <span className="font-medium">Tono de voz</span>
                <Input value={p.tone} maxLength={1000} onChange={(e) => edit((d) => (d.tone = e.target.value))} placeholder="Cercano, experto, sin tecnicismos" />
              </label>
              <label className="block space-y-1.5 text-sm">
                <span className="font-medium">Objetivo comercial *</span>
                <Select value={p.objective} onChange={(e) => edit((d) => (d.objective = e.target.value))}>
                  <option value="">Elige…</option>
                  <option value="traffic">Tráfico</option>
                  <option value="leads">Leads / contactos</option>
                  <option value="sales">Ventas</option>
                  <option value="reputation">Reputación</option>
                </Select>
              </label>
              <ListEditor label="Afirmaciones prohibidas" hint="Claims que la IA nunca debe usar." values={p.prohibitedClaims} onChange={(v) => edit((d) => (d.prohibitedClaims = v))} />
              <ListEditor label="Competidores (dominios)" hint="SEO, comerciales o publicitarios." values={p.competitors} onChange={(v) => edit((d) => (d.competitors = v))} />
            </div>
          </Card>
          {missing.length > 0 && (
            <Card title="Información no encontrada">
              <ul className="space-y-2 text-sm">
                {missing.map((m: any) => (
                  <li key={m.key}>
                    <span className="font-medium">{m.label}:</span> <span className="text-mute">{m.hint}</span>
                  </li>
                ))}
              </ul>
            </Card>
          )}
        </div>
      </div>
    </>
  );
}

function ListEditor({ label, hint, values, onChange }: { label: string; hint: string; values: string[]; onChange: (v: string[]) => void }) {
  const [v, setV] = useState("");
  return (
    <div className="space-y-1.5 text-sm">
      <span className="font-medium">{label}</span>
      <p className="text-xs text-mute">{hint}</p>
      <div className="flex flex-wrap gap-1.5">
        {values.map((x, i) => (
          <span key={`${x}${i}`} className="inline-flex items-center gap-1 rounded-full border border-line px-2.5 py-1 text-xs">
            {x}
            <button aria-label={`Quitar ${x}`} onClick={() => onChange(values.filter((_, j) => j !== i))}>
              <X className="size-3" />
            </button>
          </span>
        ))}
      </div>
      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (v.trim()) onChange([...values, v.trim()]);
          setV("");
        }}
      >
        <Input value={v} onChange={(e) => setV(e.target.value)} aria-label={`Añadir a ${label}`} />
        <Button type="submit">Añadir</Button>
      </form>
    </div>
  );
}

const CHANNEL: Record<string, string> = { technical: "Técnico", brand: "Marca", content: "Contenido", geo: "GEO", paid: "Pago", measurement: "Medición" };
const TASK_STATUS: Record<string, { label: string; tone: "neutral" | "info" | "ok" | "warn" | "accent" }> = {
  todo: { label: "Pendiente", tone: "neutral" },
  doing: { label: "En curso", tone: "accent" },
  done: { label: "Hecho", tone: "ok" },
  dismissed: { label: "Descartado", tone: "neutral" },
  blocked: { label: "Bloqueado", tone: "warn" },
};

export function PlanPage() {
  const { orgId, planId } = useParams();
  const { data, error, loading, reload, setData } = useApi<any>(`/orgs/${orgId}/plans/${planId}`);
  const [err, setErr] = useState<ApiError | null>(null);
  if (loading && !data) return <Spinner />;
  if (error) return <ErrorState error={error} onRetry={reload} />;

  const update = async (taskId: string, body: Record<string, unknown>) => {
    setErr(null);
    const prev = data;
    setData({ ...data, tasks: data.tasks.map((t: any) => (t.id === taskId ? { ...t, ...body } : t)) });
    try {
      await patch(`/orgs/${orgId}/plans/${planId}/tasks/${taskId}`, body);
    } catch (e) {
      setData(prev);
      setErr(e as ApiError);
    }
  };
  const download = async (format: "md" | "json") => {
    const res = await fetch(`/api/v1/orgs/${orgId}/plans/${planId}/export?format=${format}`, { credentials: "same-origin" });
    const blob = await res.blob();
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `plan-dni-growth.${format}`;
    a.click();
    URL.revokeObjectURL(a.href);
  };
  const total = data.tasks.filter((t: any) => t.status !== "dismissed" && t.status !== "blocked");
  const done = total.filter((t: any) => t.status === "done").length;

  return (
    <>
      <PageHeader
        eyebrow="Plan de crecimiento · 30 días"
        title={data.plan.title.replace("Plan de crecimiento 30 días · ", "")}
        subtitle={data.disclaimer}
        actions={
          <>
            <Button onClick={() => download("md")}>
              <Download className="size-4" /> Markdown
            </Button>
            <Button onClick={() => download("json")}>
              <Download className="size-4" /> JSON
            </Button>
          </>
        }
      />
      <p className="mb-4 text-sm text-mute">
        {done} de {total.length} tareas activas completadas · actualizado {timeAgo(data.plan.updated_at)}
      </p>
      {err && (
        <div className="mb-4">
          <ErrorState error={err} />
        </div>
      )}
      <div className="grid gap-4 lg:grid-cols-2 2xl:grid-cols-4">
        {[1, 2, 3, 4].map((w) => (
          <section key={w} className="rounded-2xl border border-line bg-surface p-4" aria-label={`Semana ${w}`}>
            <h2 className="mb-3 font-serif text-2xl">Semana {w}</h2>
            <ul className="space-y-3">
              {data.tasks
                .filter((t: any) => t.week === w)
                .map((t: any) => (
                  <li key={t.id} className={cx("rounded-xl border border-line p-3", t.status === "done" && "opacity-60", t.status === "dismissed" && "opacity-40")}>
                    <div className="flex items-start justify-between gap-2">
                      <p className={cx("text-sm font-medium", t.status === "done" && "line-through")}>{t.title}</p>
                      <Badge tone={TASK_STATUS[t.status]?.tone}>{TASK_STATUS[t.status]?.label}</Badge>
                    </div>
                    <p className="mt-1 text-xs text-mute">{t.description}</p>
                    <div className="mt-2 flex flex-wrap items-center gap-1.5 text-xs text-mute">
                      <Badge>{CHANNEL[t.channel] ?? t.channel}</Badge>~{t.estimate_hours} h estimadas
                      {t.requires_approval && <Badge tone="warn">Requiere aprobación</Badge>}
                    </div>
                    {t.status === "blocked" ? (
                      <p className="mt-2 flex items-center gap-1 text-xs text-warn">
                        <Lock className="size-3" /> {t.blocked_reason}
                      </p>
                    ) : (
                      <div className="mt-3 flex flex-wrap gap-1.5">
                        <Select aria-label="Estado" className="w-auto py-1 text-xs" value={t.status} onChange={(e) => update(t.id, { status: e.target.value })}>
                          <option value="todo">Pendiente</option>
                          <option value="doing">En curso</option>
                          <option value="done">Hecho</option>
                          <option value="dismissed">Descartar</option>
                        </Select>
                        <Select aria-label="Semana" className="w-auto py-1 text-xs" value={t.week} onChange={(e) => update(t.id, { week: Number(e.target.value) })}>
                          {[1, 2, 3, 4].map((x) => (
                            <option key={x} value={x}>
                              Semana {x}
                            </option>
                          ))}
                        </Select>
                      </div>
                    )}
                  </li>
                ))}
            </ul>
          </section>
        ))}
      </div>
    </>
  );
}

