"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { createTimeline, stagger, type Timeline } from "animejs";
import { useReducedMotion, useScrollPresence } from "./useInView";

const GREEN = "#1E6B62";
const RED = "#C74747";
const INK = "#0C1A26";
const MUTED = "#5A6874";

export const GATES = [
  { short: "Unseen data", name: "Tested on unseen data", threshold: "Last 30% of history", applies: "Held back during design",
    body: "The final 30% of price history is locked away while a rule is designed, then used once as the exam.", reason: "fell apart on unseen data" },
  { short: "Sharpe ≥ 0.5", name: "Sharpe ≥ 0.5 in both periods", threshold: "Sharpe ≥ 0.5", applies: "In both periods",
    body: "Return per unit of risk has to clear 0.5 on the design period and again on the period it never saw.", reason: "Sharpe below 0.5" },
  { short: "Drawdown ≤ −35%", name: "Drawdown no worse than −35%", threshold: "No worse than −35%", applies: "Peak to trough, both periods",
    body: "The deepest fall from a high point must stay inside −35%, in both periods.", reason: "drawdown past −35%" },
  { short: "15+ trades", name: "15+ trades", threshold: "15+ trades", applies: "No conclusions from a handful",
    body: "A handful of lucky trades proves nothing. Each strategy needs at least 15 to be judged.", reason: "too few trades" },
  { short: "Fees included", name: "Fees included", threshold: "Fees charged on every fill", applies: "Exchange fee plus ours",
    body: "Every simulated fill pays the exchange fee and ours. An edge that only exists before costs is not an edge.", reason: "edge gone after fees" },
] as const;

// Illustrative counts after each wall, and the dot model that stands in for them.
const COUNTS = [1240, 412, 167, 58, 19, 2];
const N = 40;
const SURVIVE = [24, 14, 8, 4, 2];
const VW = 1160;
const VH = 400;
const TOP = 74; // wall top
const BOT = 326; // wall bottom
const MID = (TOP + BOT) / 2;
const WX = [250, 412, 574, 736, 898];
const LANDX = 1010;
const fmt = (n: number) => n.toLocaleString("en-US");

function seeded(seed: number) {
  let s = seed;
  return () => ((s = (s * 16807) % 2147483647) - 1) / 2147483646;
}

type Dot = { long: boolean; failAt: number; x: number[]; y: number[] };

function buildModel(): Dot[] {
  const rnd = seeded(11);
  const order = Array.from({ length: N }, (_, i) => i).sort(() => rnd() - 0.5);
  const failAt = new Array<number>(N).fill(5);
  let cursor = N;
  for (let g = 0; g < 5; g++) {
    for (let k = SURVIVE[g]; k < cursor; k++) failAt[order[k]] = g;
    cursor = SURVIVE[g];
  }
  const dots: Dot[] = Array.from({ length: N }, (_, i) => ({
    long: i === order[0] ? true : i === order[1] ? false : rnd() > 0.45,
    failAt: failAt[i], x: [], y: [],
  }));
  // Stage 0: dense pool on the left, 5 columns x 8 rows with a little jitter.
  dots.forEach((d, i) => {
    d.x[0] = 48 + (i % 5) * 30 + (rnd() - 0.5) * 8;
    d.y[0] = TOP + 18 + Math.floor(i / 5) * 31 + (rnd() - 0.5) * 8;
  });
  for (let s = 1; s <= 5; s++) {
    const alive = dots.filter((d) => d.failAt >= s);
    if (s === 5) {
      alive.forEach((d) => { d.x[5] = LANDX; d.y[5] = d.long ? MID - 34 : MID + 34; });
      continue;
    }
    const cols = alive.length > 12 ? 3 : alive.length > 4 ? 2 : 1;
    const rows = Math.ceil(alive.length / cols);
    const cx = (WX[s - 1] + WX[s]) / 2;
    alive.forEach((d, j) => {
      const c = j % cols, r = Math.floor(j / cols);
      d.x[s] = cx - ((cols - 1) * 22) / 2 + c * 22;
      d.y[s] = MID - ((rows - 1) * 22) / 2 + r * 22;
    });
  }
  return dots;
}

export default function GateFunnel() {
  const reduced = useReducedMotion();
  const dots = useMemo(buildModel, []);
  const root = useRef<HTMLDivElement>(null);
  const counter = useRef<HTMLSpanElement>(null);
  const tl = useRef<Timeline | null>(null);
  const played = useRef(false);
  const [stage, setStage] = useState(0);
  const [active, setActive] = useState<number | null>(null);

  useEffect(() => {
    const el = root.current;
    if (!el) return;
    played.current = false;
    const q = (s: string) => Array.from(el.querySelectorAll<SVGElement>(s));
    const circles = q("[data-dot]");
    const idx = (t: unknown) => Number((t as SVGElement).dataset.i);
    const counterObj = { v: COUNTS[0] };
    const paint = () => { if (counter.current) counter.current.textContent = fmt(Math.round(counterObj.v)); };
    const t = createTimeline({ autoplay: false, defaults: { ease: "outQuart" } });
    // Pool drifts in from the left.
    t.add(circles, { cx: (x: unknown) => dots[idx(x)].x[0], opacity: [0, 1], duration: 700, delay: stagger(12) }, 0);
    for (let s = 0; s < 5; s++) {
      const T = 900 + s * 1150;
      const fails = circles.filter((c) => Number(c.dataset.fail) === s);
      const alive = circles.filter((c) => Number(c.dataset.fail) > s);
      t.add(q(`[data-wall="${s}"]`), { stroke: INK, duration: 200 }, T);
      // Failures run into the wall, then drop out of the stream.
      t.add(fails, { cx: WX[s] - 12, duration: 420, ease: "inQuad", delay: stagger(10) }, T);
      t.add(fails, { cy: BOT + 40, opacity: 0, duration: 520, ease: "inQuad", delay: stagger(10) }, T + 480);
      // Survivors pass through the gaps and regroup.
      t.add(alive, {
        cx: (x: unknown) => dots[idx(x)].x[s + 1],
        cy: (x: unknown) => dots[idx(x)].y[s + 1],
        duration: 700, ease: "inOutQuad", delay: stagger(8),
      }, T + 300);
      t.add(counterObj, { v: COUNTS[s + 1], duration: 700, ease: "outCubic", onUpdate: paint }, T + 300);
      t.add(q(`[data-reason="${s}"]`), { opacity: [0, 1], translateY: [-4, 0], duration: 360 }, T + 700);
      t.add(q(`[data-wall="${s}"]`), { stroke: GREEN, duration: 300 }, T + 900);
      t.call(() => setStage(s + 1), T + 800);
    }
    const END = 900 + 5 * 1150;
    t.add(circles.filter((c) => Number(c.dataset.fail) === 5), { r: [5, 9], duration: 500, ease: "outBack(2)" }, END - 200);
    t.add(q("[data-final]"), { opacity: [0, 1], duration: 500, delay: stagger(100) }, END);
    tl.current = t;
    if (reduced) {
      t.seek(t.duration);
      paint();
      setStage(5);
      played.current = true;
    } else {
      // Hold the pool off-stage until the section is seen.
      t.seek(0);
      setStage(0);
    }
    return () => { t.revert(); tl.current = null; };
  }, [dots, reduced]);

  useScrollPresence(root, {
    onEnter: () => {
      if (played.current || !tl.current) return;
      played.current = true;
      tl.current.play();
    },
  }, [reduced]);

  const g = active === null ? null : GATES[active];
  const status = stage === 5 ? "2 published" : `${fmt(COUNTS[stage])} candidates`;
  const mono = "font-[family-name:var(--aq-mono)]";

  return (
    <div ref={root} className="min-w-0 rounded-3xl border border-[#E3E8EA] bg-[#FBFCFC]">
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 border-b border-[#E3E8EA] px-5 py-3 sm:px-6">
        <p className="text-[13px] text-[#5A6874]">
          <span aria-hidden className={`${mono} text-[1.3rem] font-medium tracking-[-0.02em] text-[#0C1A26]`}><span ref={counter}>1,240</span></span>{" "}
          <span aria-hidden>{stage === 5 ? "published" : "candidates"}</span>
          <span className="sr-only" aria-live="polite">{status}</span>
        </p>
        <p className={`${mono} text-[11px] uppercase tracking-[0.14em] text-[#8A97A1]`}>Illustrative numbers</p>
      </div>

      {/* Desktop and tablet: horizontal flow through five walls */}
      <div className="relative mx-auto hidden sm:block" style={{ maxWidth: "min(100%, calc((100svh - 22rem) * 2.9), 1280px)" }}>
        <svg viewBox={`0 0 ${VW} ${VH}`} className="block h-auto w-full" role="img"
          aria-label="Illustration: 1,240 candidate rules flow through five filter walls. Most are stopped along the way; two strategies, one long and one short, are published.">
          <text x="110" y={TOP - 30} textAnchor="middle" fontSize="12" fill={MUTED} className={mono}>CANDIDATES</text>
          {GATES.map((gate, s) => {
            const on = active === s;
            return (
              <g key={gate.name}>
                {on && <rect x={WX[s] - 62} y={TOP - 56} width="124" height={BOT - TOP + 100} rx="14" fill={GREEN} opacity="0.06" />}
                <text x={WX[s]} y={TOP - 34} textAnchor="middle" fontSize="12" fill="#8A97A1" className={mono}>{String(s + 1).padStart(2, "0")}</text>
                <text x={WX[s]} y={TOP - 16} textAnchor="middle" fontSize="14" fontWeight="600" fill={on ? GREEN : INK}>{gate.short}</text>
                <line data-wall={s} x1={WX[s]} x2={WX[s]} y1={TOP} y2={BOT} stroke="#C9D2D7" strokeWidth="5" strokeDasharray="18 9" strokeLinecap="round" />
                <g data-reason={s} opacity="0">
                  <text x={WX[s]} y={BOT + 26} textAnchor="middle" fontSize="12" fontWeight="600" fill={RED} className={mono}>✕ {fmt(COUNTS[s] - COUNTS[s + 1])}</text>
                  <text x={WX[s]} y={BOT + 43} textAnchor="middle" fontSize="11" fill={RED} opacity="0.85">{gate.reason}</text>
                </g>
              </g>
            );
          })}
          <line x1={LANDX - 40} x2={LANDX - 40} y1={TOP + 40} y2={BOT - 40} stroke="#E3E8EA" />
          <text data-final opacity="0" x={LANDX + 30} y={TOP - 16} textAnchor="middle" fontSize="14" fontWeight="600" fill={INK}>2 published</text>
          <g data-final opacity="0">
            <circle cx={LANDX} cy={MID - 34} r="17" fill="none" stroke={GREEN} strokeWidth="1.3" opacity="0.5" />
            <circle cx={LANDX} cy={MID + 34} r="17" fill="none" stroke={RED} strokeWidth="1.3" opacity="0.5" />
            <text x={LANDX + 28} y={MID - 30} fontSize="14" fontWeight="600" fill={GREEN}>Long rule</text>
            <text x={LANDX + 28} y={MID + 38} fontSize="14" fontWeight="600" fill={RED}>Short rule</text>
          </g>
          {dots.map((d, i) => (
            <circle key={`g${i}`} cx={d.x[0]} cy={d.y[0]} r="4" fill={d.long ? GREEN : RED} opacity="0.13" />
          ))}
          <text x="110" y={BOT + 26} textAnchor="middle" fontSize="12" fontWeight="600" fill={INK} className={mono}>{fmt(COUNTS[0])}</text>
          <text x="110" y={BOT + 43} textAnchor="middle" fontSize="11" fill={MUTED}>rules tested</text>
          {dots.map((d, i) => (
            <circle key={i} data-dot data-i={i} data-fail={d.failAt} cx={d.x[0] - 60} cy={d.y[0]} r="5" fill={d.long ? GREEN : RED} opacity="0" />
          ))}
        </svg>
        {/* The walls themselves are the focusable controls. */}
        {GATES.map((gate, s) => (
          <button
            key={gate.name}
            type="button"
            aria-describedby={active === s ? "gate-detail" : undefined}
            aria-label={`${gate.name}: ${gate.threshold}, ${gate.applies.toLowerCase()}`}
            onMouseEnter={() => setActive(s)}
            onMouseLeave={() => setActive(null)}
            onFocus={() => setActive(s)}
            onBlur={() => setActive(null)}
            className="absolute top-0 h-full rounded-2xl focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-[#1E6B62]"
            style={{ left: `${((WX[s] - 62) / VW) * 100}%`, width: `${(124 / VW) * 100}%` }}
          />
        ))}
      </div>

      {/* Phones: the walls become a vertical stack with their counts */}
      <ol className="grid grid-cols-1 divide-y divide-[#E3E8EA] sm:hidden">
        {GATES.map((gate, s) => (
          <li key={gate.name} className="grid grid-cols-[1.75rem_1fr] gap-x-2 px-5 py-3.5">
            <span className={`${mono} pt-0.5 text-[11px] text-[#1E6B62]`}>{String(s + 1).padStart(2, "0")}</span>
            <div className="min-w-0">
              <p className="text-[14.5px] font-semibold text-[#0C1A26]">{gate.name}</p>
              <p className="mt-0.5 text-[13px] text-[#5A6874]">{gate.threshold} · {gate.applies}</p>
              <p className={`${mono} mt-1 text-[12px] text-[#C74747]`}>✕ {fmt(COUNTS[s] - COUNTS[s + 1])} · {gate.reason} → {fmt(COUNTS[s + 1])} left</p>
            </div>
          </li>
        ))}
        <li className="px-5 py-3.5 text-[14px] font-semibold"><span className="text-[#1E6B62]">Long rule</span> and <span className="text-[#C74747]">short rule</span> published</li>
      </ol>

      <div id="gate-detail" aria-live="polite" className="hidden min-h-[3.5rem] items-center gap-x-5 border-t border-[#E3E8EA] px-6 py-3 text-[14px] sm:flex">
        {g ? (
          <>
            <span className={`${mono} shrink-0 text-[13px] text-[#1E6B62]`}>{g.threshold}</span>
            <span className="leading-snug text-[#3E4C58]">{g.body}</span>
          </>
        ) : null}
      </div>
    </div>
  );
}
