/**
 * Pages that lose Search Console clicks: a deterministic comparison of two 28-day periods.
 * No AI is involved and Google data never leaves this function (see the privacy policy and the Google verification).
 */
export interface PagePeriodRow {
  key: string;
  clicks: number;
  impressions: number;
  position: number;
}

export type DeclineReason = "position" | "impressions" | "ctr" | "gone";

export interface DecliningPage {
  page: string;
  clicksNow: number;
  clicksBefore: number;
  lostClicks: number;
  /** 0–1, share of the previous clicks that was lost. */
  drop: number;
  impressionsNow: number;
  impressionsBefore: number;
  positionNow: number | null;
  positionBefore: number;
  reason: DeclineReason;
}

export const DECLINE_REASON_LABEL: Record<DeclineReason, string> = {
  position: "Ha bajado de posición en Google. Revisa si el contenido sigue respondiendo mejor que los resultados que ahora están por delante y actualízalo.",
  impressions: "Aparece en menos búsquedas. Puede ser estacional o que la página ya no encaje con lo que se busca: revisa las consultas en Search Console.",
  ctr: "Mismas búsquedas pero menos clics. Revisa el título y la descripción que se ven en Google.",
  gone: "Ya no aparece entre tus páginas con clics. Comprueba que sigue publicada, indexada y sin redirecciones.",
};

/** Page rows imported per period: enough that the comparison is not limited to the top pages. */
export const GSC_PAGE_ROWS = 250;

export const DECLINE_DEFAULTS = { minLostClicks: 10, minDrop: 0.3, limit: 10 };

export function decliningPages(
  current: PagePeriodRow[],
  previous: PagePeriodRow[],
  opts: { minLostClicks?: number; minDrop?: number; limit?: number; currentComplete?: boolean } = {},
): DecliningPage[] {
  const { minLostClicks, minDrop, limit } = { ...DECLINE_DEFAULTS, ...opts };
  const now = new Map(current.map((r) => [r.key, r]));
  const out: DecliningPage[] = [];
  for (const before of previous) {
    const cur = now.get(before.key);
    // A page missing from a truncated current list may just be below the cut: only call it "gone" when the list is complete.
    if (!cur && !opts.currentComplete) continue;
    const clicksNow = cur?.clicks ?? 0;
    const lost = before.clicks - clicksNow;
    if (lost < minLostClicks || before.clicks <= 0 || lost / before.clicks < minDrop) continue;
    let reason: DeclineReason;
    if (!cur) reason = "gone";
    else if (cur.position - before.position >= 2) reason = "position";
    else if (before.impressions > 0 && (before.impressions - cur.impressions) / before.impressions >= minDrop) reason = "impressions";
    else reason = "ctr";
    out.push({
      page: before.key,
      clicksNow,
      clicksBefore: before.clicks,
      lostClicks: lost,
      drop: lost / before.clicks,
      impressionsNow: cur?.impressions ?? 0,
      impressionsBefore: before.impressions,
      positionNow: cur ? cur.position : null,
      positionBefore: before.position,
      reason,
    });
  }
  return out.sort((a, b) => b.lostClicks - a.lostClicks || a.page.localeCompare(b.page)).slice(0, limit);
}
