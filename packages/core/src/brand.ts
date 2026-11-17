import type { PageExtraction } from "./extract";

/**
 * Brand Intelligence extraction. Every fact keeps its source URL and method.
 * Rules: never invent prices, audiences or claims. Missing data is reported as missing.
 */
export type FactMethod = "json-ld" | "meta" | "open-graph" | "heading" | "link" | "html" | "title";
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

const typeOf = (o: Record<string, unknown>): string[] => asArray(o["@type"] as string | string[] | undefined).filter((t) => typeof t === "string");
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim().slice(0, 500) : null);

export function extractBrand(pages: PageExtraction[]): BrandExtraction {
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
  add("theme_color", "Color de marca (theme-color)", home.themeColor, home.url, "html", "medium");
  add("logo", "Logo / icono", home.icons.find((i) => /apple-touch|\.svg|\.png/.test(i)) ?? home.icons[0] ?? null, home.url, "html", "low");
  add("og_image", "Imagen para compartir", home.og["image"] ?? null, home.url, "open-graph", "medium");

  for (const h of home.h2.slice(0, 8)) add("topic_candidate", "Tema / servicio candidato (H2)", h, home.url, "heading", "low");

  for (const page of pages) {
    for (const l of page.links) {
      try {
        const host = new URL(l.href).hostname.replace(/^www\./, "");
        if (SOCIAL_HOSTS.some((s) => host === s || host.endsWith(`.${s}`))) add("social", "Perfil social", l.href, page.url, "link", "medium");
      } catch {
        /* ignore */
      }
    }
    for (const e of page.emails) add("email", "Email", e, page.url, "link", "medium");
    for (const p of page.phones) add("telephone", "Teléfono", p, page.url, "link", "medium");
  }

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
