"""Signal runner: for every published strategy, replay it on fresh closed candles and record the
position it wants now. Run on a schedule just after each bar close (cron: every 15 minutes).

Strategies are pushed straight into the `strategies` table (see docs/PUSHING_STRATEGIES.md), so
this pass also does what an admin tool would otherwise do:
  * a published strategy with no backtest yet gets one (5000 bars) and its headline_metrics filled,
    so the marketplace shows real numbers;
  * a strategy whose rules don't compile is paused with the error in generation_meta.error,
    instead of failing silently on every pass.
"""
from __future__ import annotations

import logging
from datetime import datetime, timezone

from . import data, indicators
from .backtest import StrategySpec, compile_spec, run_backtest, simulate
from .db import client
from .rules import RuleError

log = logging.getLogger("aether.signals")
BACKTEST_BARS = 5000


def _iso(ts: int) -> str:
    return datetime.fromtimestamp(ts, tz=timezone.utc).isoformat()


def _backfill_backtest(sb, s: dict, df) -> None:
    out = run_backtest(df, StrategySpec.from_row(s))
    sb.table("backtests").insert({
        "strategy_id": s["id"], "metrics": out["metrics"], "equity_curve": out["equity_curve"],
        "trades": out["trades"], "period_start": _iso(out["period_start"]), "period_end": _iso(out["period_end"]),
    }).execute()
    sb.table("strategies").update({"headline_metrics": out["metrics"]}).eq("id", s["id"]).execute()
    log.info("backtest backfilled for %s: %s", s["slug"], out["metrics"])


def run_once() -> int:
    sb = client()
    strategies = (sb.table("strategies").select("*, markets(symbol, asset_class, hl_coin)")
                    .eq("status", "published").execute().data or [])
    cache: dict[tuple[str, str], object] = {}
    written = 0
    for s in strategies:
        coin, tf = s["markets"]["hl_coin"], s["timeframe"]
        try:
            spec = StrategySpec.from_row(s)
            if (coin, tf) not in cache:
                cache[(coin, tf)] = indicators.compute(data.ohlcv(s["symbol"], tf, bars=BACKTEST_BARS, market=s["markets"]), tf)
            df = cache[(coin, tf)]
            if df.empty:
                continue
            try:
                compile_spec(spec, set(df.columns))      # also catches misspelled indicator names
            except RuleError as e:
                meta = {**(s.get("generation_meta") or {}), "error": str(e)}
                sb.table("strategies").update({"status": "paused", "generation_meta": meta}).eq("id", s["id"]).execute()
                log.error("paused %s: invalid rule: %s", s["slug"], e)
                continue
            if not s.get("headline_metrics"):
                _backfill_backtest(sb, s, df)

            res = simulate(df, spec)
            bar = int(df["timestamp"].iloc[-1])
            sb.table("strategy_signals").upsert({
                "strategy_id": s["id"],
                "bar_time": _iso(bar),
                "desired": res.position,
                "price": float(df["close"].iloc[-1]),
                "reason": res.position_reason,
            }, on_conflict="strategy_id,bar_time").execute()
            written += 1
        except Exception as e:
            log.exception("signal failed for %s (%s %s): %s", s["slug"], coin, tf, e)
    sb.table("heartbeats").upsert({"id": "signals", "last_run": datetime.now(timezone.utc).isoformat(),
                                   "detail": {"strategies": len(strategies), "written": written}}).execute()
    return written
