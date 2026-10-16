"""Golden files for cross-language parity (Edge Functions vs this engine).

For NVDA 1h (CoinGlass, regular session) and GOLD 4h (Hyperliquid candles) this writes
engine/fixtures/<symbol>_<tf>.json with:
  * ohlcv       ~600 closed bars: timestamp (bar open, epoch s), open, high, low, close, volume
  * indicators  every indicator column the engine produces for those bars (null = NaN)
  * rules       two sample strategies and, per bar, the position the simulator holds after acting on
                that bar's close ("long" | "short" | "flat"), plus the trades and metrics

Indicators are computed on the SAME 600 bars that are exported, so a TS port fed the fixture's
OHLCV must reproduce the indicator values exactly (to float tolerance), warm-up rows included.

    python scripts/parity_fixture.py            # live fetch (network)
"""
from __future__ import annotations

import json
import math
import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from aether import data, indicators  # noqa: E402
from aether.backtest import StrategySpec, run_backtest, simulate  # noqa: E402

BARS = 600
OUT = Path(__file__).resolve().parents[1] / "fixtures"
CASES = [
    ("NVDA", "1h", {"asset_class": "equity", "hl_coin": "xyz:NVDA"}),
    ("GOLD", "4h", {"asset_class": "commodity", "hl_coin": "xyz:GOLD"}),
]
RULES = {
    "rsi_reversion": {"entry_long": "rsi_value < 35", "exit_long": "rsi_value > 55",
                      "direction": "long", "stop_loss_pct": 3.0},
    "macd_cross_both": {"entry_long": "macdext_MACD crosses above macdext_MACDSignal and adx_value > 20",
                        "entry_short": "macdext_MACD crosses below macdext_MACDSignal and adx_value > 20",
                        "direction": "both", "sl_atr_mult": 2.0, "tp_atr_mult": 4.0},
}


def _num(v):
    if v is None:
        return None
    if isinstance(v, str):
        return v
    f = float(v)
    return None if math.isnan(f) or math.isinf(f) else f


def positions_by_bar(df, spec) -> list[str]:
    """Position after each bar's decision -- the live signal the runtime would publish at that bar."""
    return [simulate(df.iloc[: i + 1], spec, fee=0).position for i in range(len(df))]


def build(symbol: str, tf: str, market: dict) -> dict:
    # fetch the full window: CoinGlass drops out-of-session bars after applying its limit
    ohlcv = data.ohlcv(symbol, tf, bars=5000, market=market).tail(BARS).reset_index(drop=True)
    ind = indicators.compute(ohlcv, tf)
    cols = [c for c in ind.columns if c not in ("timestamp", "open", "high", "low", "close", "volume")]
    rules_out = {}
    for name, r in RULES.items():
        spec = StrategySpec(timeframe=tf, **r)
        bt = run_backtest(ind, spec, fee=0)
        rules_out[name] = {"spec": {**r, "timeframe": tf, "fee": 0},
                           "positions": positions_by_bar(ind, spec),
                           "trades": bt["trades"], "metrics": bt["metrics"]}
    return {
        "symbol": symbol, "timeframe": tf, "source": ohlcv.attrs.get("source"),
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "conventions": {"timestamp": "bar open, epoch seconds UTC", "closed_bars_only": True,
                        "session": "regular trading hours (ET 09-15 bar opens)" if market["asset_class"] == "equity"
                        and tf == "1h" else "all bars",
                        "fill": "rule on bar i close -> fill at bar i+1 open",
                        "fee_per_side": 0},
        "ohlcv": [{k: _num(v) if k != "timestamp" else int(v) for k, v in row.items()}
                  for row in ohlcv[["timestamp", "open", "high", "low", "close", "volume"]].to_dict("records")],
        "indicator_columns": cols,
        "indicators": [{c: _num(v) for c, v in row.items()} for row in ind[["timestamp"] + cols].to_dict("records")],
        "rules": rules_out,
    }


def main():
    OUT.mkdir(exist_ok=True)
    for sym, tf, market in CASES:
        fx = build(sym, tf, market)
        path = OUT / f"{sym.lower()}_{tf}.json"
        path.write_text(json.dumps(fx, separators=(",", ":")), encoding="utf-8")
        print(f"{path.name}: {len(fx['ohlcv'])} bars from {fx['source']}, {len(fx['indicator_columns'])} columns, "
              + ", ".join(f"{k}: {v['metrics']['trades']} trades" for k, v in fx["rules"].items()))


if __name__ == "__main__":
    main()
