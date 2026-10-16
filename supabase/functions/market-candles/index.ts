// Backfill the latest 30 completed daily OHLCV candles for every supported Hyperliquid asset.
import { db, heartbeat, serve } from "../_shared/db.ts";

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

serve("market-candles", async () => {
  const sb = db();
  const now = Date.now();
  const todayUtc = new Date(now);
  const endOfLastDay = Date.UTC(todayUtc.getUTCFullYear(), todayUtc.getUTCMonth(), todayUtc.getUTCDate());
  const startTime = endOfLastDay - 30 * DAY_MS;
  const rows = [];
  const errors: string[] = [];

  for (const [ticker, coin] of MARKETS) {
    try {
      const candles = await candleSnapshot(coin, startTime, now);
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

  const detail = { markets: MARKETS.length, candles: rows.length, errors };
  await heartbeat("market-candles", detail);
  if (!rows.length) throw new Error(`No daily candles were fetched (${errors.join("; ")})`);
  return detail;
});
