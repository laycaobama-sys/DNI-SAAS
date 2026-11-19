import { useState, type FormEvent } from "react";
import { Link, useParams } from "react-router";
import { Download, ExternalLink, Gauge, Link2, RefreshCw, Search, Trash2 } from "lucide-react";
import { ApiError, del, fmtDate, patch, post, timeAgo } from "../lib/api";
import { useApi } from "../lib/hooks";
import { Badge, Button, Card, EmptyState, ErrorState, Field, Input, Notice, PageHeader, Select, SeverityBadge, Skeleton, Textarea, TextField } from "../ui";
import { useOrgAccess } from "./org";

const errMsg = (e: unknown) => (e instanceof ApiError ? e.message : "No se pudo completar la acción.");
const nf = (n: number | null | undefined, d = 0) => (n === null || n === undefined ? "—" : n.toLocaleString("es-ES", { maximumFractionDigits: d }));
const linkCls = "inline-flex min-h-10 items-center gap-2 rounded-full border border-line px-4 text-sm font-semibold hover:bg-surface-2";

// ── SEO técnico ───────────────────────────────────────────────────────────────────────────────
export function SeoTecnicoPage() {
  const { orgId } = useParams();
  const { data, error, loading, reload } = useApi<any>(`/orgs/${orgId}/seo/overview`);
  return (
    <>
      <PageHeader
        eyebrow="Orgánico · SEO técnico"
        title="Salud técnica a lo largo del tiempo"
        subtitle="Histórico de tus auditorías, comparación entre dos rastreos y seguimiento de cada incidencia hasta que esté corregida."
        actions={<Link to={`/o/${orgId}/analyze`} className={linkCls}><RefreshCw className="size-4" /> Nueva auditoría</Link>}
      />
      <ErrorState error={error} onRetry={reload} />
      {loading && !data && <Skeleton className="h-64 rounded-2xl" />}
      {data && data.sites.length === 0 && (
        <EmptyState icon={<Gauge className="size-8" />} title="Aún no hay auditorías completadas" action={<Link className="text-sm font-semibold text-accent-text hover:underline" to={`/o/${orgId}/analyze`}>Auditar mi web →</Link>}>
          Cada auditoría guarda sus incidencias. Con dos o más podrás ver qué se ha resuelto y qué es nuevo.
        </EmptyState>
      )}
      <div className="space-y-6">
        {data?.sites.map((s: any) => <SiteHistory key={s.siteId} orgId={orgId!} site={s} />)}
      </div>
      {data && <p className="mt-6 text-xs text-mute">Fuente: {data.source}. La salud es un indicador interno basado en reglas técnicas; no predice posiciones en Google.</p>}
    </>
  );
}

function SiteHistory({ orgId, site }: { orgId: string; site: any }) {
  const crawls = site.crawls as any[];
  const [cur, setCur] = useState<string>(crawls[0]?.id ?? "");
  const [base, setBase] = useState<string>(crawls[1]?.id ?? "");
  const max = 100;
  return (
    <Card title={site.origin} subtitle={`${crawls.length} auditorías completadas`}>
      <div className="flex h-28 items-end gap-1.5" role="img" aria-label={`Evolución de la salud técnica: ${crawls.map((c) => c.health_score ?? "sin dato").reverse().join(", ")}`}>
        {[...crawls].reverse().map((c) => (
          <div key={c.id} className="group relative flex flex-1 flex-col items-center justify-end" title={`${fmtDate(c.started_at)} · salud ${c.health_score ?? "—"} · ${c.issues} incidencias`}>
            <span className="mb-1 text-[11px] tabular-nums text-mute">{c.health_score ?? "—"}</span>
            <div className="w-full max-w-10 rounded-t bg-accent/80" style={{ height: `${Math.max(4, ((c.health_score ?? 0) / max) * 80)}px` }} />
          </div>
        ))}
      </div>
      <div className="mt-4 overflow-x-auto">
        <table className="w-full min-w-[560px] text-sm">
          <thead className="text-left text-xs text-mute">
            <tr><th className="py-2 pr-3 font-medium">Fecha</th><th className="pr-3 font-medium">Salud</th><th className="pr-3 font-medium">Páginas</th><th className="pr-3 font-medium">Incidencias</th><th className="pr-3 font-medium">Graves</th><th className="pr-3 font-medium">Abiertas</th><th /></tr>
          </thead>
          <tbody>
            {crawls.map((c) => (
              <tr key={c.id} className="border-t border-line">
                <td className="py-2 pr-3">{fmtDate(c.started_at)}</td>
                <td className="pr-3 tabular-nums">{c.health_score ?? "—"}</td>
                <td className="pr-3 tabular-nums">{c.pages_count}</td>
                <td className="pr-3 tabular-nums">{c.issues}</td>
                <td className="pr-3 tabular-nums">{c.serious}</td>
                <td className="pr-3 tabular-nums">{c.open_issues}</td>
                <td className="whitespace-nowrap py-1 text-right">
                  <Link className="text-accent-text hover:underline" to={`/o/${orgId}/audits/${c.id}`}>Ver</Link>
                  <a className="ml-3 text-accent-text hover:underline" href={`/api/v1/orgs/${orgId}/seo/issues.csv?crawlId=${c.id}`}>CSV</a>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {crawls.length >= 2 ? (
        <div className="mt-6 border-t border-line pt-4">
          <h3 className="font-semibold">Comparar dos auditorías</h3>
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <Field label="Auditoría reciente" htmlFor={`cur-${site.siteId}`}>
              <Select id={`cur-${site.siteId}`} value={cur} onChange={(e) => setCur(e.target.value)}>{crawls.map((c) => <option key={c.id} value={c.id}>{fmtDate(c.started_at)} · salud {c.health_score ?? "—"}</option>)}</Select>
            </Field>
            <Field label="Comparar con" htmlFor={`base-${site.siteId}`}>
              <Select id={`base-${site.siteId}`} value={base} onChange={(e) => setBase(e.target.value)}>{crawls.map((c) => <option key={c.id} value={c.id}>{fmtDate(c.started_at)} · salud {c.health_score ?? "—"}</option>)}</Select>
            </Field>
          </div>
          {cur && base && cur !== base && <Compare orgId={orgId} cur={cur} base={base} />}
        </div>
      ) : (
        <p className="mt-4 text-sm text-mute">Lanza otra auditoría de este sitio para comparar la evolución.</p>
      )}
    </Card>
  );
}

function Compare({ orgId, cur, base }: { orgId: string; cur: string; base: string }) {
  const access = useOrgAccess(orgId);
  const { data, error, reload } = useApi<any>(`/orgs/${orgId}/seo/compare?crawlId=${cur}&baseId=${base}`);
  const [msg, setMsg] = useState<string | null>(null);
  const mark = async (id: string, status: string) => {
    try {
      await patch(`/orgs/${orgId}/seo/issues/${id}`, { status });
      reload();
    } catch (e) {
      setMsg(errMsg(e));
    }
  };
  if (error) return <ErrorState error={error} onRetry={reload} />;
  if (!data) return <Skeleton className="mt-4 h-24 rounded-xl" />;
  return (
    <div className="mt-4 space-y-4">
      <div className="flex flex-wrap gap-2">
        <Badge tone={data.healthDelta > 0 ? "ok" : data.healthDelta < 0 ? "danger" : "neutral"}>Salud {data.healthDelta === null ? "—" : `${data.healthDelta > 0 ? "+" : ""}${data.healthDelta}`}</Badge>
        <Badge tone="danger">{data.newIssues.length} nuevas</Badge>
        <Badge tone="ok">{data.resolved.length} resueltas</Badge>
        <Badge>{data.persisting} siguen</Badge>
      </div>
      {msg && <Notice tone="warn">{msg}</Notice>}
      <div className="grid gap-4 lg:grid-cols-2">
        <div>
          <h4 className="text-sm font-semibold">Nuevas incidencias</h4>
          <ul className="mt-2 space-y-2 text-sm">
            {data.newIssues.length === 0 && <li className="text-mute">Ninguna.</li>}
            {data.newIssues.slice(0, 50).map((i: any) => (
              <li key={i.id} className="rounded-lg border border-line p-2">
                <div className="flex flex-wrap items-center gap-2"><SeverityBadge s={i.severity} /> <span className="font-medium">{i.title}</span></div>
                <p className="mt-1 break-all text-xs text-mute">{i.url ?? "Todo el sitio"}</p>
                {access.can("plan:write") && (
                  <div className="mt-2 flex gap-2">
                    <Button className="min-h-8 px-3 text-xs" onClick={() => mark(i.id, "fixed")} disabled={i.status === "fixed"}>Marcar corregida</Button>
                    <Button className="min-h-8 px-3 text-xs" onClick={() => mark(i.id, "ignored")} disabled={i.status === "ignored"}>Ignorar</Button>
                    {i.status !== "open" && <Badge>{i.status === "fixed" ? "Corregida" : "Ignorada"}</Badge>}
                  </div>
                )}
              </li>
            ))}
          </ul>
        </div>
        <div>
          <h4 className="text-sm font-semibold">Resueltas desde la auditoría anterior</h4>
          <ul className="mt-2 space-y-2 text-sm">
            {data.resolved.length === 0 && <li className="text-mute">Ninguna.</li>}
            {data.resolved.slice(0, 50).map((i: any) => (
              <li key={i.id} className="rounded-lg border border-line p-2"><span className="font-medium">{i.title}</span><p className="mt-1 break-all text-xs text-mute">{i.url ?? "Todo el sitio"}</p></li>
            ))}
          </ul>
        </div>
      </div>
      <p className="text-xs text-mute">{data.caveat}</p>
    </div>
  );
}

// ── Keywords y competencia ──────────────────────────────────────────────────────────────────────
const INTENT: Record<string, string> = { informational: "Informativa", commercial: "Comercial", transactional: "Transaccional", navigational: "De marca", unclear: "Sin clasificar" };
const OPP: Record<string, { label: string; tone: "ok" | "warn" | "info" | "neutral" }> = {
  top_position: { label: "Top 3", tone: "ok" },
  striking_distance: { label: "Cerca del top (4–20)", tone: "warn" },
  low_ctr: { label: "CTR bajo", tone: "info" },
  low_visibility: { label: "Poca visibilidad", tone: "neutral" },
};
const KSTATUS: Record<string, string> = { idea: "Idea", planned: "Planificada", covered: "Cubierta", discarded: "Descartada" };

export function KeywordsPage() {
  const { orgId } = useParams();
  const access = useOrgAccess(orgId);
  const { data, error, loading, reload } = useApi<any>(`/orgs/${orgId}/keywords/overview`);
  const [kw, setKw] = useState("");
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ tone: "ok" | "warn"; text: string } | null>(null);
  const [analysis, setAnalysis] = useState<any>(null);
  const [filter, setFilter] = useState("all");
  const canWrite = access.can("content:write");
  const save = async (keyword: string, source = "manual") => {
    setBusy(`kw:${keyword}`);
    setMsg(null);
    try {
      await post(`/orgs/${orgId}/keywords`, { keyword, source });
      setMsg({ tone: "ok", text: `«${keyword}» añadida a tu lista.` });
      setKw("");
      reload();
    } catch (e) {
      setMsg({ tone: "warn", text: errMsg(e) });
    } finally {
      setBusy(null);
    }
  };
  const analyse = async (e: FormEvent) => {
    e.preventDefault();
    setBusy("comp");
    setMsg(null);
    try {
      setAnalysis(await post(`/orgs/${orgId}/keywords/competitors`, { url }));
      reload();
    } catch (err) {
      setMsg({ tone: "warn", text: errMsg(err) });
    } finally {
      setBusy(null);
    }
  };
  const rows = (data?.gsc.rows ?? []).filter((r: any) => filter === "all" || r.opportunities.includes(filter));
  return (
    <>
      <PageHeader
        eyebrow="Orgánico · Keywords"
        title="Keywords y competencia con tus datos"
        subtitle="Consultas reales de Search Console, términos de tu web y análisis de páginas públicas de la competencia. Nunca inventamos volúmenes."
        actions={<a className={linkCls} href={`/api/v1/orgs/${orgId}/keywords.csv`}><Download className="size-4" /> Exportar lista</a>}
      />
      <ErrorState error={error} onRetry={reload} />
      {loading && !data && <Skeleton className="h-64 rounded-2xl" />}
      {msg && <div className="mb-4"><Notice tone={msg.tone}>{msg.text}</Notice></div>}
      {data && (
        <div className="space-y-6">
          <Notice tone="info" title="Datos no disponibles">{data.unavailable.join(", ")}: {data.unavailableReason}</Notice>
          <Card
            title="Consultas de Google Search Console"
            subtitle={data.gsc.connected ? `${data.gsc.property}${data.gsc.period ? ` · ${data.gsc.period.start} → ${data.gsc.period.end}` : ""}` : "No conectado"}
            actions={
              data.gsc.connected ? (
                <Select aria-label="Filtrar oportunidades" value={filter} onChange={(e) => setFilter(e.target.value)} className="min-h-9 w-auto">
                  <option value="all">Todas</option>
                  {Object.entries(OPP).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
                </Select>
              ) : undefined
            }
          >
            {!data.gsc.connected ? (
              <EmptyState icon={<Search className="size-8" />} title="Conecta Search Console" action={<Link className="text-sm font-semibold text-accent-text hover:underline" to={`/o/${orgId}/search-console`}>Conectar →</Link>}>
                Verás las búsquedas reales por las que Google ya te muestra, con clics, impresiones y posición media.
              </EmptyState>
            ) : rows.length === 0 ? (
              <p className="text-sm text-mute">Sin consultas para este filtro. Sincroniza Search Console para actualizar.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[720px] text-sm">
                  <thead className="text-left text-xs text-mute"><tr><th className="py-2 pr-3 font-medium">Consulta</th><th className="pr-3 text-right font-medium">Clics</th><th className="pr-3 text-right font-medium">Impr.</th><th className="pr-3 text-right font-medium">CTR</th><th className="pr-3 text-right font-medium">Posición</th><th className="pr-3 font-medium">Intención*</th><th className="pr-3 font-medium">Oportunidad*</th><th /></tr></thead>
                  <tbody>
                    {rows.slice(0, 100).map((r: any) => (
                      <tr key={r.key} className="border-t border-line">
                        <td className="max-w-[260px] break-words py-2 pr-3">{r.key}</td>
                        <td className="pr-3 text-right tabular-nums">{nf(r.clicks)}</td>
                        <td className="pr-3 text-right tabular-nums">{nf(r.impressions)}</td>
                        <td className="pr-3 text-right tabular-nums">{nf(r.ctr * 100, 1)} %</td>
                        <td className="pr-3 text-right tabular-nums">{nf(r.position, 1)}</td>
                        <td className="pr-3 text-xs">{INTENT[r.intent]}</td>
                        <td className="pr-3"><div className="flex flex-wrap gap-1">{r.opportunities.map((o: string) => <Badge key={o} tone={OPP[o]?.tone}>{OPP[o]?.label ?? o}</Badge>)}</div></td>
                        <td className="text-right">{canWrite && <Button className="min-h-8 px-3 text-xs" loading={busy === `kw:${r.key}`} onClick={() => save(r.key, "gsc")}>Guardar</Button>}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <p className="mt-2 text-xs text-mute">{data.gsc.note} *Derivado: la intención es una heurística por palabras.</p>
              </div>
            )}
          </Card>

          <div className="grid gap-6 xl:grid-cols-2">
            <Card title="Mi lista de keywords" subtitle={`${data.saved.length} guardadas`}>
              {canWrite && (
                <form className="mb-4 flex gap-2" onSubmit={(e) => { e.preventDefault(); if (kw.trim()) save(kw.trim()); }}>
                  <Input aria-label="Nueva keyword" placeholder="p. ej. pan de masa madre madrid" value={kw} onChange={(e) => setKw(e.target.value)} maxLength={120} />
                  <Button type="submit" variant="primary" loading={busy === `kw:${kw.trim()}`}>Añadir</Button>
                </form>
              )}
              {data.saved.length === 0 ? <p className="text-sm text-mute">Guarda consultas de Search Console, términos de tu web o huecos frente a la competencia.</p> : <SavedKeywords orgId={orgId!} items={data.saved} canWrite={canWrite} onChange={reload} />}
            </Card>
            <Card title="Términos de tu web" subtitle={data.site.origin ? `Última auditoría de ${data.site.origin}` : "Sin auditoría"}>
              {data.site.terms.length === 0 ? (
                <p className="text-sm text-mute">Audita tu web para extraer los términos de títulos, descripciones y H1.</p>
              ) : (
                <div className="flex flex-wrap gap-2">
                  {data.site.terms.map((t: any) => (
                    <button key={t.term} type="button" disabled={!canWrite} onClick={() => save(t.term, "site")} className="rounded-full border border-line px-3 py-1 text-sm hover:bg-surface-2 disabled:cursor-default" title={canWrite ? "Guardar en mi lista" : undefined}>
                      {t.term} <span className="text-xs text-mute">×{t.count}</span>
                    </button>
                  ))}
                </div>
              )}
            </Card>
          </div>

          <Card title="Analizar una página de la competencia" subtitle="Leemos UNA página pública (respetando su robots.txt) y comparamos sus términos con los de tu web.">
            {canWrite && (
              <form onSubmit={analyse} className="flex flex-col gap-2 sm:flex-row">
                <Input aria-label="URL de la competencia" type="url" required placeholder="https://competidor.es/servicio" value={url} onChange={(e) => setUrl(e.target.value)} />
                <Button type="submit" variant="primary" loading={busy === "comp"}>Analizar</Button>
              </form>
            )}
            {analysis && (
              <div className="mt-4 rounded-xl border border-line p-4">
                <p className="font-semibold">{analysis.title ?? analysis.url}</p>
                <p className="break-all text-xs text-mute">{analysis.url}</p>
                <h4 className="mt-3 text-sm font-semibold">Temas que trata y tu web no ({analysis.gap.length})</h4>
                <div className="mt-2 flex flex-wrap gap-2">
                  {analysis.gap.map((t: any) => (
                    <button key={t.term} type="button" onClick={() => save(t.term, "competitor")} className="rounded-full border border-line px-3 py-1 text-sm hover:bg-surface-2">{t.term} <span className="text-xs text-mute">×{t.count}</span></button>
                  ))}
                </div>
                <p className="mt-3 text-xs text-mute">{analysis.caveat}</p>
              </div>
            )}
            {data.competitors.length > 0 && (
              <ul className="mt-4 divide-y divide-line text-sm">
                {data.competitors.map((c: any) => (
                  <li key={c.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                    <span className="min-w-0 flex-1"><span className="font-medium">{c.title ?? c.host}</span> <span className="break-all text-xs text-mute">{c.url}</span><br /><span className="text-xs text-mute">{c.word_count ?? "—"} palabras · leída {timeAgo(c.fetched_at)} · {c.gap.length} huecos</span></span>
                    {canWrite && <Button className="min-h-8 px-3 text-xs" aria-label="Eliminar análisis" onClick={async () => { await del(`/orgs/${orgId}/keywords/competitors/${c.id}`); reload(); }}><Trash2 className="size-4" /></Button>}
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      )}
    </>
  );
}

function SavedKeywords({ orgId, items, canWrite, onChange }: { orgId: string; items: any[]; canWrite: boolean; onChange: () => void }) {
  const upd = async (id: string, body: Record<string, unknown>) => {
    await patch(`/orgs/${orgId}/keywords/${id}`, body);
    onChange();
  };
  return (
    <ul className="divide-y divide-line text-sm">
      {items.map((k) => (
        <li key={k.id} className="flex flex-wrap items-center gap-2 py-2">
          <span className="min-w-0 flex-1 break-words font-medium">{k.keyword}</span>
          <Badge>{INTENT[k.intent]}</Badge>
          {canWrite ? (
            <Select aria-label={`Estado de ${k.keyword}`} value={k.status} onChange={(e) => upd(k.id, { status: e.target.value })} className="min-h-8 w-auto py-0 text-xs">
              {Object.entries(KSTATUS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </Select>
          ) : (
            <Badge>{KSTATUS[k.status]}</Badge>
          )}
          {canWrite && <Button className="min-h-8 px-2" aria-label={`Eliminar ${k.keyword}`} onClick={async () => { await del(`/orgs/${orgId}/keywords/${k.id}`); onChange(); }}><Trash2 className="size-4" /></Button>}
        </li>
      ))}
    </ul>
  );
}

// ── Backlinks / Authority ─────────────────────────────────────────────────────────────────────
const BL: Record<string, { label: string; tone: "ok" | "warn" | "danger" | "neutral" | "info" }> = {
  unverified: { label: "Sin comprobar", tone: "neutral" },
  live: { label: "Activo", tone: "ok" },
  lost: { label: "No encontrado", tone: "danger" },
  error: { label: "Error al leer", tone: "warn" },
  blocked: { label: "Bloqueado (robots)", tone: "info" },
};

export function AuthorityPage() {
  const { orgId } = useParams();
  const access = useOrgAccess(orgId);
  const { data, error, loading, reload } = useApi<any>(`/orgs/${orgId}/backlinks`);
  const [src, setSrc] = useState("");
  const [dst, setDst] = useState("");
  const [csv, setCsv] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ tone: "ok" | "warn"; text: string } | null>(null);
  const canWrite = access.can("content:write");
  const run = async (key: string, fn: () => Promise<string>) => {
    setBusy(key);
    setMsg(null);
    try {
      setMsg({ tone: "ok", text: await fn() });
      reload();
    } catch (e) {
      setMsg({ tone: "warn", text: errMsg(e) });
    } finally {
      setBusy(null);
    }
  };
  return (
    <>
      <PageHeader
        eyebrow="Orgánico · Autoridad"
        title="Enlaces que apuntan a tu web"
        subtitle="Registra los enlaces que has conseguido (prensa, directorios, colaboraciones) y comprobamos si siguen activos leyendo la página de origen."
        actions={<a className={linkCls} href={`/api/v1/orgs/${orgId}/backlinks.csv`}><Download className="size-4" /> CSV</a>}
      />
      <ErrorState error={error} onRetry={reload} />
      {loading && !data && <Skeleton className="h-64 rounded-2xl" />}
      {msg && <div className="mb-4"><Notice tone={msg.tone}>{msg.text}</Notice></div>}
      {data && (
        <div className="space-y-6">
          <div className="grid gap-4 sm:grid-cols-3 xl:grid-cols-6">
            {[["Enlaces", data.summary.total], ["Activos", data.summary.live], ["No encontrados", data.summary.lost], ["Sin comprobar", data.summary.unverified], ["nofollow/sponsored", data.summary.nofollow], ["Dominios", data.summary.domains]].map(([l, v]) => (
              <div key={l as string} className="rounded-2xl border border-line bg-surface p-4"><p className="text-sm text-mute">{l}</p><p className="mt-1 font-serif text-3xl tabular-nums">{v as number}</p></div>
            ))}
          </div>
          <p className="text-xs text-mute">{data.note} Uso del plan: {data.usage.used} de {data.usage.limit}.</p>
          {canWrite && (
            <div className="grid gap-6 xl:grid-cols-2">
              <Card title="Añadir un enlace">
                <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); run("add", async () => { const r = await post(`/orgs/${orgId}/backlinks`, { sourceUrl: src, targetUrl: dst }); setSrc(""); return r.added ? "Enlace añadido. Pulsa «Comprobar» para verificarlo." : "Ese enlace ya estaba registrado."; }); }}>
                  <TextField label="Página que enlaza (origen)" type="url" required value={src} onChange={(e) => setSrc(e.target.value)} placeholder="https://periodico.es/articulo" />
                  <TextField label="Tu página enlazada (destino)" type="url" required value={dst} onChange={(e) => setDst(e.target.value)} placeholder="https://tuweb.es/" />
                  <Button type="submit" variant="primary" loading={busy === "add"}>Añadir</Button>
                </form>
              </Card>
              <Card title="Importar CSV" subtitle="Una línea por enlace: origen,destino[,ancla]. Máximo 500 por importación.">
                <form className="space-y-3" onSubmit={(e) => { e.preventDefault(); run("csv", async () => { const r = await post(`/orgs/${orgId}/backlinks`, { csv }); setCsv(""); return `${r.added} añadidos, ${r.duplicates} repetidos${r.skippedByPlan ? `, ${r.skippedByPlan} fuera del límite del plan` : ""}${r.errors.length ? `, ${r.errors.length} líneas con error (p. ej. línea ${r.errors[0].line})` : ""}.`; }); }}>
                  <Field label="Contenido CSV" htmlFor="bl-csv"><Textarea id="bl-csv" required value={csv} onChange={(e) => setCsv(e.target.value)} placeholder={"origen,destino\nhttps://blog.es/post,https://tuweb.es/"} /></Field>
                  <Button type="submit" loading={busy === "csv"}>Importar</Button>
                </form>
              </Card>
            </div>
          )}
          <Card
            title="Enlaces registrados"
            actions={canWrite && data.items.length > 0 ? <Button loading={busy === "check"} onClick={() => run("check", async () => { const r = await post(`/orgs/${orgId}/backlinks/check`, {}); return `${r.checked} enlaces comprobados (los 10 que llevan más tiempo sin revisar).`; })}><RefreshCw className="size-4" /> Comprobar</Button> : undefined}
          >
            {data.items.length === 0 ? (
              <EmptyState icon={<Link2 className="size-8" />} title="Sin enlaces registrados">No rastreamos toda la web: añade los enlaces que conoces y te avisamos si desaparecen.</EmptyState>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full min-w-[720px] text-sm">
                  <thead className="text-left text-xs text-mute"><tr><th className="py-2 pr-3 font-medium">Origen</th><th className="pr-3 font-medium">Destino</th><th className="pr-3 font-medium">Estado</th><th className="pr-3 font-medium">rel</th><th className="pr-3 font-medium">Ancla</th><th className="pr-3 font-medium">Comprobado</th><th /></tr></thead>
                  <tbody>
                    {data.items.map((b: any) => (
                      <tr key={b.id} className="border-t border-line">
                        <td className="max-w-[240px] break-all py-2 pr-3"><a className="hover:underline" href={b.source_url} target="_blank" rel="noopener noreferrer nofollow">{b.source_url} <ExternalLink className="inline size-3" /></a></td>
                        <td className="max-w-[200px] break-all pr-3 text-xs">{b.target_url}</td>
                        <td className="pr-3"><Badge tone={BL[b.status]?.tone}>{BL[b.status]?.label ?? b.status}</Badge></td>
                        <td className="pr-3 text-xs">{b.rel || (b.status === "live" ? "follow" : "—")}</td>
                        <td className="max-w-[160px] break-words pr-3 text-xs">{b.anchor_found ?? "—"}</td>
                        <td className="pr-3 text-xs">{b.last_checked_at ? timeAgo(b.last_checked_at) : "—"}</td>
                        <td className="text-right">{canWrite && <Button className="min-h-8 px-2" aria-label="Eliminar enlace" onClick={() => run(`del:${b.id}`, async () => { await del(`/orgs/${orgId}/backlinks/${b.id}`); return "Enlace eliminado."; })}><Trash2 className="size-4" /></Button>}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
          <Notice tone="info" title="Sin esquemas de enlaces">DNI Growth no compra, intercambia ni genera enlaces automáticamente. Las campañas de enlaces artificiales infringen las directrices de Google.</Notice>
        </div>
      )}
    </>
  );
}
