import { useState, type FormEvent } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { ArrowRight, FileSearch, Sparkles } from "lucide-react";
import { ApiError, post, timeAgo } from "../lib/api";
import { useAuth } from "../lib/auth";
import { useApi } from "../lib/hooks";
import { Badge, Button, Card, EmptyState, ErrorState, JOB_STATE, MetricCard, Notice, PageHeader, SeverityBadge, Skeleton, TextField, UnavailableCard } from "../ui";
import { Logo } from "../shell";
import { wantedPlan } from "./billing";
import { claimPendingAudit } from "../lib/pending-audit";
import { ActivationCard } from "./welcome";

const LABELS: Record<string, string> = {
  brands: "Marcas",
  completed_audits: "Auditorías completadas",
  health_score: "Salud técnica",
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
      // A free audit done before signing up becomes this organisation's (full report + prefilled analysis).
      await claimPendingAudit(r.id);
      await refresh();
      nav(`/o/${r.id}/bienvenida`);
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
        <p className="text-xs font-semibold uppercase tracking-[0.14em] text-accent-text">Antes de empezar</p>
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
        {!!me?.deletedOrganizations?.length && <DeletedOrganizations />}
      </div>
    </div>
  );
}

/** Organisations the owner deleted in the last 30 days: one click brings them back with all their data. */
function DeletedOrganizations() {
  const { me, refresh } = useAuth();
  const nav = useNavigate();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const restore = async (id: string) => {
    setBusy(id);
    setError(null);
    try {
      await post(`/orgs/${id}/restore`);
      await refresh();
      nav(`/o/${id}`);
    } catch (e) {
      setError(e as ApiError);
    } finally {
      setBusy(null);
    }
  };
  return (
    <section className="mt-10" aria-labelledby="deleted-orgs">
      <h2 id="deleted-orgs" className="text-sm font-semibold">Organizaciones eliminadas</h2>
      <p className="mt-1 text-xs text-mute">Puedes restaurarlas con todos sus datos hasta la fecha indicada.</p>
      <ul className="mt-3 divide-y divide-line rounded-2xl border border-line">
        {me!.deletedOrganizations!.map((o) => (
          <li key={o.id} className="flex flex-wrap items-center gap-3 px-4 py-3 text-sm">
            <span className="min-w-0 flex-1 truncate font-medium">{o.name}</span>
            <span className="text-xs text-mute">hasta el {new Date(o.purge_after).toLocaleDateString("es-ES", { day: "numeric", month: "long" })}</span>
            <Button loading={busy === o.id} onClick={() => restore(o.id)}>
              Restaurar
            </Button>
          </li>
        ))}
      </ul>
      <div className="mt-2">
        <ErrorState error={error} />
      </div>
    </section>
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
      {(() => {
        const w = wantedPlan();
        return w ? (
          <div className="mb-4">
            <Notice tone="info" title={`Elegiste el plan ${w.name}`}>
              Cuando quieras, actívalo en <Link className="underline" to={`/o/${orgId}/billing#planes`}>Facturación</Link>. Mientras tanto, todo lo del plan Free funciona sin límite de tiempo.
            </Notice>
          </div>
        ) : null;
      })()}
      <ActivationCard orgId={orgId!} />
      <ErrorState error={error} onRetry={reload} />
      {loading && !data && (
        <div className="grid gap-4 [grid-template-columns:repeat(auto-fill,minmax(min(100%,12.5rem),1fr))]">
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="h-36 rounded-2xl" />
          ))}
        </div>
      )}
      {data && (
        <div className="space-y-6">
          <div className="grid gap-4 [grid-template-columns:repeat(auto-fill,minmax(min(100%,12.5rem),1fr))]">
            {data.metrics.map((m: any) => (
              <MetricCard key={m.metric} m={{ ...m, label: LABELS[m.metric] ?? m.metric }} />
            ))}
          </div>
          <div className="grid gap-4 [grid-template-columns:repeat(auto-fill,minmax(min(100%,15rem),1fr))]">
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
            <div className="grid gap-4 [grid-template-columns:repeat(auto-fill,minmax(min(100%,15rem),1fr))]">
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
