"""Bar-by-bar strategy simulation shared by the backtester AND the live signal runner, so the
position a user is put in is exactly the position the published backtest would hold.

Conventions (no look-ahead):
  * rules are evaluated on the CLOSE of bar i; the resulting trade fills at the OPEN of bar i+1;
  * protective levels are decided on bar i too, as DISTANCES (percent of bar i's close), and
    applied to the fill price -- the live executor does exactly the same with its fill price;
  * stop-loss / take-profit are checked intrabar on bars after entry; if both are touched in the
    same bar the stop is assumed to fill first (pessimistic);
  * fees are charged per side on notional (Hyperliquid taker + our builder fee by default).

Exit types (any combination; the tightest stop and nearest target win):
  * fixed percent         stop_loss_pct / take_profit_pct
  * ATR multiple          sl_atr_mult / tp_atr_mult x atr_col (default atr_value) on bar i
  * structure anchor      sl_anchor = 'swing' (lowest low / highest high of the last
                          swing_lookback bars up to bar i) | 'psar' | 'supertrend' | <column>;
                          stop = anchor -/+ sl_buffer_atr x ATR, clamped to
                          [sl_atr_min, sl_atr_max] x ATR; target = rr_ratio x stop distance
  * time limit            time_limit_hours: exit at the next open once held that long
  * weekend exit          weekend_exit: flat at the close of any bar ending between Friday 16:00
                          and Sunday 18:00 ET; no entries decided in that window
  * rule exits            exit_long / exit_short, which may use entry_price
                          (e.g. "close <= entry_price * 0.98")
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Optional
from zoneinfo import ZoneInfo

import numpy as np
import pandas as pd

from .rules import Rule, compile_rule, extract_tp_sl

DEFAULT_FEE = 0.00045 + 0.0003     # HL taker 4.5 bps + builder 3 bps, per side
BARS_PER_YEAR = {"5m": 105120, "15m": 35040, "1h": 8760, "4h": 2190, "1d": 365}
TF_SECONDS = {"5m": 300, "15m": 900, "1h": 3600, "4h": 14400, "1d": 86400}
PERIOD_DAYS = {"3 Years": 1095, "2 Years": 730, "12 Months": 365, "6 Months": 180,
               "3 Months": 90, "1 Month": 30, "1 Week": 7}
ET = ZoneInfo("America/New_York")
_ANCHOR_COLUMNS = {"psar": "psar_value", "supertrend": "supertrend_value"}


@dataclass
class StrategySpec:
    entry_long: Optional[str] = None
    exit_long: Optional[str] = None
    entry_short: Optional[str] = None
    exit_short: Optional[str] = None
    direction: str = "both"
    stop_loss_pct: Optional[float] = None
    take_profit_pct: Optional[float] = None
    leverage: float = 1.0
    timeframe: str = "1h"
    # ---- extended exits (optional) ----
    sl_atr_mult: Optional[float] = None
    tp_atr_mult: Optional[float] = None
    atr_col: str = "atr_value"
    sl_anchor: Optional[str] = None
    sl_buffer_atr: float = 0.25
    swing_lookback: int = 10
    sl_atr_min: float = 0.5
    sl_atr_max: float = 6.0
    rr_ratio: float = 2.0
    time_limit_hours: Optional[float] = None
    weekend_exit: bool = False

    EXTRA_KEYS = ("sl_atr_mult", "tp_atr_mult", "atr_col", "sl_anchor", "sl_buffer_atr", "swing_lookback",
                  "sl_atr_min", "sl_atr_max", "rr_ratio", "time_limit_hours", "weekend_exit")

    @classmethod
    def from_row(cls, row: dict) -> "StrategySpec":
        """A strategies row. Extended exits come from the row itself or generation_meta.exits;
        TP/SL written as text in the exit rules ("SL 1.5 * atr_value", "TP: 3%") fill any gaps."""
        meta = row.get("generation_meta") or {}
        extra = {**(meta.get("exits") or {}), **{k: row[k] for k in cls.EXTRA_KEYS if row.get(k) is not None}}
        spec = cls(
            entry_long=row.get("entry_long"), exit_long=row.get("exit_long"),
            entry_short=row.get("entry_short"), exit_short=row.get("exit_short"),
            direction=row.get("direction") or "both",
            stop_loss_pct=_f(row.get("stop_loss_pct")), take_profit_pct=_f(row.get("take_profit_pct")),
            leverage=float(row.get("default_leverage") or 1), timeframe=row.get("timeframe") or "1h")
        for k in cls.EXTRA_KEYS:
            if extra.get(k) is not None:
                v = extra[k]
                setattr(spec, k, bool(v) if k == "weekend_exit" else v if k in ("atr_col", "sl_anchor")
                        else int(v) if k == "swing_lookback" else float(v))
        spec.apply_text_exits()
        return spec

    def apply_text_exits(self) -> None:
        text = " ".join(x for x in (self.exit_long, self.exit_short) if x)
        if not re.search(r"\b(tp|sl|take profit|stop loss)\b", text, re.IGNORECASE):
            return
        t = extract_tp_sl(text)
        if self.stop_loss_pct is None and t["sl_pct"]:
            self.stop_loss_pct = t["sl_pct"]
        if self.take_profit_pct is None and t["tp_pct"]:
            self.take_profit_pct = t["tp_pct"]
        if self.sl_atr_mult is None and t["sl_atr_mult"]:
            self.sl_atr_mult, self.atr_col = t["sl_atr_mult"], t["atr_col"]
        if self.tp_atr_mult is None and t["tp_atr_mult"]:
            self.tp_atr_mult, self.atr_col = t["tp_atr_mult"], t["atr_col"]
        if self.time_limit_hours is None and t["time_limit_hours"]:
            self.time_limit_hours = float(t["time_limit_hours"])



def _f(v):
    return None if v in (None, "") else float(v)


@dataclass
class Trade:
    side: str
    entry_time: int
    entry_price: float
    exit_time: Optional[int] = None
    exit_price: Optional[float] = None
    reason: str = ""
    pnl_pct: float = 0.0          # leveraged, net of fees, % of allocated equity
    sl_price: Optional[float] = None
    tp_price: Optional[float] = None


@dataclass
class SimResult:
    trades: list[Trade] = field(default_factory=list)
    position: str = "flat"        # position held after the last bar
    position_reason: str = ""
    equity: list[tuple[int, float]] = field(default_factory=list)
    # Protective distances for the position wanted NOW (percent of price), for the venue bracket.
    sl_pct: Optional[float] = None
    tp_pct: Optional[float] = None


def compile_spec(spec: StrategySpec, columns: set[str] | None = None) -> dict[str, Optional[Rule]]:
    return {"entry_long": compile_rule(spec.entry_long, columns),
            "exit_long": compile_rule(spec.exit_long, columns, side="long"),
            "entry_short": compile_rule(spec.entry_short, columns),
            "exit_short": compile_rule(spec.exit_short, columns, side="short")}


def in_weekend_window(ts_sec: int) -> bool:
    """Friday 16:00 ET .. Sunday 18:00 ET (US equity/futures weekend)."""
    t = datetime.fromtimestamp(int(ts_sec), tz=timezone.utc).astimezone(ET)
    wd, h = t.weekday(), t.hour
    return (wd == 4 and h >= 16) or wd == 5 or (wd == 6 and h < 18)


def protective_distances(spec: StrategySpec, df: pd.DataFrame, i: int, side: str) -> tuple[Optional[float], Optional[float]]:
    """(stop %, target %) decided on bar i, as % of bar i's close. Tightest stop, nearest target."""
    c = float(df["close"].iat[i])
    if not c or c != c:
        return None, None
    atr = None
    if spec.atr_col in df.columns:
        a = pd.to_numeric(df[spec.atr_col], errors="coerce").iat[i]
        atr = float(a) if a == a and a > 0 else None
    sls, tps = [], []
    if spec.stop_loss_pct:
        sls.append(float(spec.stop_loss_pct))
    if spec.take_profit_pct:
        tps.append(float(spec.take_profit_pct))
    if atr and spec.sl_atr_mult:
        sls.append(100 * spec.sl_atr_mult * atr / c)
    if atr and spec.tp_atr_mult:
        tps.append(100 * spec.tp_atr_mult * atr / c)
    if spec.sl_anchor:
        long = side == "long"
        buf = spec.sl_buffer_atr * (atr or 0)
        raw = None
        if spec.sl_anchor == "swing":
            lo = max(0, i - int(spec.swing_lookback) + 1)          # bars up to i only
            raw = float(df["low"].iloc[lo:i + 1].min() if long else df["high"].iloc[lo:i + 1].max())
        else:
            col = _ANCHOR_COLUMNS.get(spec.sl_anchor, spec.sl_anchor)
            if col in df.columns:
                v = pd.to_numeric(df[col], errors="coerce").iat[i]
                raw = float(v) if v == v else None
        dist = None
        if raw is not None:
            dist = (c - (raw - buf)) if long else ((raw + buf) - c)
        if atr:
            dist = spec.sl_atr_max * atr if dist is None else dist
            dist = max(spec.sl_atr_min * atr, min(spec.sl_atr_max * atr, dist))
        if dist is None or dist <= 0:
            dist = (spec.sl_atr_max * atr) if atr else c * 0.02
        sls.append(100 * dist / c)
        tps.append(100 * spec.rr_ratio * dist / c)
    return (min(sls) if sls else None), (min(tps) if tps else None)


def simulate(df: pd.DataFrame, spec: StrategySpec, fee: float = DEFAULT_FEE) -> SimResult:
    rules = compile_spec(spec)
    n = len(df)
    df = df.reset_index(drop=True)
    sig = {}
    for k, r in rules.items():
        if r is None or r.uses_entry_price:
            sig[k] = np.zeros(n, dtype=bool)       # entry_price rules are evaluated per trade
        else:
            # np.array(copy) -- pandas 3 copy-on-write hands out READ-ONLY views from to_numpy().
            sig[k] = np.array(r.evaluate(df).to_numpy(), dtype=bool)
    if spec.direction == "long":
        sig["entry_short"][:] = False
    if spec.direction == "short":
        sig["entry_long"][:] = False

    ts = df["timestamp"].to_numpy(dtype=np.int64)
    o, h, l, c = (df[k].to_numpy(dtype=float) for k in ("open", "high", "low", "close"))
    bar_sec = TF_SECONDS.get(spec.timeframe, 3600)
    lev = spec.leverage
    tlim = spec.time_limit_hours * 3600 if spec.time_limit_hours else None

    res = SimResult()
    equity = 1.0
    pos: Optional[Trade] = None
    pos_exit: Optional[np.ndarray] = None            # per-trade exit signal (entry_price rules)
    pending: Optional[tuple[str, str, tuple]] = None  # (action, reason, (sl%, tp%)) for next open

    def close(i_time, px, reason):
        nonlocal equity, pos, pos_exit
        direction = 1 if pos.side == "long" else -1
        gross = direction * (px / pos.entry_price - 1)
        # A leveraged loss can't exceed the allocated margin (the venue liquidates first).
        pos.pnl_pct = max(-100.0, 100 * (gross * lev - 2 * fee * lev))
        pos.exit_time, pos.exit_price, pos.reason = int(i_time), float(px), reason
        equity *= 1 + pos.pnl_pct / 100
        res.trades.append(pos)
        pos, pos_exit = None, None

    def open_(side, i, reason, dists):
        nonlocal pos, pos_exit
        px = float(o[i])
        sl, tp = dists
        pos = Trade(side, int(ts[i]), px, reason=reason)
        if sl:
            pos.sl_price = px * (1 - sl / 100) if side == "long" else px * (1 + sl / 100)
        if tp:
            pos.tp_price = px * (1 + tp / 100) if side == "long" else px * (1 - tp / 100)
        r = rules["exit_long" if side == "long" else "exit_short"]
        pos_exit = (np.array(r.evaluate(df, {"entry_price": px}).to_numpy(), dtype=bool)
                    if r is not None and r.uses_entry_price else None)

    for i in range(n):
        # 1) fill whatever the previous close decided, at this bar's open
        if pending is not None and not np.isnan(o[i]):
            action, reason, dists = pending
            if action in ("exit", "flip_long", "flip_short") and pos is not None:
                close(ts[i], o[i], reason)
            if action in ("long", "flip_long"):
                open_("long", i, reason, dists)
            elif action in ("short", "flip_short"):
                open_("short", i, reason, dists)
            pending = None

        # 2) intrabar protective exits (a position filled at this open can be stopped this bar)
        if pos is not None:
            sp, tpp = pos.sl_price, pos.tp_price
            if pos.side == "long":
                if sp and l[i] <= sp:
                    close(ts[i], min(o[i], sp), "stop_loss")
                elif tpp and h[i] >= tpp:
                    close(ts[i], max(o[i], tpp), "take_profit")
            else:
                if sp and h[i] >= sp:
                    close(ts[i], max(o[i], sp), "stop_loss")
                elif tpp and l[i] <= tpp:
                    close(ts[i], min(o[i], tpp), "take_profit")

        # 3) weekend: flat at this close, no entries decided in the window
        weekend = spec.weekend_exit and in_weekend_window(ts[i] + bar_sec)
        if weekend and pos is not None:
            close(ts[i], c[i], "weekend_exit")

        # 4) evaluate rules on this close -> action for next open
        def entry(side):
            return (side, f"entry_{side}", protective_distances(spec, df, i, side))

        if weekend:
            pass
        elif pos is None:
            if sig["entry_long"][i]:
                pending = entry("long")
            elif sig["entry_short"][i]:
                pending = entry("short")
        else:
            key = "exit_long" if pos.side == "long" else "exit_short"
            exit_now = sig[key][i] or (pos_exit is not None and pos_exit[i])
            if pos.side == "long" and sig["entry_short"][i]:
                pending = ("flip_short", *entry("short")[1:])
            elif pos.side == "short" and sig["entry_long"][i]:
                pending = ("flip_long", *entry("long")[1:])
            elif exit_now:
                pending = ("exit", key, (None, None))
            elif tlim and ts[i] + bar_sec - pos.entry_time >= tlim:
                pending = ("exit", "time_limit", (None, None))

        mark = equity
        if pos is not None:
            d = 1 if pos.side == "long" else -1
            mark = equity * max(0.0, 1 + (d * (c[i] / pos.entry_price - 1) - fee) * lev)
        res.equity.append((int(ts[i]), float(mark)))

    # Desired position NOW = the position after acting on the last closed bar's decision.
    if pending is not None:
        action, reason, dists = pending
        res.position = {"long": "long", "flip_long": "long", "short": "short",
                        "flip_short": "short", "exit": "flat"}[action]
        res.position_reason = reason
        if res.position != "flat":
            res.sl_pct, res.tp_pct = dists
    else:
        res.position = pos.side if pos else "flat"
        res.position_reason = pos.reason if pos else ""
        if pos is not None:
            if pos.sl_price:
                res.sl_pct = abs(pos.sl_price / pos.entry_price - 1) * 100
            if pos.tp_price:
                res.tp_pct = abs(pos.tp_price / pos.entry_price - 1) * 100
    if pos is not None:
        res.trades.append(pos)    # open trade, exit_time None
    return res


def trade_metrics(pnls_pct: list[float], risk_free_rate_annual: float = 0.05) -> dict:
    """Per-trade statistics (research definitions): compounded and simple return, win rate,
    profit factor (10 when there are no losing trades), drawdown on the trade-by-trade equity,
    and a per-trade Sharpe annualised with 252 trades a year."""
    p = [x / 100 for x in pnls_pct]
    if not p:
        return {"compounded_return_pct": 0.0, "simple_return_pct": 0.0, "trade_max_drawdown_pct": 0.0,
                "trade_sharpe": 0.0, "pf": 0.0}
    cum = np.cumprod([1 + x for x in p])
    peak = np.maximum.accumulate(cum)
    pos, neg = sum(x for x in p if x > 0), abs(sum(x for x in p if x < 0))
    sharpe = 0.0
    if len(p) >= 2:
        sd = np.std(p, ddof=1) * np.sqrt(252.0)
        if sd > 1e-9:
            sharpe = float((np.mean(p) * 252.0 - risk_free_rate_annual) / sd)
    return {
        "compounded_return_pct": round(float((cum[-1] - 1) * 100), 2),
        "simple_return_pct": round(float(sum(p) * 100), 2),
        "trade_max_drawdown_pct": round(float(((cum - peak) / peak).min() * 100), 2),
        "trade_sharpe": round(sharpe, 2),
        "pf": round(float(pos / neg) if neg > 0 else (10.0 if pos > 0 else 0.0), 2),
    }


def metrics(res: SimResult, timeframe: str = "1h") -> dict:
    closed = [t for t in res.trades if t.exit_time is not None]
    eq = np.array([e for _, e in res.equity]) if res.equity else np.array([1.0])
    rets = np.diff(eq) / eq[:-1] if len(eq) > 1 else np.array([0.0])
    peak = np.maximum.accumulate(eq)
    max_dd = float(((eq - peak) / peak).min() * 100) if len(eq) else 0.0
    wins = [t.pnl_pct for t in closed if t.pnl_pct > 0]
    losses = [t.pnl_pct for t in closed if t.pnl_pct <= 0]
    std = rets.std()
    sharpe = float(rets.mean() / std * np.sqrt(BARS_PER_YEAR.get(timeframe, 8760))) if std > 0 else 0.0
    out = {
        "return_pct": round(float((eq[-1] - 1) * 100), 2),
        "max_drawdown_pct": round(max_dd, 2),
        "sharpe": round(sharpe, 2),
        "trades": len(closed),
        "win_rate": round(100 * len(wins) / len(closed), 1) if closed else 0.0,
        "profit_factor": round(float(sum(wins) / abs(sum(losses))), 2) if losses and sum(losses) != 0 else None,
        "avg_trade_pct": round(float(np.mean([t.pnl_pct for t in closed])), 3) if closed else 0.0,
    }
    tm = trade_metrics([t.pnl_pct for t in closed])
    tm.pop("pf")
    out.update(tm)
    return out


def period_metrics(res: SimResult, timeframe: str = "1h") -> dict[str, dict]:
    """The same metrics over trailing windows ending at the last bar ('1 Week' .. '3 Years').
    Only windows the data fully covers are reported."""
    if not res.equity:
        return {}
    t0, t_end = res.equity[0][0], res.equity[-1][0]
    out = {}
    for label, days in PERIOD_DAYS.items():
        start = t_end - days * 86400
        if start < t0:
            continue
        curve = [(t, e) for t, e in res.equity if t >= start]
        base = curve[0][1] or 1.0
        sub = SimResult(trades=[t for t in res.trades if t.entry_time >= start],
                        equity=[(t, e / base) for t, e in curve])
        out[label] = metrics(sub, timeframe)
    return out


def downsample(curve: list[tuple[int, float]], points: int = 300) -> list[list[float]]:
    if len(curve) <= points:
        return [[t, round(e, 5)] for t, e in curve]
    idx = np.linspace(0, len(curve) - 1, points).astype(int)
    return [[curve[i][0], round(curve[i][1], 5)] for i in idx]


def run_backtest(df: pd.DataFrame, spec: StrategySpec, fee: float = DEFAULT_FEE) -> dict:
    res = simulate(df, spec, fee)
    m = metrics(res, spec.timeframe)
    return {
        "metrics": m,
        "periods": period_metrics(res, spec.timeframe),
        "equity_curve": downsample(res.equity),
        "trades": [t.__dict__ for t in res.trades[-500:]],
        "period_start": int(df["timestamp"].iloc[0]) if len(df) else None,
        "period_end": int(df["timestamp"].iloc[-1]) if len(df) else None,
        "position": res.position,
    }
