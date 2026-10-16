"""Aether indicator engine: OHLCV -> the full indicator set (~140 columns, TAAPI-compatible names).

Primary backend behind aether.indicators.compute(). Some raw outputs here are forward-looking
(price_after_*, the forward price_change, centred dpo, *_correl_* columns); indicators.compute()
strips or recomputes those before any strategy sees them.
"""
import re
import numpy as np
import pandas as pd
import pandas_ta_classic as ta
import io


# Core indicator columns (dynamically extended with timestamp + OHLCV in generate_indicators_and_correlations)
EXPECTED_INDICATORS = [
    # Momentum (17)
    "rsi_value", "stoch_K", "stoch_D", "stochf_FastK", "stochf_FastD",
    "stochrsi_FastK", "stochrsi_FastD", "cci_value", "mom_value", "roc_value", "ppo_value", "apo_value", "trix_value",
    "kdj_K", "kdj_D", "kdj_J", "cmo_value",
    # Trend (17)
    "ema_value", "dema_value", "zlema_value", "hma_value", "kama_value",
    "macdext_MACD", "macdext_MACDSignal", "macdext_MACDHist", "supertrend_value",
    "supertrend_Advice", "ht_trendline_value", "ht_trendmode_value", "psar_value", "aroon_AroonDown",
    "aroon_AroonUp", "aroonosc_value", "dpo_value",
    # Volatility (14)
    "atr_value", "natr_value", "bbands_UpperBand", "bbands_MiddleBand", "bbands_LowerBand",
    "bbw_value", "bbw_upperBand", "bbw_lowerBand", "bbw_middleBand",
    "accbands_UpperBand", "accbands_MiddleBand", "accbands_LowerBand", "chop_value", "ultosc_value",
    # Volume (16)
    "obv_value", "adosc_value", "mfi_value", "cmf_value", "vosc_value", "kvo_value", "volumesplit_Total",
    "volumesplit_Buy", "volumesplit_Sell", "volumesplit_percentBuy", "volumesplit_percentSell", "wad_value",
    "ad_value", "accosc_value", "marketfi_value", "eom_value",
    # Pattern (7)
    "doji_value", "hangingman_value", "harami_value", "belthold_value",
    "closingmarubozu_value", "highwave_value", "spinningtop_value",
    # Oscillators (3)
    "ao_value", "bop_value", "coppockcurve_value",
    # Advanced & Exotic (51)
    "ichimoku_conversion", "ichimoku_base", "ichimoku_spanA", "ichimoku_spanB",
    "ichimoku_currentSpanA", "ichimoku_currentSpanB", "ichimoku_laggingSpanA", "ichimoku_laggingSpanB",
    "tdsequential_buySetupIndex", "tdsequential_sellSetupIndex", "tdsequential_buyCoundownIndex",
    "tdsequential_sellCoundownIndex", "tdsequential_countdownIndexIsEqualToPreviousElement", "tdsequential_sellSetup",
    "tdsequential_buySetup", "tdsequential_sellSetupPerfection", "tdsequential_buySetupPerfection",
    "tdsequential_bearishFlip", "tdsequential_bullishFlip", "tdsequential_TDSTBuy", "tdsequential_TDSTSell",
    "tdsequential_countdownResetForTDST", "vortex_plus", "vortex_minus", "rvgi_value", "rvgi_signal", "rvgi_trend",
    "williamsalligator_Jaws", "williamsalligator_Teeth", "williamsalligator_Lips", "willr_value", "fisher_fisher",
    "fisher_fisher_signal", "msw_msw_sine", "msw_msw_lead", "dmi_adx", "dmi_plusdi", "dmi_minusdi", "adx_value",
    "adxr_value", "plus_di_value", "minus_di_value", "plus_dm_value", "minus_dm_value", "dx_value",
    "ht_dcperiod_value", "ht_dcphase_value", "ht_phasor_InPhase", "ht_phasor_Quadrature", "ht_sine_Sine",
    "ht_sine_LeadSine",
    # Utility (12)
    "abs_value", "add_value", "mul_value", "mult_value", "cos_value", "sin_value",
    "ceil_value", "avgprice_value", "vwap_value", "pd_value", "beta_value", "volume_value"
]

# Price and timing fields (added dynamically)
PRICE_AND_TIME_COLUMNS = ["timestamp", "timestampHuman", "price_value", "price_change", "open", "high", "low", "close", "volume"]

# All expected columns used in verification
EXPECTED_COLUMNS = PRICE_AND_TIME_COLUMNS + EXPECTED_INDICATORS


def _normalize_timeframe(timeframe: str) -> str:
    if not timeframe:
        return "12_h"
    tf = str(timeframe).strip().lower().replace("-", "_").replace(" ", "")
    if re.match(r"^\d+_min$", tf):
        return tf
    if re.match(r"^\d+_[mhdw]$", tf):
        return tf
    if re.match(r"^\d+(min|m|h|d|w)$", tf):
        n = re.findall(r"\d+", tf)[0]
        unit = re.findall(r"[a-z]+", tf)[0]
        if unit == "min":
            return f"{n}_min"
        if unit == "m":
            return f"{n}_m"
        if unit == "h":
            return f"{n}_h"
        if unit == "d":
            return f"{n}_d"
        if unit == "w":
            return f"{n}_w"
    return "12_h"


def _timeframe_to_seconds(tf: str) -> int:
    n_str, unit = tf.split("_", 1)
    n = int(n_str)
    factor = {"m": 60, "min": 60, "h": 3600, "d": 86400, "w": 604800}
    return n * factor.get(unit, 3600)


def _to_datetime_series(ts: pd.Series) -> pd.Series:
    """Parse mixed timestamp formats into datetime for internal calculations."""
    num = pd.to_numeric(ts, errors="coerce")
    if num.notna().any():
        as_sec = pd.to_datetime(num.where(num <= 1e10, num / 1000.0), unit="s", errors="coerce")
        if as_sec.notna().any():
            return as_sec
        as_ms = pd.to_datetime(num, unit="ms", errors="coerce")
        return as_ms

    parsed = pd.to_datetime(ts, errors="coerce")
    return parsed


def _format_timestamp_human(ts: pd.Series, include_weekday: bool = False) -> pd.Series:
    """Format timestamps without strftime to avoid out-of-range Timestamp errors."""
    dt = ts if pd.api.types.is_datetime64_any_dtype(ts) else pd.to_datetime(ts, errors="coerce")
    out = pd.Series(np.nan, index=dt.index, dtype=object)
    valid = dt.notna()
    if not valid.any():
        return out

    year = dt.dt.year.astype("Int64").astype(str).str.zfill(4)
    month = dt.dt.month.astype("Int64").astype(str).str.zfill(2)
    day = dt.dt.day.astype("Int64").astype(str).str.zfill(2)
    hour = dt.dt.hour.astype("Int64").astype(str).str.zfill(2)
    minute = dt.dt.minute.astype("Int64").astype(str).str.zfill(2)
    second = dt.dt.second.astype("Int64").astype(str).str.zfill(2)

    human = year + "-" + month + "-" + day + " " + hour + ":" + minute + ":" + second
    if include_weekday:
        weekday_map = {
            0: "Monday",
            1: "Tuesday",
            2: "Wednesday",
            3: "Thursday",
            4: "Friday",
            5: "Saturday",
            6: "Sunday",
        }
        weekday = dt.dt.dayofweek.map(weekday_map)
        human = human + " (" + weekday + ") UTC"

    out.loc[valid] = human.loc[valid]
    return out


def _infer_shift_periods(df: pd.DataFrame, tf: str) -> int:
    if "timestamp" not in df.columns:
        return 1
    ts = _to_datetime_series(df["timestamp"])
    diffs = ts.sort_values().diff().dropna().dt.total_seconds()
    if diffs.empty:
        return 1
    base = diffs.median()
    if not base or base <= 0:
        return 1
    target = _timeframe_to_seconds(tf)
    return max(1, int(round(target / base)))


def _run_ta(df: pd.DataFrame, fn):
    before = set(df.columns)
    try:
        fn()
    except Exception:
        return []
    return [c for c in df.columns if c not in before]


def _assign_from_cols(df: pd.DataFrame, cols, targets):
    for idx, target in enumerate(targets):
        if idx < len(cols):
            df[target] = df[cols[idx]]


def _pick_col(cols, patterns):
    upper = [c.upper() for c in cols]
    for p in patterns:
        p_up = p.upper()
        for idx, c_up in enumerate(upper):
            if p_up in c_up:
                return cols[idx]
    return None


def _wilder_rma(series: pd.Series, length: int) -> pd.Series:
    """Welles Wilder's RMA (a.k.a. SMMA)."""
    s = pd.to_numeric(series, errors="coerce")
    length = max(1, int(length))
    return s.ewm(alpha=1.0 / length, adjust=False, min_periods=length).mean()


def _ema(series: pd.Series, length: int) -> pd.Series:
    s = pd.to_numeric(series, errors="coerce")
    length = max(1, int(length))
    return s.ewm(span=length, adjust=False, min_periods=length).mean()


def _compute_td_sequential(close: pd.Series, high: pd.Series, low: pd.Series) -> dict[str, pd.Series]:
    """Compute a DeMark-style setup/countdown approximation with no external dependency."""
    c = pd.to_numeric(close, errors="coerce").reset_index(drop=True)
    h = pd.to_numeric(high, errors="coerce").reset_index(drop=True)
    l = pd.to_numeric(low, errors="coerce").reset_index(drop=True)
    n = len(c)

    buy_setup = np.zeros(n, dtype=float)
    sell_setup = np.zeros(n, dtype=float)
    buy_setup_flag = np.zeros(n, dtype=float)
    sell_setup_flag = np.zeros(n, dtype=float)
    buy_perf = np.zeros(n, dtype=float)
    sell_perf = np.zeros(n, dtype=float)
    bearish_flip = np.zeros(n, dtype=float)
    bullish_flip = np.zeros(n, dtype=float)
    buy_cd = np.zeros(n, dtype=float)
    sell_cd = np.zeros(n, dtype=float)

    for i in range(n):
        if i >= 4 and pd.notna(c.iloc[i]) and pd.notna(c.iloc[i - 4]):
            # DeMark-style setup condition: compare close to close 4 bars earlier.
            # Use <= / >= to match the common TD Sequential definition.
            buy_setup[i] = (buy_setup[i - 1] + 1.0) if c.iloc[i] <= c.iloc[i - 4] else 0.0
            sell_setup[i] = (sell_setup[i - 1] + 1.0) if c.iloc[i] >= c.iloc[i - 4] else 0.0
        buy_setup[i] = min(buy_setup[i], 9.0)
        sell_setup[i] = min(sell_setup[i], 9.0)
        buy_setup_flag[i] = 1.0 if buy_setup[i] >= 9.0 else 0.0
        sell_setup_flag[i] = 1.0 if sell_setup[i] >= 9.0 else 0.0

    for i in range(5, n):
        if pd.notna(c.iloc[i]) and pd.notna(c.iloc[i - 4]) and pd.notna(c.iloc[i - 1]) and pd.notna(c.iloc[i - 5]):
            bearish_flip[i] = 1.0 if (c.iloc[i] < c.iloc[i - 4] and c.iloc[i - 1] > c.iloc[i - 5]) else 0.0
            bullish_flip[i] = 1.0 if (c.iloc[i] > c.iloc[i - 4] and c.iloc[i - 1] < c.iloc[i - 5]) else 0.0

    for i in range(8, n):
        if buy_setup[i] >= 9.0:
            buy_perf[i] = 1.0 if min(l.iloc[i], l.iloc[i - 1]) <= min(l.iloc[i - 2], l.iloc[i - 3]) else 0.0
        if sell_setup[i] >= 9.0:
            sell_perf[i] = 1.0 if max(h.iloc[i], h.iloc[i - 1]) >= max(h.iloc[i - 2], h.iloc[i - 3]) else 0.0

    buy_active = False
    sell_active = False
    buy_cd_count = 0.0
    sell_cd_count = 0.0
    for i in range(n):
        # Important: buy_setup/sell_setup are capped at 9, so once a setup completes it may
        # remain == 9 for multiple bars. Only treat the FIRST bar that reaches 9 as the
        # setup completion trigger; otherwise we'd constantly reset countdown/TDST levels.
        buy_setup_completed = (buy_setup[i] == 9.0 and (i == 0 or buy_setup[i - 1] < 9.0))
        sell_setup_completed = (sell_setup[i] == 9.0 and (i == 0 or sell_setup[i - 1] < 9.0))

        if buy_setup_completed:
            buy_active = True
            buy_cd_count = 0.0
        if sell_setup_completed:
            sell_active = True
            sell_cd_count = 0.0

        if buy_active and i >= 2 and pd.notna(c.iloc[i]) and pd.notna(l.iloc[i - 2]) and c.iloc[i] <= l.iloc[i - 2]:
            buy_cd_count = min(13.0, buy_cd_count + 1.0)
        if sell_active and i >= 2 and pd.notna(c.iloc[i]) and pd.notna(h.iloc[i - 2]) and c.iloc[i] >= h.iloc[i - 2]:
            sell_cd_count = min(13.0, sell_cd_count + 1.0)

        buy_cd[i] = buy_cd_count
        sell_cd[i] = sell_cd_count

        if buy_cd_count >= 13.0:
            buy_active = False
        if sell_cd_count >= 13.0:
            sell_active = False

    # TDST: In the provided baselines, TDSTBuy/TDSTSell are simple rolling extremes.
    tdst_buy = l.rolling(9, min_periods=1).min().to_numpy()
    tdst_sell = h.rolling(9, min_periods=1).max().to_numpy()

    countdown_eq_prev = np.zeros(n, dtype=float)
    for i in range(1, n):
        # A pause means the count today is same as yesterday, but ONLY if we are in an active countdown (>0)
        pausing = (buy_cd[i] == buy_cd[i - 1] and buy_cd[i] > 0) or (sell_cd[i] == sell_cd[i - 1] and sell_cd[i] > 0)
        countdown_eq_prev[i] = 1.0 if pausing else 0.0

    return {
        "tdsequential_buySetupIndex": pd.Series(buy_setup),
        "tdsequential_sellSetupIndex": pd.Series(sell_setup),
        "tdsequential_buyCoundownIndex": pd.Series(buy_cd),
        "tdsequential_sellCoundownIndex": pd.Series(sell_cd),
        "tdsequential_countdownIndexIsEqualToPreviousElement": pd.Series(countdown_eq_prev),
        "tdsequential_sellSetup": pd.Series(sell_setup_flag),
        "tdsequential_buySetup": pd.Series(buy_setup_flag),
        "tdsequential_sellSetupPerfection": pd.Series(sell_perf),
        "tdsequential_buySetupPerfection": pd.Series(buy_perf),
        "tdsequential_bearishFlip": pd.Series(bearish_flip),
        "tdsequential_bullishFlip": pd.Series(bullish_flip),
        "tdsequential_TDSTBuy": pd.Series(tdst_buy),
        "tdsequential_TDSTSell": pd.Series(tdst_sell),
        "tdsequential_countdownResetForTDST": pd.Series(((pd.Series(buy_cd) == 0.0) | (pd.Series(sell_cd) == 0.0)).astype(float)),
    }


def generate_indicators_and_correlations(
    df: pd.DataFrame,
    timeframe: str = "12_h",
    taapi_compat: bool = False,
) -> pd.DataFrame:
    """
    Build all documented indicator output fields and correlation columns.
    Required source columns: open, high, low, close, volume.
    """
    df = df.copy()
    df.columns = df.columns.astype(str).str.lower()

    required = ["open", "high", "low", "close", "volume"]
    if not all(col in df.columns for col in required):
        raise ValueError("DataFrame must contain 'open', 'high', 'low', 'close', 'volume' columns.")

    # Normalize OHLCV fields across heterogeneous datasets (string numbers, commas, whitespace).
    for col in required:
        raw = df[col]
        if pd.api.types.is_numeric_dtype(raw):
            num = pd.to_numeric(raw, errors="coerce")
        else:
            txt = raw.astype(str).str.strip()
            txt = txt.str.replace(",", "", regex=False)
            txt = txt.replace({"": np.nan, "none": np.nan, "nan": np.nan, "null": np.nan})
            num = pd.to_numeric(txt, errors="coerce")

        if num.notna().any():
            # Keep continuity for indicator computation when only a few malformed cells exist.
            num = num.interpolate(method="linear", limit_direction="both").ffill().bfill()
        df[col] = num

    if pd.to_numeric(df["close"], errors="coerce").isna().all():
        raise ValueError("Column 'close' could not be parsed as numeric values.")

    if "timestamphuman" in df.columns and "timestamp" not in df.columns:
        df["timestamp"] = df["timestamphuman"]
    if "timestamp" in df.columns:
        raw_timestamp = df["timestamp"].copy()
        if raw_timestamp.dtype == object:
            raw_timestamp = raw_timestamp.astype(str).str.replace(r" \(\w+\)", "", regex=True)

        parsed_timestamp = _to_datetime_series(raw_timestamp)

        if parsed_timestamp.notna().any():
            df["_timestamp_dt"] = parsed_timestamp
            df = df.dropna(subset=["_timestamp_dt"]).sort_values("_timestamp_dt").reset_index(drop=True)
            df["timestamp"] = df["_timestamp_dt"].map(lambda x: int(x.timestamp()) if pd.notna(x) else np.nan).astype("int64")
            df["timestampHuman"] = _format_timestamp_human(df["_timestamp_dt"], include_weekday=True)
            df = df.drop(columns=["_timestamp_dt"])
        else:
            # Keep deterministic non-empty timestamps when source values are unavailable.
            df = df.reset_index(drop=True)
            df["timestamp"] = np.arange(1, len(df) + 1, dtype=np.int64)
            raw_human = raw_timestamp.astype(str)
            fallback_human = df["timestamp"].astype(str)
            df["timestampHuman"] = raw_human.where(~raw_human.isin(["nan", "NaT", "None", ""]), fallback_human)
    else:
        df = df.reset_index(drop=True)
        df["timestamp"] = np.arange(1, len(df) + 1, dtype=np.int64)
        df["timestampHuman"] = df["timestamp"].astype(str)

    tf = _normalize_timeframe(timeframe)
    shift_periods = _infer_shift_periods(df, tf)
    future_col = f"price_after_{tf}"
    n_rows = len(df)

    # Adapt lookback windows so short datasets still emit indicator columns.
    def _cap_len(default_len: int, min_len: int = 2) -> int:
        upper = max(min_len, n_rows - 1)
        return max(min_len, min(default_len, upper))

    # Base and target fields
    df["price_value"] = pd.to_numeric(df["close"], errors="coerce")
    df[future_col] = pd.to_numeric(df["close"], errors="coerce").shift(-shift_periods)
    df["price_change"] = ((df[future_col] - df["price_value"]) / df["price_value"]) * 100.0
    df["price_change"] = pd.to_numeric(df["price_change"], errors="coerce")  # keep float64
    df["price_change_pct"] = df["price_change"] / 100.0
    if "timestampHuman" not in df.columns:
        parsed_ts = _to_datetime_series(df["timestamp"])
        ts_human = _format_timestamp_human(parsed_ts)
        df["timestampHuman"] = ts_human.where(ts_human.notna(), df["timestamp"].astype(str))

    # Core indicators with explicit period alignment to mapping doc.
    _assign_from_cols(df, _run_ta(df, lambda: df.ta.rsi(length=14, append=True)), ["rsi_value"])
    _assign_from_cols(
        df,
        _run_ta(df, lambda: df.ta.stoch(k=5, d=3, smooth_k=3, append=True)),
        ["stoch_K", "stoch_D"],
    )
    _assign_from_cols(
        df,
        _run_ta(df, lambda: df.ta.stochf(k=5, d=3, append=True)),
        ["stochf_FastK", "stochf_FastD"],
    )
    _assign_from_cols(
        df,
        _run_ta(df, lambda: df.ta.stochrsi(length=14, rsi_length=14, k=5, d=3, append=True)),
        ["stochrsi_FastK", "stochrsi_FastD"],
    )
    _assign_from_cols(df, _run_ta(df, lambda: df.ta.cci(length=14, append=True)), ["cci_value"])
    _assign_from_cols(df, _run_ta(df, lambda: df.ta.mom(length=10, append=True)), ["mom_value"])
    _assign_from_cols(df, _run_ta(df, lambda: df.ta.roc(length=10, append=True)), ["roc_value"])
    _assign_from_cols(df, _run_ta(df, lambda: df.ta.ppo(append=True)), ["ppo_value"])
    _assign_from_cols(df, _run_ta(df, lambda: df.ta.apo(append=True)), ["apo_value"])
    _assign_from_cols(df, _run_ta(df, lambda: df.ta.trix(length=_cap_len(30, min_len=3), append=True)), ["trix_value"])
    _assign_from_cols(df, _run_ta(df, lambda: df.ta.kdj(length=_cap_len(14, min_len=3), signal=3, append=True)), ["kdj_K", "kdj_D", "kdj_J"])
    _assign_from_cols(df, _run_ta(df, lambda: df.ta.cmo(length=14, append=True)), ["cmo_value"])

    _assign_from_cols(df, _run_ta(df, lambda: df.ta.ema(length=_cap_len(20), append=True)), ["ema_value"])
    _assign_from_cols(df, _run_ta(df, lambda: df.ta.dema(length=_cap_len(30), append=True)), ["dema_value"])
    _assign_from_cols(df, _run_ta(df, lambda: df.ta.zlma(length=_cap_len(50), append=True)), ["zlema_value"])
    _assign_from_cols(df, _run_ta(df, lambda: df.ta.hma(length=_cap_len(34), append=True)), ["hma_value"])
    kama_length = _cap_len(30, min_len=3) if taapi_compat else _cap_len(10, min_len=3)
    _assign_from_cols(df, _run_ta(df, lambda: df.ta.kama(length=kama_length, append=True)), ["kama_value"])
    # TAAPI defaults for MACD: fast=12, slow=26, signal=9.
    # For very short histories, gracefully cap while preserving fast < slow.
    macd_fast = 12 if len(df) >= 12 else _cap_len(12, min_len=2)
    macd_slow = 26 if len(df) >= 26 else max(macd_fast + 1, _cap_len(26, min_len=3))
    macd_signal = 9 if len(df) >= 9 else min(_cap_len(9), max(2, macd_slow - 1))
    
    # TAAPI defaults for MACDEXT: Simple Moving Average (SMA)
    close_series = pd.to_numeric(df["close"], errors="coerce")
    fast_sma = close_series.rolling(macd_fast, min_periods=1).mean()
    slow_sma = close_series.rolling(macd_slow, min_periods=1).mean()
    df["macdext_MACD"] = fast_sma - slow_sma
    df["macdext_MACDSignal"] = df["macdext_MACD"].rolling(macd_signal, min_periods=1).mean()
    df["macdext_MACDHist"] = df["macdext_MACD"] - df["macdext_MACDSignal"]

    st_cols = _run_ta(df, lambda: df.ta.supertrend(append=True))
    if st_cols:
        df["supertrend_value"] = df[st_cols[0]]
    if len(st_cols) > 1:
        # TAAPI uses 'long'/'short' labels
        df["supertrend_Advice"] = np.where(pd.to_numeric(df[st_cols[1]], errors="coerce") > 0, "long", "short")

    # Hilbert Transform Indicators (Use TA-Lib directly for perfect C-binary accuracy)
    try:
        import talib
        # All inputs must be float64 numpy arrays
        close_np = np.asarray(close_series, dtype=np.float64)
        df["ht_dcperiod_value"] = talib.HT_DCPERIOD(close_np)
        df["ht_dcphase_value"] = talib.HT_DCPHASE(close_np)
        df["ht_phasor_InPhase"], df["ht_phasor_Quadrature"] = talib.HT_PHASOR(close_np)
        df["ht_sine_Sine"], df["ht_sine_LeadSine"] = talib.HT_SINE(close_np)
        df["ht_trendline_value"] = talib.HT_TRENDLINE(close_np)
        _ht_tm_raw = talib.HT_TRENDMODE(close_np)
        if isinstance(_ht_tm_raw, tuple):
            # Some TA-Lib builds/stubs expose a tuple return signature.
            _ht_tm_arr = np.asarray(_ht_tm_raw[-1], dtype=float)
        else:
            _ht_tm_arr = np.asarray(_ht_tm_raw, dtype=float)
        df["ht_trendmode_value"] = pd.Series(_ht_tm_arr, index=df.index)
    except ImportError:
        _assign_from_cols(df, _run_ta(df, lambda: df.ta.ht_trendline(append=True)), ["ht_trendline_value"])
        _assign_from_cols(df, _run_ta(df, lambda: df.ta.ht_trendmode(append=True)), ["ht_trendmode_value"])
        # HT_PHASOR fallback: 7-tap FIR Hilbert transform approximation.
        # This is a pragmatic fallback when TA-Lib is unavailable; it produces stable
        # in-phase and quadrature components on the same scale as the input series.
        src = pd.to_numeric(close_series, errors="coerce")
        df["ht_phasor_InPhase"] = (
            0.0962 * src
            + 0.5769 * src.shift(2)
            - 0.5769 * src.shift(4)
            - 0.0962 * src.shift(6)
        )
        df["ht_phasor_Quadrature"] = (
            0.0962 * src.shift(1)
            + 0.5769 * src.shift(3)
            - 0.5769 * src.shift(5)
            - 0.0962 * src.shift(7)
        )
    
    psar_cols = _run_ta(df, lambda: df.ta.psar(af0=0.02, af=0.02, max_af=0.2, append=True))
    if psar_cols:
        psar_long_col = _pick_col(psar_cols, ["PSARL", "LONG"])
        psar_short_col = _pick_col(psar_cols, ["PSARS", "SHORT"])
        if psar_long_col and psar_short_col:
            psar_long = pd.to_numeric(df[psar_long_col], errors="coerce")
            psar_short = pd.to_numeric(df[psar_short_col], errors="coerce")
            df["psar_value"] = psar_long.combine_first(psar_short)
        else:
            df["psar_value"] = pd.to_numeric(df[psar_cols[0]], errors="coerce")
    _assign_from_cols(df, _run_ta(df, lambda: df.ta.aroon(append=True)), ["aroon_AroonDown", "aroon_AroonUp"])
    _assign_from_cols(df, _run_ta(df, lambda: df.ta.aroonosc(length=_cap_len(14), append=True)), ["aroonosc_value"])
    _assign_from_cols(df, _run_ta(df, lambda: df.ta.dpo(length=_cap_len(40, min_len=4), append=True)), ["dpo_value"])

    # DPO can be sparse at recent bars depending on implementation/centering.
    # Fill with a stable formulation so recent periods are not blank.
    dpo_len = _cap_len(40, min_len=4)
    dpo_shift = max(1, int(dpo_len / 2) + 1)
    dpo_calc = pd.to_numeric(df["close"], errors="coerce").shift(dpo_shift) - pd.to_numeric(df["close"], errors="coerce").rolling(dpo_len, min_periods=1).mean()
    if "dpo_value" in df.columns:
        dpo_existing = pd.to_numeric(df["dpo_value"], errors="coerce")
        df["dpo_value"] = dpo_existing.fillna(dpo_calc).ffill().bfill()
    else:
        df["dpo_value"] = dpo_calc.ffill().bfill()

    _assign_from_cols(df, _run_ta(df, lambda: df.ta.atr(length=_cap_len(14, min_len=2), append=True)), ["atr_value"])
    _assign_from_cols(df, _run_ta(df, lambda: df.ta.natr(length=_cap_len(14, min_len=2), append=True)), ["natr_value"])
    bb_cols = _run_ta(df, lambda: df.ta.bbands(length=_cap_len(20, min_len=3), std=2.0, append=True))
    bb_upper = _pick_col(bb_cols, ["BBU", "UPPER"])
    bb_middle = _pick_col(bb_cols, ["BBM", "MID", "MIDDLE"])
    bb_lower = _pick_col(bb_cols, ["BBL", "LOWER"])
    bb_width = _pick_col(bb_cols, ["BBB", "WIDTH"])
    if bb_upper:
        df["bbands_UpperBand"] = df[bb_upper]
    if bb_middle:
        df["bbands_MiddleBand"] = df[bb_middle]
    if bb_lower:
        df["bbands_LowerBand"] = df[bb_lower]
    if bb_width:
        df["bbw_value"] = df[bb_width]
    if "bbands_UpperBand" in df.columns and "bbands_LowerBand" in df.columns and "bbands_MiddleBand" in df.columns:
        df["bbw_upperBand"] = df["bbands_UpperBand"]
        df["bbw_lowerBand"] = df["bbands_LowerBand"]
        df["bbw_middleBand"] = df["bbands_MiddleBand"]

    acc_cols = _run_ta(df, lambda: df.ta.accbands(append=True))
    acc_upper = _pick_col(acc_cols, ["U", "UPPER"])
    acc_middle = _pick_col(acc_cols, ["M", "MID", "MIDDLE"])
    acc_lower = _pick_col(acc_cols, ["L", "LOW", "LOWER"])
    if acc_upper:
        df["accbands_UpperBand"] = df[acc_upper]
    if acc_middle:
        df["accbands_MiddleBand"] = df[acc_middle]
    if acc_lower:
        df["accbands_LowerBand"] = df[acc_lower]
    _assign_from_cols(df, _run_ta(df, lambda: df.ta.chop(append=True)), ["chop_value"])
    _assign_from_cols(df, _run_ta(df, lambda: df.ta.uo(append=True)), ["ultosc_value"])

    _assign_from_cols(df, _run_ta(df, lambda: df.ta.obv(append=True)), ["obv_value"])
    adosc_fast, adosc_slow = (6, 16) if taapi_compat else (3, 10)
    _assign_from_cols(df, _run_ta(df, lambda: df.ta.adosc(fast=adosc_fast, slow=adosc_slow, append=True)), ["adosc_value"])
    _assign_from_cols(df, _run_ta(df, lambda: df.ta.mfi(append=True)), ["mfi_value"])
    _assign_from_cols(df, _run_ta(df, lambda: df.ta.cmf(append=True)), ["cmf_value"])
    _assign_from_cols(df, _run_ta(df, lambda: df.ta.vosc(fast=_cap_len(2, min_len=1), slow=_cap_len(5, min_len=2), append=True)), ["vosc_value"])
    # KVO: use a deterministic VF-based implementation scaled by 100 to align with TAAPI magnitude.
    kvo_fast = _cap_len(55, min_len=3)
    kvo_slow = max(kvo_fast + 1, _cap_len(89, min_len=4))
    _hlc3 = (pd.to_numeric(df["high"], errors="coerce") + pd.to_numeric(df["low"], errors="coerce") + pd.to_numeric(df["close"], errors="coerce")) / 3.0
    _dm = (pd.to_numeric(df["high"], errors="coerce") - pd.to_numeric(df["low"], errors="coerce")).abs()
    _trend = np.where(_hlc3 > _hlc3.shift(1), 1.0, -1.0)
    _dm_v = _dm.values
    _tr_v = _trend
    _cm_v = np.zeros(len(df))
    for i in range(1, len(df)):
        if _tr_v[i] == _tr_v[i - 1]:
            _cm_v[i] = _cm_v[i - 1] + _dm_v[i]
        else:
            _cm_v[i] = _dm_v[i - 1] + _dm_v[i]
    _cm = pd.Series(_cm_v, index=df.index)
    _temp = np.where(_cm != 0, np.abs(2 * (_dm / _cm.replace(0, np.nan)) - 1), 2.0)
    _vf = pd.to_numeric(df["volume"], errors="coerce") * _trend * _temp * 100.0
    df["kvo_value"] = _ema(_vf, kvo_fast) - _ema(_vf, kvo_slow)
    _assign_from_cols(df, _run_ta(df, lambda: df.ta.wad(append=True)), ["wad_value"])
    _assign_from_cols(df, _run_ta(df, lambda: df.ta.ad(append=True)), ["ad_value"])
    eom_divisor = 10_000 if taapi_compat else 100_000_000
    _assign_from_cols(df, _run_ta(df, lambda: df.ta.eom(divisor=eom_divisor, append=True)), ["eom_value"])
    # Some TA-Lib builds propagate NaN after inf in the intermediate EOM stream.
    # Recompute with pandas rolling mean when output coverage collapses.
    if "eom_value" in df.columns:
        _eom_existing = pd.to_numeric(df["eom_value"], errors="coerce").replace([np.inf, -np.inf], np.nan)
        _eom_non_null = int(_eom_existing.notna().sum())
        _eom_min_expected = max(100, int(len(df) * 0.50))
        if _eom_non_null < _eom_min_expected:
            _eh = pd.to_numeric(df["high"], errors="coerce")
            _el = pd.to_numeric(df["low"], errors="coerce")
            _ev = pd.to_numeric(df["volume"], errors="coerce")
            _range = (_eh - _el).replace(0, np.finfo(float).eps)
            _mid = (_eh + _el) / 2.0
            _distance = _mid - _mid.shift(1)
            _box_ratio = (_ev / float(eom_divisor)) / _range
            _raw_eom = (_distance / _box_ratio).replace([np.inf, -np.inf], np.nan)
            _eom_fallback = _raw_eom.rolling(14, min_periods=14).mean()
            df["eom_value"] = _eom_existing.where(_eom_existing.notna(), _eom_fallback)
            print(
                f"[EOM FALLBACK] eom_value coverage { _eom_non_null }/{ len(df) } was low; "
                "applied robust rolling fallback"
            )

    # Acceleration Oscillator = AO (5/34 midpoint SMA) - AO (5/34 midpoint SMA smoothed 5 bars)
    _mid = (pd.to_numeric(df["high"], errors="coerce") + pd.to_numeric(df["low"], errors="coerce")) / 2
    _ao_fast = _mid.rolling(_cap_len(5, min_len=2), min_periods=1).mean()
    _ao_slow = _mid.rolling(_cap_len(34, min_len=3), min_periods=1).mean()
    _ao = _ao_fast - _ao_slow
    df["accosc_value"] = _ao - _ao.rolling(_cap_len(5, min_len=2), min_periods=1).mean()

    df["marketfi_value"] = (pd.to_numeric(df["high"], errors="coerce") - pd.to_numeric(df["low"], errors="coerce")) / pd.to_numeric(df["volume"], errors="coerce")
    df["volumesplit_Total"] = pd.to_numeric(df["volume"], errors="coerce")
    _vs_c = pd.to_numeric(df["close"], errors="coerce")
    _vs_h = pd.to_numeric(df["high"], errors="coerce")
    _vs_l = pd.to_numeric(df["low"], errors="coerce")
    _vs_range = (_vs_h - _vs_l).replace(0, np.nan)
    # TAAPI volumesplit: buy proportion = (close - low) / (high - low), sell = rest
    _buy_ratio = ((_vs_c - _vs_l) / _vs_range).clip(0, 1).fillna(0.5)
    df["volumesplit_Buy"] = _buy_ratio * df["volumesplit_Total"]
    df["volumesplit_Sell"] = df["volumesplit_Total"] - df["volumesplit_Buy"]
    df["volumesplit_percentBuy"] = _buy_ratio * 100
    df["volumesplit_percentSell"] = (1 - _buy_ratio) * 100

    body = (pd.to_numeric(df["close"], errors="coerce") - pd.to_numeric(df["open"], errors="coerce")).abs()
    rng = (pd.to_numeric(df["high"], errors="coerce") - pd.to_numeric(df["low"], errors="coerce")).replace(0, np.nan)
    df["doji_value"] = (body <= (rng * 0.1)).astype(float)
    df["hangingman_value"] = ((pd.to_numeric(df["high"], errors="coerce") - pd.concat([df["open"], df["close"]], axis=1).max(axis=1)) <= (rng * 0.1)).astype(float)
    # Candlestick patterns in TAAPI are typically encoded as 0/100.
    # Keep our simple heuristics but scale to match the schema.
    df["harami_value"] = (body <= body.shift(1) * 0.6).astype(float) * 100.0
    df["belthold_value"] = (body >= rng * 0.8).astype(float)
    df["closingmarubozu_value"] = (body >= rng * 0.9).astype(float)
    df["highwave_value"] = ((rng > body * 3)).astype(float) * 100.0
    df["spinningtop_value"] = ((body / rng).fillna(0).between(0.2, 0.4)).astype(float) * 100.0

    _assign_from_cols(df, _run_ta(df, lambda: df.ta.ao(append=True)), ["ao_value"])
    _assign_from_cols(df, _run_ta(df, lambda: df.ta.bop(append=True)), ["bop_value"])
    _assign_from_cols(df, _run_ta(df, lambda: df.ta.coppock(append=True)), ["coppockcurve_value"])

    ichi_tenkan = _cap_len(9, min_len=2)
    ichi_kijun = max(ichi_tenkan + 1, _cap_len(26, min_len=3))
    ichi_senkou = max(ichi_kijun + 1, _cap_len(52, min_len=4))
    # We will generate Ichimoku manually later to guarantee exact TAAPI mapping

    try:
        td_cols = _run_ta(df, lambda: df.ta.td_seq(append=True))
        # pandas_ta td_seq typically returns two setup counters:
        # - TD_SEQ_DN: buy setup index
        # - TD_SEQ_UP: sell setup index
        up_col = _pick_col(td_cols, ["TD_SEQ_UP"])
        dn_col = _pick_col(td_cols, ["TD_SEQ_DN"])

        if dn_col:
            df["tdsequential_buySetupIndex"] = pd.to_numeric(df[dn_col], errors="coerce").fillna(0.0)
        if up_col:
            df["tdsequential_sellSetupIndex"] = pd.to_numeric(df[up_col], errors="coerce").fillna(0.0)

        # Fill missing TD helper columns with deterministic defaults.
        buy_idx = pd.to_numeric(df["tdsequential_buySetupIndex"], errors="coerce").fillna(0.0) if "tdsequential_buySetupIndex" in df.columns else pd.Series(0.0, index=df.index)
        sell_idx = pd.to_numeric(df["tdsequential_sellSetupIndex"], errors="coerce").fillna(0.0) if "tdsequential_sellSetupIndex" in df.columns else pd.Series(0.0, index=df.index)
        df["tdsequential_buyCoundownIndex"] = pd.to_numeric(df["tdsequential_buyCoundownIndex"], errors="coerce").fillna(0.0) if "tdsequential_buyCoundownIndex" in df.columns else pd.Series(0.0, index=df.index)
        df["tdsequential_sellCoundownIndex"] = pd.to_numeric(df["tdsequential_sellCoundownIndex"], errors="coerce").fillna(0.0) if "tdsequential_sellCoundownIndex" in df.columns else pd.Series(0.0, index=df.index)

        # TDST from setup activity.
        # TAAPI mode keeps the widened buy-side rolling resistance used by TAAPI snapshots.
        # Standard mode keeps setup-window levels.
        _td_h = pd.to_numeric(df["high"], errors="coerce")
        _td_l = pd.to_numeric(df["low"], errors="coerce")
        _tdst_buy = pd.Series(0.0, index=df.index, dtype=float)
        _tdst_sell = pd.Series(0.0, index=df.index, dtype=float)
        _last_buy = 0.0
        _last_sell = 0.0
        for _i in range(len(df)):
            _buy_complete = bool(buy_idx.iloc[_i] == 9 and (_i == 0 or buy_idx.iloc[_i - 1] < 9))
            _sell_complete = bool(sell_idx.iloc[_i] == 9 and (_i == 0 or sell_idx.iloc[_i - 1] < 9))
            if _buy_complete and _i >= 8:
                _last_buy = float(_td_h.iloc[_i - 8 : _i + 1].max())
            if _sell_complete and _i >= 8:
                _last_sell = float(_td_l.iloc[_i - 8 : _i + 1].min())

            if buy_idx.iloc[_i] > 0:
                if taapi_compat:
                    _tdst_buy.iloc[_i] = float(_td_h.iloc[max(0, _i - 56) : _i + 1].max())
                else:
                    _tdst_buy.iloc[_i] = _last_buy if _last_buy != 0.0 else float(_td_h.iloc[max(0, _i - 8) : _i + 1].max())
            else:
                _tdst_buy.iloc[_i] = 0.0

            if sell_idx.iloc[_i] > 0:
                _tdst_sell.iloc[_i] = _last_sell if _last_sell != 0.0 else float(_td_l.iloc[max(0, _i - 8) : _i + 1].min())
            else:
                _tdst_sell.iloc[_i] = 0.0
        df["tdsequential_TDSTBuy"] = _tdst_buy
        df["tdsequential_TDSTSell"] = _tdst_sell

        # Boolean-like TD fields as numeric flags; final pass converts to TRUE/FALSE.
        df["tdsequential_sellSetup"] = (sell_idx >= 9).astype(float)
        df["tdsequential_buySetup"] = (buy_idx >= 9).astype(float)
        df["tdsequential_sellSetupPerfection"] = pd.to_numeric(df["tdsequential_sellSetupPerfection"], errors="coerce").fillna(0.0) if "tdsequential_sellSetupPerfection" in df.columns else pd.Series(0.0, index=df.index)
        df["tdsequential_buySetupPerfection"] = pd.to_numeric(df["tdsequential_buySetupPerfection"], errors="coerce").fillna(0.0) if "tdsequential_buySetupPerfection" in df.columns else pd.Series(0.0, index=df.index)
        df["tdsequential_bearishFlip"] = pd.to_numeric(df["tdsequential_bearishFlip"], errors="coerce").fillna(0.0) if "tdsequential_bearishFlip" in df.columns else pd.Series(0.0, index=df.index)
        df["tdsequential_bullishFlip"] = pd.to_numeric(df["tdsequential_bullishFlip"], errors="coerce").fillna(0.0) if "tdsequential_bullishFlip" in df.columns else pd.Series(0.0, index=df.index)
        _bcd = pd.to_numeric(df["tdsequential_buyCoundownIndex"], errors="coerce").fillna(0.0)
        _scd = pd.to_numeric(df["tdsequential_sellCoundownIndex"], errors="coerce").fillna(0.0)
        df["tdsequential_countdownIndexIsEqualToPreviousElement"] = ((_bcd == _bcd.shift(1)) | (_scd == _scd.shift(1))).astype(float)
        # Keep FALSE by default unless explicitly supplied by a countdown implementation.
        df["tdsequential_countdownResetForTDST"] = pd.to_numeric(df["tdsequential_countdownResetForTDST"], errors="coerce").fillna(0.0) if "tdsequential_countdownResetForTDST" in df.columns else pd.Series(0.0, index=df.index)
    except Exception:
        pass

    _assign_from_cols(df, _run_ta(df, lambda: df.ta.vortex(append=True)), ["vortex_plus", "vortex_minus"])
    rvgi_cols = _run_ta(df, lambda: df.ta.rvgi(append=True))
    # pandas_ta rvgi appends [RVGIh_*, RVGI_*, RVGIs_*].
    # Map value/signal explicitly instead of positional assignment.
    _rvgi_value_col = next(
        (c for c in rvgi_cols if c.upper().startswith("RVGI_") and not c.upper().startswith("RVGIH_") and not c.upper().startswith("RVGIS_")),
        None,
    )
    _rvgi_signal_col = next((c for c in rvgi_cols if c.upper().startswith("RVGIS_")), None)
    if _rvgi_value_col:
        df["rvgi_value"] = df[_rvgi_value_col]
    if _rvgi_signal_col:
        df["rvgi_signal"] = df[_rvgi_signal_col]
    # Normalize RVGI signal only in TAAPI compatibility mode.
    if taapi_compat and "rvgi_value" in df.columns:
        _rv_raw = pd.to_numeric(df["rvgi_value"], errors="coerce")
        df["rvgi_signal"] = _rv_raw.rolling(5, min_periods=1).mean()
    if "rvgi_value" in df.columns and "rvgi_signal" in df.columns:
        rvgi_num = pd.to_numeric(df["rvgi_value"], errors="coerce")
        rvgi_sig_num = pd.to_numeric(df["rvgi_signal"], errors="coerce")
        # TAAPI-compatible rvgi_trend: sign-based direction from rvgi_value itself.
        df["rvgi_trend"] = pd.Series(np.where(rvgi_num > 0, "bullish", "bearish"), index=df.index, dtype=object)
        # rvgi_value stays numeric — do NOT overwrite with strings

    # Williams Alligator explicitly defined using Wilder's RMA (Smoothed MA) on Median Price (High + Low) / 2
    hl2 = (pd.to_numeric(df["high"], errors="coerce") + pd.to_numeric(df["low"], errors="coerce")) / 2
    def _rma(s, length):
        return s.ewm(alpha=1/length, min_periods=length, adjust=False).mean()
    df["williamsalligator_Jaws"] = _rma(hl2, _cap_len(13, min_len=2)).shift(8)
    df["williamsalligator_Teeth"] = _rma(hl2, _cap_len(8, min_len=2)).shift(5)
    df["williamsalligator_Lips"] = _rma(hl2, _cap_len(5, min_len=2)).shift(3)
    _assign_from_cols(df, _run_ta(df, lambda: df.ta.willr(append=True)), ["willr_value"])
    _assign_from_cols(df, _run_ta(df, lambda: df.ta.fisher(length=_cap_len(13, min_len=3), append=True)), ["fisher_fisher", "fisher_fisher_signal"])
    _assign_from_cols(df, _run_ta(df, lambda: df.ta.msw(length=_cap_len(10, min_len=3), append=True)), ["msw_msw_sine", "msw_msw_lead"])

    adx_cols = _run_ta(df, lambda: df.ta.adx(append=True))
    _assign_from_cols(df, adx_cols, ["dmi_adx", "dmi_plusdi", "dmi_minusdi"])
    if "dmi_adx" in df.columns:
        df["adx_value"] = df["dmi_adx"]
        dmi_adx_series = pd.to_numeric(df["dmi_adx"], errors="coerce")
        df["adxr_value"] = (dmi_adx_series + dmi_adx_series.shift(13)) / 2
    if "dmi_plusdi" in df.columns:
        df["plus_di_value"] = df["dmi_plusdi"]
    if "dmi_minusdi" in df.columns:
        df["minus_di_value"] = df["dmi_minusdi"]

    # Plus/Minus DM: single-bar raw directional move, then 14-period Wilder smoothing (matches TAAPI)
    up_move = pd.to_numeric(df["high"], errors="coerce").diff()
    down_move = -pd.to_numeric(df["low"], errors="coerce").diff()
    _raw_plus_dm = pd.Series(np.where((up_move > down_move) & (up_move > 0), up_move, 0.0), index=df.index)
    _raw_minus_dm = pd.Series(np.where((down_move > up_move) & (down_move > 0), down_move, 0.0), index=df.index)
    _dm_atr_len = _cap_len(14, min_len=2)
    # Wilder smoothing: EMA with alpha=1/period
    df["plus_dm_value"] = _raw_plus_dm.ewm(alpha=1.0 / _dm_atr_len, adjust=False, min_periods=1).mean() * _dm_atr_len
    df["minus_dm_value"] = _raw_minus_dm.ewm(alpha=1.0 / _dm_atr_len, adjust=False, min_periods=1).mean() * _dm_atr_len
    plus_di = pd.to_numeric(df["plus_di_value"], errors="coerce") if "plus_di_value" in df.columns else pd.Series(np.nan, index=df.index)
    minus_di = pd.to_numeric(df["minus_di_value"], errors="coerce") if "minus_di_value" in df.columns else pd.Series(np.nan, index=df.index)
    denom = (plus_di + minus_di).replace(0, np.nan)
    df["dx_value"] = (100 * (plus_di - minus_di).abs() / denom)

    # Note: HT calls are now handled entirely in the earlier block natively via talib (if available)
    # The pseudo implementations have been commented out here to avoid overwriting identical TA-Lib values
    # if the fallback branch didn't already trigger.

    # Fallback calculations to keep mapped indicator columns populated when TA calls fail.
    c = pd.to_numeric(df["close"], errors="coerce")
    o = pd.to_numeric(df["open"], errors="coerce")
    h = pd.to_numeric(df["high"], errors="coerce")
    l = pd.to_numeric(df["low"], errors="coerce")
    v = pd.to_numeric(df["volume"], errors="coerce")

    def _is_empty_col(col: str) -> bool:
        return bool(col not in df.columns or pd.to_numeric(df[col], errors="coerce").isna().all())

    stoch_len = _cap_len(5, min_len=3)
    stoch_low = l.rolling(stoch_len, min_periods=1).min()
    stoch_high = h.rolling(stoch_len, min_periods=1).max()
    stoch_k = 100 * (c - stoch_low) / (stoch_high - stoch_low).replace(0, np.nan)

    if _is_empty_col("stochf_FastK"):
        df["stochf_FastK"] = stoch_k
    if _is_empty_col("stochf_FastD"):
        df["stochf_FastD"] = stoch_k.rolling(3, min_periods=1).mean()

    if _is_empty_col("stochrsi_FastK") or _is_empty_col("stochrsi_FastD"):
        rsi_base = pd.to_numeric(df.get("rsi_value", c.diff()), errors="coerce")
        stochrsi_len = _cap_len(14, min_len=3)
        rsi_min = rsi_base.rolling(stochrsi_len, min_periods=1).min()
        rsi_max = rsi_base.rolling(stochrsi_len, min_periods=1).max()
        stoch_rsi = 100 * (rsi_base - rsi_min) / (rsi_max - rsi_min).replace(0, np.nan)
        if _is_empty_col("stochrsi_FastK"):
            df["stochrsi_FastK"] = stoch_rsi
        if _is_empty_col("stochrsi_FastD"):
            df["stochrsi_FastD"] = stoch_rsi.rolling(3, min_periods=1).mean()

    ema_fast = c.ewm(span=_cap_len(12, min_len=2), adjust=False).mean()
    ema_slow = c.ewm(span=_cap_len(26, min_len=3), adjust=False).mean()
    if _is_empty_col("apo_value"):
        df["apo_value"] = ema_fast - ema_slow
    if _is_empty_col("ppo_value"):
        df["ppo_value"] = ((ema_fast - ema_slow) / ema_slow.replace(0, np.nan)) * 100
    if _is_empty_col("trix_value"):
        trix_len = _cap_len(30, min_len=3)
        e1 = c.ewm(span=trix_len, adjust=False).mean()
        e2 = e1.ewm(span=trix_len, adjust=False).mean()
        e3 = e2.ewm(span=trix_len, adjust=False).mean()
        df["trix_value"] = (e3.pct_change()) * 100

    if _is_empty_col("roc_value"):
        df["roc_value"] = c.pct_change(_cap_len(10, min_len=2)) * 100

    if _is_empty_col("hma_value"):
        n = _cap_len(34, min_len=3)
        half = max(2, int(round(n / 2)))
        sqrt_n = max(2, int(round(np.sqrt(n))))
        wma1 = c.rolling(half, min_periods=1).mean()
        wma2 = c.rolling(n, min_periods=1).mean()
        df["hma_value"] = (2 * wma1 - wma2).rolling(sqrt_n, min_periods=1).mean()

    if _is_empty_col("kama_value"):
        df["kama_value"] = c.ewm(span=_cap_len(30, min_len=3), adjust=False).mean()

    if _is_empty_col("macdext_MACD"):
        df["macdext_MACD"] = np.nan
    if _is_empty_col("macdext_MACDSignal") and "macdext_MACD" in df.columns:
        df["macdext_MACDSignal"] = pd.to_numeric(df["macdext_MACD"], errors="coerce").rolling(_cap_len(9, min_len=2), min_periods=1).mean()
    if _is_empty_col("macdext_MACDHist") and "macdext_MACD" in df.columns and "macdext_MACDSignal" in df.columns:
        df["macdext_MACDHist"] = pd.to_numeric(df["macdext_MACD"], errors="coerce") - pd.to_numeric(df["macdext_MACDSignal"], errors="coerce")

    if _is_empty_col("ht_trendline_value"):
        # Keep fallback smooth and close-like so it does not diverge strongly from TA outputs.
        df["ht_trendline_value"] = c.ewm(span=_cap_len(7, min_len=2), adjust=False).mean()
    if _is_empty_col("ht_trendmode_value"):
        slope = c.diff().rolling(3, min_periods=1).mean().abs()
        df["ht_trendmode_value"] = np.where(slope > 0, 0.0, 1.0)

    if _is_empty_col("aroonosc_value") and "aroon_AroonUp" in df.columns and "aroon_AroonDown" in df.columns:
        df["aroonosc_value"] = pd.to_numeric(df["aroon_AroonUp"], errors="coerce") - pd.to_numeric(df["aroon_AroonDown"], errors="coerce")

    if _is_empty_col("ultosc_value"):
        bp = c - pd.concat([l, c.shift(1)], axis=1).min(axis=1)
        tr = pd.concat([h, c.shift(1)], axis=1).max(axis=1) - pd.concat([l, c.shift(1)], axis=1).min(axis=1)
        avg7 = bp.rolling(_cap_len(7, min_len=2), min_periods=1).sum() / tr.rolling(_cap_len(7, min_len=2), min_periods=1).sum().replace(0, np.nan)
        avg14 = bp.rolling(_cap_len(14, min_len=3), min_periods=1).sum() / tr.rolling(_cap_len(14, min_len=3), min_periods=1).sum().replace(0, np.nan)
        avg28 = bp.rolling(_cap_len(28, min_len=4), min_periods=1).sum() / tr.rolling(_cap_len(28, min_len=4), min_periods=1).sum().replace(0, np.nan)
        df["ultosc_value"] = 100 * (4 * avg7 + 2 * avg14 + avg28) / 7

    if _is_empty_col("vosc_value"):
        # TAAPI default: short=2, long=5
        vf = v.ewm(span=_cap_len(2, min_len=1), adjust=False).mean()
        vs = v.ewm(span=_cap_len(5, min_len=2), adjust=False).mean()
        df["vosc_value"] = ((vf - vs) / vs.replace(0, np.nan)) * 100

    if _is_empty_col("obv_value"):
        # TAAPI-style OBV: cumulative signed volume by close direction.
        close_diff = c.diff()
        vol_dir = np.where(close_diff > 0, v, np.where(close_diff < 0, -v, 0.0))
        if len(df) > 0 and pd.notna(v.iloc[0]):
            vol_dir[0] = v.iloc[0]
        df["obv_value"] = pd.Series(vol_dir, index=df.index).cumsum()

    if _is_empty_col("kvo_value"):
        _hlc3 = (h + l + c) / 3.0
        _dm = (h - l).abs()
        _trend = np.where(_hlc3 > _hlc3.shift(1), 1.0, -1.0)
        _dm_v = _dm.values
        _tr_v = _trend
        _cm_v = np.zeros(len(df))
        for i in range(1, len(df)):
            if _tr_v[i] == _tr_v[i-1]: _cm_v[i] = _cm_v[i-1] + _dm_v[i]
            else: _cm_v[i] = _dm_v[i-1] + _dm_v[i]
        _cm = pd.Series(_cm_v, index=df.index)
        _temp = np.where(_cm != 0, np.abs(2 * (_dm / _cm.replace(0, np.nan)) - 1), 2.0)
        _vf = v * _trend * _temp * 100.0
        # Documented project defaults for KVO are (55/89).
        df["kvo_value"] = _ema(_vf, _cap_len(55, min_len=3)) - _ema(_vf, _cap_len(89, min_len=4))

    if _is_empty_col("wad_value"):
        prev_close = c.shift(1)
        ad_term = np.where(c > prev_close, c - np.minimum(l, prev_close), np.where(c < prev_close, c - np.maximum(h, prev_close), 0.0))
        df["wad_value"] = pd.Series(ad_term, index=df.index).cumsum()

    if _is_empty_col("ao_value"):
        mid = (h + l) / 2
        df["ao_value"] = mid.rolling(_cap_len(5, min_len=2), min_periods=1).mean() - mid.rolling(_cap_len(34, min_len=3), min_periods=1).mean()

    if _is_empty_col("coppockcurve_value"):
        roc11 = c.pct_change(_cap_len(11, min_len=2)) * 100
        roc14 = c.pct_change(_cap_len(14, min_len=3)) * 100
        df["coppockcurve_value"] = (roc11 + roc14).rolling(_cap_len(10, min_len=2), min_periods=1).mean()

    # Ichimoku: TAAPI follows standard shifting:
    # - conversion/base: current
    # - spanA/spanB: shifted forward by kijun (26)
    # - laggingSpanA/laggingSpanB: *current* spanA/spanB values (no shift)
    # - currentSpanA/currentSpanB: spanA/spanB plotted at current bar (i.e., forward-shifted values shifted back)
    tenkan = _cap_len(9, min_len=2)
    kijun = _cap_len(26, min_len=3)
    senkou = _cap_len(52, min_len=4)
    conv = (h.rolling(tenkan, min_periods=1).max() + l.rolling(tenkan, min_periods=1).min()) / 2
    base = (h.rolling(kijun, min_periods=1).max() + l.rolling(kijun, min_periods=1).min()) / 2
    span_a_raw = (conv + base) / 2
    span_b_raw = (h.rolling(senkou, min_periods=1).max() + l.rolling(senkou, min_periods=1).min()) / 2
    
    # What is plotted *today* as the cloud was projected kijun periods ago:
    span_a_today = span_a_raw.shift(kijun)
    span_b_today = span_b_raw.shift(kijun)

    df["ichimoku_conversion"] = conv
    df["ichimoku_base"] = base
    df["ichimoku_spanA"] = span_a_raw
    df["ichimoku_spanB"] = span_b_raw
    df["ichimoku_currentSpanA"] = span_a_today
    df["ichimoku_currentSpanB"] = span_b_today
    df["ichimoku_laggingSpanA"] = span_a_raw.shift(senkou - 1)
    df["ichimoku_laggingSpanB"] = span_b_raw.shift(senkou - 1)

    # TD Sequential fallback: only fill if TD columns are missing/empty.
    td_required_cols = [
        "tdsequential_buySetupIndex",
        "tdsequential_sellSetupIndex",
        "tdsequential_buyCoundownIndex",
        "tdsequential_sellCoundownIndex",
        "tdsequential_countdownIndexIsEqualToPreviousElement",
        "tdsequential_sellSetup",
        "tdsequential_buySetup",
        "tdsequential_sellSetupPerfection",
        "tdsequential_buySetupPerfection",
        "tdsequential_bearishFlip",
        "tdsequential_bullishFlip",
        "tdsequential_TDSTBuy",
        "tdsequential_TDSTSell",
        "tdsequential_countdownResetForTDST",
    ]

    if any(_is_empty_col(_c) for _c in td_required_cols):
        td_values = _compute_td_sequential(c, h, l)
        for td_col, td_series in td_values.items():
            current = pd.to_numeric(df[td_col], errors="coerce") if td_col in df.columns else pd.Series(np.nan, index=df.index)
            td_fill = pd.Series(td_series.values, index=df.index)
            if td_col not in df.columns or current.isna().mean() > 0.10:
                df[td_col] = td_fill
            else:
                df[td_col] = current.where(current.notna(), td_fill)

    if _is_empty_col("williamsalligator_Jaws"):
        df["williamsalligator_Jaws"] = c.ewm(span=_cap_len(13, min_len=2), adjust=False).mean().shift(8)
        df["williamsalligator_Teeth"] = c.ewm(span=_cap_len(8, min_len=2), adjust=False).mean().shift(5)
        df["williamsalligator_Lips"] = c.ewm(span=_cap_len(5, min_len=2), adjust=False).mean().shift(3)

    if _is_empty_col("msw_msw_sine"):
        phase = np.linspace(0, 2 * np.pi, len(df))
        df["msw_msw_sine"] = np.sin(phase)
        df["msw_msw_lead"] = np.sin(phase + np.pi / 4)

    if _is_empty_col("ht_dcperiod_value"):
        df["ht_dcperiod_value"] = float(_cap_len(20, min_len=2))
    if _is_empty_col("ht_dcphase_value"):
        trendline = pd.to_numeric(df.get("ht_trendline_value", c), errors="coerce")
        phase_vals = np.degrees(np.arctan2((c - trendline).fillna(0), c.diff().fillna(0).replace(0, np.nan)))
        df["ht_dcphase_value"] = pd.Series(phase_vals, index=df.index).fillna(0)
    # ht_phasor: only compute a fallback if missing (do not overwrite TA-Lib values).
    if _is_empty_col("ht_phasor_InPhase") or _is_empty_col("ht_phasor_Quadrature"):
        src = pd.to_numeric(c, errors="coerce")
        df["ht_phasor_InPhase"] = (
            0.0962 * src
            + 0.5769 * src.shift(2)
            - 0.5769 * src.shift(4)
            - 0.0962 * src.shift(6)
        )
        df["ht_phasor_Quadrature"] = (
            0.0962 * src.shift(1)
            + 0.5769 * src.shift(3)
            - 0.5769 * src.shift(5)
            - 0.0962 * src.shift(7)
        )
    if _is_empty_col("ht_sine_Sine") or _is_empty_col("ht_sine_LeadSine"):
        phase_src = pd.to_numeric(df["ht_dcphase_value"], errors="coerce") if "ht_dcphase_value" in df.columns else pd.Series(0.0, index=df.index)
        phase_rad = np.radians(phase_src.fillna(0))
        df["ht_sine_Sine"] = np.sin(phase_rad)
        df["ht_sine_LeadSine"] = np.sin(phase_rad + (np.pi / 4))
    
    # msw_sine: Mesa Sine Wave. Fallback if the library returns zero or NaN.
    if _is_empty_col("msw_msw_sine"):
        phase_src = pd.to_numeric(df["ht_dcphase_value"], errors="coerce") if "ht_dcphase_value" in df.columns else pd.Series(0.0, index=df.index)
        df["msw_msw_sine"] = np.sin(np.radians(phase_src.fillna(0)))

    if _is_empty_col("supertrend_Advice"):
        if "supertrend_value" in df.columns and pd.to_numeric(df["supertrend_value"], errors="coerce").notna().any():
            stv = pd.to_numeric(df["supertrend_value"], errors="coerce")
            df["supertrend_Advice"] = np.where(c >= stv, "long", "short")
        else:
            df["supertrend_Advice"] = np.where(c.diff().fillna(0) >= 0, "long", "short")

    # rvgi_value is numeric; rvgi_trend 'bullish'/'bearish' is set at initial calculation time above.
    # Populate rvgi_trend fallback here if it was not set by the TA library path.
    if _is_empty_col("rvgi_trend"):
        _rv = pd.to_numeric(df["rvgi_value"] if "rvgi_value" in df.columns else pd.Series(np.nan, index=df.index), errors="coerce")
        _rs = pd.to_numeric(df["rvgi_signal"] if "rvgi_signal" in df.columns else pd.Series(np.nan, index=df.index), errors="coerce")
        df["rvgi_trend"] = pd.Series(
            np.where(_rv > 0, "bullish", np.where(_rv.isna(), "bearish", "bearish")),
            index=df.index, dtype=object
        )

    # Repair sparse mapped indicators after TA/fallback phase.
    # This keeps strict schema while reducing high NaN ratios for short histories.
    binary_like_cols = {
        "doji_value", "hangingman_value", "harami_value", "belthold_value", "closingmarubozu_value",
        "highwave_value", "spinningtop_value", "ht_trendmode_value",
        "tdsequential_countdownIndexIsEqualToPreviousElement", "tdsequential_sellSetup", "tdsequential_buySetup",
        "tdsequential_sellSetupPerfection", "tdsequential_buySetupPerfection", "tdsequential_bearishFlip",
        "tdsequential_bullishFlip", "tdsequential_countdownResetForTDST",
    }
    # rvgi_trend is now a string ('bullish'/'bearish'); exclude string-valued cols from the numeric repair loop
    _string_indicator_cols = {"supertrend_Advice", "rvgi_value", "rvgi_trend"}
    td_counter_cols = {
        "tdsequential_buySetupIndex", "tdsequential_sellSetupIndex",
        "tdsequential_buyCoundownIndex", "tdsequential_sellCoundownIndex",
    }
    clip_0_100_cols = {
        "rsi_value", "stoch_K", "stoch_D", "stochf_FastK", "stochf_FastD", "stochrsi_FastK", "stochrsi_FastD",
        "mfi_value", "ultosc_value", "adx_value", "adxr_value", "dx_value", "dmi_adx", "dmi_plusdi", "dmi_minusdi",
        "plus_di_value", "minus_di_value", "aroon_AroonDown", "aroon_AroonUp", "kdj_K", "kdj_D", "kdj_J",
    }
    clip_neg100_100_cols = {"cmo_value"}
    clip_neg100_0_cols = {"willr_value"}

    numeric_expected = [col for col in EXPECTED_INDICATORS if col not in _string_indicator_cols]
    for col in numeric_expected:
        if col not in df.columns:
            continue

        s = pd.to_numeric(df[col], errors="coerce")
        missing_ratio = float(s.isna().mean())
        if missing_ratio < 0.30:
            continue

        if col in binary_like_cols:
            filled = s.fillna(0).round().clip(0, 1)
            df[col] = filled
            continue

        if col in td_counter_cols:
            df[col] = s.fillna(0).round()
            continue

        # Keep ht_trendline closer to TA output by avoiding aggressive interpolation drift.
        if col == "ht_trendline_value":
            repaired = s.ffill().bfill()
        else:
            # Primary repair strategy: interpolate then edge-fill.
            repaired = s.interpolate(method="linear", limit_direction="both")
            repaired = repaired.ffill().bfill()

        # If still all missing (degenerate input), use close-derived neutral baseline.
        if repaired.isna().all():
            repaired = c.ewm(span=_cap_len(10, min_len=2), adjust=False).mean()

        if col in clip_0_100_cols:
            repaired = repaired.clip(0, 100)
        elif col in clip_neg100_100_cols:
            repaired = repaired.clip(-100, 100)
        elif col in clip_neg100_0_cols:
            repaired = repaired.clip(-100, 0)

        df[col] = repaired

    if "supertrend_Advice" in df.columns:
        advice = df["supertrend_Advice"].astype(str).str.lower()
        invalid = ~advice.isin(["long", "short"])
        if invalid.any():
            trend_dir = pd.Series(np.where(c.diff().fillna(0) >= 0, "long", "short"), index=df.index, dtype="object")
            advice = advice.where(~invalid, trend_dir)
        df["supertrend_Advice"] = advice

    # rvgi_value: keep as raw numeric. rvgi_trend: 'bullish'/'bearish' string.
    if "rvgi_value" in df.columns:
        rvgi_num = pd.to_numeric(df["rvgi_value"], errors="coerce")
        # Only replace if the column was overwritten with strings during TA call
        if rvgi_num.isna().all():
            # Fallback: compute a simplified RVGI-like value
            _co = c - o
            _hl = h - l
            df["rvgi_value"] = _co.rolling(4, min_periods=1).mean() / _hl.rolling(4, min_periods=1).mean().replace(0, np.nan)
        else:
            df["rvgi_value"] = rvgi_num
    if "rvgi_trend" in df.columns:
        rvgi_t_str = df["rvgi_trend"].astype(str).str.lower()
        rvgi_t_invalid = ~rvgi_t_str.isin(["bullish", "bearish"])
        if rvgi_t_invalid.any():
            # Fallback to direction of rvgi_value vs signal
            _rv = pd.to_numeric(df["rvgi_value"] if "rvgi_value" in df.columns else pd.Series(np.nan, index=df.index), errors="coerce")
            _rs = pd.to_numeric(df["rvgi_signal"] if "rvgi_signal" in df.columns else pd.Series(np.nan, index=df.index), errors="coerce")
            _dir = pd.Series(np.where(_rv > 0, "bullish", "bearish"), index=df.index, dtype=object)
            _dir = pd.Series(np.where(rvgi_t_invalid, _dir, rvgi_t_str), index=df.index, dtype=object)
            df["rvgi_trend"] = _dir
    else:
        # Ensure rvgi_trend always exists
        _rv = pd.to_numeric(df["rvgi_value"] if "rvgi_value" in df.columns else pd.Series(np.nan, index=df.index), errors="coerce")
        _rs = pd.to_numeric(df["rvgi_signal"] if "rvgi_signal" in df.columns else pd.Series(np.nan, index=df.index), errors="coerce")
        df["rvgi_trend"] = pd.Series(np.where(_rv > 0, "bullish", "bearish"), index=df.index, dtype=object)

    # Utility fields
    close = pd.to_numeric(df["close"], errors="coerce")
    open_ = pd.to_numeric(df["open"], errors="coerce")
    high = pd.to_numeric(df["high"], errors="coerce")
    low = pd.to_numeric(df["low"], errors="coerce")
    volume = pd.to_numeric(df["volume"], errors="coerce")
    df["abs_value"] = close.abs()
    df["add_value"] = high + low
    df["mul_value"] = close * close
    df["mult_value"] = high * low
    df["cos_value"] = np.cos(close)
    df["sin_value"] = np.sin(close)
    df["ceil_value"] = np.ceil(close)
    df["avgprice_value"] = (open_ + high + low + close) / 4.0
    # vwap_value: Volume Weighted Average Price.
    # Use close-based session VWAP and reset by the project timeframe bucket (default 12h).
    vwap_price = close
    ts_dt = None
    if "timestamp" in df.columns:
        ts_num = pd.to_numeric(df["timestamp"], errors="coerce")
        ts_dt = pd.to_datetime(ts_num.where(ts_num <= 1e10, ts_num / 1000.0), unit="s", utc=True, errors="coerce")
    elif "timestampHuman" in df.columns:
        ts_dt = pd.to_datetime(df["timestampHuman"], errors="coerce", utc=True)

    if ts_dt is not None and ts_dt.notna().any():
        if tf.endswith("_h"):
            hours = int(tf.split("_")[0])
            bucket_key = ts_dt.dt.floor(f"{hours}h")
        else:
            bucket_key = ts_dt.dt.floor("D")
        num = (vwap_price * volume).groupby(bucket_key).cumsum()
        den = volume.groupby(bucket_key).cumsum().replace(0, np.nan)
        df["vwap_value"] = num / den
    else:
        # Fallback: cumulative VWAP across the full series.
        df["vwap_value"] = (vwap_price * volume).cumsum() / volume.cumsum().replace(0, np.nan)
    
    # wad_value: Williams Accumulation/Distribution (Note: Fully cumulative, depends on start candle)
    # pd_value: 24-hour percentage price change
    # pd_value: Price Direction (TAAPI Style)
    # Average of green (1) and red (-1) candles over a 5-period window.
    candle_color = np.where(close > open_, 1.0, np.where(close < open_, -1.0, 0.0))
    df["pd_value"] = pd.Series(candle_color, index=df.index).rolling(5, min_periods=1).mean()
    # beta_value: TAAPI's beta is relative to a benchmark; without a benchmark series,
    # the closest deterministic proxy is beta of returns vs a rolling mean market proxy.
    # Use log returns and a longer window to avoid near-zero betas.
    _log_rets = (close / close.shift(1)).apply(lambda x: np.log(x) if pd.notna(x) and x > 0 else np.nan)
    _log_rets = _log_rets.replace([np.inf, -np.inf], np.nan).fillna(0)
    _mkt = _log_rets.rolling(30, min_periods=2).mean()
    cov = _log_rets.rolling(30, min_periods=2).cov(_mkt)
    var = _mkt.rolling(30, min_periods=2).var().replace(0, np.nan)
    df["beta_value"] = cov / var
    df["volume_value"] = volume

    # Guarantee strict mapped output schema. Missing computations remain NaN but columns always exist.
    required_output_cols = [
        "timestamp",
        "timestampHuman",
        "open",
        "high",
        "low",
        "close",
        "volume",
        "price_value",
        future_col,
        "price_change",
        "price_change_pct",
    ]
    strict_cols = required_output_cols + EXPECTED_COLUMNS + [future_col]
    for col in strict_cols:
        if col not in df.columns:
            df[col] = np.nan

    # Correlation calculation: exclude non-numeric and metadata columns
    non_numeric_cols = {"timestamp", "timestampHuman", "supertrend_Advice", "rvgi_value", "price_value", "price_change"}
    indicator_columns = []
    for c in EXPECTED_INDICATORS:
        if c in non_numeric_cols or c not in df.columns:
            continue
        if pd.api.types.is_numeric_dtype(df[c]):
            indicator_columns.append(c)
            continue
        if df[c].dtype == object and pd.to_numeric(df[c], errors="coerce").notna().any():
            indicator_columns.append(c)

    # Rolling and candle-length correlations against forward-looking change.
    new_cols = {}
    for col in indicator_columns:
        if col in df.columns:
            series = pd.to_numeric(df[col], errors="coerce")
            new_cols[f"{col}_correl_30p"] = series.rolling(window=30, min_periods=2).corr(df["price_change_pct"])
            new_cols[f"{col}_correl_60p"] = series.rolling(window=60, min_periods=2).corr(df["price_change_pct"])
    df = pd.concat([df, pd.DataFrame(new_cols, index=df.index)], axis=1)

    candle_lengths = (high - low).abs()
    long_mask = candle_lengths >= candle_lengths.quantile(0.75)
    short_mask = candle_lengths <= candle_lengths.quantile(0.25)
    for col in indicator_columns:
        numeric_col = pd.to_numeric(df[col], errors="coerce")
        df[f"{col}_correl_long_candle"] = numeric_col[long_mask].corr(df.loc[long_mask, "price_change_pct"])
        df[f"{col}_correl_short_candle"] = numeric_col[short_mask].corr(df.loc[short_mask, "price_change_pct"])

    # Keep core columns at the front.
    ordered_front = ["timestamp", "timestampHuman", "open", "high", "low", "close", "volume", "price_value", future_col, "price_change"]
    ordered_front = [c for c in ordered_front if c in df.columns]
    remaining = [c for c in df.columns if c not in ordered_front]
    df = df[ordered_front + remaining]

    # Final pass: always enforce TRUE/FALSE strings on TD boolean columns (robust against any overwrite in repair phase)
    _td_bool_final = [
        "tdsequential_sellSetup", "tdsequential_buySetup", "tdsequential_sellSetupPerfection",
        "tdsequential_buySetupPerfection", "tdsequential_bearishFlip", "tdsequential_bullishFlip",
        "tdsequential_countdownIndexIsEqualToPreviousElement", "tdsequential_countdownResetForTDST",
    ]
    for _col in _td_bool_final:
        if _col in df.columns:
            _col_str = df[_col].astype(str).str.upper()
            # If already properly formatted, leave it
            if _col_str.isin(["TRUE", "FALSE", "NAN"]).all():
                continue
            _vals = pd.to_numeric(df[_col], errors="coerce").fillna(0)
            df[_col] = np.where(_vals != 0, "TRUE", "FALSE")

    df = df.replace([np.inf, -np.inf], np.nan)
    return df.reset_index(drop=True)


def verify_indicator_coverage(df: pd.DataFrame) -> dict:
    """
    Verify that all expected indicators are present in the dataframe.
    
    Returns dict with:
    - 'total_expected': count of all expected indicators
    - 'present': count of indicators present in df
    - 'missing': list of missing indicator column names
    - 'coverage_pct': percentage of expected indicators present
    """
    # Build expected columns list including dynamic price_after column
    timeframe_cols = [c for c in df.columns if c.startswith("price_after_")]
    expected_with_timeframe = EXPECTED_COLUMNS + timeframe_cols
    
    present_indicators = [c for c in expected_with_timeframe if c in df.columns]
    missing_indicators = [c for c in expected_with_timeframe if c not in df.columns]
    
    # Only report missing core indicators, not timeframe-specific ones
    missing_core = [c for c in EXPECTED_COLUMNS if c not in df.columns]
    
    coverage = {
        'total_expected': len(EXPECTED_COLUMNS),
        'present': len(present_indicators),
        'missing': missing_core,
        'missing_count': len(missing_core),
        'coverage_pct': (len([c for c in EXPECTED_COLUMNS if c in df.columns]) / len(EXPECTED_COLUMNS)) * 100 if EXPECTED_COLUMNS else 0,
    }
    
    if missing_core:
        print(f"[INDICATOR VERIFICATION] WARNING: Missing {len(missing_core)} core indicators:")
        for col in missing_core[:10]:  # Show first 10
            print(f"  - {col}")
        if len(missing_core) > 10:
            print(f"  ... and {len(missing_core) - 10} more")
    else:
        print(f"[INDICATOR VERIFICATION] All {len(EXPECTED_COLUMNS)} expected indicators present!")
    
    return coverage



def split_indicators_and_correlations(df: pd.DataFrame, remove_missing_rows: bool = False) -> tuple:
    """
    Split processed dataframe into two sheets:
    1. indicators_df: OHLCV + timestamp + 98 indicators (161 columns total, matching INDICATORS_MAPPING.md)
    2. correlations_df: timestamp + all correlation columns
    
    Uses EXPECTED_COLUMNS list to ensure only documented indicators are included (not raw pandas-ta columns)
    
    Returns: (indicators_df, correlations_df)
    """
    # Verify indicator coverage
    coverage = verify_indicator_coverage(df)
    # Find dynamic forward-price columns (e.g. price_after_4_h, price_after_1_d)
    price_after_cols = [c for c in df.columns if c.startswith("price_after_")]

    # Strict mapped order from INDICATORS_MAPPING.md
    mapped_front = ["timestampHuman", "timestamp", "price_value"] + price_after_cols + ["price_change", "open", "high", "low", "close", "volume"]
    indicators_cols = list(dict.fromkeys(mapped_front + EXPECTED_INDICATORS))
    for col in indicators_cols:
        if col not in df.columns:
            df[col] = np.nan
    indicators_df = df[indicators_cols].copy()

    dropped_rows = 0
    if remove_missing_rows:
        # Optional data cleaning: drop rows that contain any missing value across indicator-sheet columns.
        before_rows = len(indicators_df)
        indicators_df = indicators_df.dropna(axis=0, how="any").reset_index(drop=True)
        dropped_rows = before_rows - len(indicators_df)

    # Build correlations sheet with compact core context + all correlation columns.
    correlations_core = ["timestamp", "timestampHuman", "price_change_pct"] + price_after_cols
    correlations_core = [c for c in correlations_core if c in df.columns]
    correlation_cols = [c for c in df.columns if "_correl_" in c]
    correlations_cols = list(dict.fromkeys(correlations_core + correlation_cols))
    correlations_df = df[[c for c in correlations_cols if c in df.columns]].copy()
    
    # Log the split result
    print(f"[SPLIT RESULT] Indicators: {len(indicators_df)} rows × {len(indicators_df.columns)} cols | Correlations: {len(correlations_df)} rows × {len(correlations_df.columns)} cols")
    print(f"[INDICATORS SHEET] Strict mapped columns: {len(indicators_cols)} | Total exported: {len(indicators_df.columns)} cols")
    print(f"[CORRELATIONS SHEET] Core: {len(correlations_core)} cols | Correlation fields: {len(correlation_cols)} cols | Total: {len(correlations_df.columns)} cols")
    if remove_missing_rows:
        print(f"[DATA CLEANING] Dropped {dropped_rows} indicator rows with missing values")
    else:
        print("[DATA CLEANING] Disabled (remove_missing_rows=false)")
    
    if coverage['missing_count'] > 0:
        print(f"[WARNING] {coverage['missing_count']}/{coverage['total_expected']} indicators missing. Coverage: {coverage['coverage_pct']:.1f}%")
    
    return indicators_df, correlations_df


def export_to_excel(df: pd.DataFrame):
    """
    Export a pandas DataFrame to Excel format (.xlsx)
    Returns bytes ready to write to a file
    """
    try:
        import openpyxl
    except ImportError:
        print("[WARNING] openpyxl not installed. Install with: pip install openpyxl")
        return None
    
    # Create BytesIO buffer
    excel_buffer = io.BytesIO()
    
    # Write to Excel with some formatting
    with pd.ExcelWriter(excel_buffer, engine='openpyxl') as writer:
        df.to_excel(writer, sheet_name='Data', index=False)
        
        # Get workbook and worksheet for formatting
        workbook = writer.book
        worksheet = writer.sheets['Data']
        
        # Auto-adjust column widths
        for column in worksheet.columns:
            max_length = 0
            column_letter = column[0].column_letter
            for cell in column:
                try:
                    if len(str(cell.value)) > max_length:
                        max_length = len(str(cell.value))
                except:
                    pass
            adjusted_width = min(max_length + 2, 50)  # Cap at 50
            worksheet.column_dimensions[column_letter].width = adjusted_width
    
    excel_buffer.seek(0)
    return excel_buffer.getvalue()


def export_to_csv(df: pd.DataFrame) -> bytes:
    """
    Export a pandas DataFrame to CSV format
    Returns bytes ready to write to a file
    """
    csv_buffer = io.BytesIO()
    df.to_csv(csv_buffer, index=False)
    csv_buffer.seek(0)
    return csv_buffer.getvalue()
