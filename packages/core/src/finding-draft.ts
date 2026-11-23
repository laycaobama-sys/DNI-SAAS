import type { ContentKind } from "./content";
import { classifyPage, PAGE_TYPE_LABEL, type PageType } from "./organic";
import { RULES } from "./seo-rules";

/**
 * Deterministic drafts (no AI, no credits): an audit finding becomes an editable brief with the observed
 * evidence, the proposed change and how to verify it. Works with every connector off and every AI quota spent.
 * Nothing here is invented: unknown values are left as [COMPLETAR: …] for a person to fill in.
 */

export interface FindingEvidence {
  url: string | null;
  evidence: Record<string, unknown>;
}

export interface FindingDraftInput {
  ruleKey: string;
  severity: string;
  origin: string;
  crawlId: string;
  observedAt: string;
  items: FindingEvidence[];
  brandName?: string | null;
  /** Topics/services the user confirmed or that came from the brand profile (with their source). */
  topics?: string[];
}

export interface FindingDraft {
  kind: ContentKind;
  title: string;
  keyword: string;
  bodyMd: string;
  finding: {
    ruleKey: string;
    title: string;
    severity: string;
    crawlId: string;
    origin: string;
    observedAt: string;
    urls: string[];
    pageTypes: Partial<Record<PageType, number>>;
    measurement: "observed";
    source: string;
  };
}

export const PLACEHOLDER_RE = /\[(COMPLETAR|VERIFICAR)[^\]]*\]/g;
const SEVERITY_ES: Record<string, string> = { critical: "Crítica", high: "Alta", medium: "Media", low: "Baja", info: "Informativa" };
const ENTITY_RULES = new Set(["structured_data_missing", "organization_schema_missing", "jsonld_invalid", "llms_txt_missing"]);
const CONTENT_RULES = new Set(["site_sparse", "no_content_section", "thin_content"]);

export function kindForRule(ruleKey: string): ContentKind {
  if (CONTENT_RULES.has(ruleKey)) return "blog_article";
  if (ENTITY_RULES.has(ruleKey)) return "entity_summary";
  return "meta_tags";
}

const fmtDay = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toISOString().slice(0, 10);
};
const q = (v: unknown) => (typeof v === "string" ? `«${v.replace(/\s+/g, " ").slice(0, 200)}»` : String(v));
const esc = (s: string) => s.replace(/\|/g, "\\|").replace(/\n/g, " ");

/** Plain-language summary of one evidence object (what the crawler actually saw). */
export function describeEvidence(ruleKey: string, e: Record<string, unknown>): string {
  const parts: string[] = [];
  const pick = (k: string, label: string, fmt: (v: unknown) => string = String) => {
    if (e[k] !== undefined && e[k] !== null && e[k] !== "") parts.push(`${label}: ${fmt(e[k])}`);
  };
  pick("status", "HTTP");
  pick("title", "título actual", q);
  pick("description", "descripción actual", q);
  pick("length", "caracteres");
  pick("count", "repeticiones");
  pick("metaRobots", "meta robots", q);
  pick("canonical", "canónica", q);
  pick("durationMs", "tiempo de respuesta (ms)");
  pick("wordCount", "palabras");
  pick("ogImage", "og:image", q);
  pick("format", "formato");
  if (typeof e["width"] === "number" && typeof e["height"] === "number") parts.push(`tamaño: ${e["width"]}×${e["height"]} px`);
  if (Array.isArray(e["missing"]) && e["missing"].length) parts.push(`faltan: ${(e["missing"] as string[]).map((k) => `og:${k}`).join(", ")}`);
  if (Array.isArray(e["problems"])) parts.push((e["problems"] as string[]).join(" "));
  if (Array.isArray(e["examples"]) && e["examples"].length) parts.push(`ejemplos: ${(e["examples"] as string[]).slice(0, 3).join(", ")}`);
  if (typeof e["total"] === "number") parts.push(`imágenes en la página: ${e["total"]}`);
  if (Array.isArray(e["jsonLdTypes"])) parts.push(`datos estructurados presentes: ${(e["jsonLdTypes"] as string[]).join(", ") || "ninguno"}`);
  pick("contentPages", "páginas con contenido");
  pick("sitemapUrlCount", "URLs en el sitemap");
  pick("articlePages", "artículos detectados");
  if (typeof e["checked"] === "string") parts.push(`comprobado: ${e["checked"]}`);
  if (!parts.length) parts.push(RULES[ruleKey]?.title ?? ruleKey);
  return parts.join(" · ");
}

function proposal(ruleKey: string, items: FindingEvidence[], origin: string, input: FindingDraftInput): string[] {
  const urls = items.map((i) => i.url).filter((u): u is string => !!u);
  const perUrl = (fn: (url: string, e: Record<string, unknown>) => string[]) => items.filter((i) => i.url).slice(0, 15).flatMap((i) => fn(i.url!, i.evidence));
  switch (ruleKey) {
    case "title_missing":
    case "title_too_long":
    case "title_too_short":
    case "title_multiple":
    case "duplicate_titles":
      return perUrl((u, e) => [`- ${u}`, `  - Actual: ${e["title"] ? q(e["title"]) : "sin título"}`, "  - Propuesto: [COMPLETAR: título único de 30–60 caracteres con el término principal de esta página]"]);
    case "meta_description_missing":
    case "meta_description_too_long":
    case "meta_description_too_short":
    case "duplicate_descriptions":
      return perUrl((u, e) => [`- ${u}`, `  - Actual: ${e["description"] ? q(e["description"]) : "sin descripción"}`, "  - Propuesta: [COMPLETAR: 70–160 caracteres: qué ofreces, para quién y una llamada a la acción]"]);
    case "h1_missing":
    case "h1_multiple":
      return perUrl((u) => [`- ${u}: un único H1 visible → [COMPLETAR: tema principal de la página]`]);
    case "images_missing_alt":
      return perUrl((u, e) => [`- ${u}`, ...((e["examples"] as string[] | undefined) ?? []).slice(0, 5).map((src) => `  - ${src} → alt="[COMPLETAR: describe lo que muestra; alt="" si es decorativa]"`)]);
    case "og_missing":
      return [
        "En la plantilla de las páginas afectadas:",
        "```html",
        '<meta property="og:title" content="[COMPLETAR: título para compartir]">',
        '<meta property="og:description" content="[COMPLETAR: resumen de 1–2 frases]">',
        '<meta property="og:image" content="[COMPLETAR: URL absoluta de un PNG o JPG de 1200×630]">',
        "```",
      ];
    case "og_image_format": {
      const e = items[0]?.evidence ?? {};
      return [
        `Sustituir la imagen actual ${e["ogImage"] ? q(e["ogImage"]) : ""} por una imagen PNG, JPG o WebP de al menos 1200×630 px y menos de 5 MB:`,
        "```html",
        '<meta property="og:image" content="[COMPLETAR: URL absoluta, p. ej. https://tu-dominio/og.png]">',
        '<meta property="og:image:width" content="1200">',
        '<meta property="og:image:height" content="630">',
        '<meta property="og:image:alt" content="[COMPLETAR: qué muestra la imagen]">',
        "```",
      ];
    }
    case "canonical_missing":
    case "canonical_multiple":
      return perUrl((u) => ["```html", `<link rel="canonical" href="${u}">`, "```", `(una sola etiqueta en ${u}; comprueba que es la versión preferida)`]);
    case "canonical_cross_domain":
      return perUrl((u, e) => [`- ${u}: la canónica apunta a ${q(e["canonical"])}. [VERIFICAR: ¿es intencionado? Si no, apúntala a ${u}]`]);
    case "lang_missing":
      return ["```html", '<html lang="[COMPLETAR: idioma, p. ej. es]">', "```"];
    case "viewport_missing":
      return ["```html", '<meta name="viewport" content="width=device-width, initial-scale=1">', "```"];
    case "noindex":
      return perUrl((u, e) => [`- ${u}: meta robots actual ${q(e["metaRobots"])}. [VERIFICAR: ¿debe aparecer en buscadores? Si sí, elimina «noindex»]`]);
    case "http_error":
      return perUrl((u, e) => [`- ${u} responde HTTP ${e["status"]}: redirige con 301 a [COMPLETAR: URL equivalente] o quita los enlaces internos que apuntan aquí.`]);
    case "sitemap_missing":
      return [`Publicar ${origin}/sitemap.xml con las URLs indexables y declararlo en robots.txt:`, "```text", `Sitemap: ${origin}/sitemap.xml`, "```", "Un sitemap ayuda a descubrir URLs; no garantiza su indexación."];
    case "robots_missing":
      return [`Publicar ${origin}/robots.txt:`, "```text", "User-agent: *", "Allow: /", `Sitemap: ${origin}/sitemap.xml`, "```"];
    case "llms_txt_missing":
      return [`Opcional (convención emergente, no estándar): publicar ${origin}/llms.txt:`, "```markdown", `# ${input.brandName ?? "[COMPLETAR: nombre de la marca]"}`, "", "> [COMPLETAR: qué hace la empresa, para quién y dónde, en 2 frases verificables]", "", "## Páginas clave", `- [Inicio](${origin}/)`, "- [COMPLETAR: servicio principal](URL)", "```"];
    case "structured_data_missing":
    case "organization_schema_missing":
    case "jsonld_invalid":
      return [
        "JSON-LD que refleje solo contenido visible y real (no promete resultados enriquecidos: Google decide si los muestra):",
        "```json",
        JSON.stringify({ "@context": "https://schema.org", "@type": "Organization", name: input.brandName ?? "[COMPLETAR: nombre]", url: `${origin}/`, logo: "[COMPLETAR: URL del logo]", sameAs: ["[COMPLETAR: perfiles oficiales]"] }, null, 2),
        "```",
        ...(urls.length ? [`Páginas: ${urls.slice(0, 10).join(", ")}`] : []),
      ];
    case "site_sparse":
    case "no_content_section":
    case "thin_content": {
      const topics = (input.topics ?? []).slice(0, 5);
      return [
        "Plan de contenidos con páginas útiles y propias (sin relleno ni texto masivo generado):",
        "",
        "| Página o artículo | Pregunta real que responde | Fuente o experiencia propia |",
        "|---|---|---|",
        ...(topics.length ? topics.map((t) => `| ${esc(t)} | [COMPLETAR] | [COMPLETAR] |`) : ["| [COMPLETAR: servicio principal] | [COMPLETAR] | [COMPLETAR] |", "| [COMPLETAR: pregunta frecuente de clientes] | [COMPLETAR] | [COMPLETAR] |"]),
        "",
        `Ubicación sugerida: ${origin}/blog/ o ${origin}/recursos/ [VERIFICAR: encaja con tu web]`,
      ];
    }
    case "slow_response":
      return perUrl((u, e) => [`- ${u}: ${e["durationMs"]} ms en una medición puntual. [VERIFICAR: confírmalo con PageSpeed Insights o CrUX antes de cambiar el hosting]`]);
    default:
      return [RULES[ruleKey]?.fix ?? "[COMPLETAR: cambio propuesto]"];
  }
}

export function buildFindingDraft(input: FindingDraftInput): FindingDraft {
  const rule = RULES[input.ruleKey];
  const title = rule?.title ?? input.ruleKey;
  const day = fmtDay(input.observedAt);
  const urls = [...new Set(input.items.map((i) => i.url).filter((u): u is string => !!u))];
  const pageTypes: Partial<Record<PageType, number>> = {};
  for (const u of urls) {
    const t = classifyPage(u, `${input.origin}/`);
    pageTypes[t] = (pageTypes[t] ?? 0) + 1;
  }
  const typesText = Object.entries(pageTypes).map(([k, n]) => `${PAGE_TYPE_LABEL[k as PageType]}: ${n}`).join(", ");
  const source = "Rastreo público DNIGrowthBot";
  const lines = [
    `# Corrección: ${title}`,
    "",
    `> Borrador creado sin IA a partir de la auditoría de ${input.origin} del ${day}. Completa los campos [COMPLETAR] y revisa los [VERIFICAR] antes de enviarlo a aprobación.`,
    "",
    "## Qué hemos observado",
    `- Problema: ${title} · gravedad ${SEVERITY_ES[input.severity] ?? input.severity}`,
    `- Alcance: ${urls.length ? `${urls.length} URL(s)${typesText ? ` (${typesText})` : ""}` : "todo el sitio"}`,
    ...(pageTypes.legal && Object.keys(pageTypes).length === 1 ? ["- Solo afecta a páginas legales: apenas influye en el crecimiento; corrígelo cuando haya hueco."] : []),
    "",
    "## Por qué importa",
    rule?.fix ?? "",
    "",
    "## Cambio propuesto",
    ...proposal(input.ruleKey, input.items, input.origin, input),
    "",
    "## Cómo comprobarlo",
    "- Aplica el cambio en tu web o CMS.",
    "- Vuelve a lanzar la auditoría en DNI Growth: el hallazgo debe desaparecer de la lista.",
    ...(input.ruleKey.startsWith("og_") ? ["- Prueba la vista previa compartiendo el enlace en una conversación privada."] : []),
    "- Ningún cambio garantiza posiciones en buscadores ni menciones en motores de IA.",
    "",
    "## Evidencia (anexo)",
    `Fuente: ${source} · observado el ${day} · tipo de medida: observada · auditoría ${input.crawlId.slice(0, 8)}`,
    "",
    "| URL | Tipo de página | Dato observado |",
    "|---|---|---|",
    ...input.items.slice(0, 25).map((i) => `| ${i.url ? esc(i.url) : "Todo el sitio"} | ${i.url ? PAGE_TYPE_LABEL[classifyPage(i.url, `${input.origin}/`)] : "—"} | ${esc(describeEvidence(input.ruleKey, i.evidence))} |`),
    ...(input.items.length > 25 ? [`| … | | ${input.items.length - 25} URL(s) más en la auditoría |`] : []),
    "",
  ];
  return {
    kind: kindForRule(input.ruleKey),
    title: `Corrección: ${title}`.slice(0, 160),
    keyword: "",
    bodyMd: lines.join("\n"),
    finding: { ruleKey: input.ruleKey, title, severity: input.severity, crawlId: input.crawlId, origin: input.origin, observedAt: input.observedAt, urls: urls.slice(0, 50), pageTypes, measurement: "observed", source },
  };
}

/* ------------------------------------------------------------------------------------------------ */

const MANUAL_SKELETON: Record<ContentKind, string[]> = {
  blog_article: ["# [COMPLETAR: título con el tema principal]", "", "[COMPLETAR: responde la pregunta principal en 2–3 frases]", "", "## [COMPLETAR: primer apartado]", "", "## [COMPLETAR: segundo apartado]", "", "## Fuentes y supuestos", "- [COMPLETAR: de dónde sale cada dato]"],
  landing_copy: ["# [COMPLETAR: titular de máximo 10 palabras]", "", "[COMPLETAR: subtítulo]", "", "## Beneficios", "- [COMPLETAR]", "- [COMPLETAR]", "- [COMPLETAR]", "", "## Preguntas frecuentes", "- [COMPLETAR]", "", "## Llamada a la acción", "[COMPLETAR]"],
  faq_aeo: ["# Preguntas frecuentes", "", "## [COMPLETAR: pregunta real de un cliente]", "[COMPLETAR: respuesta directa en 2–4 frases]", "", "## Fuentes y supuestos", "- [COMPLETAR]"],
  meta_tags: ["# Metadatos", "", "- Título: [COMPLETAR: 30–60 caracteres]", "- Meta description: [COMPLETAR: 70–160 caracteres]", "- og:title: [COMPLETAR]", "- og:image: [COMPLETAR: PNG o JPG de 1200×630]"],
  social_post: ["[COMPLETAR: texto de la publicación]", "", "[COMPLETAR: llamada a la acción]"],
  entity_summary: ["# [COMPLETAR: nombre de la marca]", "", "[COMPLETAR: qué hace, para quién y dónde, en 2 frases verificables]", "", "## Datos verificables", "- [COMPLETAR]"],
};

/** A blank, structured draft for writing by hand (no AI): used when AI is off or the quota is spent. */
export function manualDraftBody(kind: ContentKind, title: string): string {
  const s = [...MANUAL_SKELETON[kind]];
  if (s[0]?.startsWith("# [COMPLETAR")) s[0] = `# ${title}`;
  return s.join("\n");
}

/* ------------------------------------------------------------------------------------------------ */

export interface DraftCheck {
  key: string;
  level: "blocking" | "needs_ack";
  message: string;
  samples: string[];
}

/**
 * Text the editor wrote: code blocks are dropped, and inside the evidence appendix only the observed data
 * (source line and table rows) is dropped — anything the editor adds after it is still checked.
 */
const strip = (md: string) => {
  const [body, ...rest] = md.replace(/```[\s\S]*?```/g, " ").split(/\n## Evidencia \(anexo\)/);
  const appendix = rest.join("\n").split("\n").filter((l) => !/^\s*(\||Fuente: )/.test(l));
  return [body, ...appendix].join("\n");
};

/**
 * Deterministic pre-approval checks. `blocking` cannot be approved (unfinished placeholders, guarantees);
 * `needs_ack` can be approved only with an explicit, audited acknowledgement (unsourced figures, prices that
 * do not appear in the brand's verified offers).
 */
export function checkDraft(bodyMd: string, opts: { knownPrices?: string[] } = {}): DraftCheck[] {
  const out: DraftCheck[] = [];
  const placeholders = [...new Set(bodyMd.match(PLACEHOLDER_RE) ?? [])];
  if (placeholders.length) out.push({ key: "placeholders", level: "blocking", message: `Quedan ${placeholders.length} campo(s) por completar o verificar.`, samples: placeholders.slice(0, 5) });
  const text = strip(bodyMd);
  const guarantees = text.match(/[^.\n]*\b(garantiza\w*|garantía de (posici\w+|resultados|ventas|tráfico)|asegura(mos)? (el )?(primer|top)|resultados garantizados)\b[^.\n]*/gi) ?? [];
  // "Ningún cambio garantiza…" is the honest disclaimer, not a promise.
  const promises = guarantees.filter((g) => !/\b(ning[uú]n[ao]?|no|nunca|sin|nada)\b[^.]{0,40}garant/i.test(g));
  if (promises.length) out.push({ key: "guarantees", level: "blocking", message: "Promete resultados garantizados: elimínalo (ningún cambio garantiza posiciones, tráfico ni ventas).", samples: promises.slice(0, 3).map((s) => s.trim().slice(0, 160)) });
  const figures = text.match(/[^.\n]{0,60}\b\d+(?:[.,]\d+)?\s?(%|por ciento|x más|veces más)[^.\n]{0,40}/gi) ?? [];
  const unsourced = figures.filter((f) => !/(fuente|según|datos de|search console|analytics|ga4|evidencia)/i.test(f));
  if (unsourced.length) out.push({ key: "figures", level: "needs_ack", message: "Hay cifras sin fuente. Añade de dónde salen o elimínalas.", samples: unsourced.slice(0, 3).map((s) => s.trim().slice(0, 160)) });
  const known = (opts.knownPrices ?? []).map((p) => p.replace(/[^\d,.]/g, "").replace(",", "."));
  const prices = [...text.matchAll(/(\d{1,6}(?:[.,]\d{1,2})?)\s?(€|eur\b|euros\b)/gi)].map((m) => m[0]);
  const unknownPrices = prices.filter((p) => !known.includes(p.replace(/[^\d,.]/g, "").replace(",", ".")));
  if (unknownPrices.length) out.push({ key: "prices", level: "needs_ack", message: "Hay precios que no figuran en las ofertas verificadas de tu marca. Confírmalos antes de aprobar.", samples: [...new Set(unknownPrices)].slice(0, 5) });
  return out;
}
