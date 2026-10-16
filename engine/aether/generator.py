"""Strategy generation with an OFFLINE model.

Any OpenAI-compatible local server works (Ollama, LM Studio, llama.cpp server, vLLM):
    OFFLINE_MODEL_URL=http://localhost:11434/v1   OFFLINE_MODEL_NAME=qwen2.5:14b

Pipeline: prompt -> JSON candidates -> compile against the real indicator columns -> backtest on
the in-sample window -> re-test on the held-out window -> keep only robust ones -> save as
status='backtested' for an admin to review and publish. Nothing the model writes is ever executed
as code (see rules.py), and nothing reaches users without an admin publishing it.

You can also skip the model call and import candidates you produced elsewhere:
    python -m aether.cli import-strategies candidates.json --symbol NVDA --timeframe 1h
"""
from __future__ import annotations

import json
import logging
import re
from datetime import datetime, timezone

import requests

from . import config, data, indicators
from .backtest import StrategySpec, run_backtest
from .indicators import NATIVE_COLUMNS
from .rules import RuleError, compile_rule

log = logging.getLogger("aether.generator")

PROMPT = """You design rule-based trading strategies for {symbol} ({name}, {asset_class}) on the {timeframe} timeframe.
It trades as a perpetual on Hyperliquid. US equities only move in US market hours; keep that in mind.

Available columns (current bar). Append _prev or _prevN for N bars back:
open, high, low, close, volume, {columns}

Rule syntax: comparisons joined with and/or/not, + - * /, numbers, abs/min/max,
and "X crosses above Y" / "X crosses below Y". Nothing else.

Recent market context (last bar): {context}

Return ONLY a JSON array of {n} objects:
[{{"name": str, "description": str (one sentence: the edge and when it works),
   "direction": "long"|"short"|"both",
   "entry_long": str|null, "exit_long": str|null, "entry_short": str|null, "exit_short": str|null,
   "stop_loss_pct": number, "take_profit_pct": number|null, "leverage": number (1-5)}}]
Make the {n} strategies use different ideas (trend, mean reversion, breakout, volatility, volume)."""

# Minimum bar a candidate must clear on BOTH windows to be saved.
GATES = {"min_trades": 15, "min_sharpe": 0.5, "max_dd_pct": -35.0}


def ask_model(prompt: str) -> str:
    r = requests.post(f"{config.OFFLINE_MODEL_URL.rstrip('/')}/chat/completions", timeout=600, json={
        "model": config.OFFLINE_MODEL_NAME,
        "messages": [{"role": "user", "content": prompt}],
        "temperature": 0.7,
    })
    r.raise_for_status()
    return r.json()["choices"][0]["message"]["content"]


def parse_candidates(text: str) -> list[dict]:
    m = re.search(r"\[[\s\S]*\]", text)
    if not m:
        raise ValueError("model reply contained no JSON array")
    return json.loads(m.group(0))


def evaluate(df, cand: dict, timeframe: str, holdout: float = 0.3) -> dict:
    """Validate rules and backtest in-sample + out-of-sample. Raises RuleError on bad rules."""
    cols = set(df.columns)
    for k in ("entry_long", "exit_long", "entry_short", "exit_short"):
        compile_rule(cand.get(k), cols)
    spec = StrategySpec(
        entry_long=cand.get("entry_long"), exit_long=cand.get("exit_long"),
        entry_short=cand.get("entry_short"), exit_short=cand.get("exit_short"),
        direction=cand.get("direction") or "both",
        stop_loss_pct=cand.get("stop_loss_pct"), take_profit_pct=cand.get("take_profit_pct"),
        leverage=float(min(max(cand.get("leverage") or 1, 1), 5)), timeframe=timeframe)
    split = int(len(df) * (1 - holdout))
    ins, oos = run_backtest(df.iloc[:split].reset_index(drop=True), spec), \
               run_backtest(df.iloc[split:].reset_index(drop=True), spec)
    full = run_backtest(df, spec)

    def ok(m, share):
        return (m["trades"] >= GATES["min_trades"] * share
                and m["sharpe"] >= GATES["min_sharpe"] and m["max_drawdown_pct"] >= GATES["max_dd_pct"])

    return {"spec": spec, "in_sample": ins["metrics"], "out_of_sample": oos["metrics"], "full": full,
            "passed": ok(ins["metrics"], 1 - holdout) and ok(oos["metrics"], holdout)}


def _slug(name: str, symbol: str, timeframe: str) -> str:
    base = re.sub(r"[^a-z0-9]+", "-", f"{symbol}-{timeframe}-{name}".lower()).strip("-")
    return f"{base}-{datetime.now(timezone.utc).strftime('%y%m%d%H%M%S')}"


def save(sb, market: dict, timeframe: str, cand: dict, ev: dict, model: str | None) -> str:
    spec, full = ev["spec"], ev["full"]
    row = sb.table("strategies").insert({
        "slug": _slug(cand.get("name", "strategy"), market["symbol"], timeframe),
        "name": cand.get("name") or "Untitled", "description": cand.get("description"),
        "symbol": market["symbol"], "timeframe": timeframe, "direction": spec.direction,
        "entry_long": spec.entry_long, "exit_long": spec.exit_long,
        "entry_short": spec.entry_short, "exit_short": spec.exit_short,
        "stop_loss_pct": spec.stop_loss_pct, "take_profit_pct": spec.take_profit_pct,
        "default_leverage": spec.leverage, "status": "backtested",
        "source": "offline_model" if model else "manual", "model_name": model,
        "generation_meta": {"in_sample": ev["in_sample"], "out_of_sample": ev["out_of_sample"]},
        "headline_metrics": full["metrics"],
    }).execute().data[0]
    sb.table("backtests").insert({
        "strategy_id": row["id"], "metrics": full["metrics"], "equity_curve": full["equity_curve"],
        "trades": full["trades"],
        "period_start": datetime.fromtimestamp(full["period_start"], tz=timezone.utc).isoformat(),
        "period_end": datetime.fromtimestamp(full["period_end"], tz=timezone.utc).isoformat(),
    }).execute()
    return row["id"]


def generate(sb, symbol: str, timeframe: str, n: int = 5, candidates: list[dict] | None = None,
             keep_failed: bool = False) -> list[dict]:
    market = sb.table("markets").select("*").eq("symbol", symbol).single().execute().data
    df = indicators.compute(data.ohlcv(symbol, timeframe, bars=5000, market=market), timeframe)
    model = None
    if candidates is None:
        last = df.iloc[-1]
        ctx = {k: round(float(last[k]), 4) for k in ("close", "rsi_value", "adx_value", "natr_value", "bbw_value")}
        cols = ", ".join(c for c in NATIVE_COLUMNS if c in df.columns)
        candidates = parse_candidates(ask_model(PROMPT.format(
            symbol=symbol, name=market["name"], asset_class=market["asset_class"], timeframe=timeframe,
            columns=cols, context=json.dumps(ctx), n=n)))
        model = config.OFFLINE_MODEL_NAME
    report = []
    for cand in candidates:
        try:
            ev = evaluate(df, cand, timeframe)
        except (RuleError, ValueError, TypeError) as e:
            report.append({"name": cand.get("name"), "error": str(e)})
            continue
        sid = save(sb, market, timeframe, cand, ev, model) if (ev["passed"] or keep_failed) else None
        report.append({"name": cand.get("name"), "passed": ev["passed"], "strategy_id": sid,
                       "in_sample": ev["in_sample"], "out_of_sample": ev["out_of_sample"]})
    return report
