import { useEffect, useRef, useState, type FormEvent } from "react";
import { Link, useParams, useSearchParams } from "react-router";
import { ArrowRight, CheckCircle2, Circle, CircleDashed, Clock, Lock, SkipForward } from "lucide-react";
import { ApiError, put } from "../lib/api";
import { useApi } from "../lib/hooks";
import { Badge, Button, Card, ErrorState, Notice, PageHeader, Progress, Select, Skeleton } from "../ui";

type StepStatus = "done" | "pending" | "skipped" | "unavailable" | "locked";
type StepKey = "brand" | "competitors" | "analytics" | "cms" | "mode" | "article";
interface Step {
  key: StepKey;
  title: string;
  description: string;
  status: StepStatus;
  href: string;
  cta: string;
  note?: string;
}
export interface Activation {
  steps: Step[];
  done: number;
  total: number;
  percent: number;
  next: StepKey | null;
  publishingMode: "approval" | "autopilot" | null;
  articlesPerWeek: number | null;
  publicAudit: { id: string; host: string; status: string } | null;
}

const SKIPPABLE = new Set<StepKey>(["competitors", "analytics", "cms"]);
const STATUS: Record<StepStatus, { label: string; tone: "ok" | "neutral" | "warn" | "info" }> = {
  done: { label: "Hecho", tone: "ok" },
  pending: { label: "Pendiente", tone: "neutral" },
  skipped: { label: "Para más tarde", tone: "neutral" },
  unavailable: { label: "En desarrollo", tone: "warn" },
  locked: { label: "Desde Starter", tone: "info" },
};

function StepIcon({ s }: { s: StepStatus }) {
  const cls = "size-5 shrink-0";
  if (s === "done") return <CheckCircle2 className={`${cls} text-ok`} aria-hidden />;
  if (s === "skipped") return <SkipForward className={`${cls} text-mute`} aria-hidden />;
  if (s === "unavailable") return <Clock className={`${cls} text-warn`} aria-hidden />;
  if (s === "locked") return <Lock className={`${cls} text-info`} aria-hidden />;
  return <Circle className={`${cls} text-mute`} aria-hidden />;
}

/** Guided set-up: the six steps, read from real data (nothing is ticked by hand). */
export function WelcomePage() {
  const { orgId } = useParams();
  const [params] = useSearchParams();
  const { data, error, loading, reload, setData } = useApi<Activation>(`/orgs/${orgId}/activation`);
  const [busy, setBusy] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<ApiError | null>(null);
  const modeRef = useRef<HTMLLIElement>(null);
  useEffect(() => {
    if (params.get("paso") === "mode" && data) modeRef.current?.scrollIntoView({ block: "center" });
  }, [params, data]);

  const save = async (key: string, body: Record<string, unknown>) => {
    setBusy(key);
    setSaveError(null);
    try {
      setData(await put<Activation>(`/orgs/${orgId}/onboarding`, body));
    } catch (e) {
      setSaveError(e as ApiError);
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      <PageHeader
        eyebrow="Bienvenida"
        title="Pon en marcha DNI Growth"
        subtitle="Seis pasos para empezar con buen pie. Puedes dejar alguno para más tarde: lo que marcamos como hecho sale de tus datos reales, no de una casilla."
      />
      <ErrorState error={error} onRetry={reload} />
      {loading && !data && <Skeleton className="h-64 rounded-2xl" />}
      {data && (
        <div className="space-y-6">
          <Card>
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <p className="font-medium">
                {data.done} de {data.total} pasos hechos
              </p>
              <p className="text-sm text-mute tabular-nums">{data.percent} %</p>
            </div>
            <div className="mt-3">
              <Progress value={data.percent} />
            </div>
          </Card>
          {data.publicAudit && (
            <Notice tone="ok" title={`Tu auditoría gratuita de ${data.publicAudit.host} ya está en tu cuenta`}>
              <a className="underline" href={`/auditoria/${data.publicAudit.id}`}>
                Ver el informe completo
              </a>
              . Para tu plan de 30 días, analiza tu web completa en el primer paso (revisa más páginas que la auditoría gratuita).
            </Notice>
          )}
          <ErrorState error={saveError} />
          <ol className="space-y-3">
            {data.steps.map((s, i) => (
              <li key={s.key} ref={s.key === "mode" ? modeRef : undefined} id={`paso-${s.key}`} className="rounded-2xl border border-line bg-surface p-4 sm:p-5">
                <div className="flex gap-3">
                  <StepIcon s={s.status} />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <h2 className="font-semibold">
                        <span className="text-mute">{i + 1}.</span> {s.title}
                      </h2>
                      <Badge tone={STATUS[s.status].tone}>{STATUS[s.status].label}</Badge>
                    </div>
                    <p className="mt-1 text-sm text-mute">{s.description}</p>
                    {s.note && <p className="mt-2 text-sm text-mute">{s.note}</p>}
                    {s.key === "mode" ? (
                      <ModeForm a={data} busy={busy === "mode"} onSave={(b) => save("mode", b)} />
                    ) : (
                      <div className="mt-3 flex flex-wrap gap-2">
                        {s.status !== "done" && s.status !== "unavailable" && (
                          <Link to={s.href} className="inline-flex min-h-10 items-center gap-2 rounded-full bg-accent px-4 text-sm font-semibold text-accent-ink">
                            {s.cta} <ArrowRight className="size-4" aria-hidden />
                          </Link>
                        )}
                        {s.status === "unavailable" && (
                          <Link to={s.href} className="inline-flex min-h-10 items-center gap-2 rounded-full border border-line px-4 text-sm font-semibold hover:bg-surface-2">
                            {s.cta}
                          </Link>
                        )}
                        {SKIPPABLE.has(s.key) && s.status === "pending" && (
                          <Button variant="ghost" loading={busy === s.key} onClick={() => save(s.key, { skip: s.key })}>
                            Dejarlo para más tarde
                          </Button>
                        )}
                        {SKIPPABLE.has(s.key) && s.status === "skipped" && (
                          <Button variant="ghost" loading={busy === s.key} onClick={() => save(s.key, { unskip: s.key })}>
                            Retomar este paso
                          </Button>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              </li>
            ))}
          </ol>
          <p className="text-sm text-mute">
            Te escribiremos un par de veces durante los primeros días con el siguiente paso; puedes darte de baja desde el propio correo.
          </p>
        </div>
      )}
    </>
  );
}

function ModeForm({ a, busy, onSave }: { a: Activation; busy: boolean; onSave: (b: Record<string, unknown>) => void }) {
  const [mode, setMode] = useState<"approval" | "autopilot">(a.publishingMode ?? "approval");
  const [perWeek, setPerWeek] = useState(a.articlesPerWeek ?? 1);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    onSave({ publishingMode: mode, articlesPerWeek: perWeek });
  };
  return (
    <form onSubmit={submit} className="mt-3 space-y-3">
      <fieldset className="space-y-2">
        <legend className="sr-only">Modo de trabajo</legend>
        <label className="flex cursor-pointer gap-3 rounded-xl border border-line p-3 has-[:checked]:border-accent">
          <input type="radio" name="mode" value="approval" checked={mode === "approval"} onChange={() => setMode("approval")} className="mt-1" />
          <span>
            <span className="font-medium">Con aprobación (recomendado)</span>
            <span className="block text-sm text-mute">Preparamos cada artículo en borrador y tú decides qué se publica.</span>
          </span>
        </label>
        <label className="flex cursor-pointer gap-3 rounded-xl border border-line p-3 has-[:checked]:border-accent">
          <input type="radio" name="mode" value="autopilot" checked={mode === "autopilot"} onChange={() => setMode("autopilot")} className="mt-1" />
          <span>
            <span className="font-medium">Piloto automático</span>
            <span className="block text-sm text-mute">En desarrollo. Guardamos tu preferencia, pero hasta que esté listo todo seguirá esperando tu aprobación.</span>
          </span>
        </label>
      </fieldset>
      <div className="flex flex-wrap items-end gap-3">
        <label className="text-sm">
          <span className="mb-1 block font-medium">Artículos por semana</span>
          <Select value={perWeek} onChange={(e) => setPerWeek(Number(e.target.value))} className="w-28">
            {[1, 2, 3, 4, 5, 6, 7].map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </Select>
        </label>
        <Button variant="primary" type="submit" loading={busy}>
          {a.publishingMode ? "Guardar cambios" : "Guardar"}
        </Button>
      </div>
    </form>
  );
}

/** Dashboard checklist: progress and the next step, until every step is done, skipped or not available yet. */
export function ActivationCard({ orgId }: { orgId: string }) {
  const { data } = useApi<Activation>(`/orgs/${orgId}/activation`);
  if (!data || !data.next) return null;
  const next = data.steps.find((s) => s.key === data.next)!;
  return (
    <div className="mb-6 rounded-2xl border border-accent/40 bg-surface p-4 sm:p-5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="font-semibold">
          Configuración: {data.done} de {data.total} pasos
        </p>
        <Link to={`/o/${orgId}/bienvenida`} className="text-sm text-accent-text hover:underline">
          Ver los {data.total} pasos
        </Link>
      </div>
      <div className="mt-3">
        <Progress value={data.percent} />
      </div>
      <ul className="mt-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {data.steps.map((s) => (
          <li key={s.key} className="flex items-center gap-2 text-sm">
            {s.status === "done" ? (
              <CheckCircle2 className="size-4 shrink-0 text-ok" aria-hidden />
            ) : s.key === data.next ? (
              <CircleDashed className="size-4 shrink-0 text-accent-text" aria-hidden />
            ) : s.status === "skipped" ? (
              <SkipForward className="size-4 shrink-0 text-mute" aria-hidden />
            ) : (
              <Circle className="size-4 shrink-0 text-mute" aria-hidden />
            )}
            <span className={s.status === "done" ? "text-mute line-through" : ""}>{s.title}</span>
            <span className="sr-only">: {STATUS[s.status].label}</span>
          </li>
        ))}
      </ul>
      <div className="mt-4">
        <Link to={next.href} className="inline-flex min-h-10 items-center gap-2 rounded-full bg-accent px-4 text-sm font-semibold text-accent-ink">
          Siguiente: {next.cta} <ArrowRight className="size-4" aria-hidden />
        </Link>
      </div>
    </div>
  );
}
