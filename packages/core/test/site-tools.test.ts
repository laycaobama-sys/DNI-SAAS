import { describe, expect, it } from "vitest";
import { aiReadiness, extractPage, keywordGap, linkTargets, linkVerdict, pageTerms, tokenize } from "../src";

const page = (title: string, h1: string, h2: string[], body: string, extra = "") =>
  `<html lang="es"><head><title>${title}</title><meta name="description" content="${title} en Madrid">${extra}</head><body><nav>Inicio Contacto Aviso legal</nav><h1>${h1}</h1>${h2.map((h) => `<h2>${h}</h2>`).join("")}<p>${body}</p><footer>Política de privacidad cookies</footer></body></html>`;

describe("keyword gap", () => {
  it("folds accents and drops stopwords", () => {
    expect(tokenize("Análisis de la Clínica")).toEqual(["analisis", "clinica"]);
  });

  it("lists what the competitor stresses and you never mention, ignoring menus and footers", () => {
    const mine = pageTerms(page("Clínica dental Lavapiés", "Dentista en Lavapiés", ["Limpieza dental"], "Hacemos limpieza dental y empastes."), "https://a.es/");
    const comp = pageTerms(
      page("Implantes dentales en Madrid", "Implantes dentales sin dolor", ["Ortodoncia invisible", "Financiación sin intereses"], "Implantes dentales, ortodoncia invisible y blanqueamiento. Implantes dentales con garantía."),
      "https://b.es/",
    );
    const g = keywordGap(mine, comp);
    const terms = g.missing.map((m) => m.term);
    expect(terms).toContain("implantes dentales");
    expect(terms).toContain("ortodoncia invisible");
    expect(terms.some((t) => /privacidad|cookies|contacto/.test(t))).toBe(false);
    // A word already covered by a listed phrase is not repeated on its own.
    expect(terms).not.toContain("implantes");
    expect(g.missing[0]!.places.length).toBeGreaterThan(0);
  });

  it("flags terms the competitor puts in headings that you only mention in passing", () => {
    const mine = pageTerms(page("Reformas", "Reformas en Madrid", [], "También hacemos reformas de cocinas a veces."), "https://a.es/");
    const comp = pageTerms(page("Reformas de cocinas en Madrid", "Reformas de cocinas", ["Reformas de cocinas llave en mano"], "Reformas de cocinas."), "https://b.es/");
    expect(keywordGap(mine, comp).weaker.map((w) => w.term)).toContain("reformas cocinas");
  });
});

describe("broken links", () => {
  it("dedupes links, internal first, max 50", () => {
    const links = Array.from({ length: 70 }, (_, i) => `<a href="https://otra.es/${i}">x</a>`).join("") + '<a href="/a">a</a><a href="/a#b">a</a><a href="mailto:x@y.es">m</a>';
    const t = linkTargets(extractPage(`<body>${links}</body>`, "https://mia.es/"));
    expect(t).toHaveLength(50);
    expect(t[0]).toMatchObject({ url: "https://mia.es/a", internal: true });
    expect(t.filter((x) => x.url === "https://mia.es/a")).toHaveLength(1);
  });

  it("classifies statuses honestly", () => {
    expect(linkVerdict(200)).toBe("ok");
    expect(linkVerdict(301)).toBe("redirect");
    expect(linkVerdict(404)).toBe("broken");
    expect(linkVerdict(410)).toBe("broken");
    expect(linkVerdict(403)).toBe("blocked");
    expect(linkVerdict(999)).toBe("blocked");
    expect(linkVerdict(503)).toBe("error");
    expect(linkVerdict(null)).toBe("error");
  });
});

describe("AI readiness", () => {
  const long = "palabra ".repeat(400);
  it("passes a well prepared page", () => {
    const html = page("Clínica", "Clínica dental", ["¿Cuánto cuesta un implante?", "¿Duele?"], long, '<script type="application/ld+json">{"@context":"https://schema.org","@type":"Dentist","name":"X"}</script>').replace("Dentist", "LocalBusiness");
    const r = aiReadiness({ page: extractPage(html, "https://a.es/"), status: 200, https: true, robotsTxt: "User-agent: *\nAllow: /", llmsTxt: "# Clínica\n> Resumen" });
    expect(r.checks.filter((c) => c.state !== "ok")).toEqual([]);
    expect(r.ok).toBe(r.total);
  });

  it("detects blocked search bots, noindex, thin HTML and missing llms.txt", () => {
    const html = page("App", "", [], "Cargando…", '<meta name="robots" content="noindex">');
    const r = aiReadiness({ page: extractPage(html, "https://a.es/"), status: 200, https: true, robotsTxt: "User-agent: OAI-SearchBot\nDisallow: /\n\nUser-agent: GPTBot\nDisallow: /", llmsTxt: null });
    const by = Object.fromEntries(r.checks.map((c) => [c.key, c]));
    expect(by.robots!.state).toBe("bad");
    expect(by.robots!.detail).toContain("OAI-SearchBot");
    // Blocking only the training bot (GPTBot) is a legitimate choice and is not reported as a problem.
    expect(by.robots!.detail).not.toContain("GPTBot");
    expect(by.index!.state).toBe("bad");
    expect(by.text!.state).toBe("bad");
    expect(by.llms!.state).toBe("warn");
  });

  it("says it could not check robots.txt or llms.txt instead of claiming they are missing", () => {
    const r = aiReadiness({ page: null, status: 200, https: true, robotsTxt: null, llmsTxt: null, robotsUnknown: true, llmsUnknown: true });
    const by = Object.fromEntries(r.checks.map((c) => [c.key, c]));
    expect(by.robots!.detail).toContain("No pudimos descargar");
    expect(by.robots!.state).toBe("warn");
    expect(by.llms!.detail).toContain("No pudimos descargar");
  });

  it("reports an unreachable page without inventing the rest", () => {
    const r = aiReadiness({ page: null, status: 404, https: true, robotsTxt: null, llmsTxt: null });
    expect(r.checks.find((c) => c.key === "reachable")!.state).toBe("bad");
    expect(r.checks.find((c) => c.key === "text")).toBeUndefined();
  });
});
