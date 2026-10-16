"""Parse a strategy's exit-logic DSL string into venue-placeable trigger levels.

Mirrors the semantics of Aether's rule language (aether/rules.py):
AND/OR/NOT (any case) become boolean operators, comparisons are
`< <= > >= == !=`, and the per-candle context carries `entry_price, high, low,
close, open, price_value` plus the indicator table's own columns.

A clause becomes a venue trigger when it reads as

    <price field>  <direction>  <level>

where the price field is `high`, `low` or `close`, and the level is an affine
expression over at most: `entry_price`, `close`, and ONE indicator column —

    level = a*entry_price + b*close + c*<indicator> + d

Every exit rule in the strategy corpus falls into one of these tiers:

  TIER "static"  — level depends only on entry_price (+ a constant)
        high >= entry_price * 1.05 or low <= entry_price * 0.97
        close <= (entry_price * 0.9) OR close >= (entry_price * 1.133)
  TIER "atr"     — level is entry_price offset by a multiple of an ATR-class
                   indicator; must be re-resolved from the live ATR each pass
        close >= (entry_price + (2.0 * atr_value))
        high > entry_price + atr_value*2.5 OR low < entry_price - atr_value*4.0
  TIER "dynamic" — level tracks a price-valued indicator, or the current bar's
                   own close; moves every bar
        close < supertrend_value          close > bbands_MiddleBand
        high > close * 1.03               close > psar_value

and everything else is NOT convertible and stays on the software exit path:
oscillator thresholds (`rsi_value > 62`, `stoch_K > 75`, `macdext_macd <
macdext_macdsignal`, `kvo_value < 0`, `willr_value < -80`, ...), session flags
(`is_final_rth_bar == 1`), AND-combined clauses, negations, and a bare `False`
(which simply means "this side never exits on logic").

CONFIRMATION SEMANTICS — the one thing a venue order cannot reproduce. The DSL
tests an intracandle touch of `high`/`low` but a `close`-anchored clause only
fires once the bar CLOSES beyond the level; a venue trigger always fires on
touch. So `confirm` is recorded per spec: "touch" clauses are exact, "close"
clauses fire earlier than the backtest did. That difference is small for a
fixed TP/SL band far from spot (tier static) and large for a level price hugs
(tier dynamic) — which is why the caller gates the tiers separately rather
than treating all convertible clauses alike.

This module has zero Supabase/broker imports — pure string/AST/dataclass — so
it is trivially unit-testable, and the caller supplies the live values
(entry_price / close / indicator) when resolving a spec to a price.
"""
from __future__ import annotations

import ast
import re
from dataclasses import dataclass, field
from typing import Dict, List, Optional, Tuple

# ── transpile, mirroring the rule normaliser ────────────
_AND_RE = re.compile(r"\bAND\b", re.IGNORECASE)
_OR_RE = re.compile(r"\bOR\b", re.IGNORECASE)
_NOT_RE = re.compile(r"\bNOT\b", re.IGNORECASE)
_TRUE_RE = re.compile(r"\bTrue\b", re.IGNORECASE)
_FALSE_RE = re.compile(r"\bFalse\b", re.IGNORECASE)
# bare `=` (not part of <= >= == !=) -> ==
_EQ_RE = re.compile(r"(?<![<>=!])=(?!=)")

# LHS price fields we can hang a venue trigger off. `open`/`price_value` are
# deliberately excluded: neither maps onto a trigger a venue can evaluate
# ("the bar opened past X" is not a touch, and price_value is just an alias
# for close that no exit rule in the corpus actually uses).
_PRICE_FIELDS = {"high", "low", "close"}
# Price references allowed inside the LEVEL expression.
_ENTRY = "entry_price"
_CLOSE = "close"
_LEVEL_PRICE_REFS = {_ENTRY, _CLOSE}

# Indicator families whose value IS a price on the instrument's own scale, so a
# comparison against them is a real price level (a trailing stop, effectively).
_PRICE_LEVEL_INDICATORS = {
    "supertrend", "ema", "sma", "wma", "dema", "tema", "trima", "t3", "kama",
    "hma", "mama", "psar", "sar", "bbands", "keltner", "donchian", "vwap",
    "ichimoku", "tenkan", "kijun", "midpoint", "midprice",
}
# Indicator families that are a price DISTANCE — valid as an offset term added
# to a price, never as a level on their own.
_OFFSET_INDICATORS = {"atr"}

_PROBE_BASE = 1.0
_AFFINE_TOL = 1e-6

_OP_MAP = {
    ast.Lt: "<", ast.LtE: "<=", ast.Gt: ">", ast.GtE: ">=",
    ast.Eq: "==", ast.NotEq: "!=",
}
_FLIP_OP = {"<": ">", "<=": ">=", ">": "<", ">=": "<=", "==": "==", "!=": "!="}

_ALLOWED_EXPR_NODE_TYPES = (
    ast.Name, ast.Constant, ast.BinOp, ast.UnaryOp,
    ast.Add, ast.Sub, ast.Mult, ast.Div, ast.UAdd, ast.USub, ast.Load,
)


def indicator_class(name: str) -> str:
    """'price' (a level), 'atr' (a distance) or 'other' (an oscillator etc.).

    Classified on the family prefix so casing variants in stored rules
    (`bbands_MiddleBand` / `bbands_middleband`, `macdext_MACD` /
    `macdext_macd`) all land the same way. Exact prefix match, never a
    substring: `natr_value` must NOT read as an ATR.
    """
    family = str(name).split("_")[0].lower()
    if family in _OFFSET_INDICATORS:
        return "atr"
    if family in _PRICE_LEVEL_INDICATORS:
        return "price"
    return "other"


@dataclass
class TriggerSpec:
    """One convertible clause, as a resolvable price level."""
    kind: str                     # "tp" | "sl"
    field: str                    # "high" | "low" | "close" (the LHS)
    direction: str                # "up" | "down"
    tier: str                     # "static" | "atr" | "dynamic"
    confirm: str                  # "touch" (high/low LHS) | "close" (close LHS)
    coeffs: Dict[str, float]      # per-variable coefficient (entry_price/close/<indicator>)
    const: float
    indicator: Optional[str]      # indicator column referenced, if any
    source: str                   # original clause text, for logging/audit

    @property
    def is_dynamic(self) -> bool:
        """Level moves bar to bar, so it must be re-resolved every pass."""
        return self.tier in ("atr", "dynamic")

    @property
    def entry_mult(self) -> Optional[float]:
        """Plain `entry_price * K` multiplier, when that is all this is."""
        if self.tier != "static" or abs(self.const) > _AFFINE_TOL:
            return None
        return self.coeffs.get(_ENTRY)

    def level(self, entry_price: float, close: float = None,
              indicator_value: float = None) -> Optional[float]:
        """Resolve to an absolute price, or None when a needed input is missing."""
        out = float(self.const)
        for var, coef in self.coeffs.items():
            if var == _ENTRY:
                if entry_price is None:
                    return None
                out += coef * float(entry_price)
            elif var == _CLOSE:
                if close is None:
                    return None
                out += coef * float(close)
            else:
                if indicator_value is None:
                    return None
                out += coef * float(indicator_value)
        return out if out > 0 else None


_TIER_ORDER = {"static": 0, "atr": 1, "dynamic": 2}


@dataclass
class BracketResult:
    """`tp`/`sl` are the PRIMARY spec per side (the most reliably resolvable
    one); `tp_alts`/`sl_alts` hold any further clauses that also bind on that
    side. A strategy commonly declares both a trailing indicator stop and a
    hard percentage stop —

        close < supertrend_value OR low < entry_price * 0.94

    — and which of those actually fires first is only knowable once both are
    resolved against live values, so the choice is deferred to `choose()`
    rather than guessed at parse time."""
    tp: Optional[TriggerSpec] = None
    sl: Optional[TriggerSpec] = None
    tp_alts: List[TriggerSpec] = field(default_factory=list)
    sl_alts: List[TriggerSpec] = field(default_factory=list)
    fully_covered: bool = False    # every OR-branch reduced to a convertible clause
    skipped: List[str] = field(default_factory=list)

    def specs(self, kind: str) -> List[TriggerSpec]:
        primary = self.tp if kind == "tp" else self.sl
        alts = self.tp_alts if kind == "tp" else self.sl_alts
        return ([primary] if primary else []) + list(alts)

    @property
    def indicators(self) -> List[str]:
        """Indicator columns the caller must supply to resolve every spec."""
        out = set()
        for kind in ("tp", "sl"):
            for s in self.specs(kind):
                if s.indicator:
                    out.add(s.indicator)
        return sorted(out)

    def choose(self, kind: str, entry_price: float, close: float = None,
               indicator_values: Dict[str, float] = None,
               allowed_tiers: Tuple[str, ...] = ("static", "atr"),
               ) -> Optional[Tuple[TriggerSpec, float]]:
        """The (spec, level) that should actually rest at the venue for `kind`.

        Considers every clause on that side whose tier the caller allows and
        whose inputs resolve, then picks the one that would TRIGGER FIRST —
        the lowest level for an upside trigger, the highest for a downside
        one. Picking the first-to-bind is the only safe rule for a protective
        order: resting further out than the strategy's own earliest exit would
        let a position run past where the strategy wanted out.
        """
        values = indicator_values or {}
        candidates = []
        for spec in self.specs(kind):
            if spec.tier not in allowed_tiers:
                continue
            level = spec.level(entry_price, close,
                               values.get(spec.indicator) if spec.indicator else None)
            if level is None:
                continue
            candidates.append((spec, level))
        if not candidates:
            return None
        first = min if candidates[0][0].direction == "up" else max
        return first(candidates, key=lambda c: c[1])

    # Convenience for the plain `entry_price * K` case (the common one).
    @property
    def tp_price_mult(self) -> Optional[float]:
        return self.tp.entry_mult if self.tp else None

    @property
    def sl_price_mult(self) -> Optional[float]:
        return self.sl.entry_mult if self.sl else None


def _normalize(expr: str) -> str:
    s = _AND_RE.sub(" and ", expr)
    s = _OR_RE.sub(" or ", s)
    s = _NOT_RE.sub(" not ", s)
    s = _TRUE_RE.sub("True", s)
    s = _FALSE_RE.sub("False", s)
    s = _EQ_RE.sub("==", s)
    return s.strip()


def _flatten_or(node: ast.AST) -> List[ast.AST]:
    if isinstance(node, ast.BoolOp) and isinstance(node.op, ast.Or):
        out: List[ast.AST] = []
        for v in node.values:
            out.extend(_flatten_or(v))
        return out
    return [node]


def _unparse_safe(node: ast.AST) -> str:
    try:
        return ast.unparse(node)
    except Exception:
        return "<unparseable clause>"


def _names_in(node: ast.AST) -> Optional[List[str]]:
    """Every identifier in `node`, or None if it uses syntax we don't model
    (calls, attributes, subscripts, comparisons nested in arithmetic, ...)."""
    names: List[str] = []
    for n in ast.walk(node):
        if isinstance(n, ast.Name):
            names.append(n.id)
        elif isinstance(n, ast.Constant):
            if isinstance(n.value, bool) or not isinstance(n.value, (int, float)):
                return None
        elif isinstance(n, _ALLOWED_EXPR_NODE_TYPES):
            continue
        else:
            return None
    return names


def _eval_at(node: ast.AST, point: Dict[str, float]) -> float:
    wrapper = ast.Expression(body=node)
    ast.fix_missing_locations(wrapper)
    code = compile(wrapper, "<exit_bracket>", "eval")
    return eval(code, {"__builtins__": {}}, dict(point))


def _affine_coeffs(node: ast.AST, variables: List[str]
                   ) -> Optional[Tuple[Dict[str, float], float]]:
    """Solve `node` as a*v1 + b*v2 + ... + const by probing one variable at a
    time, then validate linearity at an independent point. Returns None when
    the expression is not affine in those variables (e.g. entry_price**2, or a
    variable in a denominator)."""
    try:
        base = {v: _PROBE_BASE for v in variables}
        f0 = _eval_at(node, base)
        coeffs: Dict[str, float] = {}
        for v in variables:
            probe = dict(base)
            probe[v] = _PROBE_BASE + 1.0
            coeffs[v] = _eval_at(node, probe) - f0
        const = f0 - sum(coeffs.values()) * _PROBE_BASE
        check = {v: 3.0 + i * 1.7 for i, v in enumerate(variables)}
        predicted = const + sum(coeffs[v] * check[v] for v in variables)
        actual = _eval_at(node, check)
    except Exception:
        return None
    if abs(predicted - actual) > max(_AFFINE_TOL, abs(actual) * _AFFINE_TOL):
        return None
    return coeffs, const


def _classify_level(node: ast.AST) -> Optional[Tuple[Dict[str, float], float, Optional[str], str]]:
    """(coeffs, const, indicator, tier) for a level expression, or None."""
    names = _names_in(node)
    if names is None:
        return None
    unique = sorted(set(names))

    price_refs = [n for n in unique if n in _LEVEL_PRICE_REFS]
    others = [n for n in unique if n not in _LEVEL_PRICE_REFS]

    indicator = None
    if others:
        if len(others) > 1:
            return None                       # two indicators in one level: not modelled
        indicator = others[0]
        if indicator_class(indicator) == "other":
            return None                       # an oscillator is not a price level

    if not price_refs and indicator is None:
        return None                           # a bare constant is not a bracket

    fit = _affine_coeffs(node, unique)
    if fit is None:
        return None
    coeffs, const = fit
    coeffs = {k: v for k, v in coeffs.items() if abs(v) > _AFFINE_TOL}
    if not coeffs:
        return None

    if indicator and indicator not in coeffs:
        indicator = None                      # it cancelled out of the expression

    if indicator and indicator_class(indicator) == "atr":
        # An ATR term is a DISTANCE: only meaningful offsetting a real price.
        if not any(p in coeffs for p in _LEVEL_PRICE_REFS):
            return None
        tier = "dynamic" if _CLOSE in coeffs else "atr"
    elif indicator:                            # a price-valued indicator level
        tier = "dynamic"
    elif _CLOSE in coeffs:                     # tracks the current bar's own close
        tier = "dynamic"
    else:
        tier = "static"
    return coeffs, const, indicator, tier


def _classify_compare(node: ast.Compare, side: str) -> Optional[TriggerSpec]:
    if len(node.ops) != 1 or len(node.comparators) != 1:
        return None                            # chained comparison: not modelled
    op = node.ops[0]
    if type(op) not in _OP_MAP:
        return None
    op_str = _OP_MAP[type(op)]
    left, right = node.left, node.comparators[0]

    def as_field(n):
        return n.id.lower() if isinstance(n, ast.Name) else None

    left_field, right_field = as_field(left), as_field(right)

    if left_field in _PRICE_FIELDS:
        price_field, level_node, op_norm = left_field, right, op_str
    elif right_field in _PRICE_FIELDS:
        # flip: "entry_price*X <= high"  ==  "high >= entry_price*X"
        price_field, level_node, op_norm = right_field, left, _FLIP_OP[op_str]
    else:
        return None

    if op_norm in (">", ">="):
        direction = "up"
    elif op_norm in ("<", "<="):
        direction = "down"
    else:
        return None                            # ==/!= is not a bracket

    # A touch trigger only reads one way per field: `low` can only be breached
    # downward and `high` upward. `close` can be compared either way.
    if price_field == "low" and direction != "down":
        return None
    if price_field == "high" and direction != "up":
        return None

    classified = _classify_level(level_node)
    if classified is None:
        return None
    coeffs, const, indicator, tier = classified

    # `close` on BOTH sides is an intrabar-range test, not a level vs a
    # reference — only meaningful when the compared field is high/low.
    if _CLOSE in coeffs and price_field == _CLOSE:
        return None

    if side == "short":
        kind = "tp" if direction == "down" else "sl"
    else:
        kind = "sl" if direction == "down" else "tp"

    return TriggerSpec(
        kind=kind, field=price_field, direction=direction, tier=tier,
        confirm="close" if price_field == _CLOSE else "touch",
        coeffs=coeffs, const=const, indicator=indicator,
        source=_unparse_safe(node),
    )


def parse_exit_bracket(expr: Optional[str], side: str) -> BracketResult:
    """side: 'long' | 'short'. Never raises — a parser bug must degrade to
    fully_covered=False / skipped=[...], never an exception that reaches the
    execution bridge."""
    result = BracketResult()
    if not expr or not expr.strip():
        return result
    side = (side or "").strip().lower()
    if side not in ("long", "short"):
        result.skipped.append(f"unknown side {side!r}")
        return result

    try:
        normalized = _normalize(expr)
        tree = ast.parse(normalized, mode="eval").body
    except Exception as e:
        result.skipped.append(f"unparseable: {expr!r} ({e})")
        return result

    # A bare `False` is how a strategy says "this side never exits on logic".
    # That is a clean no-op, not something worth reporting as unconvertible.
    if isinstance(tree, ast.Constant) and isinstance(tree.value, bool):
        return result

    branches = _flatten_or(tree)
    total = len(branches)
    convertible = 0

    for node in branches:
        text = _unparse_safe(node)
        if not isinstance(node, ast.Compare):
            result.skipped.append(text)        # And/Not/anything else
            continue
        spec = _classify_compare(node, side)
        if spec is None:
            result.skipped.append(text)
            continue
        convertible += 1
        if spec.kind == "tp":
            result.tp_alts.append(spec)
        else:
            result.sl_alts.append(spec)

    # Promote the most reliably resolvable clause per side to primary (static
    # before atr before dynamic; ties broken by whichever binds first). The
    # rest stay as alternatives — `choose()` decides between them once live
    # values make the comparison meaningful.
    for kind in ("tp", "sl"):
        alts = result.tp_alts if kind == "tp" else result.sl_alts
        if not alts:
            continue
        alts.sort(key=lambda s: (_TIER_ORDER.get(s.tier, 9), _bind_order(s)))
        primary = alts.pop(0)
        if kind == "tp":
            result.tp = primary
        else:
            result.sl = primary

    result.fully_covered = total > 0 and convertible == total
    return result


def _bind_order(spec: TriggerSpec) -> float:
    """Sort key for "binds first" among same-tier specs. Only meaningful for
    static specs (a dynamic level can't be ranked without live values), so
    everything else sorts neutrally."""
    mult = spec.entry_mult
    if mult is None:
        return 0.0
    return mult if spec.direction == "up" else -mult
