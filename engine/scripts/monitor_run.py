"""Run one monitor pass:  python engine/scripts/monitor_run.py

Works from the repo root or engine/ without installing the package."""
import json
import logging
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), ".."))

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")

from aether.monitor import run_once  # noqa: E402

if __name__ == "__main__":
    out = run_once()
    print(json.dumps(out, default=str))
    # Exit 0 even with crit findings: the alert IS the signal; a non-zero exit would make
    # Cloud Run mark the job failed and (with retries) spam. Set MONITOR_FAIL_ON_CRIT=1 to opt in.
    sys.exit(2 if os.getenv("MONITOR_FAIL_ON_CRIT") == "1" and out["counts"]["crit"] else 0)
