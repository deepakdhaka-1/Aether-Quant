"""Tiny cron sidecar for docker-compose (no system cron: env vars stay in the process, logs go to stdout).

Reads deploy/crontab ("<5-field cron> <command>" lines), checks once per minute (aligned to :00),
and starts each due command as a subprocess. A job is skipped if its previous run is still going
(the executor additionally has the DB lease lock). Supports *, */n, a-b, a-b/n and comma lists.
"""
import shlex
import subprocess
import sys
import time
from datetime import datetime, timezone

RANGES = [(0, 59), (0, 23), (1, 31), (1, 12), (0, 6)]


def _field(spec: str, lo: int, hi: int) -> set[int]:
    out: set[int] = set()
    for part in spec.split(","):
        rng, _, step = part.partition("/")
        a, b = (lo, hi) if rng == "*" else (int(rng.split("-")[0]), int(rng.split("-")[-1]))
        out.update(range(a, b + 1, int(step or 1)))
    return out


def parse(path: str):
    jobs = []
    for line in open(path, encoding="utf-8"):
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        parts = line.split(None, 5)
        sets = [_field(p, *r) for p, r in zip(parts[:5], RANGES)]
        jobs.append((sets, parts[5]))
    return jobs


def due(sets, t: datetime) -> bool:
    dow = (t.weekday() + 1) % 7            # cron: 0 = Sunday
    return (t.minute in sets[0] and t.hour in sets[1] and t.day in sets[2]
            and t.month in sets[3] and dow in sets[4])


def main(path: str):
    jobs = parse(path)
    running: dict[str, subprocess.Popen] = {}
    print(f"scheduler: {len(jobs)} jobs from {path}", flush=True)
    while True:
        time.sleep(60 - time.time() % 60 + 0.5)
        now = datetime.now(timezone.utc)
        for sets, cmd in jobs:
            if not due(sets, now):
                continue
            p = running.get(cmd)
            if p and p.poll() is None:
                print(f"{now:%H:%M} skip (still running): {cmd}", flush=True)
                continue
            print(f"{now:%H:%M} run: {cmd}", flush=True)
            running[cmd] = subprocess.Popen(shlex.split(cmd))


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "/deploy/crontab")
