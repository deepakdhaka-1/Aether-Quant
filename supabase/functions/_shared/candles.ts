// OHLCV sources. Every source returns CLOSED bars only, ascending, timestamp = bar open (epoch s).
//   equities                -> CoinGlass (regular-session bars on 5m/15m/1h, all bars on 4h/1d),
//                              falling back to Hyperliquid candles when CoinGlass fails;
//   commodities / indices   -> Hyperliquid candleSnapshot (the HIP-3 venue we trade on).
import { env } from "./env.ts";
import type { Ohlcv } from "./indicators.ts";
import { MAINNET } from "./hyperliquid.ts";

export const TF_SEC: Record<string, number> = { "5m": 300, "15m": 900, "1h": 3600, "4h": 14400, "1d": 86400 };
const CG_INTERVAL: Record<string, string> = { "5m": "m5", "15m": "m15", "1h": "h1", "4h": "h4", "1d": "d1" };
const RTH = new Set(["5m", "15m", "1h"]);
const CALENDAR_FACTOR = 3;
const CG_MAX_LIMIT = 7200;

const ET = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false });
export function etParts(tsSec: number) {
  const p: Record<string, string> = {};
  for (const x of ET.formatToParts(new Date(tsSec * 1000))) p[x.type] = x.value;
  let hh = Number(p.hour);
  if (hh === 24) hh = 0;
  return { wd: ({ Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 } as Record<string, number>)[p.weekday], hh, mm: Number(p.minute) };
}

/** Regular-trading-hours bar (by bar open, New York time). Weekends are never in session. */
export function inRth(tsSec: number, tf: string): boolean {
  const { wd, hh, mm } = etParts(tsSec);
  if (wd >= 5) return false;
  if (tf === "1h") return hh >= 9 && hh <= 15;
  return (hh === 9 && mm >= 30) || (hh >= 10 && hh <= 15);
}

export function sessionStamp(tsSec: number, tf: string) {
  const { hh, mm } = etParts(tsSec);
  const final = tf === "1h" ? hh === 15 : tf === "15m" ? hh === 15 && mm === 45 : hh === 15 && mm === 55;
  return { bar_et_hour: hh, is_final_rth_bar: final ? 1 : 0 };
}

async function retry<T>(fn: () => Promise<T>, tries = 3): Promise<T> {
  let last: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      if ((e as { fatal?: boolean }).fatal) break;
      if (i < tries - 1) await new Promise((r) => setTimeout(r, 1000 * 2 ** i));
    }
  }
  throw last;
}

function toOhlcv(rows: { t: number; o: number; h: number; l: number; c: number; v: number }[]): Ohlcv {
  return {
    timestamp: rows.map((r) => r.t), open: rows.map((r) => r.o), high: rows.map((r) => r.h),
    low: rows.map((r) => r.l), close: rows.map((r) => r.c), volume: rows.map((r) => r.v),
  };
}

export async function coinglass(symbol: string, tf: string, bars: number, nowSec = Date.now() / 1000): Promise<Ohlcv> {
  const rth = RTH.has(tf);
  const limit = Math.min(rth ? bars * CALENDAR_FACTOR : bars + 2, CG_MAX_LIMIT);
  const base = env("COINGLASS_BASE_URL", "https://fapi.coinglass.com").replace(/\/$/, "");
  const url = `${base}/stocks/api/v2/kline?symbol=US_${symbol.toUpperCase()}%23kline&interval=${CG_INTERVAL[tf]}&limit=${limit}&session=extended_hours`;
  const key = env("COINGLASS_API_KEY");
  const payload = await retry(async () => {
    const r = await fetch(url, { headers: key ? { "CG-API-KEY": key } : {}, signal: AbortSignal.timeout(30000) });
    if (r.status >= 500 || r.status === 429) throw new Error(`CoinGlass HTTP ${r.status}`);
    if (!r.ok) throw Object.assign(new Error(`CoinGlass HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`), { fatal: true });
    return await r.json();
  });
  const data = payload?.data;
  const rows = Array.isArray(data) ? data : data?.data;
  if (!Array.isArray(rows) || !rows.length) throw new Error(`CoinGlass returned no candles for ${symbol} ${tf}`);
  const step = TF_SEC[tf];
  const seen = new Map<number, { t: number; o: number; h: number; l: number; c: number; v: number }>();
  for (const r of rows) {
    if (!Array.isArray(r) || r.length < 6) continue;
    const t = Math.trunc(Number(r[0]));
    const vals = r.slice(1, 6).map(Number);
    if (!(t > 0) || vals.some((x) => !Number.isFinite(x))) continue;
    if (t + step > nowSec) continue; // forming bar
    if (rth && !inRth(t, tf)) continue;
    seen.set(t, { t, o: vals[0], h: vals[1], l: vals[2], c: vals[3], v: vals[4] });
  }
  const out = [...seen.values()].sort((a, b) => a.t - b.t).slice(-bars);
  if (!out.length) throw new Error(`no closed ${rth ? "RTH " : ""}bars for ${symbol} ${tf}`);
  return toOhlcv(out);
}

export async function hlCandles(coin: string, tf: string, bars: number, nowMs = Date.now()): Promise<Ohlcv> {
  const step = TF_SEC[tf] * 1000;
  const start = nowMs - step * (Math.min(bars, 5000) + 1);
  const base = env("HYPERLIQUID_API_URL", MAINNET).replace(/\/$/, "");
  const rows = await retry(async () => {
    const r = await fetch(`${base}/info`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "candleSnapshot", req: { coin, interval: tf, startTime: start, endTime: nowMs } }),
      signal: AbortSignal.timeout(30000),
    });
    if (!r.ok) throw new Error(`candleSnapshot HTTP ${r.status}`);
    return await r.json() as { t: number; o: string; h: string; l: string; c: string; v: string }[];
  }, 4);
  const seen = new Map<number, { t: number; o: number; h: number; l: number; c: number; v: number }>();
  for (const k of rows || []) {
    if (Number(k.t) + step > nowMs) continue; // never compute on a forming candle
    const t = Math.trunc(Number(k.t) / 1000);
    seen.set(t, { t, o: Number(k.o), h: Number(k.h), l: Number(k.l), c: Number(k.c), v: Number(k.v) });
  }
  return toOhlcv([...seen.values()].sort((a, b) => a.t - b.t).slice(-bars));
}

export interface Market { symbol: string; asset_class: string; hl_coin: string }

export async function ohlcv(m: Market, tf: string, bars: number): Promise<{ bars: Ohlcv; source: string }> {
  if (m.asset_class === "equity") {
    try {
      return { bars: await coinglass(m.symbol, tf, bars), source: "coinglass" };
    } catch (e) {
      console.warn(`CoinGlass failed for ${m.symbol} ${tf} (${(e as Error).message}); using Hyperliquid candles`);
    }
  }
  return { bars: await hlCandles(m.hl_coin, tf, bars), source: "hyperliquid" };
}
