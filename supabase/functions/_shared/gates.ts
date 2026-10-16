// Pure entry gates (no I/O): market quality, late join, protective levels. Closes never pass here.
import { envNum } from "./env.ts";

export interface Quote {
  bid: number;
  ask: number;
  ts: number | null; // epoch seconds of the book snapshot (venue clock)
  bidDepthUsd: number | null;
  askDepthUsd: number | null;
  depthBp: number;
  mark?: number | null;
  index?: number | null;
}

export function bookDepthUsd(levels: { px: string; sz: string }[], mid: number, depthBp: number, side: "bid" | "ask"): number {
  const [lo, hi] = side === "bid" ? [mid * (1 - depthBp / 1e4), mid] : [mid, mid * (1 + depthBp / 1e4)];
  let total = 0;
  for (const lv of levels) {
    const px = Number(lv.px), qty = Number(lv.sz);
    if (!Number.isFinite(px) || !Number.isFinite(qty)) continue;
    if (px >= lo - 1e-12 && px <= hi + 1e-12) total += px * qty;
  }
  return total;
}

// deno-lint-ignore no-explicit-any
export function quoteFromL2(book: any, depthBp = envNum("MARKET_GATE_DEPTH_BP", 10)): Quote {
  const [bids, asks] = (book?.levels ?? [[], []]).slice(0, 2);
  const bid = Number(bids[0].px), ask = Number(asks[0].px);
  const mid = (bid + ask) / 2;
  return {
    bid, ask, ts: book.time ? Number(book.time) / 1000 : null, depthBp,
    bidDepthUsd: bookDepthUsd(bids, mid, depthBp, "bid"), askDepthUsd: bookDepthUsd(asks, mid, depthBp, "ask"),
  };
}

/** The reason this entry must not be sent now, or null when the market is fit to trade. */
export function checkEntry(assetClass: string, buy: boolean, notional: number, quote: Quote | null, o: {
  now?: number; signalPrice?: number | null; signalTime?: string | null; stopPct?: number | null;
} = {}): string | null {
  if (!quote) return "market gate: no order book could be read — entry not sent";
  const bid = Number(quote.bid || 0), ask = Number(quote.ask || 0);
  if (bid <= 0 || ask <= 0 || ask < bid) return `market gate: no two-sided quote (bid ${bid} / ask ${ask})`;
  const mid = (bid + ask) / 2;
  const maxAge = envNum("MARKET_GATE_MAX_AGE_S", 5);
  if (quote.ts) {
    const age = (o.now ?? Date.now() / 1000) - quote.ts;
    if (age > maxAge) return `market gate: quote is ${age.toFixed(1)}s old (limit ${maxAge}s)`;
  }
  const spreadBp = (ask - bid) / mid * 1e4;
  const lim = assetClass === "crypto" ? envNum("MARKET_GATE_SPREAD_CRYPTO_BP", 15) : envNum("MARKET_GATE_SPREAD_BP", 10);
  if (spreadBp > lim + 1e-9) return `market gate: spread ${spreadBp.toFixed(1)} bp > ${lim} bp`;
  const depth = buy ? quote.askDepthUsd : quote.bidDepthUsd;
  const mult = envNum("MARKET_GATE_DEPTH_MULT", 10);
  if (depth !== null && notional > 0 && depth + 1e-9 < mult * notional) {
    return `market gate: only $${Math.round(depth)} on the ${buy ? "ask" : "bid"} within ${quote.depthBp} bp, needs $${Math.round(mult * notional)} (${mult}x the order)`;
  }
  if (quote.mark && quote.index && quote.index > 0) {
    const basis = Math.abs(quote.mark / quote.index - 1) * 1e4;
    const maxB = envNum("MARKET_GATE_BASIS_MAX_BP", 25);
    if (basis > maxB) return `market gate: mark/index apart by ${basis.toFixed(1)} bp > ${maxB} bp`;
  }
  if (o.signalPrice && o.stopPct && o.stopPct > 0 && o.signalTime) {
    const age = (o.now ?? Date.now() / 1000) - Date.parse(o.signalTime) / 1000;
    if (Number.isFinite(age) && age < envNum("SIGNAL_ANCHOR_MIN_AGE_S", 3600)) {
      const px = buy ? ask : bid;
      const ran = (buy ? px - o.signalPrice : o.signalPrice - px) / o.signalPrice * 100;
      const allowed = envNum("MARKET_GATE_CHASE_FRAC", 0.5) * o.stopPct;
      if (ran > allowed + 1e-9) {
        return `market gate: price already ${ran.toFixed(2)}% past the signal price ${o.signalPrice} (limit ${allowed.toFixed(2)}%)`;
      }
    }
  }
  return null;
}

/**
 * Late join: the strategy's trade has been open > SIGNAL_ANCHOR_MIN_AGE_S. Anchor to the strategy's own
 * entry; refuse when a level is already through the price, or the room left is too small to be worth it.
 */
export function lateJoinRefusal(side: "long" | "short", px: number, anchor: number, slPct: number | null, tpPct: number | null): string | null {
  const frac = envNum("LATE_JOIN_MIN_ROOM_FRAC", 0.25);
  const long = side === "long";
  if (slPct) {
    const stop = anchor * (long ? 1 - slPct / 100 : 1 + slPct / 100);
    const room = (long ? px - stop : stop - px) / px * 100;
    if (room <= 0) return `late join: price ${px} is already through the strategy's stop ${stop.toFixed(4)}`;
    if (room < Math.max(0.1, frac * slPct)) return `late join: only ${room.toFixed(2)}% left to the strategy's stop`;
  }
  if (tpPct) {
    const tgt = anchor * (long ? 1 + tpPct / 100 : 1 - tpPct / 100);
    const room = (long ? tgt - px : px - tgt) / px * 100;
    if (room <= 0) return `late join: price ${px} is already through the strategy's target ${tgt.toFixed(4)}`;
    if (room < frac * tpPct) return `late join: only ${room.toFixed(2)}% left to the strategy's target`;
  }
  return null;
}

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));

/** Venue bracket distances in percent: the strategy's own (clamped), or a catastrophe stop. */
export function bracketPcts(sigSl: number | null, sigTp: number | null, declaredStop: number | null): { sl: number; tp: number | null; catastrophe: boolean } {
  const lo = envNum("BRACKET_MIN_PCT", 0.1), hi = envNum("BRACKET_MAX_PCT", 50);
  if (sigSl && sigSl > 0) return { sl: clamp(sigSl, lo, hi), tp: sigTp && sigTp > 0 ? clamp(sigTp, lo, hi) : null, catastrophe: false };
  const cat = declaredStop ? envNum("VENUE_STOP_MULT", 1.5) * declaredStop : envNum("VENUE_STOP_DEFAULT_PCT", 15);
  return { sl: clamp(cat, envNum("VENUE_STOP_MIN_PCT", 3), envNum("VENUE_STOP_MAX_PCT", 25)), tp: sigTp && sigTp > 0 ? clamp(sigTp, lo, hi) : null, catastrophe: true };
}
