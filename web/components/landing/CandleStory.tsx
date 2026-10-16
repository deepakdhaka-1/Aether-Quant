"use client";

// One continuous, scroll-scrubbed schematic. Every stage is built from the previous stage's elements:
// a candle breaks apart -> reassembles and clones into a series -> computations grow from the series ->
// EMA lines draw over it -> rule fragments peel off into candidate logic -> most fail -> the survivor is
// published and signals on the same chart -> the last signal travels to an order on the user's account.
// Desktop: pinned stage, anime.js timeline synced to scroll (reversible).
// Mobile: the same stage frozen at each step, stacked with plain-text detail.

import { useEffect, useRef, useState } from "react";
import { createTimeline, onScroll } from "animejs";

const st = (k: number) => (_t: unknown, i?: number) => (i ?? 0) * k;

/* ---------------- data (deterministic, illustrative) ---------------- */

const LAST = { o: 182.4, h: 185.2, l: 181.6, c: 184.1, v: 2.4 };
const STOP = (LAST.c * 0.97).toFixed(2);

function rng(seed: number) {
  let s = seed;
  return () => ((s = (s * 16807) % 2147483647) / 2147483647) - 0.5;
}
type Bar = { o: number; h: number; l: number; c: number };
const BARS: Bar[] = (() => {
  const r = rng(19);
  const closes: number[] = [];
  const leg = (n: number, a: number, b: number, z = 0.5) => { for (let k = 1; k <= n; k++) closes.push(a + ((b - a) * k) / n + r() * z); };
  for (let t = 0; t < 30; t++) closes.push(173 - t * 0.08 + 0.3 * Math.sin(t / 3) + r() * 0.3);
  leg(11, closes[29], 188, 0.5); // rally
  leg(12, 188, 169, 0.5); // sell-off
  leg(2, 169, 169.6, 0.4); // base
  leg(5, 169.6, LAST.o, 0.4); // recovery
  closes[58] = LAST.o;
  const bars = closes.map((c, i) => {
    const o = i ? closes[i - 1] : c - 0.3;
    return { o, c, h: Math.max(o, c) + Math.abs(r()) * 1.2 + 0.1, l: Math.min(o, c) - Math.abs(r()) * 1.2 - 0.1 };
  });
  bars.push({ ...LAST });
  return bars;
})();
const ema = (n: number) => {
  const a = 2 / (n + 1);
  const out: number[] = [];
  BARS.forEach((b, i) => out.push(i ? a * b.c + (1 - a) * out[i - 1] : b.c));
  return out;
};
const VIS = 32;
const OFF = BARS.length - VIS;
const SER = BARS.slice(OFF);
// fast / medium / slow averages (5, 13, 34 hours)
const E9 = ema(5).slice(OFF), E20 = ema(13).slice(OFF), E50 = ema(34).slice(OFF);
const PLO = Math.min(...SER.map((b) => b.l)) - 0.6, PHI = Math.max(...SER.map((b) => b.h)) + 0.6;
const X = (i: number) => 140 + i * 23;
const Y = (v: number) => 450 - ((v - PLO) / (PHI - PLO)) * 320;
const LI = VIS - 1;
const CROSSES = SER.map((_, i) => i).filter((i) => i > 0 && Math.sign(E9[i] - E20[i]) !== Math.sign(E9[i - 1] - E20[i - 1]));
const UPX = [...CROSSES].reverse().find((i) => E9[i] > E20[i]) ?? LI;
const DNX = [...CROSSES].reverse().find((i) => E9[i] < E20[i]) ?? 0;
const SHOWX = CROSSES;
// trades: from each cross to the next; long after an up-cross, short after a down-cross
type Trade = { a: number; b: number; dir: "long" | "short"; pnl: number; open: boolean };
// entry on a fast/medium cross; exit when price closes back through the fast average
const TRADES: Trade[] = CROSSES.map((a) => {
  const dir = E9[a] > E20[a] ? "long" : "short";
  let b = a + 1;
  while (b < LI && !(dir === "long" ? SER[b].c < E9[b] : SER[b].c > E9[b])) b++;
  const pnl = ((SER[b].c - SER[a].c) / SER[a].c) * 100 * (dir === "long" ? 1 : -1);
  return { a, b, dir, pnl, open: b >= LI };
});
const HI14 = SER.slice(-14).reduce((m, b, k) => (b.h > SER[m].h ? VIS - 14 + k : m), VIS - 14);
const LO14 = SER.slice(-14).reduce((m, b, k) => (b.l < SER[m].l ? VIS - 14 + k : m), VIS - 14);
const AVG20 = SER.slice(-20).reduce((s, b) => s + b.c, 0) / 20;
const MOM = LAST.c - SER[LI - 9].c;
const linePath = (arr: number[]) => arr.map((v, i) => `${i ? "L" : "M"}${X(i)},${Y(v).toFixed(1)}`).join("");

// big candle: body 200 px tall for the last candle's open->close
const K = 200 / (LAST.c - LAST.o);
const BIG = { cx: 500, top: 200, bot: 400, hi: 200 - (LAST.h - LAST.c) * K, lo: 400 + (LAST.o - LAST.l) * K };
const SMALL_S = (Y(LAST.o) - Y(LAST.c)) / 200;
const TO_SLOT = { x: X(LI) - 500, y: (Y(LAST.o) + Y(LAST.c)) / 2 - 300 };

// chart shrinks to the left half for the logic stages: P' = (P * 0.5) + (0, 120)
const CS = 0.5, CY = 120;
const M = (x: number, y: number) => [x * CS, CY + y * CS] as const;

const RULE_LINES = ["Long when EMA 5 crosses above EMA 13", "and RSI < 70. Short when it crosses", "below and RSI > 30. Exit when price", "closes back through EMA 5. Stop 3%."];
const RULE = RULE_LINES.join(" ");

type Src = "cross" | "dcross" | "rsi" | "e50" | "e20" | "hi" | "lo";
const SRC: Record<Src, readonly [number, number]> = {
  cross: M(X(UPX), Y(E9[UPX])),
  dcross: M(X(DNX), Y(E9[DNX])),
  rsi: M(865, 583),
  e50: M(X(LI), Y(E50[LI])),
  e20: M(X(LI), Y(E20[LI])),
  hi: M(865, 57),
  lo: M(135, 583),
};
type Chip = { t: string; s: Src } | { op: "AND" | "OR" } | { dir: "long" | "short" };
const ROWS: Chip[][] = [
  [{ t: "EMA5 × EMA13 ↑", s: "cross" }, { op: "AND" }, { t: "RSI < 70", s: "rsi" }, { dir: "long" }],
  [{ t: "EMA5 × EMA13 ↓", s: "dcross" }, { op: "AND" }, { t: "RSI > 30", s: "rsi" }, { dir: "short" }],
  [{ t: "new 14h high", s: "hi" }, { op: "OR" }, { t: "RSI < 30", s: "rsi" }, { dir: "long" }],
  [{ t: "near 14h low", s: "lo" }, { op: "AND" }, { t: "RSI > 70", s: "rsi" }, { dir: "short" }],
  [{ t: "price > EMA20", s: "e20" }, { op: "OR" }, { t: "new 14h high", s: "hi" }, { dir: "long" }],
];
const KEEP = 2;
const ROW_X = 556, ROW_Y = (r: number) => 132 + r * 66, CHIP_H = 26;
const chipW = (c: Chip) => ("op" in c ? 34 : "dir" in c ? 66 : c.t.length * 6.4 + 16);
const ROW_LAYOUT = ROWS.map((row) => {
  let x = ROW_X;
  return row.map((c) => { const w = chipW(c); const at = x; x += w + 5; return { c, x: at, w }; });
});
function spark(seed: number, drift: number) {
  const r = rng(seed);
  const pts = [0];
  for (let i = 1; i < 24; i++) pts.push(pts[i - 1] + drift + r() * 1.6);
  const lo = Math.min(...pts), hi = Math.max(...pts);
  return pts.map((v, i) => `${i ? "L" : "M"}${(918 + i * 3).toFixed(1)},${(22 - ((v - lo) / (hi - lo || 1)) * 20).toFixed(1)}`).join("");
}

const PK = M((X(TRADES[TRADES.length - 1].a) + X(TRADES[TRADES.length - 1].b)) / 2, 509);
const fmt = (v: number) => `$${v.toFixed(2)}`;
const clamp = (x: number) => Math.min(1, Math.max(0, x));
const seg = (p: number, a: number, b: number) => clamp((p - a) / (b - a));

/* ---------------- copy ---------------- */

type Step = { k: string; name: string; title: string; body: string; at: number; detail: [string, string][] };
const STEPS: Step[] = [
  {
    k: "01", name: "Anatomy", at: 0.11,
    title: "This is one hour of NVIDIA's price.",
    body: "It is called a candle. Take it apart and it is just five numbers. Market data providers send us these five numbers for every market, every hour.",
    detail: [
      ["Open $182.40", "the price when the hour started"],
      ["High $185.20", "the highest price in the hour"],
      ["Low $181.60", "the lowest price in the hour"],
      ["Close $184.10", "the price when the hour ended"],
      ["Volume 2.4M", "how many shares changed hands"],
    ],
  },
  {
    k: "02", name: "Series", at: 0.245,
    title: "One candle becomes many.",
    body: "Put the hours side by side and you get a chart. Green candles rose, red candles fell. Prices fall too, and that matters, as you will see.",
    detail: [],
  },
  {
    k: "03", name: "Compute", at: 0.37,
    title: "We calculate around the chart.",
    body: "Small formulas look back over recent candles: the average price, the highest high, the lowest low, how fast price is moving. We compute about 140 of these, called indicators.",
    detail: [
      [`Average of 20 closes ${fmt(AVG20)}`, "where price usually sits"],
      [`Highest high, 14 hours ${fmt(SER[HI14].h)}`, "the recent ceiling"],
      [`Lowest low, 14 hours ${fmt(SER[LO14].l)}`, "the recent floor"],
      ["RSI 64", "momentum: buyers in control, not yet stretched"],
    ],
  },
  {
    k: "04", name: "Averages", at: 0.495,
    title: "Moving averages show the trend.",
    body: "An EMA is an average that cares more about recent prices. Fast (5 hours), medium (13) and slow (34) lines move at different speeds. When the fast line crosses the medium one, the trend may be turning, up or down.",
    detail: [
      [`EMA 5 ${fmt(E9[LI])}`, "fast: reacts within hours"],
      [`EMA 13 ${fmt(E20[LI])}`, "medium"],
      [`EMA 34 ${fmt(E50[LI])}`, "slow: the bigger trend"],
    ],
  },
  {
    k: "05", name: "Combine", at: 0.62,
    title: "A model combines the pieces into rules.",
    body: "Each finding becomes a small condition, like \"RSI under 70\". Our model joins them with AND and OR into candidate rules. Some go long (buy, profit if price rises). Some go short (sell first, profit if price falls).",
    detail: [],
  },
  {
    k: "06", name: "Validate", at: 0.745,
    title: "Every rule is tested. Most fail.",
    body: "A backtest replays a rule on years of past prices, with fees. Then it must also work on a later period it never saw. Only rules that pass every gate go further.",
    detail: [
      ["Sharpe ≥ 0.5", "return for the risk taken, on both periods"],
      ["Drawdown no worse than −35%", "the largest fall from a peak"],
      ["15 or more trades", "no conclusions from a handful"],
      ["Fees included", "on every simulated trade"],
    ],
  },
  {
    k: "07", name: "Publish", at: 0.87,
    title: "Prices fall too. That is an opportunity.",
    body: "Our strategies can sell first and buy back lower, so a falling market is an opportunity, not only a risk. Here it went long on the rally, short on the sell-off, and long again.",
    detail: [],
  },
  {
    k: "08", name: "Execute", at: 0.995,
    title: "A signal becomes an order on your own account.",
    body: "You approve a trade-only key from your wallet. It can place orders but can never withdraw. Every order goes out with a stop-loss that rests on Hyperliquid.",
    detail: [
      ["Your wallet", "MetaMask or OKX, holds your funds"],
      ["Trade-only key", "can trade, can never withdraw"],
      ["Order", `Long NVDA at $184.10, stop $${STOP}`],
      ["Earlier short", "sold first, bought back lower, in profit"],
      ["Hyperliquid", "the exchange where it executes"],
    ],
  },
];

/* ---------------- the stage: one SVG, 1000 x 640 ---------------- */

const INK = "#0C1A26", GREEN = "#1E6B62", RED = "#C74747", AMBER = "#A8791A", MUTE = "#5A6874", LINE = "#DDE5E7", DEEP = "#0C1A26", PANEL = "#FFFFFF";
const EMA_C = { 5: AMBER, 13: "#087C98", 34: "#7051A0" } as const;
const DIRC = { long: GREEN, short: RED } as const;

function Candle({ b, i }: { b: Bar; i: number }) {
  const up = b.c >= b.o;
  return (
    <>
      <line x1={X(i)} x2={X(i)} y1={Y(b.h)} y2={Y(b.l)} stroke={up ? GREEN : RED} strokeWidth="1.4" opacity="0.85" />
      <rect x={X(i) - 6} width="12" y={Y(Math.max(b.o, b.c))} height={Math.max(1.5, Math.abs(Y(b.o) - Y(b.c)))}
        fill={up ? GREEN : RED} stroke={up ? GREEN : RED} strokeWidth="1.4" />
    </>
  );
}

function Box({ q, a, x, y, title, val }: { q: (n: string) => string; a: string; x: number; y: number; title: string; val: string }) {
  return (
    <g data-a={q("box")} style={{ opacity: 0 }}>
      <rect x={x} y={y} width="230" height="74" rx="12" fill={PANEL} stroke={LINE} />
      <text x={x + 14} y={y + 26} fontSize="12.5" fill={MUTE} data-n={q(`${a}t`)}>{title}</text>
      <text x={x + 14} y={y + 54} fontSize="19" fill={INK} fontFamily="var(--aq-mono)" data-n={q(`${a}v`)}>{val}</text>
    </g>
  );
}

function Stage({ id }: { id: string }) {
  const q = (n: string) => `${id}-${n}`;
  const lbl: [string, string, string, number, number, "start" | "end"][] = [
    ["High", "hi", "Highest price in the hour", 470, 46, "end"],
    ["Close", "cl", "Price when the hour ended", 690, 196, "start"],
    ["Body", "bd", "From open to close. Green: it rose.", 690, 300, "start"],
    ["Open", "op", "Price when the hour started", 320, 396, "end"],
    ["Low", "lo", "Lowest price in the hour", 470, 520, "end"],
    ["Volume", "vo", "Shares traded in the hour", 545, 590, "start"],
  ];
  return (
    <svg width="1000" height="640" viewBox="0 0 1000 640" className="block overflow-visible" style={{ fontFamily: "var(--aq-sans)" }} aria-hidden>
      <defs>
        <filter id="aqglow" x="-50%" y="-50%" width="200%" height="200%">
          <feGaussianBlur stdDeviation="4" result="b" />
          <feMerge><feMergeNode in="b" /><feMergeNode in="SourceGraphic" /></feMerge>
        </filter>
        <filter id="aqglowsoft" x="-30%" y="-30%" width="160%" height="160%">
          <feGaussianBlur stdDeviation="2.2" result="b" />
          <feMerge><feMergeNode in="b" /><feMergeNode in="SourceGraphic" /></feMerge>
        </filter>
        <pattern id="aqdots" width="24" height="24" patternUnits="userSpaceOnUse">
          <circle cx="1" cy="1" r="1" fill="#DCE4E6" />
        </pattern>
      </defs>
      <rect className="aq-drift" x="-48" y="-48" width="1096" height="736" fill="url(#aqdots)" />
      {/* ---------- chart group: everything that later shrinks to the left half ---------- */}
      <g data-a={q("chart")} style={{ transformOrigin: "0px 0px" }}>
        {/* grid */}
        <g data-a={q("grid")} style={{ opacity: 0 }}>
          {[0, 1, 2, 3, 4].map((k) => {
            const v = PLO + ((PHI - PLO) * k) / 4;
            return (
              <g key={k}>
                <line x1="120" x2="880" y1={Y(v)} y2={Y(v)} stroke="#E5EAEC" />
                <text x="886" y={Y(v) + 4} fontSize="11" fill={MUTE} fontFamily="var(--aq-mono)">{v.toFixed(0)}</text>
              </g>
            );
          })}
          <text x="120" y="478" fontSize="11.5" fill={MUTE}>NVDA · one candle = one hour</text>
        </g>

        {/* clones */}
        {SER.slice(0, LI).map((b, i) => (
          <g key={i} data-a={q("clone")} style={{ opacity: 0 }}><Candle b={b} i={i} /></g>
        ))}

        {/* computations around the corners */}
        <path data-a={q("wire")} d={`M135,94 L135,104 L${X(LI - 19)},104 L${X(LI - 19)},112 M${X(LI - 19)},104 L${X(LI)},104 L${X(LI)},112`} pathLength={1} fill="none" stroke={GREEN} strokeWidth="1.1" strokeDasharray="1" strokeDashoffset="1" />
        <path data-a={q("wire")} d={`M865,94 L865,${Y(SER[HI14].h) - 18} L${X(HI14)},${Y(SER[HI14].h) - 18} L${X(HI14)},${Y(SER[HI14].h) - 4}`} pathLength={1} fill="none" stroke={GREEN} strokeWidth="1.1" strokeDasharray="1" strokeDashoffset="1" />
        <path data-a={q("wire")} d={`M135,546 L135,${Y(SER[LO14].l) + 22} L${X(LO14)},${Y(SER[LO14].l) + 22} L${X(LO14)},${Y(SER[LO14].l) + 4}`} pathLength={1} fill="none" stroke={GREEN} strokeWidth="1.1" strokeDasharray="1" strokeDashoffset="1" />
        <path data-a={q("wire")} d={`M${X(LI - 9)},${Y(SER[LI - 9].c)} Q${(X(LI - 9) + X(LI)) / 2},${Y(SER[LI - 9].c) + 70} ${X(LI)},${Y(LAST.c) + 40} L865,520 L865,546`} pathLength={1} fill="none" stroke={GREEN} strokeWidth="1.1" strokeDasharray="1" strokeDashoffset="1" />
        <Box q={q} a="tl" x={20} y={20} title="Average of last 20 closes" val={fmt(AVG20)} />
        <Box q={q} a="tr" x={750} y={20} title="Highest high, last 14 hours" val={fmt(SER[HI14].h)} />
        <Box q={q} a="bl" x={20} y={546} title="Lowest low, last 14 hours" val={fmt(SER[LO14].l)} />
        <Box q={q} a="br" x={750} y={546} title="Change over 9 hours → RSI" val={`+${fmt(MOM)} · RSI 64`} />

        {/* EMA lines */}
        {([[5, E9], [13, E20], [34, E50]] as const).map(([n, arr]) => (
          <path key={n} data-a={q("ema")} d={linePath(arr)} pathLength={1} fill="none" stroke={EMA_C[n]} strokeWidth="2.4" strokeDasharray="1" strokeDashoffset="1" strokeLinejoin="round" filter="url(#aqglow)" />
        ))}
        <g data-a={q("amb")} style={{ opacity: 0 }}>
          {([[5, E9], [13, E20], [34, E50]] as const).map(([n, arr]) => (
            <path key={n} className="aq-flow" d={linePath(arr)} fill="none" stroke={INK} strokeOpacity="0.35" strokeWidth="1.4" strokeDasharray="2 26" />
          ))}
        </g>
        <g data-a={q("cursor")} style={{ opacity: 0 }}>
          <line x1={X(0)} x2={X(0)} y1="118" y2="460" stroke={INK} strokeWidth="1" strokeDasharray="3 3" />
        </g>
        {SHOWX.map((i) => (
          <g key={i} data-n={q(`x${i}`)} style={{ opacity: 0 }}>
            <circle cx={X(i)} cy={Y(E9[i])} r="9" fill="none" stroke={E9[i] > E20[i] ? GREEN : RED} strokeWidth="2" />
            <text x={X(i)} y={Y(E9[i]) - 15} fontSize="11.5" textAnchor="middle" fill={E9[i] > E20[i] ? GREEN : RED} fontWeight="600">
              {E9[i] > E20[i] ? "cross up" : "cross down"}
            </text>
          </g>
        ))}

        {/* trades on the chart: long (teal) and short (coral), both profitable */}
        {TRADES.map((t, k) => (
          <g key={k} data-a={q("sg")} style={{ opacity: 0 }}>
            <rect x={X(t.a)} y="118" width={Math.max(8, X(t.b) - X(t.a))} height="342" fill={DIRC[t.dir]} opacity="0.1" />
            <line x1={X(t.a)} x2={X(t.b)} y1="488" y2="488" stroke={DIRC[t.dir]} strokeWidth="3" strokeLinecap="round" filter="url(#aqglowsoft)" />
            <text x={(X(t.a) + X(t.b)) / 2} y="514" fontSize="16" fontWeight="700" textAnchor="middle" fill={DIRC[t.dir]}>
              {t.dir.toUpperCase()} {t.open ? "open" : `${t.pnl >= 0 ? "+" : ""}${t.pnl.toFixed(1)}%`}
            </text>
          </g>
        ))}

        {/* the hero candle; ends as the newest candle of the series */}
        <g data-a={q("big")} style={{ transformOrigin: "500px 300px" }}>
          <g data-a={q("hw")}><line x1="500" x2="500" y1={BIG.hi} y2={BIG.top} stroke={INK} strokeWidth="3" strokeLinecap="round" /></g>
          <g data-a={q("lw")}><line x1="500" x2="500" y1={BIG.bot} y2={BIG.lo} stroke={INK} strokeWidth="3" strokeLinecap="round" /></g>
          <rect x="465" y={BIG.top} width="70" height="200" rx="3" fill={GREEN} filter="url(#aqglow)" />
          <g data-a={q("ot")}><line x1="422" x2="465" y1={BIG.bot} y2={BIG.bot} stroke={INK} strokeWidth="3" strokeLinecap="round" /></g>
          <g data-a={q("ct")}><line x1="535" x2="578" y1={BIG.top} y2={BIG.top} stroke={INK} strokeWidth="3" strokeLinecap="round" /></g>
          <g data-a={q("vol")} style={{ opacity: 0 }}><rect x="472" y="552" width="56" height="44" rx="2" fill="#7FAEAA" /></g>
        </g>
      </g>

      {/* ---------- anatomy labels ---------- */}
      {lbl.map(([name, key, def, x, y, anchor]) => (
        <g key={key} data-a={q("lbl")} style={{ opacity: 0 }}>
          <text x={x} y={y} textAnchor={anchor} fontSize="15" fontWeight="600" fill={INK}>
            {name} <tspan data-n={q(key)} fontFamily="var(--aq-mono)" fontWeight="500" fill={GREEN} />
          </text>
          <text x={x} y={y + 19} textAnchor={anchor} fontSize="12.5" fill={MUTE}>{def}</text>
        </g>
      ))}

      {/* ---------- published card (behind the survivor row once it moves) ---------- */}
      <g data-a={q("card")} style={{ opacity: 0, transformOrigin: "760px 230px", transformBox: "view-box" }}>
        <rect x="540" y="96" width="445" height="300" rx="20" fill={PANEL} stroke={LINE} filter="url(#aqglowsoft)" />
        <circle className="aq-pulse" cx="566" cy="124" r="3.5" fill={AMBER} />
        <text x="578" y="128" fontSize="11.5" fill={MUTE} letterSpacing="1">PUBLISHED · NVDA · 1H CANDLES</text>
        {RULE_LINES.map((l, i) => (
          <text key={i} x="562" y={160 + i * 26} fontSize="19" fill={INK} fontFamily="var(--aq-serif)">{l}</text>
        ))}
        <text x="562" y="373" fontSize="11.5" fill={MUTE} letterSpacing="1">TRADES</text>
        {TRADES.map((t, k) => (
          <g key={k} data-a={q("sgc")} style={{ opacity: 0 }}>
            <rect x={626 + k * 118} y="356" width="110" height="24" rx="12" fill={DIRC[t.dir]} />
            <text x={681 + k * 118} y="372" fontSize="11.5" textAnchor="middle" fontWeight="700" fill={DEEP}>
              {t.dir.toUpperCase()} {t.open ? "open" : `+${t.pnl.toFixed(1)}%`}
            </text>
          </g>
        ))}
      </g>

      {/* ---------- logic: model node, branches, candidate rows ---------- */}
      <g data-a={q("root")} style={{ opacity: 0 }}>
        <circle className="aq-pulse" cx="516" cy="290" r="15" fill={GREEN} filter="url(#aqglow)" />
        <text x="516" y="294" fontSize="10.5" textAnchor="middle" fill={DEEP} fontWeight="700">AI</text>
        <text x="516" y="324" fontSize="10.5" textAnchor="middle" fill={MUTE}>model</text>
      </g>
      {ROWS.map((_, r) => (
        <path key={r} data-a={q(r >= KEEP ? "brx" : "br0")} d={`M531,290 C545,290 538,${ROW_Y(r) + 13} ${ROW_X - 4},${ROW_Y(r) + 13}`} pathLength={1}
          fill="none" stroke={INK} strokeWidth="1.1" strokeDasharray="1" strokeDashoffset="1" />
      ))}
      {ROW_LAYOUT.map((row, r) => (
        <g key={r} data-a={q(r >= KEEP ? "row" : `keep${r}`)}>
          {row.map(({ c, x, w }, k) => {
            const y = ROW_Y(r);
            if ("op" in c) {
              return (
                <g key={k} data-a={q("op")} style={{ opacity: 0 }}>
                  <rect x={x} y={y + 3} width={w} height={CHIP_H - 6} rx="4" fill={c.op === "AND" ? INK : PANEL} stroke={INK} />
                  <text x={x + w / 2} y={y + 17} fontSize="10" textAnchor="middle" fontWeight="700" fill={c.op === "AND" ? DEEP : INK}>{c.op}</text>
                </g>
              );
            }
            if ("dir" in c) {
              return (
                <g key={k} data-a={q("op")} style={{ opacity: 0 }}>
                  <text x={x + 2} y={y + 17} fontSize="12" fill={MUTE}>→</text>
                  <rect x={x + 16} y={y + 2} width={w - 16} height={CHIP_H - 4} rx="11" fill={DIRC[c.dir]} filter="url(#aqglowsoft)" />
                  <text x={x + 16 + (w - 16) / 2} y={y + 17} fontSize="10.5" textAnchor="middle" fontWeight="800" fill={DEEP}>{c.dir.toUpperCase()}</text>
                </g>
              );
            }
            const [sx, sy] = SRC[c.s];
            return (
              <g key={k} data-a={q("chip")} data-dx={sx - (x + w / 2)} data-dy={sy - (y + CHIP_H / 2)} style={{ opacity: 0 }}>
                <rect x={x} y={y} width={w} height={CHIP_H} rx="13" fill="rgba(168,121,26,.10)" stroke={AMBER} filter="url(#aqglowsoft)" />
                <text x={x + w / 2} y={y + 17} fontSize="11" textAnchor="middle" fill="#79550F" fontFamily="var(--aq-mono)">{c.t}</text>
              </g>
            );
          })}
          <g transform={`translate(0 ${ROW_Y(r) + 2})`}>
            <path data-a={q(r >= KEEP ? "spx" : "sp0")} d={spark(200 + r, r >= KEEP ? (r % 2 ? -0.35 : 0.02) : 0.5)} pathLength={1} fill="none"
              stroke={r >= KEEP ? "#A8B4B8" : DIRC[r ? "short" : "long"]} strokeWidth="1.6" strokeDasharray="1" strokeDashoffset="1" />
            {r >= KEEP && (
              <g data-a={q("fail")} style={{ opacity: 0 }}>
                <rect x="931" y="-2" width="48" height="18" rx="9" fill="rgba(199,71,71,.10)" />
                <text x="955" y="11" fontSize="10.5" textAnchor="middle" fill="#A93232" fontWeight="700">failed</text>
              </g>
            )}
          </g>
        </g>
      ))}
      {[0, 1].map((r) => (
        <g key={r} data-a={q("pass")} style={{ opacity: 0 }}>
          <rect x="931" y={ROW_Y(r) - 18} width="50" height="18" rx="9" fill={AMBER} />
          <text x="956" y={ROW_Y(r) - 5} fontSize="10.5" textAnchor="middle" fill={DEEP} fontWeight="700">passed</text>
        </g>
      ))}

      {/* ---------- gates ---------- */}
      <text data-a={q("tally")} x={ROW_X} y="262" fontSize="13" fill={MUTE} style={{ opacity: 0 }}>
        5 tested · 2 passed every gate: one long rule, one short rule
      </text>
      {(
        [["Sharpe on history", "1.12  (≥ 0.5)"], ["Sharpe on unseen period", "0.81  (≥ 0.5)"], ["Worst drawdown", "−14.2%  (limit −35%)"], ["Trades, long and short", "41  (15+)"], ["Fees included", "yes"]] as const
      ).map(([k, v], i) => (
        <g key={k} data-a={q("chk")} style={{ opacity: 0 }}>
          <circle cx={ROW_X + 7} cy={292 + i * 30} r="7" fill={GREEN} />
          <path d={`M${ROW_X + 3.5},${292 + i * 30} l2.5,2.5 l4.5,-5`} fill="none" stroke={DEEP} strokeWidth="1.6" />
          <text x={ROW_X + 22} y={296 + i * 30} fontSize="13.5" fill={INK}>{k}</text>
          <text x="980" y={296 + i * 30} fontSize="12.5" textAnchor="end" fill={GREEN} fontFamily="var(--aq-mono)">{v}</text>
        </g>
      ))}

      {/* ---------- execution ---------- */}
      <path data-a={q("flow")} d="M200,540 L230,540 M410,540 L450,540 M700,540 L740,540" pathLength={1} fill="none" stroke={INK} strokeWidth="1.4" strokeDasharray="1" strokeDashoffset="1" />
      {(
        [
          ["Your wallet", "MetaMask or OKX.", "Your funds stay here.", 20, 475, 180, 130],
          ["Trade-only key", "Approved by you. Can", "trade, never withdraw.", 230, 475, 180, 130],
          ["Order", "", "", 450, 462, 250, 156],
          ["Hyperliquid", "Where the order", "executes.", 740, 475, 240, 130],
        ] as const
      ).map(([t, d1, d2, x, y, w, h], i) => (
        <g key={t} data-a={q("node")} style={{ opacity: 0 }}>
          <rect x={x} y={y} width={w} height={h} rx="16" fill="none" stroke="#9BAAB0" strokeWidth="1.5" strokeDasharray="5 4" />
          <rect data-a={q("fill")} style={{ opacity: 0 }} x={x} y={y} width={w} height={h} rx="16"
            fill={i === 2 ? GREEN : PANEL} stroke={i === 2 ? GREEN : LINE} filter={i === 2 ? "url(#aqglow)" : undefined} />
          {i === 3 && <image href="/brand/Hyperliquid_Blob_Light.svg" x={x + 16} y={y + 16} width="22" height="22" />}
          {i === 2 ? (
            <>
              {(["dk", "lt"] as const).map((tone) => (
                <g key={tone} data-a={q(tone)} style={{ opacity: tone === "dk" ? 1 : 0 }} fill={tone === "dk" ? INK : DEEP}>
                  <text x={x + 18} y={y + 30} fontSize="15" fontWeight="600">Order</text>
                  <text x={x + 18} y={y + 58} fontSize="13" fontFamily="var(--aq-mono)">Long NVDA at $184.10</text>
                  <text x={x + 18} y={y + 82} fontSize="13" fontFamily="var(--aq-mono)">Stop-loss ${STOP}</text>
                  <text x={x + 18} y={y + 112} fontSize="11.5" opacity="0.75">The stop rests on the exchange,</text>
                  <text x={x + 18} y={y + 128} fontSize="11.5" opacity="0.75">even if we go offline.</text>
                </g>
              ))}
            </>
          ) : (
            <>
              <text x={x + 16} y={y + (i === 3 ? 60 : 32)} fontSize="15" fontWeight="600" fill={INK}>{t}</text>
              <text x={x + 16} y={y + (i === 3 ? 82 : 56)} fontSize="12.5" fill={MUTE}>{d1}</text>
              <text x={x + 16} y={y + (i === 3 ? 99 : 73)} fontSize="12.5" fill={MUTE}>{d2}</text>
            </>
          )}
        </g>
      ))}
      <g data-a={q("packet")} style={{ opacity: 0 }} filter="url(#aqglow)">
        <circle cx={PK[0]} cy={PK[1]} r="7" fill={GREEN} />
        <circle cx={PK[0]} cy={PK[1]} r="13" fill={GREEN} opacity="0.18" />
      </g>
    </svg>
  );
}

/* ---------------- timeline: 1000 ms = whole story, 8 stages of 125 ---------------- */

function build(root: Element, id: string, autoplay: boolean | ReturnType<typeof onScroll>) {
  const $ = (n: string) => Array.from(root.querySelectorAll<SVGElement>(`[data-a="${id}-${n}"]`));
  const n = (k: string) => root.querySelector<SVGElement>(`[data-n="${id}-${k}"]`);
  const T = (k: string, v: string) => { const el = n(k); if (el && el.textContent !== v) el.textContent = v; };
  const crossEls = SHOWX.map((i) => [i, n(`x${i}`)] as const);
  const cursor = $("cursor")[0];

  const paint = (p: number) => {
    const e = seg(p, 0.04, 0.09);
    const L = (a: number, b: number) => a + (b - a) * e;
    T("op", fmt(LAST.o)); T("hi", fmt(L(LAST.o, LAST.h))); T("lo", fmt(L(LAST.o, LAST.l)));
    T("cl", fmt(L(LAST.o, LAST.c))); T("vo", `${L(0, LAST.v).toFixed(1)}M`); T("bd", `+${fmt(L(0, LAST.c - LAST.o))}`);

    // computations count in, then the top-left box becomes the live EMA readout
    const c = seg(p, 0.27, 0.34);
    const cur = Math.round(seg(p, 0.385, 0.49) * LI);
    if (p < 0.375) {
      T("tlt", "Average of last 20 closes"); T("tlv", fmt(AVG20 * (0.9 + 0.1 * c)));
    } else {
      T("tlt", `EMAs at ${String(9 + (cur % 15)).padStart(2, "0")}:00 · 5 / 13 / 34`);
      T("tlv", `${E9[cur].toFixed(1)} ${E20[cur].toFixed(1)} ${E50[cur].toFixed(1)}`);
    }
    T("trv", fmt(SER[HI14].h * (0.9 + 0.1 * c)));
    T("blv", fmt(SER[LO14].l * (0.9 + 0.1 * c)));
    T("brv", `+${fmt(MOM * c)} · RSI ${Math.round(64 * c)}`);
    if (cursor) cursor.style.transform = `translateX(${X(cur) - X(0)}px)`;
    crossEls.forEach(([i, el]) => { if (el) el.style.opacity = p > 0.38 && cur >= i ? "1" : "0"; });
  };

  const tl = createTimeline({ autoplay, defaults: { ease: "outQuart" }, onUpdate: (self) => paint(self.progress) });
  tl.add({ v: 0 }, { v: 1, duration: 1000 }, 0);

  // 01 Anatomy: push in, then explode along the axis
  tl.add($("big"), { scale: [1, 1.06], duration: 40 }, 0)
    .add($("hw"), { translateY: [0, -45], duration: 45 }, 35)
    .add($("lw"), { translateY: [0, 45], duration: 45 }, 35)
    .add($("ot"), { translateX: [0, -90], duration: 45 }, 40)
    .add($("ct"), { translateX: [0, 90], duration: 45 }, 40)
    .add($("vol"), { opacity: [0, 1], translateY: [-150, 0], duration: 45 }, 45)
    .add($("lbl"), { opacity: [0, 1], duration: 20, delay: st(5) }, 70);
  // 02 Series: reassemble, shrink into the newest slot, clones slide out to the left
  tl.add($("lbl"), { opacity: [1, 0], duration: 15 }, 125)
    .add($("hw"), { translateY: [-45, 0], duration: 30 }, 132)
    .add($("lw"), { translateY: [45, 0], duration: 30 }, 132)
    .add($("ot"), { translateX: [-90, 0], duration: 30 }, 132)
    .add($("ct"), { translateX: [90, 0], duration: 30 }, 132)
    .add($("vol"), { opacity: [1, 0], translateY: [0, -150], duration: 25 }, 132)
    .add($("big"), { scale: [1.06, SMALL_S], translateX: [0, TO_SLOT.x], translateY: [0, TO_SLOT.y], duration: 35, ease: "inOutQuad" }, 162)
    .add($("clone"), {
      ease: "outExpo",
      opacity: [0, 1],
      translateX: (_el: unknown, i?: number) => [X(LI) - X(i ?? 0), 0],
      duration: 40, delay: (_el: unknown, i?: number) => (LI - 1 - (i ?? 0)) * 1.6,
    }, 192)
    .add($("grid"), { opacity: [0, 1], duration: 25 }, 215);
  // 03 Compute: wires grow out of the series into corner calculations
  tl.add($("wire"), { strokeDashoffset: [1, 0], duration: 40, delay: st(8) }, 252)
    .add($("box"), { opacity: [0, 1], translateY: [6, 0], duration: 20, delay: st(8) }, 275);
  // 04 Averages: EMA lines draw from left to right behind a scrubbing cursor
  tl.add($("cursor"), { opacity: [0, 1], duration: 8 }, 380)
    .add($("ema"), { strokeDashoffset: [1, 0], duration: 105, ease: "linear" }, 385)
    .add($("amb"), { opacity: [0, 1], duration: 12 }, 488)
    .add($("wire"), { opacity: [1, 0.35], duration: 20 }, 385);
  // 05 Combine: chart shrinks left; fragments peel off into candidate logic
  tl.add([...$("cursor"), ...$("wire")], { opacity: [1, 0], duration: 12 }, 500)
    .add($("chart"), { scale: [1, CS], translateY: [0, CY], duration: 30, ease: "inOutQuad" }, 508)
    .add($("root"), { opacity: [0, 1], duration: 12 }, 540)
    .add([...$("br0"), ...$("brx")], { strokeDashoffset: [1, 0], duration: 25, delay: st(4) }, 548)
    .add($("chip"), {
      opacity: [0, 1],
      translateX: (el: unknown) => [Number((el as Element).getAttribute("data-dx")), 0],
      translateY: (el: unknown) => [Number((el as Element).getAttribute("data-dy")), 0],
      duration: 30, delay: st(3), ease: "outExpo",
    }, 555)
    .add($("op"), { opacity: [0, 1], duration: 10, delay: st(3) }, 590);
  // 06 Validate: every candidate is backtested; most fail and fall away
  tl.add([...$("sp0"), ...$("spx")], { strokeDashoffset: [1, 0], duration: 35, delay: st(3) }, 628)
    .add($("fail"), { opacity: [0, 1], duration: 8, delay: st(3) }, 668)
    .add($("pass"), { opacity: [0, 1], duration: 8, delay: st(4) }, 680)
    .add($("row"), { opacity: [1, 0], translateY: [0, 30], duration: 20, delay: st(3) }, 688)
    .add($("brx"), { opacity: [1, 0], duration: 15 }, 688)
    .add($("tally"), { opacity: [0, 1], duration: 10 }, 705)
    .add($("chk"), { opacity: [0, 1], translateX: [-6, 0], duration: 10, delay: st(5) }, 712);
  // 07 Publish: survivor drops into the published card; signals appear on the same chart
  tl.add([...$("chk"), ...$("tally"), ...$("pass"), ...$("sp0"), ...$("root"), ...$("br0")], { opacity: [1, 0], duration: 12 }, 750)
    .add($("card"), { opacity: [0, 1], scale: [0.92, 1], duration: 22 }, 760)
    .add($("keep0"), { translateX: [0, 6], translateY: [0, 130], duration: 25, ease: "inOutQuart" }, 765)
    .add($("keep1"), { translateX: [0, 6], translateY: [0, 98], duration: 25, ease: "inOutQuart" }, 770)
    .add($("sg"), { opacity: [0, 1], duration: 14, delay: st(14) }, 795)
    .add($("sgc"), { opacity: [0, 1], translateY: [8, 0], duration: 12, delay: st(14) }, 800);
  // 08 Execute: the newest signal travels wallet -> key -> order -> Hyperliquid; outline becomes lit
  const [px, py] = PK;
  tl.add($("node"), { opacity: [0, 1], translateY: [14, 0], duration: 20, delay: st(5) }, 878)
    .add($("flow"), { strokeDashoffset: [1, 0], duration: 30 }, 900)
    .add($("packet"), {
      translateX: [0, 110 - px], translateY: [0, 540 - py], duration: 15,
    }, 905)
    .add($("packet"), { opacity: [0, 1], duration: 4 }, 905)
    .add($("packet"), { translateX: [110 - px, 860 - px], duration: 40 }, 920)
    .add($("packet"), { opacity: [1, 0], duration: 6 }, 958)
    .add($("fill"), { opacity: [0, 1], duration: 20, delay: st(6) }, 945)
    .add($("dk"), { opacity: [1, 0], duration: 15 }, 960)
    .add($("lt"), { opacity: [0, 1], duration: 15 }, 960);

  paint(0);
  return tl;
}

/* ---------------- scaling wrapper ---------------- */

function Scaled({ id, fitHeight, rootRef }: { id: string; fitHeight: boolean; rootRef: React.RefObject<HTMLDivElement | null> }) {
  const box = useRef<HTMLDivElement>(null);
  const [s, setS] = useState(0.5);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => {
      const { width, height } = e.contentRect;
      setS(fitHeight ? Math.min(width / 1000, height / 640) : width / 1000);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [fitHeight]);
  return (
    <div ref={box} className={fitHeight ? "relative h-full w-full" : "relative w-full"} style={fitHeight ? undefined : { aspectRatio: "1000 / 640" }}>
      <div ref={rootRef} className="absolute left-1/2 top-1/2 h-[640px] w-[1000px]" style={{ transform: `translate(-50%,-50%) scale(${s})` }}>
        <Stage id={id} />
      </div>
    </div>
  );
}

/* ---------------- pinned, scroll-synced ---------------- */

function Pinned() {
  const section = useRef<HTMLElement>(null);
  const root = useRef<HTMLDivElement | null>(null);
  const [p, setP] = useState(0);

  useEffect(() => {
    if (!section.current || !root.current) return;
    const debug = process.env.NODE_ENV === "development" ? new URLSearchParams(location.search).get("progress") : null;
    const tl = build(
      root.current,
      "pin",
      debug !== null ? false : onScroll({ target: section.current, enter: "top top", leave: "bottom bottom", sync: 0.22 }),
    );
    const prev = tl.onUpdate;
    tl.onUpdate = (self) => { prev?.(self); setP(self.progress); };
    if (debug !== null) {
      tl.seek(clamp(parseFloat(debug)) * 1000);
      window.scrollTo(0, section.current.getBoundingClientRect().top + window.scrollY);
    }
    return () => { tl.revert(); };
  }, []);

  const n = STEPS.length;
  const active = Math.min(n - 1, Math.floor(p * n));
  const cur = STEPS[active];
  return (
    <section ref={section} aria-label="How a strategy is made, step by step" className="relative bg-[#F5F7F7]" style={{ height: `${n * 72 + 100}vh` }}>
      <div className="sticky top-0 h-screen overflow-hidden">
        {/* minimal rail */}
        <ol className="absolute inset-x-0 top-16 z-10 flex gap-1 px-4 pt-3 sm:px-8" aria-label="Stages">
          {STEPS.map((s, i) => (
            <li key={s.k} className="flex-1" aria-current={i === active ? "step" : undefined}>
              <span className="block h-[2px] overflow-hidden rounded-full bg-[#DDE5E7]">
                <span className="block h-full bg-[#1E6B62]" style={{ width: `${clamp(p * n - i) * 100}%` }} />
              </span>
              <span className={`mt-1.5 block font-[family-name:var(--aq-mono)] text-[11px] tracking-wide transition-colors duration-300 ${i === active ? "text-[#0C1A26]" : "text-[#8A98A1]"}`}>
                {s.k} {s.name}
              </span>
            </li>
          ))}
        </ol>
        {/* stage */}
        <div className="absolute inset-x-0 bottom-[150px] top-[118px] px-4 sm:px-8">
          <Scaled id="pin" fitHeight rootRef={root} />
        </div>
        {/* in-stage caption */}
        <div className="absolute inset-x-0 bottom-0 z-10 h-[150px] px-4 sm:px-8">
          <div className="relative mx-auto h-full max-w-[880px] text-center">
            {STEPS.map((s, i) => (
              <div key={s.k} aria-hidden={i !== active} className="absolute inset-x-0 top-3 transition-all duration-300 ease-out"
                style={{ opacity: i === active ? 1 : 0, transform: `translateY(${(i - active) * 10}px)` }}>
                <p className="text-[clamp(1.2rem,1.9vw,1.6rem)] font-semibold leading-tight tracking-[-0.025em] text-[#0C1A26]">{s.title}</p>
                <p className="mx-auto mt-2 max-w-[720px] text-[14.5px] leading-relaxed text-[#5A6874]">{s.body}</p>
              </div>
            ))}
          </div>
        </div>
        <p className="sr-only" aria-live="polite">{cur.title}</p>
      </div>
    </section>
  );
}

/* ---------------- static, stepped (mobile and reduced motion) ---------------- */

function StaticStep({ i }: { i: number }) {
  const root = useRef<HTMLDivElement | null>(null);
  const s = STEPS[i];
  useEffect(() => {
    if (!root.current) return;
    const tl = build(root.current, `st${i}`, false);
    tl.seek(s.at * 1000);
    return () => { tl.revert(); };
  }, [i, s.at]);
  return (
    <li className="grid grid-cols-1 gap-6 border-t border-[#DDE3E6] py-10 md:grid-cols-[1fr_1.3fr] md:items-center">
      <div className="min-w-0">
        <p className="font-[family-name:var(--aq-mono)] text-[12.5px] text-[#1E6B62]">{s.k} / 0{STEPS.length} · {s.name}</p>
        <h3 className="mt-3 text-[1.5rem] font-semibold leading-tight tracking-[-0.025em]">{s.title}</h3>
        <p className="mt-3 text-[16px] leading-relaxed text-[#3E4C58]">{s.body}</p>
        {i === 6 && <p className="mt-4 rounded-2xl bg-[#E3EEEC] p-5 font-[family-name:var(--aq-serif)] text-[1.15rem] leading-snug text-[#0C1A26]">{RULE}</p>}
        {s.detail.length > 0 && (
          <dl className="mt-5 divide-y divide-[#E3E8EA] text-[15px]">
            {s.detail.map(([k, v]) => (
              <div key={k} className="grid grid-cols-1 gap-0.5 py-2.5 sm:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)] sm:gap-4">
                <dt className="font-medium">{k}</dt>
                <dd className="text-[#5A6874]">{v}</dd>
              </div>
            ))}
          </dl>
        )}
      </div>
      <div className="min-w-0 overflow-hidden rounded-3xl border border-[#E3E8EA] bg-[#F5F7F7] p-2" aria-hidden>
        <Scaled id={`st${i}`} fitHeight={false} rootRef={root} />
      </div>
    </li>
  );
}

const AMBIENT_CSS = `
@keyframes aq-flow { to { stroke-dashoffset: -28; } }
@keyframes aq-drift { to { transform: translate(24px, 24px); } }
@keyframes aq-pulse { 0%,100% { opacity: 1; } 50% { opacity: .55; } }
.aq-flow { animation: aq-flow 1.6s linear infinite; }
.aq-drift { animation: aq-drift 14s linear infinite; }
.aq-pulse { animation: aq-pulse 2.4s ease-in-out infinite; }
@media (prefers-reduced-motion: reduce) { .aq-flow, .aq-drift, .aq-pulse { animation: none; } }
`;

export default function CandleStory() {
  const [mode, setMode] = useState<"pinned" | "static" | null>(null);
  useEffect(() => {
    // Keep the scroll-scrubbed transformation on desktop even when the OS asks
    // to reduce ambient motion. Nothing autoplays; the user drives every stage
    // with the page scroll. Small screens use the stepped static presentation.
    const mq = window.matchMedia("(min-width: 900px) and (min-height: 600px)");
    const update = () => setMode(mq.matches ? "pinned" : "static");
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, []);
  if (!mode) return <div className="min-h-[100vh]" />;
  if (mode === "pinned") return <><style>{AMBIENT_CSS}</style><Pinned /></>;
  return (
    <ol className="mx-auto max-w-[1240px] px-4 sm:px-8">
      {STEPS.map((s, i) => <StaticStep key={s.k} i={i} />)}
    </ol>
  );
}
