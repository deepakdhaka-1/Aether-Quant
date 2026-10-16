"""CoinGlass source, OHLCV router, engine-backed indicators, snapshot ingest write rules."""
from datetime import datetime, timezone

import numpy as np
import pandas as pd
import pytest

from aether import data, indicators, ingest
from aether.sources import coinglass


def _ts(s):  # "2026-10-14 13:00" UTC -> epoch s
    return int(datetime.strptime(s, "%Y-%m-%d %H:%M").replace(tzinfo=timezone.utc).timestamp())


# ---------------- CoinGlass ----------------
def test_coinglass_keeps_closed_rth_bars_only():
    # Wed 2026-10-14: 12:00 UTC = 08:00 ET (pre), 13:00 = 09:00 ET (RTH on 1h), 19:00 = 15:00 ET,
    # 20:00 = 16:00 ET (after hours); Sat 2026-10-17 15:00 UTC never in session.
    rows = [[_ts("2026-10-14 12:00"), 1, 2, 0.5, 1.5, 10, "pre_market"],
            [_ts("2026-10-14 13:00"), 1, 2, 0.5, 1.5, 10, "regular"],
            [_ts("2026-10-14 19:00"), 1, 2, 0.5, 1.6, 10, "regular"],
            [_ts("2026-10-14 20:00"), 1, 2, 0.5, 1.7, 10, "after_hours"],
            [_ts("2026-10-17 15:00"), 1, 2, 0.5, 1.7, 10, None],
            [_ts("2026-10-14 13:00"), 1, 2, 0.5, 1.5, 10, "regular"],          # duplicate
            ["bad", 1, 2, 3, 4, 5]]
    df = coinglass.parse(rows, "1h", now=_ts("2026-10-18 00:00"))
    assert df["timestamp"].tolist() == [_ts("2026-10-14 13:00"), _ts("2026-10-14 19:00")]


def test_coinglass_drops_the_forming_bar():
    rows = [[_ts("2026-10-14 13:00"), 1, 2, 0.5, 1.5, 10, "regular"],
            [_ts("2026-10-14 14:00"), 1, 2, 0.5, 1.5, 10, "regular"]]
    df = coinglass.parse(rows, "1h", now=_ts("2026-10-14 14:59"))
    assert df["timestamp"].tolist() == [_ts("2026-10-14 13:00")]


def test_coinglass_4h_keeps_every_bar():
    rows = [[_ts("2026-10-14 08:00"), 1, 2, 0.5, 1.5, 10, "pre_market"]]
    assert len(coinglass.parse(rows, "4h", now=_ts("2026-10-15 00:00"))) == 1


def test_session_stamp():
    assert coinglass.session_stamp(_ts("2026-10-14 19:00"), "1h") == {"bar_et_hour": 15, "is_final_rth_bar": 1}
    assert coinglass.session_stamp(_ts("2026-10-14 13:00"), "1h") == {"bar_et_hour": 9, "is_final_rth_bar": 0}


def test_coinglass_retries_transient_then_fails(monkeypatch):
    calls = []

    class R:
        status_code, ok, text = 503, False, "busy"

    monkeypatch.setattr(coinglass.requests, "get", lambda *a, **k: calls.append(1) or R())
    with pytest.raises(coinglass.CoinglassError):
        coinglass._get("http://x", {}, sleep=lambda s: None)
    assert len(calls) == coinglass.RETRIES


def test_coinglass_asks_calendar_factor(monkeypatch):
    seen = {}

    def fake(symbol, tf, limit):
        seen["limit"] = limit
        return [[_ts("2026-10-14 13:00"), 1, 2, 0.5, 1.5, 10, "regular"]]
    monkeypatch.setattr(coinglass, "fetch_raw", fake)
    coinglass.candles("NVDA", "1h", bars=100)
    assert seen["limit"] == 300


# ---------------- router ----------------
def _ohlcv(n=5):
    return pd.DataFrame({"timestamp": np.arange(n) * 3600, "open": 1.0, "high": 1.0, "low": 1.0,
                         "close": 1.0, "volume": 1.0})


def test_router_uses_coinglass_for_equities_and_falls_back(monkeypatch):
    monkeypatch.setattr(coinglass, "candles", lambda *a, **k: _ohlcv())
    monkeypatch.setattr(data, "hl_candles", lambda *a, **k: _ohlcv(3))
    eq = {"asset_class": "equity", "hl_coin": "xyz:NVDA"}
    assert data.ohlcv("NVDA", "1h", market=eq).attrs["source"] == "coinglass"

    def boom(*a, **k):
        raise coinglass.CoinglassError("down")
    monkeypatch.setattr(coinglass, "candles", boom)
    df = data.ohlcv("NVDA", "1h", market=eq)
    assert df.attrs["source"] == "hyperliquid" and len(df) == 3


def test_router_sends_commodities_to_hyperliquid(monkeypatch):
    monkeypatch.setattr(coinglass, "candles", lambda *a, **k: pytest.fail("CoinGlass used for a commodity"))
    monkeypatch.setattr(data, "hl_candles", lambda coin, *a, **k: _ohlcv(2).assign(coin=coin))
    df = data.ohlcv("GOLD", "4h", market={"asset_class": "commodity", "hl_coin": "xyz:GOLD"})
    assert df.attrs["source"] == "hyperliquid" and df["coin"].iat[0] == "xyz:GOLD"


# ---------------- indicators ----------------
def _walk(n=700, seed=0):
    rng = np.random.default_rng(seed)
    c = 100 + np.cumsum(rng.normal(0, 1, n))
    return pd.DataFrame({"timestamp": 1_700_000_000 + 3600 * np.arange(n), "open": c, "high": c + 1,
                         "low": c - 1, "close": c + rng.normal(0, .2, n), "volume": rng.uniform(1e3, 2e3, n)})


def test_engine_output_is_causal():
    df = _walk()
    out = indicators.compute(df, "1h")
    assert not [c for c in out.columns if c.startswith("price_after") or "correl" in c]
    assert "kvo_value" in out.columns and "ichimoku_spanA" in out.columns     # engine, not native
    np.testing.assert_allclose(out["price_change"].iloc[1:], df["close"].pct_change().iloc[1:] * 100)
    # no indicator value at bar i may change when later bars are appended
    cut = indicators.compute(df.iloc[:600], "1h")
    for col in ("rsi_value", "macdext_MACD", "dpo_value", "atr_value", "bbands_UpperBand", "supertrend_value"):
        np.testing.assert_allclose(out[col].iloc[580:600].to_numpy(dtype=float),
                                   cut[col].iloc[580:600].to_numpy(dtype=float), rtol=1e-9, err_msg=col)


def test_engine_failure_falls_back_to_native(monkeypatch):
    def boom(*a, **k):
        raise RuntimeError("engine down")
    monkeypatch.setattr(indicators, "compute_engine", boom)
    out = indicators.compute(_walk(200), "1h")
    assert set(indicators.NATIVE_COLUMNS) <= set(out.columns) and "kvo_value" not in out.columns


# ---------------- ingest write rules ----------------
def _built(n):
    return [{"timestamp": i, "obv_value": float(i), "ad_value": None, "wad_value": 1.0} for i in range(n)]


def test_ingest_skips_warmup_and_writes_only_missing_plus_latest():
    stored = {i: {"timestamp": i, "obv_value": float(i), "ad_value": None, "wad_value": 1.0} for i in range(5, 8)}
    w = ingest.select_writes(_built(10), stored, warmup=5)
    assert [r["timestamp"] for r in w] == [8, 9]          # 5..7 stored; 8, 9 new (= newest 2)
    w = ingest.select_writes(_built(10), {i: stored.get(i, {"timestamp": i}) for i in range(5, 10)}, warmup=5)
    assert [r["timestamp"] for r in w] == [8, 9]          # the newest 2 are always rewritten


def test_ingest_shifts_running_totals_onto_stored_series():
    stored = {6: {"timestamp": 6, "obv_value": 1006.0, "wad_value": 1.0}}
    w = ingest.select_writes(_built(10), stored, warmup=5)
    by = {r["timestamp"]: r for r in w}
    assert by[9]["obv_value"] == 1009.0 and by[5]["obv_value"] == 1005.0


def test_ingest_rows_carry_label_and_session():
    ind = indicators.compute(_walk(50), "1h")
    rows = ingest.build_rows(ind, "1h", "equity", "coinglass")
    assert rows[0]["price_after_1_h"] == pytest.approx(float(ind["close"].iat[1]))
    assert rows[-1]["price_after_1_h"] is None
    assert "bar_et_hour" in rows[0] and rows[0]["source"] == "coinglass"
    assert ingest.table_name("nvda", "4h") == "NVDA_4H_TAAPI_Indicator_snapshot"
