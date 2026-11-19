import { z } from "zod";

/**
 * Shared, deterministic logic for the F2/F4/F5/F6/F8 modules. Nothing here invents data: keyword
 * volumes, CPC and difficulty are never estimated; opportunities come only from the customer's own
 * Search Console rows or from public pages they choose to compare.
 */

// ── Text → terms ─────────────────────────────────────────────────────────────────────────────────
const STOP = new Set(
  (
    "a al algo algunas algunos ante antes como con contra cual cuando de del desde donde durante e el ella ellas ellos en entre era es esa esas ese eso esos esta estas este esto estos fue ha hay la las le les lo los mas me mi mis muy ni no nos o os otra otro para pero poco por porque que quien se ser si sin sobre su sus tambien te tiene tu tus un una uno unos y ya yo " +
    "the and or of to in for on with at by from is are be as it its this that these those an a your you our we us not can will more most how what why which who when where about into over"
  ).split(" "),
);

export function normalizeKeyword(s: string): string {
  return s
    .normalize("NFKC")
    .toLowerCase()
    .replace(new RegExp("[\\s\\u00a0]+", "g"), " ")
    .trim()
    .slice(0, 120);
}

function stripAccents(s: string) {
  return s.normalize("NFD").replace(new RegExp("[\\u0300-\\u036f]", "g"), "");
}

/** Unigrams and bigrams with counts (stop words removed, ≥ 3 letters). */
export function extractTerms(texts: string[], max = 60): Array<{ term: string; count: number }> {
  const counts = new Map<string, number>();
  for (const t of texts) {
    const words = stripAccents(t.toLowerCase())
      .split(/[^a-z0-9ñ]+/)
      .filter((w) => w.length >= 3 && !STOP.has(w) && !/^\d+$/.test(w));
    for (let i = 0; i < words.length; i++) {
      counts.set(words[i]!, (counts.get(words[i]!) ?? 0) + 1);
      if (i + 1 < words.length) {
        const bi = `${words[i]} ${words[i + 1]}`;
        counts.set(bi, (counts.get(bi) ?? 0) + 1);
      }
    }
  }
  return [...counts.entries()]
    .map(([term, count]) => ({ term, count }))
    .sort((a, b) => b.count - a.count || a.term.localeCompare(b.term))
    .slice(0, max);
}

export type Intent = "informational" | "commercial" | "transactional" | "navigational" | "unclear";
const INTENT_RULES: Array<[Intent, RegExp]> = [
  ["transactional", /\b(comprar|compra|precio|precios|presupuesto|contratar|reservar|oferta|descuento|barato|tarifa|cita|pedido|buy|price|pricing|order|book|quote|hire)\b/],
  ["commercial", /\b(mejor|mejores|comparativa|comparar|vs|opiniones|alternativa|alternativas|top|ranking|review|reviews|best|compare)\b/],
  ["informational", /\b(que|como|por que|cuando|donde|guia|tutorial|ejemplo|ejemplos|significado|definicion|what|how|why|guide|tips|ideas)\b/],
  ["navigational", /\b(login|acceso|entrar|iniciar sesion|contacto|telefono|direccion|horario|web oficial)\b/],
];
/** Heuristic intent from the words used (labelled as such in the UI). */
export function classifyIntent(keyword: string): Intent {
  const k = stripAccents(keyword.toLowerCase());
  for (const [intent, re] of INTENT_RULES) if (re.test(k)) return intent;
  return "unclear";
}

// ── Search Console opportunities (derived from the customer's own observed rows) ───────────────
export interface GscRow {
  key: string;
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
}
export type GscOpportunity = "striking_distance" | "low_ctr" | "top_position" | "low_visibility";
export function gscOpportunities(r: GscRow): GscOpportunity[] {
  const tags: GscOpportunity[] = [];
  if (r.position <= 3) tags.push("top_position");
  if (r.position > 3 && r.position <= 20 && r.impressions >= 10) tags.push("striking_distance");
  // Conservative: flag only clearly low CTR for a first-page average position.
  if (r.position <= 10 && r.impressions >= 50 && r.ctr < 0.01) tags.push("low_ctr");
  if (r.position > 20) tags.push("low_visibility");
  return tags;
}

/** Terms a competitor page uses that do not appear anywhere in the customer's crawled pages. */
export function contentGap(competitor: Array<{ term: string; count: number }>, ownTexts: string[], max = 25) {
  const own = new Set(extractTerms(ownTexts, 2000).map((t) => t.term));
  return competitor.filter((t) => !own.has(t.term)).slice(0, max);
}

// ── Backlinks ─────────────────────────────────────────────────────────────────────────────────────
const httpUrl = z
  .string()
  .trim()
  .max(1000)
  .refine((v) => {
    try {
      const u = new URL(v);
      return u.protocol === "https:" || u.protocol === "http:";
    } catch {
      return false;
    }
  }, "URL no válida (http/https).");
export const BacklinkInput = z.strictObject({ sourceUrl: httpUrl, targetUrl: httpUrl, anchor: z.string().trim().max(200).optional(), notes: z.string().trim().max(500).optional() });
export type BacklinkInput = z.infer<typeof BacklinkInput>;

/** «origen,destino[,ancla]» per line; header row and blank lines ignored. Returns valid rows + line errors. */
export function parseBacklinkCsv(text: string, max = 500): { rows: BacklinkInput[]; errors: Array<{ line: number; error: string }> } {
  const rows: BacklinkInput[] = [];
  const errors: Array<{ line: number; error: string }> = [];
  const lines = text.split(/\r?\n/);
  lines.forEach((raw, i) => {
    const line = raw.trim();
    if (!line || /^(source|origen|url)/i.test(line)) return;
    const cells = line.split(/[;,\t]/).map((c) => c.trim().replace(/^"|"$/g, ""));
    const r = BacklinkInput.safeParse({ sourceUrl: cells[0] ?? "", targetUrl: cells[1] ?? "", anchor: cells[2] || undefined });
    if (r.success) {
      if (rows.length < max) rows.push(r.data);
    } else errors.push({ line: i + 1, error: r.error.issues[0]?.message ?? "Fila no válida" });
  });
  return { rows, errors };
}

/** Finds a link to the target (same host; same path prefix when the target has one). */
export function findLink(links: Array<{ href: string; text: string; rel: string }>, targetUrl: string): { found: boolean; rel: string | null; anchor: string | null } {
  let t: URL;
  try {
    t = new URL(targetUrl);
  } catch {
    return { found: false, rel: null, anchor: null };
  }
  const host = t.host.replace(/^www\./, "");
  const path = t.pathname.replace(/\/$/, "");
  for (const l of links) {
    try {
      const u = new URL(l.href);
      if (u.host.replace(/^www\./, "") !== host) continue;
      if (path && !u.pathname.replace(/\/$/, "").startsWith(path)) continue;
      return { found: true, rel: l.rel || null, anchor: l.text || null };
    } catch {
      /* ignore */
    }
  }
  return { found: false, rel: null, anchor: null };
}

// ── Automation engine ────────────────────────────────────────────────────────────────────────────
export const AUTOMATION_TRIGGERS = ["lead_created", "stage_changed", "task_overdue"] as const;
export const AutomationCondition = z.discriminatedUnion("field", [
  z.strictObject({ field: z.literal("form_id"), op: z.literal("eq"), value: z.string().uuid() }),
  z.strictObject({ field: z.literal("utm_source"), op: z.enum(["eq", "contains"]), value: z.string().trim().min(1).max(100) }),
  z.strictObject({ field: z.literal("stage"), op: z.literal("eq"), value: z.enum(["new", "contacted", "qualified", "proposal", "won", "lost"]) }),
  z.strictObject({ field: z.literal("value_eur"), op: z.literal("gte"), value: z.number().min(0).max(100_000_000) }),
  z.strictObject({ field: z.literal("consent_marketing"), op: z.literal("eq"), value: z.boolean() }),
]);
export type AutomationCondition = z.infer<typeof AutomationCondition>;

const httpsOnly = z
  .string()
  .trim()
  .max(500)
  .refine((v) => {
    try {
      return new URL(v).protocol === "https:";
    } catch {
      return false;
    }
  }, "El webhook debe ser una URL https://");
export const AutomationAction = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("create_task"), title: z.string().trim().min(3).max(200), dueHours: z.number().int().min(1).max(720).default(24), assignTo: z.string().uuid().nullable().optional() }),
  z.strictObject({ type: z.literal("set_stage"), stage: z.enum(["new", "contacted", "qualified", "proposal", "won", "lost"]) }),
  z.strictObject({ type: z.literal("assign"), userId: z.string().uuid() }),
  z.strictObject({ type: z.literal("notify_team"), message: z.string().trim().min(3).max(300) }),
  z.strictObject({ type: z.literal("webhook"), url: httpsOnly }),
]);
export type AutomationAction = z.infer<typeof AutomationAction>;

export const AutomationRuleInput = z.strictObject({
  name: z.string().trim().min(3).max(120),
  trigger: z.enum(AUTOMATION_TRIGGERS),
  conditions: z.array(AutomationCondition).max(10).default([]),
  actions: z.array(AutomationAction).min(1, "Añade al menos una acción.").max(5),
  enabled: z.boolean().default(false),
});
export type AutomationRuleInput = z.infer<typeof AutomationRuleInput>;

export interface AutomationSubject {
  formId?: string | null;
  utmSource?: string | null;
  stage?: string | null;
  valueEur?: number | null;
  consentMarketing?: boolean | null;
}
export function matchesConditions(conds: AutomationCondition[], s: AutomationSubject): boolean {
  return conds.every((c) => {
    switch (c.field) {
      case "form_id":
        return s.formId === c.value;
      case "utm_source": {
        const v = (s.utmSource ?? "").toLowerCase();
        return c.op === "eq" ? v === c.value.toLowerCase() : v.includes(c.value.toLowerCase());
      }
      case "stage":
        return s.stage === c.value;
      case "value_eur":
        return (s.valueEur ?? 0) >= c.value;
      case "consent_marketing":
        return !!s.consentMarketing === c.value;
    }
  });
}

/** HMAC-SHA256 signature header value «t=<unix>,v1=<hex>» over «<t>.<body>». */
export async function signWebhook(secret: string, body: string, t = Math.floor(Date.now() / 1000)): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${t}.${body}`));
  return `t=${t},v1=${[...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

// ── Ads drafts + Spend Guardian ─────────────────────────────────────────────────────────────────
export const AdCampaignInput = z.strictObject({
  name: z.string().trim().min(3).max(120),
  platform: z.enum(["meta", "google", "tiktok", "linkedin"]),
  objective: z.enum(["leads", "traffic", "awareness", "sales"]),
  dailyBudgetEur: z.number().min(1).max(100_000),
  startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  audience: z
    .strictObject({ locations: z.array(z.string().trim().max(80)).max(20).default([]), ageMin: z.number().int().min(18).max(65).default(18), ageMax: z.number().int().min(18).max(65).default(65), interests: z.array(z.string().trim().max(80)).max(20).default([]), notes: z.string().trim().max(500).optional() })
    .default({ locations: [], ageMin: 18, ageMax: 65, interests: [] }),
  landingId: z.string().uuid().nullable().optional(),
  destinationUrl: httpsOnly.nullable().optional(),
  notes: z.string().trim().max(1000).optional(),
});
export type AdCampaignInput = z.infer<typeof AdCampaignInput>;
export const AdCreativeInput = z.strictObject({
  format: z.enum(["1:1", "4:5", "9:16", "16:9"]),
  headline: z.string().trim().min(2).max(60),
  primaryText: z.string().trim().min(2).max(500),
  description: z.string().trim().max(90).optional(),
  cta: z.enum(["Más información", "Reservar", "Contactar", "Comprar", "Registrarse", "Solicitar presupuesto"]),
  mediaId: z.string().uuid().nullable().optional(),
});
export type AdCreativeInput = z.infer<typeof AdCreativeInput>;

/** Spend Guardian check of a PROPOSED budget (nothing is ever spent from DNI Growth without a connector). */
export function spendGuardianCheck(g: { maxDailyCents: number; maxCampaignDailyCents: number; killSwitch: boolean }, campaignDailyCents: number, otherApprovedDailyCents: number): string[] {
  const problems: string[] = [];
  if (g.killSwitch) problems.push("El interruptor de emergencia está activado: no se puede aprobar ninguna campaña.");
  if (g.maxCampaignDailyCents > 0 && campaignDailyCents > g.maxCampaignDailyCents) problems.push(`Supera el máximo diario por campaña (${(g.maxCampaignDailyCents / 100).toFixed(2)} €).`);
  if (g.maxDailyCents > 0 && campaignDailyCents + otherApprovedDailyCents > g.maxDailyCents) problems.push(`Con las campañas ya aprobadas se superaría el máximo diario de la organización (${(g.maxDailyCents / 100).toFixed(2)} €).`);
  if (g.maxDailyCents === 0) problems.push("Define primero el presupuesto máximo diario de la organización en Spend Guardian.");
  return problems;
}

export function utmCampaignSlug(name: string): string {
  return stripAccents(name.toLowerCase())
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

// ── Video Studio project ────────────────────────────────────────────────────────────────────────
export const VideoScene = z.strictObject({
  id: z.string().min(1).max(40),
  durationMs: z.number().int().min(500).max(60_000),
  background: z.string().regex(/^#[0-9a-fA-F]{6}$/).default("#111113"),
  mediaId: z.string().uuid().nullable().optional(),
  mediaSource: z.enum(["upload", "generated"]).nullable().optional(),
  fit: z.enum(["cover", "contain"]).default("cover"),
  title: z.string().max(120).default(""),
  body: z.string().max(400).default(""),
  textColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).default("#ffffff"),
  textPosition: z.enum(["top", "center", "bottom"]).default("center"),
  transition: z.enum(["none", "fade", "slide"]).default("fade"),
  caption: z.string().max(300).default(""),
});
export type VideoScene = z.infer<typeof VideoScene>;
export const VideoProject = z.strictObject({
  scenes: z.array(VideoScene).min(1).max(40),
  audioId: z.string().uuid().nullable().optional(),
  audioVolume: z.number().min(0).max(1).default(0.8),
  burnCaptions: z.boolean().default(true),
  font: z.enum(["system", "serif", "mono"]).default("system"),
});
export type VideoProject = z.infer<typeof VideoProject>;

function srtTime(ms: number) {
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  const r = ms % 1000;
  const p = (n: number, l = 2) => String(n).padStart(l, "0");
  return `${p(h)}:${p(m)}:${p(s)},${p(r, 3)}`;
}
/** SRT from scene captions, timed exactly on the scene boundaries used by the renderer. */
export function projectToSrt(p: VideoProject): string {
  let t = 0;
  let n = 0;
  const out: string[] = [];
  for (const s of p.scenes) {
    if (s.caption.trim()) out.push(`${++n}\n${srtTime(t)} --> ${srtTime(t + s.durationMs)}\n${s.caption.trim()}\n`);
    t += s.durationMs;
  }
  return out.join("\n");
}
export const projectDurationMs = (p: VideoProject) => p.scenes.reduce((a, s) => a + s.durationMs, 0);

// ── White label ─────────────────────────────────────────────────────────────────────────────────
export const BrandingInput = z.strictObject({
  displayName: z.string().trim().min(2).max(80).nullable().optional(),
  logoUrl: httpsOnly.nullable().optional(),
  accent: z.string().regex(/^#[0-9a-fA-F]{6}$/).nullable().optional(),
  reportFooter: z.string().trim().max(300).nullable().optional(),
  supportEmail: z.email().max(254).nullable().optional(),
});
export type BrandingInput = z.infer<typeof BrandingInput>;
