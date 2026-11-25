/**
 * Public status: /estado (HTML, same shell as the blog) and /api/v1/public/status (JSON).
 * Shows only the result of the automatic checks (no customer data, no personal data).
 */
import type { Hono } from "hono";
import type { AppEnv } from "../env";
import { STATUS_INTERVAL_MIN, statusSummary, type CheckSummary } from "../lib/status";
import { fill, PAGE_HEADERS, shell } from "./site-blog";

const esc = (s: string) => s.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);
const fmt = (iso: string | null) => (iso ? `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC` : "—");
const pct = (v: number | null) => (v === null ? "—" : `${v.toLocaleString("es-ES", { maximumFractionDigits: 2 })} %`);

function bars(c: CheckSummary, today: Date): string {
  const byDay = new Map(c.days.map((d) => [d.day, d]));
  const cells: string[] = [];
  for (let i = 89; i >= 0; i--) {
    const day = new Date(today.getTime() - i * 86_400_000).toISOString().slice(0, 10);
    const d = byDay.get(day);
    const color = !d ? "#2a2a33" : d.failed === 0 ? "#3fb950" : d.failed / d.total > 0.1 ? "#f85149" : "#d29922";
    const label = !d ? `${day}: sin datos` : d.failed === 0 ? `${day}: sin fallos` : `${day}: ${d.failed} de ${d.total} comprobaciones fallaron`;
    cells.push(`<span title="${label}" style="flex:1;min-width:2px;height:28px;border-radius:2px;background:${color}"></span>`);
  }
  return `<div aria-hidden="true" style="display:flex;gap:2px;margin:8px 0 4px">${cells.join("")}</div><p style="display:flex;justify-content:space-between;font-size:12px;color:#9a9aa6;margin:0"><span>Hace 90 días</span><span>Hoy</span></p>`;
}

export function renderStatusMain(data: Awaited<ReturnType<typeof statusSummary>>, now = new Date()): string {
  const anyData = data.checks.some((c) => c.ok !== null);
  const head = !anyData
    ? `<p class="blog-lead"><strong>Las comprobaciones automáticas acaban de empezar.</strong> En unos minutos aparecerán aquí los primeros resultados.</p>`
    : data.allOk
      ? `<p class="blog-lead"><strong style="color:#3fb950">● Todo funciona con normalidad.</strong> Última comprobación: ${fmt(data.checks.map((c) => c.lastCheckedAt).filter(Boolean).sort().pop() ?? null)}.</p>`
      : `<p class="blog-lead"><strong style="color:#f85149">● Hay una incidencia en curso.</strong> Lo estamos revisando; abajo ves qué parte está afectada.</p>`;
  const rows = data.checks
    .map((c) => {
      const state = c.ok === null ? "Sin datos todavía" : c.ok ? "✓ Funciona" : "✗ Con incidencias";
      return `<section style="margin-top:28px"><h2 style="margin-bottom:4px">${esc(c.label)} · <span style="color:${c.ok === null ? "#9a9aa6" : c.ok ? "#3fb950" : "#f85149"}">${state}</span></h2>
<p style="margin:0;color:#9a9aa6">${esc(c.description)}</p>
${bars(c, now)}
<p style="font-size:14px;margin:8px 0 0">Disponibilidad: 24 h ${pct(c.uptime24h)} · 7 días ${pct(c.uptime7d)} · 90 días ${pct(c.uptime90d)}. Última comprobación: ${fmt(c.lastCheckedAt)}${c.detail ? `. ${esc(c.detail)}` : ""}</p></section>`;
    })
    .join("\n");
  return `<h1>Estado del servicio</h1>
${head}
<p>Cada ${STATUS_INTERVAL_MIN} minutos un proceso automático comprueba de verdad cada parte de DNI Growth: sirve la web, consulta la base de datos, revisa las colas de trabajo, los avisos de Stripe, las sincronizaciones con Google y el correo, y comprueba que existe la copia de seguridad del día. La auditoría de prueba se hace una vez por hora. Guardamos 90 días de historial. Si algo falla dos veces seguidas, avisamos al equipo por correo.</p>
<p style="font-size:14px;color:#9a9aa6">Qué significan los colores: verde, sin fallos ese día; amarillo, algún fallo aislado; rojo, más del 10 % de comprobaciones con fallo; gris, sin datos. Si notas algo raro que no aparece aquí, escribe a <a href="mailto:soporte@dnigrowth.com">soporte@dnigrowth.com</a>.</p>
${rows}
<p style="margin-top:32px"><a href="/api/v1/public/status">Ver estos datos en formato JSON</a> · <a href="/seguridad">Seguridad</a> · <a href="/subencargados">Subencargados</a></p>`;
}

export function registerStatusPage(app: Hono<AppEnv>) {
  app.get("/api/v1/public/status", async (c) => {
    const data = await statusSummary(c.env.DB);
    return c.json(
      {
        ...data,
        intervalMinutes: STATUS_INTERVAL_MIN,
        measurement: { type: "observed", source: "comprobaciones automáticas de DNI Growth", caveats: "Comprobaciones sintéticas cada 5 minutos; no miden la experiencia de cada usuario." },
      },
      200,
      { "cache-control": "public, max-age=60" },
    );
  });
  app.get("/estado", async (c) => {
    const origin = c.env.APP_ORIGIN.replace(/\/$/, "");
    const data = await statusSummary(c.env.DB);
    const html = fill(await shell(c), {
      title: "Estado del servicio · DNI Growth",
      description: "Estado en directo de DNI Growth: web, aplicación, auditorías, pagos, Google, correo y copias de seguridad, con 90 días de historial.",
      canonical: `${origin}/estado`,
      ogType: "website",
      main: renderStatusMain(data),
      jsonLd: { "@context": "https://schema.org", "@type": "WebPage", name: "Estado del servicio", url: `${origin}/estado`, inLanguage: "es", isPartOf: { "@type": "WebSite", name: "DNI Growth", url: origin } },
    });
    return c.body(html, 200, { ...PAGE_HEADERS, "cache-control": "public, max-age=60" });
  });
}
