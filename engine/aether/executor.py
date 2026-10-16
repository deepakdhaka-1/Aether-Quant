"""Executor: reconcile every active user's Hyperliquid account to their subscribed strategies.

Idempotent and fail-closed: each pass diffs desired vs actual,
so a missed pass self-heals on the next. Any uncertainty blocks NEW entries; reduce-only closes
are never blocked. Run every minute.

One subscription per coin per account: Hyperliquid nets positions per coin, so two strategies on
the same coin in one account would fight. The web app enforces this when subscribing.
"""
from __future__ import annotations

import logging
import os
import socket
from datetime import datetime, timedelta, timezone

from . import config, crypto
from .db import client
from .hyperliquid import BrokerError, HyperliquidAccount

log = logging.getLogger("aether.executor")
LOCK_NAME, LOCK_TTL = "executor", 110
SIGNAL_MAX_AGE = {"15m": 2, "1h": 2, "4h": 2, "1d": 2}   # bars; older signal = stale -> no entries
TF_SECONDS = {"15m": 900, "1h": 3600, "4h": 14400, "1d": 86400}


def _now():
    return datetime.now(timezone.utc)


def run_once() -> dict:
    sb = client()
    holder = f"{socket.gethostname()}:{os.getpid()}"
    if not sb.rpc("try_exec_lock", {"p_name": LOCK_NAME, "p_holder": holder, "p_ttl_s": LOCK_TTL}).execute().data:
        log.info("another executor holds the lock; skipping")
        return {"skipped": True}
    try:
        halted = bool((sb.table("system_state").select("halted").eq("id", "global").single().execute().data
                       or {}).get("halted"))
        # Revoked accounts with the kill switch on are still visited so their positions get flattened.
        accounts = (sb.table("broker_accounts").select("*").in_("status", ["active", "revoked"])
                      .eq("agent_approved", True).execute().data or [])
        accounts = [a for a in accounts if a["status"] == "active" or a.get("kill_switch")]
        summary = {"accounts": len(accounts), "orders": 0, "errors": 0, "dry_run": config.DRY_RUN}
        for acct in accounts:
            try:
                # Clear the previous pass's error first; anything this pass reports (exception below,
                # or a failed stop placement inside reconcile) is written afresh.
                if acct.get("last_error"):
                    sb.table("broker_accounts").update({"last_error": None}).eq("id", acct["id"]).execute()
                summary["orders"] += reconcile_account(sb, acct, halted)
            except Exception as e:
                summary["errors"] += 1
                log.exception("account %s failed: %s", acct["id"], e)
                sb.table("broker_accounts").update({"last_error": str(e)[:500]}).eq("id", acct["id"]).execute()
        sb.table("heartbeats").upsert({"id": "executor", "last_run": _now().isoformat(), "detail": summary}).execute()
        return summary
    finally:
        sb.rpc("release_exec_lock", {"p_name": LOCK_NAME, "p_holder": holder}).execute()


def _latest_signal(sb, strategy_id: str) -> dict | None:
    rows = (sb.table("strategy_signals").select("*").eq("strategy_id", strategy_id)
              .order("bar_time", desc=True).limit(1).execute().data or [])
    return rows[0] if rows else None


def _risk_blocks_entries(sb, acct: dict, equity: float) -> str | None:
    risk = (sb.table("user_risk").select("*").eq("user_id", acct["user_id"]).execute().data or [None])[0] or {}
    if risk and not risk.get("trading_enabled", True):
        return "trading disabled by user"
    since = (_now() - timedelta(hours=24)).isoformat()
    snaps = (sb.table("account_snapshots").select("equity").eq("broker_account_id", acct["id"])
               .gte("created_at", since).order("created_at").limit(1).execute().data or [])
    if snaps:
        start = float(snaps[0]["equity"])
        if start > 0 and (equity / start - 1) * 100 <= -float(risk.get("max_daily_loss_pct", 5)):
            return "daily loss limit reached"
    # Drawdown from the 30-day equity peak (user_risk.max_drawdown_pct, default 20).
    since30 = (_now() - timedelta(days=30)).isoformat()
    peak_rows = (sb.table("account_snapshots").select("equity").eq("broker_account_id", acct["id"])
                   .gte("created_at", since30).order("equity", desc=True).limit(1).execute().data or [])
    peak = max(float(peak_rows[0]["equity"]) if peak_rows else 0.0, equity)
    if peak > 0 and (equity / peak - 1) * 100 <= -float(risk.get("max_drawdown_pct", 20)):
        return "max drawdown limit reached"
    return None


def reconcile_account(sb, acct: dict, halted: bool) -> int:
    key = crypto.decrypt(acct["agent_secret_enc"])
    hl = HyperliquidAccount(acct["wallet_address"], key,
                            "https://api.hyperliquid-testnet.xyz" if acct["network"] == "testnet" else None)
    state = hl.account()
    sb.table("account_snapshots").insert({"broker_account_id": acct["id"], "user_id": acct["user_id"],
                                          "equity": state.equity}).execute()
    by_coin = {p.coin: p for p in state.positions}
    orders = 0

    # Kill switch: flatten everything and stop.
    if acct.get("kill_switch") or acct["status"] != "active":
        for p in state.positions:
            _close(sb, hl, acct, None, p.coin, p, "kill_switch")
            orders += 1
        _sync_positions(sb, acct, hl)
        return orders

    block = "global halt" if halted else _risk_blocks_entries(sb, acct, state.equity)
    subs = (sb.table("subscriptions").select("*, strategies(*, markets(hl_coin))")
              .eq("broker_account_id", acct["id"]).eq("mode", "live").execute().data or [])
    for sub in subs:
        strat = sub["strategies"]
        coin = hl.to_coin(strat["markets"]["hl_coin"])
        current = by_coin.get(coin)
        sig = _latest_signal(sb, strat["id"])
        desired = "flat"
        if sub["enabled"] and strat["status"] == "published" and sig:
            age = (_now() - datetime.fromisoformat(sig["bar_time"])).total_seconds()
            fresh = age <= SIGNAL_MAX_AGE[strat["timeframe"]] * TF_SECONDS[strat["timeframe"]]
            # A stale signal must not open anything, but keep an existing matching position.
            desired = sig["desired"] if fresh or (current and current.side == sig["desired"]) else "flat"
        elif strat["status"] == "paused" and current:
            desired = current.side                   # paused: no new trades, keep what's open

        actual = current.side if current else "flat"
        if desired == actual:
            continue
        if current:
            orders += 1
            if not _close(sb, hl, acct, sub, coin, current, f"signal->{desired}"):
                # Never open the other side on top of a position we failed to close: a non-reduce
                # order would net against it and leave a wrong-sized position. Retry next pass.
                continue
        if desired != "flat":
            if block:
                log.info("%s %s: entry blocked (%s)", acct["id"], coin, block)
                continue
            orders += _open(sb, hl, acct, sub, strat, coin, desired, state)
    _sync_positions(sb, acct, hl)
    return orders


def _record(sb, acct, sub, strat_id, coin, side, qty, price, reduce_only, status, oid=None, error=None):
    sb.table("orders").insert({
        "user_id": acct["user_id"], "broker_account_id": acct["id"],
        "subscription_id": sub["id"] if sub else None, "strategy_id": strat_id,
        "symbol": coin, "side": side, "qty": qty, "price": price, "reduce_only": reduce_only,
        "status": status, "broker_order_id": oid, "error": error,
        "builder_fee_bps10": config.BUILDER_FEE_BPS10 if config.BUILDER_ADDRESS else None,
    }).execute()


def _close(sb, hl, acct, sub, coin, pos, reason) -> bool:
    """Reduce-only close. Returns True only when the position is fully gone (or dry run)."""
    side = "sell" if pos.side == "long" else "buy"
    strat_id = sub["strategy_id"] if sub else None
    if config.DRY_RUN:
        _record(sb, acct, sub, strat_id, coin, side, pos.qty, pos.mark_price, True, "dry_run")
        return True
    try:
        hl.cancel_stops(coin)
        r = hl.market_order(coin, is_buy=(side == "buy"), qty=pos.qty, reduce_only=True)
        _record(sb, acct, sub, strat_id, coin, side, r["filled"], r["avg_px"], True, r["status"], r["oid"])
        return r["status"] == "filled"
    except BrokerError as e:
        _record(sb, acct, sub, strat_id, coin, side, pos.qty, None, True, "rejected", error=str(e))
        return False


def _open(sb, hl, acct, sub, strat, coin, desired, state) -> int:
    lev = float(sub["leverage"])
    notional = hl.sizing_equity(state, coin) * float(sub["allocation_pct"]) * lev
    px = hl.mid(coin)
    qty = notional / px if px else 0
    side = "buy" if desired == "long" else "sell"
    if config.DRY_RUN:
        _record(sb, acct, sub, strat["id"], coin, side, qty, px, False, "dry_run")
        return 1
    try:
        r = hl.market_order(coin, is_buy=(side == "buy"), qty=qty, leverage=lev)
    except BrokerError as e:
        _record(sb, acct, sub, strat["id"], coin, side, qty, px, False, "rejected", error=str(e))
        return 1
    _record(sb, acct, sub, strat["id"], coin, side, r["filled"], r["avg_px"], False, r["status"], r["oid"])
    sl = strat.get("stop_loss_pct")
    if sl and r["avg_px"]:
        trig = r["avg_px"] * (1 - float(sl) / 100 if desired == "long" else 1 + float(sl) / 100)
        try:
            hl.place_stop(coin, desired, r["filled"], trig)
        except BrokerError as e:
            # The entry filled; surface the missing venue stop instead of mislabelling the entry.
            log.error("%s %s: venue stop not placed: %s", acct["id"], coin, e)
            sb.table("broker_accounts").update({"last_error": f"stop not placed on {coin}: {e}"[:500]})               .eq("id", acct["id"]).execute()
    return 1


def _sync_positions(sb, acct, hl):
    st = hl.account()
    sb.table("positions").delete().eq("broker_account_id", acct["id"]).execute()
    if st.positions:
        sb.table("positions").insert([{
            "broker_account_id": acct["id"], "user_id": acct["user_id"], "symbol": p.coin,
            "side": p.side, "qty": p.qty, "entry_price": p.entry_price, "mark_price": p.mark_price,
            "unrealized_pnl": p.unrealized_pnl, "updated_at": _now().isoformat(),
        } for p in st.positions]).execute()
