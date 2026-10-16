"""Entry market gate: spread / depth / staleness / basis / chase."""
import time
from datetime import datetime, timedelta, timezone

from aether.execution.market_gate import (Quote, book_depth_usd, check_entry, quote_from_l2,
                                          spread_limit_bp)

NOW = time.time()


def _q(bid, ask, ts=None, **kw):
    return Quote(bid=bid, ask=ask, ts=NOW if ts is None else ts, **kw)


def test_limits_by_class():
    assert spread_limit_bp("equity") == 10 and spread_limit_bp("commodity") == 10
    assert spread_limit_bp("crypto") == 15


def test_clean_market_passes():
    assert check_entry("equity", True, 800.0, _q(180.00, 180.01), now=NOW) is None


def test_no_quote_blocks():
    assert "no order book" in check_entry("equity", True, 800.0, None, now=NOW)


def test_stale_quote_blocks():
    assert "old" in check_entry("equity", True, 800.0, _q(180.0, 180.01, ts=NOW - 9), now=NOW)


def test_wide_spread_blocks():
    r = check_entry("commodity", True, 300.0, _q(0.3758, 0.3771), now=NOW)   # 33 bp
    assert r and "spread" in r


def test_thin_book_blocks_on_the_side_we_take():
    q = _q(100.0, 100.01, ask_depth_usd=5_000.0, bid_depth_usd=1e9)
    assert "ask" in check_entry("equity", True, 800.0, q, now=NOW)       # buy needs $8k on the ask
    assert check_entry("equity", False, 800.0, q, now=NOW) is None       # a sell takes the bid


def test_basis_blocks():
    q = _q(100.0, 100.01, mark=100.0, index=99.5)                         # 50 bp apart
    assert "mark/index" in check_entry("equity", True, 500.0, q, now=NOW)


def test_chase_blocks_fresh_signal_only():
    fresh = (datetime.now(timezone.utc) - timedelta(minutes=10)).isoformat()
    old = (datetime.now(timezone.utc) - timedelta(hours=3)).isoformat()
    q = _q(101.5, 101.51)                                                  # 1.5% above a 100 signal
    r = check_entry("equity", True, 500.0, q, now=NOW, signal_price=100.0, signal_time=fresh, stop_pct=2.0)
    assert r and "past the signal price" in r
    assert check_entry("equity", True, 500.0, q, now=NOW, signal_price=100.0, signal_time=old, stop_pct=2.0) is None
    assert check_entry("equity", False, 500.0, q, now=NOW, signal_price=100.0, signal_time=fresh, stop_pct=2.0) is None
    q2 = _q(100.8, 100.81)
    assert check_entry("equity", True, 500.0, q2, now=NOW, signal_price=100.0, signal_time=fresh, stop_pct=2.0) is None


def test_book_depth_counts_only_inside_the_band():
    bids = [(99.95, 10), (99.9, 10), (99.8, 100)]
    asks = [(100.05, 10), (100.1, 10), (100.3, 100)]
    assert abs(book_depth_usd(bids, 100.0, 10, "bid") - (999.5 + 999.0)) < 1e-6
    assert abs(book_depth_usd(asks, 100.0, 10, "ask") - (1000.5 + 1001.0)) < 1e-6


def test_quote_from_hyperliquid_l2():
    book = {"time": int(NOW * 1000), "levels": [[{"px": "99.99", "sz": "50"}], [{"px": "100.01", "sz": "40"}]]}
    q = quote_from_l2(book)
    assert q.bid == 99.99 and q.ask == 100.01 and abs(q.ask_depth_usd - 4000.4) < 1e-6
