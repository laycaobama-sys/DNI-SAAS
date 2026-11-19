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

export const MODULES: Record<string, { label: string; phase: string; description: string }> = {
  "seo-tecnico": { label: "SEO técnico", phase: "F2", description: "Rastreos programados, histórico, hreflang, enlaces rotos y Core Web Vitals con datos de campo." },
  keywords: { label: "Keywords y competencia", phase: "F2", description: "Investigación por país e idioma con proveedor licenciado. Sin proveedor no mostramos volúmenes ni dificultad." },
  "ai-visibility": { label: "AI Visibility (GEO/AEO)", phase: "F3", description: "Biblioteca de prompts y muestreo en motores de IA solo mediante APIs permitidas, con fecha, idioma y versión." },
  content: { label: "Content Studio", phase: "F2", description: "Briefs con fuentes, editor versionado, revisión factual, aprobación y publicación en tu CMS." },
  authority: { label: "Backlinks / Authority", phase: "F2", description: "Menciones y relaciones editoriales legítimas. Nunca granjas ni intercambios masivos de enlaces." },
  creative: { label: "Creative Studio", phase: "F4", description: "Banners y carruseles con brand kit, capas, safe areas y exportación por formato." },
  video: { label: "Video Studio", phase: "F4", description: "Storyboard, voz con licencia, subtítulos y render asíncrono con coste reservado." },
  ads: { label: "Ads Manager", phase: "F6", description: "Borradores sin gasto, aprobación explícita, Spend Guardian con límites y kill switch." },
  landings: { label: "Landing Pages", phase: "F5", description: "Constructor por bloques, dominio verificado, consentimiento y formularios anti-spam." },
  experiments: { label: "Experiments / CRO", phase: "F7", description: "Tests A/B con hipótesis, muestra mínima y advertencias de significancia." },
  crm: { label: "CRM / Leads", phase: "F5", description: "Leads deduplicados, pipeline, tareas y consentimiento por finalidad." },
  analytics: { label: "Analytics & Revenue", phase: "F3–F7", description: "Search Console, GA4, gasto y ingresos verificados con atribución explícita." },
  agents: { label: "AI Agent Center", phase: "F1+", description: "Historial de cada trabajo de los agentes: entrada, salida, coste y quién lo autorizó." },
  automations: { label: "Automatizaciones", phase: "F5", description: "Flujos con aprobación, límites, horario de silencio y registro." },
  agency: { label: "Agency / White Label", phase: "F8", description: "Subclientes aislados, portal de cliente y marca propia." },
};

type NavItem = { to: string; label: string; icon: typeof Gauge; live?: boolean; end?: boolean };

function navFor(orgId: string): Array<{ section: string; items: NavItem[] }> {
  const o = `/o/${orgId}`;
  const i = (path: string, label: string, icon: typeof Gauge, end?: boolean): NavItem => ({ to: path ? `${o}/${path}` : o, label, icon, live: true, end });
  return [
    { section: "Crecimiento", items: [i("", "Command Center", LayoutDashboard, true), i("analyze", "Nueva auditoría", Sparkles), i("advisor", "Asesor IA", MessageSquareText), i("ai-hub", "Centro de IA", Cpu), i("audits", "Auditoría web", FileSearch), i("brands", "Proyectos y marcas", Building2)] },
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

export function AppShell() {
  const { orgId = "" } = useParams();
  const { me, refresh } = useAuth();
  const { theme, toggle } = useTheme();
  const [open, setOpen] = useState(false);
  const [switcher, setSwitcher] = useState(false);
  const [filter, setFilter] = useState("");
  const loc = useLocation();
  const nav = useNavigate();
  useEffect(() => setOpen(false), [loc.pathname]);
  const current = me?.memberships.find((m) => m.id === orgId);
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
        <button className="rounded-lg p-1.5 text-mute hover:bg-surface-2 lg:hidden" onClick={() => setOpen(false)} aria-label="Cerrar menú">
          <X className="size-5" />
        </button>
      </div>
      <div className="relative px-3 pb-3">
        <button onClick={() => setSwitcher((s) => !s)} className="flex w-full items-center justify-between gap-2 rounded-xl border border-line bg-surface px-3 py-2 text-left text-sm hover:bg-surface-2" aria-expanded={switcher} aria-haspopup="listbox">
          <span className="min-w-0">
            <span className="block truncate font-medium">{current?.name ?? "Organización"}</span>
            <span className="block text-xs text-mute">
              Plan {current?.plan_code ?? "—"} · {current?.role ?? ""}
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
                    {!it.live && <span className="shrink-0 rounded border border-line px-1 text-[10px] text-mute">pronto</span>}
                  </NavLink>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </nav>
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
        <LegalLinks className="mt-2 px-1" />
      </div>
    </div>
  );

  return (
    <div className="min-h-full lg:grid lg:grid-cols-[272px_1fr] print:block" style={accentStyle}>
      <aside className="sticky top-0 hidden h-screen border-r border-line bg-bg lg:block print:hidden">{sidebar}</aside>
      {open && (
        <div className="fixed inset-0 z-40 lg:hidden">
          <div className="absolute inset-0 bg-black/50" onClick={() => setOpen(false)} aria-hidden />
          <aside className="absolute inset-y-0 left-0 w-[84%] max-w-[300px] border-r border-line bg-bg">{sidebar}</aside>
        </div>
      )}
      <div className="min-w-0">
        <header className="sticky top-0 z-20 flex items-center justify-between border-b border-line bg-bg/85 px-4 py-3 backdrop-blur lg:hidden print:hidden">
          <button onClick={() => setOpen(true)} className="rounded-lg p-1.5 hover:bg-surface-2" aria-label="Abrir menú">
            <Menu className="size-5" />
          </button>
          {brandMark}
          <span className="w-8" />
        </header>
        <main id="main" className="mx-auto w-full max-w-7xl px-4 py-6 sm:px-6 lg:px-10 lg:py-10 print:max-w-none print:p-0">
          <Outlet />
        </main>
      </div>
    </div>
  );
}

