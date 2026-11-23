import { useEffect, useMemo, useState, type FormEvent } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { ArrowRight, CheckCircle2, CircleDashed, ShieldCheck, XCircle } from "lucide-react";
import { ApiError, fmtDate, post, timeAgo } from "../lib/api";
import { useApi } from "../lib/hooks";
import { Badge, Button, Card, EmptyState, ErrorState, Field, JOB_STATE, Notice, PageHeader, Progress, Select, Spinner, TextField } from "../ui";

type BrandRow = { id: string; name: string; domain: string | null; origin: string | null };
const hostOf = (raw: string) => {
  try {
    return new URL(/^https?:\/\//i.test(raw.trim()) ? raw.trim() : `https://${raw.trim()}`).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return "";
  }
};

export function AnalyzePage() {
  const { orgId } = useParams();
  const nav = useNavigate();
  const [url, setUrl] = useState(() => {
    try {
      return sessionStorage.getItem("dni.pendingUrl") ?? "";
    } catch {
      return "";
    }
  });
  const [brandName, setBrandName] = useState("");
  const [brandChoice, setBrandChoice] = useState<string>("auto");
  const [busy, setBusy] = useState(false);
  const brands = useApi<{ items: BrandRow[] }>(`/orgs/${orgId}/brands`);
  const ent = useApi<{ plan: { name: string }; rows: Array<{ key: string; used: number | null; limit: number }> }>(`/orgs/${orgId}/entitlements`);
  const brandRow = ent.data?.rows.find((r) => r.key === "brands");
  const atBrandLimit = !!brandRow && (brandRow.used ?? 0) >= brandRow.limit;
  const host = hostOf(url);
  const matching = brands.data?.items.find((b) => [b.domain, b.origin].some((d) => d && hostOf(d) === host));
  // B13: decide BEFORE submitting where a new domain goes, instead of failing after the click.
  const needsExisting = !!host && !matching && atBrandLimit && (brands.data?.items.length ?? 0) > 0;
  const chosenBrand = brandChoice !== "auto" ? brandChoice : needsExisting ? brands.data!.items[0]!.id : null;
  const [error, setError] = useState<ApiError | null>(null);
  const idemKey = useMemo(() => crypto.randomUUID().replace(/-/g, ""), []);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const target = matching ? null : chosenBrand;
      const r = await post<{ jobId: string }>(`/orgs/${orgId}/sites/analyze`, { url, ...(target ? { brandId: target } : brandName ? { brandName } : {}) }, { "idempotency-key": idemKey });
      try {
        sessionStorage.removeItem("dni.pendingUrl");
      } catch {
        /* ignore */
      }
      nav(`/o/${orgId}/jobs/${r.jobId}`);
    } catch (err) {
      setError(err as ApiError);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <PageHeader eyebrow="Auditoría web · SEO · GEO · AEO" title="Analiza una web" subtitle="Rastreo público y no intrusivo: solo leemos HTML público, respetamos robots.txt y limitamos páginas y velocidad. No cambiamos nada en el sitio." />
      <div className="grid gap-6 lg:grid-cols-[1fr_360px]">
        <Card>
          <form onSubmit={submit} className="space-y-4">
            <TextField label="URL del sitio" placeholder="tunegocio.es" inputMode="url" required maxLength={2048} value={url} onChange={(e) => setUrl(e.target.value)} hint="Solo sitios públicos (http/https). Bloqueamos direcciones internas y privadas." />
            {matching ? (
              <p className="text-sm text-mute">
                Este dominio ya pertenece a la marca <strong className="text-ink">{matching.name}</strong>: la auditoría se guardará allí.
              </p>
            ) : (brands.data?.items.length ?? 0) > 0 && host ? (
              <Field label="¿Dónde se guarda esta auditoría?" htmlFor="brand-choice" hint={needsExisting ? `Tu plan ${ent.data?.plan.name ?? ""} permite ${brandRow?.limit} marca(s) y ya las usas. La auditoría de otro dominio (por ejemplo, un competidor) se guarda en una marca existente y no cambia su perfil de marca.` : "Crea una marca nueva para este dominio o guárdalo en una existente (útil para auditar a un competidor)."}>
                <Select id="brand-choice" value={brandChoice} onChange={(e) => setBrandChoice(e.target.value)}>
                  <option value="auto" disabled={needsExisting}>{needsExisting ? "Nueva marca (no disponible en tu plan)" : `Nueva marca: ${host}`}</option>
                  {brands.data!.items.map((b) => (
                    <option key={b.id} value={b.id}>
                      En la marca «{b.name}»
                    </option>
                  ))}
                </Select>
              </Field>
            ) : null}
            {!matching && !chosenBrand && (
              <TextField label="Nombre de la marca (opcional)" maxLength={120} value={brandName} onChange={(e) => setBrandName(e.target.value)} hint="Si lo dejas vacío usaremos el dominio. Podrás corregirlo al confirmar la marca." />
            )}
            {needsExisting && brandChoice === "auto" && (
              <Notice tone="info">Se guardará en «{brands.data!.items[0]!.name}». Puedes elegir otra marca arriba o <Link className="font-semibold underline" to={`/o/${orgId}/billing`}>ver planes con más marcas</Link>.</Notice>
            )}
            {error && (
              <ErrorState error={error} />
            )}
            {error?.code === "plan_limit" && (
              <Link className="text-sm text-accent-text hover:underline" to={`/o/${orgId}/billing`}>
                Ver planes y límites →
              </Link>
            )}
            <Button variant="primary" type="submit" loading={busy}>
              Empezar auditoría <ArrowRight className="size-4" />
            </Button>
          </form>
        </Card>
        <Card title="Qué revisamos">
          <ul className="space-y-2 text-sm text-mute">
            {["Indexabilidad: HTTP, noindex, canónicas, robots.txt, sitemap", "Metadatos: títulos, descripciones, duplicados", "Estructura: H1, idioma, viewport móvil", "GEO/AEO: JSON-LD, entidad de marca, llms.txt", "Contenido: alt de imágenes, contenido escaso, blog y potencial orgánico", "Social: Open Graph e imagen para compartir (formato y tamaño)", "Páginas legales: se revisan, pero apenas pesan en las prioridades"].map((t) => (
              <li key={t} className="flex gap-2">
                <ShieldCheck className="mt-0.5 size-4 shrink-0 text-accent-text" aria-hidden /> {t}
              </li>
            ))}
          </ul>
        </Card>
      </div>
    </>
  );
}

const ACTIVE = ["queued", "validating", "running"];
/** Free read-only data syncs: label and panel path. */
const SYNC_JOBS: Record<string, { label: string; path: string } | undefined> = {
  gsc_sync: { label: "Search Console", path: "search-console" },
  ga4_sync: { label: "Google Analytics", path: "analytics" },
};

export function JobPage() {
  const { orgId, jobId } = useParams();
  const { data, error, loading, reload } = useApi<any>(`/orgs/${orgId}/jobs/${jobId}`, { pollMs: 1500, pollWhile: (d) => ACTIVE.includes(d.job.state) });
  const [cancelling, setCancelling] = useState(false);
  const nav = useNavigate();
  const job = data?.job;

  useEffect(() => {
    document.title = job ? `${JOB_STATE[job.state]?.label ?? job.state} · Auditoría · DNI Growth` : "Auditoría · DNI Growth";
    return () => {
      document.title = "DNI Growth · App";
    };
  }, [job]);

  if (loading && !data) return <Spinner />;
  if (error) return <ErrorState error={error} onRetry={reload} />;
  if (!job) return null;
  const st = JOB_STATE[job.state] ?? { label: job.state, tone: "neutral" as const };
  const out = job.output;
  const sync = SYNC_JOBS[job.kind];

  return (
    <>
      <PageHeader
        eyebrow={sync ? `Trabajo de agente · ${sync.label}` : "Trabajo de agente · auditoría web"}
        title={sync ? `Sincronización de ${sync.label}` : job.url ? new URL(job.url).hostname : "Auditoría"}
        subtitle={`Creado ${fmtDate(job.created_at)} · intento ${job.attempts}/${job.max_attempts}`}
        actions={
          ACTIVE.includes(job.state) && (
            <Button
              variant="danger"
              loading={cancelling}
              onClick={async () => {
                setCancelling(true);
                await post(`/orgs/${orgId}/jobs/${jobId}/cancel`).catch(() => null);
                setCancelling(false);
                void reload();
              }}
            >
              Cancelar
            </Button>
          )
        }
      />
      <div className="grid gap-6 xl:grid-cols-[1fr_380px]">
        <div className="space-y-6">
          <Card>
            <div className="mb-3 flex items-center justify-between gap-2">
              <Badge tone={st.tone}>{st.label}</Badge>
              <span className="text-sm tabular-nums text-mute">{job.progress}%</span>
            </div>
            <Progress value={job.progress} />
            {job.state === "queued" && job.retry_after && <p className="mt-3 text-sm text-mute">Reintento programado {timeAgo(job.retry_after)} tras un error transitorio.</p>}
            {sync && job.state === "failed" && (
              <div className="mt-4 space-y-3">
                <Notice tone="warn" title={`La sincronización con ${sync.label} no se ha completado`}>
                  {/_(invalid_grant|scope_not_granted)$/.test(job.failure_code ?? "")
                    ? `Google retiró el permiso de lectura. Vuelve a conectar ${sync.label}.`
                    : /_property_not_allowed$/.test(job.failure_code ?? "")
                      ? "La cuenta de Google conectada ya no puede leer esta propiedad."
                      : "Google no devolvió los datos tras varios intentos. No se ha consumido nada."}
                  <span className="mt-1 block font-mono text-xs">{job.failure_code}</span>
                </Notice>
                <Link className="text-sm font-semibold text-accent-text" to={`/o/${orgId}/${sync.path}`}>
                  Ir a {sync.label} →
                </Link>
              </div>
            )}
            {sync && job.state === "completed" && out && (
              <p className="mt-4 text-sm text-mute">
                {job.kind === "gsc_sync"
                  ? `${out.siteUrl}: ${out.days} días, ${out.queries} consultas y ${out.pages} páginas importadas`
                  : `${out.property}: ${out.days} días, ${out.channels} canales y ${out.landingPages} páginas de entrada importadas`}{" "}
                ({out.startDate} – {out.endDate}).{" "}
                <Link className="font-semibold text-accent-text" to={`/o/${orgId}/${sync.path}`}>
                  Ver panel →
                </Link>
              </p>
            )}
            {!sync && job.state === "failed" && (
              <div className="mt-4 space-y-3">
                <Notice tone="warn" title="La auditoría no se ha podido completar">
                  {job.failure_code?.startsWith("url_blocked")
                    ? "La URL o alguna redirección apunta a una dirección no pública. Por seguridad no la analizamos."
                    : "El sitio no respondió correctamente tras varios intentos. No se han consumido créditos."}
                  <span className="mt-1 block font-mono text-xs">{job.failure_code}</span>
                </Notice>
                <Button
                  onClick={async () => {
                    const r = await post<{ url: string }>(`/orgs/${orgId}/jobs/${jobId}/retry`);
                    try {
                      sessionStorage.setItem("dni.pendingUrl", r.url);
                    } catch {
                      /* ignore */
                    }
                    nav(`/o/${orgId}/analyze`);
                  }}
                >
                  Volver a intentar
                </Button>
              </div>
            )}
            {!sync && job.state === "completed" && out && (
              <div className="mt-6 grid gap-4 sm:grid-cols-3">
                <Stat label="Páginas analizadas" value={out.pages} />
                <Stat label="Hallazgos" value={out.issues} />
                <Stat label="Salud técnica" value={`${out.healthScore}/100`} />
                <div className="flex flex-wrap gap-2 sm:col-span-3">
                  <Link className="inline-flex min-h-10 items-center gap-2 rounded-full bg-accent px-4 text-sm font-semibold text-accent-ink" to={`/o/${orgId}/audits/${out.crawlId}`}>
                    Ver auditoría <ArrowRight className="size-4" />
                  </Link>
                  <Link className="inline-flex min-h-10 items-center rounded-full border border-line px-4 text-sm font-semibold hover:bg-surface-2" to={`/o/${orgId}/brands/${out.brandId}`}>
                    Confirmar marca
                  </Link>
                  <Link className="inline-flex min-h-10 items-center rounded-full border border-line px-4 text-sm font-semibold hover:bg-surface-2" to={`/o/${orgId}/plans/${out.planId}`}>
                    Plan de 30 días
                  </Link>
                </div>
              </div>
            )}
          </Card>
        </div>
        <Card title="Registro en tiempo real" subtitle="Eventos del agente (datos sensibles ocultados)">
          <ol className="space-y-3" aria-live="polite">
            {data.events.map((e: any, i: number) => (
              <li key={i} className="flex gap-2.5 text-sm">
                {e.level === "error" ? <XCircle className="mt-0.5 size-4 shrink-0 text-danger" /> : e.level === "warn" ? <CircleDashed className="mt-0.5 size-4 shrink-0 text-warn" /> : <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-ok" />}
                <div className="min-w-0">
                  <p className="break-words">{e.message}</p>
                  <p className="text-xs text-mute">{new Date(e.created_at).toLocaleTimeString("es-ES")}</p>
                </div>
              </li>
            ))}
          </ol>
        </Card>
      </div>
    </>
  );
}

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="rounded-xl border border-line p-4">
      <p className="text-xs text-mute">{label}</p>
      <p className="mt-1 font-serif text-3xl tabular-nums">{value}</p>
    </div>
  );
}

export function JobsPage() {
  const { orgId } = useParams();
  const { data, error, loading, reload } = useApi<any>(`/orgs/${orgId}/jobs`);
  return (
    <>
      <PageHeader eyebrow="AI Agent Center" title="Trabajos de agentes" subtitle="Historial completo: estado, intentos, coste reservado y resultado de cada trabajo." />
      <ErrorState error={error} onRetry={reload} />
      {loading && !data ? (
        <Spinner />
      ) : data?.items.length === 0 ? (
        <EmptyState title="Sin trabajos todavía" action={<Link className="text-sm font-semibold text-accent-text" to={`/o/${orgId}/analyze`}>Lanzar una auditoría →</Link>} />
      ) : (
        <div className="overflow-x-auto rounded-2xl border border-line bg-surface">
          <table className="w-full min-w-[640px] text-sm">
            <thead className="border-b border-line text-left text-xs text-mute">
              <tr>
                <th className="px-4 py-3 font-medium">Trabajo</th>
                <th className="px-4 py-3 font-medium">Estado</th>
                <th className="px-4 py-3 font-medium">Intentos</th>
                <th className="px-4 py-3 font-medium">Creado</th>
              </tr>
            </thead>
            <tbody>
              {data?.items.map((j: any) => (
                <tr key={j.id} className="border-b border-line last:border-0 hover:bg-surface-2">
                  <td className="px-4 py-3">
                    <Link className="font-medium hover:underline" to={`/o/${orgId}/jobs/${j.id}`}>
                      {SYNC_JOBS[j.kind] ? `${SYNC_JOBS[j.kind]!.label} · sincronización` : `Auditoría · ${j.url ? new URL(j.url).hostname : "—"}`}
                    </Link>
                  </td>
                  <td className="px-4 py-3">
                    <Badge tone={JOB_STATE[j.state]?.tone}>{JOB_STATE[j.state]?.label ?? j.state}</Badge>
                  </td>
                  <td className="px-4 py-3 tabular-nums">{j.attempts}</td>
                  <td className="px-4 py-3 text-mute">{timeAgo(j.created_at)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
