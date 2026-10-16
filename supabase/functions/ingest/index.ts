// ingest: closed OHLCV -> indicators -> <SYMBOL>_<TOKEN>_TAAPI_Indicator_snapshot (contract:
// docs/INDICATOR_TABLES.md). Scheduled by pg_cron one minute after every hourly bar close.
//
// POST {}                               dispatcher: fans out one call per (market, timeframe) due now
// POST {symbol, timeframe[, dry_run]}   one feed (each runs in its own worker: own CPU budget)
// POST {all: true}                      dispatch every active feed regardless of the clock
//
// Write rules (each fixes a real data-quality failure):
//   * closed bars only; equities on 1h keep regular-session bars (stamped bar_et_hour/is_final_rth_bar);
//   * WARM-UP: the first WARMUP bars of the fetched window are never written;
//   * only bars the table lacks, plus the newest REWRITE_LATEST (their price_after_<tf> label fills in);
//   * obv/ad/wad running totals are shifted to continue the stored series;
//   * only columns computed at parity with the research engine (EDGE_COLUMNS) are written.
import { db, heartbeat, serve } from "../_shared/db.ts";
import { env } from "../_shared/env.ts";
import { computeIndicators, EDGE_COLUMNS, textColumns } from "../_shared/indicators.ts";
import { type Market, ohlcv, sessionStamp } from "../_shared/candles.ts";

const TOKEN: Record<string, string> = { "5m": "5min", "15m": "15min", "1h": "1H", "4h": "4H", "1d": "1D" };
const LABEL: Record<string, string> = { "5m": "price_after_5_min", "15m": "price_after_15_min", "1h": "price_after_1_h", "4h": "price_after_4_h", "1d": "price_after_1_d" };
const TIMEFRAMES = ["1h", "4h"];
const WINDOW = 2000;
const WARMUP = 600;
const REWRITE_LATEST = 2;
const CUMULATIVE = ["obv_value", "ad_value", "wad_value"];
const BATCH = 500;

export const tableName = (symbol: string, tf: string) => `${symbol.toUpperCase()}_${TOKEN[tf]}_TAAPI_Indicator_snapshot`;

type Row = Record<string, number | string | null>;

function clean(v: number): number | null {
  return Number.isFinite(v) ? v : null;
}

export function buildRows(bars: ReturnType<typeof Object>, tf: string, assetClass: string, source: string): Row[] {
  // deno-lint-ignore no-explicit-any
  const b = bars as any;
  const ind = computeIndicators(b, tf);
  const text = textColumns(ind);
  const n = b.close.length;
  const now = new Date().toISOString();
  const stamp = assetClass === "equity" && tf === "1h";
  const rows: Row[] = [];
  for (let i = 0; i < n; i++) {
    const ts = b.timestamp[i];
    const row: Row = {
      timestamp: ts,
      timestampHuman: new Date(ts * 1000).toISOString().slice(0, 16).replace("T", " ") + " UTC",
      open: b.open[i], high: b.high[i], low: b.low[i], close: b.close[i], volume: b.volume[i],
      [LABEL[tf]]: i + 1 < n ? b.close[i + 1] : null,
      source, updated_at: now,
      supertrend_Advice: text.supertrend_Advice[i], rvgi_trend: text.rvgi_trend[i],
    };
    for (const c of EDGE_COLUMNS) row[c] = clean(ind[c][i]);
    if (stamp) Object.assign(row, sessionStamp(ts, tf));
    rows.push(row);
  }
  return rows;
}

export function selectWrites(built: Row[], stored: Map<number, Row>, warmup: number): Row[] {
  const settled = built.slice(warmup);
  if (!settled.length) return [];
  const latest = new Set(settled.slice(-REWRITE_LATEST).map((r) => r.timestamp as number));
  const writes = settled.filter((r) => latest.has(r.timestamp as number) || !stored.has(r.timestamp as number)).map((r) => ({ ...r }));
  const writing = new Set(writes.map((r) => r.timestamp as number));
  for (const col of CUMULATIVE) {
    let offset: number | null = null;
    for (let i = built.length - 1; i >= 0 && offset === null; i--) {
      const r = built[i];
      if (writing.has(r.timestamp as number)) continue;
      const s = stored.get(r.timestamp as number)?.[col];
      const c = r[col];
      if (s !== null && s !== undefined && c !== null && c !== undefined) offset = Number(s) - Number(c);
    }
    if (offset === null) continue;
    for (const r of writes) if (r[col] !== null && r[col] !== undefined) r[col] = Number(r[col]) + offset;
  }
  return writes;
}

async function storedSince(table: string, since: number): Promise<Map<number, Row>> {
  const out = new Map<number, Row>();
  for (let start = 0; ; start += 1000) {
    const { data, error } = await db().from(table).select(["timestamp", ...CUMULATIVE].join(","))
      .gte("timestamp", since).order("timestamp").range(start, start + 999);
    if (error) throw new Error(`read ${table}: ${error.message}`);
    for (const r of (data ?? []) as unknown as Row[]) out.set(Number(r.timestamp), r);
    if (!data || data.length < 1000) return out;
  }
}

async function runFeed(m: Market, tf: string, dryRun: boolean) {
  const table = tableName(m.symbol, tf);
  const { bars, source } = await ohlcv(m, tf, WINDOW);
  if (!bars.close.length) throw new Error(`no OHLCV for ${m.symbol} ${tf}`);
  const built = buildRows(bars, tf, m.asset_class, source);
  const warm = Math.min(WARMUP, Math.max(0, built.length - REWRITE_LATEST));
  const { error: tErr } = await db().rpc("aether_create_snapshot_table", { p_symbol: m.symbol, p_timeframe: tf });
  if (tErr) throw new Error(`create ${table}: ${tErr.message}`);
  const stored = await storedSince(table, built[0].timestamp as number);
  const writes = selectWrites(built, stored, warm);
  if (!dryRun) {
    for (let i = 0; i < writes.length; i += BATCH) {
      const { error } = await db().from(table).upsert(writes.slice(i, i + BATCH), { onConflict: "timestamp" });
      if (error) throw new Error(`upsert ${table}: ${error.message}`);
    }
  }
  return {
    table, source, bars: built.length, warmup: warm, stored_in_window: stored.size, writes: writes.length, dry_run: dryRun,
    first: writes[0]?.timestamp ?? null, last: writes[writes.length - 1]?.timestamp ?? null,
  };
}

/** Which timeframes have a bar that closed within the last hour (the cron fires hourly at :01). */
export function dueTimeframes(nowSec: number): string[] {
  const hour = Math.floor(nowSec / 3600) % 24;
  return TIMEFRAMES.filter((tf) => tf === "1h" || (tf === "4h" && hour % 4 === 0));
}

serve("ingest", async (req, body) => {
  if (body.symbol && body.timeframe) {
    const { data, error } = await db().from("markets").select("symbol, asset_class, hl_coin").eq("symbol", String(body.symbol).toUpperCase()).limit(1);
    if (error || !data?.length) throw new Error(`unknown market ${body.symbol}`);
    if (!TOKEN[String(body.timeframe)]) throw new Error(`unsupported timeframe ${body.timeframe}`);
    return await runFeed(data[0] as Market, String(body.timeframe), body.dry_run === true);
  }

  // Dispatcher: one HTTP call per feed so every feed gets its own worker and CPU budget.
  const { data: markets, error } = await db().from("markets").select("symbol, asset_class, hl_coin").eq("active", true);
  if (error) throw new Error(`markets: ${error.message}`);
  const tfs = body.all === true ? TIMEFRAMES : (Array.isArray(body.timeframes) ? body.timeframes as string[] : dueTimeframes(Date.now() / 1000));
  const self = new URL(req.url);
  const url = `${env("SUPABASE_URL")}/functions/v1/ingest`;
  const jobs = (markets ?? []).flatMap((m) => tfs.map((tf) => ({ symbol: m.symbol as string, timeframe: tf })));
  const results: Record<string, unknown>[] = [];
  const queue = [...jobs];
  await Promise.all(Array.from({ length: Math.min(6, queue.length) }, async () => {
    for (let job = queue.shift(); job; job = queue.shift()) {
      try {
        const r = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-cron-secret": env("CRON_SECRET"), Authorization: `Bearer ${env("SUPABASE_SERVICE_ROLE_KEY")}` },
          body: JSON.stringify({ ...job, dry_run: body.dry_run === true }),
          signal: AbortSignal.timeout(140000),
        });
        const out = await r.json().catch(() => ({ ok: false, error: `HTTP ${r.status}` }));
        results.push({ ...job, ...out });
      } catch (e) {
        results.push({ ...job, ok: false, error: String((e as Error).message).slice(0, 200) });
      }
    }
  }));
  const failed = results.filter((r) => !r.ok);
  const summary = {
    feeds: jobs.length, ok: jobs.length - failed.length, failed: failed.length,
    rows: results.reduce((s, r) => s + Number(r.writes || 0), 0), timeframes: tfs, host: self.host,
    errors: failed.slice(0, 10).map((r) => ({ feed: `${r.symbol} ${r.timeframe}`, error: r.error })),
  };
  if (body.dry_run !== true) await heartbeat("ingest", summary);

  // Chain: signals right after the bars are in (the cron schedule is the backstop).
  if (body.dry_run !== true && body.chain !== false) {
    try {
      const r = await fetch(`${env("SUPABASE_URL")}/functions/v1/signals`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-cron-secret": env("CRON_SECRET"), Authorization: `Bearer ${env("SUPABASE_SERVICE_ROLE_KEY")}` },
        body: JSON.stringify({ timeframes: tfs }), signal: AbortSignal.timeout(140000),
      });
      (summary as Record<string, unknown>).signals = (await r.json().catch(() => ({ status: r.status })));
    } catch (e) {
      (summary as Record<string, unknown>).signals = { error: String((e as Error).message) };
    }
  }
  return { summary, results };
});
