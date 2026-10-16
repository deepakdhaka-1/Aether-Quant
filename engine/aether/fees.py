"""Builder-fee revenue ledger.

For every active broker account, pull `userFillsByTime` since the last recorded fill and upsert one
`builder_fees` row per fill that carries a `builderFee` (docs: the field is omitted when 0, and the
fill's `fee` is inclusive of it). Idempotent: `fill_hash` is "<tx hash>:<tid>" (a tx hash alone is
NOT unique -- one taker order crossing several makers yields several fills with the same hash).

    python -m aether.cli fees
"""
from __future__ import annotations

import logging
import time
from datetime import datetime, timezone

from . import hyperliquid as hl
from .db import client

log = logging.getLogger("aether.fees")
PAGE = 2000                      # venue max per userFillsByTime response
DEFAULT_LOOKBACK_MS = 30 * 86_400_000
TESTNET = "https://api.hyperliquid-testnet.xyz"


def fee_rows(fills: list[dict], broker_account_id: str) -> list[dict]:
    rows = []
    for f in fills:
        fee = float(f.get("builderFee") or 0)
        if fee <= 0:
            continue
        rows.append({
            "broker_account_id": broker_account_id,
            "fill_hash": f"{f.get('hash')}:{f.get('tid')}",
            "coin": f.get("coin"),
            "notional": float(f.get("px") or 0) * float(f.get("sz") or 0),
            "fee_usd": fee,
            "filled_at": datetime.fromtimestamp(int(f["time"]) / 1000, tz=timezone.utc).isoformat(),
        })
    return rows


def fetch_fills(user: str, start_ms: int, base_url: str | None = None) -> list[dict]:
    out: list[dict] = []
    while True:
        page = hl.info({"type": "userFillsByTime", "user": user, "startTime": start_ms,
                        "endTime": int(time.time() * 1000)}, base_url) or []
        out += page
        if len(page) < PAGE:
            return out
        start_ms = max(int(f["time"]) for f in page) + 1   # startTime is inclusive


def run_once(sb=None) -> dict:
    sb = sb or client()
    accounts = (sb.table("broker_accounts").select("id, wallet_address, network")
                  .eq("status", "active").execute().data or [])
    total = 0
    for a in accounts:
        try:
            last = (sb.table("builder_fees").select("filled_at").eq("broker_account_id", a["id"])
                      .order("filled_at", desc=True).limit(1).execute().data or [])
            start = (int(datetime.fromisoformat(last[0]["filled_at"]).timestamp() * 1000) if last
                     else int(time.time() * 1000) - DEFAULT_LOOKBACK_MS)
            fills = fetch_fills(a["wallet_address"], start, TESTNET if a["network"] == "testnet" else None)
            rows = fee_rows(fills, a["id"])
            if rows:
                sb.table("builder_fees").upsert(rows, on_conflict="fill_hash", ignore_duplicates=True).execute()
            total += len(rows)
        except Exception as e:
            log.exception("fee sync failed for %s: %s", a["id"], e)
    return {"accounts": len(accounts), "fee_rows": total}
