// execute: reconcile every active follower's Hyperliquid account to their subscribed strategies.
// pg_cron, every minute. Spec: docs/EXECUTION_SPEC.md.
//
// Idempotent and fail-closed: each pass diffs desired vs actual, so a missed pass self-heals on the
// next. Any uncertainty blocks NEW entries; reduce-only closes are never blocked. A flip opens the new
// side only after a read-back proves the old side is gone.
//
// Live gates: real orders only when DRY_RUN=false AND HYPERLIQUID_LIVE_CONFIRMED=true. Otherwise every
// intended order is recorded with status 'dry_run' and nothing is sent. Every order carries the builder
// code (BUILDER_ADDRESS / BUILDER_FEE_BPS10).
import { db, heartbeat, serve } from "../_shared/db.ts";
import { decrypt } from "../_shared/crypto.ts";
import { envNum } from "../_shared/env.ts";
import { type AccountState, BrokerError, builderConfig, HyperliquidAccount, isOurCloid, liveGatesOpen, type Position } from "../_shared/hyperliquid.ts";
import { bracketPcts, checkEntry, lateJoinRefusal, quoteFromL2 } from "../_shared/gates.ts";

const LOCK = "executor", LOCK_TTL = 110;
const SIGNAL_MAX_AGE_BARS = 2;
const TF_SECONDS: Record<string, number> = { "15m": 900, "1h": 3600, "4h": 14400, "1d": 86400 };
const CLOSE_RESIDUAL_USD = () => envNum("CLOSE_RESIDUAL_USD", 1.0);
const now = () => new Date();

// deno-lint-ignore no-explicit-any
type Row = Record<string, any>;

interface Ctx {
  acct: Row;
  hl: HyperliquidAccount;
  live: boolean;
  orders: number;
  notes: string[];
  // deno-lint-ignore no-explicit-any
  openOrders: any[] | null;
}

// ------------------------------------------------------------------------------------------------
// Recording
// ------------------------------------------------------------------------------------------------
async function record(ctx: Ctx, sub: Row | null, strategyId: string | null, coin: string, side: "buy" | "sell", qty: number,
  price: number | null, reduceOnly: boolean, status: string, oid: string | null = null, error: string | null = null) {
  const sb = db();
  if (status === "blocked" && sub) {
    // De-duplicate: same subscription + same reason + same qty within the last 5 minutes.
    const since = new Date(Date.now() - 5 * 60_000).toISOString();
    const { data } = await sb.from("orders").select("id, error, qty").eq("subscription_id", sub.id).eq("status", "blocked")
      .gte("created_at", since).order("created_at", { ascending: false }).limit(1);
    if (data?.length && data[0].error === error && Math.abs(Number(data[0].qty) - qty) <= 1e-9 * Math.max(1, qty)) return;
  }
  const b = builderConfig();
  const { error: e } = await sb.from("orders").insert({
    user_id: ctx.acct.user_id, broker_account_id: ctx.acct.id, subscription_id: sub?.id ?? null, strategy_id: strategyId,
    symbol: coin, side, qty: Number.isFinite(qty) ? qty : 0, price, reduce_only: reduceOnly, status, broker_order_id: oid,
    error, builder_fee_bps10: b ? b.f : null,
  });
  if (e) console.error(`order record failed: ${e.message}`);
  if (status !== "blocked") ctx.orders++;
}

async function setLastError(acctId: string, msg: string) {
  await db().from("broker_accounts").update({ last_error: msg.slice(0, 500) }).eq("id", acctId);
}

// ------------------------------------------------------------------------------------------------
// Risk (account gates: block entries, never closes)
// ------------------------------------------------------------------------------------------------
async function riskBlocksEntries(acct: Row, equity: number, risk: Row): Promise<string | null> {
  const sb = db();
  if (risk && risk.trading_enabled === false) return "trading disabled by user";
  if (!(equity > 0)) return "account equity is zero or unreadable: move USDC to the trading pot";
  const since = new Date(Date.now() - 24 * 3600_000).toISOString();
  const { data: day, error: e1 } = await sb.from("account_snapshots").select("equity").eq("broker_account_id", acct.id)
    .gte("created_at", since).order("created_at").limit(1);
  if (e1) throw new Error(`snapshots: ${e1.message}`);
  if (day?.length) {
    const start = Number(day[0].equity);
    if (start > 0 && (equity / start - 1) * 100 <= -Number(risk?.max_daily_loss_pct ?? 5)) return "daily loss limit reached";
  }
  const since30 = new Date(Date.now() - 30 * 86400_000).toISOString();
  const { data: pk, error: e2 } = await sb.from("account_snapshots").select("equity").eq("broker_account_id", acct.id)
    .gte("created_at", since30).order("equity", { ascending: false }).limit(1);
  if (e2) throw new Error(`snapshots: ${e2.message}`);
  const peak = Math.max(pk?.length ? Number(pk[0].equity) : 0, equity);
  if (peak > 0 && (equity / peak - 1) * 100 <= -Number(risk?.max_drawdown_pct ?? 20)) return "max drawdown limit reached";
  return null;
}

async function dailyLossBudgetUsd(acct: Row, equity: number, risk: Row): Promise<number | null> {
  const since = new Date(Date.now() - 24 * 3600_000).toISOString();
  const { data } = await db().from("account_snapshots").select("equity").eq("broker_account_id", acct.id).gte("created_at", since).order("created_at").limit(1);
  const start = data?.length ? Number(data[0].equity) : equity;
  return start * Number(risk?.max_daily_loss_pct ?? 5) / 100 - Math.max(0, start - equity);
}

// ------------------------------------------------------------------------------------------------
// Venue helpers
// ------------------------------------------------------------------------------------------------
async function ourTriggers(ctx: Ctx, coin: string) {
  if (ctx.openOrders === null) ctx.openOrders = await ctx.hl.openOrders();
  return ctx.openOrders.filter((o) => o.coin === coin && o.reduceOnly && o.triggerPx && isOurCloid(o.cloid))
    .map((o) => ({ oid: Number(o.oid), sz: Number(o.sz), trigger: Number(o.triggerPx), kind: String(o.orderType || "").startsWith("Take") ? "tp" : "sl" }));
}

async function cancelOurTriggers(ctx: Ctx, coin: string) {
  for (const o of await ourTriggers(ctx, coin)) {
    try { await ctx.hl.cancel(coin, o.oid); } catch (e) { console.warn(`cancel ${coin} ${o.oid}: ${(e as Error).message}`); }
  }
  ctx.openOrders = null;
}

async function venuePosition(ctx: Ctx, coin: string): Promise<Position | null> {
  const st = await ctx.hl.account();
  return st.positions.find((p) => p.coin === coin) ?? null;
}

// ------------------------------------------------------------------------------------------------
// Close (reduce-only, never gated). True only when the position is confirmed gone (or dry run).
// ------------------------------------------------------------------------------------------------
async function closePosition(ctx: Ctx, sub: Row | null, coin: string, pos: Position, reason: string): Promise<boolean> {
  const side = pos.side === "long" ? "sell" : "buy";
  const sid = sub?.strategy_id ?? null;
  if (!ctx.live) {
    await record(ctx, sub, sid, coin, side, pos.qty, pos.mark_price, true, "dry_run", null, reason);
    return true;
  }
  try {
    await cancelOurTriggers(ctx, coin);
    const r = await ctx.hl.marketOrder(coin, side === "buy", pos.qty, { reduceOnly: true, tag: "close" });
    let after: Position | null;
    try {
      after = await venuePosition(ctx, coin);
    } catch (e) {
      await record(ctx, sub, sid, coin, side, r.filled, r.avg_px, true, "partial", r.oid, `close sent, venue unreadable after: ${(e as Error).message}`);
      return false;
    }
    const residualUsd = after ? after.qty * (after.mark_price ?? r.avg_px) : 0;
    if (!after || residualUsd < CLOSE_RESIDUAL_USD()) {
      await record(ctx, sub, sid, coin, side, r.filled, r.avg_px, true, "filled", r.oid, reason);
      await cancelOurTriggers(ctx, coin);
      return true;
    }
    await record(ctx, sub, sid, coin, side, r.filled, r.avg_px, true, "partial", r.oid, `${reason}; residual ${after.qty} ${coin} still open`);
    ctx.notes.push(`close of ${coin} left a residual of ${after.qty}`);
    return false;
  } catch (e) {
    await record(ctx, sub, sid, coin, side, pos.qty, null, true, "rejected", null, String((e as Error).message).slice(0, 500));
    return false;
  }
}

// ------------------------------------------------------------------------------------------------
// Venue-resident bracket: placed after every entry and verified every pass.
// ------------------------------------------------------------------------------------------------
async function ensureBracket(ctx: Ctx, coin: string, pos: Position, sig: Row | null, strat: Row) {
  if (!ctx.live || !pos.entry_price) return;
  const want = bracketPcts(sig?.sl_pct != null ? Number(sig.sl_pct) : null, sig?.tp_pct != null ? Number(sig.tp_pct) : null,
    strat.stop_loss_pct != null ? Number(strat.stop_loss_pct) : null);
  const long = pos.side === "long";
  const mark = pos.mark_price ?? pos.entry_price;
  const levels: { kind: "sl" | "tp"; px: number }[] = [{ kind: "sl", px: pos.entry_price * (long ? 1 - want.sl / 100 : 1 + want.sl / 100) }];
  if (want.tp) levels.push({ kind: "tp", px: pos.entry_price * (long ? 1 + want.tp / 100 : 1 - want.tp / 100) });
  const existing = await ourTriggers(ctx, coin);
  const qtyTol = envNum("BRACKET_QTY_TOLERANCE_PCT", 5) / 100, pxTol = envNum("BRACKET_PRICE_TOLERANCE_PCT", 0.25) / 100;
  for (const lv of levels) {
    let px = lv.px;
    if (lv.kind === "sl" && (long ? px >= mark : px <= mark)) {
      px = mark * (long ? 0.999 : 1.001); // already through the mark: park at the minimum distance
      ctx.notes.push(`${coin}: wanted stop is through the mark; parked at 0.1%`);
    }
    if (lv.kind === "sl" && pos.leverage) {
      const liqPct = 100 / pos.leverage * 0.9;
      if (Math.abs(px / pos.entry_price - 1) * 100 >= liqPct) ctx.notes.push(`${coin}: stop at or beyond the isolated liquidation distance`);
    }
    const mine = existing.filter((o) => o.kind === lv.kind);
    const good = mine.find((o) => Math.abs(o.sz - pos.qty) <= qtyTol * pos.qty && Math.abs(o.trigger / px - 1) <= pxTol);
    if (good) continue;
    // Place the new leg first, then remove the old ones: a replace never leaves the position unprotected.
    try {
      await ctx.hl.placeTrigger(coin, pos.side, pos.qty, px, lv.kind, envNum("STOP_FILL_SLIPPAGE", 0.05));
    } catch (e) {
      await new Promise((r) => setTimeout(r, 750));
      try {
        await ctx.hl.placeTrigger(coin, pos.side, pos.qty, px, lv.kind, envNum("STOP_FILL_SLIPPAGE", 0.05));
      } catch (e2) {
        ctx.notes.push(`${lv.kind} not placed on ${coin}: ${(e2 as Error).message || (e as Error).message}`);
        continue; // the old leg (if any) stays in place
      }
    }
    for (const o of mine) {
      try { await ctx.hl.cancel(coin, o.oid); } catch (_e) { /* left resting; next pass retries */ }
    }
    ctx.openOrders = null;
  }
}

// ------------------------------------------------------------------------------------------------
// Account pass
// ------------------------------------------------------------------------------------------------
async function latestSignal(strategyId: string): Promise<Row | null> {
  const { data } = await db().from("strategy_signals").select("*").eq("strategy_id", strategyId).order("bar_time", { ascending: false }).limit(1);
  return data?.[0] ?? null;
}

/** Identity of the trade a signal stands for: its entry bar (the bar after the decision bar). */
function signalTradeId(sig: Row, tf: string): string {
  if (sig.entry_time) return new Date(sig.entry_time).toISOString();
  return new Date(Date.parse(sig.bar_time) + (TF_SECONDS[tf] ?? 3600) * 1000).toISOString();
}

async function syncPositions(ctx: Ctx, st?: AccountState) {
  const sb = db();
  const s = st ?? await ctx.hl.account();
  await sb.from("positions").delete().eq("broker_account_id", ctx.acct.id);
  if (s.positions.length) {
    const { error } = await sb.from("positions").insert(s.positions.map((p) => ({
      broker_account_id: ctx.acct.id, user_id: ctx.acct.user_id, symbol: p.coin, side: p.side, qty: p.qty,
      entry_price: p.entry_price, mark_price: p.mark_price, unrealized_pnl: p.unrealized_pnl, updated_at: now().toISOString(),
    })));
    if (error) console.error(`positions sync: ${error.message}`);
  }
}

async function reconcileAccount(acct: Row, halted: boolean): Promise<{ orders: number; notes: string[] }> {
  const sb = db();
  const key = await decrypt(acct.agent_secret_enc);
  const hl = await HyperliquidAccount.open(acct.wallet_address, key, acct.network); // refuses a master key
  const ctx: Ctx = { acct, hl, live: liveGatesOpen(), orders: 0, notes: [], openOrders: null };
  const state = await hl.account();
  await sb.from("account_snapshots").insert({ broker_account_id: acct.id, user_id: acct.user_id, equity: state.equity });
  const byCoin = new Map(state.positions.map((p) => [p.coin, p]));

  if (acct.kill_switch || acct.status !== "active") {
    for (const p of state.positions) await closePosition(ctx, null, p.coin, p, "kill_switch");
    await syncPositions(ctx);
    return { orders: ctx.orders, notes: ctx.notes };
  }

  const { data: riskRows } = await sb.from("user_risk").select("*").eq("user_id", acct.user_id).limit(1);
  const risk = riskRows?.[0] ?? {};
  let block: string | null = null;
  try {
    block = halted ? "global halt" : await riskBlocksEntries(acct, state.equity, risk);
  } catch (e) {
    block = `risk check failed: ${(e as Error).message}`;
  }
  const builder = builderConfig();
  if (!block && builder) {
    try {
      const approved = await hl.maxBuilderFee(builder.b);
      if (approved < builder.f) {
        block = `builder fee not approved (approved ${approved}, needs ${builder.f} tenths of a bp)`;
        ctx.notes.push(block);
      }
    } catch (e) {
      block = `builder approval unreadable: ${(e as Error).message}`;
    }
  } else if (!block && ctx.live) {
    block = "BUILDER_ADDRESS not configured: live entries refused";
  }

  const { data: subs, error } = await sb.from("subscriptions").select("*, strategies(*, markets(hl_coin, asset_class))")
    .eq("broker_account_id", acct.id).eq("mode", "live");
  if (error) throw new Error(`subscriptions: ${error.message}`);
  for (const sub of subs ?? []) {
    const strat = sub.strategies;
    let coin: string;
    try {
      coin = hl.toCoin(strat.markets.hl_coin);
    } catch (e) {
      ctx.notes.push((e as Error).message);
      continue;
    }
    const current = byCoin.get(coin) ?? null;
    const sig = await latestSignal(strat.id);
    let desired: "long" | "short" | "flat" = "flat";
    let fresh = false;
    if (sub.enabled && strat.status === "published" && sig) {
      const age = (Date.now() - Date.parse(sig.bar_time)) / 1000;
      fresh = age <= SIGNAL_MAX_AGE_BARS * (TF_SECONDS[strat.timeframe] ?? 3600);
      // A stale signal must not open anything, but keeps an existing matching position.
      desired = fresh || (current && current.side === sig.desired) ? sig.desired : "flat";
    } else if (strat.status === "paused" && current) {
      desired = current.side; // paused: no new trades, keep what's open
    }
    const actual = current ? current.side : "flat";

    if (desired === actual) {
      if (current) {
        try {
          await ensureBracket(ctx, coin, current, sig, strat);
        } catch (e) {
          ctx.notes.push(`bracket check failed on ${coin}: ${(e as Error).message}`);
        }
        await trimOversized(ctx, sub, strat, coin, current, state);
      }
      continue;
    }
    if (current) {
      if (!(await closePosition(ctx, sub, coin, current, `signal->${desired}`))) continue; // never open on an unconfirmed flat
    }
    if (desired === "flat") continue;

    const side = desired === "long" ? "buy" : "sell";
    const tradeId = signalTradeId(sig!, strat.timeframe);
    if (!current && sub.last_entry_signal && sub.last_entry_signal === tradeId) {
      // We opened this very signal before and the venue is flat without our close: the bracket (or a
      // liquidation / manual close) took it out. A new entry needs a new signal.
      await record(ctx, sub, strat.id, coin, side, 0, null, false, "blocked", null, "exit bracket filled on this signal; waiting for a new signal");
      continue;
    }
    if (block) {
      await record(ctx, sub, strat.id, coin, side, 0, null, false, "blocked", null, block);
      continue;
    }
    try {
      await openEntry(ctx, sub, strat, coin, desired, sig!, state, risk, tradeId);
    } catch (e) {
      const msg = String((e as Error).message).slice(0, 500);
      await record(ctx, sub, strat.id, coin, side, 0, null, false, e instanceof BrokerError ? "rejected" : "blocked", null, msg);
    }
  }
  await syncPositions(ctx);
  return { orders: ctx.orders, notes: ctx.notes };
}

async function openEntry(ctx: Ctx, sub: Row, strat: Row, coin: string, desired: "long" | "short", sig: Row, state: AccountState, risk: Row, tradeId: string) {
  const side = desired === "long" ? "buy" : "sell";
  const buy = side === "buy";
  const lev = Number(sub.leverage);
  if (!(lev > 0)) throw new Error("refusing an entry without explicit leverage");
  const pot = ctx.hl.sizingEquity(state, coin);
  if (!(pot > 0)) {
    await record(ctx, sub, strat.id, coin, side, 0, null, false, "blocked", null,
      `no collateral in the ${coin.includes(":") ? coin.split(":")[0] : "perps"} pot: move USDC there to trade ${coin}`);
    return;
  }
  const mid = await ctx.hl.mid(coin);
  let notional = pot * Number(sub.allocation_pct) * lev;
  // Fit free collateral instead of sending an order the venue refuses every pass.
  const free = Object.keys(state.pots).length ? (state.withdrawable[coin.includes(":") ? coin.split(":")[0] : ""] ?? 0) : state.equity;
  const cap = free * envNum("FREE_COLLATERAL_USE", 0.9) * lev;
  if (notional > cap) notional = cap;
  const qty = notional / mid;
  const stopPct = sig.sl_pct != null ? Number(sig.sl_pct) : (strat.stop_loss_pct != null ? Number(strat.stop_loss_pct) : null);

  // Per-order gates (entries only).
  const maxLev = ctx.hl.maxLev.get(coin) || lev;
  if (notional > pot * Math.min(lev, maxLev) + 1e-6) return void await record(ctx, sub, strat.id, coin, side, qty, mid, false, "blocked", null, "order notional exceeds the pot's leverage cap");
  const gross = state.positions.reduce((s, p) => s + p.qty * (p.mark_price ?? 0), 0) + notional;
  const maxGross = Number(risk?.max_gross_leverage ?? 3);
  if (state.equity > 0 && gross / state.equity > maxGross) {
    return void await record(ctx, sub, strat.id, coin, side, qty, mid, false, "blocked", null, `gross leverage ${(gross / state.equity).toFixed(2)}x would exceed your ${maxGross}x limit`);
  }
  if (stopPct) {
    const budget = await dailyLossBudgetUsd(ctx.acct, state.equity, risk);
    if (budget !== null && notional * stopPct / 100 > budget) {
      return void await record(ctx, sub, strat.id, coin, side, qty, mid, false, "blocked", null, "a stop-out on this entry would exceed the remaining daily loss budget");
    }
  }
  if (notional < 10) return void await record(ctx, sub, strat.id, coin, side, qty, mid, false, "blocked", null, `notional $${notional.toFixed(2)} is below the $10 venue minimum`);

  // Late join: the strategy's trade has been open for a while -> anchor to its entry, refuse if pointless.
  if (sig.entry_time && sig.entry_price && (Date.now() - Date.parse(sig.entry_time)) / 1000 > envNum("SIGNAL_ANCHOR_MIN_AGE_S", 3600)) {
    const why = lateJoinRefusal(desired, mid, Number(sig.entry_price), sig.sl_pct != null ? Number(sig.sl_pct) : null, sig.tp_pct != null ? Number(sig.tp_pct) : null);
    if (why) return void await record(ctx, sub, strat.id, coin, side, qty, mid, false, "blocked", null, why);
  }

  // Market gate (fail closed on an unreadable book).
  let quote = null;
  try { quote = quoteFromL2(await ctx.hl.l2Book(coin)); } catch (_e) { quote = null; }
  const gate = checkEntry(strat.markets?.asset_class ?? "equity", buy, notional, quote, {
    signalPrice: sig.price != null ? Number(sig.price) : null, signalTime: sig.created_at ?? sig.bar_time, stopPct,
  });
  if (gate) return void await record(ctx, sub, strat.id, coin, side, qty, mid, false, "blocked", null, gate);

  if (!ctx.live) {
    await record(ctx, sub, strat.id, coin, side, qty, mid, false, "dry_run", null, `entry_${desired}`);
    return;
  }
  const r = await ctx.hl.marketOrder(coin, buy, qty, { leverage: lev, tag: `open-${side}` });
  await record(ctx, sub, strat.id, coin, side, r.filled, r.avg_px, false, r.status, r.oid, `entry_${desired}`);
  await db().from("subscriptions").update({ last_entry_signal: tradeId }).eq("id", sub.id);
  // Protection is sized to what is actually open: read the venue position back.
  const pos = await venuePosition(ctx, coin);
  if (pos) await ensureBracket(ctx, coin, pos, sig, strat);
}

/** Side matches but the size is > tolerance over target: trim with a reduce-only order (never top up). */
async function trimOversized(ctx: Ctx, sub: Row, strat: Row, coin: string, pos: Position, state: AccountState) {
  try {
    const tol = envNum("RECONCILE_TOLERANCE_PCT", 20) / 100;
    const cooldown = envNum("RECONCILE_COOLDOWN_S", 900) * 1000;
    if (sub.last_resize_at && Date.now() - Date.parse(sub.last_resize_at) < cooldown) return;
    const mark = pos.mark_price ?? pos.entry_price;
    if (!mark) return;
    const target = ctx.hl.sizingEquity(state, coin) * Number(sub.allocation_pct) * Number(sub.leverage) / mark;
    if (!(target > 0) || pos.qty <= target * (1 + tol)) return;
    const excess = pos.qty - target;
    const side = pos.side === "long" ? "sell" : "buy";
    if (!ctx.live) {
      await record(ctx, sub, strat.id, coin, side, excess, mark, true, "dry_run", null, "trim oversized position");
    } else {
      const r = await ctx.hl.marketOrder(coin, side === "buy", excess, { reduceOnly: true, tag: "close" });
      await record(ctx, sub, strat.id, coin, side, r.filled, r.avg_px, true, r.status, r.oid, "trim oversized position");
      ctx.openOrders = null;
    }
    await db().from("subscriptions").update({ last_resize_at: now().toISOString() }).eq("id", sub.id);
  } catch (e) {
    ctx.notes.push(`trim on ${coin} failed: ${(e as Error).message}`);
  }
}

serve("execute", async () => {
  const sb = db();
  const holder = `edge:${crypto.randomUUID()}`;
  const { data: got, error: lockErr } = await sb.rpc("try_exec_lock", { p_name: LOCK, p_holder: holder, p_ttl_s: LOCK_TTL });
  if (lockErr) throw new Error(`lock: ${lockErr.message}`);
  if (!got) return { skipped: true, reason: "another executor holds the lock" };
  try {
    const { data: st } = await sb.from("system_state").select("halted").eq("id", "global").limit(1);
    const halted = !!st?.[0]?.halted;
    // Revoked accounts with the kill switch on are still visited so their positions get flattened.
    const { data: rows, error } = await sb.from("broker_accounts").select("*").in("status", ["active", "revoked"]).eq("agent_approved", true);
    if (error) throw new Error(`accounts: ${error.message}`);
    const accounts = (rows ?? []).filter((a) => a.status === "active" || a.kill_switch);
    const summary = { accounts: accounts.length, orders: 0, errors: 0, dry_run: !liveGatesOpen(), halted };
    for (const acct of accounts) {
      try {
        if (acct.last_error) await sb.from("broker_accounts").update({ last_error: null }).eq("id", acct.id);
        const r = await reconcileAccount(acct, halted);
        summary.orders += r.orders;
        if (r.notes.length) await setLastError(acct.id, r.notes.join("; "));
      } catch (e) {
        summary.errors++;
        console.error(`account ${acct.id} failed:`, e);
        await setLastError(acct.id, String((e as Error).message));
      }
    }
    await heartbeat("executor", summary);
    return summary;
  } finally {
    await sb.rpc("release_exec_lock", { p_name: LOCK, p_holder: holder });
  }
});
