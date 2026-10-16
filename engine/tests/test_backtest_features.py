"""Rule dialect normalisation and the extended backtest exits / reporting."""
from datetime import datetime, timezone

import numpy as np
import pandas as pd
import pytest

from aether.backtest import StrategySpec, in_weekend_window, run_backtest, simulate
from aether.rules import RuleError, compile_rule, extract_tp_sl, normalise_dialect


def _df(close, high=None, low=None, open_=None, start=1_700_000_000, step=3600, **cols):
    c = np.asarray(close, dtype=float)
    d = {"timestamp": start + step * np.arange(len(c)), "open": c if open_ is None else open_,
         "high": c if high is None else high, "low": c if low is None else low, "close": c, "volume": 1.0}
    d.update(cols)
    return pd.DataFrame(d)


# ---------------- dialect ----------------
def test_dialect_labels_comments_and_wrappers():
    assert normalise_dialect("Entry Long: rsi_value < 30 // oversold") == "rsi_value < 30"
    assert normalise_dialect("if (rsi_value < 30) { return true; }") == "rsi_value < 30"
    assert normalise_dialect("{ return close > ema_value; }") == "close > ema_value"
    assert normalise_dialect("const x = rsi_value > 70;") == "rsi_value > 70"


def test_dialect_historical_current_and_diff():
    assert normalise_dialect("current.close > historical[2].close") == "close > close_prev2"
    assert normalise_dialect("rsi_value.diff() > 0") == "(rsi_value > rsi_value_prev)"
    df = _df([1, 2, 3, 2])
    assert compile_rule("close.diff() > 0").evaluate(df).tolist() == [False, True, True, False]


def test_dialect_alternatives_pick_the_condition():
    assert normalise_dialect("momentum play | rsi_value < 30 | n/a") == "rsi_value < 30"


def test_case_insensitive_columns():
    df = _df([1, 2], macdext_MACD=[1.0, 3.0], macdext_MACDSignal=[2.0, 2.0])
    r = compile_rule("macdext_macd > macdext_macdsignal", {"macdext_MACD", "macdext_MACDSignal"})
    assert r.evaluate(df).tolist() == [False, True]


def test_comment_stripping_never_unlocks_floor_division():
    with pytest.raises(RuleError):
        compile_rule("a // 2 > 1")


def test_bare_tp_fragment_is_dropped_never_always_true():
    with pytest.raises(RuleError):
        compile_rule("TP: 2%")                                   # constant-only rule
    r = compile_rule("rsi_value > 70 or TP: 2%", side="long")
    assert r.columns == {"rsi_value"}


def test_threshold_term_direction_follows_multiplier():
    assert normalise_dialect("entry_price * 1.05", side="long") == "(price_value >= entry_price * 1.05)"
    assert normalise_dialect("entry_price * 0.97", side="long") == "(price_value <= entry_price * 0.97)"


def test_extract_tp_sl():
    t = extract_tp_sl("SL 1.5 * atr_value, TP: 3%, max 48h")
    assert t["sl_atr_mult"] == 1.5 and t["atr_col"] == "atr_value" and t["tp_pct"] == 3.0
    assert t["time_limit_hours"] == 48 and t["sl_pct"] is None


def test_entry_price_rule_rejects_non_numeric_still():
    with pytest.raises(RuleError):
        compile_rule("close < entry_price.__class__")


# ---------------- exits ----------------
def test_entry_price_exit_rule():
    # enter at bar 1 open (100); exit when close >= entry*1.05 -> bar 3 (106); fill at bar 4 open
    df = _df([100, 100, 103, 106, 107, 108], sig=[1, 0, 0, 0, 0, 0])
    spec = StrategySpec(entry_long="sig > 0", exit_long="close >= entry_price * 1.05")
    res = simulate(df, spec, fee=0)
    t = res.trades[0]
    assert t.entry_price == 100 and t.exit_price == 107 and t.reason == "exit_long"


def test_atr_stop_uses_signal_bar_atr():
    # ATR 2 at the signal bar, sl 1.5x -> 3 points under a 100 fill = 97
    df = _df([100, 100, 100, 100], low=[100, 100, 96, 100], sig=[1, 0, 0, 0], atr_value=[2.0, 9, 9, 9])
    res = simulate(df, StrategySpec(entry_long="sig > 0", sl_atr_mult=1.5), fee=0)
    t = res.trades[0]
    assert t.reason == "stop_loss" and t.exit_price == pytest.approx(97.0)


def test_swing_anchor_is_causal_and_sets_rr_target():
    # lows before the signal: 95; a lower low AFTER the signal (80) must not move the stop
    low = [99, 95, 98, 99, 80]
    df = _df([100, 100, 100, 100, 100], low=low, sig=[0, 0, 1, 0, 0], atr_value=2.0)
    spec = StrategySpec(entry_long="sig > 0", sl_anchor="swing", swing_lookback=3, sl_buffer_atr=0.0,
                        rr_ratio=2.0)
    res = simulate(df, spec, fee=0)
    t = res.trades[0]
    assert t.sl_price == pytest.approx(95.0) and t.tp_price == pytest.approx(110.0)
    assert t.reason == "stop_loss"


def test_time_limit_exit():
    df = _df([100] * 8, sig=[1, 0, 0, 0, 0, 0, 0, 0])
    res = simulate(df, StrategySpec(entry_long="sig > 0", time_limit_hours=3), fee=0)
    t = res.trades[0]
    assert t.reason == "time_limit" and (t.exit_time - t.entry_time) == 3 * 3600


def test_weekend_exit_flattens_friday_close():
    fri_14et = int(datetime(2026, 10, 16, 18, tzinfo=timezone.utc).timestamp())   # 14:00 ET
    df = _df([100, 101, 102, 103], start=fri_14et - 3600, sig=[1, 0, 0, 0])
    spec = StrategySpec(entry_long="sig > 0", weekend_exit=True)
    res = simulate(df, spec, fee=0)
    assert res.trades[0].reason == "weekend_exit" and res.position == "flat"
    assert in_weekend_window(fri_14et + 2 * 3600) and not in_weekend_window(fri_14et)


def test_text_exits_are_picked_up_from_rules():
    spec = StrategySpec.from_row({"entry_long": "x > 0", "exit_long": "rsi_value > 70 or SL: 2%",
                                  "timeframe": "1h"})
    assert spec.stop_loss_pct == 2.0


def test_meta_exits_and_signal_bracket():
    spec = StrategySpec.from_row({"entry_long": "sig > 0", "timeframe": "1h",
                                  "generation_meta": {"exits": {"sl_atr_mult": 2, "tp_atr_mult": 4}}})
    df = _df([100, 100, 100], sig=[0, 0, 1], atr_value=1.0)
    res = simulate(df, spec, fee=0)
    assert res.position == "long" and res.sl_pct == pytest.approx(2.0) and res.tp_pct == pytest.approx(4.0)


# ---------------- reporting ----------------
def test_periods_and_metric_keys():
    n = 24 * 40
    rng = np.random.default_rng(1)
    c = 100 + np.cumsum(rng.normal(0, 0.5, n))
    df = _df(c, sig=(np.arange(n) % 24 == 0).astype(float), out=(np.arange(n) % 24 == 12).astype(float))
    out = run_backtest(df, StrategySpec(entry_long="sig > 0", exit_long="out > 0"))
    for k in ("return_pct", "max_drawdown_pct", "sharpe", "trades", "win_rate", "profit_factor",
              "avg_trade_pct", "compounded_return_pct", "simple_return_pct", "trade_sharpe"):
        assert k in out["metrics"], k
    assert set(out["periods"]) == {"1 Week", "1 Month"}
    assert out["periods"]["1 Week"]["trades"] <= out["periods"]["1 Month"]["trades"] <= out["metrics"]["trades"]


def test_tp_sl_text_inside_an_exit_rule_becomes_a_stop():
    spec = StrategySpec.from_row({"entry_long": "x > 0", "exit_long": "rsi_value > 60 or SL 2 * atr_value",
                                  "timeframe": "1h"})
    assert spec.sl_atr_mult == 2.0
    r = compile_rule(spec.exit_long, side="long")
    assert r.columns == {"rsi_value"}
