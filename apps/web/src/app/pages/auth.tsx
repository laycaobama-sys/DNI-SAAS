import { useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { Link, Navigate, useNavigate, useSearchParams } from "react-router";
import { MailCheck } from "lucide-react";
import { ApiError, post } from "../lib/api";
import { useAuth } from "../lib/auth";
import { Logo } from "../shell";
import { Button, ErrorState, Notice, TextField } from "../ui";

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
      </div>
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
  const [form, setForm] = useState({ name: "", email: "", password: "" });
  const [done, setDone] = useState<null | "sent" | "not_configured">(null);
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
              El administrador debe activar el proveedor de email o verificar tu cuenta manualmente. No te hemos enviado nada.
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
      subtitle={pendingUrl ? `Después analizaremos ${pendingUrl}.` : "Audita tu web gratis. Sin tarjeta."}
      footer={<>¿Ya tienes cuenta? <Link className="text-accent-text hover:underline" to="/login">Entrar</Link></>}
    >
      <form onSubmit={onSubmit} className="space-y-4" noValidate>
        <TextField label="Nombre" autoComplete="name" required value={form.name} error={fieldErrors.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        <TextField label="Email" type="email" autoComplete="email" required value={form.email} error={fieldErrors.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
        <TextField label="Contraseña" type="password" autoComplete="new-password" required minLength={12} hint="Mínimo 12 caracteres, con letras y números." error={fieldErrors.password} value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} />
        {error && !Object.keys(fieldErrors).length && <ErrorState error={error} />}
        <Button variant="primary" type="submit" loading={busy} className="w-full">
          Crear cuenta
        </Button>
        <p className="text-xs text-mute">
          Al registrarte aceptas el tratamiento descrito en la <a className="underline" href="/legal/privacidad">política de privacidad</a>.
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
