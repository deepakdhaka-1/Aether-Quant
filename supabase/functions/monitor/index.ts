// monitor: watchdog over ingest, signals, the executor and every live account (every 5 minutes).
//
// load() reads everything with the service role; evaluate() is pure (data in, findings out).
// Findings go to heartbeats['monitor'].detail.findings for the admin page; crit/warn findings are
// alerted to Telegram and/or a webhook, de-duplicated: the same key is not re-sent for
// MONITOR_ALERT_COOLDOWN_S (30 min); a previously alerted finding that disappears sends one RESOLVED
// line. The monitor never trades and never writes to trading tables. A failing check becomes a
// 'monitor_check_failed' finding instead of a silent crash.
//
// Env (all optional): TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_IDS (comma list), MONITOR_WEBHOOK_URL,
// MONITOR_PING_URL, MONITOR_ALERT_COOLDOWN_S, MONITOR_ENV_LABEL.
import { db, serve } from "../_shared/db.ts";
import { env, envNum } from "../_shared/env.ts";

const HEARTBEAT_ID = "monitor";
const TF_SECONDS: Record<string, number> = { "15m": 900, "1h": 3600, "4h": 14400, "1d": 86400 };
const EXECUTOR_STALE_S = 5 * 60;
const SIGNALS_STALE_S = 20 * 60;
const INGEST_STALE_S = 2 * 3600 + 600;
const FEES_STALE_S = 3 * 3600;
const SIGNAL_STALE_BARS = 2;
const REJECT_MIN_ORDERS_ACCT = 3, REJECT_RATE_ACCT = 0.5, REJECT_MIN_ORDERS_GLOBAL = 5, REJECT_RATE_GLOBAL = 0.2;
const RISK_WARN_FRACTION = 0.8;
const DIVERGENCE_PASSES = 2, EXECUTOR_PERIOD_S = 60;
const SEV_ORDER: Record<string, number> = { crit: 0, warn: 1, info: 2 };

// deno-lint-ignore no-explicit-any
type Row = Record<string, any>;
export interface Finding { key: string; severity: "crit" | "warn" | "info"; check: string; message: string; [k: string]: unknown }

const ts = (v: unknown): number | null => {
  if (v === null || v === undefined || v === "") return null;
  const t = Date.parse(String(v));
  return Number.isFinite(t) ? t / 1000 : null;
};
const age = (v: unknown, now: number) => {
  const t = ts(v);
  return t === null ? null : now - t;
};
export function fmtAge(s: number | null): string {
  if (s === null) return "never";
  s = Math.trunc(s);
  if (s < 120) return `${s}s`;
  if (s < 7200) return `${Math.trunc(s / 60)}m`;
  if (s < 172800) return `${Math.trunc(s / 3600)}h${String(Math.trunc((s % 3600) / 60)).padStart(2, "0")}m`;
  return `${Math.trunc(s / 86400)}d`;
}
const finding = (key: string, severity: Finding["severity"], check: string, message: string, extra: Row = {}): Finding =>
  ({ key, severity, check, message, ...extra });
const coinMatches = (pos: string, hl: string, sym: string) => {
  const p = (pos || "").toLowerCase();
  return p === (hl || "").toLowerCase() || p.split(":").pop() === (sym || "").toLowerCase() || p.split(":").pop() === (hl || "").toLowerCase().split(":").pop();
};
async function sha1Short(s: string) {
  const d = new Uint8Array(await crypto.subtle.digest("SHA-1", new TextEncoder().encode(s)));
  return [...d].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 8);
}

// ------------------------------------------------------------------------------------------------ load
async function load(now: number): Promise<Row> {
  const sb = db();
  const iso = (s: number) => new Date((now - s) * 1000).toISOString();
  const data: Row = { errors: [] };
  const q = async (name: string, fn: () => Promise<unknown>, def: unknown) => {
    try {
      data[name] = await fn();
    } catch (e) {
      data[name] = def;
      data.errors.push(`${name}: ${(e as Error).message}`.slice(0, 300));
    }
  };
  const must = <T>(r: { data: T | null; error: { message: string } | null }) => {
    if (r.error) throw new Error(r.error.message);
    return r.data;
  };
  await q("heartbeats", async () => must(await sb.from("heartbeats").select("*")) ?? [], []);
  await q("system_state", async () => (must(await sb.from("system_state").select("*").eq("id", "global")) as Row[] ?? [])[0] ?? null, null);
  await q("strategies", async () => must(await sb.from("strategies").select("id, slug, symbol, timeframe, status, markets(hl_coin)").eq("status", "published")) ?? [], []);
  await q("latest_signals", async () => {
    const out: Row = {};
    for (const s of data.strategies as Row[]) {
      const rows = must(await sb.from("strategy_signals").select("strategy_id, bar_time, desired, created_at").eq("strategy_id", s.id).order("bar_time", { ascending: false }).limit(1)) as Row[];
      if (rows?.length) out[s.id] = rows[0];
    }
    return out;
  }, {});
  await q("accounts", async () => must(await sb.from("broker_accounts").select("id, user_id, network, wallet_address, status, kill_switch, last_error, agent_approved, updated_at").in("status", ["active", "error"])) ?? [], []);
  await q("orders_1h", async () => must(await sb.from("orders").select("id, broker_account_id, symbol, status, error, created_at").gte("created_at", iso(3600)).in("status", ["filled", "partial", "rejected"])) ?? [], []);
  await q("snapshots", async () => {
    const out: Row = {};
    for (const a of data.accounts as Row[]) {
      out[a.id] = must(await sb.from("account_snapshots").select("equity, created_at").eq("broker_account_id", a.id).gte("created_at", iso(30 * 86400)).order("created_at").limit(10000)) ?? [];
    }
    return out;
  }, {});
  await q("user_risk", async () => Object.fromEntries(((must(await sb.from("user_risk").select("*")) ?? []) as Row[]).map((r) => [r.user_id, r])), {});
  await q("subscriptions", async () => must(await sb.from("subscriptions").select("id, user_id, broker_account_id, strategy_id, mode, enabled, strategies(id, slug, symbol, status, timeframe, markets(hl_coin))").eq("mode", "live").eq("enabled", true)) ?? [], []);
  await q("positions", async () => must(await sb.from("positions").select("broker_account_id, symbol, side, qty, updated_at")) ?? [], []);
  await q("fees_24h", async () => must(await sb.from("builder_fees").select("fee_usd").gte("filled_at", iso(86400))) ?? [], []);
  return data;
}

// ------------------------------------------------------------------------------------------------ checks
function checkHeartbeats(d: Row, now: number): Finding[] {
  const out: Finding[] = [];
  const hb: Row = Object.fromEntries((d.heartbeats as Row[]).map((h) => [h.id, h]));
  for (const [wid, limit] of [["executor", EXECUTOR_STALE_S], ["signals", SIGNALS_STALE_S]] as [string, number][]) {
    const a = age(hb[wid]?.last_run, now);
    if (a === null || a > limit) out.push(finding(`heartbeat:${wid}`, "crit", "heartbeat", `${wid} heartbeat stale (${fmtAge(a)} old, limit ${fmtAge(limit)})`, { worker: wid, age_s: a }));
  }
  const ex = hb.executor?.detail;
  if (ex && typeof ex === "object" && ex.errors) out.push(finding("executor:errors", "warn", "heartbeat", `executor last pass had ${ex.errors} account error(s) of ${ex.accounts ?? "?"}`));
  for (const [wid, limit] of [["fees", FEES_STALE_S], ["ingest", INGEST_STALE_S]] as [string, number][]) {
    if (!(wid in hb)) continue;
    const a = age(hb[wid].last_run, now);
    if (a === null || a > limit) out.push(finding(`heartbeat:${wid}`, "warn", "heartbeat", `${wid} heartbeat stale (${fmtAge(a)} old)`, { worker: wid, age_s: a }));
  }
  const ing = hb.ingest?.detail;
  if (ing && typeof ing === "object" && ing.failed) out.push(finding("ingest:failed", "warn", "heartbeat", `ingest: ${ing.failed} of ${ing.feeds} feeds failed last run`));
  return out;
}

function checkSignalFreshness(d: Row, now: number): Finding[] {
  const out: Finding[] = [];
  for (const s of d.strategies as Row[]) {
    const bar = TF_SECONDS[s.timeframe];
    if (!bar) continue;
    const sig = d.latest_signals[s.id];
    const a = age(sig?.bar_time, now);
    if (a === null || a > SIGNAL_STALE_BARS * bar) {
      out.push(finding(`signal_stale:${s.id}`, "warn", "signal_freshness",
        `strategy ${s.slug} (${s.symbol} ${s.timeframe}) has no signal for ${fmtAge(a)} (> ${SIGNAL_STALE_BARS} bars): executor will not open entries`, { strategy_id: s.id, age_s: a }));
    }
  }
  return out;
}

async function checkAccounts(d: Row): Promise<Finding[]> {
  const out: Finding[] = [];
  for (const a of d.accounts as Row[]) {
    const short = `${a.id.slice(0, 8)} (${(a.wallet_address || "").slice(0, 10)}, ${a.network})`;
    if (a.status === "error") out.push(finding(`acct_status:${a.id}`, "crit", "broker_account", `account ${short} status=error: ${a.last_error || "no detail"}`, { account_id: a.id }));
    else if (a.last_error) out.push(finding(`acct_error:${a.id}:${await sha1Short(a.last_error)}`, "warn", "broker_account", `account ${short} last_error: ${a.last_error.slice(0, 200)}`, { account_id: a.id }));
    if (a.kill_switch && a.status === "active") out.push(finding(`kill_switch:${a.id}`, "info", "broker_account", `account ${short} kill switch ON (flattening / flat)`, { account_id: a.id }));
  }
  return out;
}

function checkOrders(d: Row): Finding[] {
  const out: Finding[] = [];
  const orders = d.orders_1h as Row[];
  const byAcct = new Map<string, Row[]>();
  for (const o of orders) byAcct.set(o.broker_account_id, [...(byAcct.get(o.broker_account_id) ?? []), o]);
  for (const [acct, rows] of byAcct) {
    const rej = rows.filter((o) => o.status === "rejected");
    if (rows.length >= REJECT_MIN_ORDERS_ACCT && rej.length / rows.length >= REJECT_RATE_ACCT) {
      out.push(finding(`reject_rate:${acct}`, "crit", "orders", `account ${acct.slice(0, 8)}: ${rej.length}/${rows.length} orders rejected in 1h. last: ${(rej[rej.length - 1].error || "").slice(0, 150)}`, { account_id: acct, rejected: rej.length, total: rows.length }));
    }
    const partial = rows.filter((o) => o.status === "partial");
    if (partial.length) {
      const syms = [...new Set(partial.map((o) => o.symbol))].sort();
      out.push(finding(`partial:${acct}:${syms.join(",")}`, "warn", "orders", `account ${acct.slice(0, 8)}: ${partial.length} partial fill(s) in 1h on ${syms.join(", ")}`, { account_id: acct }));
    }
  }
  const rejAll = orders.filter((o) => o.status === "rejected").length;
  if (orders.length >= REJECT_MIN_ORDERS_GLOBAL && rejAll / orders.length >= REJECT_RATE_GLOBAL) {
    out.push(finding("reject_rate:global", "crit", "orders", `global rejection rate ${rejAll}/${orders.length} (${Math.round(100 * rejAll / orders.length)}%) in 1h`, { rejected: rejAll, total: orders.length }));
  }
  return out;
}

function checkDrawdown(d: Row, now: number): Finding[] {
  const out: Finding[] = [];
  for (const a of d.accounts as Row[]) {
    const snaps = (d.snapshots[a.id] ?? []) as Row[];
    if (!snaps.length) continue;
    const risk = d.user_risk[a.user_id] ?? {};
    const maxDaily = Number(risk.max_daily_loss_pct || 5), maxDd = Number(risk.max_drawdown_pct || 20);
    const eq = snaps.filter((s) => s.equity !== null).map((s) => [ts(s.created_at)!, Number(s.equity)] as [number, number]).sort((x, y) => x[0] - y[0]);
    if (!eq.length) continue;
    const cur = eq[eq.length - 1][1];
    const peak = Math.max(...eq.map((e) => e[1]));
    const day = eq.filter(([t]) => t >= now - 86400).map((e) => e[1]);
    const start = day.length ? day[0] : null;
    for (const [name, limit, base] of [["daily_loss", maxDaily, start], ["drawdown", maxDd, peak]] as [string, number, number | null][]) {
      if (!base || base <= 0) continue;
      const loss = (1 - cur / base) * 100;
      const sev = loss >= limit ? "crit" : loss >= RISK_WARN_FRACTION * limit ? "warn" : null;
      if (!sev) continue;
      const what = name === "daily_loss" ? "24h loss" : "drawdown from 30d peak";
      const note = sev === "crit" ? " (executor blocks new entries)" : "";
      out.push(finding(`${name}:${a.id}:${sev}`, sev, "risk", `account ${a.id.slice(0, 8)} ${what} ${loss.toFixed(1)}% vs limit ${limit}%${note}`, { account_id: a.id, loss_pct: Math.round(loss * 100) / 100, limit_pct: limit, equity: cur }));
    }
  }
  return out;
}

function checkDivergence(d: Row, now: number): Finding[] {
  const out: Finding[] = [];
  if (d.system_state?.halted) return out;
  const accounts: Row = Object.fromEntries((d.accounts as Row[]).map((a) => [a.id, a]));
  const hb: Row = Object.fromEntries((d.heartbeats as Row[]).map((h) => [h.id, h]));
  const execLast = ts(hb.executor?.last_run);
  if (execLast === null) return out;
  const grace = DIVERGENCE_PASSES * EXECUTOR_PERIOD_S + 30;
  for (const sub of d.subscriptions as Row[]) {
    const acct = accounts[sub.broker_account_id];
    const strat = sub.strategies ?? {};
    if (!acct || acct.status !== "active" || acct.kill_switch || strat.status !== "published") continue;
    const sig = d.latest_signals[strat.id ?? sub.strategy_id];
    if (!sig) continue;
    const bar = TF_SECONDS[strat.timeframe] ?? 3600;
    const a = age(sig.bar_time, now);
    if (a === null || a > SIGNAL_STALE_BARS * bar) continue;
    const written = ts(sig.created_at) ?? ts(sig.bar_time)!;
    if (execLast - written < grace) continue;
    const hl = strat.markets?.hl_coin ?? "";
    const pos = (d.positions as Row[]).find((p) => p.broker_account_id === acct.id && coinMatches(p.symbol, hl, strat.symbol ?? ""));
    const actual = pos ? pos.side : "flat";
    if (actual !== sig.desired) {
      const risk = d.user_risk[acct.user_id] ?? {};
      const why = risk.trading_enabled === false ? " (user trading disabled)" : "";
      const sev = why || sig.desired !== "flat" ? "warn" : "crit"; // failing to CLOSE is worse
      out.push(finding(`divergence:${sub.id}:${sig.desired}`, sev, "divergence", `account ${acct.id.slice(0, 8)} ${strat.slug}: signal=${sig.desired} actual=${actual} for ${fmtAge(execLast - written)}${why}`, { account_id: acct.id, subscription_id: sub.id }));
    }
  }
  return out;
}

function checkHalt(d: Row): Finding[] {
  const st = d.system_state ?? {};
  return st.halted ? [finding("system:halted", "warn", "system", `GLOBAL HALT is on (new entries blocked)${st.note ? ": " + st.note : ""}`)] : [];
}

function checkRevenue(d: Row): Finding[] {
  const rows = d.fees_24h as Row[];
  const total = rows.reduce((s, r) => s + Number(r.fee_usd || 0), 0);
  return [finding("revenue:24h", "info", "revenue", `builder fees last 24h: $${total.toFixed(2)} (${rows.length} fills)`, { fee_usd_24h: Math.round(total * 1e4) / 1e4, fills: rows.length })];
}

export async function evaluate(d: Row, now: number): Promise<Finding[]> {
  const findings: Finding[] = (d.errors as string[]).map((e) => finding(`monitor_load:${e.split(":")[0]}`, "warn", "monitor", `monitor query failed: ${e}`));
  const checks: [string, () => Finding[] | Promise<Finding[]>][] = [
    ["heartbeats", () => checkHeartbeats(d, now)], ["halt", () => checkHalt(d)], ["signal_freshness", () => checkSignalFreshness(d, now)],
    ["accounts", () => checkAccounts(d)], ["orders", () => checkOrders(d)], ["drawdown", () => checkDrawdown(d, now)],
    ["divergence", () => checkDivergence(d, now)], ["revenue", () => checkRevenue(d)],
  ];
  for (const [name, fn] of checks) {
    try {
      findings.push(...await fn());
    } catch (e) {
      findings.push(finding(`monitor_check_failed:${name}`, "warn", "monitor", `check ${name} crashed: ${(e as Error).message}`.slice(0, 300)));
    }
  }
  return findings.sort((a, b) => (SEV_ORDER[a.severity] - SEV_ORDER[b.severity]) || a.key.localeCompare(b.key));
}

export function planAlerts(findings: Finding[], prev: Record<string, string>, now: number, cooldown: number) {
  const active = new Set(findings.filter((f) => f.severity !== "info").map((f) => f.key));
  const toSend = findings.filter((f) => {
    if (!active.has(f.key)) return false;
    const last = ts(prev[f.key]);
    return last === null || now - last >= cooldown;
  });
  const resolved = Object.keys(prev).filter((k) => !active.has(k)).sort();
  const carried = Object.fromEntries(Object.entries(prev).filter(([k]) => active.has(k)));
  return { toSend, resolved, carried };
}

export function formatMessage(toSend: Finding[], resolved: string[], label = ""): string {
  const icon: Record<string, string> = { crit: "[CRIT]", warn: "[WARN]" };
  return [`Aether monitor${label ? " " + label : ""}`, ...toSend.map((f) => `${icon[f.severity] ?? ""} ${f.message}`), ...resolved.map((k) => `[RESOLVED] ${k}`)].join("\n").slice(0, 3900);
}

async function notify(text: string, findings: Finding[]): Promise<boolean> {
  const token = env("TELEGRAM_BOT_TOKEN"), hook = env("MONITOR_WEBHOOK_URL");
  const chats = token ? (env("TELEGRAM_CHAT_IDS") || env("TELEGRAM_CHAT_ID")).split(",").map((c) => c.trim()).filter(Boolean) : [];
  if (!chats.length && !hook) {
    console.warn(`no alert channel configured; alert only logged:\n${text}`);
    return true;
  }
  let ok = false;
  for (const chat of chats) {
    try {
      const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: chat, text, disable_web_page_preview: true }), signal: AbortSignal.timeout(10000),
      });
      ok ||= r.ok;
      if (!r.ok) console.error(`telegram ${chat} -> ${r.status}`);
    } catch (e) {
      console.error(`telegram ${chat} failed: ${(e as Error).message}`);
    }
  }
  if (hook) {
    try {
      const r = await fetch(hook, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text, findings }), signal: AbortSignal.timeout(10000) });
      ok ||= r.ok;
    } catch (e) {
      console.error(`webhook failed: ${(e as Error).message}`);
    }
  }
  return ok;
}

serve("monitor", async () => {
  const now = Date.now() / 1000;
  const data = await load(now);
  const findings = await evaluate(data, now);
  const prev = (data.heartbeats as Row[]).find((h) => h.id === HEARTBEAT_ID)?.detail?.alerted ?? {};
  const { toSend, resolved, carried } = planAlerts(findings, prev, now, envNum("MONITOR_ALERT_COOLDOWN_S", 1800));
  const alerted: Record<string, string> = { ...carried };
  let sent = false;
  if (toSend.length || resolved.length) {
    sent = await notify(formatMessage(toSend, resolved, env("MONITOR_ENV_LABEL")), toSend);
    if (sent) for (const f of toSend) alerted[f.key] = new Date(now * 1000).toISOString();
    else for (const k of resolved) alerted[k] = prev[k]; // delivery failed: retry next run
  }
  const counts = { crit: 0, warn: 0, info: 0 };
  for (const f of findings) counts[f.severity]++;
  const summary = { counts, findings, alerted, sent: sent ? toSend.length : 0, resolved: sent ? resolved : [] };
  await db().from("heartbeats").upsert({ id: HEARTBEAT_ID, last_run: new Date(now * 1000).toISOString(), detail: summary });
  const ping = env("MONITOR_PING_URL");
  if (ping) await fetch(ping, { signal: AbortSignal.timeout(5000) }).catch(() => {});
  return { counts, sent: summary.sent, resolved: summary.resolved };
});
