"""Strategy rule language: safe, vectorised evaluation.

    rsi_value < 30 and close > ema_value
    macdext_MACD crosses above macdext_MACDSignal
    (adx_value > 25) AND NOT (chop_value > 61.8)
    rsi_value > rsi_value_prev and close_prev2 < bbands_LowerBand_prev2
    close <= entry_price * 0.98                      (exit rules only)

`<col>_prevN` is the column N bars back (`_prev` == `_prev1`). Allowed after normalisation:
and/or/not, comparisons, + - * /, unary minus, numbers, column names, abs/min/max, and the
position variable `entry_price` (alias `entry`). Anything else (attribute access, subscripts,
lambdas, other calls, strings) is rejected at compile time. Rules are never eval()'d: they are
parsed to an AST, checked against a whitelist and interpreted -- a hard requirement for a
multi-user service.

Authoring dialect accepted (normalise_dialect), so strategies written in the research notation
compile unchanged:
  * labels ("Entry Long:", "Exit:", "LONG:", ...), // and /* */ comments, const/let/var;
  * JS wrappers: `if (cond) { return true }`, `{ return cond; }`;
  * `historical[n].x` -> x_prevn, `current.x` -> x, `x.diff() > 0` -> (x > x_prev);
  * `a | b | c` alternatives -> the first part that is an actual condition;
  * AND/OR/NOT, &&/||, `crosses above/below`, stray %, trailing punctuation, unbalanced parens;
  * with side='long'/'short': bare TP/SL fragments ("TP: 2%") are dropped and threshold-only
    terms ("entry_price * 0.98") become (price_value <= ...)/(price_value >= ...).
Column names resolve case-insensitively (macdext_macd -> macdext_MACD).
"""
from __future__ import annotations

import ast
import operator
import re
from dataclasses import dataclass, field

import numpy as np
import pandas as pd

_CROSS = re.compile(r"([A-Za-z_]\w*)\s+crosses\s+(above|below)\s+([A-Za-z_]\w*|-?\d+(?:\.\d+)?)",
                    re.IGNORECASE)
_PREV = re.compile(r"^(?P<base>[A-Za-z_]\w*?)_prev(?P<n>\d*)$")

_CMP = {ast.Gt: operator.gt, ast.GtE: operator.ge, ast.Lt: operator.lt, ast.LtE: operator.le,
        ast.Eq: operator.eq, ast.NotEq: operator.ne}
_BIN = {ast.Add: operator.add, ast.Sub: operator.sub, ast.Mult: operator.mul, ast.Div: operator.truediv}
_FUNCS = {"abs": np.abs, "min": np.minimum, "max": np.maximum}
_ARITY = {"abs": 1, "min": 2, "max": 2}
MAX_RULE_LEN = 2000
# Position-state variables: bound per trade at evaluation time, not columns.
POSITION_VARS = {"entry_price": "entry_price", "entry": "entry_price"}
# Price aliases used by the research dialect.
COLUMN_ALIASES = {"price": "close"}

_LABELS = ["Entry Logic:", "Exit Logic:", "Entry Short:", "Entry Long:", "Exit Short:", "Exit Long:",
           "Short Entry:", "Long Entry:", "Short Exit:", "Long Exit:", "Stop Loss:", "Take Profit:",
           "Logic:", "LONG:", "SHORT:", "TP:", "SL:", "Exit:"]


class RuleError(ValueError):
    pass


# ---------------------------------------------------------------------------
# Dialect normalisation (text -> canonical rule text). Output still goes through the AST whitelist.
# ---------------------------------------------------------------------------
def clean_alternatives(text: str) -> str:
    """'a | b' alternatives: keep the first part that is an actual condition."""
    if not text or "|" not in text or "||" in text:
        return text or ""
    parts = [p.strip() for p in text.split("|")]
    for p in parts:
        if re.search(r"[<>=]|prev|diff|crosses|between", p, re.IGNORECASE):
            return p
    return parts[0] if parts else ""


def _balanced_paren_content(s: str):
    start = s.find("(")
    if start == -1:
        return None
    depth = 0
    for i in range(start, len(s)):
        if s[i] == "(":
            depth += 1
        elif s[i] == ")":
            depth -= 1
            if depth == 0:
                return s[start + 1:i], i + 1
    return None


def normalise_dialect(src: str, side: str = "") -> str:
    """Research-notation rule -> canonical rule text (see module docstring)."""
    logic = clean_alternatives((src or "").strip())
    logic = re.sub(r"/\*[\s\S]*?\*/", "", logic)
    # `// note` is a comment only when what follows reads as prose: no operators, not a number.
    # Otherwise "a // 2 > 1" (floor division, rejected) would silently become the rule "a".
    logic = re.sub(r"//(?![^\n]*[<>=+\-*/()])(?!\s*[\d.])[^\n]*", "", logic)
    lines = []
    for line in logic.split("\n"):
        ln = re.sub(r"^(const|let|var)\s+\w+\s*=\s*", "", line.strip())
        for label in _LABELS:
            if ln.lower().startswith(label.lower()):
                ln = ln[len(label):].strip()
        if ln:
            lines.append(ln)
    logic = " ".join(lines).strip()

    if re.match(r"^\s*if\b", logic, re.IGNORECASE):
        bal = _balanced_paren_content(logic)
        if bal:
            content, end = bal
            rest = logic[end:].strip()
            logic = (content.strip() if rest.startswith("{") or re.search(r"\breturn\b", rest, re.I)
                     else re.sub(r"^\s*if\b", "", logic, flags=re.I).strip())
        else:
            logic = re.sub(r"^\s*if\b", "", logic, flags=re.I).strip()
    elif "{" in logic and "}" in logic:
        body = re.search(r"\{([\s\S]*)\}", logic)
        if body:
            content = body.group(1).strip()
            ret = re.search(r"return\s+([\s\S]*?);?\s*$", content, re.IGNORECASE)
            logic = ret.group(1) if ret else content

    logic = re.sub(r"historical\[(\d+)\]\.(\w+)", r"\2_prev\1", logic)
    logic = re.sub(r"\bcurrent\.(\w+)", r"\1", logic)
    logic = re.sub(r"(\w+)\.diff\(\)\s*>\s*0", r"(\1 > \1_prev)", logic, flags=re.IGNORECASE)
    logic = re.sub(r"(\w+)\.diff\(\)\s*<\s*0", r"(\1 < \1_prev)", logic, flags=re.IGNORECASE)

    if side in ("long", "short"):
        parts = re.split(r"\b(OR|AND|or|and)\b", logic)
        rebuilt = []
        for p in parts:
            t = p.strip()
            if re.fullmatch(r"OR|AND|or|and", t):
                rebuilt.append(t)
                continue
            bare = re.sub(r"^(tp|sl|stop loss|take profit|exit):?\s*", "", t, flags=re.IGNORECASE).lower()
            if re.fullmatch(r"(\d+(\.\d+)?%?|fixed\s*\d+(\.\d+)?%?)", bare):
                continue                                       # "TP: 2%" -> handled by extract_tp_sl
            if (re.match(r"^(tp|sl|stop loss|take profit)\b:?", t, re.IGNORECASE)
                    and not re.search(r"[<>=]", t)):
                continue                                       # "SL 2 * atr_value" -> extract_tp_sl
            if "entry_price" in t.lower() and not re.search(r"[<>=]", t):
                # Direction from the multiplier: above entry is a long TP / short SL (price must
                # rise to it), below entry a long SL / short TP. Default: a stop.
                k = re.search(r"entry_price\s*\*\s*([\d.]+)", t, re.IGNORECASE)
                f = float(k.group(1)) if k else None
                if f is not None and f != 1.0:
                    cmp = ">=" if f > 1 else "<="
                else:
                    cmp = "<=" if side == "long" else ">="
                rebuilt.append(f"(price_value {cmp} {re.sub(r'[)]+$', '', t)})")
            else:
                rebuilt.append(p)
        # drop connectives left dangling by removed fragments
        out: list[str] = []
        for tok in [x for x in rebuilt if x.strip()]:
            if re.fullmatch(r"\s*(OR|AND|or|and)\s*", tok) and (not out or re.fullmatch(r"\s*(OR|AND|or|and)\s*", out[-1])):
                continue
            out.append(tok)
        while out and re.fullmatch(r"\s*(OR|AND|or|and)\s*", out[-1]):
            out.pop()
        logic = " ".join(out)

    logic = re.sub(r"\b(const|let|var)\b", "", logic)
    logic = logic.replace("%", "")
    logic = re.sub(r"[.`*;]+$", "", logic).strip()
    opens, closes = logic.count("("), logic.count(")")
    while closes > opens:
        logic = re.sub(r"\)(?=[^)]*$)", "", logic)
        closes -= 1
    logic += ")" * max(0, opens - closes)
    return logic


def extract_tp_sl(text: str) -> dict:
    """TP/SL/time-limit parameters written as text, e.g. 'SL 1.5 * atr_value, TP: 3%, 48h'.
    Percentages are returned in percent (3.0 for 3%), matching stop_loss_pct/take_profit_pct."""
    res = {"tp_atr_mult": None, "sl_atr_mult": None, "tp_pct": None, "sl_pct": None,
           "atr_col": "atr_value", "time_limit_hours": None}
    if not text:
        return res
    m = re.search(r"(?:\bsl\b|stop loss).*?([\d.]+)\s*\*\s*(atr\w*)", text, re.IGNORECASE)
    if m:
        res["sl_atr_mult"], res["atr_col"] = float(m.group(1)), m.group(2)
    m = re.search(r"(?:\btp\b|take profit).*?([\d.]+)\s*\*\s*(atr\w*)", text, re.IGNORECASE)
    if m:
        res["tp_atr_mult"], res["atr_col"] = float(m.group(1)), m.group(2)
    m = re.search(r"(?:\btp\b|take profit)[^%*]*?([\d.]+)\s*%", text, re.IGNORECASE)
    if m:
        res["tp_pct"] = float(m.group(1))
    m = re.search(r"(?:\bsl\b|stop loss)[^%*]*?([\d.]+)\s*%", text, re.IGNORECASE)
    if m:
        res["sl_pct"] = float(m.group(1))
    m = re.search(r"(\d+)\s*(?:h\b|hours?\b)", text, re.IGNORECASE)
    if m:
        res["time_limit_hours"] = int(m.group(1))
    return res


def normalise(src: str, side: str = "") -> str:
    s = normalise_dialect(src, side)
    s = re.sub(r"\bAND\b", "and", s, flags=re.IGNORECASE)
    s = re.sub(r"\bOR\b", "or", s, flags=re.IGNORECASE)
    s = re.sub(r"\bNOT\b", "not", s, flags=re.IGNORECASE)
    s = s.replace("&&", " and ").replace("||", " or ")

    def cross(m: re.Match) -> str:
        a, direction, b = m.group(1), m.group(2).lower(), m.group(3)
        b_prev = f"{b}_prev" if re.match(r"^[A-Za-z_]", b) else b
        if direction == "above":
            return f"({a} > {b} and {a}_prev <= {b_prev})"
        return f"({a} < {b} and {a}_prev >= {b_prev})"

    return _CROSS.sub(cross, s)


# ---------------------------------------------------------------------------
# Compile + evaluate
# ---------------------------------------------------------------------------
@dataclass
class Rule:
    source: str
    tree: ast.Expression
    columns: set[str]
    position_vars: set[str] = field(default_factory=set)

    @property
    def uses_entry_price(self) -> bool:
        return "entry_price" in self.position_vars

    def evaluate(self, df: pd.DataFrame, env: dict | None = None) -> pd.Series:
        res = _eval(self.tree.body, df, _resolver(df), env or {})
        if np.isscalar(res):
            res = pd.Series(bool(res), index=df.index)
        return pd.Series(res, index=df.index).fillna(False).astype(bool)


def _resolver(df: pd.DataFrame) -> dict[str, str]:
    return {str(c).lower(): c for c in df.columns}


def _base_name(name: str) -> str:
    m = _PREV.match(name)
    return m.group("base") if m else name


def compile_rule(src: str | None, allowed_columns: set[str] | None = None, side: str = "") -> Rule | None:
    if not src or not src.strip():
        return None
    if len(src) > MAX_RULE_LEN:
        raise RuleError(f"rule longer than {MAX_RULE_LEN} characters")
    text = normalise(src, side)
    if not text:
        return None
    try:
        tree = ast.parse(text, mode="eval")
    except SyntaxError as e:
        raise RuleError(f"cannot parse rule {src!r}: {e.msg}") from e
    cols: set[str] = set()
    pvars: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, (ast.Expression, ast.BoolOp, ast.And, ast.Or, ast.Compare, ast.BinOp,
                             ast.UnaryOp, ast.Not, ast.USub, ast.Load, ast.Constant)):
            # Numbers only: a string constant enables memory DoS ("x" * 10**9) and is never needed.
            if isinstance(node, ast.Constant) and (isinstance(node.value, bool)
                                                   or not isinstance(node.value, (int, float))):
                raise RuleError(f"constant {node.value!r} not allowed")
            continue
        if type(node) in _CMP or type(node) in _BIN:
            continue
        if isinstance(node, ast.Call):
            if not (isinstance(node.func, ast.Name) and node.func.id in _FUNCS) or node.keywords:
                raise RuleError("only abs(), min(), max() calls are allowed")
            # numpy ufuncs take a positional `out=`: max(a, b, c) would WRITE into column c.
            if len(node.args) != _ARITY[node.func.id]:
                raise RuleError(f"{node.func.id}() takes {_ARITY[node.func.id]} argument(s)")
            continue
        if isinstance(node, ast.Name):
            if node.id in _FUNCS:
                continue
            if node.id.lower() in POSITION_VARS:
                pvars.add(POSITION_VARS[node.id.lower()])
                continue
            cols.add(_base_name(node.id))
            continue
        raise RuleError(f"'{type(node).__name__}' is not allowed in a rule")
    if not cols and not pvars:
        # e.g. "TP: 2%" normalised to "2": a constant rule would fire on every bar.
        raise RuleError(f"rule {src!r} references no indicator or price column")
    if allowed_columns is not None:
        lower = {c.lower() for c in allowed_columns}
        unknown = sorted(c for c in cols
                         if c.lower() not in lower and COLUMN_ALIASES.get(c.lower(), "") not in lower)
        if unknown:
            raise RuleError(f"unknown indicator column(s): {', '.join(unknown)}")
    return Rule(src, tree, cols, pvars)


def _col(df: pd.DataFrame, name: str, res: dict[str, str] | None = None):
    res = res if res is not None else _resolver(df)
    real = name if name in df.columns else res.get(name.lower()) or res.get(COLUMN_ALIASES.get(name.lower(), ""))
    if real is not None:
        s = df[real]
        return s.astype(float) if pd.api.types.is_numeric_dtype(s) else s
    m = _PREV.match(name)
    if m:
        n = int(m.group("n") or 1)
        return _col(df, m.group("base"), res).shift(n)
    raise RuleError(f"column '{name}' not in data")


def _eval(node, df, res, env):
    if isinstance(node, ast.BoolOp):
        vals = [_as_bool(_eval(v, df, res, env)) for v in node.values]
        acc = vals[0]
        for v in vals[1:]:
            acc = (acc & v) if isinstance(node.op, ast.And) else (acc | v)
        return acc
    if isinstance(node, ast.UnaryOp):
        v = _eval(node.operand, df, res, env)
        return ~_as_bool(v) if isinstance(node.op, ast.Not) else -v
    if isinstance(node, ast.Compare):
        left, acc = _eval(node.left, df, res, env), None
        for op, comp in zip(node.ops, node.comparators):
            right = _eval(comp, df, res, env)
            r = _CMP[type(op)](left, right)
            acc = r if acc is None else (acc & r)
            left = right
        return acc
    if isinstance(node, ast.BinOp):
        return _BIN[type(node.op)](_eval(node.left, df, res, env), _eval(node.right, df, res, env))
    if isinstance(node, ast.Call):
        return _FUNCS[node.func.id](*[_eval(a, df, res, env) for a in node.args])
    if isinstance(node, ast.Name):
        if node.id.lower() in POSITION_VARS:
            v = env.get(POSITION_VARS[node.id.lower()])
            return np.nan if v is None else float(v)     # no position -> comparisons are False
        return _col(df, node.id, res)
    if isinstance(node, ast.Constant):
        return node.value
    raise RuleError(f"unsupported node {type(node).__name__}")


def _as_bool(v):
    if isinstance(v, pd.Series):
        return v.fillna(False).astype(bool)
    return bool(v)
