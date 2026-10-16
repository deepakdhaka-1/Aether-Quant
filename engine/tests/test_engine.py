import os

import numpy as np
import pandas as pd
import pytest

from aether import crypto, indicators
from aether.backtest import StrategySpec, run_backtest, simulate
from aether.rules import RuleError, compile_rule


def make_df(n=600, seed=1):
    rng = np.random.default_rng(seed)
    close = 100 * np.exp(np.cumsum(rng.normal(0, 0.01, n)))
    open_ = np.r_[close[0], close[:-1]]
    high = np.maximum(open_, close) * (1 + rng.uniform(0, 0.005, n))
    low = np.minimum(open_, close) * (1 - rng.uniform(0, 0.005, n))
    return pd.DataFrame({"timestamp": 1_700_000_000 + 3600 * np.arange(n), "open": open_, "high": high,
                         "low": low, "close": close, "volume": rng.uniform(1e3, 1e4, n)})


def test_indicators_have_expected_columns():
    out = indicators.compute_native(make_df())
    for col in indicators.NATIVE_COLUMNS:
        assert col in out.columns, col
    assert out["rsi_value"].dropna().between(0, 100).all()


def test_rules_reject_code_injection():
    for bad in ["__import__('os').system('x')", "close.__class__", "open('f')", "[1][0]", "lambda: 1"]:
        with pytest.raises(RuleError):
            compile_rule(bad)


def test_rules_crosses_and_prev():
    df = pd.DataFrame({"a": [1.0, 2, 3, 2, 1], "b": [2.0, 2, 2, 2, 2]})
    up = compile_rule("a crosses above b").evaluate(df).tolist()
    assert up == [False, False, True, False, False]
    assert compile_rule("a > a_prev2").evaluate(df).tolist() == [False, False, True, False, False]
    assert compile_rule("a > 1 AND NOT (a > 2)").evaluate(df).tolist() == [False, True, False, True, False]


def test_unknown_column_rejected():
    with pytest.raises(RuleError):
        compile_rule("rsi_valu < 30", {"rsi_value"})


def test_no_lookahead_fill_at_next_open():
    df = indicators.compute_native(make_df())
    res = simulate(df, StrategySpec(entry_long="rsi_value < 35", exit_long="rsi_value > 60", direction="long"))
    ts_to_open = dict(zip(df["timestamp"], df["open"]))
    for t in res.trades:
        assert t.entry_price == pytest.approx(ts_to_open[t.entry_time])


def test_backtest_and_live_position_agree():
    df = indicators.compute_native(make_df())
    spec = StrategySpec(entry_long="close crosses above ema_value", exit_long="close crosses below ema_value",
                        direction="long", stop_loss_pct=3)
    out = run_backtest(df, spec)
    assert out["position"] in {"long", "flat"}
    assert out["metrics"]["trades"] > 0
    assert len(out["equity_curve"]) <= 300


def test_crypto_roundtrip(monkeypatch):
    import base64
    monkeypatch.setattr(crypto.config, "ENCRYPTION_KEY", base64.b64encode(os.urandom(32)).decode())
    env = crypto.encrypt("0x" + "ab" * 32)
    assert env.startswith("v1.") and crypto.decrypt(env) == "0x" + "ab" * 32


# ---------------- added: sandbox hardening ----------------
@pytest.mark.parametrize("bad", ["'a' * 1000000000 > 1", "max(a, b, c) > 1", "abs(a, b) > 1", "a ** 2 > 1",
                                 "a // 2 > 1", "a is None", "a in b", "True", "x if a else b", "a.b > 1",
                                 "max(*a) > 1", "close > 1 " * 400])
def test_rules_reject_more(bad):
    with pytest.raises(RuleError):
        compile_rule(bad)


def test_max_does_not_mutate_columns():
    df = pd.DataFrame({"a": [1.0, 5.0], "b": [3.0, 2.0]})
    before = df.copy()
    assert compile_rule("max(a, b) > 2").evaluate(df).tolist() == [True, True]
    pd.testing.assert_frame_equal(df, before)


# ---------------- added: simulator semantics ----------------
def bars(opens, highs=None, lows=None, closes=None, **cols):
    n = len(opens)
    df = pd.DataFrame({"timestamp": 3600 * np.arange(n), "open": opens,
                       "high": highs or opens, "low": lows or opens, "close": closes or opens,
                       "volume": [1.0] * n})
    for k, v in cols.items():
        df[k] = v
    return df


def test_entry_fills_next_open_and_exit_next_open():
    df = bars([100, 101, 102, 103, 104], sig=[1, 0, 0, 0, 0], ex=[0, 0, 1, 0, 0])
    res = simulate(df, StrategySpec(entry_long="sig > 0", exit_long="ex > 0", direction="long"), fee=0)
    t = res.trades[0]
    assert (t.entry_price, t.exit_price, t.reason) == (101, 103, "exit_long")
    assert res.position == "flat"


def test_flip_closes_and_reverses_at_same_open():
    df = bars([100, 100, 110, 120, 120], el=[1, 0, 0, 0, 0], es=[0, 0, 1, 0, 0])
    res = simulate(df, StrategySpec(entry_long="el > 0", entry_short="es > 0"), fee=0)
    assert res.trades[0].side == "long" and res.trades[0].exit_price == 120
    assert res.trades[1].side == "short" and res.trades[1].entry_price == 120
    assert res.position == "short"


def test_stop_and_tp_same_bar_assumes_stop():
    df = bars([100, 100, 100, 100], highs=[100, 100, 120, 100], lows=[100, 100, 80, 100], sig=[1, 0, 0, 0])
    res = simulate(df, StrategySpec(entry_long="sig > 0", direction="long", stop_loss_pct=5, take_profit_pct=5), fee=0)
    assert res.trades[0].reason == "stop_loss" and res.trades[0].exit_price == 95


def test_stop_gap_fills_at_open():
    df = bars([100, 100, 90, 90], highs=[100, 100, 91, 90], lows=[100, 100, 89, 90], sig=[1, 0, 0, 0])
    res = simulate(df, StrategySpec(entry_long="sig > 0", direction="long", stop_loss_pct=5), fee=0)
    assert res.trades[0].exit_price == 90       # gapped through the stop: fill at the open, not 95


def test_leveraged_loss_capped_at_margin():
    df = bars([100, 100, 40, 40], sig=[1, 0, 0, 0], ex=[0, 1, 0, 0])
    res = simulate(df, StrategySpec(entry_long="sig > 0", exit_long="ex > 0", direction="long", leverage=5))
    assert res.trades[0].pnl_pct == -100.0
    assert min(e for _, e in res.equity) >= 0


def test_live_position_is_decision_on_last_close():
    # Entry signal on the LAST closed bar: backtest holds no trade yet, but live must go long now.
    df = bars([100, 100, 100], sig=[0, 0, 1])
    res = simulate(df, StrategySpec(entry_long="sig > 0", direction="long"))
    assert res.trades == [] and res.position == "long"


def test_position_matches_truncated_replay():
    """Position emitted at bar k == state the full backtest holds entering bar k+1 (live == backtest)."""
    df = indicators.compute_native(make_df(800, seed=7))
    spec = StrategySpec(entry_long="rsi_value < 40", exit_long="rsi_value > 55", entry_short="rsi_value > 65",
                        exit_short="rsi_value < 50", stop_loss_pct=2, take_profit_pct=4)
    full = simulate(df, spec)
    held = {}
    for t in full.trades:
        end = t.exit_time if t.exit_time is not None else 10**12
        for ts in df["timestamp"]:
            if t.entry_time <= ts < end:
                held[int(ts)] = t.side
    for k in range(300, 790, 37):
        nxt = int(df["timestamp"].iloc[k + 1])
        # Skip bars where a protective stop closed intrabar (live venue stop handles those).
        if any(t.exit_time == nxt and t.reason in ("stop_loss", "take_profit") for t in full.trades):
            continue
        assert simulate(df.iloc[:k + 1].reset_index(drop=True), spec).position == held.get(nxt, "flat"), k


def test_direction_long_never_shorts():
    df = indicators.compute_native(make_df())
    res = simulate(df, StrategySpec(entry_long="rsi_value < 35", entry_short="rsi_value > 65", direction="long"))
    assert all(t.side == "long" for t in res.trades)


# ---------------- added: fee ledger ----------------
def test_fee_rows_skip_zero_and_unique_per_fill():
    from aether.fees import fee_rows
    fills = [{"coin": "xyz:NVDA", "px": "100", "sz": "2", "time": 1_700_000_000_000, "hash": "0xh", "tid": 1,
              "builderFee": "0.06"},
             {"coin": "xyz:NVDA", "px": "100", "sz": "1", "time": 1_700_000_000_000, "hash": "0xh", "tid": 2,
              "builderFee": "0.03"},
             {"coin": "xyz:GOLD", "px": "1", "sz": "1", "time": 1_700_000_000_000, "hash": "0xz", "tid": 3}]
    rows = fee_rows(fills, "acct")
    assert [r["fill_hash"] for r in rows] == ["0xh:1", "0xh:2"]
    assert rows[0]["notional"] == 200 and rows[0]["fee_usd"] == 0.06


# ---------------- added: executor safety ----------------
class _FakeHL:
    def __init__(self, close_ok):
        self.close_ok, self.orders = close_ok, []

    def cancel_stops(self, coin):
        return 0

    def market_order(self, coin, is_buy, qty, reduce_only=False, leverage=None):
        from aether.hyperliquid import BrokerError
        self.orders.append((coin, is_buy, qty, reduce_only))
        if reduce_only and not self.close_ok:
            raise BrokerError("rejected")
        return {"oid": "1", "filled": qty, "avg_px": 100.0, "status": "filled", "requested": qty}


def test_failed_close_blocks_flip(monkeypatch):
    from aether import executor
    from aether.hyperliquid import HLPosition
    monkeypatch.setattr(executor.config, "DRY_RUN", False)
    monkeypatch.setattr(executor, "_record", lambda *a, **k: None)
    hl = _FakeHL(close_ok=False)
    pos = HLPosition("xyz:NVDA", "long", 1.0, 100, 100, 0)
    assert executor._close(None, hl, {"id": "a", "user_id": "u"}, None, "xyz:NVDA", pos, "flip") is False
    assert hl.orders == [("xyz:NVDA", False, 1.0, True)]


def test_master_key_refused():
    from eth_account import Account
    from aether.hyperliquid import BrokerError, HyperliquidAccount
    acct = Account.create()
    with pytest.raises(BrokerError):
        HyperliquidAccount(acct.address, acct.key.hex(), base_url="http://127.0.0.1:9")


def test_orders_require_both_live_gates(monkeypatch):
    from aether.hyperliquid import BrokerError, HyperliquidAccount
    h = HyperliquidAccount.__new__(HyperliquidAccount)
    for dry, ok in [(True, True), (False, False), (True, False)]:
        monkeypatch.setattr("aether.config.DRY_RUN", dry)
        monkeypatch.setattr("aether.config.LIVE_CONFIRMED", ok)
        with pytest.raises(BrokerError):
            h.market_order("xyz:NVDA", True, 1.0, leverage=1)


def test_builder_fee_within_venue_and_user_caps():
    from aether import config
    assert 0 < config.BUILDER_FEE_BPS10 <= 1000      # venue max on perps: 0.1% = 1000 tenths of a bp
    assert config.BUILDER_FEE_BPS10 <= 50            # what users approve in the app (0.05%)


# ---------------- added: risk gates ----------------
class _Q:
    def __init__(self, rows):
        self.rows, self.col = rows, None

    def select(self, *a, **k): return self
    def eq(self, *a, **k): return self
    def gte(self, *a, **k): return self
    def limit(self, *a, **k): return self

    def order(self, col, desc=False):
        self.col, self.desc = col, desc
        return self

    def execute(self):
        rows = self.rows
        if self.col:
            rows = sorted(rows, key=lambda r: float(r[self.col]) if self.col == "equity" else r[self.col],
                          reverse=self.desc)
        return type("R", (), {"data": rows[:1] if self.col else rows})()


class _SB:
    def __init__(self, risk, snaps):
        self.risk, self.snaps = risk, snaps

    def table(self, name):
        return _Q(self.risk if name == "user_risk" else self.snaps)


def _snaps(*equities):
    return [{"equity": e, "created_at": f"2026-01-{i + 1:02d}"} for i, e in enumerate(equities)]


def test_drawdown_gate_blocks_entries():
    from aether.executor import _risk_blocks_entries
    risk = [{"trading_enabled": True, "max_daily_loss_pct": 50, "max_drawdown_pct": 20}]
    acct = {"id": "a", "user_id": "u"}
    assert _risk_blocks_entries(_SB(risk, _snaps(1000, 1200, 1100)), acct, 950) == "max drawdown limit reached"
    assert _risk_blocks_entries(_SB(risk, _snaps(1000, 1200, 1100)), acct, 1000) is None   # -16.7%


def test_drawdown_gate_defaults_and_no_history():
    from aether.executor import _risk_blocks_entries
    acct = {"id": "a", "user_id": "u"}
    assert _risk_blocks_entries(_SB([], []), acct, 100) is None                       # no snapshots yet
    assert _risk_blocks_entries(_SB([], _snaps(2000, 1000)), acct, 1000) is not None   # default 20% / 5%


def test_daily_loss_gate_still_first():
    from aether.executor import _risk_blocks_entries
    risk = [{"trading_enabled": True, "max_daily_loss_pct": 5, "max_drawdown_pct": 90}]
    assert _risk_blocks_entries(_SB(risk, _snaps(1000)), {"id": "a", "user_id": "u"}, 940) == "daily loss limit reached"


def test_trading_disabled_blocks():
    from aether.executor import _risk_blocks_entries
    assert _risk_blocks_entries(_SB([{"trading_enabled": False}], []), {"id": "a", "user_id": "u"}, 1) \
        == "trading disabled by user"
