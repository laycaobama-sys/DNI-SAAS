import { planIncludes } from "@dni/core";
import { orgPlan } from "./billing";
import { parseJson } from "./util";

/**
 * Guided set-up (Phase 2): six steps whose state is read from real data, never ticked by hand, except the
 * steps a user may skip on purpose (competitors, Google, CMS). A step that the product cannot do yet says so
 * («en desarrollo») instead of pretending.
 */
export const ACTIVATION_STEPS = ["brand", "competitors", "analytics", "cms", "mode", "article"] as const;
export type ActivationStepKey = (typeof ACTIVATION_STEPS)[number];
export const SKIPPABLE_STEPS: ReadonlySet<ActivationStepKey> = new Set(["competitors", "analytics", "cms"]);

export type StepStatus = "done" | "pending" | "skipped" | "unavailable" | "locked";

export interface ActivationStep {
  key: ActivationStepKey;
  title: string;
  description: string;
  status: StepStatus;
  /** App path (inside /app) where the step is done. */
  href: string;
  cta: string;
  note?: string;
}

export interface Activation {
  steps: ActivationStep[];
  done: number;
  total: number;
  percent: number;
  /** First step still pending (null when everything is done, skipped or not available yet). */
  next: ActivationStepKey | null;
  publishingMode: "approval" | "autopilot" | null;
  articlesPerWeek: number | null;
  /** Free audit without an account claimed by this organisation (most recent), if any. */
  publicAudit: { id: string; host: string; status: string } | null;
}

export async function activationFor(db: D1Database, orgId: string): Promise<Activation> {
  const [brand, profile, analytics, cms, onboarding, article, plan, audit] = await Promise.all([
    db.prepare("SELECT id FROM brands WHERE organization_id = ? ORDER BY created_at LIMIT 1").bind(orgId).first<{ id: string }>(),
    db
      .prepare("SELECT brand_id, confirmed_at, competitors_json FROM brand_profiles WHERE organization_id = ? ORDER BY (confirmed_at IS NULL), created_at LIMIT 1")
      .bind(orgId)
      .first<{ brand_id: string; confirmed_at: string | null; competitors_json: string }>(),
    db
      .prepare("SELECT COUNT(*) AS n FROM integrations WHERE organization_id = ? AND provider IN ('google_search_console', 'ga4') AND status = 'connected'")
      .bind(orgId)
      .first<{ n: number }>(),
    db.prepare("SELECT COUNT(*) AS n FROM integrations WHERE organization_id = ? AND provider = 'wordpress' AND status = 'connected'").bind(orgId).first<{ n: number }>(),
    db
      .prepare("SELECT publishing_mode, articles_per_week, skipped_json FROM organization_onboarding WHERE organization_id = ?")
      .bind(orgId)
      .first<{ publishing_mode: "approval" | "autopilot" | null; articles_per_week: number | null; skipped_json: string }>(),
    db.prepare("SELECT COUNT(*) AS n FROM content_items WHERE organization_id = ? AND kind = 'blog_article' AND status != 'archived'").bind(orgId).first<{ n: number }>(),
    orgPlan(db, orgId),
    db
      .prepare("SELECT id, host, status FROM public_audits WHERE claimed_org_id = ? AND is_competitor = 0 ORDER BY claimed_at DESC LIMIT 1")
      .bind(orgId)
      .first<{ id: string; host: string; status: string }>(),
  ]);
  const skipped = new Set(parseJson<string[]>(onboarding?.skipped_json, []));
  const base = `/o/${orgId}`;
  const brandHref = profile ? `${base}/brands/${profile.brand_id}` : brand ? `${base}/brands/${brand.id}` : `${base}/analyze`;
  const competitors = parseJson<unknown[]>(profile?.competitors_json, []);
  const contentAllowed = planIncludes(plan.code, "content");
  const cmsAllowed = planIncludes(plan.code, "cms");
  const st = (key: ActivationStepKey, done: boolean): StepStatus => (done ? "done" : skipped.has(key) ? "skipped" : "pending");

  const steps: ActivationStep[] = [
    {
      key: "brand",
      title: "Confirma tu marca",
      description: profile
        ? "Revisa lo que hemos entendido de tu negocio (qué vendes, a quién y dónde) y confírmalo. Todo lo que hagamos después parte de aquí."
        : "Analiza tu web: con lo que encontremos preparamos una ficha de tu marca para que la revises y la confirmes.",
      status: st("brand", !!profile?.confirmed_at),
      href: profile ? brandHref : `${base}/analyze`,
      cta: profile ? "Revisar y confirmar" : "Analizar mi web",
    },
    {
      key: "competitors",
      title: "Añade tus competidores",
      description: "Indica 2 o 3 webs con las que compites. Las usamos para comparar y para ver si los asistentes de IA los citan a ellos y no a ti.",
      status: st("competitors", competitors.length > 0),
      href: brandHref,
      cta: "Añadir competidores",
    },
    {
      key: "analytics",
      title: "Conecta Google Search Console o Analytics",
      description: "Solo lectura. Así medimos con tus propios datos de Google si los cambios funcionan.",
      status: st("analytics", (analytics?.n ?? 0) > 0),
      href: `${base}/search-console`,
      cta: "Conectar Google",
      note: "Google todavía está revisando nuestra aplicación: al conectar puede mostrarte un aviso de «aplicación no verificada». Solo pedimos permisos de lectura.",
    },
    {
      key: "cms",
      title: "Conecta tu CMS",
      description: "Para publicar en tu web los artículos que apruebes.",
      status: (cms?.n ?? 0) > 0 ? "done" : skipped.has("cms") ? "skipped" : cmsAllowed ? "pending" : "locked",
      href: cmsAllowed ? `${base}/content` : `${base}/billing`,
      cta: cmsAllowed ? "Conectar WordPress" : "Ver planes",
      note: cmsAllowed
        ? "Abre cualquier contenido y usa «Publicar en WordPress» con una contraseña de aplicación. Shopify, Ghost y Webflow están en desarrollo: mientras, exporta en HTML o Markdown."
        : "La publicación en WordPress está incluida desde el plan Starter. Mientras, exporta cada artículo aprobado en HTML o Markdown.",
    },
    {
      key: "mode",
      title: "Elige cómo trabajamos",
      description: "Con aprobación (tú revisas cada pieza antes de publicarla) o piloto automático, y cuántos artículos por semana quieres.",
      status: st("mode", !!onboarding?.publishing_mode),
      href: `${base}/bienvenida?paso=mode`,
      cta: "Elegir modo",
      note: onboarding?.publishing_mode === "autopilot" ? "El piloto automático está en desarrollo: por ahora todo queda en borrador hasta que una persona lo apruebe." : undefined,
    },
    {
      key: "article",
      title: "Crea tu primer artículo",
      description: "Un borrador de artículo para tu blog, escrito por ti o con ayuda de la IA. Nada se publica sin tu aprobación.",
      status: (article?.n ?? 0) > 0 ? "done" : contentAllowed ? "pending" : "locked",
      href: contentAllowed ? `${base}/content` : `${base}/billing`,
      cta: contentAllowed ? "Crear artículo" : "Ver planes",
      note: contentAllowed ? undefined : "El estudio de contenidos está incluido desde el plan Starter (o en la prueba de 7 días de Growth).",
    },
  ];
  const done = steps.filter((s) => s.status === "done").length;
  return {
    steps,
    done,
    total: steps.length,
    percent: Math.round((100 * done) / steps.length),
    next: steps.find((s) => s.status === "pending")?.key ?? null,
    publishingMode: onboarding?.publishing_mode ?? null,
    articlesPerWeek: onboarding?.articles_per_week ?? null,
    publicAudit: audit ?? null,
  };
}
