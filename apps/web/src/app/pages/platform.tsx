import { createContext, useCallback, useContext, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import qrcode from "qrcode-generator";
import { AlertTriangle, Building2, Copy, KeyRound, Lock, LockOpen, PauseCircle, PlayCircle, RotateCcw, ShieldCheck, Trash2, X } from "lucide-react";
import { PLAN_LABEL, isPlanCode } from "@dni/core/plan-access";
import { ApiError, del, fmtDate, post, put, timeAgo } from "../lib/api";
import { useAuth } from "../lib/auth";
import { useApi } from "../lib/hooks";
import { Badge, Button, Card, ErrorState, Input, Notice, Skeleton, cx } from "../ui";

const planName = (c: string) => (isPlanCode(c) ? PLAN_LABEL[c] : c);
const asApiError = (e: unknown, fallback: string) => (e instanceof ApiError ? e : new ApiError(0, "error", fallback));

// ── Owner binding and second factor ──────────────────────────────────────────────────────────────

function Qr({ text }: { text: string }) {
  const svg = useMemo(() => {
    const q = qrcode(0, "M");
    q.addData(text);
    q.make();
    return q.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
  }, [text]);
  // Locally generated SVG from our own otpauth URI (no third-party content); white plate for scanners.
  return <div className="mx-auto w-52 rounded-xl bg-white p-2 [&_svg]:h-auto [&_svg]:w-full" aria-label="Código QR para tu app de autenticación" role="img" dangerouslySetInnerHTML={{ __html: svg }} />;
}

function CodeInput({ value, onChange, label = "Código de 6 cifras", recovery }: { value: string; onChange: (v: string) => void; label?: string; recovery?: boolean }) {
  return (
    <label className="block text-sm">
      <span className="mb-1 block font-medium">{label}</span>
      <Input
        value={value}
        onChange={(e) => onChange(recovery ? e.target.value.toUpperCase() : e.target.value.replace(/\D/g, "").slice(0, 6))}
        inputMode={recovery ? "text" : "numeric"}
        autoComplete="one-time-code"
        autoFocus
        placeholder={recovery ? "XXXX-XXXX-XXXX" : "000000"}
        className="text-center font-mono text-2xl tracking-[0.3em]"
        maxLength={recovery ? 20 : 6}
      />
    </label>
  );
}

/**
 * Entry to the Control Center for platform staff: claim with a one-time code (created by the owner
 * from her own terminal), TOTP enrolment with recovery codes shown once, then a 6-digit code per session.
 */
export function PlatformGate() {
  const { me, refresh } = useAuth();
  const p = me?.platform;
  const [step, setStep] = useState<"claim" | "scan" | "codes">("claim");
  const [claimCode, setClaimCode] = useState("");
  const [enrol, setEnrol] = useState<{ otpauthUri: string; secret: string } | null>(null);
  const [code, setCode] = useState("");
  const [recovery, setRecovery] = useState<string[] | null>(null);
  const [useRecovery, setUseRecovery] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<ApiError | null>(null);
  const enrolled = !!p?.member && !!p.role && !p.legacy && p.claimed;

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setErr(null);
    try {
      await fn();
    } catch (e) {
      setErr(asApiError(e, "No se pudo completar."));
    } finally {
      setBusy(false);
    }
  };
  const claim = (e: FormEvent) => (e.preventDefault(), run(async () => {
    const r = await post<{ otpauthUri: string; secret: string }>("/platform/claim", { code: claimCode.trim().toUpperCase() });
    setEnrol(r);
    setStep("scan");
  }));
  const confirm = (e: FormEvent) => (e.preventDefault(), run(async () => {
    const r = await post<{ recoveryCodes: string[] }>("/platform/mfa/confirm", { code });
    setRecovery(r.recoveryCodes);
    setStep("codes");
  }));
  const verify = (e: FormEvent) => (e.preventDefault(), run(async () => {
    await post("/platform/mfa/verify", { code: code.trim() });
    await refresh();
  }));

  return (
    <div className="mx-auto max-w-lg py-6">
      <div className="rounded-3xl border border-line bg-surface p-6 sm:p-8">
        <div className="mb-5 flex items-center gap-3">
          <span className="grid size-11 place-items-center rounded-2xl bg-accent/15 text-accent-text">
            <ShieldCheck className="size-6" aria-hidden />
          </span>
          <div>
            <p className="text-xs font-semibold uppercase tracking-[0.14em] text-accent-text">Control Center</p>
            <h1 className="font-serif text-3xl leading-none">{enrolled ? "Desbloquea tu sesión" : "Vincula tu cuenta de propietaria"}</h1>
          </div>
        </div>

        {enrolled && !recovery ? (
          <form onSubmit={verify} className="space-y-4">
            <p className="text-sm text-mute">Abre tu app de autenticación (Google Authenticator, Microsoft Authenticator, 1Password…) e introduce el código de «DNI Growth». La sesión queda desbloqueada 12 horas en este dispositivo.</p>
            <CodeInput value={code} onChange={setCode} recovery={useRecovery} label={useRecovery ? "Código de recuperación" : undefined} />
            <ErrorState error={err} />
            <Button type="submit" variant="primary" className="w-full" loading={busy} disabled={useRecovery ? code.length < 12 : code.length !== 6}>
              <LockOpen className="size-4" aria-hidden /> Entrar
            </Button>
            <button type="button" className="w-full text-center text-xs text-mute underline-offset-2 hover:underline" onClick={() => (setUseRecovery((v) => !v), setCode(""))}>
              {useRecovery ? "Usar el código de la app" : "He perdido el móvil: usar un código de recuperación"}
            </button>
          </form>
        ) : step === "claim" ? (
          <form onSubmit={claim} className="space-y-4">
            <ol className="list-decimal space-y-1.5 pl-5 text-sm text-mute">
              <li>
                En tu ordenador, dentro de la carpeta del proyecto, ejecuta <code className="rounded bg-surface-2 px-1.5 py-0.5 text-ink">node scripts/platform-claim.mjs</code> (usa tu sesión de Cloudflare).
              </li>
              <li>Copia el código que aparece en TU terminal (caduca en 30 minutos y solo sirve una vez).</li>
              <li>Pégalo aquí. Nunca lo compartas en un chat ni por correo.</li>
            </ol>
            <label className="block text-sm">
              <span className="mb-1 block font-medium">Código de vinculación</span>
              <Input value={claimCode} onChange={(e) => setClaimCode(e.target.value)} placeholder="XXXXX-XXXXX-XXXXX-XXXXX" autoComplete="off" spellCheck={false} className="font-mono uppercase tracking-wider" />
            </label>
            <ErrorState error={err} />
            <Button type="submit" variant="primary" className="w-full" loading={busy} disabled={claimCode.trim().length < 10}>
              <KeyRound className="size-4" aria-hidden /> Vincular
            </Button>
            {p?.legacy && <Notice tone="warn">Ahora entras como administradora provisional. Hasta que vincules tu cuenta y actives el segundo factor, las acciones críticas (suspender, borrar, cambiar planes o límites) están bloqueadas.</Notice>}
          </form>
        ) : step === "scan" && enrol ? (
          <form onSubmit={confirm} className="space-y-4">
            <p className="text-sm text-mute">Escanea este código con tu app de autenticación. Si no puedes escanearlo, añade la cuenta a mano con la clave de abajo.</p>
            <Qr text={enrol.otpauthUri} />
            <details className="rounded-xl border border-line px-3 py-2 text-xs">
              <summary className="cursor-pointer text-mute">Mostrar la clave para introducirla a mano</summary>
              <p className="mt-2 break-all font-mono text-sm text-ink">{enrol.secret.match(/.{1,4}/g)?.join(" ")}</p>
            </details>
            <CodeInput value={code} onChange={setCode} />
            <ErrorState error={err} />
            <Button type="submit" variant="primary" className="w-full" loading={busy} disabled={code.length !== 6}>
              Activar segundo factor
            </Button>
          </form>
        ) : (
          <RecoveryCodes codes={recovery ?? []} onDone={() => void refresh()} />
        )}
      </div>
      <p className="mt-4 text-center text-xs text-mute">Todo intento queda registrado. El acceso no depende de tu correo: solo de tu cuenta vinculada y de tu app de autenticación.</p>
    </div>
  );
}

function RecoveryCodes({ codes, onDone }: { codes: string[]; onDone: () => void }) {
  const [saved, setSaved] = useState(false);
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(codes.join("\n"));
      setCopied(true);
    } catch {
      /* clipboard blocked: the codes stay visible to write them down */
    }
  };
  return (
    <div className="space-y-4">
      <Notice tone="warn" title="Guarda estos 10 códigos de recuperación">
        Solo se muestran ahora. Cada uno sirve una vez si pierdes el móvil. Guárdalos en tu gestor de contraseñas o en papel, nunca en un chat.
      </Notice>
      <ul className="grid grid-cols-2 gap-2 rounded-xl bg-surface-2 p-3 font-mono text-sm">
        {codes.map((c) => (
          <li key={c} className="text-center">
            {c}
          </li>
        ))}
      </ul>
      <Button onClick={copy} className="w-full">
        <Copy className="size-4" aria-hidden /> {copied ? "Copiados" : "Copiar"}
      </Button>
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" className="size-4 accent-[var(--accent)]" checked={saved} onChange={(e) => setSaved(e.target.checked)} /> Los he guardado en un lugar seguro
      </label>
      <Button variant="primary" className="w-full" disabled={!saved} onClick={onDone}>
        Entrar al Control Center
      </Button>
    </div>
  );
}

// ── Step-up: critical actions ask for a fresh code, then retry ──────────────────────────────────────

type Runner = <T>(fn: () => Promise<T>) => Promise<T>;
const StepUpCtx = createContext<Runner>((fn) => fn());
export const useStepUp = () => useContext(StepUpCtx);

export function StepUpProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const [legacy, setLegacy] = useState(false);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<ApiError | null>(null);
  const pending = useRef<{ resolve: () => void; reject: (e: unknown) => void } | null>(null);

  const run: Runner = useCallback(async (fn) => {
    try {
      return await fn();
    } catch (e) {
      if (!(e instanceof ApiError) || (e.code !== "step_up_required" && e.code !== "platform_claim_required")) throw e;
      setLegacy(e.code === "platform_claim_required");
      setCode("");
      setErr(null);
      setOpen(true);
      await new Promise<void>((resolve, reject) => (pending.current = { resolve, reject }));
      return fn();
    }
  }, []);

  const submit = async (ev: FormEvent) => {
    ev.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      await post("/platform/mfa/verify", { code });
      setOpen(false);
      pending.current?.resolve();
    } catch (e) {
      setErr(asApiError(e, "Código incorrecto."));
    } finally {
      setBusy(false);
    }
  };
  const cancel = () => {
    setOpen(false);
    pending.current?.reject(new ApiError(401, "step_up_cancelled", "Acción cancelada: no se ha cambiado nada."));
  };

  return (
    <StepUpCtx.Provider value={run}>
      {children}
      {open && (
        <div className="fixed inset-0 z-50 grid place-items-center bg-black/60 p-4" role="dialog" aria-modal="true" aria-labelledby="stepup-title">
          <div className="w-full max-w-sm rounded-3xl border border-line bg-surface p-6">
            <div className="mb-4 flex items-start justify-between gap-3">
              <h2 id="stepup-title" className="font-serif text-2xl leading-tight">
                {legacy ? "Primero vincula tu cuenta" : "Confirma que eres tú"}
              </h2>
              <button onClick={cancel} className="rounded-lg p-1.5 text-mute hover:bg-surface-2" aria-label="Cancelar">
                <X className="size-4" />
              </button>
            </div>
            {legacy ? (
              <div className="space-y-4 text-sm text-mute">
                <p>Las acciones críticas solo están disponibles para la propietaria vinculada con segundo factor. Vincula tu cuenta desde «Seguridad» en este panel.</p>
                <Button className="w-full" onClick={cancel}>
                  Entendido
                </Button>
              </div>
            ) : (
              <form onSubmit={submit} className="space-y-4">
                <p className="text-sm text-mute">Es una acción crítica: introduce el código actual de tu app de autenticación.</p>
                <CodeInput value={code} onChange={setCode} />
                <ErrorState error={err} />
                <Button type="submit" variant="primary" className="w-full" loading={busy} disabled={code.length !== 6}>
                  Confirmar y continuar
                </Button>
              </form>
            )}
          </div>
        </div>
      )}
    </StepUpCtx.Provider>
  );
}

// ── Organisation drawer: lifecycle, limits, credits, support ────────────────────────────────────────

const LIMIT_FIELDS = [
  { key: "ai_daily", label: "Consultas de IA del equipo / día" },
  { key: "ai_user_daily", label: "Consultas de IA por persona / día" },
  { key: "ai_images_daily", label: "Imágenes / día" },
] as const;

export function OrgDrawer({ orgId, onClose, onChanged }: { orgId: string; onClose: () => void; onChanged: () => void }) {
  const { data, error, reload } = useApi<any>(`/admin/organizations/${orgId}`);
  const stepUp = useStepUp();
  const { refresh } = useAuth();
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<ApiError | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [confirmName, setConfirmName] = useState("");
  const [limits, setLimits] = useState<Record<string, string>>({});
  const [credits, setCredits] = useState("");

  const act = async (key: string, fn: () => Promise<unknown>, done: string) => {
    setBusy(key);
    setErr(null);
    setOk(null);
    try {
      await stepUp(fn);
      setOk(done);
      setReason("");
      setConfirmName("");
      await reload();
      onChanged();
    } catch (e) {
      if (!(e instanceof ApiError && e.code === "step_up_cancelled")) setErr(asApiError(e, "No se pudo completar."));
    } finally {
      setBusy(null);
    }
  };
  const o = data?.organization;
  const needReason = reason.trim().length < 3;
  const base = `/admin/organizations/${orgId}`;

  return (
    <div className="fixed inset-0 z-40" role="dialog" aria-modal="true" aria-label="Gestionar organización">
      <div className="absolute inset-0 bg-black/50" onClick={onClose} aria-hidden />
      <aside className="absolute inset-y-0 right-0 flex h-dvh w-full max-w-xl flex-col border-l border-line bg-bg">
        <header className="flex items-center gap-3 border-b border-line px-5 py-4">
          <Building2 className="size-5 text-mute" aria-hidden />
          <div className="min-w-0 flex-1">
            <p className="truncate font-semibold">{o?.name ?? "Organización"}</p>
            {o && (
              <p className="text-xs text-mute">
                {planName(o.plan_code)} · creada {fmtDate(o.created_at)}
              </p>
            )}
          </div>
          <button onClick={onClose} className="rounded-lg p-2 text-mute hover:bg-surface-2" aria-label="Cerrar">
            <X className="size-5" />
          </button>
        </header>
        <div className="flex-1 space-y-4 overflow-y-auto overscroll-contain p-5 pb-[max(1.25rem,env(safe-area-inset-bottom))]">
          <ErrorState error={error} onRetry={reload} />
          {!data ? (
            <Skeleton className="h-64 rounded-2xl" />
          ) : (
            <>
              <div className="flex flex-wrap gap-2">
                {o.deleted_at ? <Badge tone="danger">Eliminada · restaurable hasta {fmtDate(o.purge_after)}</Badge> : o.status === "suspended" ? <Badge tone="warn">Suspendida</Badge> : <Badge tone="ok">Activa</Badge>}
                {data.subscription && <Badge tone="info">{data.subscription.provider === "stripe" ? "Stripe" : "Interna"} · {data.subscription.status}</Badge>}
                <Badge>{data.creditsBalance} créditos</Badge>
              </div>
              {err && <ErrorState error={err} />}
              {ok && <Notice tone="ok">{ok}</Notice>}

              <Card title="Equipo" subtitle="Correos enmascarados: el contenido del cliente nunca se muestra aquí.">
                <ul className="divide-y divide-line text-sm">
                  {data.members.map((m: any) => (
                    <li key={m.userId} className="flex items-center justify-between gap-3 py-2">
                      <span className="min-w-0 truncate">{m.email}</span>
                      <span className="shrink-0 text-xs text-mute">
                        {m.role} · {m.lastSeen ? timeAgo(m.lastSeen) : "sin conexión"}
                      </span>
                    </li>
                  ))}
                </ul>
                <dl className="mt-3 grid grid-cols-3 gap-2 text-xs">
                  <div className="rounded-xl bg-surface-2 px-3 py-2"><dt className="text-mute">Marcas</dt><dd className="font-medium">{data.counts.brands}</dd></div>
                  <div className="rounded-xl bg-surface-2 px-3 py-2"><dt className="text-mute">Contactos</dt><dd className="font-medium">{data.counts.leads}</dd></div>
                  <div className="rounded-xl bg-surface-2 px-3 py-2"><dt className="text-mute">IA hoy</dt><dd className="font-medium">{data.aiToday ? `${data.aiToday.org}/${data.aiToday.orgLimit}` : "—"}</dd></div>
                </dl>
              </Card>

              <Card title="Motivo de la acción" subtitle="Obligatorio en cada cambio: queda en el registro de auditoría.">
                <Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Ej.: petición del cliente por correo, impago, abuso…" maxLength={300} />
              </Card>

              <Card title="Estado">
                <div className="flex flex-wrap gap-2">
                  {!o.deleted_at && o.status !== "suspended" && (
                    <Button disabled={needReason} loading={busy === "suspend"} onClick={() => act("suspend", () => post(`${base}/status`, { status: "suspended", reason }), "Organización suspendida. Sus datos se conservan; puedes reactivarla cuando quieras.")}>
                      <PauseCircle className="size-4" aria-hidden /> Suspender
                    </Button>
                  )}
                  {!o.deleted_at && o.status === "suspended" && (
                    <Button variant="primary" disabled={needReason} loading={busy === "reactivate"} onClick={() => act("reactivate", () => post(`${base}/status`, { status: "active", reason }), "Organización reactivada.")}>
                      <PlayCircle className="size-4" aria-hidden /> Reactivar
                    </Button>
                  )}
                  {o.deleted_at && (
                    <Button variant="primary" loading={busy === "restore"} onClick={() => act("restore", () => post(`${base}/restore`, {}), "Organización restaurada con todos sus datos.")}>
                      <RotateCcw className="size-4" aria-hidden /> Restaurar
                    </Button>
                  )}
                </div>
                {!o.deleted_at && (
                  <div className="mt-4 rounded-xl border border-danger/30 p-3">
                    <p className="text-sm font-medium text-danger">Eliminar (se puede deshacer durante 30 días)</p>
                    <p className="mt-1 text-xs text-mute">Nadie podrá entrar y sus páginas públicas se apagan. No se borra nada hasta pasados 30 días. Escribe «{o.name}» para confirmar.</p>
                    <div className="mt-2 flex flex-col gap-2 sm:flex-row">
                      <Input value={confirmName} onChange={(e) => setConfirmName(e.target.value)} placeholder={o.name} aria-label="Nombre de la organización" />
                      <Button variant="danger" disabled={needReason || confirmName.trim() !== o.name.trim()} loading={busy === "delete"} onClick={() => act("delete", () => post(`${base}/delete`, { confirmName, reason }), "Organización eliminada. Puedes restaurarla durante 30 días.")}>
                        <Trash2 className="size-4" aria-hidden /> Eliminar
                      </Button>
                    </div>
                  </div>
                )}
              </Card>

              <Card title="Topes de IA" subtitle={`Plan ${planName(o.plan_code)}: deja en blanco para usar el del plan; 0 bloquea.`}>
                <div className="grid gap-2 sm:grid-cols-3">
                  {LIMIT_FIELDS.map((f) => {
                    const cur = data.overrides.find((x: any) => x.limit_key === f.key);
                    return (
                      <label key={f.key} className="text-xs">
                        <span className="mb-1 block text-mute">{f.label}</span>
                        <Input type="number" min={0} max={100000} inputMode="numeric" value={limits[f.key] ?? (cur ? String(cur.value) : "")} placeholder="Plan" onChange={(e) => setLimits((l) => ({ ...l, [f.key]: e.target.value }))} />
                      </label>
                    );
                  })}
                </div>
                <Button
                  className="mt-3"
                  disabled={needReason || !Object.keys(limits).length}
                  loading={busy === "limits"}
                  onClick={() =>
                    act(
                      "limits",
                      () => put(`${base}/limits`, { ...Object.fromEntries(Object.entries(limits).map(([k, v]) => [k, v.trim() === "" ? null : Math.max(0, Math.round(Number(v)))])), reason }).then(() => setLimits({})),
                      "Topes guardados. Se aplican desde la próxima consulta.",
                    )
                  }
                >
                  Guardar topes
                </Button>
              </Card>

              <Card title="Créditos internos" subtitle="Ajuste sin cobro (compensaciones, pruebas). Nunca deja el saldo en negativo.">
                <div className="flex flex-col gap-2 sm:flex-row">
                  <Input type="number" inputMode="numeric" value={credits} onChange={(e) => setCredits(e.target.value)} placeholder="Ej.: 50 o -20" aria-label="Créditos a sumar o restar" />
                  <Button
                    disabled={needReason || !Number(credits)}
                    loading={busy === "credits"}
                    onClick={() => act("credits", () => post(`${base}/credits`, { amount: Math.round(Number(credits)), reason, idempotencyKey: `ui-${crypto.randomUUID()}` }).then(() => setCredits("")), "Créditos ajustados.")}
                  >
                    Aplicar
                  </Button>
                </div>
              </Card>

              <Card title="Acceso de soporte" subtitle="Solo lectura, temporal y visible en la auditoría del cliente.">
                <div className="flex flex-wrap gap-2">
                  <Button
                    disabled={needReason || !!o.deleted_at}
                    loading={busy === "support"}
                    onClick={() =>
                      act("support", () => post(`${base}/support`, { reason, hours: 2 }), "Acceso de soporte activo durante 2 horas.").then(() => refresh())
                    }
                  >
                    <ShieldCheck className="size-4" aria-hidden /> Abrir 2 horas
                  </Button>
                </div>
                {data.supportGrants.length > 0 && (
                  <ul className="mt-3 divide-y divide-line text-xs">
                    {data.supportGrants.map((g: any) => (
                      <li key={g.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
                        <span className="min-w-0 flex-1">
                          {g.reason} <span className="text-mute">· {fmtDate(g.created_at)}</span>
                        </span>
                        {g.active ? (
                          <span className="flex items-center gap-2">
                            <a className="font-semibold text-accent-text hover:underline" href={`/app/o/${orgId}`}>Entrar</a>
                            <button className="text-danger hover:underline" onClick={() => act("revoke", () => del(`/admin/support/${g.id}`), "Acceso de soporte cerrado.").then(() => refresh())}>
                              Cerrar
                            </button>
                          </span>
                        ) : (
                          <Badge>Cerrado</Badge>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </Card>

              <Card title="Últimas acciones">
                <ol className="space-y-1 text-xs">
                  {data.recentActions.map((a: any, i: number) => (
                    <li key={i} className="flex justify-between gap-3">
                      <span className="truncate">{a.action}</span>
                      <span className="shrink-0 text-mute">{timeAgo(a.created_at)}</span>
                    </li>
                  ))}
                </ol>
              </Card>
            </>
          )}
        </div>
      </aside>
    </div>
  );
}

// ── Security, AI centre, operations and audit tabs ──────────────────────────────────────────────────

export function SecurityTab() {
  const { me, refresh } = useAuth();
  const p = me?.platform;
  const [busy, setBusy] = useState(false);
  if (p?.legacy) return <PlatformGate />;
  return (
    <Card title="Tu acceso de propietaria" subtitle="Cuenta vinculada con segundo factor. Las acciones críticas piden el código de nuevo pasados 15 minutos.">
      <div className="flex flex-wrap items-center gap-3">
        <Badge tone="ok">
          <ShieldCheck className="size-3.5" aria-hidden /> Vinculada · {p?.role === "platform_owner" ? "Propietaria" : p?.role}
        </Badge>
        <Button
          loading={busy}
          onClick={async () => {
            setBusy(true);
            await post("/platform/lock").catch(() => null);
            await refresh();
            setBusy(false);
          }}
        >
          <Lock className="size-4" aria-hidden /> Bloquear ahora
        </Button>
      </div>
    </Card>
  );
}

export function AiCentre() {
  const { data, error, reload } = useApi<any>("/admin/ai/usage");
  const stepUp = useStepUp();
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<ApiError | null>(null);
  const toggle = async () => {
    setBusy(true);
    setErr(null);
    try {
      await stepUp(() => post("/admin/ai/halt", { halted: !data.halt, reason }));
      setReason("");
      await reload();
    } catch (e) {
      if (!(e instanceof ApiError && e.code === "step_up_cancelled")) setErr(asApiError(e, "No se pudo cambiar."));
    } finally {
      setBusy(false);
    }
  };
  if (error) return <ErrorState error={error} onRetry={reload} />;
  if (!data) return <Skeleton className="h-48 rounded-2xl" />;
  // The last 7 UTC days, including the ones with no requests, so the chart never skips a day.
  const byDay = new Map<string, any>(data.days7d.map((d: any) => [d.day, d]));
  const week = Array.from({ length: 7 }, (_, k) => {
    const day = new Date(Date.now() - (6 - k) * 86_400_000).toISOString().slice(0, 10);
    const d = byDay.get(day);
    return { day, n: Number(d?.n ?? 0), failed: Number(d?.failed ?? 0) };
  });
  const maxDay = Math.max(1, ...week.map((d) => d.n));
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card title="Parada global de IA" subtitle="Detiene toda la IA de la plataforma al instante, sin desplegar. No se cobra ningún crédito mientras está parada.">
        {data.halt ? (
          <Notice tone="warn" title="IA detenida">
            {data.halt.reason} · desde {fmtDate(data.halt.at)}
          </Notice>
        ) : (
          <Notice tone="ok">La IA funciona con normalidad.</Notice>
        )}
        <div className="mt-3 flex flex-col gap-2 sm:flex-row">
          <Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Motivo (obligatorio)" aria-label="Motivo" />
          <Button variant={data.halt ? "primary" : "danger"} disabled={reason.trim().length < 3} loading={busy} onClick={toggle}>
            {data.halt ? "Reanudar IA" : "Parar IA"}
          </Button>
        </div>
        {err && <div className="mt-2"><ErrorState error={err} /></div>}
      </Card>
      <Card title="Consultas de IA (7 días)" subtitle={data.source}>
        <div className="flex h-40 gap-1.5" role="img" aria-label={week.map((d) => `${d.day}: ${d.n}`).join(", ")}>
          {week.map((d) => (
            <div key={d.day} className="flex min-w-0 flex-1 flex-col items-center gap-1" title={`${d.day}: ${d.n} consultas (${d.failed} fallidas)`}>
              <span className="text-[11px] tabular-nums text-mute">{d.n || ""}</span>
              <div className="flex w-full flex-1 items-end">
                <div className={cx("w-full rounded-t", d.n ? "bg-accent" : "bg-line")} style={{ height: d.n ? `${Math.max(4, (d.n / maxDay) * 100)}%` : "2px" }} />
              </div>
              <span className="text-[10px] tabular-nums text-mute">{d.day.slice(8)}</span>
            </div>
          ))}
        </div>
      </Card>
      <Card title="Hoy por organización" subtitle="Contador de consultas del día (UTC) frente al plan.">
        {data.today.length === 0 ? (
          <p className="text-sm text-mute">Sin consultas hoy.</p>
        ) : (
          <ul className="divide-y divide-line text-sm">
            {data.today.map((t: any) => (
              <li key={t.id} className="flex items-center justify-between gap-3 py-2">
                <span className="min-w-0 truncate">{t.name}</span>
                <span className="shrink-0 tabular-nums text-mute">
                  {t.today} · {planName(t.plan_code)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>
      <Card title="Motores (7 días)" subtitle="Solo visible para ti. Los clientes ven siempre «IA DNI Growth».">
        <ul className="divide-y divide-line text-sm">
          {data.providers7d.map((p: any, i: number) => (
            <li key={i} className="flex items-center justify-between gap-3 py-2">
              <span>
                {p.provider} <span className="text-xs text-mute">· {p.status}</span>
              </span>
              <span className="tabular-nums text-mute">
                {p.n} · {Number(p.est_usd ?? 0).toFixed(4)} $ · {p.avg_ms ?? "—"} ms
              </span>
            </li>
          ))}
        </ul>
        <p className="mt-2 text-xs text-mute">{data.caveats?.join(" ")}</p>
      </Card>
    </div>
  );
}

const STATE_LABEL: Record<string, string> = { queued: "En cola", validating: "Validando", running: "En curso", completed: "Completado", failed: "Fallido", cancelled: "Cancelado", awaiting_approval: "Pendiente", accepted: "Aceptado", sending: "Enviando", dead: "Descartado", delivered: "Entregado" };

export function OpsTab() {
  const { data, error, reload } = useApi<any>("/admin/ops");
  const stepUp = useStepUp();
  const [err, setErr] = useState<ApiError | null>(null);
  if (error) return <ErrorState error={error} onRetry={reload} />;
  if (!data) return <Skeleton className="h-48 rounded-2xl" />;
  const cancel = async (id: string) => {
    setErr(null);
    try {
      await stepUp(() => post(`/admin/jobs/${id}/cancel`, { reason: "Trabajo atascado cancelado desde Operaciones" }));
      await reload();
    } catch (e) {
      if (!(e instanceof ApiError && e.code === "step_up_cancelled")) setErr(asApiError(e, "No se pudo cancelar."));
    }
  };
  const group = (rows: any[], key: string) => rows.map((r) => (
    <li key={JSON.stringify(r)} className="flex items-center justify-between gap-3 py-1.5 text-sm">
      <span className="min-w-0 truncate">{r.kind ? `${r.kind} · ` : ""}{STATE_LABEL[r[key]] ?? r[key]}</span>
      <span className="tabular-nums text-mute">{r.n}</span>
    </li>
  ));
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      {err && <div className="lg:col-span-2"><ErrorState error={err} /></div>}
      <Card title="Trabajos atascados" subtitle="En cola o en curso desde hace más de 30 minutos.">
        {data.stuckJobs.length === 0 ? (
          <Notice tone="ok">Ninguno.</Notice>
        ) : (
          <ul className="divide-y divide-line">
            {data.stuckJobs.map((j: any) => (
              <li key={j.id} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
                <span className="min-w-0 flex-1 truncate">
                  {j.kind} · {j.organization} <span className="text-xs text-mute">· {timeAgo(j.started_at ?? j.created_at)}</span>
                </span>
                <Button variant="danger" onClick={() => cancel(j.id)}>Cancelar</Button>
              </li>
            ))}
          </ul>
        )}
      </Card>
      <Card title="Trabajos (7 días)"><ul className="divide-y divide-line">{group(data.jobs7d, "state")}</ul></Card>
      <Card title="Fallos recientes">
        {data.failedJobs.length === 0 ? <p className="text-sm text-mute">Sin fallos en 7 días.</p> : (
          <ul className="divide-y divide-line text-sm">
            {data.failedJobs.map((j: any) => (
              <li key={j.id} className="flex items-center justify-between gap-3 py-1.5">
                <span className="min-w-0 truncate">{j.kind} · {j.organization}</span>
                <span className="shrink-0 text-xs text-mute">{j.failure_code ?? "error"} · {timeAgo(j.finished_at)}</span>
              </li>
            ))}
          </ul>
        )}
      </Card>
      <Card title="Correos y webhooks (7 días)">
        <p className="mb-1 text-xs font-medium text-mute">Correos</p>
        <ul className="divide-y divide-line">{group(data.outbox7d, "status")}</ul>
        <p className="mb-1 mt-3 text-xs font-medium text-mute">Webhooks</p>
        <ul className="divide-y divide-line">{group(data.webhooks7d, "status")}</ul>
      </Card>
      <Card title="Base de datos" subtitle="Filas totales (observado).">
        <dl className="grid grid-cols-2 gap-2 text-xs">
          {Object.entries(data.database ?? {}).map(([k, v]) => (
            <div key={k} className="rounded-xl bg-surface-2 px-3 py-2"><dt className="text-mute">{k}</dt><dd className="font-medium tabular-nums">{String(v)}</dd></div>
          ))}
        </dl>
        {data.unavailable?.map((u: any) => (
          <p key={u.key} className="mt-3 flex gap-2 text-xs text-mute"><AlertTriangle className="size-3.5 shrink-0" aria-hidden /> {u.reason}</p>
        ))}
      </Card>
    </div>
  );
}

const AUDIT_LABEL: Record<string, string> = {
  "platform.claimed": "Cuenta de plataforma vinculada",
  "platform.claim_failed": "Intento de vinculación fallido",
  "platform.mfa_enabled": "Segundo factor activado",
  "platform.mfa_verified": "Sesión desbloqueada",
  "platform.mfa_failed": "Código incorrecto",
  "platform.mfa_recovery_used": "Código de recuperación usado",
  "platform.org_suspend": "Organización suspendida",
  "platform.org_reactivate": "Organización reactivada",
  "platform.org_delete": "Organización eliminada",
  "platform.org_restore": "Organización restaurada",
  "platform.org_rename": "Organización renombrada",
  "platform.limits_set": "Topes de IA cambiados",
  "platform.credits_adjust": "Créditos ajustados",
  "platform.support_access_start": "Acceso de soporte abierto",
  "platform.support_access_end": "Acceso de soporte cerrado",
  "platform.ai_halt": "IA detenida",
  "platform.ai_resume": "IA reanudada",
  "platform.job_cancel": "Trabajo cancelado",
  "platform.plan_assign": "Plan interno asignado",
};

export function AuditTab() {
  const [scope, setScope] = useState<"platform" | "all">("platform");
  const { data, error, reload } = useApi<any>(`/admin/audit?scope=${scope}`);
  return (
    <>
      <div className="mb-4 flex gap-2">
        {(["platform", "all"] as const).map((s) => (
          <button key={s} onClick={() => setScope(s)} className={cx("rounded-full border px-3 py-1.5 text-sm", scope === s ? "border-accent bg-accent/10 font-medium" : "border-line text-mute hover:bg-surface-2")}>
            {s === "platform" ? "Acciones de plataforma" : "Todo"}
          </button>
        ))}
      </div>
      <ErrorState error={error} onRetry={reload} />
      {!data ? (
        <Skeleton className="h-64 rounded-2xl" />
      ) : data.items.length === 0 ? (
        <p className="text-sm text-mute">Sin eventos.</p>
      ) : (
        <ol className="relative space-y-3 border-l border-line pl-5">
          {data.items.map((r: any) => (
            <li key={r.id} className="relative">
              <span className="absolute -left-[25px] top-1.5 size-2.5 rounded-full border-2 border-bg bg-accent" aria-hidden />
              <p className="text-sm">
                <span className="font-medium">{AUDIT_LABEL[r.action] ?? r.action}</span>
                {r.organization ? <span className="text-mute"> · {r.organization}</span> : null}
              </p>
              <p className="text-xs text-mute">
                {fmtDate(r.created_at)}
                {r.actor ? ` · ${r.actor}` : ""}
              </p>
            </li>
          ))}
        </ol>
      )}
    </>
  );
}
