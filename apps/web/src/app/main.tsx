import { AnalyticsPage } from "./pages/analytics";
import { GeoPage } from "./pages/geo";
import { SearchConsolePage } from "./pages/searchconsole";
import { StrictMode, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Navigate, Outlet, Route, Routes, useLocation, useParams } from "react-router";
import "./styles.css";
import { AuthProvider, useAuth } from "./lib/auth";
import { useTheme } from "./lib/hooks";
import { AppShell } from "./shell";
import { AdminConsolePage } from "./pages/admin";
import { Spinner } from "./ui";
import { ForgotPage, InvitePage, LoginPage, RegisterPage, ResetPage, VerifyPage } from "./pages/auth";
import { DashboardPage, OnboardingPage } from "./pages/dashboard";
import { AnalyzePage, JobPage, JobsPage } from "./pages/analyze";
import { AdvisorPage, CreativePage } from "./pages/ai";
import { AiHubPage } from "./pages/aihub";
import { ReportsPage } from "./pages/reports";
import { CrmPage } from "./pages/crm";
import { LandingsPage } from "./pages/landings";
import { AuthorityPage, KeywordsPage, SeoTecnicoPage } from "./pages/organic";
import { AttributionPage, AutomationsPage } from "./pages/automation";
import { AdsPage, VideoPage } from "./pages/studio";
import { AgencyPage } from "./pages/agency";
import { ContentDetailPage, ContentListPage } from "./pages/content";
import { AuditDetailPage, AuditsPage, BrandPage, BrandsPage, PlanPage } from "./pages/insights";
import { AuditLogPage, BillingPage, IntegrationsPage, ModulePage, NotFoundPage, TeamPage } from "./pages/org";

function FullSpinner() {
  return (
    <div className="grid min-h-full place-items-center">
      <Spinner />
    </div>
  );
}

/** Client-side guard for UX only; the API enforces auth and membership on every request. */
function RequireAuth({ children }: { children: ReactNode }) {
  const { me, loading } = useAuth();
  const loc = useLocation();
  if (loading) return <FullSpinner />;
  if (!me?.user) return <Navigate to={`/login?next=${encodeURIComponent(loc.pathname + loc.search)}`} replace />;
  return <>{children}</>;
}

function Home() {
  const { me } = useAuth();
  const first = me?.memberships[0];
  return <Navigate to={first ? `/o/${first.id}` : "/onboarding"} replace />;
}

function OrgGuard() {
  const { orgId } = useParams();
  const { me } = useAuth();
  // Members, or platform staff with an active (read-only, audited) support grant.
  if (!me?.memberships.some((m) => m.id === orgId) && !me?.supportAccess?.some((s) => s.id === orgId)) return <NotFoundPage />;
  return <Outlet />;
}

function App() {
  useTheme();
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/register" element={<RegisterPage />} />
      <Route path="/verify" element={<VerifyPage />} />
      <Route path="/forgot" element={<ForgotPage />} />
      <Route path="/reset" element={<ResetPage />} />
      <Route path="/invite" element={<InvitePage />} />
      <Route path="/onboarding" element={<RequireAuth><OnboardingPage /></RequireAuth>} />
      <Route path="/" element={<RequireAuth><Home /></RequireAuth>} />
      <Route path="/admin" element={<RequireAuth><AdminConsolePage /></RequireAuth>} />
      <Route path="/o/:orgId" element={<RequireAuth><AppShell /></RequireAuth>}>
        <Route element={<OrgGuard />}>
          <Route index element={<DashboardPage />} />
          <Route path="analyze" element={<AnalyzePage />} />
          <Route path="jobs" element={<JobsPage />} />
          <Route path="jobs/:jobId" element={<JobPage />} />
          <Route path="audits" element={<AuditsPage />} />
          <Route path="audits/:crawlId" element={<AuditDetailPage />} />
          <Route path="brands" element={<BrandsPage />} />
          <Route path="brands/:brandId" element={<BrandPage />} />
          <Route path="plans/:planId" element={<PlanPage />} />
          <Route path="advisor" element={<AdvisorPage />} />
          <Route path="creative" element={<CreativePage />} />
          <Route path="ai-hub" element={<AiHubPage />} />
          <Route path="content" element={<ContentListPage />} />
          <Route path="content/:contentId" element={<ContentDetailPage />} />
          <Route path="team" element={<TeamPage />} />
          <Route path="billing" element={<BillingPage />} />
          <Route path="integrations" element={<IntegrationsPage />} />
          <Route path="search-console" element={<SearchConsolePage />} />
          <Route path="ai-visibility" element={<GeoPage />} />
          <Route path="analytics" element={<AnalyticsPage />} />
          <Route path="reports" element={<ReportsPage />} />
          <Route path="crm" element={<CrmPage />} />
          <Route path="landings" element={<LandingsPage />} />
          <Route path="seo-tecnico" element={<SeoTecnicoPage />} />
          <Route path="keywords" element={<KeywordsPage />} />
          <Route path="authority" element={<AuthorityPage />} />
          <Route path="automations" element={<AutomationsPage />} />
          <Route path="attribution" element={<AttributionPage />} />
          <Route path="ads" element={<AdsPage />} />
          <Route path="video" element={<VideoPage />} />
          <Route path="agency" element={<AgencyPage />} />
          <Route path="audit-log" element={<AuditLogPage />} />
          <Route path="m/:moduleKey" element={<ModulePage />} />
          <Route path="*" element={<NotFoundPage />} />
        </Route>
      </Route>
      <Route path="*" element={<NotFoundPage />} />
    </Routes>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BrowserRouter basename="/app">
      <AuthProvider>
        <App />
      </AuthProvider>
    </BrowserRouter>
  </StrictMode>,
);
