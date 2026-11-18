import { useMemo, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router";
import { del, fmtDate, post, put, timeAgo, ApiError } from "../lib/api";
import { useApi } from "../lib/hooks";
import { Badge, Button, Card, EmptyState, ErrorState, MetricCard, Notice, PageHeader, Select, Spinner } from "../ui";
import { DailyChart, fmtDay } from "./dailychart";

const ERRORS: Record<string, string> = {
  google_denied: "Cancelaste el permiso en Google. No se ha conectado nada.",
  scope_not_granted: "Google no concedió el permiso de lectura de Google Analytics (la casilla quedó sin marcar). Vuelve a conectar y marca ese permiso.",
  no_refresh_token: "Google no devolvió un permiso duradero. Vuelve a conectar.",
  session_mismatch: "La conexión se inició con otra sesión. Vuelve a intentarlo desde esta pantalla.",
  forbidden: "Tu rol no permite gestionar integraciones.",
  not_configured: "La conexión con Google no está configurada en este entorno.",
  token_exchange_failed: "Google no aceptó el código de autorización. Vuelve a intentarlo.",
  email_not_verified_by_google: "La cuenta de Google no tiene el correo verificado.",
  properties_PERMISSION_DENIED:
    "Conectado, pero Google rechazó la lista de propiedades. Suele significar que la «Google Analytics Admin API» no está habilitada en el proyecto de Google Cloud. Habilítala y pulsa «Actualizar propiedades».",
};
const errorText = (code: string) =>
  ERRORS[code] ?? (code.startsWith("properties_") ? `Conectado, pero Google no devolvió las propiedades (${code.slice(11)}). Pulsa «Actualizar propiedades».` : `No se pudo conectar (${code}).`);

const STATUS: Record<string, { label: string; tone: "ok" | "warn" | "danger" | "neutral" }> = {
  connected: { label: "Conectado · solo lectura", tone: "ok" },
  reauth_required: { label: "Hay que volver a conectar", tone: "danger" },
  disconnected: { label: "Desconectado", tone: "neutral" },
};

const nf = new Intl.NumberFormat("es-ES", { maximumFractionDigits: 2 });
const nil = (v: unknown): v is null | undefined => v === null || v === undefined;

type Metric = "sessions" | "totalUsers" | "screenPageViews" | "keyEvents";
const METRICS: Record<Metric, string> = { sessions: "Sesiones", totalUsers: "Usuarios", screenPageViews: "Vistas", keyEvents: "Eventos clave" };

function delta(cur: number | null | undefined, prev: number | null | undefined) {
  if (nil(cur) || nil(prev) || prev === 0) return null;
  const d = (cur - prev) / prev;
  return { text: `${d > 0 ? "+" : ""}${(d * 100).toLocaleString("es-ES", { maximumFractionDigits: 1 })} %`, good: d > 0 };
}

function TopTable({ title, rows, head }: { title: string; rows: any[]; head: string }) {
  return (
    <Card className="min-w-0" title={title} subtitle={rows[0] ? `${fmtDay(rows[0].period_start)} – ${fmtDay(rows[0].period_end)} · observado` : undefined}>
      {rows.length === 0 ? (
        <p className="text-sm text-mute">Sin filas en este periodo.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[420px] text-sm">
            <thead className="text-left text-xs text-mute">
              <tr>
                <th className="py-2 pr-3 font-medium">{head}</th>
                <th className="py-2 pr-3 text-right font-medium">Sesiones</th>
                <th className="py-2 pr-3 text-right font-medium">Usuarios</th>
                <th className="py-2 pr-3 text-right font-medium">Con interacción</th>
                <th className="py-2 text-right font-medium">Ev. clave</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.key} className="border-t border-line">
                  <td className="max-w-[260px] truncate py-2 pr-3" title={r.key}>
                    {r.key}
                  </td>
                  <td className="py-2 pr-3 text-right tabular-nums">{nf.format(r.sessions)}</td>
                  <td className="py-2 pr-3 text-right tabular-nums">{nf.format(r.total_users)}</td>
                  <td className="py-2 pr-3 text-right tabular-nums">{nf.format(r.engaged_sessions)}</td>
                  <td className="py-2 text-right tabular-nums">{nf.format(r.key_events)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

export function AnalyticsPage() {
  const { orgId } = useParams();
  const [params, setParams] = useSearchParams();
  const [tick, setTick] = useState(0);
  const { data, error, loading, reload } = useApi<any>(`/orgs/${orgId}/analytics${tick ? `?r=${tick}` : ""}`, {
    pollMs: 3000,
    pollWhile: (d: any) => !!d?.activeJob,
  });
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<ApiError | null>(null);
  const [metric, setMetric] = useState<Metric>("sessions");
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
      const r = await post<{ url: string }>(`/orgs/${orgId}/analytics/connect`);
      if (r.url.startsWith("https://accounts.google.com/")) window.location.assign(r.url);
    });

  const report = data?.report;
  const daily = useMemo(() => report?.daily ?? [], [report]);
  if (loading && !data) return <Spinner />;
  if (error) return <ErrorState error={error} onRetry={reload} />;

  const conn = data.connection;
  const readable = data.properties.filter((p: any) => p.readable);
  const selected = data.properties.find((p: any) => p.selected);
  const gaError = params.get("ga4_error");
  const t = report?.totals;
  const prev = report?.previousTotals;
  const limitations: string[] = report?.caveats ?? [];
  const observedAt = report?.observedAt ?? new Date().toISOString();

  return (
    <>
      <PageHeader
        eyebrow="Datos observados · Google Analytics 4"
        title="Analytics"
        subtitle="Sesiones, usuarios, vistas y eventos clave de tu propiedad de GA4, leídos de tu propia cuenta con permiso de solo lectura."
      />
      <div className="mb-4 space-y-3">
        {params.get("ga4") === "connected" && !gaError && <Notice tone="ok">Google Analytics conectado. Elige la propiedad y sincroniza.</Notice>}
        {gaError && <Notice tone="warn" title="Conexión con Google">{errorText(gaError)}</Notice>}
        {(params.get("ga4") || gaError) && (
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
          title="Sin cuenta de Google Analytics conectada"
          action={
            data.canManage ? (
              <Button variant="primary" onClick={connect} loading={busy === "connect"} disabled={!data.configured}>
                Conectar con Google (solo lectura)
              </Button>
            ) : (
              <p className="text-sm text-mute">Pide a un propietario o administrador que conecte Google Analytics.</p>
            )
          }
        >
          <p>Aquí no se muestra ninguna cifra hasta que conectes una cuenta con acceso real a una propiedad de GA4. No estimamos ni inventamos visitas.</p>
          <p className="mt-2">Pediremos solo el permiso «Ver tus datos de Google Analytics» (analytics.readonly), separado del de Search Console. Puedes desconectar cuando quieras y Google revoca el acceso.</p>
        </EmptyState>
      ) : (
        <div className="space-y-6">
          <Card title="Conexión" actions={<Badge tone={STATUS[conn.status]?.tone ?? "neutral"}>{STATUS[conn.status]?.label ?? conn.status}</Badge>}>
            <div className="grid gap-4 md:grid-cols-2">
              <div className="space-y-1 text-sm">
                {conn.account && (
                  <p>
                    Cuenta de Google: <span className="font-medium">{conn.account}</span>
                  </p>
                )}
                <p className="text-mute">Permiso: solo lectura de Google Analytics</p>
                <p className="text-mute">Última sincronización: {conn.lastSyncAt ? `${fmtDate(conn.lastSyncAt)} (${timeAgo(conn.lastSyncAt)})` : "todavía no"}</p>
                {data.activeJob && (
                  <p className="text-mute">
                    Sincronizando…{" "}
                    <Link className="underline" to={`/o/${orgId}/jobs/${data.activeJob.id}`}>
                      ver trabajo
                    </Link>
                  </p>
                )}
                {data.lastJob?.state === "failed" && !data.activeJob && <p className="text-sm text-danger">La última sincronización falló ({data.lastJob.failure_code}).</p>}
                {conn.lastError && <p className="text-xs text-mute">Último aviso de Google: {conn.lastError}</p>}
              </div>
              {data.canManage && (
                <div className="space-y-3">
                  {conn.status === "connected" ? (
                    <>
                      <div>
                        <label htmlFor="ga4-prop" className="mb-1 block text-sm font-medium">
                          Propiedad de GA4
                        </label>
                        <Select
                          id="ga4-prop"
                          value={selected?.id ?? ""}
                          disabled={busy === "select"}
                          onChange={(e) => {
                            const id = e.target.value;
                            if (id)
                              void run(
                                "select",
                                async () => {
                                  await put(`/orgs/${orgId}/analytics/property`, { propertyId: id });
                                  await post(`/orgs/${orgId}/analytics/sync`);
                                },
                                true,
                              );
                          }}
                        >
                          <option value="">{readable.length ? "Elige una propiedad…" : "Ninguna propiedad con acceso"}</option>
                          {data.properties.map((p: any) => (
                            <option key={p.id} value={p.id} disabled={!p.readable}>
                              {p.displayName}
                              {p.accountName ? ` · ${p.accountName}` : ""} · {p.property.replace("properties/", "ID ")}
                              {p.readable ? "" : " · sin acceso"}
                            </option>
                          ))}
                        </Select>
                        {data.properties.length === 0 && (
                          <p className="mt-1 text-xs text-mute">Esta cuenta de Google no tiene acceso a ninguna propiedad de GA4. Crea una o pide acceso de lectura y pulsa «Actualizar propiedades».</p>
                        )}
                      </div>
                      <div className="flex flex-wrap gap-2">
                        <Button
                          variant="primary"
                          onClick={() => run("sync", () => post(`/orgs/${orgId}/analytics/sync`), true)}
                          loading={busy === "sync"}
                          disabled={!data.configured || !selected || !!data.activeJob}
                        >
                          Sincronizar ahora
                        </Button>
                        <Button onClick={() => run("props", () => post(`/orgs/${orgId}/analytics/properties/refresh`))} loading={busy === "props"} disabled={!data.configured}>
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
                      <p>Se dejará de sincronizar «{selected.displayName}» y se cancelan las sincronizaciones pendientes. La conexión con Google se mantiene.</p>
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
                              await del(`/orgs/${orgId}/analytics/property${purgeSel ? "?purge=true" : ""}`);
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
                      <p>Se pedirá a Google que revoque el acceso y se borrará el permiso guardado (cifrado).</p>
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
                              await del(`/orgs/${orgId}/analytics${purge ? "?purge=true" : ""}`);
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
            <EmptyState title="Elige una propiedad">No elegimos ninguna por ti: la cuenta de Google puede tener propiedades de otras marcas o clientes. Cuando elijas una propiedad de GA4 se importarán sus datos de los últimos 90 días.</EmptyState>
          ) : !t && daily.length === 0 ? (
            <EmptyState title={data.activeJob ? "Importando datos…" : "Sin datos importados todavía"}>
              {data.activeJob
                ? "Primera sincronización en curso (normalmente unos segundos)."
                : report.lastSyncAt
                  ? `Sincronizado ${timeAgo(report.lastSyncAt)}: Google Analytics no tiene sesiones de «${report.displayName}» en los últimos 90 días. Suele significar que la etiqueta de GA4 no está instalada en la web o que la propiedad es nueva; se vuelve a consultar automáticamente cada día. No mostramos estimaciones.`
                  : `Propiedad «${report.displayName}»: pulsa «Sincronizar ahora».`}
            </EmptyState>
          ) : (
            <>
              <p className="text-sm text-mute">
                {report.displayName} ({report.property.replace("properties/", "ID ")})
                {t ? ` · ${fmtDay(t.period.start)} – ${fmtDay(t.period.end)}` : ""}
                {prev ? ` · comparado con ${fmtDay(prev.period.start)} – ${fmtDay(prev.period.end)}` : ""}
                {report.timeZone ? ` · zona horaria ${report.timeZone}` : ""}
              </p>
              {(report.thresholded || report.sampled) && (
                <Notice tone="warn" title="Datos con limitaciones de GA4">
                  {report.sampled ? "GA4 muestreó parte de los datos: las cifras son aproximadas. " : ""}
                  {report.thresholded ? "GA4 ocultó filas con pocos usuarios por privacidad (umbrales): los desgloses pueden no sumar el total." : ""}
                </Notice>
              )}
              {t ? (
                <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-5">
                  {(
                    [
                      ["sessions", "Sesiones", t.sessions, "", "observed", delta(t.sessions, prev?.sessions)],
                      ["totalUsers", "Usuarios", t.totalUsers, "", "observed", delta(t.totalUsers, prev?.totalUsers)],
                      ["screenPageViews", "Vistas", t.screenPageViews, "", "observed", delta(t.screenPageViews, prev?.screenPageViews)],
                      ["engagementRate", "Tasa de interacción", nil(t.engagementRate) ? null : Math.round(t.engagementRate * 1000) / 10, "%", "derived", delta(t.engagementRate, prev?.engagementRate)],
                      ["keyEvents", "Eventos clave", t.keyEvents, "", "observed", delta(t.keyEvents, prev?.keyEvents)],
                    ] as const
                  ).map(([k, label, value, unit, measurement, d]) => (
                    <div key={k}>
                      <MetricCard
                        m={{
                          metric: k,
                          label,
                          value,
                          unit,
                          measurement,
                          source: `${report.source}. ${k === "engagementRate" ? "Sesiones con interacción ÷ sesiones del periodo." : "Total del periodo calculado por GA4."}`,
                          observedAt,
                          limitations,
                        }}
                      />
                      {d && <p className={`mt-1 text-xs ${d.good ? "text-ok" : "text-mute"}`}>{d.text} vs. periodo anterior</p>}
                    </div>
                  ))}
                </div>
              ) : (
                <Notice tone="info">GA4 no devolvió totales para los últimos 28 días.</Notice>
              )}

              <Card
                title={`${METRICS[metric]} por día`}
                subtitle="Datos observados por día, en la zona horaria de la propiedad."
                actions={
                  <div className="flex flex-wrap items-center gap-2">
                    <div role="group" aria-label="Métrica del gráfico" className="flex overflow-hidden rounded-xl border border-line text-xs">
                      {(Object.keys(METRICS) as Metric[]).map((k) => (
                        <button key={k} type="button" aria-pressed={metric === k} onClick={() => setMetric(k)} className={`px-2.5 py-1.5 ${metric === k ? "bg-surface-2 font-semibold" : "text-mute"}`}>
                          {METRICS[k]}
                        </button>
                      ))}
                    </div>
                    <button type="button" className="text-xs text-mute underline" onClick={() => setShowTable((s) => !s)} aria-expanded={showTable}>
                      {showTable ? "Ver gráfico" : "Ver tabla"}
                    </button>
                  </div>
                }
              >
                {daily.length === 0 ? (
                  <p className="text-sm text-mute">Sin días con actividad en el periodo importado.</p>
                ) : showTable ? (
                  <div className="max-h-80 overflow-auto">
                    <table className="w-full text-sm">
                      <thead className="text-left text-xs text-mute">
                        <tr>
                          <th className="py-1 pr-3 font-medium">Fecha</th>
                          <th className="py-1 pr-3 text-right font-medium">Sesiones</th>
                          <th className="py-1 pr-3 text-right font-medium">Usuarios</th>
                          <th className="py-1 pr-3 text-right font-medium">Vistas</th>
                          <th className="py-1 text-right font-medium">Ev. clave</th>
                        </tr>
                      </thead>
                      <tbody>
                        {daily.map((r: any) => (
                          <tr key={r.date} className="border-t border-line">
                            <td className="py-1 pr-3">{r.date}</td>
                            <td className="py-1 pr-3 text-right tabular-nums">{nf.format(r.sessions)}</td>
                            <td className="py-1 pr-3 text-right tabular-nums">{nf.format(r.totalUsers)}</td>
                            <td className="py-1 pr-3 text-right tabular-nums">{nf.format(r.screenPageViews)}</td>
                            <td className="py-1 text-right tabular-nums">{nf.format(r.keyEvents)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <DailyChart
                    rows={daily}
                    value={(r: any) => r[metric]}
                    fmt={(v) => nf.format(Math.round(v * 10) / 10)}
                    label={`${METRICS[metric]} por día`}
                    tooltip={(h: any) => `${nf.format(h.sessions)} sesiones · ${nf.format(h.totalUsers)} usuarios · ${nf.format(h.screenPageViews)} vistas · ${nf.format(h.keyEvents)} eventos clave`}
                  />
                )}
              </Card>

              <div className="grid gap-6 xl:grid-cols-2">
                <TopTable title="Canales principales" rows={report.topChannels} head="Canal (agrupación predeterminada)" />
                <TopTable title="Páginas de entrada principales" rows={report.topLandingPages} head="Página de entrada" />
              </div>

              <Card title="Cómo leer estos datos">
                <ul className="list-disc space-y-1 pl-5 text-sm text-mute">
                  {limitations.map((l) => (
                    <li key={l}>{l}</li>
                  ))}
                  <li>
                    Fuente: {report.source}. Importado {report.observedAt ? timeAgo(report.observedAt) : "—"}.
                  </li>
                </ul>
              </Card>
            </>
          )}
        </div>
      )}
    </>
  );
}
