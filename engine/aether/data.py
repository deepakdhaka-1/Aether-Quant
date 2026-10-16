"""OHLCV router.

    ohlcv(symbol, timeframe, bars)

* equities  -> CoinGlass (regular-session bars on 5m/15m/1h, every bar on 4h/1d), falling back to
               Hyperliquid candles if CoinGlass fails or returns nothing;
* commodities, indices and anything else -> Hyperliquid candles (the HIP-3 venue we trade on).

Every path returns closed bars only, ascending, columns timestamp (epoch s), open, high, low,
close, volume. Also: CSV upload parsing for user backtests.
"""
from __future__ import annotations

import io
import logging

import pandas as pd

from .sources import coinglass
from .sources import hyperliquid_candles

log = logging.getLogger("aether.data")

# Used when the markets table can't be read (tests, CLI without DB). The table is authoritative.
DEFAULT_COMMODITIES = {"GOLD", "SILVER", "CL", "BRENTOIL", "NATGAS", "COPPER", "PLATINUM", "PALLADIUM"}
DEFAULT_INDICES = {"XYZ100"}


def hl_candles(coin: str, timeframe: str, bars: int = 3000, closed_only: bool = True) -> pd.DataFrame:
    """Hyperliquid candles for a venue coin, e.g. 'xyz:GOLD'."""
    return hyperliquid_candles.candles(coin, timeframe, bars=bars, closed_only=closed_only)


def resolve_market(symbol: str, market: dict | None = None) -> dict:
    """{symbol, asset_class, hl_coin} from the given row, the markets table, or defaults."""
    sym = symbol.split(":")[-1].upper()
    if market and market.get("asset_class") and market.get("hl_coin"):
        return {"symbol": sym, **market}
    try:
        from .db import client
        row = (client().table("markets").select("symbol, asset_class, hl_coin").eq("symbol", sym)
               .limit(1).execute().data or [None])[0]
        if row:
            return row
    except Exception as e:                       # noqa: BLE001 - no DB configured is fine here
        log.debug("markets lookup failed for %s: %s", sym, e)
    cls = ("commodity" if sym in DEFAULT_COMMODITIES else "index" if sym in DEFAULT_INDICES else "equity")
    return {"symbol": sym, "asset_class": cls, "hl_coin": f"xyz:{sym}"}


def source_for(asset_class: str) -> str:
    return "coinglass" if asset_class == "equity" else "hyperliquid"


def ohlcv(symbol: str, timeframe: str, bars: int = 3000, market: dict | None = None) -> pd.DataFrame:
    m = resolve_market(symbol, market)
    df, src = None, "hyperliquid"
    if source_for(m["asset_class"]) == "coinglass":
        try:
            df, src = coinglass.candles(m["symbol"], timeframe, bars=bars), "coinglass"
        except Exception as e:                   # noqa: BLE001 - fall back to the venue's candles
            log.warning("CoinGlass failed for %s %s (%s); falling back to Hyperliquid candles",
                        m["symbol"], timeframe, e)
    if df is None or df.empty:
        df, src = hl_candles(m["hl_coin"], timeframe, bars=bars), "hyperliquid"
    df.attrs["source"] = src
    return df


_ALIASES = {"time": "timestamp", "date": "timestamp", "datetime": "timestamp", "ts": "timestamp",
            "o": "open", "h": "high", "l": "low", "c": "close", "v": "volume", "vol": "volume"}


def from_csv(data: bytes | str) -> pd.DataFrame:
    raw = data.decode() if isinstance(data, bytes) else data
    df = pd.read_csv(io.StringIO(raw))
    df.columns = [_ALIASES.get(c.strip().lower(), c.strip().lower()) for c in df.columns]
    missing = {"timestamp", "open", "high", "low", "close", "volume"} - set(df.columns)
    if missing:
        raise ValueError(f"CSV is missing column(s): {', '.join(sorted(missing))}")
    ts = df["timestamp"]
    num = pd.to_numeric(ts, errors="coerce")
    if num.notna().all():
        df["timestamp"] = (num // 1000 if num.max() > 1e11 else num).astype("int64")
    else:
        df["timestamp"] = (pd.to_datetime(ts, utc=True).astype("int64") // 10**9).astype("int64")
    for k in ("open", "high", "low", "close", "volume"):
        df[k] = pd.to_numeric(df[k], errors="coerce")
    return (df.dropna(subset=["open", "high", "low", "close"])
              .sort_values("timestamp").drop_duplicates("timestamp").reset_index(drop=True))
