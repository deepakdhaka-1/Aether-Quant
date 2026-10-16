"""Indicator snapshot ingest: OHLCV -> indicators -> <SYMBOL>_<TOKEN>_TAAPI_Indicator_snapshot.

    python -m aether.cli ingest NVDA 1h            # incremental (cron after each bar close)
    python -m aether.cli ingest GOLD 4h --dry-run  # compute only, report what would be written

The tables (supabase/migrations/0007_indicator_snapshots.sql) are the indicators database new
strategies are researched from. Write rules, each one fixing a real data-quality failure:

  * closed bars only (the sources drop the forming candle);
  * WARM-UP: indicators need history to settle (most within ~300 bars, KVO ~550), so the first
    `warmup` bars of the fetched window are never written. Writing every bar of a rolling window
    on every run made each row's LAST write happen when it was the window's oldest bar, i.e. with
    the least history behind it -- rows rotted to NULL/unconverged values;
  * a run writes only bars the table lacks, plus the newest REWRITE_LATEST bars (their
    price_after_<tf> label fills in once the next bar closes). History is never rewritten;
  * obv/ad/wad are running totals whose level depends on where the window starts: written rows
    are shifted to continue the stored series, so bar-to-bar changes stay true;
  * dpo_value is causal (indicators.compute), never the centred engine value;
  * equities on 1h store regular-session bars only, stamped with bar_et_hour / is_final_rth_bar.
"""
from __future__ import annotations

import logging
import math
from datetime import datetime, timezone

import numpy as np
import pandas as pd

from . import data, indicators
from .sources import coinglass

log = logging.getLogger("aether.ingest")

TOKEN = {"5m": "5min", "15m": "15min", "1h": "1H", "4h": "4H", "1d": "1D"}
LABEL = {"5m": "price_after_5_min", "15m": "price_after_15_min", "1h": "price_after_1_h",
         "4h": "price_after_4_h", "1d": "price_after_1_d"}
WINDOW = 5000                 # bars fetched per run (sources cap what they actually return)
WARMUP = 300                  # bars at the start of the window that are never written
REWRITE_LATEST = 2
CUMULATIVE_COLUMNS = ("obv_value", "ad_value", "wad_value")
SMALLINT_COLUMNS = ("bar_et_hour", "is_final_rth_bar")
BATCH = 500


def table_name(symbol: str, timeframe: str) -> str:
    if timeframe not in TOKEN:
        raise ValueError(f"unsupported timeframe {timeframe!r}")
    return f"{symbol.upper()}_{TOKEN[timeframe]}_TAAPI_Indicator_snapshot"


def _clean(v):
    if v is None:
        return None
    if isinstance(v, (np.floating, float)):
        f = float(v)
        return None if math.isnan(f) or math.isinf(f) else f
    if isinstance(v, (np.integer,)):
        return int(v)
    if isinstance(v, (np.bool_, bool)):
        return int(bool(v))
    if isinstance(v, str):
        return v if v.strip() and v.strip().lower() not in {"nan", "none", "null"} else None
    if pd.isna(v):
        return None
    return v


def build_rows(ind: pd.DataFrame, timeframe: str, asset_class: str, source: str) -> list[dict]:
    """Indicator frame -> table rows (all bars, ordered). Label and session stamps added."""
    from .ta.engine import EXPECTED_INDICATORS
    label = LABEL[timeframe]
    cols = ["open", "high", "low", "close", "volume", "price_value", "price_change"] + \
           [c for c in EXPECTED_INDICATORS if c in ind.columns]
    nxt = ind["close"].shift(-1).tolist()
    stamp = asset_class == "equity" and timeframe in coinglass.RTH_INTERVALS
    now = datetime.now(timezone.utc).isoformat()
    rows = []
    for i, rec in enumerate(ind[["timestamp"] + cols].to_dict("records")):
        ts = int(rec["timestamp"])
        row = {"timestamp": ts,
               "timestampHuman": datetime.fromtimestamp(ts, tz=timezone.utc).strftime("%Y-%m-%d %H:%M UTC"),
               label: _clean(nxt[i]), "source": source, "updated_at": now}
        for c in cols:
            row[c] = _clean(rec[c])
        if stamp:
            row.update(coinglass.session_stamp(ts, timeframe))
        for c in SMALLINT_COLUMNS:
            if row.get(c) is not None:
                row[c] = int(round(row[c]))
        rows.append(row)
    return rows


def select_writes(built: list[dict], stored: dict[int, dict], warmup: int) -> list[dict]:
    """Rows past warm-up that the table lacks, plus the newest REWRITE_LATEST; running totals
    shifted onto the stored series using the newest stored bar this run leaves alone."""
    settled = built[warmup:]
    if not settled:
        return []
    latest = {r["timestamp"] for r in settled[-REWRITE_LATEST:]}
    writes = [dict(r) for r in settled if r["timestamp"] in latest or r["timestamp"] not in stored]
    writing = {r["timestamp"] for r in writes}
    for col in CUMULATIVE_COLUMNS:
        offset = None
        for r in reversed(built):
            if r["timestamp"] in writing:
                continue
            s, c = (stored.get(r["timestamp"]) or {}).get(col), r.get(col)
            if s is not None and c is not None:
                offset = float(s) - float(c)
                break
        if offset is None:
            continue
        for r in writes:
            if r.get(col) is not None:
                r[col] = r[col] + offset
    return writes


def _stored(sb, table: str, since: int) -> dict[int, dict]:
    out: dict[int, dict] = {}
    start = 0
    sel = ",".join(("timestamp",) + CUMULATIVE_COLUMNS)
    while True:
        rows = (sb.table(table).select(sel).gte("timestamp", since).order("timestamp")
                  .range(start, start + 999).execute().data or [])
        for r in rows:
            out[int(r["timestamp"])] = r
        if len(rows) < 1000:
            return out
        start += 1000


def run(symbol: str, timeframe: str, bars: int = WINDOW, warmup: int = WARMUP, dry_run: bool = False,
        sb=None) -> dict:
    sym = symbol.split(":")[-1].upper()
    table = table_name(sym, timeframe)
    market = data.resolve_market(sym)
    df = data.ohlcv(sym, timeframe, bars=bars, market=market)
    if df.empty:
        raise RuntimeError(f"no OHLCV for {sym} {timeframe}")
    source = df.attrs.get("source", "unknown")
    ind = indicators.compute(df, timeframe)
    built = build_rows(ind, timeframe, market["asset_class"], source)
    warm = min(warmup, max(0, len(built) - REWRITE_LATEST))
    if warm < warmup:
        log.warning("%s: only %d bars, warm-up reduced %d -> %d (early rows less settled)",
                    table, len(built), warmup, warm)
    if sb is None and not dry_run:
        from .db import client
        sb = client()
    stored = _stored(sb, table, built[0]["timestamp"]) if sb is not None else {}
    writes = select_writes(built, stored, warm)
    out = {"table": table, "source": source, "bars": len(built), "warmup": warm,
           "stored_in_window": len(stored), "writes": len(writes), "dry_run": dry_run,
           "first": writes[0]["timestamp"] if writes else None,
           "last": writes[-1]["timestamp"] if writes else None}
    if dry_run or not writes:
        return out
    for i in range(0, len(writes), BATCH):
        sb.table(table).upsert(writes[i:i + BATCH], on_conflict="timestamp").execute()
    log.info("%s: wrote %d rows from %s", table, len(writes), source)
    return out
