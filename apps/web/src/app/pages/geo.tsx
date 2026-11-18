import { Fragment, useEffect, useMemo, useState, type FormEvent } from "react";
import { Link, useParams, useSearchParams } from "react-router";
import { Download, ExternalLink, Lightbulb, Play, Plus, RotateCcw } from "lucide-react";
import { ApiError, del, fmtDate, patch, post, timeAgo } from "../lib/api";
import { useApi } from "../lib/hooks";
import { Badge, Button, Card, EmptyState, ErrorState, Field, Notice, PageHeader, Select, Spinner, Textarea, TextField } from "../ui";
import { useOrgAccess } from "./org";

type Engine = { key: string; label: string; vendor: string; status: "official_api" | "no_official_api"; mechanism: string; caveat: string };
type Opt = { key: string; label: string };
type Prompt = {
  id: string;
  question: string;
  intent: string;
  category: string;
  engine: string;
  locale: string;
  regionCountry: string;
  regionDetail: string | null;
  enabled: boolean;
  source: string;
  createdAt: string;
  archivedAt: string | null;
  createdByName: string | null;
};
type Library = {
  brand: { id: string; name: string; domain: string | null; default_locale: string };
  items: Prompt[];
  usage: { used: number; limit: number; plan: string };
  engines: Engine[];
  intents: Opt[];
  categories: Opt[];
  sampling: Sampling;
  lastSamples: Record<string, LastSample>;
  caveats: string[];
};
type Sampling = {
  active: boolean;
  engine: string;
  model: string;
  fallbackModel: string | null;
  tier: string;
  reason: string;
  perRun: number;
  dailyOrgLimit: number;
  usedToday: number;
  platformExhausted: boolean;
  activeJob: { id: string; state: string; progress: number } | null;
  lastJob: { id: string; state: string; failureCode: string | null; finishedAt: string | null; output: { requested: number; ok: number; errors: number; mentioned: number; stoppedReason: string | null; grounded?: boolean } | null } | null;
};
type LastSample = { id: string; status: string; errorCode: string | null; mentioned: boolean | null; mentionCount: number | null; cited: boolean | null; sampledAt: string };
type Visibility = {
  sampledPrompts: number;
  mentioned: number;
  cited: number;
  mentionRate: number | null;
  mentionRateInterval?: Interval | null;
  intervalMethod?: string;
  citationRate: number | null;
  groundedSamples?: number;
  byIntent: Array<{ intent: string; label: string; sampled: number; mentioned: number; interval?: Interval | null }>;
  competitors: Array<{ name: string; domain: string | null; mentioned: number; cited: number; mentionRate?: number | null }>;
  period: { from: string; to: string } | null;
  source: string;
  caveats: string[];
};
const STOP_REASON: Record<string, string> = {
  daily_cap: "se alcanzó el tope diario gratuito; el resto se muestreará otro día",
  gemini_quota: "Gemini indicó que se agotó la cuota gratuita por ahora",
  gemini_unavailable: "Gemini no estaba respondiendo (servicio saturado); el resto se muestreará en la próxima ejecución",
  gemini_grounding_unavailable: "la búsqueda de Google no está disponible para esta clave",
};
const FAIL: Record<string, string> = {
  gemini_403: "Gemini rechazó la clave (403).",
  gemini_401: "Gemini rechazó la clave (401).",
  gemini_grounding_unavailable: "La búsqueda de Google no está disponible en el nivel gratuito de esta clave; no se ha muestreado nada.",
  gemini_model_unavailable: "Google no ofrece este modelo a esta clave (404); no se ha muestreado nada.",
  geo_no_prompts: "No había preguntas activas para Gemini.",
  gemini_not_configured: "El muestreo con Gemini no está configurado.",
};
const pctFmt = (v: number | null) => (v === null ? "—" : `${Math.round(v * 100)} %`);
type Interval = { low: number; high: number };
const ciFmt = (i: Interval | null | undefined) => (i ? `${Math.round(i.low * 100)}–${Math.round(i.high * 100)} %` : null);

type Rec = {
  id: string;
  priority: "alta" | "media" | "baja";
  title: string;
  gap: string;
  action: string;
  why: string;
  target: { type: "existing_page" | "new_page" | "site"; url: string | null; title: string | null; reason: string };
  draft: { kind: string; title: string; keyword: string; angle: string } | null;
  evidence: Array<{ promptId: string; sampleId: string; question: string; sampledAt: string; model: string; grounded: boolean; mentioned: boolean; competitorsMentioned: string[] }>;
  limitations: string[];
};
type Recs = { items: Rec[]; method: string; caveats: string[]; basedOn: { sampledPrompts: number; crawlCompletedAt: string | null; crawledPages: number }; observedAt: string | null };
const PRIORITY_TONE = { alta: "danger", media: "warn", baja: "neutral" } as const;
const TARGET_LABEL = { existing_page: "Mejorar página existente", new_page: "Página nueva sugerida", site: "Todo el sitio" } as const;

function Recommendations({ orgId, base, brandId, refreshKey }: { orgId: string; base: string; brandId: string; refreshKey: string }) {
  const recs = useApi<Recs>(`${base}/recommendations${refreshKey ? `?t=${encodeURIComponent(refreshKey)}` : ""}`);
  const [open, setOpen] = useState<string | null>(null);
  const r = recs.data;
  return (
    <Card title="Recomendaciones GEO explicables" subtitle="Hueco observado → página o acción concreta, con la prueba y sus limitaciones. Sin coste: no usan IA.">
      {recs.error && <ErrorState error={recs.error} onRetry={recs.reload} />}
      {!r && !recs.error && <Spinner />}
      {r && r.items.length === 0 && (
        <p className="text-sm text-mute">
          {r.basedOn.sampledPrompts ? "No hay huecos en las últimas respuestas observadas." : "Aún no hay respuestas muestreadas: las recomendaciones se basan en ellas."}
        </p>
      )}
      {r && r.items.length > 0 && (
        <ol className="space-y-3">
          {r.items.map((x) => {
            const isOpen = open === x.id;
            const draftHref = x.draft
              ? `/o/${orgId}/content?${new URLSearchParams({ kind: x.draft.kind, title: x.draft.title, keyword: x.draft.keyword, angle: x.draft.angle, brandId, from: "geo" }).toString()}`
              : null;
            return (
              <li key={x.id} className="rounded-xl border border-line p-4">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <p className="font-medium">
                    <Badge tone={PRIORITY_TONE[x.priority]}>Prioridad {x.priority}</Badge> <span className="ml-1">{x.title}</span>
                  </p>
                  <div className="flex gap-2">
                    {draftHref && (
                      <Link to={draftHref} className="inline-flex items-center gap-1 rounded-full border border-line px-3 py-1 text-sm hover:bg-surface-2">
                        <Plus className="size-4" aria-hidden /> Crear borrador
                      </Link>
                    )}
                    <button type="button" className="rounded-full px-3 py-1 text-sm text-accent-text hover:underline" aria-expanded={isOpen} onClick={() => setOpen(isOpen ? null : x.id)}>
                      {isOpen ? "Ocultar detalles" : "Por qué y limitaciones"}
                    </button>
                  </div>
                </div>
                <p className="mt-2 text-sm">
                  <span className="text-mute">Hueco: </span>
                  {x.gap}
                </p>
                <p className="mt-1 text-sm">
                  <span className="text-mute">Acción: </span>
                  {x.action}
                </p>
                <p className="mt-1 text-sm">
                  <span className="text-mute">{TARGET_LABEL[x.target.type]}: </span>
                  {x.target.type === "existing_page" && x.target.url ? (
                    <a href={x.target.url} target="_blank" rel="noopener noreferrer nofollow" className="break-all text-accent-text hover:underline">
                      {x.target.title ?? x.target.url} <ExternalLink className="inline size-3" aria-hidden />
                    </a>
                  ) : (
                    <span className="break-all">{x.target.url ?? x.target.title ?? "—"}</span>
                  )}
                </p>
                {isOpen && (
                  <div className="mt-3 space-y-2 rounded-lg bg-surface-2/50 p-3 text-sm">
                    <p>
                      <span className="text-mute">Por qué: </span>
                      {x.why}
                    </p>
                    <p>
                      <span className="text-mute">Destino: </span>
                      {x.target.reason}
                    </p>
                    {x.evidence.length > 0 && (
                      <div>
                        <p className="text-mute">Prueba observada:</p>
                        <ul className="list-disc pl-5">
                          {x.evidence.map((e) => (
                            <li key={e.sampleId}>
                              «{e.question}» · {fmtDate(e.sampledAt)} · {e.model} · {e.grounded ? "con búsqueda" : "sin búsqueda"} · marca {e.mentioned ? "mencionada" : "no mencionada"}
                              {e.competitorsMentioned.length > 0 && ` · aparecen: ${e.competitorsMentioned.join(", ")}`}
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}
                    <div>
                      <p className="text-mute">Limitaciones:</p>
                      <ul className="list-disc pl-5">
                        {x.limitations.map((l) => (
                          <li key={l}>{l}</li>
                        ))}
                      </ul>
                    </div>
                  </div>
                )}
              </li>
            );
          })}
        </ol>
      )}
      {r && (
        <div className="mt-3 space-y-1 text-xs text-mute">
          <p>
            Método: {r.method} Basado en {r.basedOn.sampledPrompts} preguntas muestreadas
            {r.basedOn.crawlCompletedAt ? ` y en la auditoría del ${fmtDate(r.basedOn.crawlCompletedAt)} (${r.basedOn.crawledPages} páginas)` : " (sin auditoría de la web: no se pueden proponer páginas existentes)"}.
          </p>
          {r.caveats.map((c) => (
            <p key={c}>{c}</p>
          ))}
        </div>
      )}
    </Card>
  );
}
type Suggestion = { question: string; intent: string; category: string; basedOn: string[] };

const LOCALES = [
  { v: "es-ES", l: "Español (España)" },
  { v: "es-MX", l: "Español (México)" },
  { v: "es", l: "Español (genérico)" },
  { v: "en-US", l: "Inglés (EE. UU.)" },
  { v: "en-GB", l: "Inglés (Reino Unido)" },
  { v: "ca-ES", l: "Catalán" },
  { v: "pt-PT", l: "Portugués (Portugal)" },
  { v: "fr-FR", l: "Francés (Francia)" },
];
const COUNTRIES = ["ES", "MX", "AR", "CO", "CL", "PE", "US", "GB", "PT", "FR", "DE", "IT"];
const countryName = (c: string) => {
  try {
    return new Intl.DisplayNames(["es"], { type: "region" }).of(c) ?? c;
  } catch {
    return c;
  }
};

const BASED_ON: Record<string, string> = { name: "nombre", offering: "producto/servicio", place: "zona", sector: "sector", competitors: "competidor", audience: "público" };

export function GeoPage() {
  const { orgId } = useParams();
  const [params, setParams] = useSearchParams();
  const access = useOrgAccess(orgId);
  const canWrite = access.can("brand:write");
  const brands = useApi<{ items: Array<{ id: string; name: string; domain: string | null; origin: string | null }> }>(`/orgs/${orgId}/brands`);
  const brandId = params.get("brand") ?? brands.data?.items[0]?.id ?? null;
  const [archived, setArchived] = useState(false);
  const lib = useApi<Library>(brandId ? `/orgs/${orgId}/brands/${brandId}/geo/prompts${archived ? "?archived=1" : ""}` : null, {
    pollMs: 3000,
    pollWhile: (d) => !!d?.sampling.activeJob,
  });

  if (brands.loading && !brands.data) return <Spinner />;
  if (brands.error) return <ErrorState error={brands.error} onRetry={brands.reload} />;
  const list = brands.data?.items ?? [];

  return (
    <>
      <PageHeader
        eyebrow="Orgánico · GEO / AEO"
        title="AI Visibility"
        subtitle="Biblioteca de preguntas que se medirán en motores de IA: por marca, motor, intención, idioma y región."
      />
      {list.length === 0 ? (
        <EmptyState title="Sin marcas" action={<Link className="text-sm font-semibold text-accent-text" to={`/o/${orgId}/analyze`}>Crea una auditando su web →</Link>}>
          La biblioteca de preguntas se organiza por marca.
        </EmptyState>
      ) : (
        <div className="space-y-4">
          <div className="flex flex-wrap items-end gap-3">
            <Field label="Marca" htmlFor="geo-brand">
              <Select id="geo-brand" value={brandId ?? ""} onChange={(e) => setParams({ brand: e.target.value })} className="min-w-[220px]">
                {list.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name}
                    {b.domain ? ` · ${b.domain}` : ""}
                  </option>
                ))}
              </Select>
            </Field>
            <div className="flex gap-1 rounded-full border border-line p-1 text-sm" role="tablist" aria-label="Vista">
              <button role="tab" aria-selected={!archived} className={`rounded-full px-3 py-1.5 ${!archived ? "bg-surface-2 font-medium" : "text-mute"}`} onClick={() => setArchived(false)}>
                Activas
              </button>
              <button role="tab" aria-selected={archived} className={`rounded-full px-3 py-1.5 ${archived ? "bg-surface-2 font-medium" : "text-mute"}`} onClick={() => setArchived(true)}>
                Archivadas
              </button>
            </div>
          </div>
          {lib.error && <ErrorState error={lib.error} onRetry={lib.reload} />}
          {lib.loading && !lib.data ? <Spinner /> : lib.data && <LibraryView key={brandId} orgId={orgId!} data={lib.data} archived={archived} canWrite={canWrite} reload={lib.reload} />}
        </div>
      )}
    </>
  );
}

function LibraryView({ orgId, data, archived, canWrite, reload }: { orgId: string; data: Library; archived: boolean; canWrite: boolean; reload: () => Promise<unknown> | void }) {
  const base = `/orgs/${orgId}/brands/${data.brand.id}/geo`;
  const [err, setErr] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [filter, setFilter] = useState({ engine: "", intent: "" });
  const [openId, setOpenId] = useState<string | null>(null);
  const engine = (k: string) => data.engines.find((e) => e.key === k);
  const label = (opts: Opt[], k: string) => opts.find((o) => o.key === k)?.label ?? k;
  const pct = data.usage.limit ? Math.min(100, Math.round((data.usage.used / data.usage.limit) * 100)) : 0;

  const items = useMemo(() => data.items.filter((p) => (!filter.engine || p.engine === filter.engine) && (!filter.intent || p.intent === filter.intent)), [data.items, filter]);

  const act = async (key: string, fn: () => Promise<unknown>) => {
    setErr(null);
    setBusy(key);
    try {
      await fn();
      await reload();
    } catch (e) {
      setErr(e as ApiError);
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      {!archived && <Monitor base={base} data={data} canWrite={canWrite} reload={reload} />}
      {!archived && <Recommendations orgId={orgId} base={base} brandId={data.brand.id} refreshKey={data.sampling.lastJob?.finishedAt ?? ""} />}

      <div className="grid gap-4 lg:grid-cols-3">
        <Card title="Uso del plan" subtitle="Preguntas activas (pregunta × motor) en la organización">
          <p className="text-2xl font-semibold tabular-nums">
            {data.usage.used} <span className="text-base font-normal text-mute">/ {data.usage.limit}</span>
          </p>
          <div className="mt-2 h-2 overflow-hidden rounded-full bg-surface-2" role="progressbar" aria-valuemin={0} aria-valuemax={data.usage.limit} aria-valuenow={data.usage.used} aria-label="Preguntas activas usadas">
            <div className={`h-full ${pct >= 100 ? "bg-danger" : "bg-accent"}`} style={{ width: `${pct}%` }} />
          </div>
          <p className="mt-2 text-xs text-mute">Archivar una pregunta libera su hueco.</p>
        </Card>
        <Card className="lg:col-span-2" title="Motores" subtitle="Solo se muestreará por mecanismos permitidos por cada proveedor">
          <ul className="grid gap-2 sm:grid-cols-2">
            {data.engines.map((e) => (
              <li key={e.key} className="rounded-xl border border-line p-3 text-sm">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-medium">{e.label}</span>
                  {e.status === "official_api" ? <Badge tone="info">API oficial</Badge> : <Badge tone="warn">Sin API · manual</Badge>}
                </div>
                <p className="mt-1 text-xs text-mute">{e.caveat}</p>
              </li>
            ))}
          </ul>
        </Card>
      </div>

      {err && <ErrorState error={err} />}
      {canWrite && !archived && <AddPrompts base={base} data={data} onDone={reload} />}

      <Card
        title={archived ? "Preguntas archivadas" : "Biblioteca"}
        subtitle={`${items.length} de ${data.items.length} filas · ${data.brand.name}`}
        actions={
          !archived && data.items.length > 0 ? (
            <div className="flex gap-2">
              <a className="inline-flex min-h-9 items-center gap-1.5 rounded-full border border-line px-3 text-sm hover:bg-surface-2" href={`/api/v1${base}/prompts/export`} download>
                <Download className="size-4" aria-hidden /> CSV
              </a>
              <a className="inline-flex min-h-9 items-center gap-1.5 rounded-full border border-line px-3 text-sm hover:bg-surface-2" href={`/api/v1${base}/prompts/export?format=json`} download>
                <Download className="size-4" aria-hidden /> JSON
              </a>
            </div>
          ) : undefined
        }
      >
        {data.items.length > 0 && (
          <div className="mb-3 flex flex-wrap gap-3">
            <Field label="Motor" htmlFor="geo-f-engine">
              <Select id="geo-f-engine" value={filter.engine} onChange={(e) => setFilter({ ...filter, engine: e.target.value })}>
                <option value="">Todos</option>
                {data.engines.map((e) => (
                  <option key={e.key} value={e.key}>{e.label}</option>
                ))}
              </Select>
            </Field>
            <Field label="Intención" htmlFor="geo-f-intent">
              <Select id="geo-f-intent" value={filter.intent} onChange={(e) => setFilter({ ...filter, intent: e.target.value })}>
                <option value="">Todas</option>
                {data.intents.map((o) => (
                  <option key={o.key} value={o.key}>{o.label}</option>
                ))}
              </Select>
            </Field>
          </div>
        )}
        {items.length === 0 ? (
          <p className="text-sm text-mute">{archived ? "No hay preguntas archivadas." : data.items.length ? "Ninguna fila con estos filtros." : canWrite ? "Aún no hay preguntas. Añádelas arriba o parte de las sugerencias." : "Aún no hay preguntas."}</p>
        ) : (
          <div className="relative overflow-x-auto">
            <table className="w-full min-w-[720px] text-sm">
              <thead className="text-left text-xs text-mute">
                <tr>
                  <th className="py-2 pr-3 font-medium">Pregunta</th>
                  <th className="py-2 pr-3 font-medium">Motor</th>
                  <th className="py-2 pr-3 font-medium">Intención · tipo</th>
                  <th className="py-2 pr-3 font-medium">Idioma · región</th>
                  <th className="py-2 pr-3 font-medium">Estado</th>
                  {!archived && <th className="py-2 pr-3 font-medium">Última muestra</th>}
                  {canWrite && <th className="py-2 text-right font-medium"><span className="sr-only">Acciones</span></th>}
                </tr>
              </thead>
              <tbody>
                {items.map((p) => {
                  const e = engine(p.engine);
                  return (
                    <Fragment key={p.id}>
                    <tr className="border-t border-line align-top">
                      <td className="max-w-[340px] py-2 pr-3">
                        <p className="break-words">{p.question}</p>
                        <p className="text-xs text-mute">
                          {p.source === "suggestion" ? "Sugerencia aceptada" : "Manual"} · {p.createdByName ?? "—"} · {fmtDate(p.createdAt)}
                        </p>
                      </td>
                      <td className="py-2 pr-3">
                        {e?.label ?? p.engine}
                        {e?.status === "no_official_api" && <span className="block text-xs text-mute">revisión manual</span>}
                      </td>
                      <td className="py-2 pr-3">
                        {label(data.intents, p.intent)}
                        <span className="block text-xs text-mute">{label(data.categories, p.category)}</span>
                      </td>
                      <td className="py-2 pr-3">
                        {p.locale}
                        <span className="block text-xs text-mute">
                          {countryName(p.regionCountry)}
                          {p.regionDetail ? ` · ${p.regionDetail}` : ""}
                        </span>
                      </td>
                      <td className="py-2 pr-3">{archived ? <Badge>Archivada</Badge> : p.enabled ? <Badge tone="ok">Activa</Badge> : <Badge>Pausada</Badge>}</td>
                      {!archived && (
                        <td className="py-2 pr-3">
                          <LastSampleCell s={data.lastSamples[p.id]} open={openId === p.id} onToggle={() => setOpenId(openId === p.id ? null : p.id)} />
                        </td>
                      )}
                      {canWrite && (
                        <td className="whitespace-nowrap py-2 text-right">
                          {archived ? (
                            <Button variant="ghost" loading={busy === `r${p.id}`} onClick={() => act(`r${p.id}`, () => post(`${base}/prompts/${p.id}/restore`))}>
                              <RotateCcw className="size-4" aria-hidden /> Restaurar
                            </Button>
                          ) : (
                            <>
                              <Button variant="ghost" loading={busy === `t${p.id}`} onClick={() => act(`t${p.id}`, () => patch(`${base}/prompts/${p.id}`, { enabled: !p.enabled }))}>
                                {p.enabled ? "Pausar" : "Activar"}
                              </Button>
                              <Button variant="ghost" loading={busy === `a${p.id}`} onClick={() => act(`a${p.id}`, () => del(`${base}/prompts/${p.id}`))} aria-label={`Archivar: ${p.question}`}>
                                Archivar
                              </Button>
                            </>
                          )}
                        </td>
                      )}
                    </tr>
                    {openId === p.id && (
                      <tr>
                        <td colSpan={canWrite ? 7 : 6} className="pb-4">
                          <SampleDetail base={base} promptId={p.id} />
                        </td>
                      </tr>
                    )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <ul className="space-y-1 text-xs text-mute">
        {data.caveats.map((c) => (
          <li key={c}>· {c}</li>
        ))}
      </ul>
    </>
  );
}

function AddPrompts({ base, data, onDone }: { base: string; data: Library; onDone: () => Promise<unknown> | void }) {
  const defaultLocale = LOCALES.some((l) => l.v === data.brand.default_locale) ? data.brand.default_locale : "es-ES";
  const [form, setForm] = useState({
    text: "",
    intent: "comparative",
    category: "product",
    engines: ["gemini_api"] as string[],
    locale: defaultLocale,
    regionCountry: defaultLocale.split("-")[1] ?? "ES",
    regionDetail: "",
  });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<ApiError | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [sugg, setSugg] = useState<{ suggestions: Suggestion[]; missing: string[]; inputs: { sector: string | null; place: string | null }; profile: { exists: boolean; confirmed: boolean } } | null>(null);
  const [suggIn, setSuggIn] = useState({ sector: "", place: "" });
  const [picked, setPicked] = useState<Set<number>>(new Set());

  useEffect(() => setMsg(null), [form.text]);
  const lines = form.text.split("\n").map((l) => l.trim()).filter(Boolean);
  const rows = lines.length * form.engines.length;

  const create = async (questions: string[], extra: { intent: string; category: string; source: "manual" | "suggestion" }) => {
    setErr(null);
    setBusy(true);
    try {
      const r = await post<{ created: number; duplicates: number }>(`${base}/prompts`, {
        questions,
        intent: extra.intent,
        category: extra.category,
        engines: form.engines,
        locale: form.locale,
        regionCountry: form.regionCountry,
        regionDetail: form.regionDetail.trim() || null,
        source: extra.source,
      });
      setMsg(`${r.created} fila(s) añadida(s)${r.duplicates ? ` · ${r.duplicates} ya existían` : ""}.`);
      await onDone();
      return true;
    } catch (e) {
      setErr(e as ApiError);
      return false;
    } finally {
      setBusy(false);
    }
  };

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!lines.length || !form.engines.length) return;
    if (await create(lines.slice(0, 50), { intent: form.intent, category: form.category, source: "manual" })) setForm({ ...form, text: "" });
  };

  const loadSuggestions = async () => {
    setErr(null);
    setBusy(true);
    try {
      const r = await post<any>(`${base}/suggestions`, { locale: form.locale, ...(suggIn.sector.trim() ? { sector: suggIn.sector.trim() } : {}), ...(suggIn.place.trim() ? { place: suggIn.place.trim() } : {}) });
      setSugg(r);
      setPicked(new Set());
      setSuggIn({ sector: suggIn.sector || r.inputs.sector || "", place: suggIn.place || r.inputs.place || "" });
    } catch (e) {
      setErr(e as ApiError);
    } finally {
      setBusy(false);
    }
  };

  const acceptPicked = async () => {
    if (!sugg) return;
    const chosen = sugg.suggestions.filter((_, i) => picked.has(i));
    // One request per intent/category group keeps each row's labels accurate.
    const groups = new Map<string, Suggestion[]>();
    for (const s of chosen) groups.set(`${s.intent}|${s.category}`, [...(groups.get(`${s.intent}|${s.category}`) ?? []), s]);
    for (const [k, g] of groups) {
      const [intent, category] = k.split("|") as [string, string];
      if (!(await create(g.map((s) => s.question), { intent, category, source: "suggestion" }))) return;
    }
    setPicked(new Set());
  };

  const toggleEngine = (k: string) => setForm({ ...form, engines: form.engines.includes(k) ? form.engines.filter((x) => x !== k) : [...form.engines, k] });

  return (
    <Card title="Añadir preguntas" subtitle="Una pregunta por línea. Se crea una fila por cada motor elegido.">
      <form onSubmit={submit} className="space-y-4">
        <Field label="Preguntas" htmlFor="geo-q" hint={`${lines.length} pregunta(s) × ${form.engines.length} motor(es) = ${rows} fila(s). Máximo 50 por envío; entre 8 y 300 caracteres. No incluyas datos personales: las preguntas de Gemini se envían a Google (nivel gratuito).`}>
          <Textarea id="geo-q" value={form.text} onChange={(e) => setForm({ ...form, text: e.target.value })} placeholder={"¿Cuál es el mejor software de SEO para pymes en España?\n¿Qué herramientas ayudan a aparecer en respuestas de IA?"} rows={4} />
        </Field>
        <fieldset>
          <legend className="mb-2 text-sm font-medium">Motores</legend>
          <div className="flex flex-wrap gap-2">
            {data.engines.map((e) => (
              <label key={e.key} className={`inline-flex min-h-10 cursor-pointer items-center gap-2 rounded-full border px-3 text-sm ${form.engines.includes(e.key) ? "border-accent-text/50 bg-surface-2" : "border-line"}`}>
                <input type="checkbox" checked={form.engines.includes(e.key)} onChange={() => toggleEngine(e.key)} />
                {e.label}
              </label>
            ))}
          </div>
        </fieldset>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
          <Field label="Intención" htmlFor="geo-intent">
            <Select id="geo-intent" value={form.intent} onChange={(e) => setForm({ ...form, intent: e.target.value })}>
              {data.intents.map((o) => (
                <option key={o.key} value={o.key}>{o.label}</option>
              ))}
            </Select>
          </Field>
          <Field label="Tipo" htmlFor="geo-cat">
            <Select id="geo-cat" value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })}>
              {data.categories.map((o) => (
                <option key={o.key} value={o.key}>{o.label}</option>
              ))}
            </Select>
          </Field>
          <Field label="Idioma" htmlFor="geo-locale">
            <Select id="geo-locale" value={form.locale} onChange={(e) => setForm({ ...form, locale: e.target.value })}>
              {LOCALES.map((l) => (
                <option key={l.v} value={l.v}>{l.l}</option>
              ))}
            </Select>
          </Field>
          <Field label="País" htmlFor="geo-country">
            <Select id="geo-country" value={form.regionCountry} onChange={(e) => setForm({ ...form, regionCountry: e.target.value })}>
              {COUNTRIES.map((c) => (
                <option key={c} value={c}>{countryName(c)}</option>
              ))}
            </Select>
          </Field>
          <TextField label="Ciudad o zona (opcional)" value={form.regionDetail} maxLength={80} onChange={(e) => setForm({ ...form, regionDetail: e.target.value })} />
        </div>
        {err && <ErrorState error={err} />}
        {msg && <Notice tone="ok">{msg}</Notice>}
        <div className="flex flex-wrap gap-2">
          <Button type="submit" variant="primary" loading={busy} disabled={!lines.length || !form.engines.length}>
            <Plus className="size-4" aria-hidden /> Añadir {rows ? `${rows} fila(s)` : ""}
          </Button>
          <Button type="button" variant="secondary" loading={busy && !sugg} onClick={loadSuggestions}>
            <Lightbulb className="size-4" aria-hidden /> Sugerir desde el perfil de marca
          </Button>
        </div>
      </form>

      {sugg && (
        <div className="mt-6 border-t border-line pt-4">
          <p className="text-sm font-medium">Sugerencias (plantillas, sin IA; no se guarda nada hasta que las añadas)</p>
          {!sugg.profile.exists && <p className="mt-1 text-xs text-mute">Esta marca aún no tiene perfil: las sugerencias solo usan su nombre.</p>}
          {sugg.profile.exists && !sugg.profile.confirmed && <p className="mt-1 text-xs text-mute">El perfil de marca está sin confirmar: revisa cada sugerencia.</p>}
          {sugg.missing.length > 0 && <p className="mt-1 text-xs text-mute">Falta en el perfil: {sugg.missing.join(", ")}. No se inventa.</p>}
          <div className="mt-3 grid gap-3 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
            <TextField label="Sector (editable)" value={suggIn.sector} maxLength={80} onChange={(e) => setSuggIn({ ...suggIn, sector: e.target.value })} />
            <TextField label="Zona (editable)" value={suggIn.place} maxLength={80} onChange={(e) => setSuggIn({ ...suggIn, place: e.target.value })} />
            <Button type="button" variant="ghost" onClick={loadSuggestions} loading={busy}>
              Regenerar
            </Button>
          </div>
          {sugg.suggestions.length === 0 ? (
            <p className="mt-3 text-sm text-mute">Sin datos suficientes para sugerir. Completa el perfil de marca o escribe sector y zona.</p>
          ) : (
            <>
              <ul className="mt-3 space-y-2">
                {sugg.suggestions.map((s, i) => (
                  <li key={s.question}>
                    <label className="flex cursor-pointer items-start gap-3 rounded-xl border border-line p-3 text-sm hover:bg-surface-2">
                      <input type="checkbox" className="mt-1" checked={picked.has(i)} onChange={() => setPicked((p) => (p.has(i) ? new Set([...p].filter((x) => x !== i)) : new Set([...p, i])))} />
                      <span className="min-w-0 flex-1">
                        <span className="block break-words">{s.question}</span>
                        <span className="text-xs text-mute">
                          {data.intents.find((o) => o.key === s.intent)?.label} · {data.categories.find((o) => o.key === s.category)?.label} · a partir de: {s.basedOn.map((b) => BASED_ON[b] ?? b).join(", ")}
                        </span>
                      </span>
                    </label>
                  </li>
                ))}
              </ul>
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <Button type="button" variant="primary" disabled={!picked.size || !form.engines.length} loading={busy} onClick={acceptPicked}>
                  Añadir {picked.size} seleccionada(s) × {form.engines.length} motor(es)
                </Button>
                <span className="text-xs text-mute">Se usan los motores, idioma y país elegidos arriba.</span>
              </div>
            </>
          )}
        </div>
      )}
    </Card>
  );
}

function Monitor({ base, data, canWrite, reload }: { base: string; data: Library; canWrite: boolean; reload: () => Promise<unknown> | void }) {
  const smp = data.sampling;
  const running = !!smp.activeJob;
  const vis = useApi<Visibility>(`${base}/visibility${smp.lastJob?.finishedAt ? `?t=${encodeURIComponent(smp.lastJob.finishedAt)}` : ""}`);
  const [err, setErr] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);
  const geminiActive = data.items.filter((p) => p.engine === "gemini_api" && p.enabled).length;
  const left = Math.max(0, smp.dailyOrgLimit - smp.usedToday);

  const start = async () => {
    setErr(null);
    setBusy(true);
    try {
      await post(`${base}/sample`);
      await reload();
    } catch (e) {
      setErr(e as ApiError);
    } finally {
      setBusy(false);
    }
  };

  if (!smp.active) {
    return (
      <Notice tone="info" title="Todavía no se consulta ningún motor de IA">
        {smp.reason} Aquí defines qué preguntas medir; no se muestra ninguna respuesta ni porcentaje de visibilidad hasta que haya muestras reales.
      </Notice>
    );
  }
  const v = vis.data;
  const out = smp.lastJob?.output;
  return (
    <Card
      title="Visibilidad observada en Gemini"
      subtitle={`Muestras reales por la API oficial · ${smp.model}${smp.fallbackModel ? ` (respaldo: ${smp.fallbackModel})` : ""} · nivel gratuito`}
      actions={
        canWrite ? (
          <Button variant="primary" loading={busy || running} disabled={!geminiActive || left === 0 || smp.platformExhausted} onClick={start}>
            <Play className="size-4" aria-hidden /> {running ? `Muestreando… ${smp.activeJob?.progress ?? 0} %` : "Muestrear ahora"}
          </Button>
        ) : undefined
      }
    >
      <div className="space-y-4">
        {err && <ErrorState error={err} />}
        {!geminiActive && <p className="text-sm text-mute">Añade preguntas con el motor «Gemini (API)» para poder muestrear.</p>}
        <p className="text-xs text-mute">
          Cada ejecución muestrea hasta {smp.perRun} preguntas (primero las que llevan más tiempo sin muestra). Hoy: {smp.usedToday} de {smp.dailyOrgLimit} muestras gratuitas de la organización
          {smp.platformExhausted ? " · tope diario de la plataforma alcanzado" : ""}. No tiene coste.
        </p>
        {smp.lastJob && !running && (
          <p className="text-sm">
            {smp.lastJob.state === "completed" && out ? (
              <>
                Última ejecución {timeAgo(smp.lastJob.finishedAt)}: {out.ok} respuesta(s) correcta(s){out.errors ? `, ${out.errors} con error` : ""}; la marca aparece en {out.mentioned}.
                {out.stoppedReason ? ` Se detuvo antes porque ${STOP_REASON[out.stoppedReason] ?? out.stoppedReason}.` : ""}
                {out.grounded === false ? " Sin búsqueda de Google: el nivel gratuito no la incluye para este modelo, así que las respuestas reflejan el conocimiento del modelo y no traen fuentes." : ""}
              </>
            ) : (
              <span className="text-danger">Última ejecución sin muestras: {FAIL[smp.lastJob.failureCode ?? ""] ?? smp.lastJob.failureCode ?? smp.lastJob.state}</span>
            )}
          </p>
        )}
        {vis.error && <ErrorState error={vis.error} onRetry={vis.reload} />}
        {v && v.sampledPrompts > 0 ? (
          <>
            <div className="grid gap-3 sm:grid-cols-3">
              <div className="rounded-xl border border-line p-3">
                <p className="text-xs text-mute">Preguntas en las que aparece la marca</p>
                <p className="text-2xl font-semibold tabular-nums">
                  {v.mentioned} <span className="text-base font-normal text-mute">de {v.sampledPrompts}</span>
                </p>
                <p className="text-xs text-mute">
                  {pctFmt(v.mentionRate)} · observado
                  {ciFmt(v.mentionRateInterval) && (
                    <span title={v.intervalMethod}> · margen 95 %: {ciFmt(v.mentionRateInterval)}</span>
                  )}
                </p>
              </div>
              <div className="rounded-xl border border-line p-3">
                <p className="text-xs text-mute">Respuestas que citan la web de la marca</p>
                {v.groundedSamples === 0 ? (
                  <>
                    <p className="text-2xl font-semibold">—</p>
                    <p className="text-xs text-mute">Sin fuentes: ninguna muestra usó la búsqueda de Google (no incluida en el nivel gratuito de este modelo).</p>
                  </>
                ) : (
                  <>
                    <p className="text-2xl font-semibold tabular-nums">
                      {v.cited} <span className="text-base font-normal text-mute">de {v.groundedSamples ?? v.sampledPrompts}</span>
                    </p>
                    <p className="text-xs text-mute">{pctFmt(v.citationRate)} · observado, sobre respuestas con búsqueda</p>
                  </>
                )}
              </div>
              <div className="rounded-xl border border-line p-3">
                <p className="text-xs text-mute">Por intención (aparece / muestreadas)</p>
                <ul className="mt-1 text-sm">
                  {v.byIntent.map((b) => (
                    <li key={b.intent} className="flex justify-between gap-2">
                      <span>{b.label}</span>
                      <span className="tabular-nums" title={ciFmt(b.interval) ? `Margen 95 %: ${ciFmt(b.interval)}` : undefined}>
                        {b.sampled ? `${b.mentioned}/${b.sampled}` : "—"}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
            {v.competitors.length > 0 && (
              <div>
                <p className="mb-1 text-sm font-medium">Competidores del perfil de marca en las mismas respuestas</p>
                <ul className="flex flex-wrap gap-2 text-sm">
                  {v.competitors.map((c) => (
                    <li key={c.domain ?? c.name} className="rounded-full border border-line px-3 py-1">
                      {c.domain ?? c.name}: aparece en {c.mentioned} de {v.sampledPrompts}, citado en {c.cited}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            <p className="text-xs text-mute">
              Fuente: {v.source}. Periodo: {v.period ? `${fmtDate(v.period.from)} – ${fmtDate(v.period.to)}` : "—"}. Última muestra correcta de cada pregunta activa en los últimos 30 días.
              {v.intervalMethod ? ` ${v.intervalMethod} Con pocas preguntas el margen es amplio.` : ""}
            </p>
          </>
        ) : (
          v && <p className="text-sm text-mute">Aún no hay muestras correctas. Pulsa «Muestrear ahora» para obtener las primeras respuestas reales.</p>
        )}
      </div>
    </Card>
  );
}

function LastSampleCell({ s, open, onToggle }: { s: LastSample | undefined; open: boolean; onToggle: () => void }) {
  if (!s) return <span className="text-xs text-mute">Sin muestras</span>;
  const badge =
    s.status !== "ok" ? (
      <Badge tone="warn">{s.status === "blocked" ? "Bloqueada" : s.status === "empty" ? "Vacía" : "Error"}</Badge>
    ) : s.mentioned ? (
      <Badge tone="ok">Aparece{s.cited ? " · citada" : ""}</Badge>
    ) : (
      <Badge>No aparece{s.cited ? " · citada" : ""}</Badge>
    );
  return (
    <div className="space-y-1">
      {badge}
      <p className="text-xs text-mute">{timeAgo(s.sampledAt)}</p>
      <button type="button" className="text-xs underline" aria-expanded={open} onClick={onToggle}>
        {open ? "Ocultar respuesta" : "Ver respuesta"}
      </button>
    </div>
  );
}

type SampleFull = {
  id: string;
  status: string;
  error_code: string | null;
  model: string;
  model_version: string | null;
  grounded: boolean;
  answer_text: string | null;
  answer_truncated: boolean;
  citations: Array<{ title: string; uri: string; domain: string | null }>;
  searchQueries: string[];
  brand_mention_count: number | null;
  sampled_at: string;
  latency_ms: number | null;
};

const SAMPLE_ERROR: Record<string, string> = {
  gemini_503: "Gemini estaba saturado (503)",
  gemini_500: "error interno de Gemini (500)",
  gemini_quota: "cuota gratuita de Gemini agotada por ahora",
  gemini_network: "no se pudo contactar con Gemini",
  gemini_model_unavailable: "modelo no disponible para esta clave (404)",
};
function sampleErrorLabel(x: { status: string; error_code: string | null }) {
  if (x.status === "blocked") return "Gemini no respondió (bloqueo de seguridad)";
  if (x.status === "empty") return "Gemini devolvió una respuesta vacía";
  return SAMPLE_ERROR[x.error_code ?? ""] ?? `error de Gemini (${x.error_code ?? "desconocido"})`;
}

function SampleDetail({ base, promptId }: { base: string; promptId: string }) {
  const { data, error, loading } = useApi<{ items: SampleFull[] }>(`${base}/samples?promptId=${promptId}&limit=5`);
  if (loading && !data) return <Spinner />;
  if (error) return <ErrorState error={error} />;
  const items = data?.items ?? [];
  if (!items.length) return <p className="text-sm text-mute">Sin muestras.</p>;
  // Show the latest real answer; if the most recent attempt failed, say so above it.
  const latest = items[0]!;
  const s = items.find((i) => i.status === "ok") ?? latest;
  const older = items.filter((i) => i !== s);
  return (
    <div className="rounded-xl border border-line bg-surface-2/40 p-4 text-sm">
      {s !== latest && (
        <p className="mb-2 text-xs text-mute">
          El último intento ({fmtDate(latest.sampled_at)}) no obtuvo respuesta: {sampleErrorLabel(latest)}. Se muestra la última respuesta correcta.
        </p>
      )}
      <p className="text-xs text-mute">
        {fmtDate(s.sampled_at)} · {s.model}
        {s.model_version ? ` (${s.model_version})` : ""} · {s.grounded ? "con búsqueda de Google" : "sin búsqueda"}
        {s.latency_ms ? ` · ${(s.latency_ms / 1000).toFixed(1)} s` : ""}
      </p>
      {s.status === "ok" ? (
        <>
          <p className="mt-2 whitespace-pre-wrap break-words">{s.answer_text}</p>
          {s.answer_truncated && <p className="mt-1 text-xs text-mute">Respuesta recortada a 12.000 caracteres.</p>}
        </>
      ) : (
        <p className="mt-2 text-mute">{sampleErrorLabel(s)}. No se muestra ninguna respuesta.</p>
      )}
      {s.citations.length > 0 && (
        <div className="mt-3">
          <p className="text-xs font-medium">Fuentes que citó Gemini</p>
          <ul className="mt-1 flex flex-wrap gap-2">
            {s.citations.map((c) => (
              <li key={c.uri}>
                <a className="inline-flex items-center gap-1 rounded-full border border-line px-2 py-0.5 text-xs hover:bg-surface-2" href={c.uri} target="_blank" rel="noopener noreferrer nofollow">
                  {c.domain ?? c.title} <ExternalLink className="size-3" aria-hidden />
                </a>
              </li>
            ))}
          </ul>
        </div>
      )}
      {s.searchQueries.length > 0 && <p className="mt-2 text-xs text-mute">Búsquedas que hizo: {s.searchQueries.join(" · ")}</p>}
      {older.length > 0 && (
        <p className="mt-2 text-xs text-mute">
          Muestras anteriores: {older.map((o) => `${fmtDate(o.sampled_at)} (${o.status === "ok" ? ((o.brand_mention_count ?? 0) > 0 ? "aparece" : "no aparece") : o.status})`).join(" · ")}
        </p>
      )}
      <p className="mt-2 text-xs text-mute">Texto generado por un modelo de IA y mostrado tal cual: puede contener errores. Es una muestra puntual.</p>
    </div>
  );
}
