import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { pct, stamp } from "../lib/format";
import { runHref } from "../lib/routes";

export interface ScorePoint {
  id: string;
  created: number;
  value: number;
  lo?: number;
  hi?: number;
  note: string;
}

/** Score over time: one line, a dot per check, the likely range as a faint band. Click a dot to open that report. */
export function ScoreChart({ points, label }: { points: ScorePoint[]; label: string }) {
  const nav = useNavigate();
  const [hover, setHover] = useState<number | null>(null);
  const W = 640;
  const Hh = 160;
  const pad = { l: 40, r: 16, t: 12, b: 26 };
  const iw = W - pad.l - pad.r;
  const ih = Hh - pad.t - pad.b;
  const x = (i: number) => pad.l + (points.length === 1 ? iw / 2 : (i / (points.length - 1)) * iw);
  const y = (v: number) => pad.t + (1 - v) * ih;
  const line = points.map((p, i) => `${i ? "L" : "M"}${x(i)},${y(p.value)}`).join(" ");
  const banded = points.every((p) => p.lo !== undefined && p.hi !== undefined);
  const band = banded
    ? `${points.map((p, i) => `${i ? "L" : "M"}${x(i)},${y(p.hi!)}`).join(" ")} ${points
        .map((_, i) => `L${x(points.length - 1 - i)},${y(points[points.length - 1 - i].lo!)}`)
        .join(" ")} Z`
    : "";
  const h = hover === null ? null : points[hover];
  return (
    <figure className="score-chart">
      <figcaption className="sr">{label}</figcaption>
      <svg viewBox={`0 0 ${W} ${Hh}`} role="img" aria-label={label} onMouseLeave={() => setHover(null)}>
        {[0, 0.5, 1].map((g) => (
          <g key={g}>
            <line x1={pad.l} x2={W - pad.r} y1={y(g)} y2={y(g)} className="sc-grid" />
            <text x={pad.l - 8} y={y(g) + 4} className="sc-axis" textAnchor="end">
              {pct(g)}
            </text>
          </g>
        ))}
        {band && <path d={band} className="sc-band" />}
        <path d={line} className="sc-line" />
        {points.map((p, i) => (
          <g key={p.id}>
            <circle cx={x(i)} cy={y(p.value)} r={hover === i ? 6 : 4.5} className="sc-dot" />
            <rect
              x={x(i) - 18}
              y={pad.t}
              width={36}
              height={ih}
              className="sc-hit"
              onMouseEnter={() => setHover(i)}
              onClick={() => nav(runHref(p.id))}
            >
              <title>{`${stamp(p.created)}: ${pct(p.value)}. ${p.note}`}</title>
            </rect>
            {(i === 0 || i === points.length - 1) && (
              <text x={x(i)} y={Hh - 6} className="sc-axis" textAnchor={points.length === 1 ? "middle" : i === 0 ? "start" : "end"}>
                {new Date(p.created * 1000).toLocaleDateString(undefined, { month: "short", day: "numeric" })}
              </text>
            )}
          </g>
        ))}
      </svg>
      <p className="sc-readout mono" aria-live="polite">
        {h ? (
          <>
            {stamp(h.created)} · <b>{pct(h.value)}</b>
            {h.lo !== undefined && h.hi !== undefined && <span className="quiet"> (likely {pct(h.lo)}–{pct(h.hi)})</span>} · {h.note}
          </>
        ) : (
          <span className="quiet">hover a dot for details, click to open that report</span>
        )}
      </p>
    </figure>
  );
}
