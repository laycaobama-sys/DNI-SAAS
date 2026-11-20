import { useState, type ReactNode } from "react";
import { Link, Navigate, useSearchParams } from "react-router";
import { Activity, ArrowLeft, Bot, Building2, CreditCard, Gauge, Moon, ScrollText, Search, Server, ShieldCheck, Sun, Users } from "lucide-react";
import { PLAN_LABEL, PLAN_ORDER, isPlanCode } from "@dni/core/plan-access";
import { ApiError, fmtDate, post, timeAgo } from "../lib/api";
import { useAuth } from "../lib/auth";
import { useApi, useTheme } from "../lib/hooks";
import { Logo } from "../shell";
import { Badge, Button, Card, EmptyState, ErrorState, Input, Notice, Select, Skeleton, cx } from "../ui";
import { AdminPanel, ProviderTests } from "./aihub";
import { StripeAdminPanel } from "./org";
import { AiCentre, AuditTab, OpsTab, OrgDrawer, PlatformGate, SecurityTab, StepUpProvider, useStepUp } from "./platform";

/**
 * Platform console for the owner (Platform SuperAdmin). Every figure is read from D1 and labelled
 * «observado»; money in Stripe test mode is labelled as test data. Only platform admins reach it
 * (the API answers 404 to everyone else).
 */
const TABS = [
  { key: "overview", label: "Resumen", icon: Gauge },
  { key: "orgs", label: "Organizaciones", icon: Building2 },
  { key: "users", label: "Usuarios", icon: Users },
  { key: "billing", label: "Facturación", icon: CreditCard },
  { key: "ai", label: "IA", icon: Bot },
  { key: "ops", label: "Operaciones", icon: Server },
  { key: "audit", label: "Auditoría", icon: ScrollText },
  { key: "activity", label: "Actividad", icon: Activity },
  { key: "security", label: "Seguridad", icon: ShieldCheck },
] as const;
type Tab = (typeof TABS)[number]["key"];

const n = (v: unknown) => (typeof v === "number" ? v : Number(v ?? 0)) || 0;
const eur = (v: number) => v.toLocaleString("es-ES", { style: "currency", currency: "EUR", maximumFractionDigits: 0 });
const planName = (c: string) => (isPlanCode(c) ? PLAN_LABEL[c] : c);
const SUB_LABEL: Record<string, string> = { active: "Activa", trialing: "En prueba", past_due: "Pago pendiente", canceled: "Cancelada", incomplete: "Incompleta" };

export function AdminConsolePage() {
  const { me } = useAuth();
  const { theme, toggle } = useTheme();
  const [params, setParams] = useSearchParams();
  const tab = (TABS.some((t) => t.key === params.get("tab")) ? params.get("tab") : "overview") as Tab;
  // Not platform staff at all: the console does not exist for them (the API answers 404 too).
  if (me && !me.platform?.member) return <Navigate to="/" replace />;
  const back = me?.memberships[0] ? `/o/${me.memberships[0].id}` : "/";
  const locked = !!me && !me.user?.isPlatformAdmin;

  return (
    <div className="min-h-full bg-bg">
      <header className="sticky top-0 z-30 border-b border-line bg-bg pt-[env(safe-area-inset-top)]">
        <div className="mx-auto flex max-w-7xl items-center gap-3 px-4 py-3 sm:px-6 lg:px-10">
          <Link to={back} className="rounded-lg p-1.5 text-mute hover:bg-surface-2 hover:text-ink" aria-label="Volver a la aplicación">
            <ArrowLeft className="size-5" />
          </Link>
          <Logo />
          <span className="hidden items-center gap-1 rounded-full border border-line px-2.5 py-0.5 text-xs font-medium text-mute sm:inline-flex">
            <ShieldCheck className="size-3.5 text-accent-text" aria-hidden /> Control Center
          </span>
          <span className="flex-1" />
          <span className="hidden truncate text-xs text-mute md:block">{me?.user?.email}</span>
          <button onClick={toggle} className="rounded-lg p-2 text-mute hover:bg-surface-2 hover:text-ink" aria-label={theme === "dark" ? "Cambiar a modo claro" : "Cambiar a modo oscuro"}>
            {theme === "dark" ? <Sun className="size-4" /> : <Moon className="size-4" />}
          </button>
        </div>
        <nav className="mx-auto flex max-w-7xl gap-1 overflow-x-auto px-4 pb-2 sm:px-6 lg:px-10" aria-label="Secciones de la consola">
          {TABS.map((t) => (
            <button
              key={t.key}
              onClick={() => setParams(t.key === "overview" ? {} : { tab: t.key })}
              aria-current={tab === t.key ? "page" : undefined}
              className={cx(
                "inline-flex shrink-0 items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm transition",
                tab === t.key ? "bg-surface-2 font-medium text-ink" : "text-mute hover:bg-surface-2 hover:text-ink",
              )}
            >
              <t.icon className="size-4" aria-hidden />
              {t.label}
            </button>
          ))}
        </nav>
      </header>
      <main id="main" className="mx-auto w-full max-w-7xl px-4 py-6 sm:px-6 lg:px-10 lg:py-10">
        {locked ? <PlatformGate /> : <StepUpProvider>
        {me?.platform?.legacy && tab !== "security" && (
          <div className="mb-5">
            <Notice tone="warn" title="Acceso provisional">
              Entras por la lista de administradores. Vincula tu cuenta con segundo factor en <button className="font-semibold text-accent-text underline" onClick={() => setParams({ tab: "security" })}>Seguridad</button> para poder suspender, borrar o cambiar planes y límites.
            </Notice>
          </div>
        )}
        {tab === "overview" && <Overview onOpen={(t) => setParams({ tab: t })} />}
        {tab === "orgs" && <Organizations />}
        {tab === "users" && <UsersList />}
        {tab === "billing" && <BillingTab />}
        {tab === "ai" && <AiTab />}
        {tab === "ops" && (
          <>
            <Title title="Operaciones" subtitle="Trabajos, correos y webhooks: solo estados y recuentos, nunca el contenido de los clientes." />
            <OpsTab />
          </>
        )}
        {tab === "audit" && (
          <>
            <Title title="Auditoría" subtitle="Quién hizo qué y cuándo. Los correos aparecen enmascarados." />
            <AuditTab />
          </>
        )}
        {tab === "activity" && <ActivityTab />}
        {tab === "security" && (
          <>
            <Title title="Seguridad" subtitle="Tu vinculación como propietaria y el segundo factor." />
            <SecurityTab />
          </>
        )}
        </StepUpProvider>}
      </main>
    </div>
  );
}

function Title({ title, subtitle, actions }: { title: string; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
      <div className="min-w-0">
        <h1 className="font-serif text-4xl leading-tight sm:text-5xl">{title}</h1>
        {subtitle && <p className="mt-1 max-w-2xl text-sm text-mute">{subtitle}</p>}
      </div>
      {actions}
    </div>
  );
}

function Kpi({ label, value, hint, tone }: { label: string; value: ReactNode; hint?: ReactNode; tone?: "warn" | "ok" }) {
  return (
    <div className="rounded-2xl border border-line bg-surface p-4">
      <p className="text-xs font-medium uppercase tracking-[0.1em] text-mute">{label}</p>
      <p className={cx("mt-2 font-serif text-4xl tabular-nums leading-none", tone === "warn" && "text-warn", tone === "ok" && "text-ok")}>{value}</p>
      {hint && <p className="mt-2 text-xs text-mute">{hint}</p>}
    </div>
  );
}

function Source({ observedAt }: { observedAt?: string }) {
  return <p className="mt-6 text-xs text-mute">Fuente: base de datos de la plataforma (D1) · medición observada · actualizado {observedAt ? timeAgo(observedAt) : "ahora"}.</p>;
}

function Overview({ onOpen }: { onOpen: (t: Tab) => void }) {
  const { data, error, reload } = useApi<any>("/admin/overview");
  if (error) return <ErrorState error={error} onRetry={reload} />;
  if (!data)
    return (
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {Array.from({ length: 8 }, (_, i) => <Skeleton key={i} className="h-28 rounded-2xl" />)}
      </div>
    );
  const s = data.subscriptions;
  const maxPlan = Math.max(1, ...data.organizations.byPlan.map((p: any) => n(p.orgs)));
  const maxDay = Math.max(1, ...data.signups.map((d: any) => n(d.n)));
  return (
    <>
      <Title
        title="Resumen"
        subtitle="Estado real de la plataforma: usuarios, organizaciones, suscripciones e IA. Sin cifras inventadas."
        actions={
          <div className="flex flex-wrap gap-2">
            <Badge tone={s.stripeMode === "live" ? "ok" : "warn"}>Stripe: {s.stripeMode === "live" ? "real" : s.stripeMode === "test" ? "modo prueba" : "sin configurar"}</Badge>
            <Badge tone={s.billingEnabled ? "ok" : "neutral"}>Cobros {s.billingEnabled ? "abiertos" : "cerrados"}</Badge>
          </div>
        }
      />
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Kpi label="Usuarios" value={n(data.users?.total)} hint={`${n(data.users?.verified)} verificados · +${n(data.users?.new7)} en 7 días`} />
        <Kpi label="Organizaciones" value={n(data.organizations.total)} hint={`+${n(data.organizations.new30)} en 30 días · ${n(data.organizations.clients)} de agencias`} />
        <Kpi label="Suscripciones de pago" value={n(s.paying)} hint={s.stripeMode === "live" ? "Stripe, activas" : "Stripe en modo prueba"} />
        <Kpi label="MRR (lista)" value={eur(n(s.mrrEur))} hint={s.caveat} tone={s.stripeMode === "live" ? undefined : "warn"} />
        <Kpi label="Peticiones de IA (24 h)" value={n(data.ai?.calls24)} hint={`${n(data.ai?.calls7)} en 7 días · ${n(data.ai?.failed7)} fallidas · ${n(data.ai?.cache7)} desde caché`} />
        <Kpi label="Auditorías (30 días)" value={n(data.jobs?.audits30)} hint={`${n(data.jobs?.running)} en curso · ${n(data.jobs?.failed7)} fallidas en 7 días`} tone={n(data.jobs?.failed7) > 0 ? "warn" : undefined} />
        <Kpi label="Contactos captados (30 días)" value={n(data.leads30)} hint="Todos los clientes, formularios y landings" />
        <Kpi label="Tope de Workers AI" value={`${data.ai?.dailyBudgetUsd ?? 0.1} $/día`} hint="Dentro del cupo gratuito diario" />
      </div>

      <div className="mt-6 grid gap-4 lg:grid-cols-2">
        <Card title="Organizaciones por plan" actions={<Button onClick={() => onOpen("orgs")}>Gestionar</Button>}>
          <ul className="space-y-3">
            {data.organizations.byPlan.map((p: any) => (
              <li key={p.code}>
                <div className="flex items-baseline justify-between text-sm">
                  <span>
                    {planName(p.code)} <span className="text-xs text-mute">· {p.price ? `${p.price} €/mes` : "gratis"}</span>
                  </span>
                  <span className="tabular-nums">{n(p.orgs)}</span>
                </div>
                <div className="mt-1 h-2 overflow-hidden rounded-full bg-surface-2">
                  <div className="h-full rounded-full bg-accent" style={{ width: `${(n(p.orgs) / maxPlan) * 100}%` }} />
                </div>
              </li>
            ))}
          </ul>
        </Card>
        <Card title="Altas de usuarios (30 días)" subtitle="Una barra por día con altas">
          {data.signups.length === 0 ? (
            <p className="text-sm text-mute">Sin altas en los últimos 30 días.</p>
          ) : (
            <div className="flex h-36 items-end gap-1" role="img" aria-label={`Altas por día: ${data.signups.map((d: any) => `${d.day} ${d.n}`).join(", ")}`}>
              {data.signups.map((d: any) => (
                <div key={d.day} className="group relative flex-1" style={{ height: `${Math.max(6, (n(d.n) / maxDay) * 100)}%` }}>
                  <div className="h-full rounded-t bg-accent" />
                  <span className="pointer-events-none absolute -top-7 left-1/2 hidden -translate-x-1/2 whitespace-nowrap rounded bg-ink px-1.5 py-0.5 text-[10px] text-bg group-hover:block">
                    {d.day.slice(5)} · {d.n}
                  </span>
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>
      <Source observedAt={data.observedAt} />
    </>
  );
}

function Organizations() {
  const [q, setQ] = useState("");
  const [plan, setPlan] = useState("");
  const [query, setQuery] = useState("");
  const { data, error, reload } = useApi<any>(`/admin/organizations${query}`);
  const [editing, setEditing] = useState<string | null>(null);
  const [managing, setManaging] = useState<string | null>(null);
  const search = (e: React.FormEvent) => {
    e.preventDefault();
    const p = new URLSearchParams();
    if (q.trim()) p.set("q", q.trim());
    if (plan) p.set("plan", plan);
    setQuery(p.toString() ? `?${p}` : "");
  };
  return (
    <>
      <Title title="Organizaciones" subtitle="Plan, suscripción, equipo y actividad de cada cliente. Desde aquí puedes asignar un plan interno sin cobro (queda auditado)." />
      <form onSubmit={search} className="mb-4 flex flex-col gap-2 sm:flex-row">
        <label className="relative flex-1">
          <span className="sr-only">Buscar organización</span>
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-mute" aria-hidden />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Nombre o identificador…" className="pl-9" />
        </label>
        <Select value={plan} onChange={(e) => setPlan(e.target.value)} aria-label="Filtrar por plan" className="sm:w-44">
          <option value="">Todos los planes</option>
          {PLAN_ORDER.map((p) => (
            <option key={p} value={p}>
              {PLAN_LABEL[p]}
            </option>
          ))}
        </Select>
        <Button type="submit" variant="primary">
          Buscar
        </Button>
      </form>
      <ErrorState error={error} onRetry={reload} />
      {!data ? (
        <Skeleton className="h-64 rounded-2xl" />
      ) : data.items.length === 0 ? (
        <EmptyState title="Sin resultados">Prueba con otro nombre o plan.</EmptyState>
      ) : (
        <ul className="grid gap-3">
          {data.items.map((o: any) => (
            <li key={o.id} className="rounded-2xl border border-line bg-surface p-4">
              <div className="flex flex-wrap items-start gap-3">
                <div className="min-w-0 flex-1">
                  <p className="truncate font-semibold">{o.name}</p>
                  <p className="truncate text-xs text-mute">
                    {o.owner_email ?? "sin propietario"} · creada {fmtDate(o.created_at)}
                    {o.agency_name ? ` · cliente de ${o.agency_name}` : ""}
                  </p>
                </div>
                {o.deleted_at ? <Badge tone="danger">Eliminada</Badge> : o.status === "suspended" ? <Badge tone="warn">Suspendida</Badge> : null}
                <Badge tone={o.plan_code === "free" ? "neutral" : "accent"}>{planName(o.plan_code)}</Badge>
                {o.sub_provider && (
                  <Badge tone={o.sub_status === "active" ? "ok" : "warn"}>
                    {o.sub_provider === "stripe" ? "Stripe" : "Interna"} · {SUB_LABEL[o.sub_status] ?? o.sub_status}
                    {o.cancel_at_period_end ? " · se cancela" : ""}
                  </Badge>
                )}
              </div>
              <dl className="mt-3 grid grid-cols-2 gap-2 text-xs sm:grid-cols-4">
                <Stat k="Personas" v={o.members} />
                <Stat k="Marcas" v={o.brands} />
                <Stat k="Contactos" v={o.leads} />
                <Stat k="Última actividad" v={o.last_activity ? timeAgo(o.last_activity) : "—"} />
              </dl>
              <div className="mt-3 flex flex-wrap gap-2">
                <Button variant="primary" onClick={() => setManaging(o.id)}>
                  Gestionar
                </Button>
                <Button onClick={() => setEditing(editing === o.id ? null : o.id)} disabled={o.sub_provider === "stripe" && ["active", "trialing", "past_due"].includes(o.sub_status)}>
                  {o.sub_provider === "stripe" && ["active", "trialing", "past_due"].includes(o.sub_status) ? "Plan gestionado por Stripe" : "Asignar plan interno"}
                </Button>
              </div>
              {editing === o.id && (
                <AssignPlan
                  org={o}
                  onDone={() => {
                    setEditing(null);
                    reload();
                  }}
                />
              )}
            </li>
          ))}
        </ul>
      )}
      <Source observedAt={data?.observedAt} />
      {managing && <OrgDrawer orgId={managing} onClose={() => setManaging(null)} onChanged={reload} />}
    </>
  );
}

function Stat({ k, v }: { k: string; v: ReactNode }) {
  return (
    <div className="rounded-xl bg-surface-2 px-3 py-2">
      <dt className="text-mute">{k}</dt>
      <dd className="mt-0.5 font-medium tabular-nums">{v}</dd>
    </div>
  );
}

function AssignPlan({ org, onDone }: { org: any; onDone: () => void }) {
  const [plan, setPlan] = useState<string>(org.plan_code);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<ApiError | null>(null);
  const stepUp = useStepUp();
  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      await stepUp(() => post(`/admin/organizations/${org.id}/plan`, { planCode: plan, reason }));
      onDone();
    } catch (x) {
      if (x instanceof ApiError && x.code === "step_up_cancelled") return;
      setErr(x instanceof ApiError ? x : new ApiError(0, "error", "No se pudo cambiar el plan."));
    } finally {
      setBusy(false);
    }
  };
  return (
    <form onSubmit={save} className="mt-3 grid gap-2 rounded-xl border border-line p-3 sm:grid-cols-[180px_1fr_auto] sm:items-end">
      <label className="text-xs">
        <span className="mb-1 block text-mute">Plan</span>
        <Select value={plan} onChange={(e) => setPlan(e.target.value)}>
          {PLAN_ORDER.map((p) => (
            <option key={p} value={p}>
              {PLAN_LABEL[p]}
            </option>
          ))}
        </Select>
      </label>
      <label className="text-xs">
        <span className="mb-1 block text-mute">Motivo (queda en el registro de auditoría)</span>
        <Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Ej.: organización interna, socio, soporte" minLength={3} maxLength={200} required />
      </label>
      <Button type="submit" variant="primary" loading={busy} disabled={plan === org.plan_code || reason.trim().length < 3}>
        Guardar sin cobro
      </Button>
      <div className="sm:col-span-3">
        <ErrorState error={err} />
      </div>
    </form>
  );
}

function UsersList() {
  const [q, setQ] = useState("");
  const [query, setQuery] = useState("");
  const { data, error, reload } = useApi<any>(`/admin/users${query}`);
  return (
    <>
      <Title title="Usuarios" subtitle="Cuentas registradas, verificación del correo y última conexión. Las contraseñas solo existen como huella cifrada y nunca se muestran." />
      <form
        onSubmit={(e) => {
          e.preventDefault();
          setQuery(q.trim() ? `?q=${encodeURIComponent(q.trim())}` : "");
        }}
        className="mb-4 flex gap-2"
      >
        <label className="relative flex-1">
          <span className="sr-only">Buscar usuario</span>
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-mute" aria-hidden />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Nombre o correo…" className="pl-9" />
        </label>
        <Button type="submit" variant="primary">
          Buscar
        </Button>
      </form>
      <ErrorState error={error} onRetry={reload} />
      {!data ? (
        <Skeleton className="h-64 rounded-2xl" />
      ) : (
        <div className="overflow-x-auto rounded-2xl border border-line bg-surface">
          <table className="w-full min-w-[720px] text-sm">
            <thead className="text-left text-xs text-mute">
              <tr>
                <th className="px-4 py-3 font-medium">Persona</th>
                <th className="px-4 py-3 font-medium">Estado</th>
                <th className="px-4 py-3 font-medium">Organizaciones</th>
                <th className="px-4 py-3 font-medium">Alta</th>
                <th className="px-4 py-3 font-medium">Última conexión</th>
              </tr>
            </thead>
            <tbody>
              {data.items.map((u: any) => (
                <tr key={u.id} className="border-t border-line">
                  <td className="px-4 py-3">
                    <p className="font-medium">{u.name}</p>
                    <p className="text-xs text-mute">{u.email}</p>
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex flex-wrap gap-1">
                      <Badge tone={u.verified ? "ok" : "warn"}>{u.verified ? "Verificado" : "Sin verificar"}</Badge>
                      {u.admin ? <Badge tone="accent">Admin</Badge> : null}
                      {u.locked_until && Date.parse(u.locked_until) > Date.now() ? <Badge tone="danger">Bloqueado</Badge> : null}
                    </div>
                  </td>
                  <td className="px-4 py-3 tabular-nums">{u.orgs}</td>
                  <td className="px-4 py-3 text-mute">{fmtDate(u.created_at)}</td>
                  <td className="px-4 py-3 text-mute">{u.last_seen ? timeAgo(u.last_seen) : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <Source observedAt={data?.observedAt} />
    </>
  );
}

function BillingTab() {
  const [k, setK] = useState(0);
  return (
    <>
      <Title title="Facturación" subtitle="Stripe, catálogo de planes y webhook. Los cobros reales siguen cerrados hasta que completes la verificación de tu cuenta de Stripe." />
      <Notice tone="info" title="Cobros reales">
        El paso a cobros reales necesita tu verificación de identidad en Stripe, la clave «sk_live» (la guardas tú con wrangler) y activar BILLING_ENABLED. Hasta entonces solo se aceptan pruebas.
      </Notice>
      <div className="mt-4" key={k}>
        <StripeAdminPanel onSynced={() => setK((x) => x + 1)} />
      </div>
    </>
  );
}

function AiTab() {
  const { data, error, reload } = useApi<any>("/admin/ai/overview");
  return (
    <>
      <Title title="Inteligencia artificial" subtitle="Proveedores gratuitos, topes diarios, interruptor de emergencia y uso por organización (últimos 7 días)." />
      <ErrorState error={error} onRetry={reload} />
      <div className="mb-4">
        <AiCentre />
      </div>
      {!data ? (
        <Skeleton className="h-64 rounded-2xl" />
      ) : (
        <div className="grid gap-4">
          <ProviderTests />
          <AdminPanel status={data.status} onChanged={reload} />
          <Card title="Uso por organización" subtitle={`${data.period} · ${n(data.totals?.calls)} peticiones · coste informado ${n(data.totals?.reported_cost_usd).toFixed(4)} $`}>
            {data.perTenant.length === 0 ? (
              <p className="text-sm text-mute">Sin uso en este periodo.</p>
            ) : (
              <ul className="divide-y divide-line">
                {data.perTenant.map((t: any) => (
                  <li key={t.organization_id ?? "platform"} className="flex items-center justify-between gap-3 py-2 text-sm">
                    <span className="truncate">{t.organization ?? "Plataforma"}</span>
                    <span className="shrink-0 tabular-nums text-mute">{t.calls} peticiones</span>
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

const ACTION_LABEL: Record<string, string> = {
  "platform.plan_assign": "Plan interno asignado",
  "billing.subscription_sync": "Suscripción sincronizada",
  "billing.subscription_canceled": "Suscripción cancelada",
  "platform.stripe_catalog_sync": "Catálogo de Stripe sincronizado",
  "ai.provider_test": "Prueba de proveedor de IA",
};

function ActivityTab() {
  const { data, error, reload } = useApi<any>("/admin/overview");
  return (
    <>
      <Title title="Actividad" subtitle="Últimos 25 eventos del registro de auditoría de toda la plataforma (solo acción y fecha; sin datos personales)." />
      <ErrorState error={error} onRetry={reload} />
      {!data ? (
        <Skeleton className="h-64 rounded-2xl" />
      ) : (
        <ol className="relative space-y-3 border-l border-line pl-5">
          {data.recent.map((r: any, i: number) => (
            <li key={i} className="relative">
              <span className="absolute -left-[25px] top-1.5 size-2.5 rounded-full border-2 border-bg bg-accent" aria-hidden />
              <p className="text-sm">
                <span className="font-medium">{ACTION_LABEL[r.action] ?? r.action}</span>
                {r.organization ? <span className="text-mute"> · {r.organization}</span> : null}
              </p>
              <p className="text-xs text-mute">{fmtDate(r.created_at)}</p>
            </li>
          ))}
        </ol>
      )}
      <Source observedAt={data?.observedAt} />
    </>
  );
}
