// Bar-by-bar strategy simulation (TypeScript port of engine/aether/backtest.py simulate()).
// Shared by the signal runner and the backfilled backtests, so the position a follower is put in
// is exactly the position the published backtest would hold.
//
// Conventions (no look-ahead):
//   * rules are evaluated on the CLOSE of bar i; the resulting trade fills at the OPEN of bar i+1;
//   * protective levels are decided on bar i as DISTANCES (% of bar i's close) and applied to the
//     fill price;
//   * stop-loss / take-profit are checked intrabar on bars after entry; when both are touched in
//     one bar the stop fills first (pessimistic);
//   * fees per side on notional (Hyperliquid taker + builder fee by default).
import { compileRule, evaluateRule, extractTpSl, type Frame, type Rule } from "./rules.ts";

export const DEFAULT_FEE = 0.00045 + 0.0003;
export const BARS_PER_YEAR: Record<string, number> = { "5m": 105120, "15m": 35040, "1h": 8760, "4h": 2190, "1d": 365 };
export const TF_SECONDS: Record<string, number> = { "5m": 300, "15m": 900, "1h": 3600, "4h": 14400, "1d": 86400 };
const PERIOD_DAYS: [string, number][] = [["3 Years", 1095], ["2 Years", 730], ["12 Months", 365], ["6 Months", 180],
  ["3 Months", 90], ["1 Month", 30], ["1 Week", 7]];
const ANCHOR_COLUMNS: Record<string, string> = { psar: "psar_value", supertrend: "supertrend_value" };
const EXTRA_KEYS = ["sl_atr_mult", "tp_atr_mult", "atr_col", "sl_anchor", "sl_buffer_atr", "swing_lookback",
  "sl_atr_min", "sl_atr_max", "rr_ratio", "time_limit_hours", "weekend_exit"] as const;

export interface StrategySpec {
  entry_long: string | null;
  exit_long: string | null;
  entry_short: string | null;
  exit_short: string | null;
  direction: string;
  stop_loss_pct: number | null;
  take_profit_pct: number | null;
  leverage: number;
  timeframe: string;
  sl_atr_mult: number | null;
  tp_atr_mult: number | null;
  atr_col: string;
  sl_anchor: string | null;
  sl_buffer_atr: number;
  swing_lookback: number;
  sl_atr_min: number;
  sl_atr_max: number;
  rr_ratio: number;
  time_limit_hours: number | null;
  weekend_exit: boolean;
}

const f = (v: unknown): number | null => (v === null || v === undefined || v === "" ? null : Number(v));

// deno-lint-ignore no-explicit-any
export function specFromRow(row: Record<string, any>): StrategySpec {
  const meta = row.generation_meta || {};
  // deno-lint-ignore no-explicit-any
  const extra: Record<string, any> = { ...(meta.exits || {}) };
  for (const k of EXTRA_KEYS) if (row[k] !== null && row[k] !== undefined) extra[k] = row[k];
  const spec: StrategySpec = {
    entry_long: row.entry_long ?? null, exit_long: row.exit_long ?? null,
    entry_short: row.entry_short ?? null, exit_short: row.exit_short ?? null,
    direction: row.direction || "both",
    stop_loss_pct: f(row.stop_loss_pct), take_profit_pct: f(row.take_profit_pct),
    leverage: Number(row.default_leverage || 1), timeframe: row.timeframe || "1h",
    sl_atr_mult: null, tp_atr_mult: null, atr_col: "atr_value", sl_anchor: null, sl_buffer_atr: 0.25,
    swing_lookback: 10, sl_atr_min: 0.5, sl_atr_max: 6.0, rr_ratio: 2.0, time_limit_hours: null, weekend_exit: false,
  };
  for (const k of EXTRA_KEYS) {
    const v = extra[k];
    if (v === null || v === undefined) continue;
    // deno-lint-ignore no-explicit-any
    const s = spec as any;
    if (k === "weekend_exit") s[k] = Boolean(v);
    else if (k === "atr_col" || k === "sl_anchor") s[k] = v;
    else if (k === "swing_lookback") s[k] = Math.trunc(Number(v));
    else s[k] = Number(v);
  }
  applyTextExits(spec);
  return spec;
}

function applyTextExits(spec: StrategySpec) {
  const text = [spec.exit_long, spec.exit_short].filter((x) => x).join(" ");
  if (!/\b(tp|sl|take profit|stop loss)\b/i.test(text)) return;
  const t = extractTpSl(text);
  if (spec.stop_loss_pct === null && t.sl_pct) spec.stop_loss_pct = t.sl_pct;
  if (spec.take_profit_pct === null && t.tp_pct) spec.take_profit_pct = t.tp_pct;
  if (spec.sl_atr_mult === null && t.sl_atr_mult) { spec.sl_atr_mult = t.sl_atr_mult; spec.atr_col = t.atr_col; }
  if (spec.tp_atr_mult === null && t.tp_atr_mult) { spec.tp_atr_mult = t.tp_atr_mult; spec.atr_col = t.atr_col; }
  if (spec.time_limit_hours === null && t.time_limit_hours) spec.time_limit_hours = t.time_limit_hours;
}

export interface CompiledSpec {
  entry_long: Rule | null;
  exit_long: Rule | null;
  entry_short: Rule | null;
  exit_short: Rule | null;
}

export function compileSpec(spec: StrategySpec, columns?: Iterable<string> | null): CompiledSpec {
  const cols = columns ? [...columns] : null;
  return {
    entry_long: compileRule(spec.entry_long, cols),
    exit_long: compileRule(spec.exit_long, cols, "long"),
    entry_short: compileRule(spec.entry_short, cols),
    exit_short: compileRule(spec.exit_short, cols, "short"),
  };
}

const ET_FMT = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short", hour: "2-digit", hour12: false });
const WD: Record<string, number> = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 };

/** Friday 16:00 ET .. Sunday 18:00 ET (US equity/futures weekend). */
export function inWeekendWindow(tsSec: number): boolean {
  const p: Record<string, string> = {};
  for (const x of ET_FMT.formatToParts(new Date(tsSec * 1000))) p[x.type] = x.value;
  const wd = WD[p.weekday];
  let h = Number(p.hour);
  if (h === 24) h = 0;
  return (wd === 4 && h >= 16) || wd === 5 || (wd === 6 && h < 18);
}

export interface Trade {
  side: string;
  entry_time: number;
  entry_price: number;
  exit_time: number | null;
  exit_price: number | null;
  reason: string;
  pnl_pct: number;
  sl_price: number | null;
  tp_price: number | null;
}

export interface SimResult {
  trades: Trade[];
  position: "long" | "short" | "flat";
  position_reason: string;
  equity: [number, number][];
  sl_pct: number | null;
  tp_pct: number | null;
}

export interface Bars {
  timestamp: number[];
  open: Float64Array;
  high: Float64Array;
  low: Float64Array;
  close: Float64Array;
}

function num(a: ArrayLike<number | null> | undefined, i: number): number {
  if (!a) return NaN;
  const v = a[i];
  return v === null || v === undefined ? NaN : Number(v);
}

export function protectiveDistances(spec: StrategySpec, frame: Frame, i: number, side: string): [number | null, number | null] {
  const c = num(frame.cols.close, i);
  if (!c || c !== c) return [null, null];
  let atr: number | null = null;
  if (spec.atr_col in frame.cols) {
    const a = num(frame.cols[spec.atr_col], i);
    atr = a === a && a > 0 ? a : null;
  }
  const sls: number[] = [];
  const tps: number[] = [];
  if (spec.stop_loss_pct) sls.push(Number(spec.stop_loss_pct));
  if (spec.take_profit_pct) tps.push(Number(spec.take_profit_pct));
  if (atr && spec.sl_atr_mult) sls.push(100 * spec.sl_atr_mult * atr / c);
  if (atr && spec.tp_atr_mult) tps.push(100 * spec.tp_atr_mult * atr / c);
  if (spec.sl_anchor) {
    const long = side === "long";
    const buf = spec.sl_buffer_atr * (atr || 0);
    let raw: number | null = null;
    if (spec.sl_anchor === "swing") {
      const lo = Math.max(0, i - Math.trunc(spec.swing_lookback) + 1);
      let best = NaN;
      const src = long ? frame.cols.low : frame.cols.high;
      for (let j = lo; j <= i; j++) {
        const v = num(src, j);
        if (v !== v) continue;
        if (best !== best || (long ? v < best : v > best)) best = v;
      }
      raw = best; // pandas min/max of an all-NaN window is NaN, which propagates below
    } else {
      const col = ANCHOR_COLUMNS[spec.sl_anchor] ?? spec.sl_anchor;
      if (col in frame.cols) {
        const v = num(frame.cols[col], i);
        raw = v === v ? v : null;
      }
    }
    let dist: number | null = null;
    if (raw !== null) dist = long ? c - (raw - buf) : (raw + buf) - c;
    if (atr) {
      dist = dist === null ? spec.sl_atr_max * atr : dist;
      // Python's builtin min/max keep the first argument when the other is NaN.
      const capped = dist !== dist ? spec.sl_atr_max * atr : Math.min(spec.sl_atr_max * atr, dist);
      dist = Math.max(spec.sl_atr_min * atr, capped);
    }
    if (dist === null || dist <= 0) dist = atr ? spec.sl_atr_max * atr : c * 0.02;
    sls.push(100 * dist / c);
    tps.push(100 * spec.rr_ratio * dist / c);
  }
  return [sls.length ? Math.min(...sls) : null, tps.length ? Math.min(...tps) : null];
}

export function simulate(frame: Frame, spec: StrategySpec, fee = DEFAULT_FEE): SimResult {
  const rules = compileSpec(spec);
  const n = frame.n;
  const cache = new Map<string, Float64Array>();
  const sig: Record<string, Uint8Array> = {};
  for (const k of ["entry_long", "exit_long", "entry_short", "exit_short"] as const) {
    const r = rules[k];
    sig[k] = r === null || r.usesEntryPrice ? new Uint8Array(n) : evaluateRule(r, frame, {}, cache);
  }
  if (spec.direction === "long") sig.entry_short = new Uint8Array(n);
  if (spec.direction === "short") sig.entry_long = new Uint8Array(n);

  const ts = (frame.cols.timestamp as ArrayLike<number>);
  const o = (i: number) => num(frame.cols.open, i);
  const h = (i: number) => num(frame.cols.high, i);
  const l = (i: number) => num(frame.cols.low, i);
  const c = (i: number) => num(frame.cols.close, i);
  const barSec = TF_SECONDS[spec.timeframe] ?? 3600;
  const lev = spec.leverage;
  const tlim = spec.time_limit_hours ? spec.time_limit_hours * 3600 : null;

  const res: SimResult = { trades: [], position: "flat", position_reason: "", equity: [], sl_pct: null, tp_pct: null };
  let equity = 1.0;
  let pos: Trade | null = null;
  let posExit: Uint8Array | null = null;
  let pending: [string, string, [number | null, number | null]] | null = null;

  const close = (t: number, px: number, reason: string) => {
    const p = pos!;
    const dir = p.side === "long" ? 1 : -1;
    const gross = dir * (px / p.entry_price - 1);
    p.pnl_pct = Math.max(-100.0, 100 * (gross * lev - 2 * fee * lev));
    p.exit_time = Math.trunc(t);
    p.exit_price = px;
    p.reason = reason;
    equity *= 1 + p.pnl_pct / 100;
    res.trades.push(p);
    pos = null;
    posExit = null;
  };
  const open = (side: string, i: number, reason: string, dists: [number | null, number | null]) => {
    const px = o(i);
    const [sl, tp] = dists;
    const t: Trade = { side, entry_time: Math.trunc(ts[i]), entry_price: px, exit_time: null, exit_price: null, reason, pnl_pct: 0, sl_price: null, tp_price: null };
    if (sl) t.sl_price = side === "long" ? px * (1 - sl / 100) : px * (1 + sl / 100);
    if (tp) t.tp_price = side === "long" ? px * (1 + tp / 100) : px * (1 - tp / 100);
    pos = t;
    const r = rules[side === "long" ? "exit_long" : "exit_short"];
    posExit = r !== null && r.usesEntryPrice ? evaluateRule(r, frame, { entry_price: px }, cache) : null;
  };

  for (let i = 0; i < n; i++) {
    // 1) fill whatever the previous close decided, at this bar's open
    if (pending !== null && !Number.isNaN(o(i))) {
      const [action, reason, dists] = pending;
      if ((action === "exit" || action === "flip_long" || action === "flip_short") && pos !== null) close(ts[i], o(i), reason);
      if (action === "long" || action === "flip_long") open("long", i, reason, dists);
      else if (action === "short" || action === "flip_short") open("short", i, reason, dists);
      pending = null;
    }
    // 2) intrabar protective exits
    if (pos !== null) {
      const p: Trade = pos;
      const sp = p.sl_price, tpp = p.tp_price;
      if (p.side === "long") {
        if (sp && l(i) <= sp) close(ts[i], Math.min(o(i), sp), "stop_loss");
        else if (tpp && h(i) >= tpp) close(ts[i], Math.max(o(i), tpp), "take_profit");
      } else {
        if (sp && h(i) >= sp) close(ts[i], Math.max(o(i), sp), "stop_loss");
        else if (tpp && l(i) <= tpp) close(ts[i], Math.min(o(i), tpp), "take_profit");
      }
    }
    // 3) weekend: flat at this close, no entries decided in the window
    const weekend = spec.weekend_exit && inWeekendWindow(ts[i] + barSec);
    if (weekend && pos !== null) close(ts[i], c(i), "weekend_exit");

    // 4) evaluate rules on this close -> action for next open
    const entry = (side: string): [string, string, [number | null, number | null]] =>
      [side, `entry_${side}`, protectiveDistances(spec, frame, i, side)];
    if (weekend) {
      // no decisions
    } else if (pos === null) {
      if (sig.entry_long[i]) pending = entry("long");
      else if (sig.entry_short[i]) pending = entry("short");
    } else {
      const p: Trade = pos;
      const key = p.side === "long" ? "exit_long" : "exit_short";
      const pe: Uint8Array | null = posExit;
      const exitNow = sig[key][i] || (pe !== null && pe[i]);
      if (p.side === "long" && sig.entry_short[i]) { const e = entry("short"); pending = ["flip_short", e[1], e[2]]; }
      else if (p.side === "short" && sig.entry_long[i]) { const e = entry("long"); pending = ["flip_long", e[1], e[2]]; }
      else if (exitNow) pending = ["exit", key, [null, null]];
      else if (tlim && ts[i] + barSec - p.entry_time >= tlim) pending = ["exit", "time_limit", [null, null]];
    }

    let mark = equity;
    if (pos !== null) {
      const p: Trade = pos;
      const d = p.side === "long" ? 1 : -1;
      mark = equity * Math.max(0.0, 1 + (d * (c(i) / p.entry_price - 1) - fee) * lev);
    }
    res.equity.push([Math.trunc(ts[i]), mark]);
  }

  // Desired position NOW = the position after acting on the last closed bar's decision.
  const last = pos as Trade | null;
  if (pending !== null) {
    const [action, reason, dists] = pending;
    res.position = ({ long: "long", flip_long: "long", short: "short", flip_short: "short", exit: "flat" } as Record<string, "long" | "short" | "flat">)[action];
    res.position_reason = reason;
    if (res.position !== "flat") [res.sl_pct, res.tp_pct] = dists;
  } else {
    res.position = (last?.side as "long" | "short") ?? "flat";
    res.position_reason = last ? last.reason : "";
    if (last) {
      if (last.sl_price) res.sl_pct = Math.abs(last.sl_price / last.entry_price - 1) * 100;
      if (last.tp_price) res.tp_pct = Math.abs(last.tp_price / last.entry_price - 1) * 100;
    }
  }
  if (last) res.trades.push(last);
  return res;
}

// ---------------------------------------------------------------------------------------------
// Metrics (same definitions as the research backtester)
// ---------------------------------------------------------------------------------------------
const round = (x: number, d: number) => {
  const m = 10 ** d;
  return Math.round(x * m) / m;
};
const mean = (a: number[]) => a.reduce((s, x) => s + x, 0) / a.length;
function std(a: number[], ddof: number) {
  const m = mean(a);
  return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - ddof));
}

export function tradeMetrics(pnlsPct: number[], rf = 0.05): Record<string, number> {
  const p = pnlsPct.map((x) => x / 100);
  if (!p.length) return { compounded_return_pct: 0, simple_return_pct: 0, trade_max_drawdown_pct: 0, trade_sharpe: 0, pf: 0 };
  let cum = 1, peak = 1, mdd = 0;
  let first = true;
  for (const x of p) {
    cum *= 1 + x;
    peak = first ? cum : Math.max(peak, cum);
    first = false;
    mdd = Math.min(mdd, (cum - peak) / peak);
  }
  const pos = p.filter((x) => x > 0).reduce((s, x) => s + x, 0);
  const neg = Math.abs(p.filter((x) => x < 0).reduce((s, x) => s + x, 0));
  let sharpe = 0;
  if (p.length >= 2) {
    const sd = std(p, 1) * Math.sqrt(252);
    if (sd > 1e-9) sharpe = (mean(p) * 252 - rf) / sd;
  }
  return {
    compounded_return_pct: round((cum - 1) * 100, 2),
    simple_return_pct: round(p.reduce((s, x) => s + x, 0) * 100, 2),
    trade_max_drawdown_pct: round(mdd * 100, 2),
    trade_sharpe: round(sharpe, 2),
    pf: round(neg > 0 ? pos / neg : pos > 0 ? 10 : 0, 2),
  };
}

export function metrics(res: { trades: Trade[]; equity: [number, number][] }, timeframe = "1h"): Record<string, number | null> {
  const closed = res.trades.filter((t) => t.exit_time !== null);
  const eq = res.equity.length ? res.equity.map((e) => e[1]) : [1.0];
  const rets = eq.length > 1 ? eq.slice(1).map((e, i) => (e - eq[i]) / eq[i]) : [0];
  let peak = -Infinity, maxDd = 0;
  for (const e of eq) { peak = Math.max(peak, e); maxDd = Math.min(maxDd, (e - peak) / peak); }
  const wins = closed.filter((t) => t.pnl_pct > 0).map((t) => t.pnl_pct);
  const losses = closed.filter((t) => t.pnl_pct <= 0).map((t) => t.pnl_pct);
  const sd = std(rets, 0);
  const sharpe = sd > 0 ? mean(rets) / sd * Math.sqrt(BARS_PER_YEAR[timeframe] ?? 8760) : 0;
  const sumL = losses.reduce((s, x) => s + x, 0);
  const out: Record<string, number | null> = {
    return_pct: round((eq[eq.length - 1] - 1) * 100, 2),
    max_drawdown_pct: round(maxDd * 100, 2),
    sharpe: round(sharpe, 2),
    trades: closed.length,
    win_rate: closed.length ? round(100 * wins.length / closed.length, 1) : 0,
    profit_factor: losses.length && sumL !== 0 ? round(wins.reduce((s, x) => s + x, 0) / Math.abs(sumL), 2) : null,
    avg_trade_pct: closed.length ? round(mean(closed.map((t) => t.pnl_pct)), 3) : 0,
  };
  const tm = tradeMetrics(closed.map((t) => t.pnl_pct));
  delete tm.pf;
  return { ...out, ...tm };
}

export function periodMetrics(res: SimResult, timeframe = "1h"): Record<string, Record<string, number | null>> {
  if (!res.equity.length) return {};
  const t0 = res.equity[0][0], tEnd = res.equity[res.equity.length - 1][0];
  const out: Record<string, Record<string, number | null>> = {};
  for (const [label, days] of PERIOD_DAYS) {
    const start = tEnd - days * 86400;
    if (start < t0) continue;
    const curve = res.equity.filter(([t]) => t >= start);
    const base = curve[0][1] || 1.0;
    out[label] = metrics({ trades: res.trades.filter((t) => t.entry_time >= start), equity: curve.map(([t, e]) => [t, e / base]) }, timeframe);
  }
  return out;
}

export function downsample(curve: [number, number][], points = 300): [number, number][] {
  if (curve.length <= points) return curve.map(([t, e]) => [t, round(e, 5)]);
  const out: [number, number][] = [];
  for (let k = 0; k < points; k++) {
    const i = Math.trunc((k * (curve.length - 1)) / (points - 1));
    out.push([curve[i][0], round(curve[i][1], 5)]);
  }
  return out;
}

export function runBacktest(frame: Frame, spec: StrategySpec, fee = DEFAULT_FEE) {
  const res = simulate(frame, spec, fee);
  const ts = frame.cols.timestamp as ArrayLike<number>;
  return {
    metrics: metrics(res, spec.timeframe),
    periods: periodMetrics(res, spec.timeframe),
    equity_curve: downsample(res.equity),
    trades: res.trades.slice(-500),
    period_start: frame.n ? Number(ts[0]) : null,
    period_end: frame.n ? Number(ts[frame.n - 1]) : null,
    position: res.position,
  };
}
