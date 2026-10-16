"""Daily retention: keep every account_snapshot for the last N days (default 30), one per
account per UTC day before that.  python engine/scripts/monitor_prune.py [--days 30]"""
import argparse
import logging
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")

from aether.db import client  # noqa: E402

if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("--days", type=int, default=int(os.getenv("SNAPSHOT_FULL_DAYS", "30")))
    a = p.parse_args()
    # The monitor's drawdown check reads 30 days of snapshots; keep >= 30 full days.
    deleted = client().rpc("prune_account_snapshots", {"p_full_days": max(a.days, 30)}).execute().data
    logging.info("pruned %s account_snapshots rows", deleted)
    print(deleted)
