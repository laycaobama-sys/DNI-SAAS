import { useMemo, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router";
import { del, fmtDate, post, put, timeAgo, ApiError } from "../lib/api";
import { useApi } from "../lib/hooks";
import { Badge, Button, Card, EmptyState, ErrorState, MetricCard, Notice, PageHeader, Select, Spinner } from "../ui";
import { DailyChart, fmtDay } from "./dailychart";

const ERRORS: Record<string, string> = {
  google_denied: "Cancelaste el permiso en Google. No se ha conectado nada.",
  scope_not_granted: "Google no concedió el permiso de lectura de Search Console (la casilla quedó sin marcar). Vuelve a conectar y marca ese permiso.",
  no_refresh_token: "Google no devolvió un permiso duradero. Vuelve a conectar.",
  session_mismatch: "La conexión se inició con otra sesión. Vuelve a intentarlo desde esta pantalla.",
  forbidden: "Tu rol no permite gestionar integraciones.",
  not_configured: "La conexión con Google no está configurada en este entorno.",
  token_exchange_failed: "Google no aceptó el código de autorización. Vuelve a intentarlo.",
  email_not_verified_by_google: "La cuenta de Google no tiene el correo verificado.",
  sites_PERMISSION_DENIED:
    "Conectado, pero Google rechazó la lista de propiedades. Suele significar que la «Google Search Console API» no está habilitada en el proyecto de Google Cloud. Habilítala y pulsa «Actualizar propiedades».",
};
const errorText = (code: string) => ERRORS[code] ?? (code.startsWith("sites_") ? `Conectado, pero Google no devolvió las propiedades (${code.slice(6)}). Pulsa «Actualizar propiedades».` : `No se pudo conectar (${code}).`);

const PERMISSION: Record<string, string> = {
  siteOwner: "Propietario",
  siteFullUser: "Usuario completo",
  siteRestrictedUser: "Usuario restringido",
  siteUnverifiedUser: "Sin verificar (sin acceso a datos)",
  none: "Sin acceso actualmente",
};
const STATUS: Record<string, { label: string; tone: "ok" | "warn" | "danger" | "neutral" }> = {
  connected: { label: "Conectado · solo lectura", tone: "ok" },
  reauth_required: { label: "Hay que volver a conectar", tone: "danger" },
  disconnected: { label: "Desconectado", tone: "neutral" },
};

const nf = new Intl.NumberFormat("es-ES");
const nil = (v: unknown): v is null | undefined => v === null || v === undefined;
const pct = (v: number | null | undefined) => (nil(v) ? null : `${(v * 100).toLocaleString("es-ES", { maximumFractionDigits: 1 })}`);
const pos = (v: number | null | undefined) => (nil(v) ? null : v.toLocaleString("es-ES", { maximumFractionDigits: 1 }));

type Metric = "clicks" | "impressions" | "ctr" | "position";
const METRICS: Record<Metric, { label: string; fmt: (v: number) => string }> = {
  clicks: { label: "Clics", fmt: (v) => nf.format(v) },
  impressions: { label: "Impresiones", fmt: (v) => nf.format(v) },
  ctr: { label: "CTR", fmt: (v) => `${pct(v)} %` },
  position: { label: "Posición media", fmt: (v) => pos(v)! },
};

function delta(cur: number | null, prev: number | null | undefined, invert = false) {
  if (nil(cur) || nil(prev) || prev === 0) return null;
  const d = (cur - prev) / prev;
  const good = invert ? d < 0 : d > 0;
  return { text: `${d > 0 ? "+" : ""}${(d * 100).toLocaleString("es-ES", { maximumFractionDigits: 1 })} %`, good };
}

function TopTable({ title, rows, kind }: { title: string; rows: any[]; kind: "query" | "page" }) {
  return (
    <Card className="min-w-0" title={title} subtitle={rows[0] ? `${fmtDay(rows[0].period_start)} – ${fmtDay(rows[0].period_end)} · observado` : undefined}>
      {rows.length === 0 ? (
        <p className="text-sm text-mute">Sin filas en este periodo. Google omite consultas anónimas o con muy pocas búsquedas.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[420px] text-sm">
            <thead className="text-left text-xs text-mute">
              <tr>
                <th className="py-2 pr-3 font-medium">{kind === "query" ? "Consulta" : "Página"}</th>
                <th className="py-2 pr-3 text-right font-medium">Clics</th>
                <th className="py-2 pr-3 text-right font-medium">Impr.</th>
                <th className="py-2 pr-3 text-right font-medium">CTR</th>
                <th className="py-2 text-right font-medium">Pos.</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.key} className="border-t border-line">
                  <td className="max-w-[260px] truncate py-2 pr-3" title={r.key}>
                    {r.key}
                  </td>
                  <td className="py-2 pr-3 text-right tabular-nums">{nf.format(r.clicks)}</td>
                  <td className="py-2 pr-3 text-right tabular-nums">{nf.format(r.impressions)}</td>
                  <td className="py-2 pr-3 text-right tabular-nums">{pct(r.ctr)} %</td>
                  <td className="py-2 text-right tabular-nums">{pos(r.position)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

function DecliningCard({ data }: { data: any }) {
  if (!data) {
    return (
      <Card title="Páginas que pierden clics" subtitle="Comparación de 28 días con los 28 anteriores">
        <p className="text-sm text-mute">Todavía no hay datos de los 28 días anteriores para comparar (por ejemplo, si la web es nueva en Search Console). Aparecerá sola cuando los haya, tras una sincronización.</p>
      </Card>
    );
  }
  const pages: any[] = data.pages ?? [];
  const period = data.period ? `${fmtDay(data.period.start)} – ${fmtDay(data.period.end)}` : "";
  const prev = `${fmtDay(data.previousPeriod.start)} – ${fmtDay(data.previousPeriod.end)}`;
  return (
    <Card title="Páginas que pierden clics" subtitle={`${period} frente a ${prev} · calculado con datos observados`}>
      {pages.length === 0 ? (
        <p className="text-sm text-mute">Ninguna página pierde clics de forma clara en este periodo. Regla: {data.rule.toLowerCase()}.</p>
      ) : (
        <ul className="divide-y divide-line">
          {pages.map((d) => (
            <li key={d.page} className="py-3">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <a className="min-w-0 max-w-full truncate font-medium underline-offset-2 hover:underline" href={/^https?:\/\//i.test(d.page) ? d.page : undefined} target="_blank" rel="noopener noreferrer" title={d.page}>
                  {d.page}
                </a>
                <span className="text-sm tabular-nums">
                  {nf.format(d.clicksBefore)} → {nf.format(d.clicksNow)} clics <Badge tone="danger">−{nf.format(d.lostClicks)}</Badge>
                </span>
              </div>
              <p className="mt-1 text-xs text-mute">
                Impresiones {nf.format(d.impressionsBefore)} → {nf.format(d.impressionsNow)} · posición {pos(d.positionBefore)} → {d.positionNow === null ? "—" : pos(d.positionNow)}
              </p>
              <p className="mt-1 text-sm">{d.advice}</p>
            </li>
          ))}
        </ul>
      )}
      <p className="mt-3 text-xs text-mute">
        {data.rule}. Fuente: {data.source}. Se calcula sin IA y estos datos no se envían a ningún modelo. Una bajada puede ser estacional: compárala con el mismo mes del año anterior en Search Console.
      </p>
    </Card>
  );
}

export function SearchConsolePage() {
  const { orgId } = useParams();
  const [params, setParams] = useSearchParams();
  const [tick, setTick] = useState(0);
  const { data, error, loading, reload } = useApi<any>(`/orgs/${orgId}/search-console${tick ? `?r=${tick}` : ""}`, {
    pollMs: 3000,
    pollWhile: (d: any) => !!d?.activeJob,
  });
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<ApiError | null>(null);
  const [metric, setMetric] = useState<Metric>("clicks");
  const [showTable, setShowTable] = useState(false);
  const [confirmOff, setConfirmOff] = useState(false);
  const [purge, setPurge] = useState(false);
  const [confirmDesel, setConfirmDesel] = useState(false);
  const [purgeSel, setPurgeSel] = useState(false);

  const run = async (key: string, fn: () => Promise<unknown>, poll = false) => {
    setErr(null);
    setBusy(key);
    try {
      await fn();
      if (poll) setTick((t) => t + 1);
      else await reload();
    } catch (e) {
      setErr(e as ApiError);
    } finally {
      setBusy(null);
    }
  };
  const connect = () =>
    run("connect", async () => {
      const r = await post<{ url: string }>(`/orgs/${orgId}/search-console/connect`);
      if (r.url.startsWith("https://accounts.google.com/")) window.location.assign(r.url);
    });

  const report = data?.report;
  const daily = useMemo(() => report?.daily ?? [], [report]);
  if (loading && !data) return <Spinner />;
  if (error) return <ErrorState error={error} onRetry={reload} />;

  const conn = data.connection;
  const readable = data.properties.filter((p: any) => p.readable);
  const selected = data.properties.find((p: any) => p.selected);
  const gscError = params.get("gsc_error");
  const t = report?.totals;
  const prev = report?.previousTotals;
  const limitations = report?.caveats ?? [];
  const observedAt = report?.observedAt ?? new Date().toISOString();

  return (
    <>
      <PageHeader
        eyebrow="Orgánico · datos observados"
        title="Search Console"
        subtitle="Clics, impresiones, CTR y posición de Google Search, leídos de tu propia cuenta con permiso de solo lectura."
      />
      <div className="mb-4 space-y-3">
        {params.get("gsc") === "connected" && !gscError && <Notice tone="ok">Search Console conectado. Elige la propiedad y sincroniza.</Notice>}
        {gscError && <Notice tone="warn" title="Conexión con Google">{errorText(gscError)}</Notice>}
        {(params.get("gsc") || gscError) && (
          <button type="button" className="text-xs text-mute underline" onClick={() => setParams({}, { replace: true })}>
            Ocultar aviso
          </button>
        )}
        {!data.configured && (
          <Notice tone="warn" title="Conexión no disponible en este entorno">
            Falta configurar el cliente de Google o la clave de cifrado: no se puede conectar ni sincronizar.{data.report ? " Se muestran solo los datos ya importados." : ""}
          </Notice>
        )}
        <ErrorState error={err} />
      </div>

      {!conn || (conn.status === "disconnected" && !report) ? (
        <EmptyState
          title="Sin cuenta de Search Console conectada"
          action={
            data.canManage ? (
              <Button variant="primary" onClick={connect} loading={busy === "connect"} disabled={!data.configured}>
                Conectar con Google (solo lectura)
              </Button>
            ) : (
              <p className="text-sm text-mute">Pide a un propietario o administrador que conecte Search Console.</p>
            )
          }
        >
          <p>Aquí no se muestra ninguna cifra hasta que conectes una cuenta con acceso real a tu propiedad. No estimamos ni inventamos clics.</p>
          <p className="mt-2">Pediremos solo el permiso «Ver datos de Search Console» (webmasters.readonly). Puedes desconectar cuando quieras.</p>
        </EmptyState>
      ) : (
        <div className="space-y-6">
          <Card
            title="Conexión"
            actions={<Badge tone={STATUS[conn.status]?.tone ?? "neutral"}>{STATUS[conn.status]?.label ?? conn.status}</Badge>}
          >
            <div className="grid gap-4 md:grid-cols-2">
              <div className="space-y-1 text-sm">
                {conn.account && <p>Cuenta de Google: <span className="font-medium">{conn.account}</span></p>}
                <p className="text-mute">Permiso: solo lectura de Search Console</p>
                <p className="text-mute">Última sincronización: {conn.lastSyncAt ? `${fmtDate(conn.lastSyncAt)} (${timeAgo(conn.lastSyncAt)})` : "todavía no"}</p>
                {data.activeJob && (
                  <p className="text-mute">
                    Sincronizando… <Link className="underline" to={`/o/${orgId}/jobs/${data.activeJob.id}`}>ver trabajo</Link>
                  </p>
                )}
                {data.lastJob?.state === "failed" && !data.activeJob && (
                  <p className="text-sm text-danger">La última sincronización falló ({data.lastJob.failure_code}).</p>
                )}
                {conn.lastError && <p className="text-xs text-mute">Último aviso de Google: {conn.lastError}</p>}
              </div>
              {data.canManage && (
                <div className="space-y-3">
                  {conn.status === "connected" ? (
                    <>
                      <div>
                        <label htmlFor="gsc-prop" className="mb-1 block text-sm font-medium">
                          Propiedad
                        </label>
                        <Select
                          id="gsc-prop"
                          value={selected?.id ?? ""}
                          disabled={busy === "select"}
                          onChange={(e) => {
                            const id = e.target.value;
                            if (id)
                              void run("select", async () => {
                                await put(`/orgs/${orgId}/search-console/property`, { propertyId: id });
                                await post(`/orgs/${orgId}/search-console/sync`);
                              }, true);
                          }}
                        >
                          <option value="">{readable.length ? "Elige una propiedad…" : "Ninguna propiedad con acceso"}</option>
                          {data.properties.map((p: any) => (
                            <option key={p.id} value={p.id} disabled={!p.readable}>
                              {p.siteUrl} · {PERMISSION[p.permissionLevel] ?? p.permissionLevel}
                            </option>
                          ))}
                        </Select>
                      </div>
                      <div className="flex flex-wrap gap-2">
                        <Button variant="primary" onClick={() => run("sync", () => post(`/orgs/${orgId}/search-console/sync`), true)} loading={busy === "sync"} disabled={!data.configured || !selected || !!data.activeJob}>
                          Sincronizar ahora
                        </Button>
                        <Button onClick={() => run("props", () => post(`/orgs/${orgId}/search-console/properties/refresh`))} loading={busy === "props"} disabled={!data.configured}>
                          Actualizar propiedades
                        </Button>
                        {selected && (
                          <Button variant="ghost" onClick={() => setConfirmDesel(true)}>
                            Dejar de usar esta propiedad
                          </Button>
                        )}
                        <Button variant="ghost" onClick={() => setConfirmOff(true)}>
                          Desconectar
                        </Button>
                      </div>
                    </>
                  ) : (
                    <Button variant="primary" onClick={connect} loading={busy === "connect"} disabled={!data.configured}>
                      Volver a conectar con Google
                    </Button>
                  )}
                  {confirmDesel && selected && (
                    <div className="rounded-xl border border-line p-3 text-sm">
                      <p>Se dejará de sincronizar «{selected.siteUrl}» y se cancelan las sincronizaciones pendientes. La conexión con Google se mantiene.</p>
                      <label className="mt-2 flex items-center gap-2">
                        <input type="checkbox" checked={purgeSel} onChange={(e) => setPurgeSel(e.target.checked)} />
                        Borrar también los datos ya importados de esta propiedad (no se puede deshacer)
                      </label>
                      <div className="mt-3 flex gap-2">
                        <Button
                          variant="danger"
                          loading={busy === "desel"}
                          onClick={() =>
                            run("desel", async () => {
                              await del(`/orgs/${orgId}/search-console/property${purgeSel ? "?purge=true" : ""}`);
                              setConfirmDesel(false);
                              setPurgeSel(false);
                            })
                          }
                        >
                          Dejar de usar
                        </Button>
                        <Button variant="ghost" onClick={() => setConfirmDesel(false)}>
                          Cancelar
                        </Button>
                      </div>
                    </div>
                  )}
                  {confirmOff && (
                    <div className="rounded-xl border border-line p-3 text-sm">
                      <p>Se borrará el permiso guardado (cifrado) de esta organización. Si tu cuenta de Google no está conectada en ninguna otra organización ni en otro módulo, también se pedirá a Google que revoque el acceso; si lo está, esas conexiones siguen funcionando y puedes retirar el permiso cuando quieras en myaccount.google.com/permissions.</p>
                      <label className="mt-2 flex items-center gap-2">
                        <input type="checkbox" checked={purge} onChange={(e) => setPurge(e.target.checked)} />
                        Borrar también los datos ya importados (no se puede deshacer)
                      </label>
                      <div className="mt-3 flex gap-2">
                        <Button
                          variant="danger"
                          loading={busy === "off"}
                          onClick={() =>
                            run("off", async () => {
                              await del(`/orgs/${orgId}/search-console${purge ? "?purge=true" : ""}`);
                              setConfirmOff(false);
                              setPurge(false);
                            })
                          }
                        >
                          Desconectar
                        </Button>
                        <Button variant="ghost" onClick={() => setConfirmOff(false)}>
                          Cancelar
                        </Button>
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          </Card>

          {!report ? (
            <EmptyState title="Elige una propiedad">No elegimos ninguna por ti: la cuenta de Google puede tener propiedades de otras marcas o clientes. Cuando elijas una propiedad con permiso de lectura se importarán sus datos de los últimos 90 días.</EmptyState>
          ) : !t ? (
            <EmptyState title={data.activeJob ? "Importando datos…" : "Sin datos importados todavía"}>
              {data.activeJob
                ? "Primera sincronización en curso (normalmente unos segundos)."
                : report.lastSyncAt
                  ? `Sincronizado ${timeAgo(report.lastSyncAt)}: Google no tiene clics ni impresiones de ${report.siteUrl} en los últimos 90 días con datos definitivos. Es normal en un sitio recién añadido o con poco tráfico de búsqueda; se vuelve a consultar automáticamente cada día. No mostramos estimaciones.`
                  : `Propiedad ${report.siteUrl}: pulsa «Sincronizar ahora».`}
            </EmptyState>
          ) : (
            <>
              <p className="text-sm text-mute">
                {report.siteUrl} · {fmtDay(report.period.start)} – {fmtDay(report.period.end)} ({t.days} días con datos)
                {report.previousPeriod ? ` · comparado con ${fmtDay(report.previousPeriod.start)} – ${fmtDay(report.previousPeriod.end)}` : ""}
              </p>
              <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
                {(
                  [
                    ["clicks", "Clics", t.clicks, "", delta(t.clicks, prev?.clicks)],
                    ["impressions", "Impresiones", t.impressions, "", delta(t.impressions, prev?.impressions)],
                    ["ctr", "CTR medio", nil(t.ctr) ? null : Math.round(t.ctr * 1000) / 10, "%", delta(t.ctr, prev?.ctr)],
                    ["position", "Posición media", nil(t.position) ? null : Math.round(t.position * 10) / 10, "", delta(t.position, prev?.position, true)],
                  ] as const
                ).map(([k, label, value, unit, d]) => (
                  <div key={k}>
                    <MetricCard
                      m={{
                        metric: k,
                        label,
                        value,
                        unit,
                        measurement: "derived",
                        source: `${report.source}. ${k === "clicks" || k === "impressions" ? "Suma de los totales diarios observados." : k === "ctr" ? "Clics ÷ impresiones del periodo." : "Media de las posiciones diarias ponderada por impresiones."}`,
                        observedAt,
                        limitations,
                      }}
                    />
                    {d && (
                      <p className={`mt-1 text-xs ${d.good ? "text-ok" : "text-mute"}`}>
                        {d.text} vs. periodo anterior
                      </p>
                    )}
                  </div>
                ))}
              </div>

              <Card
                title={`${METRICS[metric].label} por día`}
                subtitle="Datos observados por día (estado «final»)."
                actions={
                  <div className="flex flex-wrap items-center gap-2">
                    <div role="group" aria-label="Métrica del gráfico" className="flex overflow-hidden rounded-xl border border-line text-xs">
                      {(Object.keys(METRICS) as Metric[]).map((k) => (
                        <button key={k} type="button" aria-pressed={metric === k} onClick={() => setMetric(k)} className={`px-2.5 py-1.5 ${metric === k ? "bg-surface-2 font-semibold" : "text-mute"}`}>
                          {METRICS[k].label}
                        </button>
                      ))}
                    </div>
                    <button type="button" className="text-xs text-mute underline" onClick={() => setShowTable((s) => !s)} aria-expanded={showTable}>
                      {showTable ? "Ver gráfico" : "Ver tabla"}
                    </button>
                  </div>
                }
              >
                {showTable ? (
                  <div className="max-h-80 overflow-auto">
                    <table className="w-full text-sm">
                      <thead className="text-left text-xs text-mute">
                        <tr>
                          <th className="py-1 pr-3 font-medium">Fecha</th>
                          <th className="py-1 pr-3 text-right font-medium">Clics</th>
                          <th className="py-1 pr-3 text-right font-medium">Impresiones</th>
                          <th className="py-1 pr-3 text-right font-medium">CTR</th>
                          <th className="py-1 text-right font-medium">Posición</th>
                        </tr>
                      </thead>
                      <tbody>
                        {daily.map((r: any) => (
                          <tr key={r.date} className="border-t border-line">
                            <td className="py-1 pr-3">{r.date}</td>
                            <td className="py-1 pr-3 text-right tabular-nums">{nf.format(r.clicks)}</td>
                            <td className="py-1 pr-3 text-right tabular-nums">{nf.format(r.impressions)}</td>
                            <td className="py-1 pr-3 text-right tabular-nums">{pct(r.ctr)} %</td>
                            <td className="py-1 text-right tabular-nums">{pos(r.position)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <DailyChart
                    rows={daily}
                    value={(r: any) => r[metric]}
                    fmt={METRICS[metric].fmt}
                    minMax={metric === "ctr" ? 0.01 : 1}
                    label={`${METRICS[metric].label} por día`}
                    tooltip={(h: any) => `${nf.format(h.clicks)} clics · ${nf.format(h.impressions)} impresiones · CTR ${pct(h.ctr)} % · posición ${pos(h.position)}`}
                  />
                )}
              </Card>

              <div className="grid gap-6 xl:grid-cols-2">
                <TopTable title="Consultas principales" rows={report.topQueries} kind="query" />
                <TopTable title="Páginas principales" rows={report.topPages} kind="page" />
              </div>

              <DecliningCard data={report.declining} />

              <Card title="Cómo leer estos datos">
                <ul className="list-disc space-y-1 pl-5 text-sm text-mute">
                  {limitations.map((l: string) => (
                    <li key={l}>{l}</li>
                  ))}
                  <li>Fuente: {report.source}. Importado {timeAgo(report.observedAt)}.</li>
                </ul>
              </Card>
            </>
          )}
        </div>
      )}
    </>
  );
}
