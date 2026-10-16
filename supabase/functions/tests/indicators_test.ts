// Parity: TypeScript indicators vs the Python engine, on the bars ingest would WRITE
// (index >= WARMUP; the warm-up bars are never stored).
import { computeIndicators, EDGE_COLUMNS } from "../_shared/indicators.ts";
import { loadFixtures } from "./simulate_test.ts";

export const WARMUP = 300;
export const REL_TOL = 1e-6;

// deno-lint-ignore no-explicit-any
function engineFixtures(): { name: string; fx: any }[] {
  const dir = new URL("../../../engine/fixtures/", import.meta.url);
  const out = [];
  try {
    for (const e of Deno.readDirSync(dir)) {
      if (!e.name.endsWith(".json")) continue;
      const raw = JSON.parse(Deno.readTextFileSync(new URL(e.name, dir)));
      const cols: Record<string, (number | null)[]> = {};
      for (const k of [...raw.indicator_columns, "price_value", "price_change"]) cols[k] = raw.indicators.map((r: Record<string, number | null>) => r[k]);
      for (const k of ["open", "high", "low", "close", "volume"]) cols[k] = raw.ohlcv.map((r: Record<string, number>) => r[k]);
      out.push({ name: `engine/${e.name}`, fx: { timeframe: raw.timeframe, timestamp: raw.ohlcv.map((r: { timestamp: number }) => r.timestamp), columns: cols, raw } });
    }
  } catch (_e) { /* engine fixtures absent */ }
  return out;
}
export const ALL_FIXTURES = () => [...loadFixtures(), ...engineFixtures()];

export function columnErrors(fx: { timeframe: string; timestamp: number[]; columns: Record<string, (number | null)[]> }) {
  const bars = {
    timestamp: fx.timestamp, open: fx.columns.open as number[], high: fx.columns.high as number[],
    low: fx.columns.low as number[], close: fx.columns.close as number[], volume: fx.columns.volume as number[],
  };
  const ts = computeIndicators(bars, fx.timeframe);
  const res: Record<string, { maxRel: number; nullMismatch: number; worstAt: number }> = {};
  for (const [col, py] of Object.entries(fx.columns)) {
    const mine = ts[col];
    if (!mine || typeof py.find((x) => x !== null) === "string") continue;
    let maxRel = 0, nullMismatch = 0, worstAt = -1;
    for (let i = WARMUP; i < py.length; i++) {
      const a = mine[i], b = py[i];
      const an = !(a === a) || !Number.isFinite(a), bn = b === null;
      if (an || bn) { if (an !== bn) nullMismatch++; continue; }
      const rel = Math.abs(a - (b as number)) / Math.max(1e-9, Math.abs(b as number), 1e-6 * Math.abs(fx.columns.close[i] as number));
      if (rel > maxRel) { maxRel = rel; worstAt = i; }
    }
    res[col] = { maxRel, nullMismatch, worstAt };
  }
  return res;
}

Deno.test("indicators: per-column parity report", () => {
  const passing = new Map<string, number>();
  const failing: string[] = [];
  const fixtures = ALL_FIXTURES();
  for (const { name, fx } of fixtures) {
    for (const [col, e] of Object.entries(columnErrors(fx))) {
      const ok = e.maxRel <= REL_TOL && e.nullMismatch === 0;
      if (ok) passing.set(col, (passing.get(col) ?? 0) + 1);
      else failing.push(`${name} ${col}: maxRel=${e.maxRel.toExponential(2)} nullMismatch=${e.nullMismatch} at=${e.worstAt}`);
    }
  }
  const all = [...passing].filter(([, k]) => k === fixtures.length).map(([c]) => c).sort();
  console.log(`columns matching on all ${fixtures.length} fixtures (${all.length}):\n${all.join(" ")}`);
  console.log(`mismatches:\n${failing.join("\n")}`);
  if (Deno.env.get("CHECK_EDGE_COLUMNS") !== "0") {
    const missing = EDGE_COLUMNS.filter((c) => !all.includes(c));
    if (missing.length) throw new Error(`EDGE_COLUMNS not at parity: ${missing.join(", ")}`);
  }
});

// Full pipeline: OHLCV -> TS indicators -> TS simulate, against the engine's own golden runs
// (per-bar positions, trades, metrics) and the text columns.
import { assertEquals } from "jsr:@std/assert@1.0.8";
import { computeIndicators as ci, textColumns } from "../_shared/indicators.ts";
import { metrics, simulate, specFromRow } from "../_shared/backtest.ts";

for (const { name, fx } of ALL_FIXTURES()) {
  Deno.test(`pipeline: ${name} text columns + positions on TS indicators`, () => {
    const bars = { timestamp: fx.timestamp, open: fx.columns.open, high: fx.columns.high, low: fx.columns.low, close: fx.columns.close, volume: fx.columns.volume };
    const ind = ci(bars, fx.timeframe);
    const text = textColumns(ind);
    for (const k of ["supertrend_Advice", "rvgi_trend"]) {
      if (fx.columns[k]) assertEquals(text[k].slice(WARMUP), fx.columns[k].slice(WARMUP), k);
    }
    const frame = { n: fx.timestamp.length, cols: { ...fx.columns, ...ind, timestamp: fx.timestamp } };
    if (fx.raw) {
      for (const [rname, r] of Object.entries(fx.raw.rules) as [string, any][]) {
        const spec = specFromRow({ ...r.spec, generation_meta: { exits: r.spec } });
        const fee = r.spec.fee ?? undefined;
        const res = simulate(frame, spec, fee);
        assertEquals(res.trades.map((t) => [t.side, t.entry_time, t.exit_time, t.reason]),
          r.trades.map((t: any) => [t.side, t.entry_time, t.exit_time, t.reason]), `${rname} trades`);
        const m = metrics(res, spec.timeframe);
        assertEquals(m, r.metrics, `${rname} metrics`);
        // per-bar desired position: replay on every prefix
        const sub = (k: number) => ({ n: k, cols: Object.fromEntries(Object.entries(frame.cols).map(([c, v]) => [c, (v as any).slice(0, k)])) });
        const pos = r.positions.map((_: string, i: number) => simulate(sub(i + 1), spec, fee).position);
        assertEquals(pos, r.positions, `${rname} per-bar positions`);
      }
    } else {
      for (const sim of fx.simulations) {
        const res = simulate(frame, specFromRow({ ...sim.row, generation_meta: { exits: sim.row } }));
        assertEquals([res.position, res.trades.length], [sim.position, sim.trades.length], sim.name);
      }
    }
  });
}
