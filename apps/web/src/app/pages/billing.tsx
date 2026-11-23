import { useState } from "react";
import { CheckCircle2, Circle } from "lucide-react";
import { ApiError, post } from "../lib/api";
import { useApi } from "../lib/hooks";
import { offerFor } from "@dni/core/pricing";
import { Badge, Button, Card, ErrorState, Notice, Progress, Select, Textarea } from "../ui";

const WANTED_KEY = "dni.wantedPlan";
/** Plan picked on the public prices («/app/register?plan=growth»). Only paid catalogue codes are kept. */
export function rememberWantedPlan(code: string | null): void {
  try {
    if (code && offerFor(code) && code !== "free") localStorage.setItem(WANTED_KEY, code);
  } catch {
    /* storage unavailable: nothing to remember */
  }
}
export function wantedPlan(): { code: string; name: string } | null {
  try {
    const code = localStorage.getItem(WANTED_KEY);
    const o = code ? offerFor(code) : undefined;
    return o && o.code !== "free" ? { code: o.code, name: o.name } : null;
  } catch {
    return null;
  }
}
export function clearWantedPlan(): void {
  try {
    localStorage.removeItem(WANTED_KEY);
  } catch {
    /* ignore */
  }
}

const fmtDay = (iso: string | null | undefined) => (iso && !Number.isNaN(Date.parse(iso)) ? new Date(iso).toLocaleDateString("es-ES", { day: "numeric", month: "long", year: "numeric" }) : null);
const eur = (n: number) => `${new Intl.NumberFormat("es-ES", { maximumFractionDigits: 0 }).format(n)} €`;

/** Plan cards with monthly/annual switch, free trial, explicit acceptance of the terms and Stripe Checkout. */
export function PlanPicker({ data, orgId, canPay, stripeSub, planExtras }: { data: any; orgId: string; canPay: boolean; stripeSub: boolean; planExtras: (p: any) => React.ReactNode }) {
  const [interval, setInterval] = useState<"month" | "year">("month");
  const [accepted, setAccepted] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<ApiError | null>(null);
  const checkout = async (planCode: string) => {
    setErr(null);
    setBusy(planCode);
    try {
      const r = await post<{ url: string }>(`/orgs/${orgId}/billing/checkout`, { planCode, interval, acceptTerms: true });
      if (r.url.startsWith("https://checkout.stripe.com/")) window.location.assign(r.url);
    } catch (e) {
      setErr(e as ApiError);
    } finally {
      setBusy(null);
    }
  };
  return (
    <>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
        <h2 id="planes" className="scroll-mt-20 font-serif text-2xl">
          Planes
        </h2>
        <div role="radiogroup" aria-label="Periodo de facturación" className="inline-flex rounded-full border border-line bg-surface p-1 text-sm">
          {(["month", "year"] as const).map((k) => (
            <button
              key={k}
              type="button"
              role="radio"
              aria-checked={interval === k}
              onClick={() => setInterval(k)}
              className={`rounded-full px-4 py-1.5 ${interval === k ? "bg-accent text-accent-ink" : "text-mute hover:text-ink"}`}
            >
              {k === "month" ? "Mensual" : "Anual · 2 meses gratis"}
            </button>
          ))}
        </div>
      </div>
      <div className="mb-4 grid gap-4 md:grid-cols-2 xl:grid-cols-5">
        {data.plans.map((p: any) => {
          const current = p.code === data.plan.code;
          const offer = offerFor(p.code);
          const yearly = interval === "year" && p.price_eur_year > 0;
          const perMonth = yearly ? (offer?.yearlyPerMonth ?? Math.floor(p.price_eur_year / 12)) : p.price_eur_month;
          const trial = p.trial_days > 0 && data.trialAvailable;
          const purchasable = yearly ? !!p.purchasable_year : !!p.purchasable;
          return (
            <div key={p.code} className={`flex flex-col rounded-2xl border bg-surface p-4 ${current ? "border-accent" : offer?.highlight ? "border-ink/40" : "border-line"}`}>
              <div className="flex items-center justify-between gap-2">
                <p className="font-semibold">{p.name}</p>
                {current ? <Badge tone="accent">Actual</Badge> : offer?.highlight ? <Badge tone="info">Recomendado</Badge> : null}
              </div>
              {offer && <p className="mt-1 text-xs text-mute">{offer.tagline}</p>}
              <p className="mt-2 font-serif text-4xl tabular-nums">
                {eur(perMonth)}
                <span className="font-sans text-sm text-mute">/mes</span>
              </p>
              <p className="text-xs text-mute">{p.price_eur_month === 0 ? "Gratis para siempre" : yearly ? `${eur(p.price_eur_year)} al año, IVA aparte` : "IVA aparte"}</p>
              {trial && !current && <p className="mt-2 text-xs font-medium text-ok">Prueba gratis de {p.trial_days} días (se pide tarjeta; te avisamos antes del primer cobro).</p>}
              {planExtras(p)}
              {!current && p.price_eur_month > 0 && !stripeSub && (
                <Button className="mt-4" variant={offer?.highlight ? "primary" : "secondary"} disabled={!canPay || !purchasable || !accepted} loading={busy === p.code} onClick={() => checkout(p.code)}>
                  {!data.stripe.configured || !purchasable ? "Próximamente" : !canPay ? "Pagos aún no disponibles" : trial ? `Empezar prueba de ${p.trial_days} días` : "Contratar este plan"}
                </Button>
              )}
            </div>
          );
        })}
      </div>
      {canPay && !stripeSub && (
        <label className="mb-2 flex items-start gap-2 text-sm">
          <input type="checkbox" className="mt-1" checked={accepted} onChange={(e) => setAccepted(e.target.checked)} />
          <span>
            Acepto las{" "}
            <a className="underline" href="/legal/condiciones" target="_blank" rel="noopener">
              condiciones de contratación
            </a>{" "}
            y pido que el servicio empiece ya: entiendo que, al empezar, pierdo el derecho de desistimiento de 14 días. Puedo cancelar cuando quiera desde aquí.
          </span>
        </label>
      )}
      <ErrorState error={err} />
    </>
  );
}

/** Status notices and self-service actions: pause, resume, cancellation with one honest offer, undo. */
export function SubscriptionPanel({ data, orgId, reload, openPortal, portalBusy }: { data: any; orgId: string; reload: () => void; openPortal: () => void; portalBusy: boolean }) {
  const sub = data.subscription;
  const [err, setErr] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [step, setStep] = useState<"idle" | "reason" | "offer">("idle");
  const [reason, setReason] = useState("");
  const [comment, setComment] = useState("");
  const [months, setMonths] = useState(1);
  const [done, setDone] = useState<string | null>(null);
  const run = async (key: string, path: string, body: Record<string, unknown>, okText: (r: any) => string) => {
    setErr(null);
    setBusy(key);
    try {
      const r = await post<any>(`/orgs/${orgId}/billing/${path}`, body);
      setDone(okText(r));
      setStep("idle");
      reload();
    } catch (e) {
      setErr(e as ApiError);
    } finally {
      setBusy(null);
    }
  };
  const reasonInfo = data.cancelReasons?.find((r: any) => r.key === reason);
  const paused = !!sub.paused_until;
  const offerFits = (o: string) => (o === "discount" ? data.retentionOfferAvailable && sub.status === "active" : o === "pause" ? sub.status === "active" && !paused : o === "downgrade");
  return (
    <div className="space-y-3">
      {done && <Notice tone="ok">{done}</Notice>}
      {sub.status === "trialing" && (
        <Notice tone="info" title="Prueba gratis en curso">
          Termina el {fmtDay(sub.trial_end) ?? "final de la prueba"}. Ese día se hará el primer cobro; te avisaremos por email 3 días y 1 día antes. Si cancelas antes, no se cobra nada.
        </Notice>
      )}
      {paused && (
        <Notice tone="warn" title="Suscripción en pausa">
          No se cobra nada {fmtDay(sub.paused_until) ? `hasta el ${fmtDay(sub.paused_until)}` : "hasta que la reanudes"}. Tus datos y ajustes se conservan; los módulos de pago descansan mientras tanto.
        </Notice>
      )}
      {sub.status === "past_due" && (
        <Notice tone="warn" title="No hemos podido cobrar tu suscripción">
          Stripe reintentará el cobro. Tu cuenta sigue funcionando {fmtDay(sub.grace_until) ? `hasta el ${fmtDay(sub.grace_until)}` : "unos días"}; después pasará al plan Free sin borrar nada. Actualiza la tarjeta en «Gestionar suscripción».
        </Notice>
      )}
      {!!sub.cancel_at_period_end && (
        <Notice tone="warn" title="Cancelación programada">
          La suscripción no se renovará. Mantienes el plan {data.plan.name} hasta el {fmtDay(sub.status === "trialing" ? sub.trial_end : sub.current_period_end) ?? "final del periodo"}; después pasarás al plan Free. Tus datos se conservan.
        </Notice>
      )}
      <div className="flex flex-wrap items-center gap-3 rounded-2xl border border-line bg-surface p-4">
        <p className="min-w-0 flex-1 text-sm">
          {sub.billing_interval === "year" ? "Facturación anual." : sub.billing_interval === "month" ? "Facturación mensual." : ""} Cambia de plan o de periodo, actualiza la tarjeta y descarga facturas en el portal seguro de Stripe. Las subidas se aplican al momento (prorrateadas) y las bajadas al final del periodo.
        </p>
        <Button onClick={openPortal} loading={portalBusy} disabled={!data.stripe.canCheckout}>
          Gestionar suscripción
        </Button>
        {paused ? (
          <Button variant="primary" loading={busy === "resume"} onClick={() => run("resume", "resume", {}, () => "Suscripción reanudada: tu plan vuelve a estar activo.")}>
            Reanudar ahora
          </Button>
        ) : sub.cancel_at_period_end ? (
          <Button loading={busy === "undo"} onClick={() => run("undo", "cancel/undo", {}, () => "Cancelación anulada: la suscripción seguirá renovándose.")}>
            Seguir suscrito
          </Button>
        ) : (
          <Button variant="ghost" onClick={() => setStep(step === "idle" ? "reason" : "idle")} aria-expanded={step !== "idle"}>
            Pausar o cancelar
          </Button>
        )}
      </div>
      {step !== "idle" && !paused && !sub.cancel_at_period_end && (
        <Card title="Antes de irte, una pregunta" subtitle="Nos ayuda a mejorar. Cancelar siempre está a un clic y no se borra nada: conservas el acceso hasta el final del periodo pagado.">
          <div className="grid gap-3">
            <label className="text-sm">
              <span className="mb-1 block text-mute">¿Por qué quieres cancelar?</span>
              <Select
                value={reason}
                onChange={(e) => {
                  setReason(e.target.value);
                  setStep(e.target.value ? "offer" : "reason");
                }}
              >
                <option value="">Elige un motivo</option>
                {data.cancelReasons?.map((r: any) => (
                  <option key={r.key} value={r.key}>
                    {r.label}
                  </option>
                ))}
              </Select>
            </label>
            <label className="text-sm">
              <span className="mb-1 block text-mute">¿Algo más que quieras contarnos? (opcional)</span>
              <Textarea maxLength={500} value={comment} onChange={(e) => setComment(e.target.value)} />
            </label>
            {step === "offer" && reasonInfo && offerFits(reasonInfo.offer) && (
              <div className="rounded-xl border border-line bg-surface-2 p-3 text-sm">
                {reasonInfo.offer === "discount" && (
                  <>
                    <p>
                      Te proponemos un {data.retentionDiscount.percentOff} % de descuento durante {data.retentionDiscount.months} meses (solo una vez).
                    </p>
                    <Button className="mt-2" variant="primary" loading={busy === "discount"} onClick={() => run("discount", "cancel", { reason, comment: comment || undefined, offer: "discount" }, () => "Descuento aplicado a tus próximas facturas.")}>
                      Aplicar el descuento y seguir
                    </Button>
                  </>
                )}
                {reasonInfo.offer === "pause" && (
                  <>
                    <p>Puedes pausar la suscripción de 1 a 3 meses: no se cobra nada y tus datos se quedan como están.</p>
                    <div className="mt-2 flex flex-wrap items-center gap-2">
                      <Select aria-label="Meses de pausa" value={String(months)} onChange={(e) => setMonths(Number(e.target.value))} className="w-auto">
                        {[1, 2, 3].map((m) => (
                          <option key={m} value={m}>
                            {m} {m === 1 ? "mes" : "meses"}
                          </option>
                        ))}
                      </Select>
                      <Button variant="primary" loading={busy === "pause"} onClick={() => run("pause", "cancel", { reason, comment: comment || undefined, offer: "pause", months }, (r) => `Suscripción en pausa hasta el ${fmtDay(r.pausedUntil) ?? "final de la pausa"}.`)}>
                        Pausar en lugar de cancelar
                      </Button>
                    </div>
                  </>
                )}
                {reasonInfo.offer === "downgrade" && (
                  <>
                    <p>Puedes pasar a un plan más pequeño desde el portal: el cambio se aplica al final del periodo y no pierdes nada.</p>
                    <Button className="mt-2" onClick={openPortal} loading={portalBusy}>
                      Ver planes más pequeños
                    </Button>
                  </>
                )}
              </div>
            )}
            {step === "offer" && (
              <div className="flex flex-wrap gap-2">
                <Button variant="danger" loading={busy === "cancel"} onClick={() => run("cancel", "cancel", { reason, comment: comment || undefined, offer: "none" }, (r) => `Cancelación programada. Mantienes el acceso hasta el ${fmtDay(r.accessUntil) ?? "final del periodo"}.`)}>
                  Cancelar la suscripción
                </Button>
                <Button variant="ghost" onClick={() => setStep("idle")}>
                  Volver
                </Button>
              </div>
            )}
          </div>
        </Card>
      )}
      <ErrorState error={err} />
    </div>
  );
}

const G_STATUS: Record<string, { label: string; tone: "ok" | "warn" | "neutral" | "info" }> = {
  in_progress: { label: "En curso", tone: "info" },
  requirements_missing: { label: "Faltan requisitos", tone: "warn" },
  growth_achieved: { label: "Impresiones en aumento", tone: "ok" },
  refund_available: { label: "Reembolso disponible", tone: "warn" },
  data_missing: { label: "Faltan datos de Search Console", tone: "warn" },
};

/** Measurable 90-day guarantee: requirements, Search Console impressions with source and the 1-click claim. */
export function GuaranteeCard({ orgId, canManage }: { orgId: string; canManage: boolean }) {
  const { data, reload } = useApi<any>(`/orgs/${orgId}/billing/guarantee`);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<ApiError | null>(null);
  const [done, setDone] = useState<string | null>(null);
  if (!data || data.status === "not_applicable") return null;
  const claim = async () => {
    setErr(null);
    setBusy(true);
    try {
      const r = await post<{ refundedCents: number }>(`/orgs/${orgId}/billing/guarantee/claim`, {});
      setDone(`Reembolso tramitado: ${(r.refundedCents / 100).toFixed(2).replace(".", ",")} € a tu método de pago.`);
      reload();
    } catch (e) {
      setErr(e as ApiError);
    } finally {
      setBusy(false);
    }
  };
  const st = G_STATUS[data.status] ?? { label: data.status, tone: "neutral" as const };
  const fmtN = (n: number | null) => (n === null ? "sin datos suficientes" : new Intl.NumberFormat("es-ES").format(n));
  return (
    <Card
      title="Garantía de 90 días"
      subtitle={
        <>
          Si cumples los requisitos y tus impresiones orgánicas no suben en 90 días, te devolvemos lo pagado.{" "}
          <a className="underline" href={data.terms}>
            Condiciones
          </a>
        </>
      }
      actions={<Badge tone={st.tone}>{st.label}</Badge>}
    >
      {data.claimed ? (
        <Notice tone="ok">Garantía solicitada el {fmtDay(data.claimed.created_at)}.</Notice>
      ) : (
        <>
          <div className="mb-3">
            <p className="mb-1 text-sm text-mute">
              Día {Math.min(data.day, 90)} de 90{data.daysLeft > 0 ? ` · quedan ${data.daysLeft} días` : ""}
            </p>
            <Progress value={Math.min(100, Math.round((data.day / 90) * 100))} />
          </div>
          <ul className="space-y-2 text-sm">
            {data.requirements.map((r: any) => (
              <li key={r.key} className="flex items-start gap-2">
                {r.met ? <CheckCircle2 aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-ok" /> : <Circle aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-mute" />}
                <span>
                  <span className="font-medium">{r.label}</span>
                  <span className="block text-xs text-mute">{r.detail}</span>
                </span>
                <span className="sr-only">{r.met ? "cumplido" : "pendiente"}</span>
              </li>
            ))}
          </ul>
          <dl className="mt-4 grid gap-3 text-sm sm:grid-cols-2">
            <div>
              <dt className="text-mute">Impresiones, 28 días antes del alta</dt>
              <dd className="font-serif text-2xl tabular-nums">{fmtN(data.baselineImpressions)}</dd>
            </div>
            <div>
              <dt className="text-mute">Impresiones, últimos 28 días</dt>
              <dd className="font-serif text-2xl tabular-nums">
                {fmtN(data.currentImpressions)}
                {data.changePct !== null && <span className="ml-2 font-sans text-sm text-mute">({data.changePct > 0 ? "+" : ""}{String(data.changePct).replace(".", ",")} %)</span>}
              </dd>
            </div>
          </dl>
          <p className="mt-2 text-xs text-mute">Fuente: {data.source}. Medición observada; Google no garantiza posiciones.</p>
          {data.status === "refund_available" && canManage && (
            <Button className="mt-4" variant="primary" loading={busy} onClick={claim}>
              Solicitar el reembolso de la garantía
            </Button>
          )}
        </>
      )}
      {done && <Notice tone="ok">{done}</Notice>}
      <ErrorState error={err} />
    </Card>
  );
}
