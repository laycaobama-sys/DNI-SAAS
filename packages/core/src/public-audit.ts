import { describeEvidence } from "./finding-draft";
import { healthScore, POTENTIAL_RULES, prioritize, RULES, type Category, type Opportunity, type SeoIssue, type Severity } from "./seo-rules";

/**
 * Free audit without an account (Phase 2): the same deterministic rules as the full analysis, on at most
 * PUBLIC_AUDIT_PAGES pages, summarised as a global score plus three pillar scores. Every score is a derived
 * indicator computed from what the crawler observed; it never predicts rankings or AI citations.
 */
export const PUBLIC_AUDIT_PAGES = 5;
export const PUBLIC_AUDIT_TEASER_ITEMS = 3;

export type Pillar = "technical" | "seo" | "geo";

export const PILLAR_CATEGORIES: Record<Pillar, Category[]> = {
  technical: ["indexability", "performance", "security", "structure"],
  seo: ["metadata", "content", "social"],
  geo: ["geo"],
};

export const PILLAR_LABEL: Record<Pillar, string> = { technical: "Técnica", seo: "SEO", geo: "GEO / AEO" };

const PENALTY: Record<Severity, number> = { critical: 20, high: 10, medium: 5, low: 2, info: 0 };

const pillarOf = (c: Category): Pillar => (Object.keys(PILLAR_CATEGORIES) as Pillar[]).find((p) => PILLAR_CATEGORIES[p].includes(c)) ?? "technical";

/** Highest penalty each pillar can lose: the sum over every rule of that pillar (one count per rule). */
function maxPenalty(p: Pillar): number {
  let total = 0;
  for (const [key, r] of Object.entries(RULES)) if (!POTENTIAL_RULES.has(key) && pillarOf(r.category) === p) total += PENALTY[r.severity];
  return total;
}

export const PILLAR_METHOD =
  "Cada área: 100 × (1 − penalización observada ÷ penalización máxima posible de sus reglas), una vez por regla (crítica 20, alta 10, media 5, baja 2, informativa 0), sin contar páginas legales ni el volumen de contenido. Nota global: 100 − Σ penalizaciones (el mismo índice de salud del análisis completo). Indicadores derivados de lo observado en las páginas revisadas: no predicen posiciones en Google ni menciones en asistentes de IA.";

/** Deterministic pillar scores (0–100) from the same issues the full analysis uses. */
export function pillarScores(issues: SeoIssue[]): Record<Pillar, number> {
  const seen = new Set<string>();
  const lost: Record<Pillar, number> = { technical: 0, seo: 0, geo: 0 };
  for (const i of issues) {
    if (seen.has(i.ruleKey) || POTENTIAL_RULES.has(i.ruleKey)) continue;
    if (i.pageType === "legal" && i.ruleKey !== "http_error") continue;
    seen.add(i.ruleKey);
    lost[pillarOf(i.category)] += PENALTY[i.severity];
  }
  const out = {} as Record<Pillar, number>;
  for (const p of Object.keys(lost) as Pillar[]) {
    const max = maxPenalty(p);
    out[p] = max > 0 ? Math.max(0, Math.min(100, Math.round(100 * (1 - lost[p] / max)))) : 100;
  }
  return out;
}

export interface AuditFinding {
  ruleKey: string;
  title: string;
  severity: Severity;
  pillar: Pillar;
  affectedCount: number;
  /** Up to three affected URLs (null for site-wide findings). */
  urls: string[];
  /** Plain-language summary of what the crawler saw on the first affected page. */
  evidence: string;
  fix: string;
}

export interface PublicAuditResult {
  origin: string;
  pagesAnalyzed: number;
  observedAt: string;
  scores: { global: number } & Record<Pillar, number>;
  findings: AuditFinding[];
  method: string;
  measurement: "derived";
}

/** Full result stored for the audit (the teaser only exposes the first PUBLIC_AUDIT_TEASER_ITEMS findings). */
export function buildPublicAuditResult(issues: SeoIssue[], input: { origin: string; pagesAnalyzed: number; observedAt: string }): PublicAuditResult {
  const health = healthScore(issues);
  const opps: Opportunity[] = prioritize(issues.filter((i) => !POTENTIAL_RULES.has(i.ruleKey)), 50);
  const findings = opps
    .filter((o) => !o.legalOnly)
    .map((o) => {
      const first = issues.find((i) => i.ruleKey === o.ruleKey);
      return {
        ruleKey: o.ruleKey,
        title: o.title,
        severity: o.severity,
        pillar: pillarOf(o.category),
        affectedCount: o.affectedCount,
        urls: o.affectedUrls.slice(0, 3),
        evidence: describeEvidence(o.ruleKey, first?.evidence ?? {}).slice(0, 400),
        fix: o.fix,
      };
    });
  return {
    origin: input.origin,
    pagesAnalyzed: input.pagesAnalyzed,
    observedAt: input.observedAt,
    scores: { global: health.score, ...pillarScores(issues) },
    findings,
    method: PILLAR_METHOD,
    measurement: "derived",
  };
}

export interface PublicAuditTeaser extends Omit<PublicAuditResult, "findings"> {
  top: AuditFinding[];
  /** Findings hidden until the visitor creates an account. */
  othersCount: number;
}

export function teaserOf(r: PublicAuditResult): PublicAuditTeaser {
  const { findings, ...rest } = r;
  return { ...rest, top: findings.slice(0, PUBLIC_AUDIT_TEASER_ITEMS), othersCount: Math.max(0, findings.length - PUBLIC_AUDIT_TEASER_ITEMS) };
}

/** Plain-language band for a 0–100 score (shown next to the number, never instead of it). */
export function scoreBand(score: number): "bien" | "mejorable" | "urgente" {
  return score >= 80 ? "bien" : score >= 50 ? "mejorable" : "urgente";
}
