import { parse, type HTMLElement } from "node-html-parser";

/**
 * Structured, evidence-friendly extraction from an HTML document.
 * The HTML is untrusted DATA: nothing here executes or interprets instructions found in it.
 */
export interface ExtractedLink {
  href: string;
  text: string;
  rel: string;
  internal: boolean;
}
export interface ExtractedImage {
  src: string;
  alt: string | null;
}
export interface PageExtraction {
  url: string;
  lang: string | null;
  title: string | null;
  titleCount: number;
  metaDescription: string | null;
  metaDescriptionCount: number;
  metaRobots: string | null;
  canonical: string | null;
  canonicalCount: number;
  viewport: string | null;
  charset: string | null;
  themeColor: string | null;
  h1: string[];
  h2: string[];
  h3: string[];
  og: Record<string, string>;
  twitter: Record<string, string>;
  hreflang: Array<{ lang: string; href: string }>;
  jsonLd: unknown[];
  jsonLdErrors: number;
  jsonLdTypes: string[];
  links: ExtractedLink[];
  images: ExtractedImage[];
  icons: string[];
  wordCount: number;
  textSample: string;
  emails: string[];
  phones: string[];
}

const clean = (s: string | undefined | null) => (s ?? "").replace(/\s+/g, " ").trim();

function absolutize(href: string, base: URL): string | null {
  try {
    const u = new URL(href, base);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    u.hash = "";
    return u.toString();
  } catch {
    return null;
  }
}

function collectTypes(node: unknown, out: Set<string>, depth = 0): void {
  if (depth > 6 || node === null || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const n of node) collectTypes(n, out, depth + 1);
    return;
  }
  const obj = node as Record<string, unknown>;
  const t = obj["@type"];
  if (typeof t === "string") out.add(t);
  else if (Array.isArray(t)) t.forEach((x) => typeof x === "string" && out.add(x));
  if (obj["@graph"]) collectTypes(obj["@graph"], out, depth + 1);
  for (const [k, v] of Object.entries(obj)) {
    if (k !== "@graph" && typeof v === "object") collectTypes(v, out, depth + 1);
  }
}

export function extractPage(html: string, pageUrl: string): PageExtraction {
  const base = new URL(pageUrl);
  const root = parse(html, { comment: false, blockTextElements: { script: true, style: true, noscript: true, pre: true } });
  const q = (sel: string) => root.querySelectorAll(sel);
  const attr = (el: HTMLElement | undefined | null, name: string) => (el ? el.getAttribute(name) ?? null : null);
  const metaByName = (name: string) =>
    q("meta").filter((m) => (m.getAttribute("name") ?? "").toLowerCase() === name);

  const titles = q("title");
  const descs = metaByName("description");
  const canonicals = q("link").filter((l) => (l.getAttribute("rel") ?? "").toLowerCase().split(/\s+/).includes("canonical"));

  const og: Record<string, string> = {};
  const twitter: Record<string, string> = {};
  for (const m of q("meta")) {
    const prop = (m.getAttribute("property") ?? m.getAttribute("name") ?? "").toLowerCase();
    const content = clean(m.getAttribute("content"));
    if (prop.startsWith("og:") && content) og[prop.slice(3)] = content;
    if (prop.startsWith("twitter:") && content) twitter[prop.slice(8)] = content;
  }

  const jsonLd: unknown[] = [];
  let jsonLdErrors = 0;
  for (const s of q('script[type="application/ld+json"]')) {
    try {
      jsonLd.push(JSON.parse(s.rawText));
    } catch {
      jsonLdErrors++;
    }
  }
  const types = new Set<string>();
  collectTypes(jsonLd, types);

  const links: ExtractedLink[] = [];
  const emails = new Set<string>();
  const phones = new Set<string>();
  for (const a of q("a[href]")) {
    const raw = (a.getAttribute("href") ?? "").trim();
    if (raw.toLowerCase().startsWith("mailto:")) {
      const e = raw.slice(7).split("?")[0]!.trim();
      if (/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)) emails.add(e.toLowerCase());
      continue;
    }
    if (raw.toLowerCase().startsWith("tel:")) {
      const p = raw.slice(4).replace(/[^\d+]/g, "");
      if (p.length >= 6) phones.add(p);
      continue;
    }
    const abs = absolutize(raw, base);
    if (!abs) continue;
    links.push({
      href: abs,
      text: clean(a.text).slice(0, 120),
      rel: (a.getAttribute("rel") ?? "").toLowerCase(),
      internal: new URL(abs).host === base.host,
    });
  }

  const images: ExtractedImage[] = q("img").map((img) => ({
    src: absolutize(img.getAttribute("src") ?? img.getAttribute("data-src") ?? "", base) ?? "",
    alt: img.hasAttribute("alt") ? clean(img.getAttribute("alt")) : null,
  }));

  const icons = q("link")
    .filter((l) => /icon/.test((l.getAttribute("rel") ?? "").toLowerCase()))
    .map((l) => absolutize(l.getAttribute("href") ?? "", base))
    .filter((x): x is string => !!x);

  const body = root.querySelector("body") ?? root;
  for (const n of body.querySelectorAll("script,style,noscript,template,svg")) n.remove();
  const text = clean(body.text);
  const words = text ? text.split(" ").filter((w) => /[\p{L}\p{N}]/u.test(w)) : [];

  const htmlEl = root.querySelector("html");
  const charsetMeta = q("meta").find((m) => m.hasAttribute("charset"));

  return {
    url: pageUrl,
    lang: attr(htmlEl, "lang"),
    title: titles[0] ? clean(titles[0].text) : null,
    titleCount: titles.length,
    metaDescription: descs[0] ? clean(descs[0].getAttribute("content")) : null,
    metaDescriptionCount: descs.length,
    metaRobots: metaByName("robots")[0]?.getAttribute("content")?.toLowerCase() ?? null,
    canonical: canonicals[0] ? absolutize(canonicals[0].getAttribute("href") ?? "", base) : null,
    canonicalCount: canonicals.length,
    viewport: metaByName("viewport")[0]?.getAttribute("content") ?? null,
    charset: charsetMeta ? attr(charsetMeta, "charset") : null,
    themeColor: metaByName("theme-color")[0]?.getAttribute("content") ?? null,
    h1: q("h1").map((h) => clean(h.text)).filter(Boolean),
    h2: q("h2").map((h) => clean(h.text)).filter(Boolean).slice(0, 30),
    h3: q("h3").map((h) => clean(h.text)).filter(Boolean).slice(0, 30),
    og,
    twitter,
    hreflang: q('link[rel="alternate"]')
      .filter((l) => l.hasAttribute("hreflang"))
      .map((l) => ({ lang: l.getAttribute("hreflang") ?? "", href: absolutize(l.getAttribute("href") ?? "", base) ?? "" })),
    jsonLd,
    jsonLdErrors,
    jsonLdTypes: [...types].sort(),
    links,
    images,
    icons,
    wordCount: words.length,
    textSample: text.slice(0, 600),
    emails: [...emails].slice(0, 10),
    phones: [...phones].slice(0, 10),
  };
}

/** Normalises a URL for de-duplication inside a crawl (drops hash, sorts nothing, strips trailing slash on non-root). */
export function normalizeForCrawl(u: string): string {
  const url = new URL(u);
  url.hash = "";
  if (url.pathname !== "/" && url.pathname.endsWith("/")) url.pathname = url.pathname.slice(0, -1);
  return url.toString();
}
