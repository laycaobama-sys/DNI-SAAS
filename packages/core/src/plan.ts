import type { Opportunity } from "./seo-rules";

/**
 * 30-day Growth Plan generator. Deterministic, editable, never a promise of results.
 * Tasks depending on modules/integrations not available are flagged as blocked, not faked.
 */
export type TaskChannel = "technical" | "brand" | "content" | "geo" | "paid" | "measurement";
export type TaskStatus = "todo" | "doing" | "done" | "dismissed" | "blocked";

export interface PlanTaskDraft {
  title: string;
  description: string;
  channel: TaskChannel;
  week: 1 | 2 | 3 | 4;
  estimateHours: number;
  sourceRule: string | null;
  status: TaskStatus;
  blockedReason: string | null;
  requiresApproval: boolean;
}

const HOURS_BY_EFFORT: Record<number, number> = { 1: 0.5, 2: 2, 3: 6, 4: 12, 5: 24 };

export interface PlanInput {
  opportunities: Opportunity[];
  brandConfirmed: boolean;
  integrations: { searchConsole: boolean; ga4: boolean; meta: boolean; cms: boolean };
}

export function generateGrowthPlan(input: PlanInput): PlanTaskDraft[] {
  const tasks: PlanTaskDraft[] = [];
  if (!input.brandConfirmed) {
    tasks.push({
      title: "Revisar y confirmar el perfil de marca",
      description: "Valida los datos extraídos, completa público objetivo, tono y objetivo comercial. Es la base de todas las recomendaciones.",
      channel: "brand",
      week: 1,
      estimateHours: 0.5,
      sourceRule: null,
      status: "todo",
      blockedReason: null,
      requiresApproval: false,
    });
  }
  input.opportunities.forEach((o, idx) => {
    const week = (o.severity === "critical" || o.severity === "high" || idx < 3 ? 1 : idx < 6 ? 2 : 3) as 1 | 2 | 3;
    const perUrl = HOURS_BY_EFFORT[o.effort] ?? 2;
    const hours = Math.round(Math.min(40, perUrl * Math.max(1, Math.min(o.affectedCount, 10))) * 10) / 10;
    tasks.push({
      title: o.title,
      description: `${o.fix}${o.affectedCount > 0 ? ` Afecta a ${o.affectedCount} URL(s).` : ""}`,
      channel: o.category === "geo" ? "geo" : "technical",
      week,
      estimateHours: hours,
      sourceRule: o.ruleKey,
      status: "todo",
      blockedReason: null,
      requiresApproval: false,
    });
  });
  tasks.push({
    title: "Conectar Google Search Console y GA4",
    description: "Necesario para medir clics, impresiones y tráfico reales antes y después de los cambios.",
    channel: "measurement",
    week: 2,
    estimateHours: 0.5,
    sourceRule: null,
    status: input.integrations.searchConsole && input.integrations.ga4 ? "done" : "blocked",
    blockedReason: input.integrations.searchConsole && input.integrations.ga4 ? null : "Integración disponible en la fase F3 (aún no conectada).",
    requiresApproval: false,
  });
  tasks.push({
    title: "Calendario editorial basado en evidencias",
    description: "Briefs con fuentes, revisión factual y aprobación antes de publicar.",
    channel: "content",
    week: 3,
    estimateHours: 4,
    sourceRule: null,
    status: "blocked",
    blockedReason: "Content Studio llega en la fase F2.",
    requiresApproval: true,
  });
  tasks.push({
    title: "Campaña de captación de prueba con límite de gasto",
    description: "Borrador de campaña con presupuesto máximo, aprobación explícita y kill switch. Nunca se activa sin tu autorización.",
    channel: "paid",
    week: 4,
    estimateHours: 3,
    sourceRule: null,
    status: "blocked",
    blockedReason: input.integrations.meta ? null : "Meta Ads no está conectado (fase F6).",
    requiresApproval: true,
  });
  return tasks;
}

export function planToMarkdown(
  plan: { title: string; createdAt: string; origin: string },
  tasks: Array<PlanTaskDraft & { id?: string }>,
): string {
  const lines = [
    `# ${plan.title}`,
    "",
    `- Sitio: ${plan.origin}`,
    `- Generado: ${plan.createdAt}`,
    "- Naturaleza: planificación editable, **no** promesa de resultados ni de plazos. Las horas son estimaciones.",
    "",
  ];
  for (const w of [1, 2, 3, 4] as const) {
    const wt = tasks.filter((t) => t.week === w);
    if (!wt.length) continue;
    lines.push(`## Semana ${w}`, "");
    for (const t of wt) {
      const box = t.status === "done" ? "[x]" : "[ ]";
      lines.push(`- ${box} **${t.title}** · ${t.channel} · ~${t.estimateHours} h (estimado)${t.status === "blocked" ? ` · BLOQUEADO: ${t.blockedReason}` : ""}`);
      lines.push(`  ${t.description}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}
