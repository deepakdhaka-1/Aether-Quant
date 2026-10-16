"""Market-quality gate for ENTRIES.

Before a user's money opens a position the executor reads the venue's book and refuses the entry
when the market it would trade into is poor. A refused entry is recorded as a `blocked` order row
with the reason and retried on the next pass while the signal still wants the position. Closes,
stops and take-profits never pass through here -- getting out is always allowed.

  quote age   the book's own timestamp is older than MARKET_GATE_MAX_AGE_S
  spread      (ask - bid) / mid wider than the asset's limit (US equity / commodity / index
              perps: MARKET_GATE_SPREAD_BP, default 10 bp)
  depth       resting size within MARKET_GATE_DEPTH_BP of mid on the side we take (asks for a buy,
              bids for a sell) under MARKET_GATE_DEPTH_MULT x the order's notional
  basis       |mark / index - 1| over MARKET_GATE_BASIS_MAX_BP, when the venue reports both
  chase       a FRESH signal (younger than SIGNAL_ANCHOR_MIN_AGE_S) whose price has already run
              more than MARKET_GATE_CHASE_FRAC of the stop distance past the signal price in the
              trade's own direction -- the move the trade was meant to catch is half spent, and
              the stop is now that much further away in money. Late joins have their own rule
              (late_join.refusal).

A quote that cannot be read blocks the entry (fail-closed, like every other entry gate).
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Optional

from .. import config


@dataclass
class Quote:
    bid: float
    ask: float
    ts: Optional[float] = None            # epoch seconds of the book snapshot (venue clock)
    mark: Optional[float] = None
    index: Optional[float] = None
    bid_depth_usd: Optional[float] = None  # resting notional within depth_bp of mid
    ask_depth_usd: Optional[float] = None
    depth_bp: float = 10.0


def book_depth_usd(levels, mid: float, depth_bp: float, side: str) -> float:
    """Resting notional within depth_bp of mid. `levels` = [(price, size), ...]; side 'bid' counts
    prices down to mid*(1-depth_bp), 'ask' up to mid*(1+depth_bp)."""
    lo, hi = (mid * (1 - depth_bp / 1e4), mid) if side == "bid" else (mid, mid * (1 + depth_bp / 1e4))
    total = 0.0
    for px, qty in levels:
        try:
            px, qty = float(px), float(qty)
        except (TypeError, ValueError):
            continue
        if lo - 1e-12 <= px <= hi + 1e-12:
            total += px * qty
    return total


def quote_from_l2(book: dict, depth_bp: Optional[float] = None) -> Quote:
    """Hyperliquid l2Book -> Quote. 20 levels a side, so depth past them reads as absent
    (conservative). The book carries no mark/index, so the basis check is skipped for it."""
    depth_bp = config.MARKET_GATE_DEPTH_BP if depth_bp is None else depth_bp
    bids, asks = (book.get("levels") or [[], []])[:2]
    bid, ask = float(bids[0]["px"]), float(asks[0]["px"])
    mid = (bid + ask) / 2.0
    ts = book.get("time")
    return Quote(bid=bid, ask=ask, ts=(float(ts) / 1000.0 if ts else None),
                 bid_depth_usd=book_depth_usd([(lv["px"], lv["sz"]) for lv in bids], mid, depth_bp, "bid"),
                 ask_depth_usd=book_depth_usd([(lv["px"], lv["sz"]) for lv in asks], mid, depth_bp, "ask"),
                 depth_bp=depth_bp)


def spread_limit_bp(asset_class: str = "equity") -> float:
    if asset_class == "crypto":
        return config.MARKET_GATE_SPREAD_CRYPTO_BP
    return config.MARKET_GATE_SPREAD_BP


def _age_s(row_time) -> Optional[float]:
    if not row_time:
        return None
    try:
        t = datetime.fromisoformat(str(row_time).replace("Z", "+00:00"))
    except ValueError:
        return None
    if t.tzinfo is None:
        t = t.replace(tzinfo=timezone.utc)
    return (datetime.now(timezone.utc) - t).total_seconds()


def check_entry(asset_class: str, buy: bool, notional: float, quote: Optional[Quote], *,
                now: Optional[float] = None, signal_price: Optional[float] = None,
                signal_time=None, stop_pct: Optional[float] = None) -> Optional[str]:
    """The reason this entry must not be sent now, or None when the market is fit to trade."""
    if quote is None:
        return "market gate: no order book could be read — entry not sent"
    bid, ask = float(quote.bid or 0), float(quote.ask or 0)
    if bid <= 0 or ask <= 0 or ask < bid:
        return f"market gate: no two-sided quote (bid {bid:g} / ask {ask:g})"
    mid = (bid + ask) / 2.0
    if quote.ts:
        now = now if now is not None else datetime.now(timezone.utc).timestamp()
        age = now - float(quote.ts)
        if age > config.MARKET_GATE_MAX_AGE_S:
            return f"market gate: quote is {age:.1f}s old (limit {config.MARKET_GATE_MAX_AGE_S:g}s)"
    spread_bp = (ask - bid) / mid * 1e4
    lim = spread_limit_bp(asset_class)
    if spread_bp > lim + 1e-9:
        return f"market gate: spread {spread_bp:.1f} bp > {lim:g} bp"
    depth = quote.ask_depth_usd if buy else quote.bid_depth_usd
    if depth is not None and notional > 0:
        need = config.MARKET_GATE_DEPTH_MULT * notional
        if depth + 1e-9 < need:
            return (f"market gate: only ${depth:,.0f} on the {'ask' if buy else 'bid'} within "
                    f"{quote.depth_bp:g} bp, needs ${need:,.0f} ({config.MARKET_GATE_DEPTH_MULT:g}x the order)")
    if quote.mark and quote.index and quote.index > 0:
        basis_bp = abs(quote.mark / quote.index - 1) * 1e4
        if basis_bp > config.MARKET_GATE_BASIS_MAX_BP:
            return f"market gate: mark/index apart by {basis_bp:.1f} bp > {config.MARKET_GATE_BASIS_MAX_BP:g} bp"
    if signal_price and stop_pct and stop_pct > 0:
        age = _age_s(signal_time)
        if age is not None and age < config.SIGNAL_ANCHOR_MIN_AGE_S:
            px = ask if buy else bid
            ran = ((px - signal_price) if buy else (signal_price - px)) / signal_price * 100.0
            allowed = config.MARKET_GATE_CHASE_FRAC * stop_pct
            if ran > allowed + 1e-9:
                return (f"market gate: price already {ran:.2f}% past the signal price {signal_price:g} "
                        f"(limit {allowed:.2f}% = {config.MARKET_GATE_CHASE_FRAC:g} of the {stop_pct:.2f}% stop)")
    return None
