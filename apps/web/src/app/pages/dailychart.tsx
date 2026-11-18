import { useState, type ReactNode } from "react";

/** Calendar day (YYYY-MM-DD as reported by the source) without inventing a time. */
export const fmtDay = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleDateString("es-ES", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });

/**
 * Single-series daily bar chart: one axis, recessive grid, rounded data ends, hover tooltip.
 * Callers always pair it with a table view.
 */
export function DailyChart<R extends { date: string }>({
  rows,
  value,
  fmt,
  label,
  tooltip,
  minMax = 1,
}: {
  rows: R[];
  value: (r: R) => number;
  fmt: (v: number) => string;
  label: string;
  tooltip: (r: R) => ReactNode;
  minMax?: number;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const W = 720;
  const H = 200;
  const pad = { l: 44, r: 8, t: 10, b: 24 };
  const vals = rows.map((r) => Number(value(r)) || 0);
  const max = Math.max(...vals, minMax);
  const bw = (W - pad.l - pad.r) / Math.max(rows.length, 1);
  const y = (v: number) => pad.t + (H - pad.t - pad.b) * (1 - v / max);
  const ticks = [0, 0.5, 1].map((f) => f * max);
  const step = Math.max(1, Math.ceil(rows.length / 6));
  const h = hover !== null ? rows[hover] : null;
  return (
    <div className="relative">
      <svg viewBox={`0 0 ${W} ${H}`} className="h-auto w-full" role="img" aria-label={label} onMouseLeave={() => setHover(null)}>
        {ticks.map((t) => (
          <g key={t}>
            <line x1={pad.l} x2={W - pad.r} y1={y(t)} y2={y(t)} className="stroke-line" strokeWidth={1} />
            <text x={pad.l - 6} y={y(t) + 4} textAnchor="end" className="fill-mute text-[10px]">
              {fmt(t)}
            </text>
          </g>
        ))}
        {rows.map((r, i) => {
          const v = vals[i]!;
          const x = pad.l + i * bw;
          const top = y(v);
          const hgt = Math.max(0, H - pad.b - top);
          const w = Math.max(1, bw - 2);
          const rad = Math.min(4, w / 2, hgt);
          return (
            <g key={r.date} onMouseEnter={() => setHover(i)}>
              <rect x={x} y={pad.t} width={bw} height={H - pad.t - pad.b} fill="transparent" />
              {hgt > 0 && (
                <path
                  d={`M${x + 1},${H - pad.b} V${top + rad} Q${x + 1},${top} ${x + 1 + rad},${top} H${x + 1 + w - rad} Q${x + 1 + w},${top} ${x + 1 + w},${top + rad} V${H - pad.b} Z`}
                  className={hover === i ? "fill-ink" : "fill-accent-text"}
                />
              )}
              {i % step === 0 && (
                <text x={x + bw / 2} y={H - 8} textAnchor="middle" className="fill-mute text-[10px]">
                  {new Date(`${r.date}T00:00:00Z`).toLocaleDateString("es-ES", { day: "numeric", month: "short", timeZone: "UTC" })}
                </text>
              )}
            </g>
          );
        })}
      </svg>
      {h && (
        <div className="pointer-events-none absolute right-2 top-2 rounded-xl border border-line bg-surface px-3 py-2 text-xs shadow-sm" role="status">
          <p className="font-medium">{new Date(`${h.date}T00:00:00Z`).toLocaleDateString("es-ES", { weekday: "short", day: "numeric", month: "long", timeZone: "UTC" })}</p>
          <p className="text-mute">{tooltip(h)}</p>
        </div>
      )}
    </div>
  );
}
