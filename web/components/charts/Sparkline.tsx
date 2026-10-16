import type { EquityPoint } from "@/components/types";

/** Tiny static equity line (server-safe, no ids so many can share a page). */
export function Sparkline({ data, height = 48, className }: { data: EquityPoint[]; height?: number; className?: string }) {
  const w = 200;
  if (data.length < 2)
    return (
      <svg viewBox={`0 0 ${w} ${height}`} className={className} preserveAspectRatio="none" role="img" aria-label="No equity curve yet">
        <line x1="0" x2={w} y1={height / 2} y2={height / 2} stroke="#2a3b54" strokeDasharray="4 4" />
      </svg>
    );
  const xs = data.map((d) => d[0]);
  const ys = data.map((d) => d[1]);
  const [x0, x1] = [Math.min(...xs), Math.max(...xs)];
  const [y0, y1] = [Math.min(...ys), Math.max(...ys)];
  const sx = (x: number) => ((x - x0) / (x1 - x0 || 1)) * w;
  const sy = (y: number) => height - 2 - ((y - y0) / (y1 - y0 || 1)) * (height - 4);
  const line = data.map((d, i) => `${i ? "L" : "M"}${sx(d[0]).toFixed(1)},${sy(d[1]).toFixed(1)}`).join("");
  const up = ys[ys.length - 1] >= ys[0];
  const c = up ? "#7cf5d4" : "#ff6b81";
  return (
    <svg viewBox={`0 0 ${w} ${height}`} className={className} preserveAspectRatio="none" role="img" aria-label={`Equity curve, ${up ? "up" : "down"} overall`}>
      <path d={`${line}L${w},${height}L0,${height}Z`} fill={c} fillOpacity={0.08} />
      <path d={line} fill="none" stroke={c} strokeWidth="1.6" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}
