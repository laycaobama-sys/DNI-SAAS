import { useEffect, useMemo, useState, type FormEvent } from "react";
import { Link, useParams, useSearchParams } from "react-router";
import { Download, Lightbulb, Plus, RotateCcw } from "lucide-react";
import { ApiError, del, fmtDate, patch, post } from "../lib/api";
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
  sampling: { active: boolean; reason: string };
  caveats: string[];
};
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
  const lib = useApi<Library>(brandId ? `/orgs/${orgId}/brands/${brandId}/geo/prompts${archived ? "?archived=1" : ""}` : null);

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
      <Notice tone="info" title="Todavía no se consulta ningún motor de IA">
        {data.sampling.reason} Aquí defines qué preguntas medir; no se muestra ninguna respuesta ni porcentaje de visibilidad hasta que haya muestras reales con fecha, motor, idioma y región.
      </Notice>

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
          <div className="overflow-x-auto">
            <table className="w-full min-w-[720px] text-sm">
              <thead className="text-left text-xs text-mute">
                <tr>
                  <th className="py-2 pr-3 font-medium">Pregunta</th>
                  <th className="py-2 pr-3 font-medium">Motor</th>
                  <th className="py-2 pr-3 font-medium">Intención · tipo</th>
                  <th className="py-2 pr-3 font-medium">Idioma · región</th>
                  <th className="py-2 pr-3 font-medium">Estado</th>
                  {canWrite && <th className="py-2 text-right font-medium"><span className="sr-only">Acciones</span></th>}
                </tr>
              </thead>
              <tbody>
                {items.map((p) => {
                  const e = engine(p.engine);
                  return (
                    <tr key={p.id} className="border-t border-line align-top">
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
    engines: ["gemini_api", "perplexity_api"] as string[],
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
        <Field label="Preguntas" htmlFor="geo-q" hint={`${lines.length} pregunta(s) × ${form.engines.length} motor(es) = ${rows} fila(s). Máximo 50 por envío; entre 8 y 300 caracteres.`}>
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
