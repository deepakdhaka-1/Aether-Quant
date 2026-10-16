"""Exit-rule -> venue bracket parser (aether.execution.exit_bracket): pure parsing, no doubles."""
from __future__ import annotations

import os
import sys


from aether.execution.exit_bracket import parse_exit_bracket  # noqa: E402

ID237_EXIT = "low <= entry_price * 0.92 or high >= entry_price * 1.05"


def test_id237_short_gives_tp_92_sl_105():
    r = parse_exit_bracket(ID237_EXIT, "short")
    assert r.fully_covered, r.skipped
    assert abs(r.tp_price_mult - 0.92) < 1e-9, r.tp_price_mult
    assert abs(r.sl_price_mult - 1.05) < 1e-9, r.sl_price_mult
    assert not r.skipped, r.skipped


def test_id237_long_flips_tp_and_sl():
    r = parse_exit_bracket(ID237_EXIT, "long")
    assert r.fully_covered, r.skipped
    # low<= is now the downside touch -> SL for a long; high>= -> TP for a long
    assert abs(r.sl_price_mult - 0.92) < 1e-9, r.sl_price_mult
    assert abs(r.tp_price_mult - 1.05) < 1e-9, r.tp_price_mult


def test_indicator_level_and_atr_offset_both_convert():
    """Both halves are real prices: bbands is a price-valued level (dynamic),
    and entry_price - 1.5*atr is an ATR-offset level (atr tier)."""
    expr = "close >= bbands_MiddleBand OR close <= entry_price - 1.5*atr_value"
    r = parse_exit_bracket(expr, "short")
    assert r.fully_covered, r.skipped
    assert r.sl.tier == "dynamic" and r.sl.indicator == "bbands_MiddleBand"
    assert r.tp.tier == "atr" and r.tp.indicator == "atr_value"
    # short: down = TP -> entry 100, atr 4 -> 100 - 6 = 94
    assert abs(r.tp.level(entry_price=100.0, indicator_value=4.0) - 94.0) < 1e-9
    assert abs(r.sl.level(entry_price=100.0, indicator_value=101.5) - 101.5) < 1e-9


def test_oscillator_thresholds_are_never_a_price_level():
    for expr in ("stoch_K > 75 or rsi_value > 60",
                 "willr_value < -80",
                 "macdext_macd < macdext_macdsignal",
                 "aroon_aroonup < aroon_aroondown OR cci_value < -50",
                 "kvo_value < 0",
                 "is_final_rth_bar == 1"):
        r = parse_exit_bracket(expr, "long")
        assert not r.specs("tp") and not r.specs("sl"), (expr, r)


def test_natr_is_not_mistaken_for_atr():
    """Prefix matching must be exact: natr is a PERCENTAGE, not a price."""
    r = parse_exit_bracket("low < entry_price - 2.0*natr_value", "long")
    assert not r.specs("sl"), r


def test_close_anchored_band_converts_with_close_confirm_semantics():
    """UNI (id166): a real TP/SL band anchored on close rather than high/low."""
    r = parse_exit_bracket("close <= (entry_price * 0.9) OR close >= (entry_price * 1.133)", "long")
    assert r.fully_covered, r.skipped
    assert r.sl.confirm == "close" and r.tp.confirm == "close"
    assert abs(r.sl.entry_mult - 0.9) < 1e-9
    assert abs(r.tp.entry_mult - 1.133) < 1e-9


def test_trailing_and_hard_stop_are_both_kept_as_alternatives():
    r = parse_exit_bracket("close < ema_value OR low < entry_price*0.92", "long")
    assert r.fully_covered, r.skipped
    assert len(r.specs("sl")) == 2, r.specs("sl")
    # static is primary (always resolvable); the trailing one stays available
    assert r.sl.tier == "static"
    assert {s.tier for s in r.specs("sl")} == {"static", "dynamic"}
    # with dynamic allowed, the EMA at 99 binds before the 92 floor
    spec, level = r.choose("sl", entry_price=100.0, indicator_values={"ema_value": 99.0},
                           allowed_tiers=("static", "atr", "dynamic"))
    assert abs(level - 99.0) < 1e-9 and spec.tier == "dynamic"
    # with only static allowed, the hard floor is what rests
    spec, level = r.choose("sl", entry_price=100.0, allowed_tiers=("static",))
    assert abs(level - 92.0) < 1e-9


def test_intrabar_range_clause_is_classified_dynamic():
    """`high > close*1.03` is relative to the bar's own close, not a fixed
    level — parsed, but tiered so a caller can refuse it."""
    r = parse_exit_bracket("high > close * 1.03", "short")
    assert r.sl is not None and r.sl.tier == "dynamic"
    assert abs(r.sl.level(entry_price=100.0, close=200.0) - 206.0) < 1e-9


def test_bare_false_is_a_clean_noop_not_an_error():
    for expr in ("False", "false", "FALSE"):
        r = parse_exit_bracket(expr, "long")
        assert not r.specs("tp") and not r.specs("sl")
        assert not r.skipped, r.skipped


def test_backwards_direction_is_not_convertible():
    r = parse_exit_bracket("low >= entry_price*1.05", "short")
    assert r.tp_price_mult is None and r.sl_price_mult is None
    assert r.skipped


def test_close_field_converts_but_is_flagged_close_confirmed():
    r = parse_exit_bracket("close <= entry_price*0.92", "short")
    assert r.tp is not None and r.tp.confirm == "close"      # short: down = TP
    assert abs(r.tp.entry_mult - 0.92) < 1e-9


def test_close_on_both_sides_is_not_a_level():
    """`close >= close*1.01` compares the bar to itself — not a reference."""
    r = parse_exit_bracket("close >= close * 1.01", "long")
    assert not r.specs("tp") and not r.specs("sl")


def test_top_level_and_clause_is_rejected():
    r = parse_exit_bracket("high >= entry_price*1.05 and low <= entry_price*0.9", "short")
    assert r.tp_price_mult is None and r.sl_price_mult is None
    assert not r.fully_covered
    assert r.skipped


def test_and_clause_nested_inside_or_is_rejected():
    expr = "high >= entry_price*1.05 or (close > bbands_MiddleBand and low <= entry_price*0.9)"
    r = parse_exit_bracket(expr, "short")
    # the pure high>= branch still converts...
    assert abs(r.sl_price_mult - 1.05) < 1e-9
    # ...but the AND-clause branch does not, so coverage is partial
    assert not r.fully_covered
    assert r.skipped


def test_additive_constant_offset_is_a_valid_level():
    """A fixed offset from entry is still a static level; the affine model
    handles it even though no registered strategy uses one today."""
    r = parse_exit_bracket("high >= entry_price + 500", "short")
    assert r.sl is not None and r.sl.tier == "static"
    assert abs(r.sl.level(entry_price=1000.0) - 1500.0) < 1e-9
    assert r.sl.entry_mult is None          # not expressible as a plain multiplier


def test_nonlinear_level_is_rejected():
    r = parse_exit_bracket("high >= entry_price * entry_price", "short")
    assert not r.specs("sl") and not r.specs("tp")


def test_case_insensitive_and_or():
    r = parse_exit_bracket("low <= entry_price * 0.92 OR high >= entry_price * 1.05", "short")
    assert r.fully_covered
    r2 = parse_exit_bracket("low <= entry_price * 0.92 or high >= entry_price * 1.05", "short")
    assert r.tp_price_mult == r2.tp_price_mult and r.sl_price_mult == r2.sl_price_mult


def test_empty_or_none_logic_is_a_clean_noop():
    for expr in (None, "", "   "):
        r = parse_exit_bracket(expr, "short")
        assert r.tp_price_mult is None and r.sl_price_mult is None
        assert not r.fully_covered
        assert not r.skipped


def test_unparseable_expression_degrades_gracefully():
    r = parse_exit_bracket("this is not )( valid python at all ***", "short")
    assert r.tp_price_mult is None and r.sl_price_mult is None
    assert r.skipped


# ── whole-corpus guard ──────────────────────────────────────────────────────
# data/exit_logic_corpus.json is every DISTINCT exit-rule string of a 310-side
# production strategy corpus (165 strings), so a
# parser change that silently stops covering a real registered strategy — or
# starts converting an oscillator into a price level — fails here.
def _corpus():
    import json
    path = os.path.join(os.path.dirname(os.path.abspath(__file__)),
                        "data", "exit_logic_corpus.json")
    with open(path, encoding="utf-8") as fh:
        return json.load(fh)


def test_corpus_parses_without_raising():
    for item in _corpus():
        parse_exit_bracket(item["expr"], item["side"])   # must never raise


def test_corpus_coverage_does_not_regress():
    covered = sum(item["n"] for item in _corpus()
                  if parse_exit_bracket(item["expr"], item["side"]).specs("sl"))
    total = sum(item["n"] for item in _corpus())
    # 290/310 strategy-sides get a venue-placeable stop level once every tier
    # is allowed; the rest declare no price stop at all (oscillator-only exits
    # and `False`). Guard the floor, not the exact number.
    assert covered >= 285, f"stop coverage regressed: {covered}/{total}"


def test_corpus_never_converts_an_oscillator():
    """Every spec produced must reference only entry_price, close, or a
    price-valued / ATR indicator — never an oscillator column."""
    from aether.execution.exit_bracket import indicator_class
    for item in _corpus():
        r = parse_exit_bracket(item["expr"], item["side"])
        for spec in r.specs("tp") + r.specs("sl"):
            if spec.indicator:
                assert indicator_class(spec.indicator) in ("price", "atr"), \
                    f"{item['expr']} -> {spec.indicator}"


if __name__ == "__main__":
    failed = 0
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn):
            try:
                fn()
                print(f"PASS {name}")
            except AssertionError as e:
                failed += 1
                print(f"FAIL {name}: {e}")
    print("\nall green" if not failed else f"\n{failed} FAILED")
    sys.exit(1 if failed else 0)
