"use client";

// One continuous, scroll-scrubbed schematic. Every stage is built from the previous stage's elements:
// a candle breaks apart -> blasts and re-forms into a series -> the series is read into a data table ->
// formulas append indicator rows -> the table flows into the indicator database -> the research engine
// pulls columns out as rule chips -> most rules fail -> the survivor is published and signals on the
// same chart -> the last signal travels to an order on the user's account.
// Desktop: pinned stage, anime.js timeline synced to scroll (reversible).
// Mobile: the same stage frozen at each step, stacked with plain-text detail.

import { useEffect, useRef, useState } from "react";
import { createTimeline, onScroll } from "animejs";

const st = (k: number) => (_t: unknown, i?: number) => (i ?? 0) * k;

/* ---------------- data (deterministic, illustrative) ---------------- */

const LAST = { o: 182.4, h: 185.2, l: 181.6, c: 184.1, v: 2.4 };

function rng(seed: number) {
  let s = seed;
  return () => ((s = (s * 16807) % 2147483647) / 2147483647) - 0.5;
}
type Bar = { o: number; h: number; l: number; c: number };
const BARS: Bar[] = (() => {
  const r = rng(19);
  // Seeded hourly walk with changing drift and volatility. A small endpoint
  // correction joins the walk cleanly to the featured final candle.
  const closes: number[] = [];
  let price = 174, momentum = 0;
  for (let i = 0; i < 60; i++) {
    const drift = i < 24 ? 0.10 : i < 34 ? 0.34 : i < 45 ? -0.42 : i < 51 ? -0.08 : 0.22;
    const volatility = i >= 34 && i < 48 ? 1.05 : 0.72;
    const shock = (r() + r() + r() + r()) * volatility;
    momentum = momentum * 0.28 + shock;
    price += drift + momentum;
    closes.push(price);
  }
  const correction = LAST.o - closes[closes.length - 1];
  closes.forEach((_, i) => { closes[i] += correction * (i / (closes.length - 1)); });
  const bars = closes.map((c, i) => {
    const o = i ? closes[i - 1] + r() * 0.28 : c - 0.3;
    return { o, c, h: Math.max(o, c) + Math.abs(r()) * 1.15 + 0.12, l: Math.min(o, c) - Math.abs(r()) * 1.15 - 0.12 };
  });
  bars.push({ ...LAST });
  return bars;
})();
const emaOf = (arr: number[], n: number) => {
  const a = 2 / (n + 1);
  const out: number[] = [];
  arr.forEach((v, i) => out.push(i ? a * v + (1 - a) * out[i - 1] : v));
  return out;
};
// Wilder's moving average (RMA); a running mean until n values exist
const wilder = (arr: number[], n: number) => {
  const out: number[] = [];
  arr.forEach((v, i) => out.push(i < n ? (i ? (out[i - 1] * i + v) / (i + 1) : v) : (out[i - 1] * (n - 1) + v) / n));
  return out;
};
const VIS = 32;
const OFF = BARS.length - VIS;
const SER = BARS.slice(OFF);
const cut = (a: number[]) => a.slice(OFF);
// Volume (millions), deterministic and loosely tied to each bar's range; the featured candle is 2.4M.
const VOLA = (() => {
  const r = rng(5);
  return BARS.map((b, i) => (i === BARS.length - 1 ? LAST.v : 1.1 + (b.h - b.l) * 0.55 + Math.abs(b.c - b.o) * 0.4 + r() * 0.5));
})();
const VOL = cut(VOLA);
// Indicators, computed for real over the full walk, then cut to the visible 32 hours.
const CLA = BARS.map((b) => b.c);
const E9 = cut(emaOf(CLA, 9));
const MBA = CLA.map((_, i) => { const w = CLA.slice(Math.max(0, i - 19), i + 1); return w.reduce((s, v) => s + v, 0) / w.length; });
const M20 = cut(MBA);
const BBS = cut(CLA.map((_, i) => { const w = CLA.slice(Math.max(0, i - 19), i + 1); return Math.sqrt(w.reduce((s, v) => s + (v - MBA[i]) ** 2, 0) / w.length); }));
const DIFF = CLA.map((c, i) => (i ? c - CLA[i - 1] : 0));
const GAIN = wilder(DIFF.map((x) => Math.max(x, 0)), 14), LOSS = wilder(DIFF.map((x) => Math.max(-x, 0)), 14);
const RSI = cut(GAIN.map((g, i) => (LOSS[i] === 0 ? 100 : 100 - 100 / (1 + g / LOSS[i]))));
const RG = cut(GAIN), RL = cut(LOSS);
const KAM = (() => {
  const f = 2 / 3, s = 2 / 31;
  const er: number[] = [], sc: number[] = [], k: number[] = [];
  CLA.forEach((c, t) => {
    const e = t < 10 ? 0 : Math.abs(c - CLA[t - 10]) / (DIFF.slice(t - 9, t + 1).reduce((a, d) => a + Math.abs(d), 0) || 1);
    const q = (e * (f - s) + s) ** 2;
    er.push(e); sc.push(q); k.push(t ? k[t - 1] + q * (c - k[t - 1]) : c);
  });
  return { er: cut(er), sc: cut(sc), k: cut(k) };
})();
const DMI = (() => {
  const tr = BARS.map((b, i) => (i ? Math.max(b.h - b.l, Math.abs(b.h - BARS[i - 1].c), Math.abs(b.l - BARS[i - 1].c)) : b.h - b.l));
  const pdm = BARS.map((b, i) => { if (!i) return 0; const u = b.h - BARS[i - 1].h, d = BARS[i - 1].l - b.l; return u > d && u > 0 ? u : 0; });
  const mdm = BARS.map((b, i) => { if (!i) return 0; const u = b.h - BARS[i - 1].h, d = BARS[i - 1].l - b.l; return d > u && d > 0 ? d : 0; });
  const atr = wilder(tr, 14), rp = wilder(pdm, 14), rm = wilder(mdm, 14);
  const p = rp.map((v, i) => (100 * v) / atr[i]), m = rm.map((v, i) => (100 * v) / atr[i]);
  const dx = p.map((v, i) => (v + m[i] ? (100 * Math.abs(v - m[i])) / (v + m[i]) : 0));
  return { p: cut(p), m: cut(m), dx: cut(dx), adx: cut(wilder(dx, 14)) };
})();
const MAC = (() => {
  const a = emaOf(CLA, 12), b = emaOf(CLA, 26);
  const m = a.map((v, i) => v - b[i]);
  const s = emaOf(m, 9);
  return { m: cut(m), s: cut(s), h: cut(m.map((v, i) => v - s[i])) };
})();

const PLO = Math.min(...SER.map((b) => b.l)) - 0.6, PHI = Math.max(...SER.map((b) => b.h)) + 0.6;
// Stage geometry. The SVG viewBox is wide (1700 x 760) and offset so the hero candle (built around
// x=500, y=300) stays centred; the chart frame spans nearly the full width, the data table sits above it.
const VB = { x: -350, y: -40, w: 1700, h: 760 };
const FR = { l: -220, r: 1325, t: 180, b: 680 };
const STEP = (FR.r - FR.l - 36) / (VIS - 1);
const X = (i: number) => FR.l + 18 + i * STEP;
const Y = (v: number) => FR.b - 14 - ((v - PLO) / (PHI - PLO)) * (FR.b - FR.t - 28);
const START_HOUR = 9;                                  // label for bar 0 on the time axis
const HH = (i: number) => `${String((START_HOUR + i) % 24).padStart(2, "0")}:00`;
const LI = VIS - 1;
const CROSSES = SER.map((_, i) => i).filter((i) => i > 0 && Math.sign(E9[i] - M20[i]) !== Math.sign(E9[i - 1] - M20[i - 1]));
const SHOWX = CROSSES;
// trades: entry on an EMA 9 / MA 20 cross; exit when price closes back through EMA 9
type Trade = { a: number; b: number; dir: "long" | "short"; pnl: number; open: boolean };
const TRADES: Trade[] = CROSSES.map((a) => {
  const dir = E9[a] > M20[a] ? "long" : "short";
  let b = a + 1;
  while (b < LI && !(dir === "long" ? SER[b].c < E9[b] : SER[b].c > E9[b])) b++;
  const pnl = ((SER[b].c - SER[a].c) / SER[a].c) * 100 * (dir === "long" ? 1 : -1);
  return { a, b, dir, pnl, open: b >= LI };
});
const tradeLabel = (t: Trade) => `${t.dir.toUpperCase()} ${t.open ? "OPEN" : `${t.pnl >= 0 ? "+" : "−"}${Math.abs(t.pnl).toFixed(1)}%`}`;
const linePath = (arr: number[]) => arr.map((v, i) => `${i ? "L" : "M"}${X(i).toFixed(1)},${Y(v).toFixed(1)}`).join("");

// big candle: body 200 px tall for the last candle's open->close
const K = 200 / (LAST.c - LAST.o);
const BIG = { cx: 500, top: 200, bot: 400, hi: 200 - (LAST.h - LAST.c) * K, lo: 400 + (LAST.o - LAST.l) * K };
const SMALL_S = (Y(LAST.o) - Y(LAST.c)) / 200;
const TO_SLOT = { x: X(LI) - 500, y: (Y(LAST.o) + Y(LAST.c)) / 2 - 300 };
// Blast: the hero candle bursts into shards from its body; each target shard later re-forms into one
// candle of the series (slots 0..LI), the debris shards just fade. Deterministic so scrubbing is stable.
const SHARD_W = 10, SHARD_H = 16;
type Shard = { x0: number; y0: number; sx: number; sy: number; rot: number; tx?: number; ty?: number; th?: number; up?: boolean; order?: number };
const SHARDS: Shard[] = (() => {
  const rr = rng(77);
  const r = () => rr() + 0.5;                                       // rng() is centred on 0; we want 0..1
  const make = (): Shard => {
    const x0 = 462 + r() * 76, y0 = 205 + r() * 190;                 // somewhere inside the candle body
    const ang = Math.atan2(y0 - 300, x0 - 500) + (r() - 0.5) * 1.4;   // fly outward from the centre
    const dist = 170 + r() * 230;
    return { x0, y0, sx: 500 + Math.cos(ang) * dist * 1.25, sy: 300 + Math.sin(ang) * dist * 0.62, rot: (r() - 0.5) * 300 };
  };
  const targets = [...SER.slice(0, LI), LAST].map((b, i) => {
    const s = make();
    const top = Y(Math.max(b.o, b.c)), h = Math.max(2.5, Math.abs(Y(b.o) - Y(b.c)));
    return { ...s, tx: X(i), ty: top + h / 2, th: h, up: b.c >= b.o, order: Math.abs(X(i) - 500) / 23 };
  });
  return [...targets, ...Array.from({ length: 26 }, make)];
})();
const TARGETS = SHARDS.filter((s) => s.tx !== undefined);
const DEBRIS = SHARDS.filter((s) => s.tx === undefined);

// the indicator database: hero in stage 05, then small at the head of the research pipeline
const DBH = { x: 500, y: 330, big: 2, small: 0.7, sx: -215 };

/* ---------------- palette + data table ---------------- */

const INK = "#0C1A26", GREEN = "#1E6B62", RED = "#C74747", AMBER = "#A8791A", MUTE = "#5A6874", LINE = "#DDE5E7", DEEP = "#0C1A26", PANEL = "#FFFFFF";
const TEAL = "#087C98", PURPLE = "#7051A0";
const DIRC = { long: GREEN, short: RED } as const;

const f1 = (v: number) => v.toFixed(1);
const f2 = (v: number) => v.toFixed(2);
const sgn = (v: number, d: number) => `${v < 0 ? "−" : "+"}${Math.abs(v).toFixed(d)}`;
type TRow = { label: string; vals: string[]; color: string };
const TROWS: TRow[] = [
  { label: "Open", vals: SER.map((b) => f1(b.o)), color: INK },
  { label: "High", vals: SER.map((b) => f1(b.h)), color: INK },
  { label: "Low", vals: SER.map((b) => f1(b.l)), color: INK },
  { label: "Close", vals: SER.map((b) => f1(b.c)), color: INK },
  { label: "Volume", vals: VOL.map((v) => `${v.toFixed(1)}M`), color: INK },
  { label: "EMA 9", vals: E9.map(f1), color: AMBER },
  { label: "MA 20", vals: M20.map(f1), color: TEAL },
  { label: "BB σ", vals: BBS.map(f2), color: PURPLE },
  { label: "RSI 14", vals: RSI.map((v) => v.toFixed(0)), color: PURPLE },
  { label: "KAMA 10", vals: KAM.k.map(f1), color: PURPLE },
  { label: "ADX 14", vals: DMI.adx.map((v) => v.toFixed(0)), color: PURPLE },
  { label: "MACD", vals: MAC.m.map((v) => sgn(v, 2)), color: PURPLE },
];
const NOHLCV = 5;
const MORE = 133;                                      // 5 OHLCV + 7 shown + 133 more = 145 columns
const RH = 17, TOP = -22;
const TY = (r: number) => TOP + r * RH;
const TBL_L = -312;                                    // left edge of the table (row labels live here)
// scroll windows (fractions of the whole story) in which each row's values fill left to right
const W3: [number, number] = [0.266, 0.346];
const FW: Record<number, [number, number]> = {
  5: [0.4, 0.426], 6: [0.4, 0.426], 7: [0.412, 0.438], 8: [0.424, 0.45], 9: [0.478, 0.502], 10: [0.49, 0.516], 11: [0.5, 0.524],
};
const ROW_WIN = (r: number): [number, number] => (r < NOHLCV ? W3 : FW[r]);

// formula cards: two waves of three through the same three slots. Math strings use _{..} and ^{..}.
type Card = { name: string; rows: number[]; reads: number[]; slot: number; lines: string[]; live: (i: number) => string; from: [number, number, number] };
const CW = 440, CH = 138;
const SLOTS = [{ x: -205, y: 250 }, { x: 260, y: 250 }, { x: 725, y: 250 }];
const CARDS: Card[] = [
  {
    name: "EMA 9 · MA 20", rows: [5, 6], reads: [3], slot: 0, from: [-320, -40, -14],
    lines: ["EMA_{t} = α·C_{t} + (1 − α)·EMA_{t−1}", "α = 2 ÷ (9 + 1) = 0.2", "MA_{20} = (1/20)·Σ_{i=0}^{19} C_{t−i}"],
    live: (i) => `${HH(i)}  C ${f2(SER[i].c)}  →  EMA ${f2(E9[i])} · MA ${f2(M20[i])}`,
  },
  {
    name: "Bollinger bands", rows: [7], reads: [3], slot: 1, from: [0, 300, 10],
    lines: ["MB = SMA_{20}(C)", "σ = √( Σ_{i=1}^{20} (C_{i} − MB)^{2} ÷ 20 )", "Upper, Lower = MB ± 2σ"],
    live: (i) => `MB ${f2(M20[i])}  σ ${f2(BBS[i])}  →  ${f2(M20[i] - 2 * BBS[i])} – ${f2(M20[i] + 2 * BBS[i])}`,
  },
  {
    name: "RSI 14 (RMA smoothing)", rows: [8], reads: [3], slot: 2, from: [320, -60, 14],
    lines: ["RMA_{t} = (13·RMA_{t−1} + x_{t}) ÷ 14", "RS = RMA(gain) ÷ RMA(loss)", "RSI = 100 − 100 ÷ (1 + RS)"],
    live: (i) => `gain ${f2(RG[i])}  loss ${f2(RL[i])}  RS ${f2(RG[i] / (RL[i] || 1))}  →  ${RSI[i].toFixed(1)}`,
  },
  {
    name: "KAMA 10 (adaptive average)", rows: [9], reads: [3], slot: 0, from: [-300, 220, 12],
    lines: ["ER = |C_{t} − C_{t−10}| ÷ Σ|C_{i} − C_{i−1}|", "SC = [ER·(f − s) + s]^{2},  f = 2/3, s = 2/31", "KAMA_{t} = KAMA_{t−1} + SC·(C_{t} − KAMA_{t−1})"],
    live: (i) => `ER ${KAM.er[i].toFixed(3)}  SC ${KAM.sc[i].toFixed(4)}  →  KAMA ${f2(KAM.k[i])}`,
  },
  {
    name: "ADX 14 · DMI", rows: [10], reads: [1, 2, 3], slot: 1, from: [0, -260, -10],
    lines: ["±DI = 100·RMA(±DM) ÷ ATR_{14}", "DX = 100·|+DI − −DI| ÷ (+DI + −DI)", "ADX = RMA_{14}(DX)"],
    live: (i) => `+DI ${f1(DMI.p[i])}  −DI ${f1(DMI.m[i])}  DX ${f1(DMI.dx[i])}  →  ADX ${f1(DMI.adx[i])}`,
  },
  {
    name: "MACD 12 · 26 · 9", rows: [11], reads: [3], slot: 2, from: [300, 240, -12],
    lines: ["MACD = EMA_{12}(C) − EMA_{26}(C)", "Signal = EMA_{9}(MACD)", "Hist = MACD − Signal"],
    live: (i) => `MACD ${sgn(MAC.m[i], 3)}  signal ${sgn(MAC.s[i], 3)}  →  hist ${sgn(MAC.h[i], 3)}`,
  },
];
const cardWin = (c: Card): [number, number] => [Math.min(...c.rows.map((r) => FW[r][0])), Math.max(...c.rows.map((r) => FW[r][1]))];
const wireX = (c: Card) => { const s = SLOTS[c.slot]; const j = Math.max(0, Math.min(LI - 1, Math.round((s.x + CW / 2 - X(0)) / STEP - 0.5))); return X(j) + STEP / 2; };

// renders "EMA_{t−1}" / "x^{2}" as SVG tspans with real sub/superscripts
function MathText({ s }: { s: string }) {
  const parts: React.ReactNode[] = [];
  const re = /([_^])\{([^}]*)\}/g;
  let last = 0, m: RegExpExecArray | null, k = 0;
  while ((m = re.exec(s))) {
    if (m.index > last) parts.push(<tspan key={k++}>{s.slice(last, m.index)}</tspan>);
    parts.push(<tspan key={k++} baselineShift={m[1] === "_" ? "sub" : "super"} fontSize="0.68em">{m[2]}</tspan>);
    parts.push(<tspan key={k++} baselineShift="baseline">{" "}</tspan>);
    last = re.lastIndex;
  }
  if (last < s.length) parts.push(<tspan key={k++}>{s.slice(last)}</tspan>);
  return <>{parts}</>;
}

/* ---------------- stage 05: shatter into the database ---------------- */

type Sliver = { x: number; y: number; w: number; h: number; c: string; bx: number; by: number; tx: number; ty: number; rot: number; d: number };
const SLIVERS: Sliver[] = (() => {
  const rr = rng(31), r = () => rr() + 0.5;
  const out: Sliver[] = [];
  const add = (x: number, y: number, h: number, c: string) => {
    const ang = r() * Math.PI * 2;
    out.push({ x, y, w: 3 + r() * 3, h, c, bx: Math.cos(ang) * (20 + r() * 50), by: Math.sin(ang) * (20 + r() * 40),
      tx: DBH.x + (r() - 0.5) * 60, ty: DBH.y + (r() - 0.5) * 60, rot: (r() - 0.5) * 200, d: Math.abs(x - DBH.x) / 38 });
  };
  SER.forEach((b, i) => {
    const col = b.c >= b.o ? GREEN : RED;
    add(X(i) - 4, Y(Math.max(b.o, b.c)), Math.max(8, Math.abs(Y(b.o) - Y(b.c)) / 2), col);
    add(X(i) + 3, Y(b.h), Math.max(8, (Y(b.l) - Y(b.h)) / 2), col);
  });
  for (let k = 0; k < 44; k++) add(TBL_L + 60 + r() * (FR.r - TBL_L - 60), TOP - 10 + r() * (TY(11) - TOP + 4), 10 + r() * 6, k % 4 ? INK : PURPLE);
  for (let k = 0; k < 18; k++) { const i = Math.floor(r() * VIS); add(X(i), Y(k % 2 ? E9[i] : M20[i]) - 8, 16, k % 2 ? AMBER : TEAL); }
  return out;
})();

// facts that count up around the growing database. Plain, product-level statements.
type Fact = { v: string; l: string; count?: (s: number) => string };
const FACTS: Fact[] = [
  { v: "70+", l: "complex indicators calculated", count: (s) => `${Math.round(s * 70)}${s >= 1 ? "+" : ""}` },
  { v: "145", l: "values stored per candle", count: (s) => String(Math.round(s * 145)) },
  { v: "13", l: "markets: US stocks, index, commodities", count: (s) => String(Math.round(s * 13)) },
  { v: "24 / 7", l: "every closed hour, around the clock" },
  { v: "≈ 16.5M", l: "data points a year (145 × 13 × 24 × 365, est.)", count: (s) => `≈ ${(s * 16.5).toFixed(1)}M` },
  { v: "years", l: "of history per market" },
  { v: "every candle", l: "all values recomputed when one closes" },
  { v: "long + short", l: "signals in both directions" },
];
const FW_ = 360, FH = 88;
const FPOS = FACTS.map((_, k) => ({ x: k < 4 ? -70 : 710, y: 112 + (k % 4) * 112 }));

/* ---------------- stage 06-07: research + backtesting engines ---------------- */

const RP = { x: -90, y: 90, w: 490, h: 480 };   // research engine panel
const BP = { x: 450, y: 90, w: 560, h: 480 };   // backtesting engine panel
const SP = { x: 1060, y: 90, w: 270, h: 480 };  // selected
// fact cards blast into fragments that assemble the two engine panels' outlines
type Frag = { x0: number; y0: number; bx: number; by: number; tx: number; ty: number; rot: number; vert: boolean; c: string; d: number };
const FRAGS: Frag[] = (() => {
  const rr = rng(53), r = () => rr() + 0.5;
  const per = (p: typeof RP, n: number) => {
    const L = 2 * (p.w + p.h);
    return Array.from({ length: n }, (_, k) => {
      let u = ((k + 0.5) / n) * L;
      if (u < p.w) return { x: p.x + u, y: p.y, vert: false };
      u -= p.w; if (u < p.h) return { x: p.x + p.w, y: p.y + u, vert: true };
      u -= p.h; if (u < p.w) return { x: p.x + p.w - u, y: p.y + p.h, vert: false };
      u -= p.w; return { x: p.x, y: p.y + p.h - u, vert: true };
    });
  };
  const tg = [...per(RP, 40), ...per(BP, 44)];
  return tg.map((t, k) => {
    const f = FPOS[k % FACTS.length];
    const x0 = f.x + 20 + r() * (FW_ - 40), y0 = f.y + 15 + r() * (FH - 30);
    const ang = Math.atan2(y0 - DBH.y, x0 - DBH.x) + (r() - 0.5) * 1.2;
    const dist = 60 + r() * 140;
    return { x0, y0, bx: x0 + Math.cos(ang) * dist, by: y0 + Math.sin(ang) * dist, tx: t.x, ty: t.y, rot: (r() - 0.5) * 360, vert: t.vert, c: k % 3 ? GREEN : INK, d: r() * 10 };
  });
})();
const COLCHIPS = ["Close", "EMA 9", "MA 20", "BB σ", "RSI 14", "KAMA 10", "ADX 14", "MACD"];
const LOGS: [string, "long" | "short"][] = [
  ["#0007  RSI 14 < 30 ∨ KAMA rising", "long"],
  ["#0031  MACD hist < 0 ∧ ADX > 25", "short"],
  ["#0118  close > MB + 2σ", "short"],
  ["#0187  EMA 9 × MA 20 ↑ ∧ RSI < 70", "long"],
  ["#0244  KAMA slope > 0 ∧ ADX > 20", "long"],
  ["#0391  EMA 9 × MA 20 ↓ ∧ RSI > 30", "short"],
  ["#0502  BB σ > 1.2 ∧ RSI > 70", "short"],
  ["#0688  MACD × signal ↑", "long"],
  ["#0915  close < MA 20 ∧ ADX > 30", "short"],
  ["#1203  RSI 14 > 50 ∧ KAMA rising", "long"],
];
const TESTED = 1240;
const LANES: { id: string; ok: boolean; why: string; d1: number; d2: number }[] = [
  { id: "#0118", ok: false, why: "Sharpe 0.18", d1: 0.05, d2: -0.1 },
  { id: "#0187", ok: true, why: "passed", d1: 0.45, d2: 0.4 },
  { id: "#0244", ok: false, why: "DD −41%", d1: 0.2, d2: -0.6 },
  { id: "#0391", ok: true, why: "passed", d1: 0.38, d2: 0.32 },
  { id: "#0502", ok: false, why: "9 trades", d1: 0.15, d2: 0.05 },
  { id: "#0688", ok: false, why: "unseen 0.12", d1: 0.3, d2: -0.25 },
];
const GATES = ["Sharpe ≥ 0.5, both periods", "drawdown ≥ −35%", "15+ trades", "fees included"];
function curve(seed: number, drift: number, x0: number, w: number, ym: number, h: number, n = 26) {
  const r = rng(seed);
  const pts = [0];
  for (let i = 1; i < n; i++) pts.push(pts[i - 1] + drift + r() * 1.5);
  const lo = Math.min(...pts, -3), hi = Math.max(...pts, 3);
  return pts.map((v, i) => `${i ? "L" : "M"}${(x0 + (i / (n - 1)) * w).toFixed(1)},${(ym + h / 2 - ((v - lo) / (hi - lo)) * h).toFixed(1)}`).join("");
}

const RULE_LINES = ["Long when EMA 9 crosses above MA 20", "and RSI < 70. Short when it crosses", "below and RSI > 30. Exit when price", "closes back through EMA 9. Stop 3%."];
const RULE = RULE_LINES.join(" ");

const fmt = (v: number) => `$${v.toFixed(2)}`;
const clamp = (x: number) => Math.min(1, Math.max(0, x));
const seg = (p: number, a: number, b: number) => clamp((p - a) / (b - a));
const comma = (n: number) => n.toLocaleString("en-US");

/* ---------------- stage 09: live execution loop ---------------- */

const E0 = 8;                                           // first candle of the live loop
const XE = (i: number) => 668 + (i - E0) * 28;
const ELO = Math.min(...SER.slice(E0).map((b) => b.l)) - 0.3, EHI = Math.max(...SER.slice(E0).map((b) => b.h)) + 0.3;
const YE = (v: number) => 292 - ((v - ELO) / (EHI - ELO)) * 236;
const ePath = (arr: number[]) => arr.slice(E0).map((v, k) => `${k ? "L" : "M"}${XE(E0 + k).toFixed(1)},${YE(v).toFixed(1)}`).join("");
const LIVE_A = 0.862, LIVE_B = 0.985;
const liveCur = (p: number) => (p < 0.84 ? -1 : Math.min(LI, E0 + 2 + Math.floor(seg(p, LIVE_A, LIVE_B) * (LI - E0 - 1))));
const pAt = (i: number) => LIVE_A + ((i - E0 - 2) / (LI - E0 - 1)) * (LIVE_B - LIVE_A);
const ST = TRADES.find((t) => t.dir === "short")!;
type Ev = { at: number; kind: "ENTRY" | "EXIT"; dir: "long" | "short"; px: number; t: Trade };
const EVENTS: Ev[] = TRADES.flatMap((t) => [
  { at: t.a, kind: "ENTRY" as const, dir: t.dir, px: SER[t.a].c, t },
  ...(t.open ? [] : [{ at: t.b, kind: "EXIT" as const, dir: t.dir, px: SER[t.b].c, t }]),
]).filter((e) => e.at >= E0 + 2);
const PKT = [[-32, 200], [140, 200], [360, 200], [440, 200], [520, 200]] as const;
// the selected rules land here as the strategy column; order log tiles run along the bottom
const COLX = -320, COLR = COLX + 238, COLY = (k: number) => 110 + k * 150;
const ORD = (k: number) => ({ x: -320 + k * 416, y: 452, w: 402, h: 58 });

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
    k: "03", name: "Data", at: 0.36,
    title: "Every candle is five numbers.",
    body: "Read the chart one hour at a time and it becomes a table: open, high, low, close and volume, one column per candle.",
    detail: [
      [`Close at ${HH(7)} ${fmt(SER[7].c)}`, "one cell of the table"],
      [`Volume at ${HH(7)} ${VOL[7].toFixed(1)}M`, "shares traded that hour"],
      ["32 hours shown", "we keep years of them"],
    ],
  },
  {
    k: "04", name: "Formulas", at: 0.526,
    title: "Formulas turn the table into indicators.",
    body: "Each formula reads rows of the table and writes a new row: adaptive averages, volatility bands, momentum, trend strength. Two averages are drawn on the chart. We compute more than 70 of these.",
    detail: [
      [`EMA 9 ${fmt(E9[LI])} · MA 20 ${fmt(M20[LI])}`, "fast and slow averages"],
      [`Bollinger σ ${f2(BBS[LI])}`, "how spread out the last 20 closes are"],
      [`RSI 14 ${RSI[LI].toFixed(0)}`, "momentum from 0 to 100, Wilder smoothing"],
      [`KAMA 10 ${fmt(KAM.k[LI])}`, "an average that speeds up when price trends"],
      [`ADX 14 ${DMI.adx[LI].toFixed(0)}`, "trend strength from directional movement"],
      [`MACD ${sgn(MAC.m[LI], 2)}`, "fast trend minus slow trend"],
    ],
  },
  {
    k: "05", name: "Database", at: 0.615,
    title: "Everything goes into one database.",
    body: "The chart, the table and every indicator are stored candle by candle, for every market, and recomputed as each new candle closes.",
    detail: FACTS.map((f) => [f.v, f.l] as [string, string]),
  },
  {
    k: "06", name: "Research", at: 0.718,
    title: "Artificial Intelligence proposes the rules.",
    body: "The research engine, run by Artificial Intelligence, pulls indicator columns out of the database and combines them with AND and OR into many candidate rules. Some go long (buy, profit if price rises). Some go short (sell first, profit if price falls).",
    detail: LOGS.slice(2, 6).map(([t, d]) => [t, d === "long" ? "a long candidate" : "a short candidate"] as [string, string]),
  },
  {
    k: "07", name: "Validate", at: 0.818,
    title: "The backtesting engine tests every one. Most fail.",
    body: `Each candidate replays years of past prices, with fees, then a later period it never saw. In this run ${comma(TESTED)} combinations were tested and two passed every gate.`,
    detail: GATES.map((g) => [g, "required on every candidate"] as [string, string]),
  },
  {
    k: "08", name: "Execute", at: 0.995,
    title: "Every new candle is checked. Orders fire on their own.",
    body: "The selected long and short rules become your strategy. You approve a trade-only API key: it can place orders on Hyperliquid but can never withdraw. On every closed candle the rule's conditions are checked; when they all turn true an order is sent, with a stop-loss resting on the exchange.",
    detail: [
      ["Trade-only API key", "can trade, cannot withdraw"],
      ...EVENTS.map((e) => [`${e.kind} ${e.dir} at ${HH(e.at)}`, `${fmt(e.px)}${e.kind === "EXIT" ? `, ${tradeLabel(e.t).split(" ")[1]}` : `, stop ${fmt(e.dir === "long" ? e.px * 0.97 : e.px * 1.03)}`}`] as [string, string]),
    ],
  },
];
const PHASES = [0, 125, 252, 370, 530, 620, 720, 822];

/* ---------------- the stage: one wide SVG ---------------- */

function Candle({ b, i, x = X, y = Y, w = 18 }: { b: Bar; i: number; x?: (i: number) => number; y?: (v: number) => number; w?: number }) {
  const up = b.c >= b.o;
  return (
    <>
      <line x1={x(i)} x2={x(i)} y1={y(b.h)} y2={y(b.l)} stroke={up ? GREEN : RED} strokeWidth="2.2" opacity="0.95" />
      <rect x={x(i) - w / 2} width={w} y={y(Math.max(b.o, b.c))} height={Math.max(2.5, Math.abs(y(b.o) - y(b.c)))}
        fill={up ? GREEN : RED} stroke={up ? GREEN : RED} strokeWidth="1.6" />
    </>
  );
}

function Pill({ x, y, w, h, fill, color, text, size = 11.5, stroke }: { x: number; y: number; w: number; h: number; fill: string; color: string; text: string; size?: number; stroke?: string }) {
  return (
    <>
      <rect x={x} y={y} width={w} height={h} rx={h / 2} fill={fill} stroke={stroke ?? "none"} />
      <text x={x + w / 2} y={y + h / 2 + size * 0.36} fontSize={size} textAnchor="middle" fontWeight="700" fill={color}>{text}</text>
    </>
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
    <svg width={VB.w} height={VB.h} viewBox={`${VB.x} ${VB.y} ${VB.w} ${VB.h}`} className="block overflow-visible" style={{ fontFamily: "var(--aq-sans)" }} aria-hidden>
      <defs>
        <filter id="aqglow" x="-50%" y="-50%" width="200%" height="200%">
          <feGaussianBlur stdDeviation="4" result="b" />
          <feMerge><feMergeNode in="b" /><feMergeNode in="SourceGraphic" /></feMerge>
        </filter>
        <filter id="aqglowsoft" x="-30%" y="-30%" width="160%" height="160%">
          <feGaussianBlur stdDeviation="2.2" result="b" />
          <feMerge><feMergeNode in="b" /><feMergeNode in="SourceGraphic" /></feMerge>
        </filter>
        <pattern id="aqgrid" width="20" height="20" patternUnits="userSpaceOnUse">
          <path d="M20 0H0V20" fill="none" stroke="#E4EAEC" strokeWidth="0.8" />
        </pattern>
        <pattern id="aqgrid5" width="100" height="100" patternUnits="userSpaceOnUse">
          <path d="M100 0H0V100" fill="none" stroke="#D6DEE1" strokeWidth="1" />
        </pattern>
      </defs>
      {/* graph-paper background */}
      <rect x="-600" y="-300" width="2600" height="1300" fill="url(#aqgrid)" />
      <rect x="-600" y="-300" width="2600" height="1300" fill="url(#aqgrid5)" />
      {/* ---------- chart group: shatters in stage 05, returns small for Publish ---------- */}
      <g data-a={q("chart")} style={{ transformOrigin: "0px 0px" }}>
        <g data-a={q("grid")} style={{ opacity: 0 }}>
          {Array.from({ length: Math.floor(PHI) - Math.ceil(PLO) + 1 }, (_, k) => Math.ceil(PLO) + k)
            .filter((v) => (v - Math.ceil(PLO)) % 2 === 0)
            .map((v) => (
              <g key={v}>
                <line x1={FR.l} x2={FR.r} y1={Y(v)} y2={Y(v)} stroke="#D9E1E4" strokeDasharray="2 4" />
                <line x1={FR.l - 6} x2={FR.l} y1={Y(v)} y2={Y(v)} stroke={INK} strokeWidth="1.2" />
                <text x={FR.l - 10} y={Y(v) + 4} fontSize="12" textAnchor="end" fill={MUTE} fontFamily="var(--aq-mono)">{v}</text>
              </g>
            ))}
          {SER.map((_, i) => (
            <g key={i}>
              <line x1={X(i)} x2={X(i)} y1={FR.b} y2={FR.b + (i % 4 === 0 ? 6 : 3)} stroke={INK} strokeWidth="1.1" />
              {i % 4 === 0 && (
                <text x={X(i)} y={FR.b + 19} fontSize="11.5" textAnchor="middle" fill={MUTE} fontFamily="var(--aq-mono)">{HH(i)}</text>
              )}
            </g>
          ))}
          <path d={`M${FR.l},${FR.t} V${FR.b} H${FR.r}`} fill="none" stroke={INK} strokeWidth="1.6" />
          <text x={FR.l + 12} y={FR.t + 20} fontSize="13" fill={MUTE} fontFamily="var(--aq-mono)">NVDA · 1 candle = 1 hour</text>
        </g>

        {/* scanning highlight: one candle column, across the table and the chart */}
        <g data-n={q("scan")} style={{ opacity: 0 }}>
          <rect x={X(0) - STEP / 2 + 1} y={TOP - 15} width={STEP - 2} height={FR.b - TOP + 15} rx="6" fill="rgba(168,121,26,.10)" stroke={AMBER} strokeOpacity="0.55" />
        </g>

        {/* data table: OHLCV rows, then indicator rows appended by the formulas */}
        {TROWS.map((row, r) => (
          <g key={r} data-a={q("trow")}>
            <g data-a={q(`tl${r}`)} style={{ opacity: 0 }}>
              <rect x={TBL_L} y={TY(r) - 12.6} width={FR.r - TBL_L + 4} height={RH - 1.4} rx="3" fill={PANEL} fillOpacity={0.94} stroke={r === NOHLCV ? row.color : LINE} strokeOpacity={r === NOHLCV ? 0.35 : 1} />
              <text x={X(0) - STEP / 2 - 8} y={TY(r)} fontSize="12.5" fontWeight="600" textAnchor="end" fill={row.color}>{row.label}</text>
            </g>
            {row.vals.map((v, i) => (
              <text key={i} data-c={q(`${r}-${i}`)} x={X(i)} y={TY(r)} fontSize="12.5" textAnchor="middle" fill={row.color} fontFamily="var(--aq-mono)" style={{ opacity: 0 }}>{v}</text>
            ))}
          </g>
        ))}

        {SER.slice(0, LI).map((b, i) => (
          <g key={i} data-a={q("clone")} style={{ opacity: 0 }}><Candle b={b} i={i} /></g>
        ))}
        {TARGETS.map((s, k) => (
          <g key={`t${k}`} data-a={q("shard")} style={{ opacity: 0 }}>
            <rect x={-SHARD_W / 2} y={-SHARD_H / 2} width={SHARD_W} height={SHARD_H} rx="1.5" fill={s.up ? GREEN : RED} />
          </g>
        ))}
        {DEBRIS.map((s, k) => (
          <g key={`d${k}`} data-a={q("debris")} style={{ opacity: 0 }}>
            <rect x={-3} y={-4} width={6} height={8} rx="1" fill={k % 3 ? GREEN : INK} opacity="0.7" />
          </g>
        ))}

        <path data-a={q("l9")} d={linePath(E9)} pathLength={1} fill="none" stroke={AMBER} strokeWidth="2.6" strokeDasharray="1" strokeDashoffset="1" strokeLinejoin="round" filter="url(#aqglow)" />
        <path data-a={q("l20")} d={linePath(M20)} pathLength={1} fill="none" stroke={TEAL} strokeWidth="2.6" strokeDasharray="1" strokeDashoffset="1" strokeLinejoin="round" filter="url(#aqglow)" />
        <g data-a={q("amb")} style={{ opacity: 0 }}>
          {[E9, M20].map((arr, k) => (
            <path key={k} className="aq-flow" d={linePath(arr)} fill="none" stroke={INK} strokeOpacity="0.35" strokeWidth="1.4" strokeDasharray="2 26" />
          ))}
        </g>
        {SHOWX.map((i) => (
          <g key={i} data-n={q(`x${i}`)} style={{ opacity: 0 }}>
            <circle cx={X(i)} cy={Y(E9[i])} r="10" fill="none" stroke={E9[i] > M20[i] ? GREEN : RED} strokeWidth="2.2" />
            <text x={X(i)} y={Y(E9[i]) + (E9[i] > M20[i] ? 30 : -17)} fontSize="13" textAnchor="middle" fill={E9[i] > M20[i] ? GREEN : RED} fontWeight="600">
              {E9[i] > M20[i] ? "cross up" : "cross down"}
            </text>
          </g>
        ))}
        {/* formula cards: wires up to the rows they read (pulsing once connected), then the card */}
        {CARDS.map((c, k) => {
          const s = SLOTS[c.slot], wx = wireX(c), top = Math.min(...c.reads.map(TY)) - 4, col = TROWS[c.rows[0]].color;
          return (
            <g key={k} data-a={q(`cw${k}`)}>
              <path data-a={q(`wire${k}`)} d={`M${wx},${s.y} V${top}`} pathLength={1} fill="none" stroke={col} strokeWidth="1.4" strokeDasharray="1" strokeDashoffset="1" />
              <g data-a={q(`rdot${k}`)} style={{ opacity: 0 }}>
                <path className="aq-flow" d={`M${wx},${top} V${s.y}`} fill="none" stroke={col} strokeWidth="3" strokeDasharray="3 25" strokeLinecap="round" />
                {c.reads.map((r) => <circle key={r} cx={wx} cy={TY(r) - 4} r="3.8" fill={col} />)}
              </g>
              <g data-a={q(`card${k}`)} style={{ opacity: 0, transformBox: "fill-box", transformOrigin: "50% 50%" }}>
                <rect x={s.x} y={s.y} width={CW} height={CH} rx="12" fill={PANEL} stroke={col} strokeOpacity="0.75" filter="url(#aqglowsoft)" />
                <text x={s.x + 16} y={s.y + 25} fontSize="15" fontWeight="700" fill={col}>{c.name}</text>
                <text data-n={q(`cv${k}`)} x={s.x + CW - 16} y={s.y + 25} fontSize="13" textAnchor="end" fill={INK} fontFamily="var(--aq-mono)" style={{ opacity: 0 }}>
                  = {c.rows.map((r) => TROWS[r].vals[LI]).join(" · ")}
                </text>
                {c.lines.map((l, j) => (
                  <text key={j} data-n={q(`ml${k}-${j}`)} x={s.x + 16} y={s.y + 52 + j * 25} fontSize="16" fill={INK} fontFamily="var(--aq-serif)"><MathText s={l} /></text>
                ))}
                <line x1={s.x + 16} x2={s.x + CW - 16} y1={s.y + CH - 26} y2={s.y + CH - 26} stroke={LINE} />
                <text data-n={q(`lv${k}`)} x={s.x + 16} y={s.y + CH - 9} fontSize="12" fill={MUTE} fontFamily="var(--aq-mono)"> </text>
              </g>
            </g>
          );
        })}
        <g data-a={q("more")} style={{ opacity: 0 }}>
          <text x={FR.l + 12} y={FR.t + 44} fontSize="16" fontWeight="700" fill={AMBER}>
            + <tspan data-n={q("moren")} fontFamily="var(--aq-mono)">0</tspan> more indicators, same way
          </text>
          <text x={FR.l + 360} y={FR.t + 44} fontSize="12.5" fill={MUTE} fontFamily="var(--aq-mono)">Stochastic RSI · Supertrend · Ichimoku · Fisher · OBV · ATR · CCI · …</text>
        </g>

        {/* the hero candle; ends as the newest candle of the series */}
        <g data-a={q("big")} style={{ transformOrigin: "500px 300px" }}>
          <g data-a={q("hw")}><line x1="500" x2="500" y1={BIG.hi} y2={BIG.top} stroke={INK} strokeWidth="3" strokeLinecap="round" /></g>
          <g data-a={q("lw")}><line x1="500" x2="500" y1={BIG.bot} y2={BIG.lo} stroke={INK} strokeWidth="3" strokeLinecap="round" /></g>
          <rect x="455" y={BIG.top} width="90" height="200" rx="4" fill={GREEN} filter="url(#aqglow)" />
          <g data-a={q("ot")}><line x1="410" x2="455" y1={BIG.bot} y2={BIG.bot} stroke={INK} strokeWidth="3.5" strokeLinecap="round" /></g>
          <g data-a={q("ct")}><line x1="545" x2="590" y1={BIG.top} y2={BIG.top} stroke={INK} strokeWidth="3.5" strokeLinecap="round" /></g>
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

      {/* ---------- 05: slivers of the chart stream into the database ---------- */}
      {SLIVERS.map((s, k) => (
        <g key={k} data-a={q("sliver")} style={{ opacity: 0, transformBox: "fill-box", transformOrigin: "50% 50%" }}>
          <rect x={s.x} y={s.y} width={s.w} height={s.h} rx="1" fill={s.c} />
        </g>
      ))}
      <g data-a={q("dbf")} transform={`translate(${DBH.x} ${DBH.y})`}>
        <g data-a={q("dbm")} style={{ transformOrigin: "0px 0px" }}>
        <g data-a={q("db")} style={{ opacity: 0, transformOrigin: "0px 0px" }}>
          <text x="0" y="-80" fontSize="13" fontWeight="700" textAnchor="middle" fill={INK} letterSpacing="0.5">Indicator database</text>
          <path d="M-62,-50 V50 A62,16 0 0 0 62,50 V-50" fill={PANEL} stroke={GREEN} strokeWidth="1.8" filter="url(#aqglowsoft)" />
          {[-17, 17].map((dy) => <path key={dy} d={`M-62,${dy} A62,16 0 0 0 62,${dy}`} fill="none" stroke={GREEN} strokeOpacity="0.55" strokeWidth="1.3" />)}
          {[-36, -12, 12, 36].map((dx) => <line key={dx} x1={dx} x2={dx} y1="-34" y2="62" stroke={GREEN} strokeOpacity="0.18" />)}
          <ellipse cx="0" cy="-50" rx="62" ry="16" fill="#E3EEEC" stroke={GREEN} strokeWidth="1.8" />
          <circle className="aq-pulse" cx="0" cy="-50" r="4" fill={GREEN} />
        </g>
        </g>
      </g>
      <g data-a={q("factw")} style={{ transformBox: "fill-box", transformOrigin: "50% 50%" }}>
      {FACTS.map((f, k) => {
        const { x, y } = FPOS[k];
        return (
          <g key={k} data-a={q("fact")} style={{ opacity: 0 }}>
            <rect x={x} y={y} width={FW_} height={FH} rx="14" fill={PANEL} stroke={LINE} />
            <rect x={x} y={y + 14} width="4" height={FH - 28} rx="2" fill={k % 2 ? AMBER : GREEN} />
            <text data-n={q(`fv${k}`)} x={x + 22} y={y + 42} fontSize="28" fontWeight="700" fill={INK} fontFamily="var(--aq-mono)">{f.v}</text>
            <text x={x + 22} y={y + 68} fontSize="13.5" fill={MUTE}>{f.l}</text>
          </g>
        );
      })}
      </g>

      {/* ---------- 06-07: fragments of the facts assemble the two engines ---------- */}
      <g data-a={q("fragw")}>
      {FRAGS.map((f, k) => (
        <g key={k} data-a={q("frag")} style={{ opacity: 0 }}>
          <rect x="-11" y="-2.5" width="22" height="5" rx="1.5" fill={f.c} />
        </g>
      ))}
      </g>
      <g data-a={q("eng")}>
      <g data-a={q("panel")} style={{ opacity: 0 }}>
        {[RP, BP, SP].map((p, k) => (
          <rect key={k} x={p.x} y={p.y} width={p.w} height={p.h} rx="18" fill={PANEL} stroke={k === 2 ? AMBER : GREEN} strokeWidth="1.6" filter="url(#aqglowsoft)" />
        ))}
        <text x={RP.x + 22} y={RP.y + 36} fontSize="20" fontWeight="700" fill={INK}>Research engine</text>
        <text x={RP.x + 22} y={RP.y + 58} fontSize="13.5" fill={GREEN} fontWeight="600">run by Artificial Intelligence</text>
        <text x={RP.x + 22} y={RP.y + 92} fontSize="10.5" fill={MUTE} letterSpacing="1">COLUMNS PULLED FROM THE DATABASE</text>
        <text x={RP.x + 22} y={RP.y + 196} fontSize="10.5" fill={MUTE} letterSpacing="1">CANDIDATE RULES, LONG AND SHORT</text>
        <text x={RP.x + 22} y={RP.y + RP.h - 20} fontSize="13" fill={INK}>proposed <tspan data-n={q("prop")} fontFamily="var(--aq-mono)" fontWeight="700">0</tspan> combinations</text>
        <text x={BP.x + 22} y={BP.y + 36} fontSize="20" fontWeight="700" fill={INK}>Backtesting engine</text>
        <text x={BP.x + 22} y={BP.y + 58} fontSize="13.5" fill={MUTE}>years of history, then a held-out period · fees included</text>
        <text x={BP.x + BP.w - 22} y={BP.y + 36} fontSize="13" textAnchor="end" fill={INK}><tspan data-n={q("tested")} fontFamily="var(--aq-mono)" fontWeight="700">0</tspan> tested</text>
        {[["RULE", 22], ["HISTORY", 92], ["HELD-OUT", 300], ["RESULT", 440]].map(([t, dx]) => (
          <text key={t} x={BP.x + Number(dx)} y={BP.y + 92} fontSize="10.5" fill={MUTE} letterSpacing="1">{t}</text>
        ))}
        <text x={SP.x + 22} y={SP.y + 36} fontSize="20" fontWeight="700" fill={INK}>Selected</text>
        <text x={SP.x + 22} y={SP.y + 58} fontSize="13" fill={MUTE}>passed every gate</text>
      </g>
      <g data-a={q("pipes")} style={{ opacity: 0 }}>
        <path className="aq-flow" d={`M${DBH.sx + 46},${DBH.y} H${RP.x} M${RP.x + RP.w},330 H${BP.x} M${BP.x + BP.w},330 H${SP.x}`} fill="none" stroke={GREEN} strokeWidth="2.4" strokeDasharray="4 10" />
      </g>
      {COLCHIPS.map((t, k) => {
        const x = RP.x + 22 + (k % 4) * 114, y = RP.y + 104 + Math.floor(k / 4) * 36;
        return (
          <g key={t} data-a={q("cchip")} data-dx={DBH.sx - (x + 53)} data-dy={DBH.y - (y + 13)} style={{ opacity: 0 }}>
            <rect x={x} y={y} width="106" height="26" rx="13" fill="rgba(168,121,26,.10)" stroke={AMBER} />
            <text x={x + 53} y={y + 17} fontSize="11.5" textAnchor="middle" fill="#79550F" fontFamily="var(--aq-mono)">{t}</text>
          </g>
        );
      })}
      {LOGS.map(([t, d], k) => (
        <g key={k} data-a={q("log")} style={{ opacity: 0 }}>
          <text x={RP.x + 22} y={RP.y + 222 + k * 22} fontSize="12" fill={INK} fontFamily="var(--aq-mono)">{t}</text>
          <text x={RP.x + RP.w - 22} y={RP.y + 222 + k * 22} fontSize="11" textAnchor="end" fontWeight="800" fill={DIRC[d]}>{d.toUpperCase()}</text>
        </g>
      ))}
      {LANES.map((l, k) => {
        const y = BP.y + 122 + k * 50;
        return (
          <g key={k} data-a={q("lane")} style={{ opacity: 0 }}>
            <line x1={BP.x + 16} x2={BP.x + BP.w - 16} y1={y + 22} y2={y + 22} stroke={LINE} />
            <text x={BP.x + 22} y={y + 4} fontSize="12" fill={INK} fontFamily="var(--aq-mono)">{l.id}</text>
            <path data-a={q("c1")} d={curve(400 + k, l.d1, BP.x + 92, 190, y, 34)} pathLength={1} fill="none" stroke={l.ok ? GREEN : "#8F9DA3"} strokeWidth="1.8" strokeDasharray="1" strokeDashoffset="1" />
            <line x1={BP.x + 292} x2={BP.x + 292} y1={y - 16} y2={y + 18} stroke={LINE} strokeDasharray="2 3" />
            <path data-a={q("c2")} d={curve(500 + k, l.d2, BP.x + 300, 120, y, 34, 16)} pathLength={1} fill="none" stroke={l.ok ? GREEN : "#8F9DA3"} strokeWidth="1.8" strokeDasharray="1" strokeDashoffset="1" />
            <g data-a={q("badge")} style={{ opacity: 0 }}>
              <Pill x={BP.x + 440} y={y - 13} w={100} h={22} fill={l.ok ? AMBER : "rgba(199,71,71,.12)"} color={l.ok ? DEEP : "#A93232"} text={l.why} size={11} />
            </g>
          </g>
        );
      })}
      {GATES.map((g, k) => {
        const gw = (t: string) => t.length * 5.9 + 26;
        const x = BP.x + 18 + GATES.slice(0, k).reduce((a, t) => a + gw(t) + 6, 0);
        return (
          <g key={g} data-a={q("gate")} style={{ opacity: 0 }}>
            <rect x={x} y={BP.y + BP.h - 46} width={gw(g)} height="26" rx="13" fill="#E3EEEC" stroke="#9FC5BF" />
            <text x={x + 11} y={BP.y + BP.h - 29} fontSize="10.5" fill={INK}>✓ {g}</text>
          </g>
        );
      })}
      </g>
      {(["long", "short"] as const).map((d, k) => {
        const y = SP.y + 86 + k * 150;
        return (
          <g key={d} data-a={q("survm")} data-dx={COLX - (SP.x + 16)} data-dy={COLY(k) - y}>
          <g data-a={q("surv")} style={{ opacity: 0 }}>
            <rect x={SP.x + 16} y={y} width={SP.w - 32} height="128" rx="12" fill={d === "long" ? "#EEF5F3" : "#FBF0F0"} stroke={DIRC[d]} strokeOpacity="0.5" />
            <Pill x={SP.x + 30} y={y + 14} w={66} h={22} fill={DIRC[d]} color="#FFFFFF" text={d.toUpperCase()} size={11} />
            <text x={SP.x + 106} y={y + 30} fontSize="12" fill={MUTE} fontFamily="var(--aq-mono)">{d === "long" ? "#0187" : "#0391"}</text>
            <text x={SP.x + 30} y={y + 60} fontSize="13" fill={INK}>EMA 9 crosses {d === "long" ? "above" : "below"} MA 20</text>
            <text x={SP.x + 30} y={y + 80} fontSize="13" fill={INK}>and RSI 14 {d === "long" ? "< 70" : "> 30"}</text>
            {[0, 1].map((j) => <text key={j} data-n={q(`sck${k}${j}`)} x={SP.x + SP.w - 30} y={y + 60 + j * 20} fontSize="15" fontWeight="800" textAnchor="end"> </text>)}
            <text x={SP.x + 30} y={y + 108} fontSize="12" fill={GREEN} fontFamily="var(--aq-mono)">{d === "long" ? "Sharpe 1.12 · 0.81 unseen" : "Sharpe 0.94 · 0.66 unseen"}</text>
          </g>
          </g>
        );
      })}

      {/* ---------- 08: thesis · trade-only key · Hyperliquid · live candle loop ---------- */}
      <g data-a={q("exec")} style={{ opacity: 0 }}>
        <path d={`M${COLR},${COLY(0) + 64} H${COLR + 50} V200 H140 M${COLR},${COLY(1) + 64} H${COLR + 50} V200 M360,200 H440`} fill="none" stroke={INK} strokeWidth="1.4" strokeDasharray="4 4" />
        <rect x="140" y="120" width="220" height="160" rx="16" fill={PANEL} stroke={GREEN} strokeWidth="1.5" />
        <g transform="translate(250 166)">
          <rect x="-16" y="-4" width="32" height="26" rx="5" fill={GREEN} />
          <path d="M-10,-4 V-12 A10,10 0 0 1 10,-12 V-4" fill="none" stroke={GREEN} strokeWidth="4" />
          <circle cx="0" cy="8" r="3.5" fill="#FFFFFF" />
        </g>
        <text x="250" y="220" fontSize="14" fontWeight="700" textAnchor="middle" fill={INK}>Trade-only API key</text>
        <text x="250" y="242" fontSize="12.5" textAnchor="middle" fill={GREEN}>can trade · cannot withdraw</text>
        <text x="250" y="262" fontSize="11" textAnchor="middle" fill={MUTE}>approved from your wallet</text>
        <rect x="440" y="120" width="170" height="160" rx="16" fill={PANEL} stroke={LINE} strokeWidth="1.5" />
        <image href="/brand/Hyperliquid_Blob_Dark.svg" x="495" y="138" width="60" height="60" />
        <text x="525" y="228" fontSize="15" fontWeight="700" textAnchor="middle" fill={INK}>Hyperliquid</text>
        <text x="525" y="248" fontSize="11.5" textAnchor="middle" fill={MUTE}>orders and stops</text>
        <text x="525" y="263" fontSize="11.5" textAnchor="middle" fill={MUTE}>rest here</text>

        {/* live chart */}
        <rect x="650" y="40" width="680" height="268" rx="14" fill={PANEL} fillOpacity="0.85" stroke={LINE} />
        <text x="666" y="62" fontSize="11" fill={MUTE} letterSpacing="1">LIVE · A NEW CANDLE EVERY HOUR</text>
        <text data-n={q("eclock")} x="1314" y="62" fontSize="12" textAnchor="end" fill={INK} fontFamily="var(--aq-mono)"> </text>
        {TRADES.map((t, k) => (
          <rect key={k} data-n={q(`eb${k}`)} x={XE(t.a)} y="70" width="0" height="228" fill={DIRC[t.dir]} opacity="0.1" />
        ))}
        {SER.slice(E0).map((b, k) => (
          <g key={k} data-n={q(`ec${E0 + k}`)} style={{ opacity: 0 }}><Candle b={b} i={E0 + k} x={XE} y={YE} w={14} /></g>
        ))}
        <path data-n={q("el9")} d={ePath(E9)} pathLength={1} fill="none" stroke={AMBER} strokeWidth="2" strokeDasharray="1" strokeDashoffset="1" />
        <path data-n={q("el20")} d={ePath(M20)} pathLength={1} fill="none" stroke={TEAL} strokeWidth="2" strokeDasharray="1" strokeDashoffset="1" />
        <rect data-n={q("ecur")} x={XE(E0) - 13} y="70" width="26" height="228" rx="5" fill="none" stroke={AMBER} strokeWidth="1.4" />
        <text data-n={q("estate")} x="666" y="340" fontSize="13" fontWeight="700" fill={INK}> </text>
        <text x="666" y="360" fontSize="11.5" fill={MUTE}>conditions are checked on the strategy column at left · an order fires when both turn true</text>

        {EVENTS.map((e, k) => {
          const o = ORD(k);
          const stop = e.dir === "long" ? e.px * 0.97 : e.px * 1.03;
          return (
            <g key={k} data-n={q(`ord${k}`)} style={{ opacity: 0 }}>
              <rect x={o.x} y={o.y} width={o.w} height={o.h} rx="8" fill={PANEL} stroke={LINE} />
              <rect x={o.x} y={o.y} width="5" height={o.h} rx="2.5" fill={DIRC[e.dir]} />
              <text x={o.x + 18} y={o.y + 24} fontSize="17" fontWeight="700" fill={DIRC[e.dir]}>{e.kind} · {e.dir.toUpperCase()} <tspan fontSize="13" fontWeight="500" fill={MUTE}>{HH(e.at)} · automatic</tspan></text>
              <text x={o.x + 18} y={o.y + 46} fontSize="14" fill={INK} fontFamily="var(--aq-mono)">
                {e.kind === "ENTRY" ? `${fmt(e.px)} · stop ${fmt(stop)} on Hyperliquid` : `${fmt(e.px)} · P&L ${tradeLabel(e.t).split(" ")[1]}`}
              </text>
            </g>
          );
        })}
        <g>
          <rect x={ORD(EVENTS.length).x} y={ORD(0).y} width={ORD(0).w} height={ORD(0).h} rx="8" fill={PANEL} stroke={LINE} />
          <rect x={ORD(EVENTS.length).x} y={ORD(0).y} width="5" height={ORD(0).h} rx="2.5" fill={MUTE} />
          <text data-n={q("pos")} x={ORD(EVENTS.length).x + 18} y={ORD(0).y + 24} fontSize="17" fontWeight="700" fill={INK}> </text>
          <text data-n={q("pnl")} x={ORD(EVENTS.length).x + 18} y={ORD(0).y + 46} fontSize="14" fill={INK} fontFamily="var(--aq-mono)"> </text>
        </g>
        <g data-n={q("pkt")} style={{ opacity: 0 }} filter="url(#aqglow)">
          <circle cx="0" cy="0" r="8" fill={AMBER} />
          <circle cx="0" cy="0" r="15" fill={AMBER} opacity="0.2" />
        </g>
      </g>
    </svg>
  );
}

/* ---------------- timeline: 1000 ms = whole story ---------------- */

function build(root: Element, id: string, autoplay: boolean | ReturnType<typeof onScroll>) {
  const $ = (n: string) => Array.from(root.querySelectorAll<SVGElement>(`[data-a="${id}-${n}"]`));
  const n = (k: string) => root.querySelector<SVGElement>(`[data-n="${id}-${k}"]`);
  const T = (k: string, v: string) => { const el = n(k); if (el && el.textContent !== v) el.textContent = v; };
  const O = (el: SVGElement | null | undefined, on: boolean) => { if (el) { const v = on ? "1" : "0"; if (el.style.opacity !== v) el.style.opacity = v; } };
  const A = (el: SVGElement | null | undefined, k: string, v: string) => { if (el && el.getAttribute(k) !== v) el.setAttribute(k, v); };
  const crossEls = SHOWX.map((i) => [i, n(`x${i}`)] as const);
  const scanEl = n("scan");
  const clones = $("clone");
  const cells = TROWS.map((_, r) => SER.map((_, i) => root.querySelector<SVGElement>(`[data-c="${id}-${r}-${i}"]`)));
  const cardVals = CARDS.map((_, k) => n(`cv${k}`));
  const mathEls = CARDS.map((c, k) => c.lines.map((_, j) => n(`ml${k}-${j}`)));
  const eCandles = SER.map((_, i) => n(`ec${i}`));
  const ordEls = EVENTS.map((_, k) => n(`ord${k}`));
  const pkt = n("pkt");
  const shown = TROWS.map(() => -2);
  let lit = -1;
  const fillIdx = (p: number, [a, b]: [number, number]) => (p <= a ? -1 : Math.min(LI, Math.floor(seg(p, a, b) * VIS)));

  const paint = (p: number) => {
    const e = seg(p, 0.04, 0.09);
    const L = (a: number, b: number) => a + (b - a) * e;
    T("op", fmt(LAST.o)); T("hi", fmt(L(LAST.o, LAST.h))); T("lo", fmt(L(LAST.o, LAST.l)));
    T("cl", fmt(L(LAST.o, LAST.c))); T("vo", `${L(0, LAST.v).toFixed(1)}M`); T("bd", `+${fmt(L(0, LAST.c - LAST.o))}`);

    // 03/04 table cells fill left to right behind the scan
    TROWS.forEach((_, r) => {
      const k = fillIdx(p, ROW_WIN(r));
      if (k === shown[r]) return;
      shown[r] = k;
      cells[r].forEach((el, i) => O(el, i <= k));
    });
    const wins = [W3, ...CARDS.map(cardWin)];
    const act = wins.filter(([a, b]) => p > a && p < b + 0.004).pop();
    const at = act ? fillIdx(p, act) : -1;
    O(scanEl, at >= 0);
    if (scanEl && at >= 0) scanEl.style.transform = `translateX(${X(at) - X(0)}px)`;
    if (at !== lit) {
      if (lit >= 0 && clones[lit]) clones[lit].removeAttribute("filter");
      if (at >= 0 && clones[at]) clones[at].setAttribute("filter", "url(#aqglow)");
      lit = at;
    }
    // formula cards: the active term lights up, intermediate values tick with the scan
    CARDS.forEach((c, k) => {
      const w = cardWin(c);
      const i = fillIdx(p, w);
      O(cardVals[k], p >= w[1]);
      T(`lv${k}`, i < 0 ? "waiting for data…" : `${HH(i)} · ${c.live(i)}`);
      const hot = i >= 0 && p < w[1] ? i % c.lines.length : -1;
      mathEls[k].forEach((el, j) => A(el, "fill", j === hot ? TROWS[c.rows[0]].color : INK));
    });
    const m = fillIdx(p, FW[6]);
    crossEls.forEach(([i, el]) => O(el, m >= i));
    T("moren", String(Math.round(seg(p, 0.47, 0.525) * MORE)));
    // 05 facts count up
    const fs = seg(p, 0.578, 0.612);
    FACTS.forEach((f, k) => { if (f.count) T(`fv${k}`, f.count(fs)); });
    // 06-07 engine counters
    T("prop", comma(Math.round(seg(p, 0.672, 0.718) * TESTED)));
    T("tested", comma(Math.round(seg(p, 0.722, 0.8) * TESTED)));

    // 09 live loop: candles arrive one at a time; conditions are checked on each
    const cur = liveCur(p);
    eCandles.forEach((el, i) => O(el, i >= E0 && i <= cur));
    const frac = cur < 0 ? 0 : (cur - E0) / (LI - E0);
    A(n("el9"), "stroke-dashoffset", String(1 - frac));
    A(n("el20"), "stroke-dashoffset", String(1 - frac));
    const ecur = n("ecur");
    if (ecur) ecur.style.transform = `translateX(${cur < 0 ? 0 : XE(cur) - XE(E0)}px)`;
    TRADES.forEach((t, k) => A(n(`eb${k}`), "width", String(cur >= t.a ? Math.max(0, XE(Math.min(cur, t.b)) - XE(t.a)) : 0)));
    if (cur >= 0) {
      const ok = (b: boolean) => (b ? "✓" : "✗");
      T("eclock", `${HH(cur)} · close ${fmt(SER[cur].c)}`);
      const conds = [[E9[cur] > M20[cur], RSI[cur] < 70], [E9[cur] < M20[cur], RSI[cur] > 30]];
      conds.forEach((cs, k) => cs.forEach((v, j) => { T(`sck${k}${j}`, ok(v)); A(n(`sck${k}${j}`), "fill", v ? GREEN : RED); }));
      T("cond00", `EMA 9 > MA 20  ${ok(E9[cur] > M20[cur])}`);
      T("cond01", `RSI 14 < 70  ${ok(RSI[cur] < 70)}`);
      T("cond10", `EMA 9 < MA 20  ${ok(E9[cur] < M20[cur])}`);
      T("cond11", `RSI 14 > 30  ${ok(RSI[cur] > 30)}`);
      const open = TRADES.find((t) => cur >= t.a && (t.open || cur < t.b));
      const done = [...TRADES].reverse().find((t) => !t.open && cur >= t.b);
      if (open) {
        const pnl = ((SER[cur].c - SER[open.a].c) / SER[open.a].c) * 100 * (open.dir === "long" ? 1 : -1);
        T("estate", `IN POSITION · ${open.dir.toUpperCase()}`);
        T("pos", `POSITION · ${open.dir} since ${HH(open.a)}`);
        T("pnl", `entry ${fmt(SER[open.a].c)} · now ${fmt(SER[cur].c)} · ${sgn(pnl, 2)}%`);
        A(n("estate"), "fill", DIRC[open.dir]);
      } else {
        T("estate", "FLAT · CHECKING");
        T("pos", "POSITION · flat");
        T("pnl", done ? `last trade ${tradeLabel(done)}` : "waiting for both conditions");
        A(n("estate"), "fill", INK);
      }
    }
    if (cur < 0) [0, 1].forEach((k) => [0, 1].forEach((j) => T(`sck${k}${j}`, " ")));
    ordEls.forEach((el, k) => O(el, cur >= EVENTS[k].at));
    // the signal pulse: thesis -> key -> Hyperliquid, right after each event candle arrives
    const ev = EVENTS.find((e) => p >= pAt(e.at) && p < pAt(e.at) + 0.008);
    O(pkt, !!ev);
    if (pkt && ev) {
      const f = seg(p, pAt(ev.at), pAt(ev.at) + 0.008) * (PKT.length - 1);
      const s = Math.min(PKT.length - 2, Math.floor(f)), u = f - s;
      pkt.style.transform = `translate(${PKT[s][0] + (PKT[s + 1][0] - PKT[s][0]) * u}px, ${PKT[s][1] + (PKT[s + 1][1] - PKT[s][1]) * u}px)`;
    }
  };

  // composition "none": every tween keeps its own keyframes, so seeking backwards restores exact values
  const tl = createTimeline({ autoplay, defaults: { ease: "outQuart", composition: "none" }, onUpdate: (self) => paint(self.progress) });
  tl.add({ v: 0 }, { v: 1, duration: 1000 }, 0);

  // 01 Anatomy: push in, then explode along the axis
  tl.add($("big"), { scale: [1, 1.06], duration: 40 }, 0)
    .add($("hw"), { translateY: [0, -45], duration: 45 }, 35)
    .add($("lw"), { translateY: [0, 45], duration: 45 }, 35)
    .add($("ot"), { translateX: [0, -90], duration: 45 }, 40)
    .add($("ct"), { translateX: [0, 90], duration: 45 }, 40)
    .add($("vol"), { opacity: [0, 1], translateY: [-150, 0], duration: 45 }, 45)
    .add($("lbl"), { opacity: [0, 1], duration: 20, delay: st(5) }, 70);
  // 02 Series: reassemble, charge, BLAST into scattered shards; the shards hang, then fly into place
  // on both sides and each one becomes a candle (nearest the centre first, the newest slot last).
  const land = (_el: unknown, i?: number) => (TARGETS[i ?? 0]?.order ?? 0) * 0.9;
  const T_ = (i?: number) => TARGETS[i ?? 0];
  const D_ = (i?: number) => DEBRIS[i ?? 0];
  tl.add($("lbl"), { opacity: [1, 0], duration: 15 }, 125)
    .add($("hw"), { translateY: [-45, 0], duration: 30 }, 132)
    .add($("lw"), { translateY: [45, 0], duration: 30 }, 132)
    .add($("ot"), { translateX: [-90, 0], duration: 30 }, 132)
    .add($("ct"), { translateX: [90, 0], duration: 30 }, 132)
    .add($("vol"), { opacity: [1, 0], translateY: [0, -150], duration: 25 }, 132)
    .add($("big"), { scale: [1.06, 1.14], duration: 7, ease: "inQuad" }, 162)          // charge
    .add($("big"), { opacity: [1, 0], duration: 3, ease: "linear" }, 169)               // blast
    .add($("big"), { scaleX: [1, 18 / 90 / 1.14], scaleY: [1, SMALL_S / 1.14], translateX: [0, TO_SLOT.x], translateY: [0, TO_SLOT.y], duration: 1 }, 173)
    .add($("shard"), {
      opacity: [0, 1],
      translateX: (_e: unknown, i?: number) => [T_(i).x0, T_(i).sx],
      translateY: (_e: unknown, i?: number) => [T_(i).y0, T_(i).sy],
      rotate: (_e: unknown, i?: number) => [0, T_(i).rot],
      duration: 26, ease: "outExpo",
    }, 169)
    .add($("debris"), {
      opacity: [0, 1],
      translateX: (_e: unknown, i?: number) => [D_(i).x0, D_(i).sx],
      translateY: (_e: unknown, i?: number) => [D_(i).y0, D_(i).sy],
      rotate: (_e: unknown, i?: number) => [0, D_(i).rot],
      duration: 26, ease: "outExpo",
    }, 169)
    .add($("debris"), { opacity: [1, 0], scale: [1, 0.3], duration: 22 }, 197)
    .add($("shard"), {
      translateX: (_e: unknown, i?: number) => [T_(i).sx, T_(i).tx!],
      translateY: (_e: unknown, i?: number) => [T_(i).sy, T_(i).ty!],
      rotate: (_e: unknown, i?: number) => [T_(i).rot, 0],
      scaleX: [1, 18 / SHARD_W],
      scaleY: (_e: unknown, i?: number) => [1, T_(i).th! / SHARD_H],
      duration: 26, ease: "inOutCubic", delay: land,
    }, 198)
    .add($("shard"), { opacity: [1, 0], duration: 5, delay: land }, 224)
    .add($("clone"), { opacity: [0, 1], duration: 5, delay: land }, 223)
    .add($("big"), { opacity: [0, 1], duration: 5 }, 223 + (TARGETS[LI]?.order ?? 0) * 0.9)
    .add($("grid"), { opacity: [0, 1], duration: 25 }, 215);
  // 03 Data: the OHLCV rows open above the chart; values fill behind the scan (painted from progress)
  tl.add([0, 1, 2, 3, 4].flatMap((r) => $(`tl${r}`)), { opacity: [0, 1], translateX: [-14, 0], duration: 12, delay: st(3) }, 254);
  // 04 Formulas: two waves of three cards through the same slots; each wires up and writes its rows
  CARDS.forEach((c, k) => {
    const t0 = k < 3 ? 372 + k * 5 : 456 + (k - 3) * 5;
    tl.add($(`card${k}`), { opacity: [0, 1], translateX: [c.from[0], 0], translateY: [c.from[1], 0], rotate: [c.from[2], 0], duration: 20, ease: "outExpo" }, t0)
      .add($(`wire${k}`), { strokeDashoffset: [1, 0], duration: 10 }, t0 + 10)
      .add($(`rdot${k}`), { opacity: [0, 1], duration: 6 }, t0 + 16);
    c.rows.forEach((r) => tl.add($(`tl${r}`), { opacity: [0, 1], translateX: [-14, 0], duration: 8 }, FW[r][0] * 1000 - 5));
  });
  tl.add([0, 1, 2].flatMap((k) => $(`cw${k}`)), { opacity: [1, 0], translateY: [0, -16], duration: 8 }, 451);
  tl.add($("l9"), { strokeDashoffset: [1, 0], duration: (FW[5][1] - FW[5][0]) * 1000, ease: "linear" }, FW[5][0] * 1000)
    .add($("l20"), { strokeDashoffset: [1, 0], duration: (FW[6][1] - FW[6][0]) * 1000, ease: "linear" }, FW[6][0] * 1000)
    .add($("amb"), { opacity: [0, 1], duration: 12 }, 440)
    .add($("more"), { opacity: [0, 1], translateY: [6, 0], duration: 10 }, 468);
  // 05 Database: the chart shatters into slivers that stream into a growing database; facts count up
  const sl = (i?: number) => SLIVERS[i ?? 0];
  tl.add([3, 4, 5].flatMap((k) => $(`cw${k}`)).concat($("more")), { opacity: [1, 0], duration: 8 }, 530)
    .add($("sliver"), { opacity: [0, 1], duration: 3 }, 534)
    .add($("chart"), { opacity: [1, 0], duration: 6 }, 535)
    .add($("sliver"), {
      translateX: (_e: unknown, i?: number) => [0, sl(i).bx], translateY: (_e: unknown, i?: number) => [0, sl(i).by],
      rotate: (_e: unknown, i?: number) => [0, sl(i).rot * 0.3], duration: 10, ease: "outExpo",
    }, 536)
    .add($("sliver"), {
      translateX: (_e: unknown, i?: number) => [sl(i).bx, sl(i).tx - sl(i).x],
      translateY: (_e: unknown, i?: number) => [sl(i).by, sl(i).ty - sl(i).y],
      rotate: (_e: unknown, i?: number) => [sl(i).rot * 0.3, sl(i).rot],
      scale: [1, 0.02], duration: 22, ease: "inCubic", delay: (_e: unknown, i?: number) => sl(i).d,
    }, 546)
    .add($("db"), { opacity: [0, 1], duration: 8 }, 538)
    .add($("db"), { scale: [0.6, DBH.big], duration: 62, ease: "inOutQuad" }, 538)
    .add($("fact"), { opacity: [0, 1], scale: [0.9, 1], duration: 10, delay: st(4) }, 572);
  // 06 Research: the facts BLAST; their fragments assemble the engines; columns flow in, rules appear
  const fr = (i?: number) => FRAGS[i ?? 0];
  tl.add($("factw"), { opacity: [1, 0], scale: [1, 1.06], duration: 4 }, 621)
    .add($("frag"), {
      opacity: [0, 1],
      translateX: (_e: unknown, i?: number) => [fr(i).x0, fr(i).bx], translateY: (_e: unknown, i?: number) => [fr(i).y0, fr(i).by],
      rotate: (_e: unknown, i?: number) => [0, fr(i).rot], duration: 14, ease: "outExpo",
    }, 621)
    .add($("frag"), {
      translateX: (_e: unknown, i?: number) => [fr(i).bx, fr(i).tx], translateY: (_e: unknown, i?: number) => [fr(i).by, fr(i).ty],
      rotate: (_e: unknown, i?: number) => [fr(i).rot, fr(i).vert ? 90 : 0], duration: 20, ease: "inOutCubic", delay: (_e: unknown, i?: number) => fr(i).d,
    }, 636)
    .add($("fragw"), { opacity: [1, 0], duration: 8 }, 662)
    .add($("dbm"), { scale: [1, DBH.small / DBH.big], translateX: [0, DBH.sx - DBH.x], duration: 22, ease: "inOutQuad" }, 624)
    .add($("panel"), { opacity: [0, 1], duration: 10 }, 656)
    .add($("pipes"), { opacity: [0, 1], duration: 8 }, 664)
    .add($("cchip"), {
      opacity: [0, 1],
      translateX: (el: unknown) => [Number((el as Element).getAttribute("data-dx")), 0],
      translateY: (el: unknown) => [Number((el as Element).getAttribute("data-dy")), 0],
      duration: 16, delay: st(2), ease: "outExpo",
    }, 668)
    .add($("log"), { opacity: [0, 1], translateX: [-8, 0], duration: 6, delay: st(3) }, 684);
  // 07 Validate: each candidate races over history, then the held-out period; most fail
  tl.add($("gate"), { opacity: [0, 1], duration: 8, delay: st(3) }, 722)
    .add($("lane"), { opacity: [0, 1], duration: 6, delay: st(4) }, 722)
    .add($("c1"), { strokeDashoffset: [1, 0], duration: 18, delay: st(6), ease: "linear" }, 728)
    .add($("c2"), { strokeDashoffset: [1, 0], duration: 14, delay: st(6), ease: "linear" }, 748)
    .add($("badge"), { opacity: [0, 1], scale: [0.8, 1], duration: 6, delay: st(6) }, 764)
    .add($("surv"), { opacity: [0, 1], translateX: [-20, 0], duration: 12, delay: st(8) }, 796);
  // 08 Execute: the engines clear; the two selected rules slide left and become the strategy card;
  // key and exchange centre, live candle loop right (painted from progress)
  tl.add([...$("eng"), ...$("dbf")], { opacity: [1, 0], duration: 10 }, 824)
    .add($("survm"), {
      translateX: (el: unknown) => [0, Number((el as Element).getAttribute("data-dx"))],
      translateY: (el: unknown) => [0, Number((el as Element).getAttribute("data-dy"))],
      duration: 24, ease: "inOutCubic",
    }, 826)
    .add($("exec"), { opacity: [0, 1], duration: 10 }, 838);

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
      setS(fitHeight ? Math.min(width / VB.w, height / VB.h) : width / VB.w);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [fitHeight]);
  return (
    <div ref={box} className={fitHeight ? "relative h-full w-full" : "relative w-full"} style={fitHeight ? undefined : { aspectRatio: `${VB.w} / ${VB.h}` }}>
      <div ref={rootRef} className="absolute left-1/2 top-1/2" style={{ width: VB.w, height: VB.h, transform: `translate(-50%,-50%) scale(${s})` }}>
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
      // development only: lets a test script seek the same page backwards and forwards
      (window as unknown as { __aqSeek?: (v: number) => void }).__aqSeek = (v: number) => { tl.seek(clamp(v) * 1000); };
      tl.seek(clamp(parseFloat(debug)) * 1000);
      window.scrollTo(0, section.current.getBoundingClientRect().top + window.scrollY);
    }
    return () => {
      tl.revert();
    };
  }, []);

  const n = STEPS.length;
  const active = PHASES.reduce((current, start, i) => (p * 1000 >= start ? i : current), 0);
  const cur = STEPS[active];
  return (
    <section ref={section} aria-label="How a strategy is made, step by step" className="relative bg-[#F5F7F7]" style={{ height: `${n * 64 + 100}vh` }}>
      <div className="sticky top-16 h-[calc(100vh-4rem)] overflow-hidden">
        {/* minimal rail */}
        <ol className="absolute inset-x-0 top-0 z-10 flex gap-1 px-4 pt-2 sm:px-8" aria-label="Stages">
          {STEPS.map((s, i) => (
            <li key={s.k} className="flex-1" aria-current={i === active ? "step" : undefined}>
              <span className="block h-[2px] overflow-hidden rounded-full bg-[#DDE5E7]">
                <span className="block h-full bg-[#1E6B62]" style={{ width: `${seg(p * 1000, PHASES[i], PHASES[i + 1] ?? 1000) * 100}%` }} />
              </span>
              <span className={`mt-1.5 block font-[family-name:var(--aq-mono)] text-[11px] tracking-wide transition-colors duration-300 ${i === active ? "text-[#0C1A26]" : "text-[#8A98A1]"}`}>
                {s.k} {s.name}
              </span>
            </li>
          ))}
        </ol>
        {/* stage */}
        <div className="absolute inset-x-0 bottom-1 top-[48px] px-2 sm:px-4">
          <Scaled id="pin" fitHeight rootRef={root} />
        </div>
        <p className="sr-only" aria-live="polite">{cur.title}</p>
      </div>
    </section>
  );
}

/* ---------------- static, stepped (mobile) ---------------- */

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
        {s.k === "08" && <p className="mt-4 rounded-2xl bg-[#E3EEEC] p-5 font-[family-name:var(--aq-serif)] text-[1.15rem] leading-snug text-[#0C1A26]">{RULE}</p>}
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
    <div className="mx-auto max-w-[1240px] px-4 py-16 sm:px-8">
      <ol className="mt-14">
        {STEPS.map((s, i) => <StaticStep key={s.k} i={i} />)}
      </ol>
    </div>
  );
}
