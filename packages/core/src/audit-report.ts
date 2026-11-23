import type { OrganicPotential } from "./organic";
import type { Opportunity } from "./seo-rules";

/**
 * Audit report as Markdown (export for every plan, no AI): what was observed, with sources, dates and
 * measurement type for every figure. Never contains invented metrics.
 */
export interface AuditReportInput {
  origin: string;
  crawlId: string;
  observedAt: string;
  pagesCount: number;
  pagesLimit: number;
  health: { score: number | null; method: string | null };
  potential: OrganicPotential;
  checks: { robots: boolean; sitemap: boolean; sitemapUrls: number; https: boolean; llms: boolean };
  opportunities: Array<Pick<Opportunity, "title" | "severity" | "fix" | "affectedCount" | "affectedUrls"> & { estimateHours?: number; legalOnly?: boolean }>;
  issuesCount: number;
  limitations: string[];
}

const SEV: Record<string, string> = { critical: "Crítica", high: "Alta", medium: "Media", low: "Baja", info: "Info" };
const cell = (s: string) => s.replace(/\|/g, "\\|").replace(/\n/g, " ");

export function auditReportMarkdown(r: AuditReportInput): string {
  const day = r.observedAt.slice(0, 10);
  const yes = (b: boolean) => (b ? "Sí" : "No");
  const lines = [
    `# Informe de auditoría · ${new URL(r.origin).hostname}`,
    "",
    `- Sitio: ${r.origin}`,
    `- Fecha del rastreo: ${day} · páginas analizadas: ${r.pagesCount} de un máximo de ${r.pagesLimit}`,
    "- Fuente: rastreo público DNIGrowthBot (respeta robots.txt; solo HTML público)",
    "",
    "## Indicadores",
    "",
    "| Indicador | Valor | Tipo de medida | Método |",
    "|---|---|---|---|",
    `| Salud técnica | ${r.health.score ?? "—"}/100 | derivada | ${cell(r.health.method ?? "")} |`,
    `| Potencial orgánico | ${r.potential.score}/100 (${r.potential.level}) | derivada | ${cell(r.potential.method)} |`,
    "",
    "| Comprobación | Resultado |",
    "|---|---|",
    `| HTTPS | ${yes(r.checks.https)} |`,
    `| robots.txt | ${yes(r.checks.robots)} |`,
    `| Sitemap XML | ${yes(r.checks.sitemap)}${r.checks.sitemap ? ` (${r.checks.sitemapUrls} URLs)` : ""} |`,
    `| llms.txt (opcional) | ${yes(r.checks.llms)} |`,
    "",
    "### Señales del potencial orgánico",
    "",
    "| Señal | Valor | Puntos |",
    "|---|---|---|",
    ...r.potential.signals.map((s) => `| ${cell(s.label)} | ${s.value} | ${s.points}/${s.max} |`),
    "",
    `## Mejoras prioritarias (${r.opportunities.length} de ${r.issuesCount} hallazgos)`,
    "",
    ...r.opportunities.flatMap((o, i) => [
      `### ${i + 1}. ${o.title}`,
      `- Gravedad: ${SEV[o.severity] ?? o.severity} · alcance: ${o.affectedCount ? `${o.affectedCount} URL(s)` : "todo el sitio"}${o.estimateHours ? ` · esfuerzo estimado: ~${o.estimateHours} h` : ""}${o.legalOnly ? " · solo páginas legales (baja prioridad)" : ""}`,
      `- Qué hacer: ${o.fix}`,
      ...(o.affectedUrls?.length ? [`- Evidencia: ${o.affectedUrls.slice(0, 5).join(", ")}${o.affectedUrls.length > 5 ? " …" : ""}`] : []),
      "",
    ]),
    "## Límites de esta medición",
    ...r.limitations.map((l) => `- ${l}`),
    ...r.potential.caveats.map((l) => `- ${l}`),
    "- Las horas son estimaciones orientativas, no un presupuesto.",
    "",
    `Auditoría ${r.crawlId.slice(0, 8)} · generado por DNI Growth sin IA.`,
    "",
  ];
  return lines.join("\n");
}
