// Indicator engine (TypeScript). Produces the snapshot-table columns with the same names and the
// same formulas as the Python engine (engine/aether/indicators.py -> aether/ta/engine.py), so a row
// written here is interchangeable with one written by the research ingest.
//
// Conventions reproduced exactly, because they decide the numbers:
//   * pandas ewm(adjust=False) semantics, including how leading/embedded NaN are handled (ewm());
//   * "SMA-seeded" EMA / RMA of the reference TA library (emaSeeded(), rmaSeeded());
//   * non_zero_range(): if ANY difference in the series is 0, epsilon is added to every element;
//   * causal outputs only: price_change is the backward % change, dpo_value = close[i-11] - SMA20[i].
//
// A handful of engine columns come from the Hilbert-transform family (ht_trendline_value,
// ht_trendmode_value, ht_dcphase_value, ht_sine_*). They are not computed here; the parity tests
// list exactly which columns are, and ingest writes only those (EDGE_COLUMNS).

export type Series = Float64Array;
const EPS = 2.220446049250313e-16;

export interface Ohlcv {
  timestamp: number[];
  open: number[];
  high: number[];
  low: number[];
  close: number[];
  volume: number[];
}

const nan = (n: number) => new Float64Array(n).fill(NaN);
const isn = (x: number) => x !== x;

function from(a: ArrayLike<number>): Series {
  return Float64Array.from(a as ArrayLike<number>, (v) => (v === null || v === undefined ? NaN : Number(v)));
}
function zip(a: Series, b: Series, f: (x: number, y: number) => number): Series {
  const o = new Float64Array(a.length);
  for (let i = 0; i < a.length; i++) o[i] = f(a[i], b[i]);
  return o;
}
function mapS(a: Series, f: (x: number, i: number) => number): Series {
  const o = new Float64Array(a.length);
  for (let i = 0; i < a.length; i++) o[i] = f(a[i], i);
  return o;
}
const add = (a: Series, b: Series) => zip(a, b, (x, y) => x + y);
const sub = (a: Series, b: Series) => zip(a, b, (x, y) => x - y);
const mul = (a: Series, b: Series) => zip(a, b, (x, y) => x * y);
const div = (a: Series, b: Series) => zip(a, b, (x, y) => x / y);
const scale = (a: Series, k: number) => mapS(a, (x) => x * k);

export function shift(a: Series, k: number): Series {
  const n = a.length;
  const o = nan(n);
  if (k >= 0) for (let i = k; i < n; i++) o[i] = a[i - k];
  else for (let i = 0; i < n + k; i++) o[i] = a[i - k];
  return o;
}
const diff = (a: Series, k = 1) => sub(a, shift(a, k));

function nonZeroRange(a: Series, b: Series): Series {
  const d = sub(a, b);
  if (d.some((x) => x === 0)) for (let i = 0; i < d.length; i++) d[i] += EPS;
  return d;
}

// pandas Series.rolling(w, min_periods).<agg>() -- NaN values are skipped, a window needs
// at least min_periods non-NaN values.
function rolling(a: Series, w: number, minp: number, agg: (vals: number[]) => number): Series {
  const n = a.length;
  const o = nan(n);
  for (let i = 0; i < n; i++) {
    const vals: number[] = [];
    for (let j = Math.max(0, i - w + 1); j <= i; j++) if (!isn(a[j])) vals.push(a[j]);
    if (vals.length >= minp && vals.length > 0) o[i] = agg(vals);
  }
  return o;
}
// Fast exact rolling sum/mean for the common full-window case (no NaN inside the window).
export function rollSum(a: Series, w: number, minp = w): Series {
  return rolling(a, w, minp, (v) => {
    let s = 0;
    for (const x of v) s += x;
    return s;
  });
}
export const sma = (a: Series, w: number, minp = w) => rolling(a, w, minp, (v) => v.reduce((s, x) => s + x, 0) / v.length);
const rmax = (a: Series, w: number, minp = w) => rolling(a, w, minp, (v) => Math.max(...v));
const rmin = (a: Series, w: number, minp = w) => rolling(a, w, minp, (v) => Math.min(...v));
function rstd(a: Series, w: number, ddof: number, minp = w): Series {
  return rolling(a, w, minp, (v) => {
    if (v.length - ddof <= 0) return NaN;
    const m = v.reduce((s, x) => s + x, 0) / v.length;
    return Math.sqrt(v.reduce((s, x) => s + (x - m) ** 2, 0) / (v.length - ddof));
  });
}

/** pandas ewm(alpha, adjust=False, ignore_na=False, min_periods).mean() */
export function ewm(a: Series, alpha: number, minPeriods = 0): Series {
  const n = a.length;
  const o = nan(n);
  if (!n) return o;
  let weighted = a[0];
  let nobs = isn(weighted) ? 0 : 1;
  o[0] = nobs >= Math.max(minPeriods, 1) ? weighted : NaN;
  let oldWt = 1;
  for (let i = 1; i < n; i++) {
    const cur = a[i];
    const obs = !isn(cur);
    if (obs) nobs++;
    if (!isn(weighted)) {
      oldWt *= 1 - alpha;
      if (obs) {
        if (weighted !== cur) weighted = (oldWt * weighted + alpha * cur) / (oldWt + alpha);
        oldWt = 1;
      }
    } else if (obs) {
      weighted = cur;
    }
    o[i] = nobs >= Math.max(minPeriods, 1) ? weighted : NaN;
  }
  return o;
}
export const emaPlain = (a: Series, span: number, minp = 0) => ewm(a, 2 / (span + 1), minp);
export const rmaPlain = (a: Series, n: number, minp = 0) => ewm(a, 1 / n, minp);

/** Reference-library EMA: SMA of the first `length` valid values as the seed. */
export function emaSeeded(a: Series, length: number): Series {
  const c = Float64Array.from(a);
  const fv = c.findIndex((x) => !isn(x));
  if (fv >= 0) {
    let s = 0, k = 0;
    for (let j = fv; j < Math.min(c.length, fv + length); j++) if (!isn(c[j])) { s += c[j]; k++; }
    const seed = k ? s / k : NaN;
    for (let j = 0; j < Math.min(c.length, fv + length - 1); j++) c[j] = NaN;
    if (fv + length - 1 < c.length) c[fv + length - 1] = seed;
  }
  return ewm(c, 2 / (length + 1));
}

/** Reference-library RMA: mean of the first `length` values (NaN skipped) as the seed. */
export function rmaSeeded(a: Series, length: number): Series {
  const c = Float64Array.from(a);
  let s = 0, k = 0;
  for (let j = 0; j < Math.min(c.length, length); j++) if (!isn(c[j])) { s += c[j]; k++; }
  for (let j = 0; j < Math.min(c.length, length - 1); j++) c[j] = NaN;
  if (length - 1 < c.length) c[length - 1] = k ? s / k : NaN;
  return ewm(c, 1 / length);
}

function wma(a: Series, length: number): Series {
  const n = a.length;
  const o = nan(n);
  const tw = 0.5 * length * (length + 1);
  for (let i = length - 1; i < n; i++) {
    let s = 0;
    let bad = false;
    for (let k = 0; k < length; k++) {
      const v = a[i - length + 1 + k];
      if (isn(v)) { bad = true; break; }
      s += v * (k + 1);
    }
    o[i] = bad ? NaN : s / tw;
  }
  return o;
}

function trueRange(h: Series, l: Series, c: Series): Series {
  const hl = nonZeroRange(h, l);
  const pc = shift(c, 1);
  const o = new Float64Array(h.length);
  for (let i = 0; i < h.length; i++) {
    const a = Math.abs(hl[i]), b = Math.abs(h[i] - pc[i]), d = Math.abs(pc[i] - l[i]);
    // pandas max(axis=1) skips NaN
    const vals = [a, b, d].filter((x) => !isn(x));
    o[i] = vals.length ? Math.max(...vals) : NaN;
  }
  if (o.length) o[0] = NaN;
  return o;
}

function rsiSeries(c: Series, length: number): Series {
  const d = diff(c);
  const pos = mapS(d, (x) => (x > 0 ? x : isn(x) ? NaN : 0));
  const neg = mapS(d, (x) => (x < 0 ? x : isn(x) ? NaN : 0));
  const pa = rmaSeeded(pos, length), na = rmaSeeded(neg, length);
  return zip(pa, na, (p, q) => 100 * p / (p + Math.abs(q)));
}

function rollingArgIdx(a: Series, w: number, max: boolean): Series {
  // periods since the most recent extreme within the last w values (argmax of the reversed window)
  const n = a.length;
  const o = nan(n);
  for (let i = w - 1; i < n; i++) {
    let best = NaN, bestK = -1, bad = false;
    for (let k = 0; k < w; k++) {
      const v = a[i - k];
      if (isn(v)) { bad = true; break; }
      if (bestK < 0 || (max ? v > best : v < best)) { best = v; bestK = k; }
    }
    o[i] = bad ? NaN : bestK;
  }
  return o;
}

function swma4(a: Series): Series {
  const w = [1 / 6, 2 / 6, 2 / 6, 1 / 6];
  const o = nan(a.length);
  for (let i = 3; i < a.length; i++) {
    let s = 0;
    for (let k = 0; k < 4; k++) s += w[k] * a[i - 3 + k];
    o[i] = s;
  }
  return o;
}

const TF_HOURS: Record<string, number> = { "1h": 1, "4h": 4 };

/** OHLCV -> { column: values } for every engine column this runtime computes. */
export function computeIndicators(bars: Ohlcv, timeframe = "1h"): Record<string, Series> {
  const n = bars.close.length;
  const o = from(bars.open), h = from(bars.high), l = from(bars.low), c = from(bars.close), v = from(bars.volume);
  const out: Record<string, Series> = {};
  out.price_value = c;
  out.price_change = mapS(c, (x, i) => (i ? 100 * (x / c[i - 1] - 1) : NaN));

  // ---- momentum
  const rsi = rsiSeries(c, 14);
  out.rsi_value = rsi;
  {
    const ll = rmin(l, 5), hh = rmax(h, 5);
    const st = div(scale(sub(c, ll), 100), nonZeroRange(hh, ll));
    out.stoch_K = sma(st, 3);
    out.stoch_D = sma(out.stoch_K, 3);
    out.stochf_FastK = st;
    out.stochf_FastD = sma(st, 3);
  }
  {
    const lr = rmin(rsi, 14), hr = rmax(rsi, 14);
    const st = div(scale(sub(rsi, lr), 100), nonZeroRange(hr, lr));
    out.stochrsi_FastK = sma(st, 5);
    out.stochrsi_FastD = sma(out.stochrsi_FastK, 3);
  }
  {
    const tp = mapS(c, (x, i) => (h[i] + l[i] + x) / 3);
    const m = sma(tp, 14);
    const mad = nan(n);
    for (let i = 13; i < n; i++) {
      let s = 0;
      for (let j = i - 13; j <= i; j++) s += tp[j];
      const mu = s / 14;
      let d = 0;
      for (let j = i - 13; j <= i; j++) d += Math.abs(tp[j] - mu);
      mad[i] = d / 14;
    }
    out.cci_value = zip(sub(tp, m), mad, (x, y) => x / (0.015 * y));
  }
  out.mom_value = diff(c, 10);
  out.roc_value = zip(diff(c, 10), shift(c, 10), (x, y) => 100 * x / y);
  {
    const f = sma(c, 12), s = sma(c, 26);
    out.ppo_value = zip(sub(f, s), s, (x, y) => 100 * x / y);
    out.apo_value = sub(f, s);
  }
  {
    const e1 = emaSeeded(c, 30), e2 = emaSeeded(e1, 30), e3 = emaSeeded(e2, 30);
    out.trix_value = mapS(e3, (x, i) => (i ? 100 * (x / e3[i - 1] - 1) : NaN));
  }
  {
    const hh = rmax(h, 14), ll = rmin(l, 14);
    const fk = div(scale(sub(c, ll), 100), nonZeroRange(hh, ll));
    const k = rmaSeeded(fk, 3), d = rmaSeeded(k, 3);
    out.kdj_K = k;
    out.kdj_D = d;
    out.kdj_J = zip(k, d, (x, y) => 3 * x - 2 * y);
  }
  {
    const m = diff(c);
    const p = rollSum(mapS(m, (x) => (isn(x) ? NaN : Math.max(x, 0))), 14);
    const q = rollSum(mapS(m, (x) => (isn(x) ? NaN : Math.abs(Math.min(x, 0)))), 14);
    out.cmo_value = zip(p, q, (x, y) => 100 * (x - y) / (x + y));
  }

  // ---- overlap / trend
  out.ema_value = emaSeeded(c, 20);
  {
    const e1 = emaSeeded(c, 30);
    const fv = e1.findIndex((x) => !isn(x));
    const e2 = nan(n);
    if (fv >= 0) e2.set(emaSeeded(e1.subarray(fv), 30), fv);
    out.dema_value = zip(e1, e2, (x, y) => 2 * x - y);
  }
  out.zlema_value = emaSeeded(sub(scale(c, 2), shift(c, 24)), 50);
  out.hma_value = wma(sub(scale(wma(c, 17), 2), wma(c, 34)), 5);
  {
    const len = 30, fr = 2 / 3, sr = 2 / 31;
    const ad = mapS(nonZeroRange(c, shift(c, len)), Math.abs);
    const pd = mapS(nonZeroRange(c, shift(c, 1)), Math.abs);
    const er = div(ad, rollSum(pd, len));
    const k = nan(n);
    if (n >= len) {
      k[len - 1] = c[len - 1];
      for (let i = len; i < n; i++) {
        const x = er[i] * (fr - sr) + sr;
        const sc = x * x;
        k[i] = sc * c[i] + (1 - sc) * k[i - 1];
      }
    }
    out.kama_value = k;
  }
  {
    const f = sma(c, 12, 1), s = sma(c, 26, 1);
    out.macdext_MACD = sub(f, s);
    out.macdext_MACDSignal = sma(out.macdext_MACD, 9, 1);
    out.macdext_MACDHist = sub(out.macdext_MACD, out.macdext_MACDSignal);
  }
  {
    const atr7 = rmaSeeded(trueRange(h, l, c), 7);
    const hl2 = mapS(h, (x, i) => (x + l[i]) / 2);
    const ub = zip(hl2, atr7, (x, y) => x + 3 * y), lb = zip(hl2, atr7, (x, y) => x - 3 * y);
    const dir = new Float64Array(n).fill(1);
    const trend = new Float64Array(n);
    for (let i = 1; i < n; i++) {
      if (c[i] > ub[i - 1]) dir[i] = 1;
      else if (c[i] < lb[i - 1]) dir[i] = -1;
      else {
        dir[i] = dir[i - 1];
        if (dir[i] > 0 && lb[i] < lb[i - 1]) lb[i] = lb[i - 1];
        if (dir[i] < 0 && ub[i] > ub[i - 1]) ub[i] = ub[i - 1];
      }
      trend[i] = dir[i] > 0 ? lb[i] : ub[i];
    }
    out.supertrend_value = trend;
    out.supertrend_Advice_dir = dir; // turned into 'long'/'short' text by the writer
  }
  {
    // Parabolic SAR (af 0.02, max 0.2), seeded at the first close.
    const up = h[1] - h[0], dn = l[0] - l[1];
    const dmn = dn > up && dn > 0 ? dn : 0;
    let falling = n > 1 ? Math.abs(dmn) >= EPS && dmn > 0 : false;
    let sar = c[0];
    let ep = falling ? (n > 1 ? l[1] : l[0]) : (n > 1 ? h[1] : h[0]);
    let af = 0.02;
    const ps = nan(n);
    for (let i = 1; i < n; i++) {
      let s = sar + af * (ep - sar);
      let rev: boolean;
      if (falling) {
        if (l[i] < ep) { ep = l[i]; af = Math.min(af + 0.02, 0.2); }
        s = Math.max(h[i - 1], h[Math.max(0, i - 2)], s);
        rev = h[i] > s;
      } else {
        if (h[i] > ep) { ep = h[i]; af = Math.min(af + 0.02, 0.2); }
        s = Math.min(l[i - 1], l[Math.max(0, i - 2)], s);
        rev = l[i] < s;
      }
      if (rev) { s = ep; af = 0.02; falling = !falling; ep = falling ? l[i] : h[i]; }
      sar = s;
      ps[i] = sar;
    }
    out.psar_value = ps;
  }
  {
    const up = mapS(rollingArgIdx(h, 15, true), (x) => 100 * (1 - x / 14));
    const dn = mapS(rollingArgIdx(l, 15, false), (x) => 100 * (1 - x / 14));
    out.aroon_AroonUp = up;
    out.aroon_AroonDown = dn;
    out.aroonosc_value = sub(up, dn);
  }
  out.dpo_value = sub(shift(c, 11), sma(c, 20));

  // ---- volatility
  const tr = trueRange(h, l, c);
  const atr14 = rmaSeeded(tr, 14);
  out.atr_value = atr14;
  out.natr_value = zip(emaSeeded(tr, 14), c, (a, x) => (100 / x) * a);
  {
    const mid = sma(c, 20), sd = rstd(c, 20, 0);
    out.bbands_MiddleBand = mid;
    out.bbands_UpperBand = zip(mid, sd, (m, s) => m + 2 * s);
    out.bbands_LowerBand = zip(mid, sd, (m, s) => m - 2 * s);
    out.bbw_value = zip(nonZeroRange(out.bbands_UpperBand, out.bbands_LowerBand), mid, (r, m) => 100 * r / m);
    out.bbw_upperBand = out.bbands_UpperBand;
    out.bbw_lowerBand = out.bbands_LowerBand;
    out.bbw_middleBand = mid;
  }
  {
    const r = div(scale(nonZeroRange(h, l), 4), add(h, l));
    out.accbands_LowerBand = sma(zip(l, r, (x, y) => x * (1 - y)), 20);
    out.accbands_MiddleBand = sma(c, 20);
    out.accbands_UpperBand = sma(zip(h, r, (x, y) => x * (1 + y)), 20);
  }
  {
    const atr1 = rmaSeeded(tr, 1);
    const rng = sub(rmax(h, 14), rmin(l, 14));
    out.chop_value = zip(rollSum(atr1, 14), rng, (s, d) => 100 * (Math.log10(s) - Math.log10(d)) / Math.log10(14));
  }
  {
    const pc = shift(c, 1);
    const maxH = zip(h, pc, (x, y) => (isn(y) ? x : isn(x) ? y : Math.max(x, y)));
    const minL = zip(l, pc, (x, y) => (isn(y) ? x : isn(x) ? y : Math.min(x, y)));
    const bp = sub(c, minL), trr = sub(maxH, minL);
    const avg = (w: number) => div(rollSum(bp, w), rollSum(trr, w));
    const a7 = avg(7), a14 = avg(14), a28 = avg(28);
    out.ultosc_value = mapS(a7, (x, i) => 100 * (4 * x + 2 * a14[i] + a28[i]) / 7);
  }

  // ---- volume
  {
    const ob = new Float64Array(n);
    let acc = 0;
    for (let i = 0; i < n; i++) {
      const s = i === 0 ? 1 : c[i] > c[i - 1] ? 1 : c[i] < c[i - 1] ? -1 : 0;
      acc += s * v[i];
      ob[i] = acc;
    }
    out.obv_value = ob;
  }
  // A/D money-flow multiplier on (2*close - high - low), as the engine calls it (no open).
  const adRaw = mul(zip(c, add(h, l), (x, y) => 2 * x - y), div(v, nonZeroRange(h, l)));
  {
    const ad = new Float64Array(n);
    let acc = 0;
    for (let i = 0; i < n; i++) { acc += adRaw[i]; ad[i] = acc; }
    out.ad_value = ad;
    const fk = 2 / 7, sk = 2 / 17;
    let fe = ad[0], se = ad[0];
    const r = nan(n);
    for (let i = 1; i < n; i++) {
      fe = fk * ad[i] + (1 - fk) * fe;
      se = sk * ad[i] + (1 - sk) * se;
      if (i >= 15) r[i] = fe - se;
    }
    out.adosc_value = r;
  }
  {
    const tp = mapS(c, (x, i) => (h[i] + l[i] + x) / 3);
    const rmf = mul(tp, v);
    const pmf = mapS(rmf, (x, i) => (i && tp[i] - tp[i - 1] > 0 ? x : 0));
    const nmf = mapS(rmf, (x, i) => (i && tp[i] - tp[i - 1] < 0 ? x : 0));
    const ps = rollSum(pmf, 14), ns = rollSum(nmf, 14);
    out.mfi_value = zip(ps, ns, (p, q) => 100 * p / (p + q));
  }
  out.cmf_value = div(rollSum(adRaw, 20), rollSum(v, 20));
  {
    const f = sma(v, 2), s = sma(v, 5);
    out.vosc_value = zip(f, s, (x, y) => 100 * (x - y) / y);
  }
  {
    const hlc3 = mapS(c, (x, i) => (h[i] + l[i] + x) / 3);
    const dm = mapS(h, (x, i) => Math.abs(x - l[i]));
    const trend = mapS(hlc3, (x, i) => (i && x > hlc3[i - 1] ? 1 : -1));
    const cm = new Float64Array(n);
    for (let i = 1; i < n; i++) cm[i] = trend[i] === trend[i - 1] ? cm[i - 1] + dm[i] : dm[i - 1] + dm[i];
    const temp = mapS(cm, (x, i) => (x !== 0 ? Math.abs(2 * (dm[i] / x) - 1) : 2));
    const vf = mapS(v, (x, i) => x * trend[i] * temp[i] * 100);
    out.kvo_value = sub(emaPlain(vf, 55, 55), emaPlain(vf, 89, 89));
  }
  {
    const ratio = mapS(c, (x, i) => {
      const r = h[i] - l[i];
      if (r === 0 || isn(r)) return 0.5;
      const q = (x - l[i]) / r;
      return isn(q) ? 0.5 : Math.min(1, Math.max(0, q));
    });
    out.volumesplit_Total = v;
    out.volumesplit_Buy = mul(ratio, v);
    out.volumesplit_Sell = sub(v, out.volumesplit_Buy);
    out.volumesplit_percentBuy = scale(ratio, 100);
    out.volumesplit_percentSell = mapS(ratio, (x) => (1 - x) * 100);
  }
  {
    const w = new Float64Array(n);
    let acc = 0;
    for (let i = 0; i < n; i++) {
      if (i > 0) {
        const pc = c[i - 1];
        if (c[i] > pc) acc += c[i] - Math.min(l[i], pc);
        else if (c[i] < pc) acc += c[i] - Math.max(h[i], pc);
      }
      w[i] = acc;
    }
    out.wad_value = w;
  }
  {
    const hlr = nonZeroRange(h, l);
    const hl2 = mapS(h, (x, i) => (x + l[i]) / 2);
    const dist = sub(hl2, shift(hl2, 1));
    const box = zip(v, hlr, (x, y) => (x / 10000) / y);
    out.eom_value = sma(div(dist, box), 14);
  }
  {
    const mid = mapS(h, (x, i) => (x + l[i]) / 2);
    const ao1 = sub(sma(mid, 5, 1), sma(mid, 34, 1));
    out.accosc_value = sub(ao1, sma(ao1, 5, 1));
    out.ao_value = sub(sma(mid, 5), sma(mid, 34));
  }
  out.marketfi_value = mapS(h, (x, i) => (x - l[i]) / v[i]);
  {
    const body = mapS(c, (x, i) => Math.abs(x - o[i]));
    const rng = mapS(h, (x, i) => (x - l[i] === 0 ? NaN : x - l[i]));
    out.doji_value = mapS(body, (b, i) => (b <= rng[i] * 0.1 ? 1 : 0));
    out.hangingman_value = mapS(h, (x, i) => (x - Math.max(o[i], c[i]) <= rng[i] * 0.1 ? 1 : 0));
    out.harami_value = mapS(body, (b, i) => (i && b <= body[i - 1] * 0.6 ? 100 : 0));
    out.belthold_value = mapS(body, (b, i) => (b >= rng[i] * 0.8 ? 1 : 0));
    out.closingmarubozu_value = mapS(body, (b, i) => (b >= rng[i] * 0.9 ? 1 : 0));
    out.highwave_value = mapS(body, (b, i) => (rng[i] > b * 3 ? 100 : 0));
    out.spinningtop_value = mapS(body, (b, i) => {
      let q = b / rng[i];
      if (isn(q)) q = 0;
      return q >= 0.2 && q <= 0.4 ? 100 : 0;
    });
  }
  out.bop_value = div(nonZeroRange(c, o), nonZeroRange(h, l));
  {
    const roc = (k: number) => zip(diff(c, k), shift(c, k), (x, y) => 100 * x / y);
    out.coppockcurve_value = wma(add(roc(11), roc(14)), 10);
  }
  {
    const conv = zip(rmax(h, 9, 1), rmin(l, 9, 1), (x, y) => (x + y) / 2);
    const base = zip(rmax(h, 26, 1), rmin(l, 26, 1), (x, y) => (x + y) / 2);
    const sa = zip(conv, base, (x, y) => (x + y) / 2);
    const sb = zip(rmax(h, 52, 1), rmin(l, 52, 1), (x, y) => (x + y) / 2);
    out.ichimoku_conversion = conv;
    out.ichimoku_base = base;
    out.ichimoku_spanA = sa;
    out.ichimoku_spanB = sb;
    out.ichimoku_currentSpanA = shift(sa, 26);
    out.ichimoku_currentSpanB = shift(sb, 26);
    out.ichimoku_laggingSpanA = shift(sa, 51);
    out.ichimoku_laggingSpanB = shift(sb, 51);
  }
  {
    // TD sequential setup counts (consecutive closes above/below the close 4 bars back, capped 13)
    const run = (cond: (i: number) => boolean) => {
      const r = new Float64Array(n);
      let k = 0;
      for (let i = 0; i < n; i++) {
        k = cond(i) ? k + 1 : 0;
        const cnt = Math.min(k, 13);
        r[i] = cnt >= 6 && cnt <= 9 ? cnt : 0; // the reference only reports counts 6..9
      }
      return r;
    };
    const sell = run((i) => i >= 4 && c[i] - c[i - 4] > 0);
    const buy = run((i) => i >= 4 && c[i] - c[i - 4] < 0);
    out.tdsequential_buySetupIndex = buy;
    out.tdsequential_sellSetupIndex = sell;
    out.tdsequential_buyCoundownIndex = new Float64Array(n);
    out.tdsequential_sellCoundownIndex = new Float64Array(n);
    const tb = new Float64Array(n), ts = new Float64Array(n);
    let lastSell = 0;
    for (let i = 0; i < n; i++) {
      const sellDone = sell[i] === 9 && (i === 0 || sell[i - 1] < 9);
      if (sellDone && i >= 8) lastSell = Math.min(...Array.from(l.subarray(i - 8, i + 1)));
      tb[i] = buy[i] > 0 ? Math.max(...Array.from(h.subarray(Math.max(0, i - 56), i + 1))) : 0;
      ts[i] = sell[i] > 0 ? (lastSell !== 0 ? lastSell : Math.min(...Array.from(l.subarray(Math.max(0, i - 8), i + 1)))) : 0;
    }
    out.tdsequential_TDSTBuy = tb;
    out.tdsequential_TDSTSell = ts;
    out.tdsequential_sellSetup = mapS(sell, (x) => (x >= 9 ? 1 : 0));
    out.tdsequential_buySetup = mapS(buy, (x) => (x >= 9 ? 1 : 0));
    for (const k of ["sellSetupPerfection", "buySetupPerfection", "bearishFlip", "bullishFlip", "countdownResetForTDST"]) {
      out[`tdsequential_${k}`] = new Float64Array(n);
    }
    out.tdsequential_countdownIndexIsEqualToPreviousElement = mapS(c, (_x, i) => (i ? 1 : 0));
  }
  {
    const trs = rollSum(tr, 14);
    out.vortex_plus = div(rollSum(mapS(h, (x, i) => (i ? Math.abs(x - l[i - 1]) : NaN)), 14), trs);
    out.vortex_minus = div(rollSum(mapS(l, (x, i) => (i ? Math.abs(x - h[i - 1]) : NaN)), 14), trs);
  }
  {
    const num = rollSum(swma4(nonZeroRange(c, o)), 14);
    const den = rollSum(swma4(nonZeroRange(h, l)), 14);
    const rv = div(num, den);
    out.rvgi_value = rv;
    out.rvgi_signal = sma(rv, 5, 1);
  }
  {
    const hl2 = mapS(h, (x, i) => (x + l[i]) / 2);
    out.williamsalligator_Jaws = shift(rmaPlain(hl2, 13, 13), 8);
    out.williamsalligator_Teeth = shift(rmaPlain(hl2, 8, 8), 5);
    out.williamsalligator_Lips = shift(rmaPlain(hl2, 5, 5), 3);
  }
  {
    const ll = rmin(l, 14), hh = rmax(h, 14);
    out.willr_value = mapS(c, (x, i) => 100 * ((x - ll[i]) / (hh[i] - ll[i]) - 1));
  }
  {
    const len = 13;
    const hl2 = mapS(h, (x, i) => (x + l[i]) / 2);
    const hi = rmax(hl2, len), lo = rmin(hl2, len);
    const rng = mapS(sub(hi, lo), (x) => (x < 0.001 ? 0.001 : x));
    const pos = mapS(hl2, (x, i) => (x - lo[i]) / rng[i] - 0.5);
    const f = nan(n);
    if (n >= len) {
      f[len - 1] = 0;
      let val = 0;
      for (let i = len; i < n; i++) {
        val = 0.66 * pos[i] + 0.67 * val;
        if (val < -0.99) val = -0.999;
        else if (val > 0.99) val = 0.999;
        f[i] = 0.5 * (Math.log((1 + val) / (1 - val)) + f[i - 1]);
      }
    }
    out.fisher_fisher = f;
    out.fisher_fisher_signal = shift(f, 1);
  }
  {
    const p = 5, tpi = 2 * Math.PI;
    const sine = nan(n), lead = nan(n);
    for (let i = p; i < n; i++) {
      let rp = 0, ip = 0;
      for (let j = 0; j < p; j++) {
        rp += c[i - j] * Math.cos(tpi * j / p);
        ip += c[i - j] * Math.sin(tpi * j / p);
      }
      let ph = Math.abs(rp) > 0.001 ? Math.atan(ip / rp) : (tpi / 2) * (ip < 0 ? -1 : 1);
      if (rp < 0) ph += Math.PI;
      ph += Math.PI / 2;
      if (ph < 0) ph += tpi;
      if (ph > tpi) ph -= tpi;
      sine[i] = Math.sin(ph);
      lead[i] = Math.sin(ph + Math.PI / 4);
    }
    out.msw_msw_sine = sine;
    out.msw_msw_lead = lead;
  }
  {
    const up = sub(h, shift(h, 1)), dn = sub(shift(l, 1), l);
    const zero = (x: number) => (Math.abs(x) < EPS ? 0 : x);
    const pos = mapS(up, (u, i) => zero((u > dn[i] && u > 0 ? 1 : 0) * u));
    const neg = mapS(dn, (d, i) => zero((d > up[i] && d > 0 ? 1 : 0) * d));
    const k = mapS(atr14, (a) => 100 / a);
    const dmp = mul(k, rmaSeeded(pos, 14)), dmn = mul(k, rmaSeeded(neg, 14));
    const dx = zip(dmp, dmn, (p, q) => 100 * Math.abs(p - q) / (p + q));
    const adx = rmaSeeded(dx, 14);
    out.dmi_adx = adx;
    out.adx_value = adx;
    out.dmi_plusdi = dmp;
    out.dmi_minusdi = dmn;
    out.plus_di_value = dmp;
    out.minus_di_value = dmn;
    out.adxr_value = zip(adx, shift(adx, 13), (a, b) => (a + b) / 2);
    const rawP = mapS(up, (u, i) => (u > dn[i] && u > 0 ? u : 0));
    const rawM = mapS(dn, (d, i) => (d > up[i] && d > 0 ? d : 0));
    out.plus_dm_value = scale(rmaPlain(rawP, 14, 1), 14);
    out.minus_dm_value = scale(rmaPlain(rawM, 14, 1), 14);
    out.dx_value = zip(dmp, dmn, (p, q) => (p + q === 0 ? NaN : 100 * Math.abs(p - q) / (p + q)));
  }
  {
    out.ht_phasor_InPhase = mapS(c, (x, i) => 0.0962 * x + 0.5769 * at(c, i - 2) - 0.5769 * at(c, i - 4) - 0.0962 * at(c, i - 6));
    out.ht_phasor_Quadrature = mapS(c, (_x, i) => 0.0962 * at(c, i - 1) + 0.5769 * at(c, i - 3) - 0.5769 * at(c, i - 5) - 0.0962 * at(c, i - 7));
    out.ht_dcperiod_value = new Float64Array(n).fill(20);
  }

  // ---- utility
  out.abs_value = mapS(c, Math.abs);
  out.add_value = add(h, l);
  out.mul_value = mul(c, c);
  out.mult_value = mul(h, l);
  out.cos_value = mapS(c, Math.cos);
  out.sin_value = mapS(c, Math.sin);
  out.ceil_value = mapS(c, Math.ceil);
  out.avgprice_value = mapS(c, (x, i) => (o[i] + h[i] + l[i] + x) / 4);
  {
    const hours = TF_HOURS[timeframe];
    const bucketSec = hours ? hours * 3600 : 86400;
    const vw = nan(n);
    let key = NaN, num = 0, den = 0;
    for (let i = 0; i < n; i++) {
      const k = Math.floor(bars.timestamp[i] / bucketSec);
      if (k !== key) { key = k; num = 0; den = 0; }
      num += c[i] * v[i];
      den += v[i];
      vw[i] = den === 0 ? NaN : num / den;
    }
    out.vwap_value = vw;
  }
  out.pd_value = sma(mapS(c, (x, i) => (x > o[i] ? 1 : x < o[i] ? -1 : 0)), 5, 1);
  {
    const lr = mapS(c, (x, i) => {
      if (!i) return 0;
      const r = x / c[i - 1];
      const y = r > 0 ? Math.log(r) : NaN;
      return Number.isFinite(y) ? y : 0;
    });
    const mkt = sma(lr, 30, 2);
    const beta = nan(n);
    for (let i = 0; i < n; i++) {
      const xs: number[] = [], ys: number[] = [];
      for (let j = Math.max(0, i - 29); j <= i; j++) if (!isn(lr[j]) && !isn(mkt[j])) { xs.push(lr[j]); ys.push(mkt[j]); }
      const ms: number[] = [];
      for (let j = Math.max(0, i - 29); j <= i; j++) if (!isn(mkt[j])) ms.push(mkt[j]);
      if (xs.length < 2 || ms.length < 2) continue;
      const mx = xs.reduce((s, x) => s + x, 0) / xs.length, my = ys.reduce((s, x) => s + x, 0) / ys.length;
      let cov = 0;
      for (let k = 0; k < xs.length; k++) cov += (xs[k] - mx) * (ys[k] - my);
      cov /= xs.length - 1;
      const mm = ms.reduce((s, x) => s + x, 0) / ms.length;
      const vr = ms.reduce((s, x) => s + (x - mm) ** 2, 0) / (ms.length - 1);
      beta[i] = vr === 0 ? NaN : cov / vr;
    }
    out.beta_value = beta;
  }
  out.volume_value = v;
  return out;
}

const at = (a: Series, i: number) => (i >= 0 ? a[i] : NaN);

/** Engine columns this runtime computes AND matches the Python engine on (see tests/indicators_test.ts). */
export const EDGE_COLUMNS: string[] = [
  "abs_value", "accbands_LowerBand", "accbands_MiddleBand", "accbands_UpperBand", "accosc_value", "ad_value",
  "add_value", "adosc_value", "adx_value", "adxr_value", "ao_value", "apo_value", "aroon_AroonDown",
  "aroon_AroonUp", "aroonosc_value", "atr_value", "avgprice_value", "bbands_LowerBand", "bbands_MiddleBand",
  "bbands_UpperBand", "bbw_lowerBand", "bbw_middleBand", "bbw_upperBand", "bbw_value", "belthold_value",
  "beta_value", "bop_value", "cci_value", "ceil_value", "chop_value", "closingmarubozu_value", "cmf_value",
  "cmo_value", "coppockcurve_value", "cos_value", "dema_value", "dmi_adx", "dmi_minusdi", "dmi_plusdi",
  "doji_value", "dpo_value", "dx_value", "ema_value", "eom_value", "fisher_fisher", "fisher_fisher_signal",
  "hangingman_value", "harami_value", "highwave_value", "hma_value", "ht_dcperiod_value",
  "ht_phasor_InPhase", "ht_phasor_Quadrature", "ichimoku_base", "ichimoku_conversion",
  "ichimoku_currentSpanA", "ichimoku_currentSpanB", "ichimoku_laggingSpanA", "ichimoku_laggingSpanB",
  "ichimoku_spanA", "ichimoku_spanB", "kama_value", "kdj_D", "kdj_J", "kdj_K", "kvo_value", "macdext_MACD",
  "macdext_MACDHist", "macdext_MACDSignal", "marketfi_value", "mfi_value", "minus_di_value",
  "minus_dm_value", "mom_value", "msw_msw_lead", "msw_msw_sine", "mul_value", "mult_value", "natr_value",
  "obv_value", "pd_value", "plus_di_value", "plus_dm_value", "ppo_value", "psar_value", "roc_value",
  "rsi_value", "rvgi_signal", "rvgi_value", "sin_value", "spinningtop_value", "stoch_D", "stoch_K",
  "stochf_FastD", "stochf_FastK", "stochrsi_FastD", "stochrsi_FastK", "supertrend_value",
  "tdsequential_TDSTBuy", "tdsequential_TDSTSell", "tdsequential_bearishFlip", "tdsequential_bullishFlip",
  "tdsequential_buyCoundownIndex", "tdsequential_buySetup", "tdsequential_buySetupIndex",
  "tdsequential_buySetupPerfection", "tdsequential_countdownIndexIsEqualToPreviousElement",
  "tdsequential_countdownResetForTDST", "tdsequential_sellCoundownIndex", "tdsequential_sellSetup",
  "tdsequential_sellSetupIndex", "tdsequential_sellSetupPerfection", "trix_value", "ultosc_value",
  "volumesplit_Buy", "volumesplit_Sell", "volumesplit_Total", "volumesplit_percentBuy",
  "volumesplit_percentSell", "vortex_minus", "vortex_plus", "vosc_value", "vwap_value", "wad_value",
  "williamsalligator_Jaws", "williamsalligator_Lips", "williamsalligator_Teeth", "willr_value",
  "zlema_value", "price_value", "price_change", "volume_value",
];

/** Text columns derived from computed series (engine conventions). */
export function textColumns(ind: Record<string, Series>): Record<string, string[]> {
  return {
    supertrend_Advice: Array.from(ind.supertrend_Advice_dir, (d) => (d > 0 ? "long" : "short")),
    rvgi_trend: Array.from(ind.rvgi_value, (x) => (x > 0 ? "bullish" : "bearish")),
  };
}
