"""CoinGlass US-equity OHLCV: the production source for equity candles.

Semantics (each one learned in production):
  * the endpoint returns rows [ts_sec, open, high, low, close, volume, session] with
    session in {pre_market, regular, after_hours, extended, null};
  * we request session=extended_hours so 1h bars sit on the :00 grid, then keep regular trading
    hours ourselves (ET hour 9..15 on 1h; 09:30..15:59 on 5m/15m; never weekends).
    4h/1d keep every bar;
  * `limit` counts round-the-clock bars and the venue drops out-of-session ones afterwards
    (limit=700 on h1 gives ~340 session bars), so ask for CALENDAR_FACTOR x and keep the newest;
  * CLOSED bars only: the bar still forming (ts + interval > now) is dropped before anything
    is computed on it, so no indicator or signal is ever based on a moving candle;
  * transient errors (network, 5xx, 429) are retried with backoff; other 4xx fail fast.
"""
from __future__ import annotations

import logging
import time
from datetime import datetime, timezone
from zoneinfo import ZoneInfo

import pandas as pd
import requests

from .. import config

log = logging.getLogger("aether.sources.coinglass")
ET = ZoneInfo("America/New_York")
INTERVAL = {"5m": "m5", "15m": "m15", "1h": "h1", "4h": "h4", "1d": "d1"}
INTERVAL_SEC = {"5m": 300, "15m": 900, "1h": 3600, "4h": 14400, "1d": 86400}
RTH_INTERVALS = {"5m", "15m", "1h"}
CALENDAR_FACTOR = 3
MAX_LIMIT = 7200
RETRIES = 3


class CoinglassError(RuntimeError):
    pass


class _Retryable(CoinglassError):
    pass


def in_rth(ts_sec: int, timeframe: str) -> bool:
    """Regular-trading-hours bar (by bar open, ET)? Weekends are never in session."""
    t = datetime.fromtimestamp(ts_sec, tz=timezone.utc).astimezone(ET)
    if t.weekday() >= 5:
        return False
    if timeframe == "1h":
        return 9 <= t.hour <= 15
    return (t.hour == 9 and t.minute >= 30) or 10 <= t.hour <= 15


def session_stamp(ts_sec: int, timeframe: str, early_close: bool = False) -> dict:
    """bar_et_hour / is_final_rth_bar, as stored in the equity snapshot tables."""
    t = datetime.fromtimestamp(ts_sec, tz=timezone.utc).astimezone(ET)
    close_h = 13 if early_close else 16
    if timeframe == "1h":
        final = t.hour == close_h - 1
    elif timeframe == "15m":
        final = t.hour == close_h - 1 and t.minute == 45
    else:
        final = t.hour == close_h - 1 and t.minute == 55
    return {"bar_et_hour": t.hour, "is_final_rth_bar": int(final)}


def _get(url: str, params: dict, sleep=time.sleep) -> dict:
    headers = {"CG-API-KEY": config.COINGLASS_API_KEY} if config.COINGLASS_API_KEY else {}
    last: Exception | None = None
    for attempt in range(RETRIES):
        try:
            r = requests.get(url, params=params, headers=headers, timeout=30)
            if r.status_code >= 500 or r.status_code == 429:
                raise _Retryable(f"HTTP {r.status_code}: {r.text[:200]}")
            if not r.ok:
                raise CoinglassError(f"HTTP {r.status_code}: {r.text[:200]}")
            return r.json()
        except (requests.RequestException, _Retryable) as e:
            last = e
            if attempt < RETRIES - 1:
                sleep(2 ** attempt)
    raise CoinglassError(f"CoinGlass request failed after {RETRIES} attempts: {last}")


def fetch_raw(symbol: str, timeframe: str, limit: int) -> list:
    if timeframe not in INTERVAL:
        raise CoinglassError(f"unsupported timeframe {timeframe!r}")
    url = f"{config.COINGLASS_BASE_URL.rstrip('/')}/stocks/api/v2/kline"
    payload = _get(url, {"symbol": f"US_{symbol.upper()}#kline", "interval": INTERVAL[timeframe],
                         "limit": int(limit), "session": "extended_hours"})
    data = payload.get("data") if isinstance(payload, dict) else None
    rows = data.get("data") if isinstance(data, dict) else data
    if not isinstance(rows, list) or not rows:
        raise CoinglassError(f"CoinGlass returned no candles for {symbol} {timeframe}")
    return rows


def parse(rows: list, timeframe: str, now: float | None = None, rth_only: bool | None = None) -> pd.DataFrame:
    """Raw rows -> closed, (optionally) in-session, de-duplicated, ascending OHLCV frame."""
    now = time.time() if now is None else now
    rth = (timeframe in RTH_INTERVALS) if rth_only is None else rth_only
    step = INTERVAL_SEC[timeframe]
    out = []
    for r in rows:
        if not isinstance(r, (list, tuple)) or len(r) < 6:
            continue
        try:
            ts = int(float(r[0]))
            vals = [float(x) for x in r[1:6]]
        except (TypeError, ValueError):
            continue
        if ts <= 0 or ts + step > now:                     # forming bar
            continue
        if rth and not in_rth(ts, timeframe):
            continue
        out.append({"timestamp": ts, "open": vals[0], "high": vals[1], "low": vals[2],
                    "close": vals[3], "volume": vals[4], "session": r[6] if len(r) > 6 else None})
    df = pd.DataFrame(out, columns=["timestamp", "open", "high", "low", "close", "volume", "session"])
    return df.drop_duplicates("timestamp", keep="last").sort_values("timestamp").reset_index(drop=True)


def candles(symbol: str, timeframe: str, bars: int = 3000, rth_only: bool | None = None) -> pd.DataFrame:
    """Newest `bars` closed bars for a US equity (e.g. 'NVDA')."""
    rth = (timeframe in RTH_INTERVALS) if rth_only is None else rth_only
    ask = min(bars * CALENDAR_FACTOR if rth else bars + 2, MAX_LIMIT)
    df = parse(fetch_raw(symbol, timeframe, ask), timeframe, rth_only=rth)
    if df.empty:
        raise CoinglassError(f"no closed {'RTH ' if rth else ''}bars for {symbol} {timeframe}")
    return df.tail(bars).drop(columns="session").reset_index(drop=True)
