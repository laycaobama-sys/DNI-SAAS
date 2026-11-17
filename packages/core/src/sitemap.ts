/** Extracts <loc> entries from a sitemap or sitemap index. Pure string parsing (no XXE surface). */
export interface SitemapParseResult {
  kind: "urlset" | "index" | "unknown";
  locs: string[];
}

export function parseSitemap(xml: string, limit = 500): SitemapParseResult {
  const kind = /<sitemapindex[\s>]/i.test(xml) ? "index" : /<urlset[\s>]/i.test(xml) ? "urlset" : "unknown";
  const locs: string[] = [];
  const re = /<loc>\s*(?:<!\[CDATA\[)?\s*([^<\]]+?)\s*(?:\]\]>)?\s*<\/loc>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) && locs.length < limit) {
    const decoded = m[1]!.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").trim();
    if (decoded) locs.push(decoded);
  }
  return { kind, locs };
}
