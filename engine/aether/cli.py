"""Command line entry points (also what the schedulers call).

    python -m aether.cli signals                       # one signal pass (cron: */15 * * * *)
    python -m aether.cli execute                       # one executor pass (cron: * * * * *)
    python -m aether.cli fees                          # builder-fee ledger sync (cron: hourly)
    python -m aether.cli generate NVDA 1h --n 5        # ask the offline model for strategies
    python -m aether.cli import-strategies file.json --symbol GOLD --timeframe 4h
    python -m aether.cli backtest-csv data.csv rules.json --timeframe 1h
    python -m aether.cli ingest NVDA 1h [--dry-run]   # indicator snapshot table (cron: after bar close)
"""
import argparse
import json
import logging

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")


def main():
    p = argparse.ArgumentParser(prog="aether")
    sub = p.add_subparsers(dest="cmd", required=True)
    sub.add_parser("signals")
    sub.add_parser("execute")
    sub.add_parser("fees")
    g = sub.add_parser("generate")
    g.add_argument("symbol"); g.add_argument("timeframe"); g.add_argument("--n", type=int, default=5)
    g.add_argument("--keep-failed", action="store_true")
    i = sub.add_parser("import-strategies")
    i.add_argument("file"); i.add_argument("--symbol", required=True); i.add_argument("--timeframe", required=True)
    i.add_argument("--keep-failed", action="store_true")
    b = sub.add_parser("backtest-csv")
    b.add_argument("csv"); b.add_argument("rules"); b.add_argument("--timeframe", default="1h")
    n = sub.add_parser("ingest")
    n.add_argument("symbol"); n.add_argument("timeframe")
    n.add_argument("--bars", type=int, default=5000); n.add_argument("--warmup", type=int, default=300)
    n.add_argument("--dry-run", action="store_true")
    a = p.parse_args()

    if a.cmd == "signals":
        from .signals import run_once
        print(run_once())
    elif a.cmd == "execute":
        from .executor import run_once
        print(run_once())
    elif a.cmd == "fees":
        from .fees import run_once
        print(run_once())
    elif a.cmd in ("generate", "import-strategies"):
        from .db import client
        from .generator import generate
        cands = None
        if a.cmd == "import-strategies":
            with open(a.file, encoding="utf-8") as f:
                cands = json.load(f)
        print(json.dumps(generate(client(), a.symbol.upper(), a.timeframe, n=getattr(a, "n", 5),
                                  candidates=cands, keep_failed=a.keep_failed), indent=2, default=str))
    elif a.cmd == "ingest":
        from .ingest import run
        print(json.dumps(run(a.symbol, a.timeframe, bars=a.bars, warmup=a.warmup, dry_run=a.dry_run), indent=2))
    elif a.cmd == "backtest-csv":
        from . import data, indicators
        from .backtest import StrategySpec, run_backtest
        with open(a.csv, "rb") as f:
            df = indicators.compute(data.from_csv(f.read()), a.timeframe)
        with open(a.rules, encoding="utf-8") as f:
            r = json.load(f)
        spec = StrategySpec(**{k: v for k, v in r.items() if k in StrategySpec.__dataclass_fields__},
                            timeframe=a.timeframe)
        out = run_backtest(df, spec)
        print(json.dumps({"metrics": out["metrics"], "position": out["position"]}, indent=2))


if __name__ == "__main__":
    main()
