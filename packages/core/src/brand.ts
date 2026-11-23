import type { PageExtraction } from "./extract";

/**
 * Brand Intelligence extraction. Every fact keeps its source URL and method.
 * Rules: never invent prices, audiences or claims. Missing data is reported as missing.
 */
export type FactMethod = "json-ld" | "meta" | "open-graph" | "heading" | "link" | "html" | "title" | "css";
export type Confidence = "high" | "medium" | "low";
export type FactStatus = "extracted" | "edited" | "rejected" | "added";

export interface BrandFact {
  id: string;
  key: string;
  label: string;
  value: string;
  sourceUrl: string | null;
  method: FactMethod | "user";
  confidence: Confidence;
  status: FactStatus;
}

export interface BrandExtraction {
  facts: BrandFact[];
  missing: Array<{ key: string; label: string; hint: string }>;
  warnings: string[];
}

/** schema.org types describing the business entity itself (not a product/service it sells). */
export const ENTITY_TYPE_RE =
  /^(Organization|LocalBusiness|Corporation|NGO|\w*Store|Restaurant|\w*Business|ProfessionalService|LegalService|Attorney|Dentist|Physician|\w*Clinic|ExerciseGym|HealthClub|SportsActivityLocation|Hotel|\w*Agency|FoodEstablishment|AutoDealer|RealEstateAgent|EducationalOrganization)$/;

const SOCIAL_HOSTS =["facebook.com", "instagram.com", "linkedin.com", "x.com", "twitter.com", "youtube.com", "tiktok.com", "pinterest.com", "threads.net"];

function asArray<T>(x: T | T[] | undefined): T[] {
  return x === undefined ? [] : Array.isArray(x) ? x : [x];
}

function flattenLd(nodes: unknown[]): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  const visit = (n: unknown, depth: number) => {
    if (depth > 5 || !n || typeof n !== "object") return;
    if (Array.isArray(n)) return n.forEach((x) => visit(x, depth + 1));
    const o = n as Record<string, unknown>;
    out.push(o);
    if (o["@graph"]) visit(o["@graph"], depth + 1);
  };
  nodes.forEach((n) => visit(n, 0));
  return out;
}

/* ---------- Colours: the accent comes from the CSS, never from theme-color (often just the background). ---------- */

const hexNorm = (h: string): string | null => {
  const m = h.trim().toLowerCase().match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/);
  if (!m) return null;
  const v = m[1]!;
  return v.length === 3 ? `#${v[0]}${v[0]}${v[1]}${v[1]}${v[2]}${v[2]}` : `#${v}`;
};
const rgbToHex = (r: number, g: number, b: number) => `#${[r, g, b].map((x) => Math.max(0, Math.min(255, Math.round(x))).toString(16).padStart(2, "0")).join("")}`;

/** Saturation/lightness in 0..1 (HSL). */
export function colorStats(hex: string): { s: number; l: number } {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255) as [number, number, number];
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
  return { s, l };
}

/** Greys, near-black and near-white are not brand colours. */
export const isNeutralColor = (hex: string) => {
  const { s, l } = colorStats(hex);
  return s < 0.2 || l < 0.1 || l > 0.94;
};

const BRAND_VAR_RE = /--(?:[\w-]*?)(accent|brand|primary|primario|principal|highlight|cta)[\w-]*\s*:\s*([^;}{]+)/gi;

/**
 * Brand colour candidates from CSS: custom properties named like accent/brand/primary win; otherwise the most
 * frequent non-neutral colour. Returns at most 2, each with where it came from.
 */
export function brandColorsFromCss(css: string): Array<{ hex: string; source: string; count: number }> {
  const named = new Map<string, string>();
  for (const m of css.matchAll(BRAND_VAR_RE)) {
    const v = m[2]!.trim();
    const hex = hexNorm(v.match(/#[0-9a-f]{3,6}\b/i)?.[0] ?? "") ?? (() => {
      const r = v.match(/rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)/i);
      return r ? rgbToHex(Number(r[1]), Number(r[2]), Number(r[3])) : null;
    })();
    if (hex && !isNeutralColor(hex) && !named.has(hex)) named.set(hex, m[0].split(":")[0]!.trim());
  }
  const counts = new Map<string, number>();
  for (const m of css.matchAll(/#[0-9a-f]{6}\b|#[0-9a-f]{3}\b/gi)) {
    const hex = hexNorm(m[0]);
    if (hex && !isNeutralColor(hex)) counts.set(hex, (counts.get(hex) ?? 0) + 1);
  }
  for (const m of css.matchAll(/rgba?\(\s*(\d{1,3})[\s,]+(\d{1,3})[\s,]+(\d{1,3})/gi)) {
    const hex = rgbToHex(Number(m[1]), Number(m[2]), Number(m[3]));
    if (!isNeutralColor(hex)) counts.set(hex, (counts.get(hex) ?? 0) + 1);
  }
  const out: Array<{ hex: string; source: string; count: number }> = [];
  for (const [hex, v] of named) out.push({ hex, source: `variable CSS ${v}`, count: counts.get(hex) ?? 1 });
  for (const [hex, count] of [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))) {
    if (!out.some((o) => o.hex === hex)) out.push({ hex, source: `color más repetido en el CSS (${count} usos)`, count });
  }
  return out.slice(0, 2);
}

/* ---------- Headings that are calls to action or slogans are not services. ---------- */

const CTA_RE = /(→|»|!|^(audita|empieza|comienza|prueba|contacta|descubre|solicita|reserva|pide|llama|escr[ií]be|[uú]nete|reg[ií]strate|habla|consigue|obt[eé]n|mira|ver|lee|suscr[ií]bete|compra|agenda|cuéntanos|hablemos|start|try|get|book|contact|join|sign up|learn more)\b)/i;
const GENERIC_HEADING_RE = /^(preguntas frecuentes|faq|contacto|testimonios|opiniones|blog|newsletter|síguenos|siguenos|sobre nosotros|qui[eé]nes somos|nuestro equipo|equipo|precios|planes|c[oó]mo funciona|por qu[eé] .+|men[uú]|footer|legal|recursos)\.?$/i;

/** True for H2s that can plausibly name a topic or service (not "Audita tu web hoy →" or "Respuestas claras."). */
export function isTopicHeading(h: string): boolean {
  const t = h.replace(/\s+/g, " ").trim();
  const words = t.split(" ").filter(Boolean);
  if (words.length < 1 || words.length > 9 || t.length > 80) return false;
  if (CTA_RE.test(t) || GENERIC_HEADING_RE.test(t) || t.endsWith("?")) return false;
  // Short slogans with a full stop ("Respuestas claras.") are copywriting, not services.
  if (t.endsWith(".") && words.length <= 4) return false;
  return true;
}

/* ---------- E-mails: the contact address first; privacy/DPO/no-reply are never «the» contact. ---------- */

const CONTACT_LOCAL_RE = /^(hola|info|contacto|contact|hello|hi|ventas|sales|comercial|clientes|atencion|soporte|support|equipo|team|reservas|citas)$/i;
const NON_CONTACT_LOCAL_RE = /^(privacy|privacidad|dpo|rgpd|gdpr|lopd|legal|datos|protecciondedatos|noreply|no-reply|donotreply|abuse|postmaster|webmaster|security|seguridad|bounce|mailer-daemon)$/i;

export function emailRole(e: string): "contact" | "privacy" | "other" {
  const local = e.split("@")[0]!.toLowerCase();
  if (NON_CONTACT_LOCAL_RE.test(local)) return "privacy";
  if (CONTACT_LOCAL_RE.test(local)) return "contact";
  return "other";
}

const typeOf = (o: Record<string, unknown>): string[] => asArray(o["@type"] as string | string[] | undefined).filter((t) => typeof t === "string");
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim().slice(0, 500) : null);

export function extractBrand(pages: PageExtraction[], opts: { css?: string } = {}): BrandExtraction {
  const facts: BrandFact[] = [];
  const warnings: string[] = [];
  let n = 0;
  const add = (key: string, label: string, value: string | null, sourceUrl: string | null, method: FactMethod, confidence: Confidence) => {
    if (!value) return;
    const v = value.replace(/\s+/g, " ").trim().slice(0, 500);
    if (!v || facts.some((f) => f.key === key && f.value.toLowerCase() === v.toLowerCase())) return;
    facts.push({ id: `f${++n}`, key, label, value: v, sourceUrl, method, confidence, status: "extracted" });
  };

  const home = pages[0];
  if (!home) return { facts, missing: [], warnings: ["No se pudo analizar ninguna página."] };

  for (const page of pages) {
    const ld = flattenLd(page.jsonLd);
    for (const o of ld) {
      const types = typeOf(o);
      const isEntity = types.some((t) => ENTITY_TYPE_RE.test(t));
      if (isEntity) {
        add("name", "Nombre de marca", str(o["name"]), page.url, "json-ld", "high");
        add("legal_name", "Razón social", str(o["legalName"]), page.url, "json-ld", "high");
        const logo = o["logo"];
        add("logo", "Logo", str(logo) ?? str((logo as Record<string, unknown> | undefined)?.["url"]), page.url, "json-ld", "high");
        for (const s of asArray(o["sameAs"] as string | string[] | undefined)) add("social", "Perfil social", str(s), page.url, "json-ld", "high");
        add("telephone", "Teléfono", str(o["telephone"]), page.url, "json-ld", "high");
        add("email", "Email", str(o["email"]), page.url, "json-ld", "high");
        const addr = o["address"] as Record<string, unknown> | undefined;
        if (addr && typeof addr === "object") {
          const parts = ["streetAddress", "postalCode", "addressLocality", "addressRegion", "addressCountry"].map((k) => str(addr[k])).filter(Boolean);
          add("address", "Dirección", parts.join(", ") || null, page.url, "json-ld", "high");
        }
        add("area_served", "Zona de servicio", str(o["areaServed"]), page.url, "json-ld", "medium");
        add("price_range", "Rango de precios (declarado)", str(o["priceRange"]), page.url, "json-ld", "high");
        add("industry", "Tipo de negocio (schema)", types.join(", "), page.url, "json-ld", "medium");
      }
      // Prices ONLY from explicit Offer markup — never inferred from free text.
      if (types.includes("Product") || types.includes("Service")) {
        const name = str(o["name"]);
        add("offering", "Producto / servicio", name, page.url, "json-ld", "high");
        for (const offer of asArray(o["offers"] as Record<string, unknown> | Record<string, unknown>[] | undefined)) {
          const price = str(String(offer?.["price"] ?? "")) ?? str(String(offer?.["lowPrice"] ?? ""));
          const cur = str(offer?.["priceCurrency"]);
          if (price && name) add("price", "Precio visible (schema Offer)", `${name}: ${price}${cur ? ` ${cur}` : ""}`, page.url, "json-ld", "high");
        }
      }
    }
  }

  add("name", "Nombre de marca", home.og["site_name"] ?? null, home.url, "open-graph", "medium");
  if (home.title) {
    const parts = home.title.split(/\s[|\-–—·:]\s/);
    if (parts.length > 1) add("name", "Nombre de marca", parts[parts.length - 1] ?? null, home.url, "title", "low");
  }
  add("description", "Descripción / propuesta de valor", home.metaDescription, home.url, "meta", "medium");
  add("description", "Descripción / propuesta de valor", home.og["description"] ?? null, home.url, "open-graph", "medium");
  add("headline", "Titular principal (H1)", home.h1[0] ?? null, home.url, "heading", "medium");
  add("language", "Idioma del sitio", home.lang, home.url, "html", "high");
  const colors = brandColorsFromCss(`${pages.map((p) => p.inlineCss ?? "").join("\n")}\n${opts.css ?? ""}`);
  for (const [i, c] of colors.entries()) add("brand_color", i === 0 ? "Color de acento sugerido (CSS)" : "Color secundario sugerido (CSS)", `${c.hex} · ${c.source}`, home.url, "css", c.source.startsWith("variable") ? "medium" : "low");
  // theme-color is the browser bar colour (often the background): shown as such, never as «the» brand colour.
  const tc = home.themeColor ? hexNorm(home.themeColor) : null;
  if (tc) add("theme_color", "Color de la barra del navegador (theme-color)", tc, home.url, "html", "low");
  add("logo", "Logo / icono", home.icons.find((i) => /apple-touch|\.svg|\.png/.test(i)) ?? home.icons[0] ?? null, home.url, "html", "low");
  add("og_image", "Imagen para compartir", home.og["image"] ?? null, home.url, "open-graph", "medium");

  for (const h of home.h2.filter(isTopicHeading).slice(0, 8)) add("topic_candidate", "Tema o servicio sugerido (H2)", h, home.url, "heading", "low");

  for (const page of pages) {
    for (const l of page.links) {
      try {
        const host = new URL(l.href).hostname.replace(/^www\./, "");
        if (SOCIAL_HOSTS.some((s) => host === s || host.endsWith(`.${s}`))) add("social", "Perfil social", l.href, page.url, "link", "medium");
      } catch {
        /* ignore */
      }
    }
    for (const e of page.emails) {
      const role = emailRole(e);
      if (role === "privacy") add("email_privacy", "Email de privacidad o técnico (no es el de contacto)", e, page.url, "link", "low");
      else add("email", "Email de contacto", e, page.url, "link", role === "contact" ? "medium" : "low");
    }
    for (const p of page.phones) add("telephone", "Teléfono", p, page.url, "link", "medium");
  }

  // Contact e-mails ordered: hola@/info@/contacto@ first, generic ones after.
  const emailFacts = facts.filter((f) => f.key === "email");
  emailFacts.sort((a, b) => Number(emailRole(b.value) === "contact") - Number(emailRole(a.value) === "contact") || Number(b.method === "json-ld") - Number(a.method === "json-ld"));
  let ei = 0;
  for (let i = 0; i < facts.length; i++) if (facts[i]!.key === "email") facts[i] = emailFacts[ei++]!;

  const has = (k: string) => facts.some((f) => f.key === k);
  const missing: BrandExtraction["missing"] = [];
  if (!has("name")) missing.push({ key: "name", label: "Nombre de marca", hint: "No se encontró de forma fiable. Escríbelo tú." });
  if (!has("description")) missing.push({ key: "description", label: "Propuesta de valor", hint: "La home no tiene meta description. Resume qué vendes y a quién." });
  missing.push({ key: "audience", label: "Público objetivo", hint: "Nunca lo inferimos automáticamente: descríbelo tú." });
  missing.push({ key: "tone", label: "Tono de voz", hint: "Define cómo debe sonar tu marca (p. ej. cercano, técnico, premium)." });
  missing.push({ key: "objective", label: "Objetivo comercial", hint: "Tráfico, leads, ventas o reputación." });
  if (!has("price") && !has("price_range")) {
    missing.push({ key: "price", label: "Precios", hint: "No hay precios marcados con schema. No los inventamos: añádelos solo si quieres usarlos." });
  }
  if (facts.filter((f) => f.key === "name").length > 1) warnings.push("Hay varias variantes del nombre de marca: confirma la correcta.");
  return { facts, missing, warnings };
}
