import { useEffect, useState } from "react";
import { useParams, useSearchParams } from "react-router";
import { Download, FileJson, Printer } from "lucide-react";
import { fmtDate } from "../lib/api";
import { useApi } from "../lib/hooks";
import { Badge, Button, Card, EmptyState, ErrorState, Field, Notice, PageHeader, Select, Spinner } from "../ui";

type Section = { status: "ok" | "not_connected" | "no_data" | "no_brand"; note?: string; source?: string; observedAt?: string; caveats?: string[]; [k: string]: any };
type Report = {
  report: string;
  organization: string | null;
  brand: { id: string; name: string; domain: string | null } | null;
  generatedAt: string;
  sections: { searchConsole: Section; analytics: Section; geo: Section };
  disclaimers: string[];
};

const nf = new Intl.NumberFormat("es-ES", { useGrouping: "always" });
const num = (v: number | null | undefined) => (v === null || v === undefined ? "—" : nf.format(v));
const pct = (v: number | null | undefined) => (v === null || v === undefined ? "—" : `${(v * 100).toLocaleString("es-ES", { maximumFractionDigits: 1 })} %`);
const MEASURE: Record<string, string> = { observed: "observado", derived: "derivado", observed_sample: "muestra observada" };
const measure = (m: string | undefined) => (m ? (MEASURE[m] ?? m) : "");
const day = (s: string | undefined) => (s ? new Date(`${s.slice(0, 10)}T12:00:00Z`).toLocaleDateString("es-ES", { dateStyle: "medium" }) : "—");

function Unavailable({ s }: { s: Section }) {
  const label = s.status === "not_connected" ? "No conectado" : s.status === "no_brand" ? "Sin marca" : "Sin datos";
  return (
    <p className="text-sm text-mute">
      <Badge>{label}</Badge> {s.note}
    </p>
  );
}

function Meta({ s, period }: { s: Section; period?: string }) {
  return (
    <div className="mt-3 space-y-1 text-xs text-mute">
      <p>
        Fuente: {s.source}
        {period ? ` · Periodo: ${period}` : ""}
        {s.observedAt ? ` · Observado: ${fmtDate(s.observedAt)}` : ""}
      </p>
      {(s.caveats ?? []).map((c: string) => (
        <p key={c}>· {c}</p>
      ))}
    </div>
  );
}

function Table({ head, rows }: { head: string[]; rows: Array<Array<string | number>> }) {
  return (
    <div className="overflow-x-auto print:overflow-visible">
      <table className="w-full text-left text-sm">
        <thead className="text-xs text-mute">
          <tr>
            {head.map((h, i) => (
              <th key={h} className={i ? "px-2 py-1 text-right font-medium" : "py-1 pr-2 font-medium"}>
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className="border-t border-line">
              {r.map((c, j) => (
                <td key={j} className={j ? "px-2 py-1 text-right tabular-nums" : "max-w-[28rem] break-all py-1 pr-2"}>
                  {c}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Stat({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div className="rounded-xl border border-line p-3 print:break-inside-avoid">
      <p className="text-xs text-mute">{label}</p>
      <p className="text-xl font-semibold tabular-nums">{value}</p>
      {note && <p className="text-xs text-mute">{note}</p>}
    </div>
  );
}

function GscView({ s }: { s: Section }) {
  if (s.status !== "ok") return <Unavailable s={s} />;
  return (
    <>
      <p className="mb-3 text-sm text-mute">Propiedad: {s.property}</p>
      <div className="grid gap-3 sm:grid-cols-4">
        <Stat label="Clics" value={num(s.totals.clicks)} note={measure(s.measurement.clicks)} />
        <Stat label="Impresiones" value={num(s.totals.impressions)} note={measure(s.measurement.impressions)} />
        <Stat label="CTR" value={pct(s.totals.ctr)} note={measure(s.measurement.ctr)} />
        <Stat label="Posición media" value={s.totals.averagePosition === null ? "—" : String(s.totals.averagePosition).replace(".", ",")} note="derivado (ponderado por impresiones)" />
      </div>
      {s.topQueries.length > 0 && (
        <div className="mt-4">
          <p className="mb-1 text-sm font-medium">Consultas principales</p>
          <Table head={["Consulta", "Clics", "Impresiones", "Posición"]} rows={s.topQueries.map((q: any) => [q.key, num(q.clicks), num(q.impressions), String(q.position).replace(".", ",")])} />
        </div>
      )}
      <Meta s={s} period={`${day(s.period.from)} – ${day(s.period.to)} (${s.period.days} días con datos)`} />
    </>
  );
}

function Ga4View({ s }: { s: Section }) {
  if (s.status !== "ok") return <Unavailable s={s} />;
  const c = s.current;
  const p = s.previous;
  return (
    <>
      <p className="mb-3 text-sm text-mute">
        Propiedad: {s.property}
        {s.timeZone ? ` · zona horaria ${s.timeZone}` : ""}
      </p>
      <div className="grid gap-3 sm:grid-cols-4">
        <Stat label="Sesiones" value={num(c.sessions)} note={p ? `anterior: ${num(p.sessions)}` : "observado"} />
        <Stat label="Usuarios" value={num(c.totalUsers)} note={p ? `anterior: ${num(p.totalUsers)}` : "observado"} />
        <Stat label="Tasa de interacción" value={pct(c.engagementRate)} note="derivado" />
        <Stat label="Eventos clave" value={num(c.keyEvents)} note={p ? `anterior: ${num(p.keyEvents)}` : "observado"} />
      </div>
      {s.topChannels.length > 0 && (
        <div className="mt-4">
          <p className="mb-1 text-sm font-medium">Canales principales</p>
          <Table head={["Canal", "Sesiones", "Usuarios", "Eventos clave"]} rows={s.topChannels.map((x: any) => [x.key, num(x.sessions), num(x.total_users), num(x.key_events)])} />
        </div>
      )}
      <Meta s={s} period={`${day(c.period.from)} – ${day(c.period.to)}${p ? ` (anterior: ${day(p.period.from)} – ${day(p.period.to)})` : ""}`} />
    </>
  );
}

function GeoView({ s }: { s: Section }) {
  if (s.status === "no_brand") return <Unavailable s={s} />;
  const v = s.visibility;
  if (s.status !== "ok") return <Unavailable s={{ ...s, source: v?.source }} />;
  const ci = v.mentionRateInterval ? `margen 95 %: ${Math.round(v.mentionRateInterval.low * 100)}–${Math.round(v.mentionRateInterval.high * 100)} %` : "";
  return (
    <>
      <div className="grid gap-3 sm:grid-cols-3">
        <Stat label="Preguntas donde aparece la marca" value={`${v.mentioned} de ${v.sampledPrompts}`} note={`${pct(v.mentionRate)} · ${ci}`} />
        <Stat label="Respuestas que citan la web" value={v.groundedSamples ? `${v.cited} de ${v.groundedSamples}` : "—"} note={v.groundedSamples ? "sobre respuestas con búsqueda" : "ninguna respuesta usó búsqueda"} />
        <Stat label="Modelos que respondieron" value={String(v.models.length)} note={v.models.join(", ")} />
      </div>
      <div className="mt-4">
        <p className="mb-1 text-sm font-medium">Preguntas muestreadas</p>
        <Table
          head={["Pregunta", "Marca", "Búsqueda", "Fecha"]}
          rows={s.prompts.map((p: any) => [p.question, p.mentioned ? "Aparece" : "No aparece", p.grounded ? "Sí" : "No", day(p.sampledAt)])}
        />
      </div>
      {s.recommendations.length > 0 && (
        <div className="mt-4 print:break-inside-avoid">
          <p className="mb-1 text-sm font-medium">Recomendaciones (derivadas, con revisión humana)</p>
          <ol className="list-decimal space-y-1 pl-5 text-sm">
            {s.recommendations.map((r: any) => (
              <li key={r.title + r.target}>
                <span className="font-medium">[{r.priority}]</span> {r.title}. <span className="text-mute">{r.action}</span>
              </li>
            ))}
          </ol>
          <p className="mt-1 text-xs text-mute">{s.recommendationsMethod}</p>
        </div>
      )}
      <Meta s={{ ...v, source: v.source }} period={v.period ? `${day(v.period.from)} – ${day(v.period.to)}` : undefined} />
    </>
  );
}

export function ReportsPage() {
  const { orgId = "" } = useParams();
  const [params, setParams] = useSearchParams();
  const brands = useApi<{ items: Array<{ id: string; name: string; domain: string | null }> }>(`/orgs/${orgId}/brands`);
  const brandId = params.get("brand") ?? brands.data?.items[0]?.id ?? "";
  const path = brands.data ? `/orgs/${orgId}/reports/performance${brandId ? `?brandId=${brandId}` : ""}` : null;
  const rep = useApi<Report>(path);
  const [printing, setPrinting] = useState(false);
  useEffect(() => {
    if (!printing) return;
    const t = window.setTimeout(() => {
      window.print();
      setPrinting(false);
    }, 50);
    return () => window.clearTimeout(t);
  }, [printing]);
  const dl = (format: "csv" | "json") => `/api/v1/orgs/${orgId}/reports/performance?format=${format}${brandId ? `&brandId=${brandId}` : ""}`;
  const r = rep.data;
  return (
    <>
      <div className="print:hidden">
        <PageHeader eyebrow="Medición · Informes" title="Informe de rendimiento" subtitle="Search Console, Analytics y visibilidad en IA en un solo informe, con la fuente, el periodo y el tipo de medida de cada cifra." />
      </div>
      {brands.error && <ErrorState error={brands.error} onRetry={brands.reload} />}
      {brands.data && brands.data.items.length === 0 && <EmptyState title="Aún no hay marcas">Analiza tu web para crear la primera marca.</EmptyState>}
      {brands.data && brands.data.items.length > 0 && (
        <div className="mb-4 flex flex-wrap items-end gap-3 print:hidden">
          <Field label="Marca" htmlFor="rep-brand">
            <Select id="rep-brand" value={brandId} onChange={(e) => setParams({ brand: e.target.value })} className="min-w-[220px]">
              {brands.data.items.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                  {b.domain ? ` · ${b.domain}` : ""}
                </option>
              ))}
            </Select>
          </Field>
          <a href={dl("csv")} download className="inline-flex items-center gap-2 rounded-full border border-line px-4 py-2 text-sm hover:bg-surface-2">
            <Download className="size-4" aria-hidden /> Descargar CSV
          </a>
          <a href={dl("json")} download className="inline-flex items-center gap-2 rounded-full border border-line px-4 py-2 text-sm hover:bg-surface-2">
            <FileJson className="size-4" aria-hidden /> Descargar JSON
          </a>
          <Button type="button" onClick={() => setPrinting(true)} disabled={!r}>
            <Printer className="size-4" aria-hidden /> Descargar PDF
          </Button>
        </div>
      )}
      <p className="mb-4 text-xs text-mute print:hidden">«Descargar PDF» abre la ventana de impresión del navegador: elige «Guardar como PDF». Las descargas quedan registradas en los logs de auditoría.</p>
      {rep.error && <ErrorState error={rep.error} onRetry={rep.reload} />}
      {path && !r && !rep.error && <Spinner />}
      {r && (
        <article className="space-y-4 print:space-y-3 print:text-black" aria-label="Informe">
          <header className="hidden print:block">
            <p className="text-xs">DNI Growth · {r.report}</p>
            <h1 className="text-2xl font-semibold">
              {r.brand?.name ?? r.organization}
              {r.brand?.domain ? ` · ${r.brand.domain}` : ""}
            </h1>
          </header>
          <p className="text-sm text-mute">
            Organización: {r.organization ?? "—"} · Generado: {fmtDate(r.generatedAt)}
          </p>
          <Card title="Search Console (Búsqueda de Google)">
            <GscView s={r.sections.searchConsole} />
          </Card>
          <Card title="Google Analytics 4">
            <Ga4View s={r.sections.analytics} />
          </Card>
          <Card title="Visibilidad en motores de IA (GEO)">
            <GeoView s={r.sections.geo} />
          </Card>
          <Notice title="Cómo leer este informe">
            <ul className="list-disc space-y-1 pl-5">
              {r.disclaimers.map((d) => (
                <li key={d}>{d}</li>
              ))}
            </ul>
          </Notice>
        </article>
      )}
    </>
  );
}
