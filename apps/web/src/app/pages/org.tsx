import { useState, type FormEvent } from "react";
import { Link, useParams, useSearchParams } from "react-router";
import { Lock, Mail, UserMinus } from "lucide-react";
import { ApiError, del, fmtDate, patch, post, timeAgo } from "../lib/api";
import { useAuth } from "../lib/auth";
import { useApi } from "../lib/hooks";
import { MODULES } from "../shell";
import { Badge, Button, Card, EmptyState, ErrorState, Notice, PageHeader, Select, Spinner, TextField } from "../ui";

export const ROLE_LABELS: Record<string, string> = {
  owner: "Propietario",
  admin: "Administrador",
  marketing_manager: "Marketing Manager",
  editor: "Editor",
  analyst: "Analista",
  ads_approver: "Aprobador de Ads",
  ads_publisher: "Publicador de Ads",
  billing_admin: "Admin. facturación",
  client_viewer: "Cliente (lectura)",
};
const ROLE_ORDER = ["owner", "admin", "marketing_manager", "ads_approver", "ads_publisher", "editor", "analyst", "billing_admin", "client_viewer"];

/** Scopes of the current member, used only to hide controls — the API enforces every permission. */
export function useOrgAccess(orgId?: string) {
  const { data } = useApi<{ role: string; scopes: string[] }>(orgId ? `/orgs/${orgId}` : null);
  return { role: data?.role, can: (s: string) => !!data?.scopes.includes(s) };
}

export function TeamPage() {
  const { orgId } = useParams();
  const { me } = useAuth();
  const access = useOrgAccess(orgId);
  const { data, error, loading, reload } = useApi<any>(`/orgs/${orgId}/members`);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState("editor");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<ApiError | null>(null);
  const [notice, setNotice] = useState<{ tone: "ok" | "warn"; text: string } | null>(null);

  const act = async (fn: () => Promise<unknown>, ok?: string) => {
    setErr(null);
    setNotice(null);
    try {
      await fn();
      if (ok) setNotice({ tone: "ok", text: ok });
      await reload();
    } catch (e) {
      setErr(e as ApiError);
    }
  };
  const invite = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    setNotice(null);
    try {
      const r = await post<{ delivery: string }>(`/orgs/${orgId}/invitations`, { email, role });
      setNotice(
        r.delivery === "not_configured"
          ? { tone: "warn", text: "Invitación creada, pero el envío de email no está configurado: el invitado no recibirá el enlace hasta que se active el proveedor." }
          : r.delivery === "queued"
            ? { tone: "ok", text: `Invitación creada para ${email}. El correo está en cola y se reintentará automáticamente. Caduca en 7 días.` }
            : { tone: "ok", text: `Invitación enviada a ${email}. Caduca en 7 días.` },
      );
      setEmail("");
      await reload();
    } catch (e2) {
      setErr(e2 as ApiError);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <PageHeader eyebrow="Organización" title="Equipo y accesos" subtitle="Cada persona solo ve y hace lo que su rol permite. Todos los cambios quedan en el registro de auditoría." />
      <div className="mb-4 space-y-3">
        {notice && <Notice tone={notice.tone}>{notice.text}</Notice>}
        <ErrorState error={err} />
      </div>
      <div className="grid gap-6 xl:grid-cols-[1fr_380px]">
        <Card title="Miembros">
          <ErrorState error={error} onRetry={reload} />
          {loading && !data ? (
            <Spinner />
          ) : (
            <ul className="divide-y divide-line">
              {data?.members.map((m: any) => (
                <li key={m.id} className="flex flex-wrap items-center gap-3 py-3">
                  <div className="grid size-9 place-items-center rounded-full bg-surface-2 text-sm font-semibold">{m.name.slice(0, 1).toUpperCase()}</div>
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-medium">
                      {m.name} {m.user_id === me?.user?.id && <span className="text-xs text-mute">(tú)</span>}
                    </p>
                    <p className="truncate text-sm text-mute">{m.email}</p>
                  </div>
                  {access.can("members:manage") && m.user_id !== me?.user?.id ? (
                    <>
                      <Select aria-label={`Rol de ${m.name}`} className="w-auto py-1.5" value={m.role} onChange={(e) => act(() => patch(`/orgs/${orgId}/members/${m.id}`, { role: e.target.value }), "Rol actualizado.")}>
                        {ROLE_ORDER.map((r) => (
                          <option key={r} value={r}>
                            {ROLE_LABELS[r]}
                          </option>
                        ))}
                      </Select>
                      <Button
                        variant="ghost"
                        aria-label={`Quitar a ${m.name}`}
                        onClick={() => {
                          if (window.confirm(`¿Quitar a ${m.name} de la organización? Perderá el acceso inmediatamente.`)) void act(() => del(`/orgs/${orgId}/members/${m.id}`), "Miembro eliminado.");
                        }}
                      >
                        <UserMinus className="size-4" />
                      </Button>
                    </>
                  ) : (
                    <Badge tone={m.role === "owner" ? "accent" : "neutral"}>{ROLE_LABELS[m.role] ?? m.role}</Badge>
                  )}
                </li>
              ))}
            </ul>
          )}
          {data?.invitations.length > 0 && (
            <>
              <h3 className="mt-6 mb-2 text-sm font-semibold">Invitaciones pendientes</h3>
              <ul className="divide-y divide-line">
                {data.invitations.map((i: any) => (
                  <li key={i.id} className="flex flex-wrap items-center gap-3 py-3 text-sm">
                    <Mail className="size-4 text-mute" aria-hidden />
                    <span className="min-w-0 flex-1 truncate">{i.email}</span>
                    <Badge>{ROLE_LABELS[i.role] ?? i.role}</Badge>
                    <span className="text-xs text-mute">caduca {fmtDate(i.expires_at)}</span>
                    {access.can("members:invite") && (
                      <Button variant="ghost" onClick={() => act(() => del(`/orgs/${orgId}/invitations/${i.id}`), "Invitación revocada.")}>
                        Revocar
                      </Button>
                    )}
                  </li>
                ))}
              </ul>
            </>
          )}
        </Card>
        {access.can("members:invite") ? (
          <Card title="Invitar" subtitle="El número de usuarios depende de tu plan.">
            <form onSubmit={invite} className="space-y-4">
              <TextField label="Email" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
              <label className="block space-y-1.5 text-sm">
                <span className="font-medium">Rol</span>
                <Select value={role} onChange={(e) => setRole(e.target.value)}>
                  {ROLE_ORDER.filter((r) => r !== "owner" || access.role === "owner").map((r) => (
                    <option key={r} value={r}>
                      {ROLE_LABELS[r]}
                    </option>
                  ))}
                </Select>
              </label>
              <Button variant="primary" type="submit" loading={busy}>
                Enviar invitación
              </Button>
            </form>
          </Card>
        ) : (
          <Notice title="Solo lectura">Tu rol no permite invitar ni cambiar permisos.</Notice>
        )}
      </div>
    </>
  );
}

const ENTRY_LABEL: Record<string, string> = { grant: "Asignación mensual", reserve: "Reserva", release: "Liberación", settle: "Consumo", adjustment: "Ajuste" };
const SUB_STATUS: Record<string, string> = { active: "activa", trialing: "en prueba", past_due: "con pago pendiente", canceled: "cancelada", incomplete: "incompleta" };

const ACCESS_LABEL: Record<string, string> = {
  not_configured: "Sin conectar",
  off: "Desactivado",
  test_admin_only: "Modo prueba (solo administradores)",
  open: "Pagos abiertos",
};

/** Platform-admin view of the Stripe connection: secrets present (never their values), mode and catalogue sync. */
function StripeAdminPanel({ onSynced }: { onSynced: () => void }) {
  const { data, error, reload } = useApi<any>("/admin/billing/stripe");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<ApiError | null>(null);
  const [result, setResult] = useState<any>(null);
  const sync = async () => {
    setErr(null);
    setBusy(true);
    try {
      setResult(await post("/admin/billing/stripe/sync", {}));
      reload();
      onSynced();
    } catch (e) {
      setErr(e as ApiError);
    } finally {
      setBusy(false);
    }
  };
  if (error || !data) return null;
  const ok = (b: boolean) => <Badge tone={b ? "ok" : "warn"}>{b ? "presente" : "falta"}</Badge>;
  return (
    <Card title="Stripe · administración de la plataforma" subtitle="Visible solo para administradores de DNI Growth. Las claves viven en los secretos de Cloudflare y nunca se muestran.">
      <dl className="grid gap-3 text-sm sm:grid-cols-2">
        <div>
          <dt className="text-mute">Modo</dt>
          <dd>
            {data.mode === "none" ? "—" : data.mode === "test" ? "Prueba" : "Real"} · {ACCESS_LABEL[data.access] ?? data.access}
          </dd>
        </div>
        <div>
          <dt className="text-mute">Claves</dt>
          <dd className="flex flex-wrap gap-2">
            <span>STRIPE_SECRET_KEY {ok(data.secretKeyPresent)}</span>
            <span>
              Firma del webhook{" "}
              <Badge tone={data.webhookVerifiable ? "ok" : "warn"}>
                {data.webhookSecretPresent ? "secreto de la titular" : data.webhookVerifiable ? "gestionada y cifrada" : "pendiente: pulsa Sincronizar"}
              </Badge>
            </span>
          </dd>
        </div>
        <div className="sm:col-span-2">
          <dt className="text-mute">URL del webhook (eventos checkout.session.completed y customer.subscription.*)</dt>
          <dd className="break-all font-mono text-xs">{data.webhookUrl}</dd>
        </div>
        <div className="sm:col-span-2">
          <dt className="text-mute">Precios en Stripe</dt>
          <dd className="text-xs">
            {data.plans
              .filter((p: any) => p.price_eur_month > 0)
              .map((p: any) => `${p.name}: ${p.stripe_price_id ?? "sin precio"}`)
              .join(" · ")}
          </dd>
        </div>
      </dl>
      <ErrorState error={err} />
      {result && <Notice tone="ok">Catálogo sincronizado: {result.plans.map((p: any) => `${p.code} (${p.action})`).join(", ")}; portal {result.portalAction === "created" ? "creado" : "actualizado"}.</Notice>}
      <Button className="mt-4" onClick={sync} loading={busy} disabled={!data.secretKeyPresent}>
        Sincronizar productos, precios y portal
      </Button>
    </Card>
  );
}

export function BillingPage() {
  const { orgId } = useParams();
  const [params] = useSearchParams();
  const access = useOrgAccess(orgId);
  const { data, error, loading, reload } = useApi<any>(`/orgs/${orgId}/billing`);
  const [err, setErr] = useState<ApiError | null>(null);
  const [busyPlan, setBusyPlan] = useState<string | null>(null);
  const { me } = useAuth();
  if (loading && !data) return <Spinner />;
  if (error) return <ErrorState error={error} onRetry={reload} />;

  const checkout = async (planCode: string) => {
    setErr(null);
    setBusyPlan(planCode);
    try {
      const r = await post<{ url: string }>(`/orgs/${orgId}/billing/checkout`, { planCode });
      if (r.url.startsWith("https://checkout.stripe.com/")) window.location.assign(r.url);
    } catch (e) {
      setErr(e as ApiError);
    } finally {
      setBusyPlan(null);
    }
  };
  const openPortal = async () => {
    setErr(null);
    setBusyPlan("portal");
    try {
      const r = await post<{ url: string }>(`/orgs/${orgId}/billing/portal`, {});
      if (r.url.startsWith("https://billing.stripe.com/")) window.location.assign(r.url);
    } catch (e) {
      setErr(e as ApiError);
    } finally {
      setBusyPlan(null);
    }
  };
  const limits = data.plan.limits;
  const stripeSub = data.subscription?.provider === "stripe" && data.subscription.status !== "canceled";
  const canPay = !!data.stripe.canCheckout && access.can("billing:manage");

  return (
    <>
      <PageHeader eyebrow="Organización" title="Facturación y créditos" subtitle="Cuota del software y créditos de uso separados. Cada consumo queda registrado en un libro contable inmutable." />
      <div className="mb-4 space-y-3">
        {params.get("checkout") === "success" && <Notice tone="ok">Pago recibido por Stripe. El plan se activa cuando llega la confirmación firmada (normalmente en segundos).</Notice>}
        {params.get("checkout") === "cancel" && <Notice tone="warn">Pago cancelado. No se ha realizado ningún cargo.</Notice>}
        {!data.stripe.configured && <Notice tone="warn" title="Pagos no activados">Stripe no está conectado en este entorno. Los planes de pago aparecen como «próximamente» y no se realiza ningún cargo.</Notice>}
        {data.stripe.configured && data.stripe.access === "test_admin_only" && (
          <Notice tone="warn" title="Stripe en modo prueba">
            {data.stripe.note} {data.stripe.canCheckout ? "Usa la tarjeta 4242 4242 4242 4242, cualquier fecha futura y cualquier CVC." : ""}
          </Notice>
        )}
        {stripeSub && access.can("billing:manage") && (
          <div className="flex flex-wrap items-center gap-3 rounded-2xl border border-line bg-surface p-4">
            <p className="flex-1 text-sm">Cambia de plan, actualiza la tarjeta, descarga facturas o cancela desde el portal seguro de Stripe.</p>
            <Button onClick={openPortal} loading={busyPlan === "portal"} disabled={!data.stripe.canCheckout}>
              Gestionar suscripción
            </Button>
          </div>
        )}
        <ErrorState error={err} />
      </div>
      <div className="mb-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <div className="rounded-2xl border border-line bg-surface p-4">
          <p className="text-sm text-mute">Plan actual</p>
          <p className="mt-1 font-serif text-4xl">{data.plan.name}</p>
          <p className="mt-1 text-xs text-mute">{data.plan.code === "free" || !data.subscription ? "Sin suscripción de pago" : `Suscripción ${SUB_STATUS[data.subscription.status] ?? data.subscription.status}`}</p>
        </div>
        <div className="rounded-2xl border border-line bg-surface p-4">
          <p className="text-sm text-mute">Créditos disponibles</p>
          <p className="mt-1 font-serif text-4xl tabular-nums">{data.balance}</p>
          <p className="mt-1 text-xs text-mute">{limits.monthlyCredits} incluidos cada mes</p>
        </div>
        <div className="rounded-2xl border border-line bg-surface p-4">
          <p className="text-sm text-mute">Auditorías al mes</p>
          <p className="mt-1 font-serif text-4xl tabular-nums">{limits.analysesPerMonth}</p>
          <p className="mt-1 text-xs text-mute">hasta {limits.pagesPerCrawl} páginas cada una</p>
        </div>
        <div className="rounded-2xl border border-line bg-surface p-4">
          <p className="text-sm text-mute">Marcas · usuarios</p>
          <p className="mt-1 font-serif text-4xl tabular-nums">
            {limits.brands} · {limits.seats}
          </p>
        </div>
      </div>

      <div className="mb-6 grid gap-4 md:grid-cols-2 xl:grid-cols-5">
        {data.plans.map((p: any) => {
          const l = JSON.parse(p.limits_json);
          const current = p.code === data.plan.code;
          return (
            <div key={p.code} className={`flex flex-col rounded-2xl border bg-surface p-4 ${current ? "border-accent" : "border-line"}`}>
              <div className="flex items-center justify-between">
                <p className="font-semibold">{p.name}</p>
                {current && <Badge tone="accent">Actual</Badge>}
              </div>
              <p className="mt-2 font-serif text-4xl tabular-nums">
                {p.price_eur_month}€<span className="font-sans text-sm text-mute">/mes</span>
              </p>
              <ul className="mt-3 flex-1 space-y-1 text-xs text-mute">
                <li>{l.analysesPerMonth} auditorías/mes</li>
                <li>{l.pagesPerCrawl} páginas por auditoría</li>
                <li>{l.monthlyCredits} créditos/mes</li>
                <li>
                  {l.brands} marca(s) · {l.seats} usuario(s)
                </li>
              </ul>
              {!current && p.price_eur_month > 0 && !stripeSub && (
                <Button className="mt-4" disabled={!canPay || !p.purchasable} loading={busyPlan === p.code} onClick={() => checkout(p.code)}>
                  {!data.stripe.configured || !p.purchasable ? "Próximamente" : !canPay ? "Pagos aún no disponibles" : "Contratar este plan"}
                </Button>
              )}
            </div>
          );
        })}
      </div>

      {me?.user?.isPlatformAdmin && <StripeAdminPanel onSynced={reload} />}

      <Card title="Movimientos de créditos" subtitle="Reserva al iniciar un trabajo, consumo real al terminar y liberación del resto. Si un trabajo falla, se libera todo.">
        {data.ledger.length === 0 ? (
          <p className="text-sm text-mute">Sin movimientos.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[560px] text-sm">
              <thead className="text-left text-xs text-mute">
                <tr>
                  <th className="py-2 font-medium">Fecha</th>
                  <th className="py-2 font-medium">Movimiento</th>
                  <th className="py-2 font-medium">Concepto</th>
                  <th className="py-2 text-right font-medium">Créditos</th>
                </tr>
              </thead>
              <tbody>
                {data.ledger.map((e: any) => (
                  <tr key={e.id} className="border-t border-line">
                    <td className="py-2 text-mute">{fmtDate(e.created_at)}</td>
                    <td className="py-2">{ENTRY_LABEL[e.entry_kind] ?? e.entry_kind}</td>
                    <td className="py-2">
                      {e.job_id ? (
                        <Link className="hover:underline" to={`/o/${orgId}/jobs/${e.job_id}`}>
                          {e.category}
                        </Link>
                      ) : (
                        e.category
                      )}
                    </td>
                    <td className={`py-2 text-right tabular-nums ${e.amount < 0 ? "text-danger" : "text-ok"}`}>
                      {e.amount > 0 ? "+" : ""}
                      {e.amount}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
      {data.notes.map((n: string) => (
        <p key={n} className="mt-3 text-xs text-mute">
          {n}
        </p>
      ))}
    </>
  );
}

const PROVIDER_STATUS: Record<string, { label: string; tone: "ok" | "warn" | "neutral" | "info" | "danger" }> = {
  connected: { label: "Activo", tone: "ok" },
  demo: { label: "Modo desarrollo", tone: "info" },
  not_configured: { label: "No configurado", tone: "warn" },
  planned: { label: "Planificado", tone: "neutral" },
  blocked_external_approval: { label: "Requiere aprobación externa", tone: "danger" },
};

export function IntegrationsPage() {
  const { orgId } = useParams();
  const { data, error, loading, reload } = useApi<any>(`/orgs/${orgId}/integrations`);
  return (
    <>
      <PageHeader eyebrow="Organización" title="Integraciones" subtitle="Estado real de cada proveedor. Nada aparece como conectado hasta que lo está y se ha validado." />
      <ErrorState error={error} onRetry={reload} />
      {loading && !data ? (
        <Spinner />
      ) : (
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
          {data?.items.map((p: any) => (
            <div key={p.key} className="rounded-2xl border border-line bg-surface p-5">
              <div className="flex items-start justify-between gap-2">
                <div>
                  <p className="font-medium">{p.name}</p>
                  <p className="text-xs text-mute">
                    {p.category} · fase {p.phase}
                  </p>
                </div>
                <Badge tone={PROVIDER_STATUS[p.status]?.tone}>{PROVIDER_STATUS[p.status]?.label ?? p.status}</Badge>
              </div>
              <p className="mt-3 text-sm text-mute">{p.note}</p>
            </div>
          ))}
        </div>
      )}
    </>
  );
}

const ACTION_LABEL: Record<string, string> = {
  "org.create": "Organización creada",
  "member.invite": "Invitación enviada",
  "member.invite_revoke": "Invitación revocada",
  "member.join": "Miembro unido",
  "member.role_change": "Rol cambiado",
  "member.remove": "Miembro eliminado",
  "brand.create": "Marca creada",
  "site.analyze": "Auditoría solicitada",
  "job.cancel": "Trabajo cancelado",
  "brand_profile.update": "Perfil de marca editado",
  "brand_profile.confirm": "Perfil de marca confirmado",
  "plan_task.update": "Tarea del plan actualizada",
  "billing.checkout_start": "Pago iniciado",
  "billing.subscription_sync": "Suscripción sincronizada",
  "billing.subscription_canceled": "Suscripción cancelada",
};

export function AuditLogPage() {
  const { orgId } = useParams();
  const [cursor, setCursor] = useState<string | null>(null);
  const { data, error, loading, reload } = useApi<any>(`/orgs/${orgId}/audit-logs${cursor ? `?before=${encodeURIComponent(cursor)}` : ""}`);
  const [open, setOpen] = useState<string | null>(null);
  return (
    <>
      <PageHeader eyebrow="Organización" title="Logs de auditoría" subtitle="Registro inmutable de quién hizo qué y cuándo. Los datos personales y secretos se ocultan automáticamente." />
      <ErrorState error={error} onRetry={reload} />
      {loading && !data ? (
        <Spinner />
      ) : !data?.items.length ? (
        <EmptyState title="Sin eventos" />
      ) : (
        <Card>
          <ul className="divide-y divide-line">
            {data.items.map((a: any) => (
              <li key={a.id} className="py-3">
                <button className="flex w-full flex-wrap items-center gap-2 text-left text-sm" onClick={() => setOpen(open === a.id ? null : a.id)} aria-expanded={open === a.id}>
                  <span className="font-medium">{ACTION_LABEL[a.action] ?? a.action}</span>
                  <span className="text-mute">· {a.actor_name ?? "Sistema"}</span>
                  <span className="ml-auto text-xs text-mute" title={fmtDate(a.created_at)}>
                    {timeAgo(a.created_at)}
                  </span>
                </button>
                {open === a.id && (
                  <pre className="mt-2 overflow-x-auto whitespace-pre-wrap break-all rounded-xl bg-surface-2 p-3 font-mono text-xs">
                    {JSON.stringify({ action: a.action, entity: `${a.entity_type}:${a.entity_id ?? "—"}`, before: a.before_redacted ? JSON.parse(a.before_redacted) : null, after: a.after_redacted ? JSON.parse(a.after_redacted) : null, requestId: a.request_id }, null, 2)}
                  </pre>
                )}
              </li>
            ))}
          </ul>
          <div className="mt-4 flex gap-2">
            {cursor && <Button onClick={() => setCursor(null)}>Más recientes</Button>}
            {data.nextCursor && <Button onClick={() => setCursor(data.nextCursor)}>Más antiguos</Button>}
          </div>
        </Card>
      )}
    </>
  );
}

export function ModulePage() {
  const { orgId, moduleKey = "" } = useParams();
  const m = MODULES[moduleKey];
  if (!m) return <NotFoundPage />;
  return (
    <>
      <PageHeader eyebrow={`Módulo · fase ${m.phase}`} title={m.label} />
      <div className="max-w-2xl space-y-4">
        <div className="rounded-2xl border border-dashed border-line p-8">
          <Lock className="mb-4 size-8 text-mute" aria-hidden />
          <p className="text-lg font-medium">Este módulo aún no está disponible</p>
          <p className="mt-2 text-mute">{m.description}</p>
          <p className="mt-4 text-sm text-mute">No mostramos datos de ejemplo ni métricas simuladas: cuando el módulo esté activo verás aquí tus datos reales con su fuente.</p>
          <Link className="mt-6 inline-flex min-h-10 items-center rounded-full bg-accent px-4 text-sm font-semibold text-accent-ink" to={`/o/${orgId}/analyze`}>
            Empieza por una auditoría web
          </Link>
        </div>
      </div>
    </>
  );
}

export function NotFoundPage() {
  return (
    <div className="grid min-h-[50vh] place-items-center text-center">
      <div>
        <p className="font-serif text-7xl">404</p>
        <p className="mt-2 text-mute">Esta página no existe o no tienes acceso.</p>
        <Link className="mt-4 inline-block text-sm text-accent-text hover:underline" to="/">
          Volver al inicio
        </Link>
      </div>
    </div>
  );
}
