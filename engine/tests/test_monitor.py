"""Monitor tests: fake data only, no network, no Supabase."""
import os
import sys
from datetime import datetime, timedelta, timezone

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from aether import monitor as m  # noqa: E402

NOW = datetime(2026, 10, 15, 12, 0, tzinfo=timezone.utc)


def ago(**kw):
    return (NOW - timedelta(**kw)).isoformat()


def healthy():
    return {
        "errors": [],
        "heartbeats": [{"id": "executor", "last_run": ago(seconds=50), "detail": {"accounts": 1, "errors": 0}},
                       {"id": "signals", "last_run": ago(minutes=4), "detail": {}}],
        "system_state": {"id": "global", "halted": False},
        "strategies": [{"id": "s1", "slug": "nvda-trend", "symbol": "NVDA", "timeframe": "1h",
                        "status": "published", "markets": {"hl_coin": "xyz:NVDA"}}],
        "latest_signals": {"s1": {"strategy_id": "s1", "bar_time": ago(hours=1), "desired": "long",
                                  "created_at": ago(minutes=59)}},
        "accounts": [{"id": "a1aaaaaaaa", "user_id": "u1", "network": "mainnet", "wallet_address": "0xabc",
                      "status": "active", "kill_switch": False, "last_error": None}],
        "orders_1h": [{"broker_account_id": "a1aaaaaaaa", "symbol": "xyz:NVDA", "status": "filled"}],
        "snapshots": {"a1aaaaaaaa": [{"equity": 1000, "created_at": ago(hours=30)},
                                     {"equity": 1000, "created_at": ago(hours=20)},
                                     {"equity": 995, "created_at": ago(minutes=1)}]},
        "user_risk": {"u1": {"max_daily_loss_pct": 5, "max_drawdown_pct": 20, "trading_enabled": True}},
        "subscriptions": [{"id": "sub1", "broker_account_id": "a1aaaaaaaa", "strategy_id": "s1",
                           "strategies": {"id": "s1", "slug": "nvda-trend", "symbol": "NVDA", "status": "published",
                                          "timeframe": "1h", "markets": {"hl_coin": "xyz:NVDA"}}}],
        "positions": [{"broker_account_id": "a1aaaaaaaa", "symbol": "xyz:NVDA", "side": "long", "qty": 1}],
        "fees_24h": [{"fee_usd": 1.25}, {"fee_usd": 0.75}],
    }


def alerts(f):
    return [x for x in f if x["severity"] in ("crit", "warn")]


def keys(f):
    return {x["key"] for x in f}


def test_healthy_has_no_alerts_and_reports_revenue():
    f = m.evaluate(healthy(), NOW)
    assert alerts(f) == []
    rev = next(x for x in f if x["key"] == "revenue:24h")
    assert rev["fee_usd_24h"] == 2.0 and rev["severity"] == "info"


def test_stale_heartbeats():
    d = healthy()
    d["heartbeats"][0]["last_run"] = ago(minutes=6)
    d["heartbeats"][1]["last_run"] = ago(minutes=21)
    f = m.evaluate(d, NOW)
    assert {"heartbeat:executor", "heartbeat:signals"} <= keys(f)
    d["heartbeats"] = []
    assert {"heartbeat:executor", "heartbeat:signals"} <= keys(m.evaluate(d, NOW))


def test_signal_stale_after_two_bars():
    d = healthy()
    d["latest_signals"]["s1"]["bar_time"] = ago(hours=2, minutes=1)
    assert "signal_stale:s1" in keys(m.evaluate(d, NOW))
    del d["latest_signals"]["s1"]
    assert "signal_stale:s1" in keys(m.evaluate(d, NOW))


def test_account_errors():
    d = healthy()
    d["accounts"][0]["last_error"] = "insufficient margin"
    f = m.evaluate(d, NOW)
    assert any(k.startswith("acct_error:a1aaaaaaaa") for k in keys(f))
    d["accounts"][0]["status"] = "error"
    f = m.evaluate(d, NOW)
    assert "acct_status:a1aaaaaaaa" in keys(f)


def test_rejection_rate_and_partials():
    d = healthy()
    d["orders_1h"] = ([{"broker_account_id": "a1aaaaaaaa", "symbol": "xyz:NVDA", "status": "rejected", "error": "x"}] * 3
                      + [{"broker_account_id": "a1aaaaaaaa", "symbol": "xyz:NVDA", "status": "partial"}]
                      + [{"broker_account_id": "b2", "symbol": "xyz:GOLD", "status": "filled"}] * 2)
    f = m.evaluate(d, NOW)
    k = keys(f)
    assert "reject_rate:a1aaaaaaaa" in k
    assert "reject_rate:global" in k          # 3/6 = 50 %
    assert "partial:a1aaaaaaaa:xyz:NVDA" in k


def test_drawdown_warn_and_crit():
    d = healthy()
    d["snapshots"]["a1aaaaaaaa"][-1]["equity"] = 955     # 4.5 % daily -> warn (80 % of 5)
    k = keys(m.evaluate(d, NOW))
    assert "daily_loss:a1aaaaaaaa:warn" in k
    d["snapshots"]["a1aaaaaaaa"][-1]["equity"] = 790     # 21 % from peak -> crit both
    k = keys(m.evaluate(d, NOW))
    assert {"daily_loss:a1aaaaaaaa:crit", "drawdown:a1aaaaaaaa:crit"} <= k


def test_divergence_needs_two_passes():
    d = healthy()
    d["positions"] = []                                   # signal long, actual flat
    d["latest_signals"]["s1"]["created_at"] = ago(seconds=90)
    assert not any(x.startswith("divergence") for x in keys(m.evaluate(d, NOW)))
    d["latest_signals"]["s1"]["created_at"] = ago(minutes=5)
    f = m.evaluate(d, NOW)
    div = [x for x in f if x["check"] == "divergence"]
    assert len(div) == 1 and div[0]["severity"] == "warn"
    # Should be flat but is long -> crit (a missed close)
    d["latest_signals"]["s1"]["desired"] = "flat"
    d["positions"] = [{"broker_account_id": "a1aaaaaaaa", "symbol": "xyz:NVDA", "side": "long", "qty": 1}]
    div = [x for x in m.evaluate(d, NOW) if x["check"] == "divergence"]
    assert div[0]["severity"] == "crit"
    # Halted or kill-switched -> not a divergence
    d["accounts"][0]["kill_switch"] = True
    assert not [x for x in m.evaluate(d, NOW) if x["check"] == "divergence"]


def test_halt():
    d = healthy()
    d["system_state"] = {"halted": True, "note": "maintenance"}
    assert "system:halted" in keys(m.evaluate(d, NOW))


def test_load_errors_and_crashing_check_become_findings():
    d = healthy()
    d["errors"] = ["orders_1h: boom"]
    d["accounts"] = [{"id": "x"}]                         # malformed row -> checks must not crash run
    f = m.evaluate(d, NOW)
    assert "monitor_load:orders_1h" in keys(f)


def test_dedupe_cooldown_and_resolve():
    f = [{"key": "a", "severity": "crit", "message": "A"}, {"key": "b", "severity": "warn", "message": "B"},
         {"key": "r", "severity": "info", "message": "rev"}]
    send, res, state = m.plan_alerts(f, {}, NOW)
    assert [x["key"] for x in send] == ["a", "b"] and res == []
    prev = {"a": ago(minutes=10), "b": ago(minutes=31), "gone": ago(minutes=5)}
    send, res, state = m.plan_alerts(f, prev, NOW)
    assert [x["key"] for x in send] == ["b"]
    assert res == ["gone"]
    assert set(state) == {"a", "b"}


class FakeQuery:
    def __init__(self, db, table):
        self.db, self.table = db, table

    def __getattr__(self, name):                          # select/eq/gte/in_/order/limit -> chain
        return lambda *a, **k: self

    def upsert(self, row, **k):
        self.db.setdefault("_upserts", []).append((self.table, row))
        return self

    def execute(self):
        class R:
            pass
        r = R()
        r.data = self.db.get(self.table, [])
        return r


class FakeSB:
    def __init__(self, db):
        self.db = db

    def table(self, name):
        return FakeQuery(self.db, name)


def test_run_once_dedupes_across_runs():
    db = {"heartbeats": [], "system_state": [{"id": "global", "halted": False}]}
    sent = []
    sender = lambda text, f: sent.append(text) or True   # noqa: E731
    m.run_once(FakeSB(db), NOW, sender)
    assert len(sent) == 1 and "executor heartbeat stale" in sent[0]
    table, row = db["_upserts"][-1]
    assert table == "heartbeats" and row["id"] == "monitor"
    # Second run 5 min later with the stored state: nothing new to send.
    db["heartbeats"] = [row]
    m.run_once(FakeSB(db), NOW + timedelta(minutes=5), sender)
    assert len(sent) == 1
    # After the cooldown it re-alerts.
    db["heartbeats"] = [db["_upserts"][-1][1]]
    m.run_once(FakeSB(db), NOW + timedelta(minutes=31), sender)
    assert len(sent) == 2


def test_failed_delivery_retries_next_run():
    db = {"heartbeats": [], "system_state": [{"id": "global", "halted": True}]}
    m.run_once(FakeSB(db), NOW, lambda t, f: False)
    row = db["_upserts"][-1][1]
    assert row["detail"]["alerted"] == {}
