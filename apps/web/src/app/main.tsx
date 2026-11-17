import { StrictMode, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Navigate, Outlet, Route, Routes, useLocation, useParams } from "react-router";
import "./styles.css";
import { AuthProvider, useAuth } from "./lib/auth";
import { useTheme } from "./lib/hooks";
import { AppShell } from "./shell";
import { Spinner } from "./ui";
import { ForgotPage, InvitePage, LoginPage, RegisterPage, ResetPage, VerifyPage } from "./pages/auth";
import { DashboardPage, OnboardingPage } from "./pages/dashboard";
import { AnalyzePage, JobPage, JobsPage } from "./pages/analyze";
import { AdvisorPage, CreativePage } from "./pages/ai";
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
  if (!me?.memberships.some((m) => m.id === orgId)) return <NotFoundPage />;
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
          <Route path="team" element={<TeamPage />} />
          <Route path="billing" element={<BillingPage />} />
          <Route path="integrations" element={<IntegrationsPage />} />
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
