import { GUARANTEE, PLAN_OFFERS } from "./pricing";
/**
 * Single source of truth for what each module really does today. The public site (badges and module
 * names), llms.txt (generated at build time by apps/web/vite.config.ts) and the app menu read from here,
 * so nothing can say «Disponible» for something that is not built. A test fails if they drift apart.
 * status: available = usable end to end · partial = usable, with a named external limit · building.
 */
export type FeatureStatus = "available" | "partial" | "building";
export interface FeatureInfo {
  key: string;
  label: string;
  status: FeatureStatus;
  /** Plain-language limit shown next to «Parcial». */
  limit?: string;
  /** One customer-language sentence: what it does today. */
  summary: string;
  /** Concrete capabilities that work today (listed in llms.txt). */
  details?: string[];
  /** App menu modules (path segment after /o/:orgId) whose status this feature defines. */
  menu: string[];
}

export const FEATURES: FeatureInfo[] = [
  {
    key: "seo",
    label: "SEO + GEO + AEO",
    status: "available",
    summary: "Revisa tu web como la ven Google y los asistentes con IA, enseña la página exacta de cada problema y ordena qué arreglar primero.",
    details: [
      "Auditoría pública y no intrusiva de una web a partir de su URL (respeta robots.txt): problemas técnicos con evidencia por URL, tipo de página, salud técnica y potencial orgánico (medidas derivadas, con método).",
      "Informe de auditoría y brief de cada mejora descargables en Markdown o HTML, sin IA y en todos los planes.",
      "Borradores de corrección creados desde cada hallazgo (sin IA ni créditos), con comprobaciones antes de aprobar: campos pendientes, promesas de resultados, cifras sin fuente y precios sin verificar.",
      "Content Studio: borradores con IA o escritos a mano, versiones, revisión y aprobación por roles, exportación Markdown/HTML.",
      "Publicación en tu WordPress (plan Starter o superior): conexión con contraseña de aplicación, solo contenido aprobado, como borrador o publicado, sin duplicados y con opción de retirarlo a borrador.",
      "Plugin gratuito «DNI Growth Connector» para WordPress (opcional): título y descripción SEO compatibles con Yoast SEO y Rank Math, datos estructurados JSON-LD, llms.txt y correcciones técnicas que apruebas una a una y deshaces con un clic.",
      "Perfil de marca extraído con fuente de cada dato y confirmación humana; plan de crecimiento de 30 días editable y exportable.",
      "Asesor de crecimiento con IA que responde con los datos observados de tu auditoría y cita la URL de evidencia.",
      "Conexión de solo lectura con Google Search Console y Google Analytics 4: datos observados de tu propia cuenta, con fuente y fecha.",
      "Monitor de visibilidad en IA por muestreo (no es cobertura total de todas las consultas reales).",
    ],
    menu: ["analyze", "audits", "advisor", "seo-tecnico", "search-console", "ai-visibility", "content"],
  },
  {
    key: "ads",
    label: "Anuncios multicanal",
    status: "partial",
    limit: "Borradores, aprobación y Spend Guardian disponibles; publicar en Meta/Google requiere su aprobación (se exporta el paquete para subirlo).",
    summary: "Prepara campañas para Meta, Google, TikTok y LinkedIn que otra persona del equipo aprueba dentro de tus límites de gasto.",
    menu: ["ads"],
  },
  {
    key: "video",
    label: "Estudio de vídeo",
    status: "available",
    summary: "Vídeos cortos por escenas con texto, imágenes, música y subtítulos, creados en tu navegador.",
    details: ["Creative Studio: imágenes creadas con IA a partir de una descripción, guardadas en privado en tu cuenta y con su coste en créditos."],
    menu: ["video", "creative"],
  },
  {
    key: "social",
    label: "Publicación en Facebook e Instagram",
    status: "partial",
    limit: "Meta tiene que aprobar la app de DNI Growth para que cualquier cliente pueda conectar sus cuentas; hasta entonces solo funciona con las cuentas autorizadas en la app.",
    summary: "Conecta tu página de Facebook y tu cuenta profesional de Instagram, prepara publicaciones con imagen, apruébalas y se publican solas a la hora programada.",
    details: [
      "Conexión con Facebook Login for Business: solo las páginas y cuentas de Instagram que tú eliges; los permisos se pueden retirar desde DNI Growth o desde Facebook.",
      "Cada publicación pasa por aprobación de una persona con permiso de aprobar antes de llegar a Meta; botón de pausa para detener todas las publicaciones.",
      "Comprobación previa de las reglas de Instagram (JPG, proporción 4:5 a 1,91:1, 2.200 caracteres, 30 hashtags) para que no falle al publicar.",
      "Nunca se publica dos veces: reintentos seguros y aviso si no se puede confirmar el resultado.",
    ],
    menu: ["social"],
  },
  {
    key: "landings",
    label: "Landing pages",
    status: "available",
    summary: "Páginas de captación por bloques con formularios antispam, consentimiento claro, dominio propio y pruebas A/B.",
    menu: ["landings"],
  },
  {
    key: "crm",
    label: "CRM y automatización",
    status: "available",
    summary: "Contactos sin duplicados con su origen, etapas de venta, tareas y seguimientos automáticos con permiso.",
    menu: ["crm", "automations"],
  },
  {
    key: "attribution",
    label: "Ingresos y atribución",
    status: "partial",
    limit: "Atribución UTM → contacto → venta con el valor declarado en el CRM; sin gasto publicitario conectado no se calcula ROAS.",
    summary: "Del clic al contacto y del contacto a la venta, con el valor que declara tu equipo en el CRM.",
    menu: ["attribution"],
  },
  {
    key: "agents",
    label: "Agentes inteligentes",
    status: "partial",
    limit: "Los agentes proponen; las acciones con efecto externo siempre piden aprobación.",
    summary: "Preparan auditorías, borradores y propuestas; ves en qué está cada tarea y puedes pararla.",
    menu: ["jobs"],
  },
  {
    key: "enterprise",
    label: "Control Enterprise",
    status: "available",
    summary: "Varias empresas o clientes en una cuenta, con datos separados, permisos por persona e historial de quién hizo qué.",
    menu: ["team", "audit-log"],
  },
];

export const FEATURE_STATUS_LABEL: Record<FeatureStatus, string> = { available: "Disponible", partial: "Parcial", building: "En desarrollo" };

/** Planned capabilities that are not part of any module yet. Listed as «no disponible todavía». */
export const NOT_YET_AVAILABLE: string[] = [
  "Publicación directa en Shopify, Ghost y Webflow. Hoy se exportan en Markdown o HTML (WordPress ya está disponible).",
  "Volumen y dificultad de búsqueda con un proveedor de datos licenciado. Hoy se usan las consultas reales de tu Search Console.",
];

/** The feature that defines the status of an app menu module, if any. */
export function featureForMenu(module: string): FeatureInfo | undefined {
  return FEATURES.find((f) => f.menu.includes(module));
}

/** Badge for the app menu: only for modules that are not fully available («Parcial», «En desarrollo»). */
export function menuStatusBadge(module: string): { label: string; title: string } | null {
  const f = featureForMenu(module);
  if (!f || f.status === "available") return null;
  return { label: FEATURE_STATUS_LABEL[f.status], title: f.limit ?? FEATURE_STATUS_LABEL[f.status] };
}

/**
 * Body of /llms.txt, generated at build time from FEATURES (apps/web/vite.config.ts). Statuses and limits
 * are never written by hand, so llms.txt says exactly what the site badges and the app menu say.
 */
export function buildLlmsTxt(siteUrl: string): string {
  const url = siteUrl.replace(/\/$/, "");
  const modules = FEATURES.map((f) => {
    const lines = [`### ${f.label} — ${FEATURE_STATUS_LABEL[f.status]}`, f.summary];
    for (const d of f.details ?? []) lines.push(`- ${d}`);
    if (f.limit) lines.push(`- Límite: ${f.limit}`);
    return lines.join("\n");
  }).join("\n\n");
  const building = [...FEATURES.filter((f) => f.status === "building").map((f) => `${f.label}: ${f.summary}`), ...NOT_YET_AVAILABLE];
  return `# DNI Growth

> Software de crecimiento orgánico con IA para pymes y agencias: más clientes desde Google y desde asistentes como ChatGPT, con pruebas. Audita tu web (SEO técnico, GEO y AEO) con evidencia por URL, ordena qué arreglar primero, prepara borradores revisables y mide con tus propios datos de Google. Nada se publica ni se gasta sin tu aprobación.

El estado de cada módulo sale del mismo registro que usa la aplicación: Disponible (funciona de punta a punta), Parcial (funciona, con el límite indicado) o En desarrollo.

## Módulos y estado

${modules}

## En desarrollo (no disponible todavía)
${building.map((b) => `- ${b}`).join("\n")}

## Planes y precios (EUR al mes, IVA aparte; anual = 2 meses gratis)
${PLAN_OFFERS.map((o) => `- ${o.name}: ${o.monthly === 0 ? "gratis" : `${o.monthly} € al mes o ${o.yearlyPerMonth} € al mes en anual`}${o.trialDays ? `, ${o.trialDays} días de prueba gratis` : ""}. ${o.tagline}.`).join("\n")}
- Garantía medible de ${GUARANTEE.days} días en ${GUARANTEE.plans.map((c) => PLAN_OFFERS.find((o) => o.code === c)?.name ?? c).join(", ")}: condiciones en ${url}/legal/garantia

## Principios
- Ninguna métrica sin fuente ni fecha. No se garantizan posiciones en buscadores ni menciones en motores de IA.
- Nada se publica ni se gasta sin aprobación explícita.
- Analítica de uso propia, sin cookies y sin guardar direcciones IP.

## Enlaces
- [Inicio](${url}/)
- [Precios](${url}/precios)
- [Blog](${url}/blog)
- [Seguridad y confianza](${url}/seguridad)
- [Crear cuenta y auditar una web](${url}/app/register)
- [Privacidad](${url}/legal/privacidad)
- [Condiciones de uso](${url}/legal/condiciones)
- [Aviso legal](${url}/legal/aviso-legal)
`;
}
