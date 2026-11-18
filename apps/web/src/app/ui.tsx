import { useId, useState, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from "react";
import { AlertTriangle, CheckCircle2, Info, Loader2, Lock } from "lucide-react";
import type { ApiError } from "./lib/api";

const cx = (...c: Array<string | false | null | undefined>) => c.filter(Boolean).join(" ");
export { cx };

type BtnVariant = "primary" | "secondary" | "ghost" | "danger";
export function Button({ variant = "secondary", loading, className, children, disabled, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: BtnVariant; loading?: boolean }) {
  return (
    <button
      {...rest}
      disabled={disabled || loading}
      className={cx(
        "inline-flex min-h-10 items-center justify-center gap-2 rounded-full px-4 text-sm font-semibold transition active:translate-y-px disabled:cursor-not-allowed disabled:opacity-50",
        variant === "primary" && "bg-accent text-accent-ink hover:shadow-[0_0_0_5px_color-mix(in_srgb,var(--accent)_22%,transparent)]",
        variant === "secondary" && "border border-line bg-surface text-ink hover:bg-surface-2",
        variant === "ghost" && "text-mute hover:bg-surface-2 hover:text-ink",
        variant === "danger" && "border border-danger/40 text-danger hover:bg-danger/10",
        className,
      )}
    >
      {loading && <Loader2 className="size-4 animate-spin" aria-hidden />}
      {children}
    </button>
  );
}

export function Field({ label, hint, error, children, htmlFor }: { label: string; hint?: ReactNode; error?: string; children: ReactNode; htmlFor: string }) {
  return (
    <div className="space-y-1.5">
      <label htmlFor={htmlFor} className="block text-sm font-medium">
        {label}
      </label>
      {children}
      {hint && !error && <p className="text-xs text-mute">{hint}</p>}
      {error && (
        <p className="text-xs text-danger" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

const inputCls = "w-full rounded-xl border border-line bg-surface px-3.5 py-2.5 text-sm text-ink placeholder:text-mute/70 focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/30";
export const Input = (p: InputHTMLAttributes<HTMLInputElement>) => <input {...p} className={cx(inputCls, p.className)} />;
export const Textarea = (p: TextareaHTMLAttributes<HTMLTextAreaElement>) => <textarea {...p} className={cx(inputCls, "min-h-24", p.className)} />;
export const Select = (p: SelectHTMLAttributes<HTMLSelectElement>) => <select {...p} className={cx(inputCls, p.className)} />;

export function TextField(props: InputHTMLAttributes<HTMLInputElement> & { label: string; hint?: ReactNode; error?: string }) {
  const id = useId();
  const { label, hint, error, ...rest } = props;
  return (
    <Field label={label} hint={hint} error={error} htmlFor={id}>
      <Input id={id} aria-invalid={!!error} {...rest} />
    </Field>
  );
}

export function Card({ children, className, title, actions, subtitle }: { children: ReactNode; className?: string; title?: ReactNode; actions?: ReactNode; subtitle?: ReactNode }) {
  return (
    <section className={cx("rounded-2xl border border-line bg-surface", className)}>
      {(title || actions) && (
        <header className="flex flex-wrap items-start justify-between gap-3 border-b border-line px-5 py-4">
          <div>
            {title && <h2 className="text-base font-semibold">{title}</h2>}
            {subtitle && <p className="mt-0.5 text-sm text-mute">{subtitle}</p>}
          </div>
          {actions}
        </header>
      )}
      <div className="p-5">{children}</div>
    </section>
  );
}

export function PageHeader({ title, subtitle, actions, eyebrow }: { title: ReactNode; subtitle?: ReactNode; actions?: ReactNode; eyebrow?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div className="min-w-0">
        {eyebrow && <p className="mb-1 text-xs font-semibold uppercase tracking-[0.14em] text-accent-text">{eyebrow}</p>}
        <h1 className="font-serif text-4xl leading-none tracking-tight sm:text-5xl">{title}</h1>
        {subtitle && <p className="mt-2 max-w-2xl text-sm text-mute">{subtitle}</p>}
      </div>
      {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
    </div>
  );
}

type Tone = "neutral" | "ok" | "warn" | "danger" | "info" | "accent";
export function Badge({ tone = "neutral", children, className }: { tone?: Tone; children: ReactNode; className?: string }) {
  return (
    <span
      className={cx(
        "inline-flex items-center gap-1 whitespace-nowrap rounded-full border px-2 py-0.5 text-xs font-medium",
        tone === "neutral" && "border-line text-mute",
        tone === "ok" && "border-ok/40 text-ok",
        tone === "warn" && "border-warn/40 text-warn",
        tone === "danger" && "border-danger/40 text-danger",
        tone === "info" && "border-info/40 text-info",
        tone === "accent" && "border-accent-text/40 text-accent-text",
        className,
      )}
    >
      {children}
    </span>
  );
}

export const SEVERITY: Record<string, { label: string; tone: Tone }> = {
  critical: { label: "Crítica", tone: "danger" },
  high: { label: "Alta", tone: "danger" },
  medium: { label: "Media", tone: "warn" },
  low: { label: "Baja", tone: "info" },
  info: { label: "Info", tone: "neutral" },
};
export const SeverityBadge = ({ s }: { s: string }) => <Badge tone={SEVERITY[s]?.tone ?? "neutral"}>{SEVERITY[s]?.label ?? s}</Badge>;

export const JOB_STATE: Record<string, { label: string; tone: Tone }> = {
  queued: { label: "En cola", tone: "info" },
  validating: { label: "Validando", tone: "info" },
  running: { label: "En curso", tone: "accent" },
  awaiting_approval: { label: "Pendiente de aprobación", tone: "warn" },
  completed: { label: "Completado", tone: "ok" },
  failed: { label: "Fallido", tone: "danger" },
  cancelled: { label: "Cancelado", tone: "neutral" },
};

export function Spinner({ label = "Cargando…" }: { label?: string }) {
  return (
    <div className="flex items-center gap-2 py-10 text-sm text-mute" role="status">
      <Loader2 className="size-4 animate-spin" aria-hidden /> {label}
    </div>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={cx("skeleton h-4", className)} aria-hidden />;
}

export function ErrorState({ error, onRetry }: { error: ApiError | null; onRetry?: () => void }) {
  if (!error) return null;
  return (
    <div role="alert" className="flex flex-wrap items-start gap-3 rounded-2xl border border-danger/30 bg-danger/5 p-4 text-sm">
      <AlertTriangle className="mt-0.5 size-4 shrink-0 text-danger" aria-hidden />
      <div className="flex-1">
        <p className="font-medium">{error.message}</p>
        {error.status === 404 && <p className="text-mute">Puede que no exista o que no tengas acceso.</p>}
      </div>
      {onRetry && (
        <Button variant="ghost" onClick={onRetry}>
          Reintentar
        </Button>
      )}
    </div>
  );
}

export function Notice({ tone = "info", children, title }: { tone?: "info" | "ok" | "warn"; children: ReactNode; title?: ReactNode }) {
  const Icon = tone === "ok" ? CheckCircle2 : tone === "warn" ? AlertTriangle : Info;
  return (
    <div className={cx("flex gap-3 rounded-2xl border p-4 text-sm", tone === "info" && "border-info/30 bg-info/5", tone === "ok" && "border-ok/30 bg-ok/5", tone === "warn" && "border-warn/30 bg-warn/5")}>
      <Icon className={cx("mt-0.5 size-4 shrink-0", tone === "info" && "text-info", tone === "ok" && "text-ok", tone === "warn" && "text-warn")} aria-hidden />
      <div>
        {title && <p className="font-medium">{title}</p>}
        <div className="text-mute">{children}</div>
      </div>
    </div>
  );
}

export function EmptyState({ icon, title, children, action }: { icon?: ReactNode; title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center rounded-2xl border border-dashed border-line px-6 py-12 text-center">
      {icon && <div className="mb-3 text-mute">{icon}</div>}
      <p className="font-medium">{title}</p>
      {children && <div className="mt-1 max-w-md text-sm text-mute">{children}</div>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

const MEASUREMENT_LABEL: Record<string, string> = { observed: "Observado", derived: "Derivado", estimated: "Estimado", demo: "Demo" };

/** Metric card that always exposes source, measurement type, freshness and limitations. */
export function MetricCard({ m }: { m: { metric: string; label?: string; value: number | null; unit: string; measurement: string; source: string; observedAt: string; limitations?: string[] } }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded-2xl border border-line bg-surface p-4">
      <div className="flex items-start justify-between gap-2">
        <p className="text-sm text-mute">{m.label ?? m.metric}</p>
        <Badge tone={m.measurement === "observed" ? "ok" : m.measurement === "demo" ? "warn" : "info"}>{MEASUREMENT_LABEL[m.measurement] ?? m.measurement}</Badge>
      </div>
      <p className="mt-2 font-serif text-4xl leading-none tabular-nums">
        {typeof m.value === "number" ? m.value.toLocaleString("es-ES") : "—"}
        <span className="ml-1 font-sans text-sm text-mute">{m.unit}</span>
      </p>
      <button type="button" onClick={() => setOpen((o) => !o)} className="mt-3 text-xs text-mute underline-offset-2 hover:underline" aria-expanded={open}>
        Fuente y método
      </button>
      {open && (
        <div className="mt-2 space-y-1 text-xs text-mute">
          <p>
            <span className="text-ink">Fuente:</span> {m.source}
          </p>
          <p>
            <span className="text-ink">Observado:</span> {new Date(m.observedAt).toLocaleString("es-ES")}
          </p>
          {m.limitations?.map((l) => <p key={l}>· {l}</p>)}
        </div>
      )}
    </div>
  );
}

export function UnavailableCard({ label, reason }: { label: string; reason: string }) {
  return (
    <div className="rounded-2xl border border-dashed border-line p-4">
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm text-mute">{label}</p>
        <Lock className="size-4 text-mute" aria-hidden />
      </div>
      <p className="mt-2 font-serif text-4xl leading-none text-mute">—</p>
      <p className="mt-3 text-xs text-mute">{reason}</p>
    </div>
  );
}

export function Progress({ value }: { value: number }) {
  return (
    <div className="h-2 w-full overflow-hidden rounded-full bg-surface-2" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={value}>
      <div className="h-full rounded-full bg-accent transition-[width] duration-500" style={{ width: `${Math.max(2, value)}%` }} />
    </div>
  );
}

/** Links to the static legal pages (full page loads: they are not SPA routes). */
export function LegalLinks({ className }: { className?: string }) {
  return (
    <nav aria-label="Páginas legales" className={cx("flex flex-wrap gap-x-4 gap-y-1 text-xs text-mute", className)}>
      <a className="py-1 underline-offset-2 hover:text-ink hover:underline" href="/legal/aviso-legal">Aviso legal</a>
      <a className="py-1 underline-offset-2 hover:text-ink hover:underline" href="/legal/privacidad">Privacidad</a>
      <a className="py-1 underline-offset-2 hover:text-ink hover:underline" href="/legal/condiciones">Condiciones</a>
    </nav>
  );
}
