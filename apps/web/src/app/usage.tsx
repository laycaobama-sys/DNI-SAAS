import { useEffect, useState } from "react";
import { Link } from "react-router";
import { ArrowUpRight, Gauge, Sparkles, X } from "lucide-react";
import { useApi } from "./lib/hooks";
import { Badge, cx } from "./ui";

export type UsageLevel = "ok" | "warning" | "critical" | "exhausted";
export interface UsageItem {
  key: string;
  label: string;
  used: number;
  limit: number;
  unit: string;
  period: "day" | "month" | "total";
  resetsAt: string | null;
  overridden?: boolean;
  pct: number;
  level: UsageLevel;
  upgrade: { plan: string; label: string; limit: number; priceEurMonth: number } | null;
}
export interface Usage {
  plan: { code: string; label: string; priceEurMonth: number };
  creditsBalance: number;
  items: UsageItem[];
  alerts: UsageItem[];
  observedAt: string;
  measurement: string;
  source: string;
}

const LEVEL_RANK: Record<UsageLevel, number> = { ok: 0, warning: 1, critical: 2, exhausted: 3 };
const LEVEL_TONE: Record<UsageLevel, "ok" | "warn" | "danger"> = { ok: "ok", warning: "warn", critical: "danger", exhausted: "danger" };
const LEVEL_LABEL: Record<UsageLevel, string> = { ok: "Correcto", warning: "Cerca del límite", critical: "Casi agotado", exhausted: "Agotado" };
const PERIOD: Record<UsageItem["period"], string> = { day: "hoy", month: "este mes", total: "en total" };

export const useUsage = (orgId: string | undefined) => useApi<Usage>(orgId ? `/orgs/${orgId}/usage` : null);

function resetText(i: UsageItem) {
  if (!i.resetsAt) return null;
  const d = new Date(i.resetsAt);
  return i.period === "day"
    ? `Se renueva a las ${d.toLocaleTimeString("es-ES", { hour: "2-digit", minute: "2-digit" })}`
    : `Se renueva el ${d.toLocaleDateString("es-ES", { day: "numeric", month: "long" })}`;
}

/** A total allowance (seats, brands) that is simply in use: «complete», not an alarm. */
const isFull = (i: UsageItem) => i.period === "total" && i.level === "exhausted" && i.used <= i.limit;

function Meter({ i }: { i: UsageItem }) {
  const width = i.limit > 0 ? Math.min(100, Math.max(i.used > 0 ? 3 : 0, i.pct)) : 100;
  return (
    <div className="h-2 w-full overflow-hidden rounded-full bg-surface-2" role="meter" aria-valuemin={0} aria-valuemax={i.limit} aria-valuenow={i.used} aria-label={i.label}>
      <div
        className={cx("h-full rounded-full transition-[width] duration-500", i.level === "ok" ? "bg-accent" : i.level === "warning" || isFull(i) ? "bg-warn" : "bg-danger")}
        style={{ width: `${width}%` }}
      />
    </div>
  );
}

/** Every quota of the plan with its level, reset time and the plan that raises it. */
export function UsageMeters({ orgId, usage }: { orgId: string; usage: Usage }) {
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      {usage.items.map((i) => (
        <div key={i.key} className="rounded-2xl border border-line bg-surface p-4">
          <div className="flex items-start justify-between gap-2">
            <p className="text-sm font-medium">{i.label}</p>
            <Badge tone={isFull(i) ? "warn" : LEVEL_TONE[i.level]}>{isFull(i) ? "Completo" : LEVEL_LABEL[i.level]}</Badge>
          </div>
          <p className="mt-2 font-serif text-3xl leading-none tabular-nums">
            {i.used.toLocaleString("es-ES")}
            <span className="ml-1 font-sans text-sm text-mute">
              / {i.limit.toLocaleString("es-ES")} {i.unit} {PERIOD[i.period]}
            </span>
          </p>
          <div className="mt-3">
            <Meter i={i} />
          </div>
          <div className="mt-2 flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-xs text-mute">
            <span>{resetText(i) ?? (i.overridden ? "Límite personalizado" : "Límite de tu plan")}</span>
            {i.upgrade && i.level !== "ok" && (
              <Link to={`/o/${orgId}/billing#planes`} className="inline-flex items-center gap-1 font-semibold text-accent-text hover:underline">
                {i.upgrade.label}: {i.upgrade.limit.toLocaleString("es-ES")} {i.unit} <ArrowUpRight className="size-3" aria-hidden />
              </Link>
            )}
          </div>
        </div>
      ))}
      <p className="text-xs text-mute sm:col-span-2">
        Fuente: {usage.source}. Observado {new Date(usage.observedAt).toLocaleString("es-ES")}. Los límites diarios se renuevan a las 00:00 UTC.
      </p>
    </div>
  );
}

const DISMISS_KEY = "dni.usageBanner";

/**
 * Warning shown on every page when a quota is close to (≥75 %) or at its limit, with the plan that
 * raises it. Dismissible for the day per level, so it never nags twice for the same thing.
 */
export function UsageBanner({ orgId }: { orgId: string }) {
  const { data, reload } = useUsage(orgId);
  const [dismissed, setDismissed] = useState<string | null>(null);
  useEffect(() => {
    try {
      setDismissed(localStorage.getItem(DISMISS_KEY));
    } catch {
      /* storage blocked */
    }
    // Refresh when the tab comes back (after using AI elsewhere) and every 5 minutes.
    const onFocus = () => void reload();
    window.addEventListener("focus", onFocus);
    const t = window.setInterval(onFocus, 5 * 60_000);
    return () => (window.removeEventListener("focus", onFocus), window.clearInterval(t));
  }, [reload]);
  if (!data?.alerts.length) return null;
  const top = [...data.alerts].sort((a, b) => LEVEL_RANK[b.level] - LEVEL_RANK[a.level] || b.pct - a.pct)[0]!;
  const stamp = `${orgId}:${top.key}:${top.level}:${new Date().toISOString().slice(0, 10)}`;
  if (dismissed === stamp) return null;
  const dismiss = () => {
    setDismissed(stamp);
    try {
      localStorage.setItem(DISMISS_KEY, stamp);
    } catch {
      /* storage blocked */
    }
  };
  const exhausted = top.level === "exhausted";
  return (
    <div role="status" className={cx("mb-5 flex flex-wrap items-center gap-3 rounded-2xl border p-3 pr-2 text-sm sm:p-4", exhausted || top.level === "critical" ? "border-danger/30 bg-danger/5" : "border-warn/30 bg-warn/5")}>
      <Gauge className={cx("size-5 shrink-0", exhausted || top.level === "critical" ? "text-danger" : "text-warn")} aria-hidden />
      <div className="min-w-0 flex-1">
        <p className="font-medium">
          {exhausted ? `Has llegado al límite: ${top.label.toLowerCase()}` : `${top.label}: ${top.used} de ${top.limit} (${top.pct} %)`}
        </p>
        <p className="text-mute">
          {top.upgrade
            ? `Con el plan ${top.upgrade.label} tendrías ${top.upgrade.limit.toLocaleString("es-ES")} ${top.unit}${top.period === "day" ? " al día" : top.period === "month" ? " al mes" : ""}.`
            : exhausted
              ? resetText(top) ?? "Escríbenos si necesitas más capacidad."
              : "Te avisamos antes de que se agote."}
          {data.alerts.length > 1 && ` · ${data.alerts.length - 1} aviso(s) más en «Plan, límites y créditos».`}
        </p>
      </div>
      <div className="flex items-center gap-1">
        <Link to={`/o/${orgId}/billing#uso`} className="inline-flex min-h-9 items-center gap-1.5 rounded-full bg-accent px-3.5 text-xs font-semibold text-accent-ink">
          <Sparkles className="size-3.5" aria-hidden /> {top.upgrade ? `Pasar a ${top.upgrade.label}` : "Ver uso"}
        </Link>
        <button onClick={dismiss} className="grid size-9 place-items-center rounded-full text-mute hover:bg-surface-2 hover:text-ink" aria-label="Ocultar aviso hasta mañana">
          <X className="size-4" />
        </button>
      </div>
    </div>
  );
}
