import { useEffect, useState, type FormEvent } from "react";
import { Link, Navigate, useLocation, useNavigate, useParams, useSearchParams } from "react-router";
import { Lock, Mail, Trash2, UserMinus } from "lucide-react";
import { api, ApiError, del, fmtDate, patch, post, timeAgo } from "../lib/api";
import { useAuth } from "../lib/auth";
import { useApi } from "../lib/hooks";
import { MODULES } from "../shell";
import { AI_DAILY_REQUESTS, AI_IMAGES_DAILY, AI_USER_DAILY_REQUESTS, PLAN_PITCH, planIncludes } from "@dni/core/plan-access";
import { UsageMeters, useUsage } from "../usage";
import { PlanModulesTable } from "../planaccess";
import { Entitlements } from "./agency";
import { Badge, Button, Card, EmptyState, ErrorState, Input, Notice, PageHeader, Select, Spinner, TextField } from "../ui";
import { clearWantedPlan, GuaranteeCard, PlanPicker, SubscriptionPanel } from "./billing";

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
      {access.role === "owner" && <OrgSettings orgId={orgId!} />}
    </>
  );
}

/** Owner-only: rename the organisation, or delete it with a 30-day undo (nothing is erased before). */
function OrgSettings({ orgId }: { orgId: string }) {
  const { me, refresh } = useAuth();
  const nav = useNavigate();
  const current = me?.memberships.find((m) => m.id === orgId);
  const [name, setName] = useState(current?.name ?? "");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<ApiError | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const run = async (key: string, fn: () => Promise<unknown>, done?: string) => {
    setBusy(key);
    setErr(null);
    setOk(null);
    try {
      await fn();
      if (done) setOk(done);
    } catch (e) {
      setErr(e as ApiError);
    } finally {
      setBusy(null);
    }
  };
  const rename = (e: FormEvent) => (e.preventDefault(), run("rename", async () => (await patch(`/orgs/${orgId}`, { name: name.trim() }), await refresh()), "Nombre actualizado."));
  const remove = () =>
    run("delete", async () => {
      await api(`/orgs/${orgId}`, { method: "DELETE", body: { confirmName: confirm } });
      const m = await refresh();
      nav(m?.memberships[0] ? `/o/${m.memberships[0].id}` : "/onboarding", { replace: true });
    });
  return (
    <div className="mt-6 grid gap-6 lg:grid-cols-2">
      <Card title="Datos de la organización">
        <form onSubmit={rename} className="space-y-3">
          <TextField label="Nombre" value={name} onChange={(e) => setName(e.target.value)} minLength={2} maxLength={120} required />
          <Button type="submit" loading={busy === "rename"} disabled={name.trim().length < 2 || name.trim() === current?.name}>
            Guardar nombre
          </Button>
        </form>
        {ok && <div className="mt-3"><Notice tone="ok">{ok}</Notice></div>}
      </Card>
      <Card title="Eliminar organización" subtitle="Puedes deshacerlo durante 30 días desde «Organizaciones eliminadas».">
        <p className="text-sm text-mute">
          Todo el equipo pierde el acceso y las landings y formularios públicos dejan de funcionar. No se borra ningún dato hasta pasados 30 días. Si tienes una suscripción de pago, cancélala antes.
        </p>
        <label className="mt-3 block text-sm">
          <span className="mb-1 block">Escribe «{current?.name}» para confirmar</span>
          <Input value={confirm} onChange={(e) => setConfirm(e.target.value)} placeholder={current?.name} />
        </label>
        <Button variant="danger" className="mt-3" loading={busy === "delete"} disabled={confirm.trim() !== current?.name?.trim()} onClick={remove}>
          <Trash2 className="size-4" aria-hidden /> Eliminar organización
        </Button>
      </Card>
      {err && <div className="lg:col-span-2"><ErrorState error={err} /></div>}
    </div>
  );
}

const ENTRY_LABEL: Record<string, string> = { grant: "Asignación", reserve: "Reserva", release: "Liberación", settle: "Consumo", adjustment: "Ajuste" };
/** Ledger categories are stored as internal codes; customers only ever see these labels. */
export const LEDGER_CONCEPT: Record<string, string> = {
  monthly_allowance: "Créditos incluidos en el plan",
  plan_upgrade: "Créditos por cambio de plan",
  platform_adjustment: "Ajuste del equipo de DNI Growth",
  site_analysis: "Auditoría web",
  ai_advisor: "Pregunta al Asesor",
  ai_content: "Borrador de contenido con IA",
  ai_content_review: "Revisión de contenido con IA",
  ai_image: "Imagen con IA",
};
export const ledgerConcept = (c: string) => LEDGER_CONCEPT[c] ?? "Otro movimiento";
const SUB_STATUS: Record<string, string> = { active: "activa", trialing: "en prueba", past_due: "con pago pendiente", canceled: "cancelada", incomplete: "incompleta" };

const ACCESS_LABEL: Record<string, string> = {
  not_configured: "Sin conectar",
  off: "Desactivado",
  test_admin_only: "Modo prueba (solo administradores)",
  open: "Pagos abiertos",
};

/** Platform-admin view of the Stripe connection: secrets present (never their values), mode and catalogue sync. */
export function StripeAdminPanel({ onSynced }: { onSynced: () => void }) {
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
        <div>
          <dt className="text-mute">Cuenta de Stripe</dt>
          <dd className="flex flex-wrap items-center gap-2">
            {data.account ? (
              <>
                <span>{data.account.name ?? "Sin nombre"}</span>
                <Badge tone={data.account.chargesEnabled ? "ok" : "warn"}>{data.account.chargesEnabled ? "puede cobrar" : "Stripe aún no permite cobrar"}</Badge>
              </>
            ) : (
              "Sin comprobar: pulsa Sincronizar"
            )}
          </dd>
        </div>
        <div>
          <dt className="text-mute">IVA</dt>
          <dd>{!data.tax ? "—" : data.tax.mode === "automatic" ? "Stripe Tax (automático)" : data.tax.taxRateId ? "IVA España 21 % (tipo manual)" : "Pendiente de sincronizar"}</dd>
        </div>
        <div className="sm:col-span-2">
          <dt className="text-mute">Sincronización automática</dt>
          <dd className="text-xs">
            Cada hora como máximo; última: {data.lastAutoSync ? fmtDate(data.lastAutoSync) : "nunca"} · interruptor BILLING_ENABLED = {data.billingFlagValue ?? "sin definir"}
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
              .map((p: any) => `${p.name}: ${p.stripe_price_id ?? "sin precio"} / anual ${p.stripe_price_id_year ?? "sin precio"}`)
              .join(" · ")}
          </dd>
        </div>
      </dl>
      <ErrorState error={err} />
      {result && <Notice tone="ok">Catálogo sincronizado: {result.plans.map((p: any) => `${p.code} (${p.action})`).join(", ")}; portal {result.portalAction === "created" ? "creado" : "actualizado"}.</Notice>}
      <Button className="mt-4" onClick={sync} loading={busy} disabled={!data.secretKeyPresent}>
        Sincronizar productos, precios y portal
      </Button>
      {data.secretKeyPresent && <ForeignProducts />}
    </Card>
  );
}

/** Products in the Stripe account that DNI Growth does not manage: preview, then archive (reversible in Stripe). */
function ForeignProducts() {
  const { data, reload } = useApi<{ items: Array<{ id: string; name: string; created: number }> }>("/admin/billing/stripe/foreign-products");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<ApiError | null>(null);
  const [done, setDone] = useState<number | null>(null);
  if (!data) return null;
  const archive = async () => {
    setErr(null);
    setBusy(true);
    try {
      const r = await post<{ archived: string[] }>("/admin/billing/stripe/archive-products", { ids: data.items.map((i) => i.id).slice(0, 50) });
      setDone(r.archived.length);
      reload();
    } catch (e) {
      setErr(e as ApiError);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="mt-4 border-t border-line pt-4 text-sm">
      <p className="font-medium">Productos antiguos en la cuenta de Stripe</p>
      {data.items.length === 0 ? (
        <p className="text-mute">{done ? `${done} producto(s) archivado(s). ` : ""}No hay productos activos ajenos a DNI Growth.</p>
      ) : (
        <>
          <ul className="mt-1 list-disc pl-5 text-mute">
            {data.items.slice(0, 20).map((i) => (
              <li key={i.id}>
                {i.name} <span className="font-mono text-xs">{i.id}</span>
              </li>
            ))}
          </ul>
          <p className="mt-1 text-xs text-mute">Se archivan (no se borran): dejan de venderse y se pueden reactivar en Stripe. Las suscripciones existentes no se tocan.</p>
          <Button className="mt-2" variant="danger" loading={busy} onClick={archive}>
            Archivar {data.items.length} producto(s)
          </Button>
        </>
      )}
      <ErrorState error={err} />
    </div>
  );
}

export function BillingPage() {
  const { orgId } = useParams();
  const [params] = useSearchParams();
  const access = useOrgAccess(orgId);
  const { data, error, loading, reload } = useApi<any>(`/orgs/${orgId}/billing`);
  const { data: usage } = useUsage(orgId);
  const [err, setErr] = useState<ApiError | null>(null);
  const [busyPlan, setBusyPlan] = useState<string | null>(null);
  const { me } = useAuth();
  const { hash } = useLocation();
  // The plan picked on the public prices has done its job once the plans are on screen.
  useEffect(() => {
    if (data) clearWantedPlan();
  }, [data]);
  // Back from Stripe Checkout: ask Stripe directly (a few tries) instead of waiting for its notification.
  const [checkoutSync, setCheckoutSync] = useState<"checking" | "done" | "pending" | null>(null);
  useEffect(() => {
    if (params.get("checkout") !== "success" || !orgId) return;
    let stop = false;
    setCheckoutSync("checking");
    (async () => {
      for (let i = 0; i < 4 && !stop; i++) {
        try {
          const r = await post<{ planCode: string; status: string | null }>(`/orgs/${orgId}/billing/sync`, {});
          if (r.status === "active" || r.status === "trialing") {
            if (!stop) setCheckoutSync("done");
            reload();
            return;
          }
        } catch {
          // Rate limit or network: the webhook and the hourly check still apply the payment.
        }
        await new Promise((res) => setTimeout(res, 4000));
      }
      if (!stop) setCheckoutSync("pending");
      reload();
    })();
    return () => {
      stop = true;
    };
  }, [orgId, params]);
  // Deep links from warnings («#uso», «#planes») scroll once the content exists.
  useEffect(() => {
    if (!hash || !data) return;
    document.getElementById(hash.slice(1))?.scrollIntoView({ block: "start" });
  }, [hash, data, usage]);
  if (loading && !data) return <Spinner />;
  if (error) return <ErrorState error={error} onRetry={reload} />;

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
      <PageHeader eyebrow="Organización" title="Plan, límites y créditos" subtitle="Lo que incluye tu plan, cuánto llevas usado hoy y este mes, y cuándo se renueva. Cada consumo queda registrado." />
      <div className="mb-4 space-y-3">
        {params.get("checkout") === "success" && (
          <Notice tone={checkoutSync === "pending" ? "warn" : "ok"} title={checkoutSync === "done" ? "Plan activado" : checkoutSync === "pending" ? "Stripe aún está confirmando el pago" : "Comprobando el pago con Stripe…"}>
            {checkoutSync === "done"
              ? "Stripe ha confirmado tu suscripción y tu plan ya está activo. Gracias."
              : checkoutSync === "pending"
                ? "Algunos métodos de pago tardan en confirmarse. En cuanto Stripe lo confirme, el plan se activa solo (lo comprobamos también cada hora). No hace falta pagar de nuevo."
                : "Estamos preguntando a Stripe por tu pago. Tarda unos segundos."}
          </Notice>
        )}
        {params.get("checkout") === "cancel" && <Notice tone="warn">Pago cancelado. No se ha realizado ningún cargo.</Notice>}
        {!data.stripe.configured && <Notice tone="warn" title="Pagos no activados">Stripe no está conectado en este entorno. Los planes de pago aparecen como «próximamente» y no se realiza ningún cargo.</Notice>}
        {data.stripe.configured && data.stripe.access === "test_admin_only" && (
          <Notice tone="warn" title="Stripe en modo prueba">
            {data.stripe.note} {data.stripe.canCheckout ? "Usa la tarjeta 4242 4242 4242 4242, cualquier fecha futura y cualquier CVC." : ""}
          </Notice>
        )}
        {stripeSub && access.can("billing:manage") && <SubscriptionPanel data={data} orgId={orgId!} reload={reload} openPortal={openPortal} portalBusy={busyPlan === "portal"} />}
        {stripeSub && !access.can("billing:manage") && !!data.subscription.cancel_at_period_end && <Notice tone="warn">La suscripción está cancelada y no se renovará al final del periodo.</Notice>}
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

      {usage && (
        <section id="uso" className="mb-8 scroll-mt-20" aria-labelledby="uso-title">
          <h2 id="uso-title" className="mb-1 font-serif text-2xl">Tu uso</h2>
          <p className="mb-3 text-sm text-mute">Te avisamos al llegar al 75 % y al 90 % de cada límite. Al agotarse, la acción se detiene sin cobrar nada.</p>
          <UsageMeters orgId={orgId!} usage={usage} />
        </section>
      )}

      {stripeSub && access.can("billing:manage") && (
        <div className="mb-6">
          <GuaranteeCard orgId={orgId!} canManage={access.can("billing:manage")} />
        </div>
      )}

      <PlanPicker
        data={data}
        orgId={orgId!}
        canPay={canPay}
        stripeSub={stripeSub}
        planExtras={(p: any) => {
          const l = JSON.parse(p.limits_json);
          return (
            <>
              <ul className="mt-3 flex-1 space-y-1 text-xs text-mute">
                <li>{l.analysesPerMonth} auditorías/mes</li>
                <li>{l.pagesPerCrawl} páginas por auditoría</li>
                {l.articlesPerMonth !== undefined && <li>{l.articlesPerMonth} borradores de artículo con IA/mes</li>}
                <li>{l.monthlyCredits} créditos/mes</li>
                <li>
                  {l.brands} web(s) · {l.seats >= 1000 ? "usuarios ilimitados" : `${l.seats} usuario(s)`}
                </li>
                {l.landingPages !== undefined && planIncludes(p.code, "landings") && <li>{l.landingPages} landings · {l.leadForms ?? 1} formularios</li>}
                {l.automationRules !== undefined && planIncludes(p.code, "automations") && <li>{l.automationRules} reglas de automatización</li>}
                {l.videoProjects !== undefined && planIncludes(p.code, "video") && <li>{l.videoProjects} proyectos de vídeo</li>}
                {l.trackedPrompts !== undefined && planIncludes(p.code, "ai-visibility") && <li>{l.trackedPrompts} preguntas GEO</li>}
                {l.clientOrgs && planIncludes(p.code, "agency") ? <li>{l.clientOrgs} clientes (agencia) y marca blanca</li> : null}
                <li>{AI_DAILY_REQUESTS[p.code as keyof typeof AI_DAILY_REQUESTS] ?? 10} consultas de IA al día ({AI_USER_DAILY_REQUESTS[p.code as keyof typeof AI_USER_DAILY_REQUESTS] ?? 10} por persona)</li>
                {(AI_IMAGES_DAILY[p.code as keyof typeof AI_IMAGES_DAILY] ?? 0) > 0 && <li>{AI_IMAGES_DAILY[p.code as keyof typeof AI_IMAGES_DAILY]} imágenes con IA al día</li>}
              </ul>
              <p className="mt-3 text-xs leading-snug">{PLAN_PITCH[p.code as keyof typeof PLAN_PITCH] ?? ""}</p>
            </>
          );
        }}
      />
      <div className="mb-6" />

      <section className="mb-6" aria-labelledby="plan-modules-title">
        <h2 id="plan-modules-title" className="mb-1 font-serif text-2xl">Qué módulos incluye cada plan</h2>
        <p className="mb-3 text-sm text-mute">Los módulos fuera de tu plan aparecen con candado en el menú, en «Disponible en otros planes». Tus datos se conservan si cambias de plan.</p>
        <PlanModulesTable current={data.plan.code} />
      </section>

      <div className="mb-6"><Entitlements orgId={orgId!} /></div>

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
                          {ledgerConcept(e.category)}
                        </Link>
                      ) : (
                        ledgerConcept(e.category)
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
  available: { label: "Disponible", tone: "info" },
  reauth_required: { label: "Volver a conectar", tone: "danger" },
  disconnected: { label: "Desconectado", tone: "neutral" },
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
                    {p.category}
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
  "billing.terms_accepted": "Condiciones de contratación aceptadas",
  "billing.paused": "Suscripción pausada",
  "billing.resumed": "Suscripción reanudada",
  "billing.cancel_flow": "Cancelación o alternativa elegida",
  "billing.cancel_undone": "Cancelación anulada",
  "billing.guarantee_refund": "Reembolso de la garantía de 90 días",
  "billing.payment_failed": "Cobro fallido",
  "billing.invoice_paid": "Factura pagada",
  "billing.grace_expired": "Fin del periodo de gracia: plan Free",
  "platform.stripe_catalog_autosync": "Sincronización automática con Stripe",
  "platform.stripe_products_archived": "Productos antiguos archivados en Stripe",
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
  "billing.portal_open": "Portal de facturación abierto",
  "ads.campaign_archive": "Campaña archivada",
  "ads.campaign_draft": "Borrador de campaña guardado",
  "ads.campaign_submit": "Campaña enviada a aprobación",
  "ads.spend_guardian_update": "Límites de gasto actualizados",
  "advisor.message": "Consulta al Asesor IA",
  "agency.client_create": "Cliente de agencia creado",
  "ai.catalog_sync": "Catálogo de modelos de IA actualizado",
  "ai.openrouter_reset_halt": "Motor de IA reactivado",
  "ai.preferences_update": "Preferencias de IA actualizadas",
  "ai.provider_test": "Prueba de motor de IA",
  "audit.export": "Informe de auditoría exportado",
  "automation.rule_create": "Automatización creada",
  "automation.rule_delete": "Automatización eliminada",
  "automation.secret_rotate": "Clave de automatización renovada",
  "brand.profile_created": "Perfil de marca extraído",
  "content.create_manual": "Borrador manual creado",
  "content.edit": "Contenido editado",
  "content.from_finding": "Borrador creado desde un hallazgo",
  "content.generate": "Borrador generado con IA",
  "content.submit": "Contenido enviado a revisión",
  "content.approve": "Contenido aprobado",
  "content.reject": "Contenido devuelto a borrador",
  "content.archive": "Contenido archivado",
  "content.export": "Contenido exportado",
  "content.ai_review": "Revisión de contenido con IA",
  "creative.image_generate": "Imagen generada",
  "crm.export": "Leads exportados",
  "geo.prompt_archive": "Pregunta GEO archivada",
  "geo.prompt_restore": "Pregunta GEO restaurada",
  "geo.prompt_update": "Pregunta GEO editada",
  "geo.prompts_create": "Preguntas GEO creadas",
  "geo.sample_run": "Muestreo GEO ejecutado",
  "integration.connect": "Integración conectada",
  "integration.disconnect": "Integración desconectada",
  "integration.gsc_property_deselect": "Propiedad de Search Console quitada",
  "integration.gsc_property_select": "Propiedad de Search Console elegida",
  "integration.gsc_sync": "Search Console sincronizado",
  "landing.create": "Landing creada",
  "landing.experiment_promote_b": "Variante B aplicada",
  "landing.experiment_start": "Test A/B iniciado",
  "landing.experiment_stop": "Test A/B detenido",
  "landing.publish": "Landing publicada",
  "landing.unpublish": "Landing despublicada",
  "landing.update": "Landing editada",
  "lead.captured": "Lead recibido",
  "lead.create": "Lead creado",
  "lead.erase": "Datos de lead suprimidos",
  "lead.update": "Lead actualizado",
  "lead_form.create": "Formulario creado",
  "lead_form.update": "Formulario editado",
  "media.delete": "Archivo eliminado",
  "media.upload": "Archivo subido",
  "org.branding_reset": "Marca blanca restablecida",
  "org.branding_update": "Marca blanca actualizada",
  "org.delete": "Organización eliminada",
  "org.rename": "Organización renombrada",
  "org.restore": "Organización restaurada",
  "plan.created": "Plan de 30 días creado",
  "platform.plan_assign": "Plan asignado por la plataforma",
  "report.export": "Informe exportado",
  "seo.issue_status": "Estado de hallazgo actualizado",
  "user.link_google": "Cuenta de Google vinculada",
  "user.link_google_verified": "Vinculación con Google verificada",
  "user.login": "Inicio de sesión",
  "user.login_failed": "Inicio de sesión fallido",
  "user.login_google": "Inicio de sesión con Google",
  "user.password_reset": "Contraseña restablecida",
  "user.register": "Cuenta creada",
  "user.register_google": "Cuenta creada con Google",
  "user.verify_email": "Email verificado",
};
/** Unknown actions get a readable label from their area; the exact code stays in the technical detail. */
const AREA_LABEL: Record<string, string> = { content: "Contenido", ads: "Anuncios", ai: "IA", geo: "GEO", lead: "Leads", landing: "Landings", org: "Organización", user: "Cuenta", integration: "Integraciones", billing: "Facturación", member: "Equipo", platform: "Plataforma" };
const actionLabel = (a: string) => ACTION_LABEL[a] ?? `${AREA_LABEL[a.split(".")[0] ?? ""] ?? "Actividad"}: acción registrada`;

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
                  <span className="font-medium">{actionLabel(a.action)}</span>
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
  const live: Record<string, string> = { "seo-tecnico": "seo-tecnico", keywords: "keywords", authority: "authority", video: "video", ads: "ads", automations: "automations", agency: "agency", landings: "landings", experiments: "landings", crm: "crm", analytics: "analytics", agents: "jobs", content: "content", creative: "creative", "ai-visibility": "ai-visibility" };
  if (live[moduleKey]) return <Navigate to={`/o/${orgId}/${live[moduleKey]}`} replace />;
  if (!m) return <NotFoundPage />;
  return (
    <>
      <PageHeader eyebrow="Módulo" title={m.label} />
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
