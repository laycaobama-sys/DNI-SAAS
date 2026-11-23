import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { Link, Navigate, useNavigate, useSearchParams } from "react-router";
import { MailCheck } from "lucide-react";
import { api, ApiError, post } from "../lib/api";
import { useAuth } from "../lib/auth";
import { Logo } from "../shell";
import { rememberWantedPlan, wantedPlan } from "./billing";
import { pendingAudit, rememberPendingAudit } from "../lib/pending-audit";
import { Button, ErrorState, LegalLinks, Notice, TextField } from "../ui";

function AuthLayout({ title, subtitle, children, footer }: { title: string; subtitle?: ReactNode; children: ReactNode; footer?: ReactNode }) {
  return (
    <div className="relative grid min-h-full place-items-center overflow-hidden px-4 py-12">
      <div aria-hidden className="pointer-events-none absolute -top-40 left-1/2 h-[520px] w-[820px] -translate-x-1/2 rounded-full bg-[radial-gradient(circle,rgba(122,44,255,.35),transparent_60%)] blur-3xl" />
      <div className="relative w-full max-w-md">
        <a href="/" className="mb-8 inline-block" aria-label="DNI Growth, inicio">
          <Logo />
        </a>
        <div className="rounded-3xl border border-line bg-surface p-6 shadow-sm sm:p-8">
          <h1 className="font-serif text-4xl leading-none">{title}</h1>
          {subtitle && <p className="mt-2 text-sm text-mute">{subtitle}</p>}
          <div className="mt-6">{children}</div>
        </div>
        {footer && <div className="mt-4 text-center text-sm text-mute">{footer}</div>}
        <LegalLinks className="mt-6 justify-center" />
      </div>
    </div>
  );
}

type AuthOptions = { google: boolean; emailDelivery: "enabled" | "dev_mailbox" | "not_configured" };
let optionsCache: Promise<AuthOptions> | null = null;
function useAuthOptions() {
  const [opts, setOpts] = useState<AuthOptions | null>(null);
  useEffect(() => {
    let alive = true;
    (optionsCache ??= api<AuthOptions>("/auth/options").catch(() => ({ google: false, emailDelivery: "enabled" as const })))
      .then((o) => alive && setOpts(o));
    return () => {
      alive = false;
    };
  }, []);
  return opts;
}

const OAUTH_ERRORS: Record<string, string> = {
  google_denied: "Has cancelado el acceso con Google.",
  google_not_configured: "El acceso con Google todavía no está activado.",
  email_not_verified_by_google: "Tu cuenta de Google no tiene el correo verificado.",
  state_mismatch: "La sesión de acceso con Google ha caducado o no es válida. Inténtalo de nuevo.",
  state_expired: "La sesión de acceso con Google ha caducado. Inténtalo de nuevo.",
};

function GoogleButton({ next, label }: { next?: string | null; label: string }) {
  const target = next && next.startsWith("/") && !next.startsWith("//") ? `/app${next}` : "/app/";
  return (
    <a
      href={`/api/v1/auth/google/start?next=${encodeURIComponent(target)}`}
      className="inline-flex min-h-11 w-full items-center justify-center gap-3 rounded-full border border-line bg-white px-4 text-sm font-semibold text-[#1f1f1f] transition hover:bg-[#f2f2f2] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
    >
      <svg aria-hidden viewBox="0 0 48 48" className="size-5">
        <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z" />
        <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z" />
        <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z" />
        <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z" />
      </svg>
      {label}
    </a>
  );
}

function OrDivider() {
  return (
    <div className="my-5 flex items-center gap-3 text-xs uppercase tracking-wider text-mute" role="separator">
      <span className="h-px flex-1 bg-line" />o con tu email<span className="h-px flex-1 bg-line" />
    </div>
  );
}

function useSubmit() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    setFieldErrors({});
    try {
      await fn();
    } catch (e) {
      const err = e instanceof ApiError ? e : new ApiError(0, "error", "Error inesperado");
      const fe: Record<string, string> = {};
      for (const x of (err.data.errors as Array<{ path: string; message: string }> | undefined) ?? []) fe[x.path] = x.message;
      setFieldErrors(fe);
      setError(err);
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, fieldErrors, run };
}

export function LoginPage() {
  const { me, refresh } = useAuth();
  const nav = useNavigate();
  const [params] = useSearchParams();
  const { busy, error, run } = useSubmit();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const opts = useAuthOptions();
  const oauthError = params.get("oauth_error");
  if (me?.user) return <Navigate to={params.get("next") ?? "/"} replace />;
  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => {
      await post("/auth/login", { email, password });
      await refresh();
      nav(params.get("next") ?? "/", { replace: true });
    });
  };
  return (
    <AuthLayout title="Bienvenido" subtitle="Entra en tu cuenta de DNI Growth." footer={<>¿No tienes cuenta? <Link className="text-accent-text hover:underline" to="/register">Crea una gratis</Link></>}>
      {oauthError && (
        <div className="mb-4">
          <Notice tone="warn">{OAUTH_ERRORS[oauthError] ?? "No hemos podido completar el acceso con Google. Inténtalo de nuevo."}</Notice>
        </div>
      )}
      {opts?.google && (
        <>
          <GoogleButton next={params.get("next")} label="Continuar con Google" />
          <OrDivider />
        </>
      )}
      <form onSubmit={onSubmit} className="space-y-4" noValidate>
        <TextField label="Email" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
        <TextField label="Contraseña" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
        <ErrorState error={error} />
        {error?.code === "email_not_verified" && <ResendLink email={email} />}
        <Button variant="primary" type="submit" loading={busy} className="w-full">
          Entrar
        </Button>
        <p className="text-center text-sm">
          <Link className="text-mute hover:text-ink hover:underline" to="/forgot">
            ¿Has olvidado tu contraseña?
          </Link>
        </p>
      </form>
    </AuthLayout>
  );
}

function ResendLink({ email }: { email: string }) {
  const [sent, setSent] = useState(false);
  return sent ? (
    <Notice tone="ok">Si la cuenta existe y no está verificada, te hemos enviado otro enlace.</Notice>
  ) : (
    <button type="button" className="text-sm text-accent-text hover:underline" onClick={() => post("/auth/resend-verification", { email }).finally(() => setSent(true))}>
      Reenviar email de verificación
    </button>
  );
}

export function RegisterPage() {
  const { busy, error, fieldErrors, run } = useSubmit();
  const [regParams] = useSearchParams();
  const planParam = regParams.get("plan");
  const auditParam = regParams.get("audit");
  useEffect(() => {
    rememberWantedPlan(planParam);
    rememberPendingAudit(auditParam);
  }, [planParam, auditParam]);
  const hasAudit = !!auditParam || !!pendingAudit();
  const wanted = wantedPlan();
  const [form, setForm] = useState({ name: "", email: "", password: "" });
  const [done, setDone] = useState<null | "sent" | "not_configured">(null);
  const opts = useAuthOptions();
  const pendingUrl = (() => {
    try {
      return sessionStorage.getItem("dni.pendingUrl");
    } catch {
      return null;
    }
  })();
  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    void run(async () => {
      const r = await post<{ delivery: "sent" | "not_configured" }>("/auth/register", form);
      setDone(r.delivery);
    });
  };
  if (done)
    return (
      <AuthLayout title="Revisa tu correo" subtitle={`Si ${form.email} es válido, te hemos enviado un enlace para verificar tu cuenta.`}>
        <div className="flex flex-col items-center gap-4 text-center">
          <MailCheck className="size-10 text-accent-text" aria-hidden />
          {done === "not_configured" && (
            <Notice tone="warn" title="Envío de correo no configurado en este entorno">
              Todavía no podemos enviar correos desde DNI Growth, así que no te hemos enviado nada.{opts?.google ? " Puedes entrar ya con tu cuenta de Google." : ""}
            </Notice>
          )}
          <Link className="text-sm text-accent-text hover:underline" to="/login">
            Ir a iniciar sesión
          </Link>
        </div>
      </AuthLayout>
    );
  return (
    <AuthLayout
      title="Crea tu cuenta"
      subtitle={hasAudit ? "Gratis y sin tarjeta. Al entrar verás el informe completo de tu web y tu plan de 30 días." : pendingUrl ? `Después analizaremos ${pendingUrl}.` : wanted ? `La cuenta es gratis. Después podrás activar ${wanted.name} desde Facturación.` : "Audita tu web gratis. Sin tarjeta."}
      footer={<>¿Ya tienes cuenta? <Link className="text-accent-text hover:underline" to="/login">Entrar</Link></>}
    >
      {opts?.google && (
        <>
          <GoogleButton next={null} label="Registrarte con Google" />
          <OrDivider />
        </>
      )}
      {opts?.emailDelivery === "not_configured" && (
        <div className="mb-4">
          <Notice tone="warn" title="Registro por email en pausa">
            El envío de correos de verificación aún no está activo.{opts.google ? " Usa «Registrarte con Google» para entrar ahora." : " Vuelve pronto."}
          </Notice>
        </div>
      )}
      <form onSubmit={onSubmit} className="space-y-4" noValidate>
        <TextField label="Nombre" autoComplete="name" required value={form.name} error={fieldErrors.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        <TextField label="Email" type="email" autoComplete="email" required value={form.email} error={fieldErrors.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
        <TextField label="Contraseña" type="password" autoComplete="new-password" required minLength={12} hint="Mínimo 12 caracteres, con letras y números." error={fieldErrors.password} value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} />
        {error && !Object.keys(fieldErrors).length && <ErrorState error={error} />}
        <Button variant="primary" type="submit" loading={busy} className="w-full">
          Crear cuenta
        </Button>
        <p className="text-xs text-mute">
          Al crear la cuenta aceptas las <a className="underline" href="/legal/condiciones">condiciones de uso</a>. Cómo tratamos tus datos: <a className="underline" href="/legal/privacidad">política de privacidad</a>.
        </p>
      </form>
    </AuthLayout>
  );
}

export function VerifyPage() {
  const [params] = useSearchParams();
  const [state, setState] = useState<"loading" | "ok" | ApiError>("loading");
  const sent = useRef(false);
  useEffect(() => {
    // Tokens are single-use: never submit twice (StrictMode, re-renders).
    if (sent.current) return;
    sent.current = true;
    const token = params.get("token") ?? "";
    post("/auth/verify-email", { token })
      .then(() => setState("ok"))
      .catch((e) => setState(e instanceof ApiError ? e : new ApiError(0, "error", "Error")));
  }, [params]);
  return (
    <AuthLayout title="Verificación de email">
      {state === "loading" && <p className="text-sm text-mute">Verificando…</p>}
      {state === "ok" && (
        <div className="space-y-4">
          <Notice tone="ok">Tu correo está verificado.</Notice>
          <Link to="/login" className="inline-flex min-h-10 w-full items-center justify-center rounded-full bg-accent px-4 text-sm font-semibold text-accent-ink">
            Iniciar sesión
          </Link>
        </div>
      )}
      {state instanceof ApiError && <ErrorState error={state} />}
    </AuthLayout>
  );
}

export function ForgotPage() {
  const { busy, error, run } = useSubmit();
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  return (
    <AuthLayout title="Recupera tu acceso" subtitle="Te enviaremos un enlace para elegir una nueva contraseña." footer={<Link className="hover:underline" to="/login">Volver</Link>}>
      {sent ? (
        <Notice tone="ok">Si existe una cuenta con ese email, recibirás un enlace válido durante 1 hora.</Notice>
      ) : (
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            void run(async () => {
              await post("/auth/password-reset/request", { email });
              setSent(true);
            });
          }}
        >
          <TextField label="Email" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
          <ErrorState error={error} />
          <Button variant="primary" type="submit" loading={busy} className="w-full">
            Enviar enlace
          </Button>
        </form>
      )}
    </AuthLayout>
  );
}

export function ResetPage() {
  const [params] = useSearchParams();
  const { busy, error, fieldErrors, run } = useSubmit();
  const [password, setPassword] = useState("");
  const [ok, setOk] = useState(false);
  return (
    <AuthLayout title="Nueva contraseña">
      {ok ? (
        <div className="space-y-4">
          <Notice tone="ok">Contraseña actualizada. Hemos cerrado tus otras sesiones por seguridad.</Notice>
          <Link to="/login" className="text-sm text-accent-text hover:underline">
            Iniciar sesión
          </Link>
        </div>
      ) : (
        <form
          className="space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            void run(async () => {
              await post("/auth/password-reset/confirm", { token: params.get("token") ?? "", password });
              setOk(true);
            });
          }}
        >
          <TextField label="Nueva contraseña" type="password" autoComplete="new-password" required minLength={12} error={fieldErrors.password} value={password} onChange={(e) => setPassword(e.target.value)} />
          {error && !fieldErrors.password && <ErrorState error={error} />}
          <Button variant="primary" type="submit" loading={busy} className="w-full">
            Guardar
          </Button>
        </form>
      )}
    </AuthLayout>
  );
}

export function InvitePage() {
  const [params] = useSearchParams();
  const { me, refresh } = useAuth();
  const nav = useNavigate();
  const { busy, error, run } = useSubmit();
  const token = params.get("token") ?? "";
  if (!me?.user) return <Navigate to={`/login?next=${encodeURIComponent(`/invite?token=${token}`)}`} replace />;
  return (
    <AuthLayout title="Invitación" subtitle={`Vas a unirte a una organización como ${me.user.email}.`}>
      <ErrorState error={error} />
      <Button
        variant="primary"
        className="mt-4 w-full"
        loading={busy}
        onClick={() =>
          run(async () => {
            const r = await post<{ organizationId: string }>("/invitations/accept", { token });
            await refresh();
            nav(`/o/${r.organizationId}`);
          })
        }
      >
        Aceptar invitación
      </Button>
    </AuthLayout>
  );
}
