"""Hyperliquid candleSnapshot OHLCV (public, no key).

Source for HIP-3 commodities and the fallback for equities. The venue serves at most 5000 candles
per request and only the latest 5000 overall; the forming candle is dropped; transient errors are
retried with backoff.
"""
from __future__ import annotations

import logging
import time

import pandas as pd
import requests

from .. import config

log = logging.getLogger("aether.sources.hyperliquid_candles")
TF_MS = {"5m": 300_000, "15m": 900_000, "1h": 3_600_000, "4h": 14_400_000, "1d": 86_400_000}
COLUMNS = ["timestamp", "open", "high", "low", "close", "volume"]


def _post(payload: dict) -> list:
    for attempt in range(4):
        try:
            r = requests.post(f"{config.HYPERLIQUID_API_URL}/info", json=payload, timeout=30)
            r.raise_for_status()
            return r.json() or []
        except requests.RequestException as e:
            if attempt == 3:
                raise
            log.warning("HL candle request failed (attempt %d): %s", attempt + 1, e)
            time.sleep(2 ** attempt)
    return []


def candles(coin: str, timeframe: str, bars: int = 3000, closed_only: bool = True) -> pd.DataFrame:
    """Candles for a Hyperliquid coin, e.g. 'xyz:GOLD'."""
    step = TF_MS[timeframe]
    end = int(time.time() * 1000)
    start = end - step * (min(bars, 5000) + 1)
    rows = _post({"type": "candleSnapshot",
                  "req": {"coin": coin, "interval": timeframe, "startTime": start, "endTime": end}})
    df = pd.DataFrame([{
        "timestamp": int(k["t"]) // 1000, "open_ms": int(k["t"]),
        "open": float(k["o"]), "high": float(k["h"]), "low": float(k["l"]),
        "close": float(k["c"]), "volume": float(k["v"]),
    } for k in rows])
    if df.empty:
        return pd.DataFrame(columns=COLUMNS)
    if closed_only:
        df = df[df["open_ms"] + step <= end]          # never trade on a forming candle
    return (df.drop(columns="open_ms").drop_duplicates("timestamp").sort_values("timestamp")
              .tail(bars).reset_index(drop=True))
