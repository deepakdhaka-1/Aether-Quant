// Hero data panel: what a published strategy looks like on Aether.
// The equity path is a deterministic illustration and is labelled as such.

const N = 90;

function equity(): number[] {
  let seed = 23;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) - 0.5;
  const out = [100];
  for (let i = 1; i < N; i++) out.push(out[i - 1] * (1 + (0.18 + rnd() * 1.6 + Math.sin(i / 9) * 0.25) / 100));
  return out;
}

const METRICS: [string, string][] = [
  ["Out-of-sample return", "+11.4%"],
  ["Sharpe ratio", "1.32"],
  ["Max drawdown", "−8.7%"],
  ["Trades tested", "64"],
];

export default function StrategyPanel() {
  const eq = equity();
  const W = 520, H = 120;
  const lo = Math.min(...eq), hi = Math.max(...eq);
  const pts = eq.map((v, i) => [(i / (N - 1)) * W, H - 6 - ((v - lo) / (hi - lo)) * (H - 12)]);
  const line = pts.map(([x, y], i) => `${i ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`).join("");
  const area = `${line}L${W},${H}L0,${H}Z`;

  return (
    <div className="rounded-[10px] bg-[#0C1A26] p-6 text-white shadow-[0_30px_70px_-35px_rgba(12,26,38,.65)] sm:p-7">
      <div className="flex items-start justify-between gap-4">
        <div>
          <p className="text-[13px] text-[#8FA3B3]">Published strategy</p>
          <p className="mt-1 font-[family-name:var(--aq-serif)] text-[1.55rem] leading-tight">NVIDIA Trend Rider</p>
        </div>
        <span className="mt-1 inline-flex items-center gap-2 rounded-full border border-[#2C4A5C] px-3 py-1 text-xs text-[#BFD3DD]">
          <span className="h-1.5 w-1.5 rounded-full bg-[#4FB39A]" /> Long only
        </span>
      </div>

      <div className="mt-4 flex flex-wrap gap-2 font-[family-name:var(--aq-mono)] text-[12px] text-[#9FB2C0]">
        {["xyz:NVDA", "4h bars", "Stop 3%", "Max 2× leverage"].map((t) => (
          <span key={t} className="rounded border border-[#22394A] px-2 py-0.5">{t}</span>
        ))}
      </div>

      <dl className="mt-6 grid grid-cols-2 gap-x-6 gap-y-5">
        {METRICS.map(([k, v]) => (
          <div key={k}>
            <dt className="text-[12.5px] text-[#8FA3B3]">{k}</dt>
            <dd className="mt-1 font-[family-name:var(--aq-mono)] text-[1.35rem] tabular-nums">{v}</dd>
          </div>
        ))}
      </dl>

      <svg viewBox={`0 0 ${W} ${H}`} className="mt-6 block h-auto w-full" aria-hidden>
        <defs>
          <linearGradient id="aq-fill" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0" stopColor="#4FB39A" stopOpacity=".28" />
            <stop offset="1" stopColor="#4FB39A" stopOpacity="0" />
          </linearGradient>
        </defs>
        <path d={area} fill="url(#aq-fill)" />
        <path d={line} fill="none" stroke="#4FB39A" strokeWidth="1.8" />
      </svg>

      <p className="mt-4 border-t border-[#1D3243] pt-4 text-[12px] leading-relaxed text-[#7D93A3]">
        Illustrative example of a strategy listing. Figures are hypothetical, not a track record.
      </p>
    </div>
  );
}
