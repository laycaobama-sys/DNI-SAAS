/**
 * Free tools (/herramientas/*): each page has <main data-tool="slug"> with a form [data-form] and an
 * output [data-out]. Most tools run here, in the visitor's browser (nothing is sent anywhere); the logic is
 * in @dni/core/free-tools (unit-tested). The four that read a public web page ask our API
 * (/api/v1/public/tools/*, SSRF-protected and rate-limited) and only draw its answer. Output is built only with DOM nodes and text, never raw HTML
 * strings from user input.
 */
import {
  buildFaq,
  buildLlmsFile,
  buildOgTags,
  buildSchema,
  jsonLdScript,
  robotsAiReport,
  schemaProblems,
  SERP_DESC_PX,
  SERP_TITLE_PX,
  sitemapReport,
  trafficValue,
  truncateToWidth,
  type SchemaInput,
} from "@dni/core/free-tools";

type Child = Node | string | null | undefined | false;
const h = (tag: string, attrs: Record<string, string> = {}, ...kids: Child[]) => {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  for (const k of kids) if (k) el.append(k);
  return el;
};

function codeBlock(label: string, text: string, filename?: string) {
  const pre = h("pre", { class: "tool-code", tabindex: "0" }, h("code", {}, text));
  const copy = h("button", { type: "button", class: "btn" }, "Copiar");
  copy.addEventListener("click", () => {
    void navigator.clipboard?.writeText(text).then(
      () => (copy.textContent = "Copiado ✓"),
      () => (copy.textContent = "Selecciónalo y cópialo"),
    );
  });
  const actions = h("p", { class: "tool-actions" }, copy);
  if (filename) {
    const a = h("a", { class: "btn", download: filename, href: URL.createObjectURL(new Blob([text], { type: "text/plain;charset=utf-8" })) }, `Descargar ${filename}`);
    actions.append(a);
  }
  return h("div", { class: "tool-block" }, h("h3", {}, label), pre, actions);
}

const field = (form: HTMLFormElement, name: string) => {
  const el = form.elements.namedItem(name) as HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement | null;
  return (el?.value ?? "").trim();
};
const problemsList = (items: string[]) => h("ul", { class: "tool-problems" }, ...items.map((p) => h("li", {}, p)));

class ToolError extends Error {}
/** POST to the free-tools API; throws the API's Spanish message on error. */
async function api<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(`/api/v1/public/tools/${path}`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json" }, body: JSON.stringify(body) });
  const json = (await res.json().catch(() => ({}))) as T & { title?: string };
  if (!res.ok) throw new ToolError(json.title ?? (res.status === 429 ? "Has hecho muchas comprobaciones seguidas. Espera un rato y vuelve a probar." : "No se pudo comprobar. Inténtalo de nuevo."));
  return json;
}
const urlOf = (form: HTMLFormElement, name = "url") => {
  const v = field(form, name);
  return v && !/^https?:\/\//i.test(v) ? `https://${v}` : v;
};
const stateMark = { ok: "✓", warn: "!", bad: "✗" } as const;
const when = (iso: string) => new Date(iso).toLocaleString("es-ES", { dateStyle: "short", timeStyle: "short" });

const TOOLS: Record<string, (form: HTMLFormElement, out: HTMLElement) => void | Promise<void>> = {
  "robots-txt-bots-ia": (form, out) => {
    const txt = field(form, "robots");
    if (!txt) return void out.replaceChildren(h("p", {}, "Pega primero el contenido de tu robots.txt."));
    const r = robotsAiReport(txt);
    const rows = r.bots.map((b) =>
      h("tr", {}, h("td", {}, h("strong", {}, b.ua), h("br"), `${b.owner} · ${b.purpose}`), h("td", { class: b.allowed ? "ok" : "bad" }, b.allowed ? "✓ Puede leer tu portada" : "✗ Bloqueado"), h("td", {}, b.group === "*" ? "reglas generales (*)" : b.group === "ninguno" ? "sin reglas" : "reglas propias")),
    );
    const blockedSearch = r.bots.filter((b) => !b.allowed && /búsqueda|Search|Bing/.test(`${b.purpose}`));
    out.replaceChildren(
      h("h2", {}, "Resultado"),
      blockedSearch.length ? h("p", { class: "bad" }, `Atención: bloqueas ${blockedSearch.map((b) => b.ua).join(", ")}: ${blockedSearch.length > 1 ? "se usan" : "se usa"} para mostrar resultados en buscadores o asistentes.`) : h("p", { class: "ok" }, "Ningún bot de búsqueda está bloqueado en tu portada."),
      h("div", { class: "tw" }, h("table", {}, h("thead", {}, h("tr", {}, h("th", {}, "Bot"), h("th", {}, "Portada (/)"), h("th", {}, "Grupo aplicado"))), h("tbody", {}, ...rows))),
      h("p", {}, r.sitemaps.length ? `Sitemaps declarados: ${r.sitemaps.join(", ")}` : "No declaras ningún sitemap. Añade «Sitemap: https://tuweb.com/sitemap.xml»."),
    );
  },
  "generador-llms-txt": (form, out) => {
    const name = field(form, "name");
    const summary = field(form, "summary");
    if (!name || !summary) return void out.replaceChildren(problemsList(["Escribe el nombre y el resumen."]));
    const links = field(form, "links")
      .split(/\n/)
      .map((l) => l.split("|").map((x) => x.trim()))
      .filter((p) => p[0] && p[1])
      .map(([title, url, note]) => ({ title: title!, url: url!, note }));
    const bad = links.filter((l) => !/^https?:\/\//i.test(l.url));
    const text = buildLlmsFile({ name, summary, details: field(form, "details"), sections: [{ title: "Páginas principales", links }] });
    out.replaceChildren(bad.length ? problemsList(bad.map((l) => `«${l.title}» no tiene una dirección válida (empieza por https://).`)) : "", codeBlock("Tu llms.txt", text, "llms.txt"));
  },
  "generador-schema": (form, out) => {
    const i: SchemaInput = {
      type: field(form, "type") as SchemaInput["type"],
      name: field(form, "name"),
      url: field(form, "url"),
      description: field(form, "description"),
      logo: field(form, "logo"),
      phone: field(form, "phone"),
      street: field(form, "street"),
      city: field(form, "city"),
      postalCode: field(form, "postalCode"),
      sameAs: field(form, "sameAs").split(/\s+/).filter(Boolean),
      author: field(form, "author"),
      datePublished: field(form, "datePublished"),
      image: field(form, "image"),
    };
    const p = schemaProblems(i);
    if (p.length) return void out.replaceChildren(problemsList(p));
    out.replaceChildren(codeBlock("JSON-LD listo para pegar en el <head>", jsonLdScript(buildSchema(i))));
  },
  "generador-faq-aeo": (form, out) => {
    const pairs: Array<{ q: string; a: string }> = [];
    for (const line of field(form, "faq").split(/\n/)) {
      const t = line.trim();
      if (/^P\s*:/i.test(t)) pairs.push({ q: t.replace(/^P\s*:\s*/i, ""), a: "" });
      else if (/^R\s*:/i.test(t) && pairs.length) pairs[pairs.length - 1]!.a += t.replace(/^R\s*:\s*/i, "");
      else if (t && pairs.length && pairs[pairs.length - 1]!.a) pairs[pairs.length - 1]!.a += `\n${t}`;
    }
    const r = buildFaq(pairs);
    if (!r.count) return void out.replaceChildren(problemsList(["Escribe al menos una pregunta con «P:» y su respuesta con «R:»."]));
    out.replaceChildren(h("p", {}, `${r.count} preguntas.`), codeBlock("HTML para tu página", r.html), codeBlock("Marcado FAQPage (en el <head>)", jsonLdScript(r.jsonLd)));
  },
  "vista-previa-google": (form, out) => {
    const ctx = document.createElement("canvas").getContext("2d");
    const measure = (font: string) => (s: string) => {
      if (!ctx) return s.length * 9;
      ctx.font = font;
      return ctx.measureText(s).width;
    };
    const title = truncateToWidth(field(form, "title") || "Título de tu página", SERP_TITLE_PX, measure("20px Arial"));
    const desc = truncateToWidth(field(form, "description") || "Aquí aparecerá tu meta descripción.", SERP_DESC_PX, measure("14px Arial"));
    let host = "tuweb.com";
    try {
      const u = new URL(field(form, "url"));
      host = `${u.hostname}${u.pathname !== "/" ? u.pathname.replace(/\//g, " › ").replace(/ › $/, "") : ""}`;
    } catch {
      /* keep the example */
    }
    out.replaceChildren(
      h("div", { class: "serp", "aria-label": "Vista previa aproximada" }, h("p", { class: "serp-url" }, host), h("p", { class: "serp-title" }, title.text), h("p", { class: "serp-desc" }, desc.text)),
      h("p", { class: title.cut ? "bad" : "ok" }, title.cut ? "El título se corta: acórtalo o pon lo importante al principio." : "El título cabe entero."),
      h("p", { class: desc.cut ? "bad" : "ok" }, desc.cut ? "La descripción se corta." : "La descripción cabe entera."),
    );
  },
  "comprobador-sitemap": (form, out) => {
    const xml = field(form, "xml");
    if (!xml) return void out.replaceChildren(h("p", {}, "Pega primero el contenido de tu sitemap."));
    const r = sitemapReport(xml);
    out.replaceChildren(
      h("h2", {}, "Resultado"),
      h("p", {}, `${r.kind === "index" ? "Índice de sitemaps" : "Sitemap de páginas"} con ${r.urls} direcciones (${r.withLastmod} con fecha de cambio).`),
      r.problems.length ? problemsList(r.problems) : h("p", { class: "ok" }, "No vemos errores en el archivo."),
      r.duplicates.length ? codeBlock("Repetidas", r.duplicates.join("\n")) : "",
      r.notHttps.length ? codeBlock("Sin https", r.notHttps.join("\n")) : "",
    );
  },
  "etiquetas-open-graph": (form, out) => {
    const i = { title: field(form, "title"), description: field(form, "description"), url: field(form, "url"), image: field(form, "image"), siteName: field(form, "siteName") };
    const p: string[] = [];
    if (!i.title) p.push("Falta el título.");
    if (i.url && !/^https:\/\//.test(i.url)) p.push("La dirección tiene que empezar por https://.");
    if (i.image && !/^https:\/\//.test(i.image)) p.push("La imagen tiene que ser una dirección https://.");
    if (p.length) return void out.replaceChildren(problemsList(p));
    out.replaceChildren(codeBlock("Etiquetas para el <head>", buildOgTags(i)));
  },
  "calculadora-valor-trafico": (form, out) => {
    const r = trafficValue(Number(field(form, "visits")), Number(field(form, "cpc").replace(",", ".")));
    if (!r || !field(form, "visits") || !field(form, "cpc")) return void out.replaceChildren(h("p", {}, "Escribe tus visitas al mes y el coste por clic."));
    const eur = (n: number) => n.toLocaleString("es-ES", { style: "currency", currency: "EUR" });
    out.replaceChildren(
      h("p", { class: "tool-big" }, eur(r.monthly), h("span", {}, " al mes")),
      h("p", {}, `${eur(r.yearly)} al año en anuncios por las mismas visitas. Es una estimación (media de visitas × media de coste por clic), no una cifra medida.`),
    );
  },
  "preparada-para-ia": async (form, out) => {
    const url = urlOf(form);
    if (!url) return void out.replaceChildren(h("p", {}, "Escribe la dirección de tu web."));
    const r = await api<{ url: string; checks: Array<{ label: string; state: "ok" | "warn" | "bad"; detail: string }>; ok: number; total: number; checkedAt: string }>("ai-readiness", { url });
    out.replaceChildren(
      h("h2", {}, "Resultado"),
      h("p", { class: "tool-big" }, `${r.ok} de ${r.total}`, h("span", {}, " requisitos cumplidos")),
      h("ul", { class: "tool-checks" }, ...r.checks.map((c) => h("li", {}, h("strong", { class: c.state }, `${stateMark[c.state]} ${c.label}`), h("br"), h("span", {}, c.detail)))),
      h("p", { class: "tool-note" }, `${r.url} · comprobado el ${when(r.checkedAt)}. Son requisitos técnicos; no miden cuántas veces te citan.`),
    );
  },
  "palabras-clave-competidor": async (form, out) => {
    const mine = urlOf(form, "mine");
    const competitor = urlOf(form, "competitor");
    if (!mine || !competitor) return void out.replaceChildren(h("p", {}, "Escribe las dos direcciones."));
    type Item = { term: string; score: number; places: string[] };
    const r = await api<{ missing: Item[]; weaker: Item[]; shared: number; yourWords: number; competitorWords: number }>("keyword-gap", { mine, competitor });
    const table = (items: Item[]) =>
      h("div", { class: "tw" }, h("table", {}, h("thead", {}, h("tr", {}, h("th", {}, "Término"), h("th", {}, "Dónde lo usa el competidor"))), h("tbody", {}, ...items.map((i) => h("tr", {}, h("td", {}, h("strong", {}, i.term)), h("td", {}, i.places.join(", ")))))));
    out.replaceChildren(
      h("h2", {}, "Términos que destaca tu competidor y tú no mencionas"),
      r.missing.length ? table(r.missing) : h("p", { class: "ok" }, "No vemos términos importantes del competidor que te falten."),
      r.weaker.length ? h("h3", {}, "Los usas, pero sin destacarlos (él los pone en el título o en encabezados)") : "",
      r.weaker.length ? table(r.weaker) : "",
      h("p", { class: "tool-note" }, `Tu página: ${r.yourWords} palabras. La del competidor: ${r.competitorWords}. Términos en común: ${r.shared}. Comparamos lo que está escrito; no son datos de búsquedas de Google.`),
    );
  },
  "comprobador-enlaces-rotos": async (form, out) => {
    const url = urlOf(form);
    if (!url) return void out.replaceChildren(h("p", {}, "Escribe la dirección de la página."));
    const list = await api<{ url: string; links: Array<{ url: string; text: string; internal: boolean }>; total: number; batch: number }>("links", { url });
    if (!list.links.length) return void out.replaceChildren(h("p", {}, "No encontramos enlaces en esa página."));
    const label = { ok: "Funciona", redirect: "Redirige", broken: "Roto", blocked: "No deja comprobarlo", error: "No responde" } as const;
    const cls = { ok: "ok", redirect: "warn", broken: "bad", blocked: "warn", error: "warn" } as const;
    const progress = h("p", { "aria-live": "polite" }, `Comprobando ${list.links.length} enlaces…`);
    const tbody = h("tbody");
    const cells = new Map<string, HTMLElement>();
    for (const l of list.links) {
      const status = h("td", {}, "…");
      cells.set(l.url, status);
      tbody.append(h("tr", {}, h("td", {}, h("a", { href: l.url, rel: "nofollow noopener noreferrer", target: "_blank" }, l.url), l.text ? h("br") : "", l.text ? h("span", { class: "tool-note" }, l.text) : ""), h("td", {}, l.internal ? "Tu web" : "Externo"), status));
    }
    out.replaceChildren(h("h2", {}, "Resultado"), progress, h("div", { class: "tw" }, h("table", {}, h("thead", {}, h("tr", {}, h("th", {}, "Enlace"), h("th", {}, "Tipo"), h("th", {}, "Estado"))), tbody)));
    const counts = { ok: 0, redirect: 0, broken: 0, blocked: 0, error: 0 };
    for (let i = 0; i < list.links.length; i += list.batch) {
      const batch = list.links.slice(i, i + list.batch).map((l) => l.url);
      const r = await api<{ results: Array<{ url: string; status: number | null; verdict: keyof typeof label; location?: string | null }> }>("links/check", { urls: batch });
      for (const x of r.results) {
        counts[x.verdict]++;
        cells.get(x.url)?.replaceChildren(h("span", { class: cls[x.verdict] }, `${label[x.verdict]}${x.status ? ` (${x.status})` : ""}`), x.location ? h("br") : "", x.location ? h("span", { class: "tool-note" }, `→ ${x.location}`) : "");
      }
      progress.textContent = `Comprobados ${Math.min(i + list.batch, list.links.length)} de ${list.links.length}…`;
    }
    progress.replaceChildren(
      h("strong", { class: counts.broken ? "bad" : "ok" }, counts.broken ? `${counts.broken} enlace(s) roto(s)` : "Ningún enlace roto"),
      ` · ${counts.ok} funcionan · ${counts.redirect} redirigen · ${counts.blocked + counts.error} sin confirmar${list.total > list.links.length ? ` · la página tiene ${list.total} enlaces; hemos comprobado los ${list.links.length} primeros` : ""}.`,
    );
  },
  "comprobador-imagen-compartir": async (form, out) => {
    const url = urlOf(form);
    if (!url) return void out.replaceChildren(h("p", {}, "Escribe la dirección de la página."));
    type Img = { url: string; status: number | null; contentType: string; info: { format: string; width: number | null; height: number | null } | null; problems: string[] };
    const r = await api<{ url: string; pageTitle: string | null; tags: Record<string, string | null>; image: Img | null; problems: string[]; checkedAt: string }>("og-image", { url });
    const all = [...r.problems, ...(r.image?.problems ?? [])];
    const showImg = !!r.image && r.image.status !== null && r.image.status < 400 && r.image.info?.format !== "svg" && r.image.info?.format !== "unknown";
    const card = h(
      "div",
      { class: "og-card" },
      showImg ? h("img", { src: r.image!.url, alt: "", loading: "lazy", referrerpolicy: "no-referrer" }) : h("div", { class: "og-empty" }, "Sin imagen"),
      h("div", { class: "og-text" }, h("p", { class: "og-host" }, new URL(r.url).hostname), h("p", { class: "og-title" }, r.tags.title ?? r.pageTitle ?? "(sin título)"), h("p", { class: "og-desc" }, r.tags.description ?? "")),
    );
    out.replaceChildren(
      h("h2", {}, "Así se vería al compartirla (aproximado)"),
      card,
      r.image?.info?.width ? h("p", {}, `Imagen: ${r.image.info.format.toUpperCase()}, ${r.image.info.width}×${r.image.info.height} px.`) : "",
      all.length ? problemsList(all) : h("p", { class: "ok" }, "Todo correcto: imagen, título, descripción y tarjeta de X."),
      h("p", { class: "tool-note" }, `Comprobado el ${when(r.checkedAt)}. Cada red recorta y guarda en caché a su manera.`),
    );
  },
};

(() => {
  try {
    const main = document.querySelector<HTMLElement>("[data-tool]");
    const form = main?.querySelector<HTMLFormElement>("[data-form]");
    const out = main?.querySelector<HTMLElement>("[data-out]");
    const run = main ? TOOLS[main.dataset.tool ?? ""] : undefined;
    if (!main || !form || !out || !run) return;
    const button = form.querySelector<HTMLButtonElement>("button[type=submit]");
    const go = async () => {
      if (button?.disabled) return;
      try {
        const pending = run(form, out);
        if (pending) {
          if (button) button.disabled = true;
          out.replaceChildren(h("p", { class: "tool-note" }, "Comprobando… puede tardar unos segundos."));
          await pending;
        }
      } catch (e) {
        if (!(e instanceof ToolError)) console.warn("[herramientas]", e);
        out.replaceChildren(h("p", { class: "bad" }, e instanceof ToolError ? e.message : "No se pudo procesar. Revisa lo que has escrito."));
      } finally {
        if (button) button.disabled = false;
      }
    };
    const type = form.querySelector<HTMLSelectElement>("select[name=type]");
    const sync = () => form.querySelectorAll<HTMLElement>("[data-only]").forEach((el) => (el.hidden = !(el.dataset.only ?? "").split(" ").includes(type?.value ?? "")));
    type?.addEventListener("change", sync);
    sync();
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      void go();
    });
    // Live tools (no button): preview and calculator update as you type.
    if (!form.querySelector("button[type=submit]")) {
      form.addEventListener("input", () => void go());
      void go();
    }
  } catch (e) {
    console.warn("[herramientas] init failed", e);
  }
})();
