import { useEffect, useState } from "react";
import { Link, NavLink, Outlet, useLocation, useNavigate, useParams } from "react-router";
import {
  BarChart3,
  Bot,
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
import { useTheme } from "./lib/hooks";
import { cx } from "./ui";

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
  const m = (k: string, icon: typeof Gauge): NavItem => ({ to: `${o}/m/${k}`, label: MODULES[k]!.label, icon });
  return [
    { section: "Crecimiento", items: [{ to: o, label: "Command Center", icon: LayoutDashboard, live: true, end: true }, { to: `${o}/analyze`, label: "Nueva auditoría", icon: Sparkles, live: true }, { to: `${o}/advisor`, label: "Asesor IA", icon: MessageSquareText, live: true }, { to: `${o}/ai-hub`, label: "Centro de IA", icon: Cpu, live: true }, { to: `${o}/audits`, label: "Auditoría web", icon: FileSearch, live: true }, { to: `${o}/brands`, label: "Proyectos y marcas", icon: Building2, live: true }] },
    { section: "Orgánico", items: [m("seo-tecnico", Gauge), m("keywords", Search), m("ai-visibility", Bot), { to: `${o}/content`, label: "Content Studio", icon: FileText, live: true }, m("authority", Link2)] },
    { section: "Creatividad y pago", items: [{ to: `${o}/creative`, label: "Creative Studio", icon: Palette, live: true }, m("video", Film), m("ads", Megaphone), m("landings", LayoutTemplate), m("experiments", FlaskConical)] },
    { section: "Ventas y datos", items: [m("crm", Target), m("analytics", BarChart3), { to: `${o}/jobs`, label: "AI Agent Center", icon: Bot, live: true }, m("automations", Workflow)] },
    { section: "Organización", items: [{ to: `${o}/integrations`, label: "Integraciones", icon: Plug, live: true }, { to: `${o}/team`, label: "Equipo y accesos", icon: Users, live: true }, { to: `${o}/billing`, label: "Facturación y créditos", icon: CreditCard, live: true }, m("agency", KeyRound), { to: `${o}/audit-log`, label: "Logs de auditoría", icon: ScrollText, live: true }] },
  ];
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
  const loc = useLocation();
  const nav = useNavigate();
  useEffect(() => setOpen(false), [loc.pathname]);
  const current = me?.memberships.find((m) => m.id === orgId);

  async function logout() {
    await post("/auth/logout").catch(() => null);
    await refresh();
    nav("/login");
  }

  const sidebar = (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between px-4 py-4">
        <Link to={`/o/${orgId}`} aria-label="DNI Growth, Command Center">
          <Logo />
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
      <nav className="flex-1 overflow-y-auto px-3 pb-4" aria-label="Módulos">
        {navFor(orgId).map((g) => (
          <div key={g.section} className="mb-4">
            <p className="px-3 pb-1 text-[11px] font-semibold uppercase tracking-[0.12em] text-mute">{g.section}</p>
            <ul>
              {g.items.map((it) => (
                <li key={it.to}>
                  <NavLink
                    to={it.to}
                    end={it.end}
                    className={({ isActive }) => cx("group flex items-center gap-2.5 rounded-lg px-3 py-1.5 text-sm transition", isActive ? "bg-surface-2 font-medium text-ink" : "text-mute hover:bg-surface-2 hover:text-ink")}
                  >
                    <it.icon className="size-4 shrink-0" aria-hidden />
                    <span className="flex-1 truncate">{it.label}</span>
                    {!it.live && <span className="rounded border border-line px-1 text-[10px] text-mute">pronto</span>}
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
      </div>
    </div>
  );

  return (
    <div className="min-h-full lg:grid lg:grid-cols-[272px_1fr]">
      <aside className="sticky top-0 hidden h-screen border-r border-line bg-bg lg:block">{sidebar}</aside>
      {open && (
        <div className="fixed inset-0 z-40 lg:hidden">
          <div className="absolute inset-0 bg-black/50" onClick={() => setOpen(false)} aria-hidden />
          <aside className="absolute inset-y-0 left-0 w-[84%] max-w-[300px] border-r border-line bg-bg">{sidebar}</aside>
        </div>
      )}
      <div className="min-w-0">
        <header className="sticky top-0 z-20 flex items-center justify-between border-b border-line bg-bg/85 px-4 py-3 backdrop-blur lg:hidden">
          <button onClick={() => setOpen(true)} className="rounded-lg p-1.5 hover:bg-surface-2" aria-label="Abrir menú">
            <Menu className="size-5" />
          </button>
          <Logo />
          <span className="w-8" />
        </header>
        <main id="main" className="mx-auto w-full max-w-7xl px-4 py-6 sm:px-6 lg:px-10 lg:py-10">
          <Outlet />
        </main>
      </div>
    </div>
  );
}

