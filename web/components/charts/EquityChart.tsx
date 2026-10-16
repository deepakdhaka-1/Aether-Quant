"use client";

import { useMemo, useRef, useState, type PointerEvent } from "react";
import type { EquityPoint } from "@/components/types";

const W = 800;
const H = 300;
const PAD = { l: 8, r: 64, t: 16, b: 28 };

const fmtX = (s: number) =>
  new Date(s * 1000).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "2-digit", timeZone: "UTC" });
const fmtY = (v: number) => v.toLocaleString("en-US", { maximumFractionDigits: v >= 100 ? 0 : 2 });

/** Responsive, hand-rolled SVG equity chart with a hover/touch crosshair. */
export function EquityChart({ data, label = "Backtest equity" }: { data: EquityPoint[]; label?: string }) {
  const ref = useRef<SVGSVGElement>(null);
  const [hover, setHover] = useState<number | null>(null);

  const g = useMemo(() => {
    if (data.length < 2) return null;
    const xs = data.map((d) => d[0]);
    const ys = data.map((d) => d[1]);
    const x0 = xs[0], x1 = xs[xs.length - 1];
    let y0 = Math.min(...ys), y1 = Math.max(...ys);
    const pad = (y1 - y0) * 0.08 || 1;
    y0 -= pad; y1 += pad;
    const iw = W - PAD.l - PAD.r, ih = H - PAD.t - PAD.b;
    const sx = (x: number) => PAD.l + ((x - x0) / (x1 - x0 || 1)) * iw;
    const sy = (y: number) => PAD.t + ih - ((y - y0) / (y1 - y0 || 1)) * ih;
    const line = data.map((d, i) => `${i ? "L" : "M"}${sx(d[0]).toFixed(1)},${sy(d[1]).toFixed(1)}`).join("");
    const area = `${line}L${sx(x1).toFixed(1)},${PAD.t + ih}L${PAD.l},${PAD.t + ih}Z`;
    const yTicks = Array.from({ length: 4 }, (_, i) => y0 + ((y1 - y0) * (i + 0.5)) / 4);
    const xTicks = Array.from({ length: 4 }, (_, i) => x0 + ((x1 - x0) * i) / 3);
    // running max for drawdown in tooltip
    let peak = -Infinity;
    const dd = ys.map((y) => { peak = Math.max(peak, y); return peak > 0 ? ((y - peak) / peak) * 100 : 0; });
    const up = ys[ys.length - 1] >= ys[0];
    return { sx, sy, line, area, yTicks, xTicks, dd, up, ih };
  }, [data]);

  if (!g)
    return (
      <div className="flex h-56 items-center justify-center rounded-xl border border-dashed border-ink-700 text-sm text-mist-400">
        No equity curve recorded for this backtest yet.
      </div>
    );

  const color = g.up ? "#7cf5d4" : "#ff6b81";

  const onMove = (e: PointerEvent<SVGSVGElement>) => {
    const r = ref.current?.getBoundingClientRect();
    if (!r) return;
    const x = ((e.clientX - r.left) / r.width) * W;
    let best = 0, bd = Infinity;
    for (let i = 0; i < data.length; i++) {
      const d = Math.abs(g.sx(data[i][0]) - x);
      if (d < bd) { bd = d; best = i; }
    }
    setHover(best);
  };

  const p = hover !== null ? data[hover] : null;
  const px = p ? g.sx(p[0]) : 0;
  const py = p ? g.sy(p[1]) : 0;
  const start = data[0][1];

  return (
    <figure className="relative">
      <svg
        ref={ref}
        viewBox={`0 0 ${W} ${H}`}
        className="h-auto w-full touch-none select-none"
        role="img"
        aria-label={`${label}: from ${fmtY(start)} to ${fmtY(data[data.length - 1][1])} between ${fmtX(data[0][0])} and ${fmtX(data[data.length - 1][0])}`}
        onPointerMove={onMove}
        onPointerDown={onMove}
        onPointerLeave={() => setHover(null)}
      >
        <defs>
          <linearGradient id="eq-fill" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0" stopColor={color} stopOpacity=".22" />
            <stop offset="1" stopColor={color} stopOpacity="0" />
          </linearGradient>
        </defs>
        {g.yTicks.map((t) => (
          <g key={t}>
            <line x1={PAD.l} x2={W - PAD.r} y1={g.sy(t)} y2={g.sy(t)} stroke="#1d2a3d" strokeDasharray="2 4" />
            <text x={W - PAD.r + 8} y={g.sy(t) + 4} fill="#5f6f86" fontSize="11" fontFamily="var(--font-mono)">{fmtY(t)}</text>
          </g>
        ))}
        {g.xTicks.map((t, i) => (
          <text
            key={t}
            x={g.sx(t)}
            y={H - 8}
            fill="#5f6f86"
            fontSize="11"
            fontFamily="var(--font-mono)"
            textAnchor={i === 0 ? "start" : i === 3 ? "end" : "middle"}
          >
            {fmtX(t)}
          </text>
        ))}
        <line x1={PAD.l} x2={W - PAD.r} y1={g.sy(start)} y2={g.sy(start)} stroke="#2a3b54" />
        <path d={g.area} fill="url(#eq-fill)" />
        <path d={g.line} fill="none" stroke={color} strokeWidth="1.8" className="animate-draw" />
        {p && (
          <g pointerEvents="none">
            <line x1={px} x2={px} y1={PAD.t} y2={PAD.t + g.ih} stroke="#8291a7" strokeDasharray="3 3" />
            <circle cx={px} cy={py} r="4.5" fill="#05080d" stroke={color} strokeWidth="2" />
          </g>
        )}
      </svg>
      {p && hover !== null && (
        <div
          className="pointer-events-none absolute top-2 z-10 rounded-lg border border-ink-600 bg-ink-850/95 px-3 py-2 font-mono text-[11px] shadow-lg"
          style={{ left: `${(px / W) * 100}%`, transform: px > W * 0.6 ? "translateX(calc(-100% - 12px))" : "translateX(12px)" }}
          role="status"
        >
          <div className="text-mist-400">{fmtX(p[0])}</div>
          <div className="text-mist-100">Equity {fmtY(p[1])}</div>
          <div className={p[1] >= start ? "text-aether" : "text-loss"}>
            {p[1] >= start ? "+" : ""}{(((p[1] - start) / (start || 1)) * 100).toFixed(2)}% total
          </div>
          <div className="text-mist-400">DD {g.dd[hover].toFixed(2)}%</div>
        </div>
      )}
    </figure>
  );
}
