// signals: for every published strategy, replay it on the stored closed bars and record the position
// it wants now (strategy_signals). Runs right after ingest (chained) and on its own schedule.
//
// Same semantics as the research backtester's simulate(): rules on bar i's close, fill at bar i+1's
// open, flips, SL/TP intrabar, and the desired position = the position after acting on the LAST
// closed bar's decision. Also, as the research runner does:
//   * a strategy whose rules don't compile (syntax, forbidden construct, unknown column) is paused
//     with the reason in generation_meta.error instead of failing silently every pass;
//   * a published strategy with no headline metrics gets a backtest backfilled.
import { db, heartbeat, serve } from "../_shared/db.ts";
import { compileSpec, runBacktest, simulate, specFromRow } from "../_shared/backtest.ts";
import { RuleError, type Frame } from "../_shared/rules.ts";

const TOKEN: Record<string, string> = { "15m": "15min", "1h": "1H", "4h": "4H", "1d": "1D" };
const BARS = 3000;
const iso = (ts: number) => new Date(ts * 1000).toISOString();

async function loadFrame(symbol: string, tf: string): Promise<Frame> {
  const table = `${symbol.toUpperCase()}_${TOKEN[tf]}_TAAPI_Indicator_snapshot`;
  const rows: Record<string, unknown>[] = [];
  for (let start = 0; start < BARS; start += 1000) {
    const { data, error } = await db().from(table).select("*").order("timestamp", { ascending: false }).range(start, Math.min(start + 999, BARS - 1));
    if (error) throw new Error(`read ${table}: ${error.message}`);
    rows.push(...(data ?? []));
    if (!data || data.length < 1000) break;
  }
  rows.reverse();
  const cols: Record<string, (number | null)[]> = {};
  const skip = (k: string) => k.startsWith("price_after_") || ["id", "ts_utc", "timestampHuman", "source", "created_at", "updated_at"].includes(k);
  for (const k of Object.keys(rows[0] ?? {})) if (!skip(k)) cols[k] = rows.map((r) => (r[k] === null || r[k] === undefined || typeof r[k] === "string" ? null : Number(r[k])));
  return { n: rows.length, cols };
}

serve("signals", async (_req, body) => {
  const sb = db();
  let q = sb.from("strategies").select("*, markets(symbol, asset_class, hl_coin)").eq("status", "published");
  if (Array.isArray(body.timeframes)) q = q.in("timeframe", body.timeframes as string[]);
  if (body.strategy_id) q = q.eq("id", String(body.strategy_id));
  const { data: strategies, error } = await q;
  if (error) throw new Error(`strategies: ${error.message}`);
  const cache = new Map<string, Frame>();
  let written = 0, paused = 0, backfilled = 0;
  const errors: { slug: string; error: string }[] = [];
  for (const s of strategies ?? []) {
    try {
      const tf = s.timeframe as string;
      const key = `${s.symbol}|${tf}`;
      if (!cache.has(key)) cache.set(key, await loadFrame(s.symbol, tf));
      const frame = cache.get(key)!;
      if (!frame.n) { errors.push({ slug: s.slug, error: "no snapshot rows yet" }); continue; }
      const spec = specFromRow(s);
      try {
        compileSpec(spec, Object.keys(frame.cols)); // also catches misspelled indicator names
      } catch (e) {
        if (!(e instanceof RuleError)) throw e;
        const meta = { ...(s.generation_meta || {}), error: e.message };
        await sb.from("strategies").update({ status: "paused", generation_meta: meta }).eq("id", s.id);
        paused++;
        console.error(`paused ${s.slug}: invalid rule: ${e.message}`);
        continue;
      }
      if (!s.headline_metrics || !Object.keys(s.headline_metrics).length) {
        const bt = runBacktest(frame, spec);
        const { error: bErr } = await sb.from("backtests").insert({
          strategy_id: s.id, metrics: bt.metrics, equity_curve: bt.equity_curve, trades: bt.trades,
          period_start: bt.period_start ? iso(bt.period_start) : null, period_end: bt.period_end ? iso(bt.period_end) : null,
        });
        if (!bErr) {
          await sb.from("strategies").update({ headline_metrics: bt.metrics }).eq("id", s.id);
          backfilled++;
        }
      }
      const res = simulate(frame, spec);
      const ts = frame.cols.timestamp as number[];
      const close = frame.cols.close as number[];
      const open = res.trades.length ? res.trades[res.trades.length - 1] : null;
      const holding = open && open.exit_time === null && open.side === res.position ? open : null;
      const { error: uErr } = await sb.from("strategy_signals").upsert({
        strategy_id: s.id, bar_time: iso(ts[frame.n - 1]), desired: res.position, price: close[frame.n - 1],
        reason: res.position_reason, sl_pct: res.sl_pct, tp_pct: res.tp_pct,
        entry_price: holding ? holding.entry_price : null, entry_time: holding ? iso(holding.entry_time) : null,
      }, { onConflict: "strategy_id,bar_time" });
      if (uErr) throw new Error(`signal upsert: ${uErr.message}`);
      written++;
    } catch (e) {
      errors.push({ slug: s.slug, error: String((e as Error).message).slice(0, 300) });
      console.error(`signal failed for ${s.slug}:`, e);
    }
  }
  const detail = { strategies: strategies?.length ?? 0, written, paused, backfilled, errors: errors.slice(0, 10) };
  await heartbeat("signals", detail);
  return detail;
});
