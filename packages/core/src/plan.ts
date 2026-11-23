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
    const week = (o.legalOnly ? 4 : o.severity === "critical" || o.severity === "high" || idx < 3 ? 1 : idx < 6 ? 2 : 3) as 1 | 2 | 3 | 4;
    const perUrl = HOURS_BY_EFFORT[o.effort] ?? 2;
    // Prefer the per-rule, per-page-type estimate (template fixes are done once; legal pages weigh little).
    const hours = o.estimateHours ?? Math.round(Math.min(40, perUrl * Math.max(1, Math.min(o.affectedCount, 10))) * 10) / 10;
    tasks.push({
      title: o.title,
      description: `${o.fix}${o.affectedCount > 0 ? ` Afecta a ${o.affectedCount} URL(s).` : ""}`,
      channel: o.category === "geo" ? "geo" : o.category === "content" ? "content" : "technical",
      week,
      estimateHours: hours,
      sourceRule: o.ruleKey,
      status: "todo",
      blockedReason: null,
      requiresApproval: false,
    });
  });
  const gsc = input.integrations.searchConsole;
  const ga4 = input.integrations.ga4;
  const missing = [!gsc && "Search Console", !ga4 && "GA4"].filter(Boolean).join(" y ");
  tasks.push({
    title: "Conectar Google Search Console y GA4",
    description: gsc && ga4
      ? "Conectadas: ya se miden clics, impresiones y tráfico reales antes y después de los cambios."
      : `Pendiente de conectar ${missing} (solo lectura) desde Integraciones. Sin ellas no hay medición real del antes y el después.`,
    channel: "measurement",
    week: 2,
    estimateHours: 0.5,
    sourceRule: null,
    status: gsc && ga4 ? "done" : "todo",
    blockedReason: null,
    requiresApproval: false,
  });
  tasks.push({
    title: "Calendario editorial basado en evidencias",
    description: "Crea un borrador desde cada hallazgo de la auditoría en Content Studio: brief con la evidencia observada, revisión humana y aprobación antes de exportar o publicar.",
    channel: "content",
    week: 3,
    estimateHours: 4,
    sourceRule: null,
    status: "todo",
    blockedReason: null,
    requiresApproval: true,
  });
  tasks.push({
    title: "Campaña de captación de prueba con límite de gasto",
    description: "Borrador de campaña con presupuesto máximo, aprobación explícita y kill switch. Nunca se activa sin tu autorización.",
    channel: "paid",
    week: 4,
    estimateHours: 3,
    sourceRule: null,
    status: input.integrations.meta ? "todo" : "blocked",
    blockedReason: input.integrations.meta ? null : "Pendiente de conectar Meta Ads. Puedes preparar el borrador sin gasto en Ads Manager; publicarlo exige la conexión y tu aprobación.",
    requiresApproval: true,
  });
  return tasks;
}

/** Old plans stored internal phase codes as a block reason ("fase F3"). They are actionable now. */
export const LEGACY_PHASE_BLOCK_RE = /\bfase F\d/i;

export function isLegacyPhaseBlock(task: { status: string; blocked_reason?: string | null }): boolean {
  return task.status === "blocked" && !!task.blocked_reason && LEGACY_PHASE_BLOCK_RE.test(task.blocked_reason);
}

/** Channel names as the interface shows them (exports never carry internal codes). */
export const CHANNEL_ES: Record<string, string> = { technical: "Técnico", brand: "Marca", content: "Contenido", geo: "GEO", paid: "Publicidad", measurement: "Medición" };

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
      lines.push(`- ${box} **${t.title}** · ${CHANNEL_ES[t.channel] ?? "General"} · ~${String(t.estimateHours).replace(".", ",")} h (estimado)${t.status === "blocked" ? ` · BLOQUEADO: ${t.blockedReason}` : ""}`);
      lines.push(`  ${t.description}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}
