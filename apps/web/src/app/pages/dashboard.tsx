import { useState, type FormEvent } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { ArrowRight, FileSearch, Sparkles } from "lucide-react";
import { ApiError, post, timeAgo } from "../lib/api";
import { useAuth } from "../lib/auth";
import { useApi } from "../lib/hooks";
import { Badge, Button, Card, EmptyState, ErrorState, JOB_STATE, MetricCard, Notice, PageHeader, SeverityBadge, Skeleton, TextField, UnavailableCard } from "../ui";
import { Logo } from "../shell";

const LABELS: Record<string, string> = {
  brands: "Marcas",
  completed_audits: "Auditorías completadas",
  health_score: "Salud técnica (última auditoría)",
  credits_balance: "Créditos disponibles",
  analyses_used: "Auditorías usadas",
};

export function OnboardingPage() {
  const { refresh, me } = useAuth();
  const nav = useNavigate();
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await post<{ id: string }>("/orgs", { name });
      await refresh();
      nav(`/o/${r.id}/analyze`);
    } catch (err) {
      setError(err as ApiError);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="grid min-h-full place-items-center px-4 py-12">
      <div className="w-full max-w-lg">
        <Logo className="mb-8" />
        <p className="text-xs font-semibold uppercase tracking-[0.14em] text-accent-text">Paso 1 de 3</p>
        <h1 className="mt-2 font-serif text-5xl leading-none">Crea tu espacio de trabajo</h1>
        <p className="mt-3 text-mute">
          Hola {me?.user?.name}. Una organización agrupa tus marcas, tu equipo y tus datos — aislados del resto de clientes.
        </p>
        <form onSubmit={submit} className="mt-8 space-y-4">
          <TextField label="Nombre de la empresa o agencia" required minLength={2} maxLength={120} value={name} onChange={(e) => setName(e.target.value)} placeholder="Mi Empresa SL" />
          <ErrorState error={error} />
          <Button variant="primary" type="submit" loading={busy}>
            Continuar <ArrowRight className="size-4" />
          </Button>
        </form>
      </div>
    </div>
  );
}

export function DashboardPage() {
  const { orgId } = useParams();
  const { data, error, loading, reload } = useApi<any>(`/orgs/${orgId}/dashboard`);
  return (
    <>
      <PageHeader
        eyebrow="Growth Command Center"
        title="Tu crecimiento, con pruebas"
        subtitle="Solo mostramos datos con fuente. Lo que aún no está conectado aparece como no disponible — nunca con cifras de ejemplo."
        actions={
          <Link to={`/o/${orgId}/analyze`} className="inline-flex min-h-10 items-center gap-2 rounded-full bg-accent px-4 text-sm font-semibold text-accent-ink">
            <Sparkles className="size-4" /> Nueva auditoría
          </Link>
        }
      />
      <ErrorState error={error} onRetry={reload} />
      {loading && !data && (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-5">
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="h-36 rounded-2xl" />
          ))}
        </div>
      )}
      {data && (
        <div className="space-y-6">
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-5">
            {data.metrics.map((m: any) => (
              <MetricCard key={m.metric} m={{ ...m, label: LABELS[m.metric] ?? m.metric }} />
            ))}
          </div>
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
            {(data.kpis ?? []).map((k: any) =>
              k.metric ? (
                <MetricCard key={k.key} m={k.metric} />
              ) : (
                <div key={k.key} className="flex flex-col rounded-2xl border border-dashed border-line p-4">
                  <p className="text-sm text-mute">{k.label}</p>
                  <p className="mt-2 flex-1 text-sm">{k.reason}</p>
                  <Link to={`/o/${orgId}/${k.cta.to}`} className="mt-3 inline-flex items-center gap-1 text-sm font-semibold text-accent-text hover:underline">
                    {k.cta.label} <ArrowRight className="size-4" />
                  </Link>
                </div>
              ),
            )}
          </div>
          {data.unavailable.length > 0 && (
            <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
              {data.unavailable.map((u: any) => (
                <UnavailableCard key={u.key} label={u.label} reason={u.reason} />
              ))}
            </div>
          )}
          <div className="grid gap-6 xl:grid-cols-3">
            <Card className="xl:col-span-2" title="Última auditoría" subtitle={data.latestAudit ? `${data.latestAudit.origin} · ${timeAgo(data.latestAudit.completed_at)}` : undefined}>
              {data.latestAudit ? (
                <div className="space-y-4">
                  <div className="flex flex-wrap gap-2">
                    {data.issuesBySeverity.length === 0 && <Badge tone="ok">Sin incidencias abiertas</Badge>}
                    {data.issuesBySeverity.map((s: any) => (
                      <span key={s.severity} className="inline-flex items-center gap-1.5 text-sm">
                        <SeverityBadge s={s.severity} /> <span className="tabular-nums">{s.n}</span>
                      </span>
                    ))}
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <Link className="inline-flex min-h-10 items-center gap-2 rounded-full border border-line px-4 text-sm font-semibold hover:bg-surface-2" to={`/o/${orgId}/audits/${data.latestAudit.id}`}>
                      Ver hallazgos <ArrowRight className="size-4" />
                    </Link>
                    <Link className="inline-flex min-h-10 items-center gap-2 rounded-full border border-line px-4 text-sm font-semibold hover:bg-surface-2" to={`/o/${orgId}/brands/${data.latestAudit.brand_id}`}>
                      Perfil de marca
                    </Link>
                  </div>
                </div>
              ) : (
                <EmptyState icon={<FileSearch className="size-8" />} title="Aún no has auditado ninguna web" action={<Link className="text-sm font-semibold text-accent-text hover:underline" to={`/o/${orgId}/analyze`}>Auditar mi web →</Link>}>
                  Pega una URL y en unos minutos tendrás hallazgos con evidencia, tu perfil de marca y un plan de 30 días.
                </EmptyState>
              )}
            </Card>
            <Card title="Actividad de agentes" actions={<Link className="text-sm text-accent-text hover:underline" to={`/o/${orgId}/jobs`}>Ver todo</Link>}>
              {data.recentJobs.length === 0 ? (
                <p className="text-sm text-mute">Sin trabajos todavía.</p>
              ) : (
                <ul className="space-y-3">
                  {data.recentJobs.map((j: any) => (
                    <li key={j.id}>
                      <Link to={`/o/${orgId}/jobs/${j.id}`} className="flex items-center justify-between gap-2 rounded-lg p-1 text-sm hover:bg-surface-2">
                        <span>{j.kind === "gsc_sync" ? "Search Console" : j.kind === "ga4_sync" ? "Google Analytics" : "Auditoría web"} · {timeAgo(j.created_at)}</span>
                        <Badge tone={JOB_STATE[j.state]?.tone}>{JOB_STATE[j.state]?.label ?? j.state}</Badge>
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </Card>
          </div>
          <Notice>Cada cifra indica su fuente y método. Lo que no está conectado muestra el siguiente paso, nunca cifras de ejemplo.</Notice>
        </div>
      )}
    </>
  );
}
