/**
 * Single source of truth for what each module really does today. The public site, the app menu and
 * the docs read from here, so a badge can never say «Disponible» for something that is not built.
 * status: available = usable end to end · partial = usable, with a named external limit · building.
 */
export type FeatureStatus = "available" | "partial" | "building";
export interface FeatureInfo {
  key: string;
  label: string;
  status: FeatureStatus;
  /** Plain-language limit shown next to «Parcial». */
  limit?: string;
}

export const FEATURES: FeatureInfo[] = [
  { key: "seo", label: "SEO + GEO + AEO", status: "available" },
  { key: "ads", label: "Anuncios multicanal", status: "partial", limit: "Borradores, aprobación y Spend Guardian disponibles; publicar en Meta/Google requiere su aprobación (se exporta el paquete para subirlo)." },
  { key: "video", label: "Estudio de vídeo", status: "available" },
  { key: "landings", label: "Landing pages", status: "available" },
  { key: "crm", label: "CRM y automatización", status: "available" },
  { key: "attribution", label: "Ingresos y atribución", status: "partial", limit: "Atribución UTM → contacto → venta con el valor declarado en el CRM; sin gasto publicitario conectado no se calcula ROAS." },
  { key: "agents", label: "Agentes inteligentes", status: "partial", limit: "Los agentes proponen; las acciones con efecto externo siempre piden aprobación." },
  { key: "enterprise", label: "Control Enterprise", status: "available" },
];

export const FEATURE_STATUS_LABEL: Record<FeatureStatus, string> = { available: "Disponible", partial: "Parcial", building: "En desarrollo" };
