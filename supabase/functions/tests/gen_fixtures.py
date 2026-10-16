"""Golden fixtures for the Edge runtime parity tests.

    engine/.venv/Scripts/python supabase/functions/tests/gen_fixtures.py

For each market feed: closed OHLCV from the production source, the Python indicator frame
(aether.indicators.compute) and, for a set of strategies, the Python simulate() result
(trades, final position, protective distances). The Deno tests recompute everything in
TypeScript and compare.
"""
import json
import math
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "..", "..", ".."))
sys.path.insert(0, os.path.join(ROOT, "engine"))

import pandas as pd  # noqa: E402

from aether import data, indicators  # noqa: E402
from aether.backtest import StrategySpec, simulate  # noqa: E402

BARS = 1500
FEEDS = [("GOLD", "commodity", "xyz:GOLD", "1h"), ("NVDA", "equity", "xyz:NVDA", "1h"),
         ("CL", "commodity", "xyz:CL", "4h")]

STRATEGIES = [
    {"name": "rsi_revert", "direction": "long", "entry_long": "rsi_value < 35 and close > ema_value",
     "exit_long": "rsi_value > 55", "stop_loss_pct": 2},
    {"name": "macd_cross_both", "direction": "both",
     "entry_long": "macdext_MACD crosses above macdext_MACDSignal",
     "entry_short": "macdext_MACD crosses below macdext_MACDSignal",
     "exit_long": "rsi_value > 70", "exit_short": "rsi_value < 30"},
    {"name": "bb_prev", "direction": "both",
     "entry_long": "close_prev2 < bbands_LowerBand_prev2 and close > bbands_LowerBand",
     "exit_long": "close <= entry_price * 0.985 or close >= entry_price * 1.02",
     "entry_short": "close > bbands_UpperBand AND NOT (adx_value > 30)",
     "exit_short": "close >= entry_price * 1.01 or TP: 3%"},
    {"name": "supertrend_atr", "direction": "long", "entry_long": "close crosses above supertrend_value",
     "exit_long": "close < supertrend_value", "sl_atr_mult": 2.0, "tp_atr_mult": 3.0},
    {"name": "swing_anchor", "direction": "short", "entry_short": "stoch_K crosses below 80 and willr_value > -50",
     "exit_short": "stoch_K < 20", "sl_anchor": "swing", "rr_ratio": 1.5},
    {"name": "time_weekend", "direction": "both", "entry_long": "mom_value > 0 and cci_value > 100",
     "entry_short": "mom_value < 0 and cci_value < -100", "exit_long": "cci_value < 0",
     "exit_short": "cci_value > 0", "time_limit_hours": 24, "weekend_exit": True},
    {"name": "arith", "direction": "long",
     "entry_long": "abs(close - ema_value) / atr_value > 1.5 and min(rsi_value, mfi_value) < 40",
     "exit_long": "max(rsi_value, mfi_value) > 60 or close >= entry_price + 2 * atr_value"},
    {"name": "dialect", "direction": "both",
     "entry_long": "Entry Long: if (current.rsi_value < 40 && historical[1].rsi_value < current.rsi_value) { return true }",
     "exit_long": "Exit: rsi_value.diff() < 0 AND rsi_value > 50",
     "entry_short": "rsi_value > 65 | something", "exit_short": "rsi_value < 45 // take it",
     "stop_loss_pct": 1.5, "take_profit_pct": 4},
]


RULE_CASES = [
    ("rsi_value < 30 and close > ema_value", ""), ("macdext_MACD crosses above macdext_MACDSignal", ""),
    ("(adx_value > 25) AND NOT (chop_value > 61.8)", ""), ("close_prev3 > close", ""),
    ("close <= entry_price * 0.98", "long"), ("entry_price * 0.98", "long"), ("entry_price * 1.05", "short"),
    ("TP: 2%", "long"), ("TP: 2% OR rsi_value > 70", "long"), ("rsi_value > 70 and", ""),
    ("__import__('os')", ""), ("close.real > 1", ""), ("max(close, open, high) > 1", ""),
    ("'x' * 5", ""), ("2 > 1", ""), ("a // 2 > 1", ""), ("rsi_value // note here", ""),
    ("stoch_K crosses below 20", ""), ("x[0] > 1", ""), ("lambda: 1", ""), ("abs(close) > -1", ""),
    ("if (rsi_value < 30) { return true }", ""), ("{ return close > open; }", ""),
    ("rsi_value < 30 && (close > open || volume > 0)", ""), ("rsi_value > 50 | macd | foo", ""),
    ("unknown_col > 1", ""), ("price > 1", ""), ("RSI_VALUE > 1", ""), ("close > 1e3", ""),
    ("True and close > 1", ""), ("close > 1 if close else 0", ""), ("not close > open", ""),
    ("close >= open == 1", ""), ("-close < -1", ""), ("close ** 2 > 1", ""), ("close % 2 > 1", ""),
]


def rule_cases(columns):
    from aether.rules import RuleError, compile_rule, normalise
    out = []
    for src, side in RULE_CASES:
        try:
            r = compile_rule(src, set(columns), side=side)
            out.append({"src": src, "side": side, "ok": r is not None, "normalised": normalise(src, side),
                        "columns": sorted(r.columns) if r else [], "error": None})
        except RuleError as e:
            out.append({"src": src, "side": side, "ok": False, "normalised": None, "columns": [], "error": str(e)})
    return out


def clean(v):
    if v is None:
        return None
    try:
        f = float(v)
    except (TypeError, ValueError):
        return v if isinstance(v, str) else None
    return None if math.isnan(f) or math.isinf(f) else f


def main():
    for sym, cls, coin, tf in FEEDS:
        market = {"symbol": sym, "asset_class": cls, "hl_coin": coin}
        df = data.ohlcv(sym, tf, bars=BARS, market=market)
        ind = indicators.compute(df, tf)
        cols = {}
        for c in ind.columns:
            if c in ("timestamp", "timestampHuman"):
                continue
            cols[c] = [clean(v) for v in ind[c].tolist()]
        sims = []
        for s in STRATEGIES:
            row = {k: v for k, v in s.items() if k != "name"}
            row["timeframe"] = tf
            spec = StrategySpec.from_row({**row, "generation_meta": {"exits": {k: row[k] for k in StrategySpec.EXTRA_KEYS if k in row}}})
            res = simulate(ind, spec)
            sims.append({"name": s["name"], "row": row, "position": res.position,
                         "position_reason": res.position_reason, "sl_pct": res.sl_pct, "tp_pct": res.tp_pct,
                         "trades": [{k: clean(v) if k not in ("side", "reason") else v for k, v in t.__dict__.items()}
                                    for t in res.trades]})
        out = {"symbol": sym, "timeframe": tf, "source": df.attrs.get("source"),
               "timestamp": [int(t) for t in ind["timestamp"].tolist()], "columns": cols, "simulations": sims,
               "rule_cases": rule_cases(list(ind.columns))}
        path = os.path.join(HERE, "fixtures", f"{sym}_{tf}.json")
        with open(path, "w") as fh:
            json.dump(out, fh, separators=(",", ":"))
        print(path, len(ind), "bars", len(cols), "columns", [(x["name"], len(x["trades"]), x["position"]) for x in sims])


if __name__ == "__main__":
    main()
