"""Indicator computation.

Two backends, same column names (TAAPI-style naming used by the indicator snapshot tables,
e.g. rsi_value, macdext_MACD, bbands_UpperBand):

* engine  -- aether/ta/engine.py (~140 indicators, pandas_ta_classic). PRIMARY.
* native  -- the core set below, pure pandas/numpy. Used only if the engine raises, and to fill
             any core column the engine did not produce.

Causality: the engine also emits training labels and centred values. Before anything reaches a
strategy, compute() drops price_after_* / price_change_pct / *_correl_* and the raw pandas_ta
columns, recomputes price_change as the BACKWARD % change, and replaces dpo_value with a causal
DPO (close[i-11] - SMA20[i]) -- the same formula the snapshot ingest uses.
"""
from __future__ import annotations

import logging
import warnings

import numpy as np
import pandas as pd

TF_TO_ENGINE = {"15m": "15_min", "1h": "1_h", "4h": "4_h", "1d": "1_d"}


def _rma(s: pd.Series, n: int) -> pd.Series:
    return s.ewm(alpha=1.0 / n, adjust=False, min_periods=n).mean()


def _ema(s: pd.Series, n: int) -> pd.Series:
    return s.ewm(span=n, adjust=False, min_periods=n).mean()


def _true_range(h, l, c):
    pc = c.shift(1)
    return pd.concat([h - l, (h - pc).abs(), (l - pc).abs()], axis=1).max(axis=1)


def compute_native(df: pd.DataFrame) -> pd.DataFrame:
    out = df.copy()
    o, h, l, c, v = (out[k].astype(float) for k in ("open", "high", "low", "close", "volume"))
    out["price_value"] = c
    out["price_change"] = c.pct_change() * 100

    # Momentum
    d = c.diff()
    rs = _rma(d.clip(lower=0), 14) / _rma(-d.clip(upper=0), 14)
    out["rsi_value"] = 100 - 100 / (1 + rs)
    ll, hh = l.rolling(14).min(), h.rolling(14).max()
    k = 100 * (c - ll) / (hh - ll)
    out["stoch_K"] = k.rolling(3).mean()
    out["stoch_D"] = out["stoch_K"].rolling(3).mean()
    r = out["rsi_value"]
    srsi = 100 * (r - r.rolling(14).min()) / (r.rolling(14).max() - r.rolling(14).min())
    out["stochrsi_FastK"] = srsi.rolling(3).mean()
    out["stochrsi_FastD"] = out["stochrsi_FastK"].rolling(3).mean()
    tp = (h + l + c) / 3
    md = tp.rolling(20).apply(lambda x: np.mean(np.abs(x - x.mean())), raw=True)
    out["cci_value"] = (tp - tp.rolling(20).mean()) / (0.015 * md)
    out["mom_value"] = c - c.shift(10)
    out["roc_value"] = c.pct_change(10) * 100
    out["willr_value"] = -100 * (hh - c) / (hh - ll)
    m9 = (h + l) / 2
    x = ((m9 - m9.rolling(10).min()) / (m9.rolling(10).max() - m9.rolling(10).min()) - 0.5) * 2
    x = x.clip(-0.999, 0.999).fillna(0)
    val = np.zeros(len(x)); fish = np.zeros(len(x))
    for i in range(1, len(x)):
        val[i] = 0.33 * 2 * x.iloc[i] + 0.67 * val[i - 1]
        val[i] = min(max(val[i], -0.999), 0.999)
        fish[i] = 0.5 * np.log((1 + val[i]) / (1 - val[i])) + 0.5 * fish[i - 1]
    out["fisher_fisher"] = fish
    out["fisher_fisher_signal"] = pd.Series(fish, index=out.index).shift(1)

    # Trend
    out["ema_value"] = _ema(c, 20)
    out["dema_value"] = 2 * _ema(c, 20) - _ema(_ema(c, 20), 20)
    macd = _ema(c, 12) - _ema(c, 26)
    out["macdext_MACD"] = macd
    out["macdext_MACDSignal"] = _ema(macd, 9)
    out["macdext_MACDHist"] = macd - out["macdext_MACDSignal"]
    up, dn = h.diff(), -l.diff()
    pdm = pd.Series(np.where((up > dn) & (up > 0), up, 0.0), index=out.index)
    mdm = pd.Series(np.where((dn > up) & (dn > 0), dn, 0.0), index=out.index)
    tr = _true_range(h, l, c)
    atr = _rma(tr, 14)
    pdi, mdi = 100 * _rma(pdm, 14) / atr, 100 * _rma(mdm, 14) / atr
    dx = 100 * (pdi - mdi).abs() / (pdi + mdi)
    out["dmi_plusdi"], out["dmi_minusdi"] = pdi, mdi
    out["dmi_adx"] = out["adx_value"] = _rma(dx, 14)
    out["aroon_AroonUp"] = 100 * h.rolling(26).apply(np.argmax, raw=True) / 25
    out["aroon_AroonDown"] = 100 * l.rolling(26).apply(np.argmin, raw=True) / 25
    out["aroonosc_value"] = out["aroon_AroonUp"] - out["aroon_AroonDown"]

    # Supertrend (10, 3)
    atr10 = _rma(tr, 10)
    mid = (h + l) / 2
    ub, lb = (mid + 3 * atr10).to_numpy(), (mid - 3 * atr10).to_numpy()
    cc = c.to_numpy()
    st = np.full(len(cc), np.nan); adv = np.array([""] * len(cc), dtype=object)
    fub, flb, trend = ub.copy(), lb.copy(), 1
    for i in range(1, len(cc)):
        if np.isnan(ub[i]):
            continue
        fub[i] = ub[i] if (np.isnan(fub[i - 1]) or ub[i] < fub[i - 1] or cc[i - 1] > fub[i - 1]) else fub[i - 1]
        flb[i] = lb[i] if (np.isnan(flb[i - 1]) or lb[i] > flb[i - 1] or cc[i - 1] < flb[i - 1]) else flb[i - 1]
        if trend == 1 and cc[i] < flb[i]:
            trend = -1
        elif trend == -1 and cc[i] > fub[i]:
            trend = 1
        st[i] = flb[i] if trend == 1 else fub[i]
        adv[i] = "long" if trend == 1 else "short"
    out["supertrend_value"], out["supertrend_Advice"] = st, adv

    # Volatility
    out["atr_value"] = atr
    out["natr_value"] = 100 * atr / c
    sma20, sd20 = c.rolling(20).mean(), c.rolling(20).std(ddof=0)
    out["bbands_MiddleBand"] = sma20
    out["bbands_UpperBand"] = sma20 + 2 * sd20
    out["bbands_LowerBand"] = sma20 - 2 * sd20
    out["bbw_value"] = (out["bbands_UpperBand"] - out["bbands_LowerBand"]) / sma20
    out["chop_value"] = 100 * np.log10(tr.rolling(14).sum() / (hh - ll)) / np.log10(14)

    # Volume
    out["obv_value"] = (np.sign(c.diff()).fillna(0) * v).cumsum()
    mfm = ((c - l) - (h - c)) / (h - l).replace(0, np.nan)
    out["cmf_value"] = (mfm * v).rolling(20).sum() / v.rolling(20).sum()
    rmf = tp * v
    pos = rmf.where(tp > tp.shift(1), 0.0).rolling(14).sum()
    neg = rmf.where(tp < tp.shift(1), 0.0).rolling(14).sum()
    out["mfi_value"] = 100 - 100 / (1 + pos / neg)
    out["vosc_value"] = 100 * (v.rolling(5).mean() - v.rolling(10).mean()) / v.rolling(10).mean()
    out["vwap_value"] = (tp * v).rolling(20).sum() / v.rolling(20).sum()
    out["volume_value"] = v
    return out


NATIVE_COLUMNS = [
    "price_value", "price_change", "rsi_value", "stoch_K", "stoch_D", "stochrsi_FastK", "stochrsi_FastD",
    "cci_value", "mom_value", "roc_value", "willr_value", "fisher_fisher", "fisher_fisher_signal",
    "ema_value", "dema_value", "macdext_MACD", "macdext_MACDSignal", "macdext_MACDHist",
    "dmi_plusdi", "dmi_minusdi", "dmi_adx", "adx_value", "aroon_AroonUp", "aroon_AroonDown",
    "aroonosc_value", "supertrend_value", "atr_value", "natr_value", "bbands_UpperBand",
    "bbands_MiddleBand", "bbands_LowerBand", "bbw_value", "chop_value", "obv_value", "cmf_value",
    "mfi_value", "vosc_value", "vwap_value", "volume_value",
]


log = logging.getLogger("aether.indicators")

DPO_PERIOD = 20
DPO_BACK = DPO_PERIOD // 2 + 1
# Columns the engine marks as booleans ("TRUE"/"FALSE"); turned into 1.0/0.0 so rules can use them.
_BOOL_COLUMNS = (
    "tdsequential_sellSetup", "tdsequential_buySetup", "tdsequential_sellSetupPerfection",
    "tdsequential_buySetupPerfection", "tdsequential_bearishFlip", "tdsequential_bullishFlip",
    "tdsequential_countdownIndexIsEqualToPreviousElement", "tdsequential_countdownResetForTDST",
)
STRING_COLUMNS = {"supertrend_Advice", "rvgi_trend", "timestampHuman"}


def causal_dpo(close: pd.Series) -> pd.Series:
    """Detrended price oscillator from past bars only: close[i-11] - SMA20[i]."""
    c = close.astype(float)
    return c.shift(DPO_BACK) - c.rolling(DPO_PERIOD).mean()


def compute_engine(df: pd.DataFrame, timeframe: str = "1h") -> pd.DataFrame:
    """Run the full engine and return a causal frame: OHLCV + engine indicator columns."""
    from .ta import engine
    with warnings.catch_warnings():
        warnings.simplefilter("ignore")
        raw = engine.generate_indicators_and_correlations(
            df[["timestamp", "open", "high", "low", "close", "volume"]].copy(),
            timeframe=TF_TO_ENGINE.get(timeframe, "1_h"), taapi_compat=True)
    if len(raw) != len(df):
        raise RuntimeError(f"engine returned {len(raw)} rows for {len(df)} bars")
    keep = [c for c in engine.EXPECTED_INDICATORS if c in raw.columns]
    out = df.reset_index(drop=True).copy()
    ind = raw[keep].reset_index(drop=True)
    for col in _BOOL_COLUMNS:
        if col in ind.columns:
            ind[col] = ind[col].astype(str).str.upper().map({"TRUE": 1.0, "FALSE": 0.0})
    for col in ind.columns:
        if col not in STRING_COLUMNS and not pd.api.types.is_numeric_dtype(ind[col]):
            ind[col] = pd.to_numeric(ind[col], errors="coerce")
    out = pd.concat([out, ind], axis=1)
    c = out["close"].astype(float)
    out["price_value"] = c
    out["price_change"] = c.pct_change() * 100           # backward-looking; the engine's is forward
    out["dpo_value"] = causal_dpo(c)
    return out


def compute(df: pd.DataFrame, timeframe: str = "1h") -> pd.DataFrame:
    """OHLCV (columns timestamp[epoch s], open, high, low, close, volume) -> OHLCV + indicators.

    Engine first; the native set only if the engine fails. Core columns the engine lacks are
    filled from the native set so a rule never references a missing column.
    """
    df = df.sort_values("timestamp").drop_duplicates("timestamp").reset_index(drop=True)
    if df.empty:
        return compute_native(df) if len(df.columns) else df
    try:
        res = compute_engine(df, timeframe)
    except Exception as e:                                # noqa: BLE001 - fall back, never crash a pass
        log.warning("indicator engine failed (%s); using native set", e)
        return compute_native(df)
    missing = [c for c in NATIVE_COLUMNS if c not in res.columns]
    if missing:
        native = compute_native(df)
        for col in missing:
            res[col] = native[col].values
    return res
