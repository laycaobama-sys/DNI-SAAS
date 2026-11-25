/**
 * Build-time completion of public pages (vite transformIndexHtml): every page that does not declare
 * its own JSON-LD gets a WebPage description with the publisher, and every page without social tags
 * gets og:* and twitter:* with the site image. Values come from the page's own <title>, description
 * and canonical, so nothing here can say something the page itself does not.
 */
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
const pick = (html: string, re: RegExp) => re.exec(html)?.[1]?.trim() ?? "";
const decode = (s: string) => s.replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");

export function fillPageMeta(html: string, siteUrl: string): string {
  if (!/<\/head>/i.test(html) || /<meta name="robots" content="noindex/i.test(html)) return html;
  const title = decode(pick(html, /<title>([^<]*)<\/title>/i));
  const description = decode(pick(html, /<meta name="description" content="([^"]*)"/i));
  const url = pick(html, /<link rel="canonical" href="([^"]*)"/i);
  if (!title || !url) return html;
  let extra = "";
  if (!/property="og:image"/.test(html)) {
    extra += [
      `<meta property="og:type" content="website" />`,
      `<meta property="og:locale" content="es_ES" />`,
      `<meta property="og:site_name" content="DNI Growth" />`,
      `<meta property="og:title" content="${esc(title)}" />`,
      description ? `<meta property="og:description" content="${esc(description)}" />` : "",
      `<meta property="og:url" content="${esc(url)}" />`,
      `<meta property="og:image" content="${siteUrl}/og-dni-growth.png" />`,
      `<meta property="og:image:type" content="image/png" />`,
      `<meta property="og:image:width" content="1200" />`,
      `<meta property="og:image:height" content="630" />`,
      `<meta property="og:image:alt" content="DNI Growth: crece con pruebas, no con promesas." />`,
      `<meta name="twitter:card" content="summary_large_image" />`,
    ]
      .filter(Boolean)
      .join("\n    ");
  }
  if (!/application\/ld\+json/.test(html)) {
    const ld = {
      "@context": "https://schema.org",
      "@type": "WebPage",
      "@id": `${url}#webpage`,
      url,
      name: title,
      ...(description ? { description } : {}),
      inLanguage: "es-ES",
      isPartOf: { "@type": "WebSite", "@id": `${siteUrl}/#website`, name: "DNI Growth", url: `${siteUrl}/` },
      publisher: { "@type": "Organization", "@id": `${siteUrl}/#organization`, name: "DNI Growth", url: `${siteUrl}/`, logo: `${siteUrl}/icon-512.png` },
    };
    extra += `\n    <script type="application/ld+json">${JSON.stringify(ld).replace(/</g, "\u003c")}</script>`;
  }
  return extra ? html.replace(/<\/head>/i, `    ${extra}\n  </head>`) : html;
}
