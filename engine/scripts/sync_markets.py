"""Reconcile the `markets` table with the live HIP-3 universe (read-only on Hyperliquid).

* every existing row: max_leverage <- venue maxLeverage, active <- listed and not delisted;
* --add-new: also insert venue coins we don't have yet (inactive, asset_class guessed, name = ticker)
  so an admin can review and switch them on.

    python scripts/sync_markets.py            # dry run: print the diff
    python scripts/sync_markets.py --apply    # write with the service role
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from aether import config, hyperliquid  # noqa: E402

COMMODITIES = {"GOLD", "SILVER", "CL", "BRENTOIL", "NATGAS", "COPPER", "PLATINUM", "PALLADIUM",
               "ALUMINIUM", "URANIUM", "CORN", "WHEAT", "HO", "TTF"}
INDICES = {"XYZ100", "SP500", "JP225", "KR200", "NIFTY", "IBOV", "DXY", "VIX"}


def live_universe(dex: str) -> dict[str, dict]:
    meta = hyperliquid.info({"type": "meta", "dex": dex})
    return {a["name"]: a for a in meta.get("universe", [])}


def plan(rows: list[dict], uni: dict[str, dict], add_new: bool, dex: str) -> list[dict]:
    changes, have = [], {r["hl_coin"] for r in rows}
    for r in rows:
        a = uni.get(r["hl_coin"])
        active = bool(a) and not a.get("isDelisted", False)
        lev = a.get("maxLeverage") if a else r.get("max_leverage")
        if bool(r.get("active")) != active or (lev is not None and float(r.get("max_leverage") or 0) != float(lev)):
            changes.append({"symbol": r["symbol"], "name": r["name"], "asset_class": r["asset_class"],
                            "hl_coin": r["hl_coin"], "max_leverage": lev, "active": active})
    if add_new:
        for name, a in uni.items():
            if name in have or a.get("isDelisted"):
                continue
            t = name.split(":", 1)[1]
            changes.append({"symbol": t, "name": t, "hl_coin": name, "max_leverage": a.get("maxLeverage"),
                            "asset_class": "commodity" if t in COMMODITIES else "index" if t in INDICES else "equity",
                            "active": False})
    return changes


def main():
    p = argparse.ArgumentParser()
    p.add_argument("--apply", action="store_true")
    p.add_argument("--add-new", action="store_true")
    a = p.parse_args()
    from aether.db import client
    sb = client()
    rows = sb.table("markets").select("*").execute().data or []
    uni = live_universe(config.HIP3_DEX)
    changes = plan(rows, uni, a.add_new, config.HIP3_DEX)
    missing = [r["hl_coin"] for r in rows if r["hl_coin"] not in uni]
    print(json.dumps({"db_rows": len(rows), "venue_coins": len(uni), "missing_on_venue": missing,
                      "changes": changes}, indent=2))
    if a.apply and changes:
        sb.table("markets").upsert(changes, on_conflict="symbol").execute()
        print(f"applied {len(changes)} change(s)")


if __name__ == "__main__":
    main()
