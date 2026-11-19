import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router";
import { Check, Lock, ShieldCheck } from "lucide-react";
import { isPlanCode, MODULE_MIN_PLAN, PLAN_LABEL, PLAN_ORDER, PLAN_PITCH, planIncludes, requiredPlan, type PlanCode } from "@dni/core/plan-access";
import { useAuth } from "./lib/auth";
import { Badge, cx } from "./ui";

/** Human names of the plan-gated modules (menu wording). */
export const MODULE_LABEL: Record<string, string> = {
  "seo-tecnico": "SEO técnico",
  keywords: "Keywords y competencia",
  "ai-visibility": "AI Visibility (GEO)",
  content: "Content Studio",
  landings: "Landing Pages y tests A/B",
  reports: "Informes",
  authority: "Backlinks / Authority",
  creative: "Creative Studio",
  video: "Video Studio",
  automations: "Automatizaciones",
  attribution: "Atribución",
  analytics: "Analytics (GA4)",
  ads: "Ads Manager",
  agency: "Agencia y marca blanca",
};

const INCLUDED_IN_FREE = ["Command Center", "Auditoría web y plan de 30 días", "Asesor IA", "Search Console", "CRM / Leads y formulario", "Equipo, integraciones y logs"];

const VIEW_AS_CLIENT_KEY = "dni.viewAsClient";

/**
 * What the current organisation's plan unlocks. Platform admins see every module (they support all
 * plans) unless they switch on «Ver como cliente», which shows exactly what a customer sees.
 */
export function usePlanAccess(orgId: string | undefined) {
  const { me } = useAuth();
  const m = me?.memberships.find((x) => x.id === orgId);
  const raw = m?.effective_plan ?? m?.plan_code ?? "free";
  const plan: PlanCode = isPlanCode(raw) ? raw : "free";
  const isAdmin = !!me?.user?.isPlatformAdmin;
  const [viewAsClient, setView] = useState(false);
  useEffect(() => {
    try {
      setView(localStorage.getItem(VIEW_AS_CLIENT_KEY) === "1");
    } catch {
      /* storage blocked: default view */
    }
  }, []);
  const setViewAsClient = useCallback((v: boolean) => {
    setView(v);
    try {
      localStorage.setItem(VIEW_AS_CLIENT_KEY, v ? "1" : "0");
    } catch {
      /* storage blocked: keeps working for this page view */
    }
  }, []);
  const bypass = isAdmin && !viewAsClient;
  return {
    plan,
    isAdmin,
    viewAsClient,
    setViewAsClient,
    bypass,
    /** Included in the plan (ignores the admin bypass). */
    includes: (module: string) => planIncludes(plan, module),
    /** Usable right now by this viewer. */
    unlocked: (module: string) => bypass || planIncludes(plan, module),
  };
}

export function PlanBadge({ plan, className }: { plan: PlanCode; className?: string }) {
  return (
    <span className={cx("inline-flex shrink-0 items-center gap-1 rounded-md border border-line px-1.5 text-[10px] font-medium uppercase tracking-wide text-mute", className)}>
      <Lock className="size-3" aria-hidden />
      {PLAN_LABEL[plan]}
    </span>
  );
}

/** Full-page lock shown instead of a module the plan does not include. */
export function PlanLockedPanel({ orgId, module, plan }: { orgId: string; module: string; plan: PlanCode }) {
  const need = requiredPlan(module);
  const added = PLAN_ORDER.slice(PLAN_ORDER.indexOf(plan) + 1, PLAN_ORDER.indexOf(need) + 1);
  return (
    <section className="mx-auto max-w-3xl py-6" aria-labelledby="plan-lock-title">
      <div className="relative overflow-hidden rounded-3xl border border-line bg-surface p-6 sm:p-10">
        <div className="pointer-events-none absolute -right-24 -top-24 size-72 rounded-full bg-accent/15 blur-3xl" aria-hidden />
        <div className="relative">
          <span className="inline-grid size-12 place-items-center rounded-2xl border border-line bg-bg">
            <Lock className="size-5 text-accent-text" aria-hidden />
          </span>
          <p className="mt-6 text-xs font-semibold uppercase tracking-[0.14em] text-mute">Disponible desde el plan {PLAN_LABEL[need]}</p>
          <h1 id="plan-lock-title" className="mt-2 font-serif text-4xl leading-tight sm:text-5xl">
            {MODULE_LABEL[module] ?? module}
          </h1>
          <p className="mt-3 max-w-xl text-mute">
            Tu organización está en el plan <strong className="text-ink">{PLAN_LABEL[plan]}</strong>. Este módulo forma parte de {PLAN_LABEL[need]}: {PLAN_PITCH[need]}
          </p>
          <ul className="mt-6 grid gap-2 sm:grid-cols-2">
            {added.flatMap((p) => Object.entries(MODULE_MIN_PLAN).filter(([, mp]) => mp === p)).map(([mod, p]) => (
              <li key={mod} className="flex items-center gap-2 text-sm">
                <Check className="size-4 shrink-0 text-ok" aria-hidden />
                <span className={cx(mod === module && "font-semibold")}>{MODULE_LABEL[mod] ?? mod}</span>
                <span className="text-xs text-mute">· {PLAN_LABEL[p]}</span>
              </li>
            ))}
          </ul>
          <div className="mt-8 flex flex-wrap gap-3">
            <Link to={`/o/${orgId}/billing`} className="inline-flex h-11 items-center rounded-xl bg-accent px-5 text-sm font-semibold text-accent-ink hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2">
              Ver planes y mejorar
            </Link>
            <Link to={`/o/${orgId}`} className="inline-flex h-11 items-center rounded-xl border border-line px-5 text-sm font-medium hover:bg-surface-2">
              Volver al Command Center
            </Link>
          </div>
          <p className="mt-6 text-xs text-mute">Tus datos de este módulo se conservan y puedes borrarlos en cualquier momento, aunque cambies de plan.</p>
        </div>
      </div>
    </section>
  );
}

/** Thin notice above a module that the platform admin opens outside the organisation's plan. */
export function AdminBypassNotice({ module, onViewAsClient }: { module: string; onViewAsClient: () => void }) {
  return (
    <div className="mb-6 flex flex-wrap items-center gap-3 rounded-2xl border border-dashed border-line bg-surface px-4 py-3 text-sm">
      <ShieldCheck className="size-4 shrink-0 text-accent-text" aria-hidden />
      <p className="min-w-0 flex-1">
        Módulo del plan <strong>{PLAN_LABEL[requiredPlan(module)]}</strong>. Lo ves porque eres administrador de la plataforma; los clientes de este plan lo ven bloqueado.
      </p>
      <button onClick={onViewAsClient} className="rounded-lg border border-line px-3 py-1.5 text-xs font-medium hover:bg-surface-2">
        Ver como cliente
      </button>
    </div>
  );
}

/** Plan × module comparison, generated from the same matrix the API enforces. */
export function PlanModulesTable({ current }: { current: string }) {
  const modules = Object.keys(MODULE_MIN_PLAN);
  return (
    <div className="overflow-x-auto rounded-2xl border border-line bg-surface">
      <table className="w-full min-w-[640px] text-sm">
        <caption className="sr-only">Módulos incluidos en cada plan</caption>
        <thead>
          <tr className="text-left">
            <th scope="col" className="px-4 py-3 text-xs font-semibold uppercase tracking-[0.12em] text-mute">Módulo</th>
            {PLAN_ORDER.map((p) => (
              <th key={p} scope="col" className={cx("px-3 py-3 text-center font-semibold", p === current && "bg-accent/10")}>
                {PLAN_LABEL[p]}
                {p === current && <Badge tone="accent" className="ml-1.5 align-middle">Actual</Badge>}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          <tr className="border-t border-line">
            <th scope="row" className="px-4 py-2.5 text-left font-normal">
              <span className="font-medium">Base</span>
              <span className="block text-xs text-mute">{INCLUDED_IN_FREE.join(" · ")}</span>
            </th>
            {PLAN_ORDER.map((p) => (
              <td key={p} className={cx("px-3 py-2.5 text-center", p === current && "bg-accent/10")}>
                <Check className="mx-auto size-4 text-ok" aria-label="Incluido" />
              </td>
            ))}
          </tr>
          {modules.map((m) => (
            <tr key={m} className="border-t border-line">
              <th scope="row" className="px-4 py-2.5 text-left font-normal">{MODULE_LABEL[m] ?? m}</th>
              {PLAN_ORDER.map((p) => (
                <td key={p} className={cx("px-3 py-2.5 text-center", p === current && "bg-accent/10")}>
                  {planIncludes(p, m) ? <Check className="mx-auto size-4 text-ok" aria-label="Incluido" /> : <span className="text-mute" aria-label="No incluido">—</span>}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
