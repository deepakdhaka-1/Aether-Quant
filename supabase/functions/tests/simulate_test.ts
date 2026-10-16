// Parity: rule compiler and simulate() against the Python engine, on the Python indicator frame.
//   deno test --allow-read supabase/functions/tests/
import { assertEquals } from "jsr:@std/assert@1.0.8";
import { compileRule, normalise, RuleError } from "../_shared/rules.ts";
import { simulate, specFromRow } from "../_shared/backtest.ts";
import type { Frame } from "../_shared/rules.ts";

const DIR = new URL("./fixtures/", import.meta.url);
// deno-lint-ignore no-explicit-any
export function loadFixtures(): { name: string; fx: any }[] {
  const out = [];
  for (const e of Deno.readDirSync(DIR)) {
    if (e.name.endsWith(".json")) out.push({ name: e.name, fx: JSON.parse(Deno.readTextFileSync(new URL(e.name, DIR))) });
  }
  return out;
}

// deno-lint-ignore no-explicit-any
export function pythonFrame(fx: any): Frame {
  return { n: fx.timestamp.length, cols: { ...fx.columns, timestamp: fx.timestamp } };
}

const close = (a: number | null, b: number | null) =>
  (a === null && b === null) || (a !== null && b !== null && Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(b)));

for (const { name, fx } of loadFixtures()) {
  Deno.test(`rules: ${name} compile/normalise parity`, () => {
    const cols = [...Object.keys(fx.columns), "timestamp"];
    for (const rc of fx.rule_cases) {
      let ok = false, norm: string | null = null, err: string | null = null, columns: string[] = [];
      try {
        const r = compileRule(rc.src, cols, rc.side);
        ok = r !== null;
        norm = normalise(rc.src, rc.side);
        columns = r ? [...r.columns].sort() : [];
      } catch (e) {
        if (!(e instanceof RuleError)) throw e;
        err = e.message;
      }
      assertEquals({ src: rc.src, ok, error: err !== null }, { src: rc.src, ok: rc.ok, error: rc.error !== null });
      if (rc.ok) assertEquals([norm, columns], [rc.normalised, rc.columns], rc.src);
    }
  });

  Deno.test(`simulate: ${name} trades + position parity (Python indicator frame)`, () => {
    const frame = pythonFrame(fx);
    for (const sim of fx.simulations) {
      const spec = specFromRow({ ...sim.row, generation_meta: { exits: sim.row } });
      const res = simulate(frame, spec);
      assertEquals(res.position, sim.position, `${sim.name} position`);
      assertEquals(res.position_reason, sim.position_reason, `${sim.name} reason`);
      assertEquals(res.trades.length, sim.trades.length, `${sim.name} trade count`);
      res.trades.forEach((t, k) => {
        const p = sim.trades[k];
        assertEquals([t.side, t.entry_time, t.exit_time, t.reason], [p.side, p.entry_time, p.exit_time, p.reason], `${sim.name} trade ${k}`);
        for (const key of ["entry_price", "exit_price", "pnl_pct", "sl_price", "tp_price"] as const) {
          if (!close(t[key], p[key])) throw new Error(`${sim.name} trade ${k} ${key}: ts ${t[key]} vs py ${p[key]}`);
        }
      });
      if (!close(res.sl_pct, sim.sl_pct) || !close(res.tp_pct, sim.tp_pct)) {
        throw new Error(`${sim.name} sl/tp: ${res.sl_pct}/${res.tp_pct} vs ${sim.sl_pct}/${sim.tp_pct}`);
      }
    }
  });
}
