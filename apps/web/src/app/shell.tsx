import { useEffect, useState } from "react";
import { Link, NavLink, Outlet, useLocation, useNavigate, useParams } from "react-router";
import {
  BarChart3,
  FileBarChart,
  Bot,
  TrendingUp,
  Building2,
  ChevronsUpDown,
  Cpu,
  CreditCard,
  FileSearch,
  FileText,
  Film,
  Gauge,
  KeyRound,
  LayoutDashboard,
  LayoutTemplate,
  LogOut,
  Megaphone,
  MessageSquareText,
  Menu,
  Moon,
  Palette,
  Plug,
  ScrollText,
  Search,
  Sparkles,
  Sun,
  Target,
  Users,
  Workflow,
  X,
  Link2,
  FlaskConical,
} from "lucide-react";
import { post } from "./lib/api";
import { useAuth } from "./lib/auth";
import { useApi, useTheme } from "./lib/hooks";
import { cx, LegalLinks } from "./ui";
import { MODULE_MIN_PLAN, PLAN_LABEL, menuShowsModule, requiredPlan } from "@dni/core/plan-access";
import { menuStatusBadge } from "@dni/core/features";
import { AdminBypassNotice, PlanLockedPanel, usePlanAccess } from "./planaccess";
import { ErrorBoundary } from "./errorboundary";
import { UsageBanner } from "./usage";
import { ChevronDown, Lock, ShieldAlert, ShieldCheck } from "lucide-react";

export const MODULES: Record<string, { label: string; description: string }> = {
  "seo-tecnico": { label: "SEO técnico", description: "Rastreos programados, histórico, hreflang, enlaces rotos y Core Web Vitals con datos de campo." },
  keywords: { label: "Keywords y competencia", description: "Investigación por país e idioma con proveedor licenciado. Sin proveedor no mostramos volúmenes ni dificultad." },
  "ai-visibility": { label: "AI Visibility (GEO/AEO)", description: "Biblioteca de prompts y muestreo en motores de IA solo mediante APIs permitidas, con fecha, idioma y versión." },
  content: { label: "Content Studio", description: "Briefs con fuentes, editor versionado, revisión factual, aprobación y publicación en tu CMS." },
  authority: { label: "Backlinks / Authority", description: "Menciones y relaciones editoriales legítimas. Nunca granjas ni intercambios masivos de enlaces." },
  creative: { label: "Creative Studio", description: "Banners y carruseles con brand kit, capas, safe areas y exportación por formato." },
  video: { label: "Video Studio", description: "Storyboard, voz con licencia, subtítulos y render asíncrono con coste reservado." },
  ads: { label: "Ads Manager", description: "Borradores sin gasto, aprobación explícita, Spend Guardian con límites y kill switch." },
  landings: { label: "Landing Pages", description: "Constructor por bloques, dominio verificado, consentimiento y formularios anti-spam." },
  experiments: { label: "Experiments / CRO", description: "Tests A/B con hipótesis, muestra mínima y advertencias de significancia." },
  crm: { label: "CRM / Leads", description: "Leads deduplicados, pipeline, tareas y consentimiento por finalidad." },
  analytics: { label: "Analytics & Revenue", description: "Search Console, GA4, gasto y ingresos verificados con atribución explícita." },
  agents: { label: "AI Agent Center", description: "Historial de cada trabajo de los agentes: entrada, salida, coste y quién lo autorizó." },
  automations: { label: "Automatizaciones", description: "Flujos con aprobación, límites, horario de silencio y registro." },
  agency: { label: "Agency / White Label", description: "Subclientes aislados, portal de cliente y marca propia." },
};

type NavItem = { to: string; label: string; icon: typeof Gauge; live?: boolean; end?: boolean; module: string };

/** Menu structure (exported for the test that keeps it in line with FEATURES in @dni/core/features). */
export function navFor(orgId: string): Array<{ section: string; items: NavItem[] }> {
  const o = `/o/${orgId}`;
  const i = (path: string, label: string, icon: typeof Gauge, end?: boolean): NavItem => ({ to: path ? `${o}/${path}` : o, label, icon, live: true, end, module: path });
  return [
    { section: "Crecimiento", items: [i("", "Command Center", LayoutDashboard, true), i("analyze", "Nueva auditoría", Sparkles), i("advisor", "Asesor IA", MessageSquareText), i("ai-hub", "Tu IA y consumo", Cpu), i("audits", "Auditoría web", FileSearch), i("brands", "Proyectos y marcas", Building2)] },
    { section: "Orgánico", items: [i("seo-tecnico", "SEO técnico", Gauge), i("search-console", "Search Console", TrendingUp), i("keywords", "Keywords y competencia", Search), i("ai-visibility", "AI Visibility (GEO)", Bot), i("content", "Content Studio", FileText), i("authority", "Backlinks / Authority", Link2)] },
    { section: "Creatividad y pago", items: [i("creative", "Creative Studio", Palette), i("video", "Video Studio", Film), i("ads", "Ads Manager", Megaphone), i("landings", "Landing Pages y tests A/B", LayoutTemplate)] },
    { section: "Ventas y datos", items: [i("crm", "CRM / Leads", Target), i("automations", "Automatizaciones", Workflow), i("attribution", "Atribución", FlaskConical), i("analytics", "Analytics (GA4)", BarChart3), i("reports", "Informes", FileBarChart), i("jobs", "AI Agent Center", Bot)] },
    { section: "Organización", items: [i("integrations", "Integraciones", Plug), i("team", "Equipo y accesos", Users), i("billing", "Plan, límites y créditos", CreditCard), i("agency", "Agencia y marca blanca", KeyRound), i("audit-log", "Logs de auditoría", ScrollText)] },
  ];
}

const norm = (s: string) =>
  s
    .normalize("NFD")
    .replace(new RegExp("[\u0300-\u036f]", "g"), "")
    .toLowerCase();

/** Black or white text for a custom accent, whichever contrasts more (WCAG relative luminance). */
function inkFor(hex: string) {
  const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  const l = 0.2126 * c[0]! + 0.7152 * c[1]! + 0.0722 * c[2]!;
  return l > 0.179 ? "#0b0b0c" : "#ffffff";
}

export function Logo({ className }: { className?: string }) {
  return (
    <span className={cx("inline-flex items-center gap-2 font-bold", className)}>
      <span className="grid h-7 place-items-center rounded-md border-[1.5px] border-accent px-1.5 text-[11px] font-extrabold tracking-[0.08em]">DNI</span>
      <span className="font-serif text-2xl font-normal italic">Growth</span>
    </span>
  );
}

/**
 * «Parcial» / «En desarrollo» next to a menu item, from the same FEATURES registry as the public site and
 * llms.txt. Fully available modules show nothing. The limit is in the tooltip and for screen readers.
 */
export function MenuStatus({ module }: { module: string }) {
  const b = menuStatusBadge(module);
  if (!b) return null;
  return (
    <span className="shrink-0 rounded border border-line px-1 text-[10px] text-mute" title={b.title} data-menu-status={module}>
      {b.label}
      <span className="sr-only">: {b.title}</span>
    </span>
  );
}

/** Modules outside the customer's plan: one collapsed group at the end, never mixed with what they can use. */
function LockedModules({ groups, plan, bypass, filter }: { groups: Array<{ section: string; items: NavItem[] }>; plan: string; bypass: boolean; filter: string }) {
  if (bypass) return null;
  const q = norm(filter.trim());
  const locked = groups
    .flatMap((g) => g.items.map((it) => ({ ...it, section: g.section })))
    .filter((it) => !menuShowsModule(plan, it.module, false))
    .filter((it) => !q || norm(it.label + " " + it.section).includes(q));
  if (!locked.length) return null;
  return (
    <details className="group/locked mb-4" open={!!q}>
      <summary className="flex cursor-pointer list-none items-center justify-between rounded-lg px-3 py-1.5 text-[11px] font-semibold uppercase tracking-[0.12em] text-mute hover:bg-surface-2 [&::-webkit-details-marker]:hidden">
        <span>Disponible en otros planes ({locked.length})</span>
        <ChevronDown className="size-3.5 transition group-open/locked:rotate-180" aria-hidden />
      </summary>
      <ul className="mt-1">
        {locked.map((it) => (
          <li key={it.label}>
            <NavLink to={it.to} title={`${it.label}: incluido desde el plan ${PLAN_LABEL[requiredPlan(it.module)]}`} className="flex items-center gap-2.5 rounded-lg px-3 py-1.5 text-sm leading-snug text-mute/80 transition hover:bg-surface-2 hover:text-ink">
              <Lock className="size-4 shrink-0" aria-hidden />
              <span className="min-w-0 flex-1 break-words">{it.label}</span>
              <span className="shrink-0 text-[10px] font-semibold">{PLAN_LABEL[requiredPlan(it.module)]}</span>
            </NavLink>
          </li>
        ))}
      </ul>
    </details>
  );
}

export function AppShell() {
  const { orgId = "" } = useParams();
  const { me, refresh } = useAuth();
  const { theme, toggle } = useTheme();
  const [open, setOpen] = useState(false);
  const [switcher, setSwitcher] = useState(false);
  const [filter, setFilter] = useState("");
  const loc = useLocation();
  const nav = useNavigate();
  useEffect(() => {
    setOpen(false);
  }, [loc.pathname]);
  // Mobile drawer: the page behind must not scroll or jump while it is open; Escape closes it.
  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = prev;
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);
  const current = me?.memberships.find((m) => m.id === orgId);
  const support = !current ? me?.supportAccess?.find((s) => s.id === orgId) : undefined;
  const suspended = current?.status === "suspended";
  const access = usePlanAccess(orgId);
  // Module of the current page (first path segment after /o/:orgId) and whether this viewer may open it.
  const pageModule = loc.pathname.split("/")[3] ?? "";
  const gated = pageModule in MODULE_MIN_PLAN && !access.includes(pageModule);
  const { data: brand } = useApi<{ displayName: string | null; logoUrl: string | null; accent: string | null }>(orgId ? `/orgs/${orgId}/branding` : null);
  const accentStyle = brand?.accent ? ({ "--accent": brand.accent, "--accent-ink": inkFor(brand.accent) } as React.CSSProperties) : undefined;
  const brandMark = brand?.displayName || brand?.logoUrl ? (
    <span className="inline-flex min-w-0 items-center gap-2 font-semibold">
      {brand.logoUrl && <img src={brand.logoUrl} alt="" className="h-7 max-w-[120px] object-contain" referrerPolicy="no-referrer" />}
      {brand.displayName && <span className="truncate">{brand.displayName}</span>}
    </span>
  ) : (
    <Logo />
  );

  async function logout() {
    await post("/auth/logout").catch(() => null);
    await refresh();
    nav("/login");
  }

  const sidebar = (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between px-4 py-4">
        <Link to={`/o/${orgId}`} aria-label={`${brand?.displayName ?? "DNI Growth"}, Command Center`} className="min-w-0">
          {brandMark}
        </Link>
        <button className="-m-1.5 grid size-11 place-items-center rounded-lg text-mute hover:bg-surface-2 lg:hidden" onClick={() => setOpen(false)} aria-label="Cerrar menú">
          <X className="size-5" />
        </button>
      </div>
      <div className="relative px-3 pb-3">
        <button onClick={() => setSwitcher((s) => !s)} className="flex w-full items-center justify-between gap-2 rounded-xl border border-line bg-surface px-3 py-2 text-left text-sm hover:bg-surface-2" aria-expanded={switcher} aria-haspopup="listbox">
          <span className="min-w-0">
            <span className="block truncate font-medium">{current?.name ?? "Organización"}</span>
            <span className="block text-xs text-mute">
              Plan {PLAN_LABEL[access.plan]} · {current?.role ?? ""}
            </span>
          </span>
          <ChevronsUpDown className="size-4 shrink-0 text-mute" />
        </button>
        {switcher && (
          <div role="listbox" className="absolute inset-x-3 top-full z-30 mt-1 rounded-xl border border-line bg-surface p-1 shadow-xl">
            {me?.memberships.map((m) => (
              <button key={m.id} role="option" aria-selected={m.id === orgId} onClick={() => (setSwitcher(false), nav(`/o/${m.id}`))} className={cx("block w-full truncate rounded-lg px-3 py-2 text-left text-sm hover:bg-surface-2", m.id === orgId && "font-semibold")}>
                {m.name}
              </button>
            ))}
            <Link to="/onboarding" onClick={() => setSwitcher(false)} className="block rounded-lg px-3 py-2 text-sm text-accent-text hover:bg-surface-2">
              + Nueva organización
            </Link>
          </div>
        )}
      </div>
      <div className="px-3 pb-2">
        <label className="relative block">
          <span className="sr-only">Buscar módulo</span>
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-mute" aria-hidden />
          <input
            type="search"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Buscar módulo…"
            className="h-9 w-full rounded-lg border border-line bg-surface pl-8 pr-2 text-sm placeholder:text-mute focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
          />
        </label>
      </div>
      <nav className="flex-1 overflow-y-auto px-3 pb-4" aria-label="Módulos">
        {navFor(orgId)
          // Customers only see what their plan includes; upgrades live in «Plan, límites y créditos».
          .map((g) => ({ ...g, items: g.items.filter((it) => menuShowsModule(access.plan, it.module, access.bypass)) }))
          .map((g) => ({ ...g, items: g.items.filter((it) => !filter.trim() || norm(it.label + " " + g.section).includes(norm(filter.trim()))) }))
          .filter((g) => g.items.length)
          .map((g) => (
          <div key={g.section} className="mb-4">
            <p className="px-3 pb-1 text-[11px] font-semibold uppercase tracking-[0.12em] text-mute">{g.section}</p>
            <ul>
              {g.items.map((it) => (
                <li key={it.label}>
                  <NavLink
                    to={it.to}
                    end={it.end}
                    title={it.label}
                    className={({ isActive }) => cx("group flex items-center gap-2.5 rounded-lg px-3 py-1.5 text-sm leading-snug transition", isActive ? "bg-surface-2 font-medium text-ink" : "text-mute hover:bg-surface-2 hover:text-ink")}
                  >
                    <it.icon className="size-4 shrink-0" aria-hidden />
                    <span className="min-w-0 flex-1 break-words">{it.label}</span>
                    <MenuStatus module={it.module} />
                    {access.bypass && !access.includes(it.module) && <span className="shrink-0 rounded border border-dashed border-line px-1 text-[10px] text-mute" title={`Plan ${requiredPlan(it.module)}: visible por ser administrador`}>admin</span>}
                  </NavLink>
                </li>
              ))}
            </ul>
          </div>
        ))}
        <LockedModules groups={navFor(orgId)} plan={access.plan} bypass={access.bypass} filter={filter} />
      </nav>
      {!access.bypass && access.plan !== "agency" && (
        <div className="px-3 pb-3">
          <Link to={`/o/${orgId}/billing`} className="flex items-center justify-between gap-2 rounded-xl border border-line px-3 py-2 text-xs hover:bg-surface-2">
            <span className="text-mute">
              Plan <strong className="text-ink">{PLAN_LABEL[access.plan]}</strong>
            </span>
            <span className="font-semibold text-accent-text">Mejorar plan</span>
          </Link>
        </div>
      )}
      <div className="border-t border-line p-3">
        <div className="flex items-center gap-2">
          <div className="grid size-8 place-items-center rounded-full bg-surface-2 text-xs font-semibold">{me?.user?.name?.slice(0, 1).toUpperCase()}</div>
          <div className="min-w-0 flex-1 text-sm">
            <p className="truncate font-medium">{me?.user?.name}</p>
            <p className="truncate text-xs text-mute">{me?.user?.email}</p>
          </div>
          <button onClick={toggle} className="rounded-lg p-2 text-mute hover:bg-surface-2 hover:text-ink" aria-label={theme === "dark" ? "Cambiar a modo claro" : "Cambiar a modo oscuro"}>
            {theme === "dark" ? <Sun className="size-4" /> : <Moon className="size-4" />}
          </button>
          <button onClick={logout} className="rounded-lg p-2 text-mute hover:bg-surface-2 hover:text-ink" aria-label="Cerrar sesión">
            <LogOut className="size-4" />
          </button>
        </div>
        {(access.isAdmin || me?.platform?.member) && (
          <div className="mt-2 flex flex-col gap-1.5 rounded-lg border border-line px-2.5 py-2 text-xs">
            <Link to="/admin" className="font-medium text-accent-text hover:underline">
              Control Center del propietario
            </Link>
            {access.isAdmin && <label className="flex cursor-pointer items-center justify-between gap-2 text-mute">
              Ver como cliente
              <input type="checkbox" className="size-4 accent-[var(--accent)]" checked={access.viewAsClient} onChange={(e) => access.setViewAsClient(e.target.checked)} />
            </label>}
          </div>
        )}
        <LegalLinks className="mt-2 px-1" />
      </div>
    </div>
  );

  return (
    <div className="min-h-full overflow-x-clip lg:grid lg:grid-cols-[272px_1fr] print:block" style={accentStyle}>
      <aside className="sticky top-0 hidden h-dvh border-r border-line bg-bg lg:block print:hidden">{sidebar}</aside>
      {open && (
        <div className="fixed inset-0 z-40 lg:hidden">
          <div className="absolute inset-0 bg-black/50" onClick={() => setOpen(false)} aria-hidden />
          <aside className="absolute inset-y-0 left-0 h-dvh w-[84%] max-w-[300px] overflow-hidden border-r border-line bg-bg pb-[env(safe-area-inset-bottom)]" role="dialog" aria-modal="true" aria-label="Menú">{sidebar}</aside>
        </div>
      )}
      <div className="min-w-0">
        <header className="sticky top-0 z-20 flex items-center justify-between border-b border-line bg-bg px-4 pb-3 pt-[max(0.75rem,env(safe-area-inset-top))] lg:hidden print:hidden">
          <button onClick={() => setOpen(true)} className="-m-1.5 grid size-11 place-items-center rounded-lg hover:bg-surface-2" aria-label="Abrir menú">
            <Menu className="size-5" />
          </button>
          {brandMark}
          <span className="w-8" />
        </header>
        <main id="main" className="mx-auto w-full max-w-7xl px-4 py-6 sm:px-6 lg:px-10 lg:py-10 print:max-w-none print:p-0">
          {support && (
            <div role="status" className="mb-5 flex flex-wrap items-center gap-3 rounded-2xl border border-info/30 bg-info/5 p-3 text-sm sm:p-4">
              <ShieldCheck className="size-5 shrink-0 text-info" aria-hidden />
              <p className="min-w-0 flex-1">
                <span className="font-medium">Acceso de soporte de solo lectura</span>
                <span className="text-mute"> · caduca {new Date(support.expires_at).toLocaleString("es-ES", { hour: "2-digit", minute: "2-digit", day: "numeric", month: "short" })}. Queda registrado en la auditoría de la organización.</span>
              </p>
              <Link to="/admin" className="text-xs font-semibold text-accent-text hover:underline">Volver al Control Center</Link>
            </div>
          )}
          {suspended ? (
            <div className="mx-auto max-w-xl rounded-3xl border border-line bg-surface p-8 text-center">
              <ShieldAlert className="mx-auto size-10 text-warn" aria-hidden />
              <h1 className="mt-4 font-serif text-4xl leading-none">Organización en pausa</h1>
              <p className="mt-3 text-sm text-mute">
                El acceso a «{current?.name}» está suspendido temporalmente. Tus datos se conservan intactos y nada se ha borrado. Escríbenos a soporte y la reactivaremos en cuanto esté resuelto.
              </p>
              {(me?.memberships.length ?? 0) > 1 && (
                <Link to={`/o/${me!.memberships.find((m) => m.id !== orgId)!.id}`} className="mt-5 inline-flex min-h-10 items-center rounded-full border border-line px-4 text-sm font-semibold hover:bg-surface-2">
                  Ir a otra organización
                </Link>
              )}
            </div>
          ) : gated && !access.bypass ? (
            <PlanLockedPanel orgId={orgId} module={pageModule} plan={access.plan} />
          ) : (
            <>
              {!support && <UsageBanner orgId={orgId} />}
              {gated && <AdminBypassNotice module={pageModule} onViewAsClient={() => access.setViewAsClient(true)} />}
              <ErrorBoundary key={loc.pathname} homeHref={`/app/o/${orgId}`}>
                <Outlet />
              </ErrorBoundary>
            </>
          )}
        </main>
      </div>
    </div>
  );
}

