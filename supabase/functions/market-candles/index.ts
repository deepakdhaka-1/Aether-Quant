// Backfill the latest 30 completed daily OHLCV candles for every supported Hyperliquid asset.
import { createClient } from "jsr:@supabase/supabase-js@2.46.1";
import { authorize } from "../_shared/db.ts";

const DAY_MS = 86_400_000;
const MARKETS = [
  ["NVDA", "xyz:NVDA"], ["TSLA", "xyz:TSLA"], ["AAPL", "xyz:AAPL"],
  ["MSFT", "xyz:MSFT"], ["AMZN", "xyz:AMZN"], ["GOOGL", "xyz:GOOGL"],
  ["META", "xyz:META"], ["XYZ100", "xyz:XYZ100"], ["GOLD", "xyz:GOLD"],
  ["SILVER", "xyz:SILVER"], ["CL", "xyz:CL"], ["NATGAS", "xyz:NATGAS"],
  ["COPPER", "xyz:COPPER"],
] as const;

type HyperliquidCandle = {
  t: number;
  o: string;
  h: string;
  l: string;
  c: string;
  v: string;
};

async function candleSnapshot(coin: string, startTime: number, endTime: number) {
  const response = await fetch("https://api.hyperliquid.xyz/info", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      type: "candleSnapshot",
      req: { coin, interval: "1d", startTime, endTime },
    }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`Hyperliquid ${coin}: ${response.status}`);
  return await response.json() as HyperliquidCandle[];
}

// Refreshes a fixed allowlist from Hyperliquid into market_candles. Platform JWT verification is
// off (the anon key is a JWT too), so only the scheduler or the service role may trigger a run.
Deno.serve(async (req: Request) => {
  const denied = authorize(req);
  if (denied) return denied;
  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!supabaseUrl || !serviceRoleKey) {
      throw new Error("Supabase URL or service role key is unavailable in the Edge Function environment");
    }
    const sb = createClient(supabaseUrl, serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const now = Date.now();
    const todayUtc = new Date(now);
    const endOfLastDay = Date.UTC(todayUtc.getUTCFullYear(), todayUtc.getUTCMonth(), todayUtc.getUTCDate());
    const startTime = endOfLastDay - 30 * DAY_MS;
    const rows = [];
    const errors: string[] = [];
    const refreshedTickers: string[] = [];

    for (const [ticker, coin] of MARKETS) {
      try {
        const candles = await candleSnapshot(coin, startTime, now);
        const tickerRowCount = rows.length;
        for (const candle of candles) {
          const values = [candle.t, candle.o, candle.h, candle.l, candle.c, candle.v].map(Number);
          if (!values.every(Number.isFinite) || candle.t >= endOfLastDay || values[5] < 0) continue;
          rows.push({
            ticker,
            coin,
            interval: "1d",
            candle_time: new Date(candle.t).toISOString(),
            open: values[1],
            high: values[2],
            low: values[3],
            close: values[4],
            volume: values[5],
            updated_at: new Date(now).toISOString(),
          });
        }
        if (rows.length > tickerRowCount) refreshedTickers.push(ticker);
      } catch (error) {
        errors.push(`${ticker}: ${String((error as Error).message ?? error).slice(0, 160)}`);
      }
    }

    if (rows.length) {
      const { error } = await sb.from("market_candles").upsert(rows, {
        onConflict: "ticker,interval,candle_time",
      });
      if (error) throw new Error(`market_candles upsert: ${error.message}`);
    }

    // Keep the cache to a rolling 30-day window. Upsert updates existing day keys;
    // pruning removes only expired rows for markets fetched successfully this run.
    const cutoff = new Date(startTime).toISOString();
    for (const ticker of refreshedTickers) {
      const { error } = await sb.from("market_candles")
        .delete()
        .eq("ticker", ticker)
        .eq("interval", "1d")
        .lt("candle_time", cutoff);
      if (error) throw new Error(`market_candles prune ${ticker}: ${error.message}`);
    }

    const detail = { markets: MARKETS.length, candles: rows.length, errors };
    const { error: heartbeatError } = await sb.from("heartbeats").upsert({
      id: "market-candles",
      last_run: new Date().toISOString(),
      detail,
    });
    if (heartbeatError) console.error(`heartbeat market-candles: ${heartbeatError.message}`);
    if (!rows.length) throw new Error(`No daily candles were fetched (${errors.join("; ")})`);
    return Response.json({ ok: true, ...detail });
  } catch (error) {
    console.error("market-candles failed:", error);
    return Response.json(
      { ok: false, error: String((error as Error)?.message ?? error).slice(0, 500) },
      { status: 500 },
    );
  }
});
