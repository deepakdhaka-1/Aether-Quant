"""Monitor: watchdog over the signal runner, the executor and every live account.

Run every 5 minutes (`python engine/scripts/monitor_run.py` or `python -m aether.monitor`).

Design
------
* `load(sb, now)` reads everything from Supabase with the service-role client (read-only except
  for the heartbeat upsert at the end).
* `evaluate(data, now)` is a PURE function: data in, list of findings out. Unit tests drive it
  with fake rows; no network.
* Findings are written to heartbeats id 'monitor' (detail.findings) so the admin ops page can show
  them, and alerts go to Telegram / a generic webhook, de-duplicated: a finding with the same
  `key` is not re-sent for ALERT_COOLDOWN_S (30 min). The cooldown state lives in
  heartbeats['monitor'].detail.alerted = {key: iso_time_last_sent}. When a previously alerted
  finding disappears, one "RESOLVED" line is sent.
* Severity: 'crit' and 'warn' alert; 'info' is shown on the dashboard only (e.g. revenue).
* The monitor never trades and never writes to trading tables. It must never crash silently:
  a failing check becomes a 'monitor_check_failed' finding.

Env (all optional, see root .env):
  TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_IDS (comma list), MONITOR_WEBHOOK_URL, MONITOR_PING_URL,
  MONITOR_ALERT_COOLDOWN_S (default 1800), MONITOR_ENV_LABEL (prefix on alerts, e.g. "prod").
"""
from __future__ import annotations

import hashlib
import logging
import os
from datetime import datetime, timedelta, timezone
from typing import Any, Callable

log = logging.getLogger("aether.monitor")

HEARTBEAT_ID = "monitor"
TF_SECONDS = {"15m": 900, "1h": 3600, "4h": 14400, "1d": 86400}

# Thresholds (seconds / ratios). Kept as module constants so tests and the runbook agree.
EXECUTOR_STALE_S = 5 * 60
SIGNALS_STALE_S = 20 * 60
FEES_STALE_S = 3 * 3600            # only checked if a 'fees' heartbeat exists
SIGNAL_STALE_BARS = 2              # same as executor SIGNAL_MAX_AGE: past this, no new entries
REJECT_MIN_ORDERS_ACCT = 3
REJECT_RATE_ACCT = 0.5
REJECT_MIN_ORDERS_GLOBAL = 5
REJECT_RATE_GLOBAL = 0.2
RISK_WARN_FRACTION = 0.8           # warn at 80 % of a user's limit, crit at 100 %
DIVERGENCE_PASSES = 2              # executor passes (1 min each) a mismatch may persist
EXECUTOR_PERIOD_S = 60
ALERT_COOLDOWN_S = int(os.getenv("MONITOR_ALERT_COOLDOWN_S", "1800"))

SEV_ORDER = {"crit": 0, "warn": 1, "info": 2}


# ----------------------------------------------------------------------------- helpers
def _now() -> datetime:
    return datetime.now(timezone.utc)


def _ts(v: Any) -> datetime | None:
    if v is None or v == "":
        return None
    if isinstance(v, datetime):
        return v if v.tzinfo else v.replace(tzinfo=timezone.utc)
    s = str(v).replace("Z", "+00:00")
    try:
        d = datetime.fromisoformat(s)
    except ValueError:
        # Postgres may return 5-digit fractional seconds which older Pythons reject.
        head, _, tail = s.partition(".")
        frac, sign, tz = tail, "", ""
        for c in "+-":
            if c in tail:
                frac, tz = tail.split(c, 1)
                sign = c
                break
        d = datetime.fromisoformat(f"{head}.{frac.ljust(6, '0')[:6]}{sign}{tz}")
    return d if d.tzinfo else d.replace(tzinfo=timezone.utc)


def _age(v: Any, now: datetime) -> float | None:
    t = _ts(v)
    return None if t is None else (now - t).total_seconds()


def _fmt_age(s: float | None) -> str:
    if s is None:
        return "never"
    s = int(s)
    if s < 120:
        return f"{s}s"
    if s < 7200:
        return f"{s // 60}m"
    if s < 172800:
        return f"{s // 3600}h{(s % 3600) // 60:02d}m"
    return f"{s // 86400}d"


def _finding(key: str, severity: str, check: str, message: str, **extra) -> dict:
    return {"key": key, "severity": severity, "check": check, "message": message, **extra}


def _coin_matches(position_symbol: str, hl_coin: str, symbol: str) -> bool:
    p = (position_symbol or "").lower()
    return p == (hl_coin or "").lower() or p.split(":")[-1] == (symbol or "").lower() \
        or p.split(":")[-1] == (hl_coin or "").lower().split(":")[-1]


# ----------------------------------------------------------------------------- load
def load(sb, now: datetime) -> dict:
    """Read everything evaluate() needs. Each query is independent so one failure is isolated."""
    hour_ago = (now - timedelta(hours=1)).isoformat()
    day_ago = (now - timedelta(hours=24)).isoformat()
    month_ago = (now - timedelta(days=30)).isoformat()
    data: dict[str, Any] = {"errors": []}

    def q(name: str, fn: Callable[[], Any], default: Any):
        try:
            data[name] = fn()
        except Exception as e:                      # noqa: BLE001 - surfaced as a finding
            log.exception("monitor load %s failed", name)
            data[name] = default
            data["errors"].append(f"{name}: {e}"[:300])

    q("heartbeats", lambda: sb.table("heartbeats").select("*").execute().data or [], [])
    q("system_state", lambda: (sb.table("system_state").select("*").eq("id", "global")
                               .execute().data or [None])[0], None)
    q("strategies", lambda: sb.table("strategies").select("id, slug, symbol, timeframe, status, markets(hl_coin)")
      .eq("status", "published").execute().data or [], [])

    def latest_signals():
        out = {}
        for s in data.get("strategies", []):
            rows = (sb.table("strategy_signals").select("strategy_id, bar_time, desired, created_at")
                    .eq("strategy_id", s["id"]).order("bar_time", desc=True).limit(1).execute().data or [])
            if rows:
                out[s["id"]] = rows[0]
        return out
    q("latest_signals", latest_signals, {})

    q("accounts", lambda: sb.table("broker_accounts")
      .select("id, user_id, network, wallet_address, status, kill_switch, last_error, agent_approved, updated_at")
      .in_("status", ["active", "error"]).execute().data or [], [])
    q("orders_1h", lambda: sb.table("orders")
      .select("id, broker_account_id, symbol, status, error, created_at")
      .gte("created_at", hour_ago).in_("status", ["filled", "partial", "rejected"]).execute().data or [], [])

    def snapshots():
        out: dict[str, list] = {}
        for a in data.get("accounts", []):
            rows = (sb.table("account_snapshots").select("equity, created_at")
                    .eq("broker_account_id", a["id"]).gte("created_at", month_ago)
                    .order("created_at").limit(10000).execute().data or [])
            out[a["id"]] = rows
        return out
    q("snapshots", snapshots, {})
    q("user_risk", lambda: {r["user_id"]: r for r in (sb.table("user_risk").select("*").execute().data or [])}, {})
    q("subscriptions", lambda: sb.table("subscriptions")
      .select("id, user_id, broker_account_id, strategy_id, mode, enabled, strategies(id, slug, symbol, status, timeframe, markets(hl_coin))")
      .eq("mode", "live").eq("enabled", True).execute().data or [], [])
    q("positions", lambda: sb.table("positions").select("broker_account_id, symbol, side, qty, updated_at")
      .execute().data or [], [])
    q("fees_24h", lambda: sb.table("builder_fees").select("fee_usd").gte("filled_at", day_ago)
      .execute().data or [], [])
    return data


# ----------------------------------------------------------------------------- checks
def check_heartbeats(data: dict, now: datetime) -> list[dict]:
    out = []
    hb = {h["id"]: h for h in data.get("heartbeats", [])}
    for wid, limit in (("executor", EXECUTOR_STALE_S), ("signals", SIGNALS_STALE_S)):
        age = _age(hb.get(wid, {}).get("last_run"), now)
        if age is None or age > limit:
            out.append(_finding(f"heartbeat:{wid}", "crit", "heartbeat",
                                f"{wid} heartbeat stale ({_fmt_age(age)} old, limit {_fmt_age(limit)})",
                                worker=wid, age_s=age))
    ex = hb.get("executor", {}).get("detail") or {}
    if isinstance(ex, dict) and ex.get("errors"):
        out.append(_finding("executor:errors", "warn", "heartbeat",
                            f"executor last pass had {ex['errors']} account error(s) of {ex.get('accounts', '?')}"))
    if "fees" in hb:
        age = _age(hb["fees"].get("last_run"), now)
        if age is None or age > FEES_STALE_S:
            out.append(_finding("heartbeat:fees", "warn", "heartbeat",
                                f"fees heartbeat stale ({_fmt_age(age)} old)", worker="fees", age_s=age))
    return out


def check_signal_freshness(data: dict, now: datetime) -> list[dict]:
    out = []
    for s in data.get("strategies", []):
        tf = s.get("timeframe")
        bar = TF_SECONDS.get(tf)
        if not bar:
            continue
        sig = data.get("latest_signals", {}).get(s["id"])
        age = _age(sig.get("bar_time") if sig else None, now)
        if age is None or age > SIGNAL_STALE_BARS * bar:
            out.append(_finding(f"signal_stale:{s['id']}", "warn", "signal_freshness",
                                f"strategy {s.get('slug')} ({s.get('symbol')} {tf}) has no signal for "
                                f"{_fmt_age(age)} (> {SIGNAL_STALE_BARS} bars): executor will not open entries",
                                strategy_id=s["id"], age_s=age))
    return out


def check_accounts(data: dict, now: datetime) -> list[dict]:
    out = []
    for a in data.get("accounts", []):
        short = f"{a['id'][:8]} ({(a.get('wallet_address') or '')[:10]}, {a.get('network')})"
        if a.get("status") == "error":
            out.append(_finding(f"acct_status:{a['id']}", "crit", "broker_account",
                                f"account {short} status=error: {a.get('last_error') or 'no detail'}",
                                account_id=a["id"]))
        elif a.get("last_error"):
            h = hashlib.sha1(a["last_error"].encode()).hexdigest()[:8]
            out.append(_finding(f"acct_error:{a['id']}:{h}", "warn", "broker_account",
                                f"account {short} last_error: {a['last_error'][:200]}", account_id=a["id"]))
        if a.get("kill_switch") and a.get("status") == "active":
            out.append(_finding(f"kill_switch:{a['id']}", "info", "broker_account",
                                f"account {short} kill switch ON (flattening / flat)", account_id=a["id"]))
    return out


def check_orders(data: dict, now: datetime) -> list[dict]:
    out = []
    orders = data.get("orders_1h", [])
    by_acct: dict[str, list] = {}
    for o in orders:
        by_acct.setdefault(o["broker_account_id"], []).append(o)
    for acct, rows in by_acct.items():
        rej = [o for o in rows if o["status"] == "rejected"]
        if len(rows) >= REJECT_MIN_ORDERS_ACCT and len(rej) / len(rows) >= REJECT_RATE_ACCT:
            last = (rej[-1].get("error") or "")[:150]
            out.append(_finding(f"reject_rate:{acct}", "crit", "orders",
                                f"account {acct[:8]}: {len(rej)}/{len(rows)} orders rejected in 1h. last: {last}",
                                account_id=acct, rejected=len(rej), total=len(rows)))
        partial = [o for o in rows if o["status"] == "partial"]
        if partial:
            syms = sorted({o["symbol"] for o in partial})
            out.append(_finding(f"partial:{acct}:{','.join(syms)}", "warn", "orders",
                                f"account {acct[:8]}: {len(partial)} partial fill(s) in 1h on {', '.join(syms)} "
                                f"(position may be under-sized; next pass re-diffs side only)",
                                account_id=acct))
    rej_all = sum(1 for o in orders if o["status"] == "rejected")
    if len(orders) >= REJECT_MIN_ORDERS_GLOBAL and rej_all / len(orders) >= REJECT_RATE_GLOBAL:
        out.append(_finding("reject_rate:global", "crit", "orders",
                            f"global rejection rate {rej_all}/{len(orders)} ({rej_all / len(orders):.0%}) in 1h",
                            rejected=rej_all, total=len(orders)))
    return out


def check_drawdown(data: dict, now: datetime) -> list[dict]:
    out = []
    day_ago = now - timedelta(hours=24)
    for a in data.get("accounts", []):
        snaps = data.get("snapshots", {}).get(a["id"]) or []
        if not snaps:
            continue
        risk = data.get("user_risk", {}).get(a["user_id"]) or {}
        max_daily = float(risk.get("max_daily_loss_pct") or 5)
        max_dd = float(risk.get("max_drawdown_pct") or 20)
        eq = [(_ts(s["created_at"]), float(s["equity"])) for s in snaps if s.get("equity") is not None]
        eq.sort(key=lambda x: x[0])
        if not eq:
            continue
        cur = eq[-1][1]
        peak = max(e for _, e in eq)
        day = [e for t, e in eq if t >= day_ago]
        start = day[0] if day else None
        for name, limit, base in (("daily_loss", max_daily, start), ("drawdown", max_dd, peak)):
            if not base or base <= 0:
                continue
            loss = (1 - cur / base) * 100
            if loss >= limit:
                sev = "crit"
            elif loss >= RISK_WARN_FRACTION * limit:
                sev = "warn"
            else:
                continue
            what = "24h loss" if name == "daily_loss" else "drawdown from 30d peak"
            note = " (executor blocks new entries)" if name == "daily_loss" and sev == "crit" else \
                   " (NOT enforced by executor yet: consider kill switch)" if sev == "crit" else ""
            out.append(_finding(f"{name}:{a['id']}:{sev}", sev, "risk",
                                f"account {a['id'][:8]} {what} {loss:.1f}% vs limit {limit:g}%{note}",
                                account_id=a["id"], loss_pct=round(loss, 2), limit_pct=limit, equity=cur))
    return out


def check_divergence(data: dict, now: datetime) -> list[dict]:
    """Live subscription whose actual position side differs from the latest (fresh) signal for
    longer than DIVERGENCE_PASSES executor passes after the signal was written."""
    out = []
    state = data.get("system_state") or {}
    if state.get("halted"):
        return out                                   # entries intentionally blocked
    accounts = {a["id"]: a for a in data.get("accounts", [])}
    hb = {h["id"]: h for h in data.get("heartbeats", [])}
    exec_last = _ts(hb.get("executor", {}).get("last_run"))
    if exec_last is None:
        return out                                   # heartbeat check already alerts
    grace = timedelta(seconds=DIVERGENCE_PASSES * EXECUTOR_PERIOD_S + 30)
    for sub in data.get("subscriptions", []):
        acct = accounts.get(sub["broker_account_id"])
        strat = sub.get("strategies") or {}
        if not acct or acct.get("status") != "active" or acct.get("kill_switch") or strat.get("status") != "published":
            continue
        sig = data.get("latest_signals", {}).get(strat.get("id") or sub["strategy_id"])
        if not sig:
            continue
        bar = TF_SECONDS.get(strat.get("timeframe"), 3600)
        age = _age(sig.get("bar_time"), now)
        if age is None or age > SIGNAL_STALE_BARS * bar:
            continue                                 # stale: covered by signal_freshness
        written = _ts(sig.get("created_at")) or _ts(sig.get("bar_time"))
        if exec_last - written < grace:
            continue                                 # executor has not had 2 passes yet
        hl_coin = (strat.get("markets") or {}).get("hl_coin", "")
        pos = next((p for p in data.get("positions", []) if p["broker_account_id"] == acct["id"]
                    and _coin_matches(p["symbol"], hl_coin, strat.get("symbol", ""))), None)
        actual = pos["side"] if pos else "flat"
        if actual != sig["desired"]:
            risk = data.get("user_risk", {}).get(acct["user_id"]) or {}
            why = " (user trading disabled)" if risk.get("trading_enabled") is False else ""
            sev = "warn" if why or sig["desired"] != "flat" else "crit"   # failing to CLOSE is worse
            out.append(_finding(f"divergence:{sub['id']}:{sig['desired']}", sev, "divergence",
                                f"account {acct['id'][:8]} {strat.get('slug')}: signal={sig['desired']} "
                                f"actual={actual} for {_fmt_age((exec_last - written).total_seconds())}{why}",
                                account_id=acct["id"], subscription_id=sub["id"]))
    return out


def check_halt(data: dict, now: datetime) -> list[dict]:
    st = data.get("system_state") or {}
    if st.get("halted"):
        return [_finding("system:halted", "warn", "system",
                         f"GLOBAL HALT is on (new entries blocked){': ' + st['note'] if st.get('note') else ''}")]
    return []


def check_revenue(data: dict, now: datetime) -> list[dict]:
    rows = data.get("fees_24h", [])
    total = sum(float(r.get("fee_usd") or 0) for r in rows)
    return [_finding("revenue:24h", "info", "revenue", f"builder fees last 24h: ${total:,.2f} ({len(rows)} fills)",
                     fee_usd_24h=round(total, 4), fills=len(rows))]


CHECKS = [check_heartbeats, check_halt, check_signal_freshness, check_accounts, check_orders,
          check_drawdown, check_divergence, check_revenue]


def evaluate(data: dict, now: datetime) -> list[dict]:
    findings: list[dict] = []
    for e in data.get("errors", []):
        findings.append(_finding(f"monitor_load:{e.split(':')[0]}", "warn", "monitor", f"monitor query failed: {e}"))
    for chk in CHECKS:
        try:
            findings.extend(chk(data, now))
        except Exception as e:                      # noqa: BLE001
            log.exception("check %s failed", chk.__name__)
            findings.append(_finding(f"monitor_check_failed:{chk.__name__}", "warn", "monitor",
                                     f"check {chk.__name__} crashed: {e}"[:300]))
    findings.sort(key=lambda f: (SEV_ORDER.get(f["severity"], 9), f["key"]))
    return findings


# ----------------------------------------------------------------------------- dedupe
def plan_alerts(findings: list[dict], prev_alerted: dict[str, str], now: datetime,
                cooldown_s: int = ALERT_COOLDOWN_S) -> tuple[list[dict], list[str], dict[str, str]]:
    """Return (to_send, resolved_keys, carried_state).

    to_send: alertable findings whose key was never sent or was last sent >= cooldown ago.
    resolved_keys: keys that were alerted before and are no longer present.
    carried_state: prev state restricted to still-active keys (the caller stamps sent keys)."""
    active = {f["key"] for f in findings if f["severity"] in ("crit", "warn")}
    to_send = []
    for f in findings:
        if f["key"] not in active:
            continue
        last = _ts(prev_alerted.get(f["key"]))
        if last is None or (now - last).total_seconds() >= cooldown_s:
            to_send.append(f)
    resolved = sorted(k for k in prev_alerted if k not in active)
    carried = {k: v for k, v in prev_alerted.items() if k in active}
    return to_send, resolved, carried


def format_message(to_send: list[dict], resolved: list[str], label: str = "") -> str:
    icon = {"crit": "[CRIT]", "warn": "[WARN]"}
    head = f"Aether monitor{' ' + label if label else ''}"
    lines = [head]
    lines += [f"{icon.get(f['severity'], '')} {f['message']}" for f in to_send]
    lines += [f"[RESOLVED] {k}" for k in resolved]
    return "\n".join(lines)[:3900]                  # Telegram limit is 4096


# ----------------------------------------------------------------------------- notify
def _chat_ids() -> list[str]:
    raw = os.getenv("TELEGRAM_CHAT_IDS") or os.getenv("TELEGRAM_CHAT_ID") or ""
    return [c.strip() for c in raw.split(",") if c.strip()]


def notify(text: str, findings: list[dict]) -> bool:
    """Send to every configured channel. Returns True if at least one delivered, or if no channel is
    configured (nothing to retry). Never raises."""
    import requests
    token = os.getenv("TELEGRAM_BOT_TOKEN", "")
    hook = os.getenv("MONITOR_WEBHOOK_URL", "")
    chats = _chat_ids() if token else []
    if not chats and not hook:
        log.warning("no alert channel configured; alert only logged:\n%s", text)
        return True
    ok = False
    for chat in chats:
        try:
            r = requests.post(f"https://api.telegram.org/bot{token}/sendMessage",
                              json={"chat_id": chat, "text": text, "disable_web_page_preview": True}, timeout=10)
            ok |= r.ok
            if not r.ok:
                log.error("telegram %s -> %s %s", chat, r.status_code, r.text[:200])
        except Exception as e:                      # noqa: BLE001
            log.error("telegram %s failed: %s", chat, e)
    if hook:
        try:
            r = requests.post(hook, json={"text": text, "findings": findings}, timeout=10)
            ok |= r.ok
            if not r.ok:
                log.error("webhook -> %s", r.status_code)
        except Exception as e:                      # noqa: BLE001
            log.error("webhook failed: %s", e)
    return ok


def _ping():
    url = os.getenv("MONITOR_PING_URL", "")
    if url:
        try:
            import requests
            requests.get(url, timeout=5)
        except Exception as e:                      # noqa: BLE001
            log.warning("ping failed: %s", e)


# ----------------------------------------------------------------------------- run
def run_once(sb=None, now: datetime | None = None, sender: Callable[[str, list], bool] | None = None) -> dict:
    if sb is None:
        from .db import client
        sb = client()
    now = now or _now()
    sender = sender or notify
    data = load(sb, now)
    findings = evaluate(data, now)

    prev = next((h for h in data.get("heartbeats", []) if h["id"] == HEARTBEAT_ID), None)
    prev_alerted = ((prev or {}).get("detail") or {}).get("alerted") or {}
    to_send, resolved, alerted = plan_alerts(findings, prev_alerted, now)
    sent = False
    if to_send or resolved:
        sent = sender(format_message(to_send, resolved, os.getenv("MONITOR_ENV_LABEL", "")), to_send)
        if sent:
            for f in to_send:
                alerted[f["key"]] = now.isoformat()
        else:
            # Delivery failed: keep old stamps so we retry next run; keep resolved keys pending too.
            alerted.update({k: prev_alerted[k] for k in resolved})

    counts = {s: sum(1 for f in findings if f["severity"] == s) for s in ("crit", "warn", "info")}
    summary = {"counts": counts, "findings": findings, "alerted": alerted,
               "sent": len(to_send) if sent else 0, "resolved": resolved if sent else []}
    sb.table("heartbeats").upsert({"id": HEARTBEAT_ID, "last_run": now.isoformat(), "detail": summary}).execute()
    _ping()
    log.info("monitor: %s crit, %s warn, %s info; sent %s", counts["crit"], counts["warn"], counts["info"],
             summary["sent"])
    return {"counts": counts, "sent": summary["sent"], "resolved": summary["resolved"]}


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    print(run_once())
