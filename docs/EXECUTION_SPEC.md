# Execution specification (signal -> Hyperliquid)

Language-neutral specification of the live trading flow. The runtime implements it (Edge Functions +
pg_cron); the Python engine is the reference for signals (`engine/aether/backtest.py`, `simulate`) and
holds tested reference implementations of the pure parts (`engine/aether/execution/market_gate.py`,
`engine/aether/execution/exit_bracket.py`). Every rule below exists because its absence lost money
or left a position unprotected in production.

Schema: `broker_accounts`, `subscriptions`, `strategies`, `strategy_signals`, `orders`, `positions`,
`account_snapshots`, `user_risk`, `system_state`, `heartbeats` (migrations 0001-0006).

---

## 0. Safety invariants (never relaxed)

1. **Two live gates.** Real orders only when `DRY_RUN=false` AND `HYPERLIQUID_LIVE_CONFIRMED=true`.
   Otherwise every intended order is recorded with `status='dry_run'` and nothing is sent.
2. **Agent keys only.** Before any I/O, derive the address from the decrypted key; if it equals
   `broker_accounts.wallet_address` (a master key, which can withdraw) refuse the account.
3. **Builder code on every order** (entries, closes, stops, take-profits):
   `builder = {"b": BUILDER_ADDRESS (lower-case), "f": BUILDER_FEE_BPS10}` (tenths of a bp; 30 = 0.03%).
   The user must have approved at least that fee (`info {"type":"maxBuilderFee","user","builder"}`);
   if not, block entries for the account with a clear `last_error`.
4. **Closes are reduce-only and never gated.** No risk, market, or freshness gate may block a close,
   stop, or take-profit. Getting out is always allowed.
5. **Fail closed on entries.** Any uncertainty (unreadable venue, unreadable book, missing equity,
   risk-check exception, unknown fill state) blocks NEW entries for that pass.
6. **Never open on an unconfirmed flat.** A flip (long->short) opens the new side only after a
   read-back proves the old side is gone (section 4).
7. **Idempotent passes.** Each pass diffs desired vs actual; a missed or crashed pass self-heals on the
   next. A single-holder lock (`try_exec_lock('executor', holder, ttl 110s)` / `release_exec_lock`)
   prevents overlapping passes.

---

## 1. Desired position (signals)

For each published strategy, after each bar close, replay the strategy on closed bars
(`simulate`): rules evaluated on bar i's close, fill at bar i+1's open. The position after acting on the
LAST closed bar's decision is the desired side (`long` | `short` | `flat`). Upsert
`strategy_signals(strategy_id, bar_time, desired, price, reason)` on `(strategy_id, bar_time)`.

The same simulation produces the protective distances for the venue bracket (percent of price):
the strategy's stop/target from `stop_loss_pct`/`take_profit_pct`, ATR multiples, or the
structure anchor (see `backtest.py` docstring), decided on the signal bar and applied to the fill price.

Freshness: a signal older than 2 bars (`bar_time + 2 x timeframe < now`) may not OPEN anything; it can
only keep an existing position on the same side. Paused strategy: no new trades, keep what is open.
Disabled subscription or unpublished strategy: desired = flat.

Weekend exit (strategy option): flat at the close of any bar ending Friday 16:00 ET .. Sunday 18:00 ET.

## 2. Per-account pass (every minute)

```
lock -> read system_state.halted -> accounts (status active, or revoked with kill_switch) ->
for each account:
  clear last_error; decrypt agent key (refuse master key)
  read venue state (section 6); write account_snapshots(equity)
  if kill_switch or status != active: close every position (reduce-only), sync, next account
  entry_block = global halt | account protection (section 7) | builder fee not approved
  for each live subscription (one per coin per account):
     coin = venue coin of strategies.markets.hl_coin
     desired = section 1;  actual = venue position side or flat
     if desired == actual:
        if actual != flat: ensure protective stop + target (section 5); size check (section 4.3)
        continue
     if actual != flat: close (section 4.1); if not confirmed flat -> do NOT open; next subscription
     if desired != flat:
        if bracket just filled this position (section 5.4) -> do not re-open the same signal
        if entry_block -> record blocked, continue
        late-join check (section 8) -> blocked?
        size (section 3) -> per-order risk (section 7.2) -> market gate (section 9) -> open (section 4.2)
  sync positions table from a fresh venue read
heartbeat('executor', summary); release lock
```

Errors inside one account never stop the pass: record `broker_accounts.last_error` and continue.

## 3. Sizing and leverage

- `notional = sizing_equity(coin) x subscriptions.allocation_pct x subscriptions.leverage`;
  `qty = notional / mid`.
- **Collateral pots.** On a classic account, standard perps and the HIP-3 `xyz` dex hold SEPARATE
  collateral: size against the pot the coin trades from (`clearinghouseState` with and without
  `"dex":"xyz"`). On a unified account (`info {"type":"userAbstraction"} == "unifiedAccount"`), equity is
  spot USDC + unrealized PnL and is shared.
- **Partial reads are fatal for the pass**: if the `xyz` clearinghouse read fails, raise (a half read
  looks like a drawdown and would trip the risk halt).
- **Fit free collateral**: if notional exceeds free margin x 0.9 x exchange leverage, shrink the order to
  fit instead of sending one the venue will refuse every pass.
- **Leverage convergence**: leverage is persistent venue state. Immediately before EVERY entry call
  `updateLeverage(min(int(requested), venue maxLeverage), coin, isCross=false)` (isolated) and fail
  closed if it is rejected. Refuse an entry with no explicit leverage. Never on reduce-only orders.
- Minimum notional $10 for entries (reduce-only closes are exempt).
- Rounding: size to `szDecimals`; price to 5 significant figures and at most `6 - szDecimals` decimals.

## 4. Orders

### 4.1 Close (reduce-only, never gated)
1. Cancel this coin's resting protective orders (only ours, by tag, section 5.2).
2. IOC limit at mid x (1 +/- slippage, default 0.5%), `reduce_only=true`, builder code.
3. **Read the position back.** Flat when residual qty is 0 or residual notional < $1.
   - flat: record `filled`, book realized PnL, cancel remaining protection;
   - residual: record `partial` with the residual in the reason, alert, and DO NOT open the other side;
     retry the close next pass (book the realized trade once, when finally flat);
   - venue unreadable after the close: record as error; same no-open rule.

### 4.2 Open (entry)
IOC limit at mid x (1 +/- slippage), `reduce_only=false`, explicit leverage (section 3), builder code.
Fill outcome:
- filled >= 99.9% of size: `filled`;
- 0 < filled < 99.9%: `partial` -- a real position of the filled size; protection is sized to what is
  actually open (section 5 reads the venue size, never the requested size);
- no fill: error "IOC got no fill" (slippage bound too tight); retried next pass.
Then place the bracket (section 5).

### 4.3 Size reconciliation (side already matches)
Compare the venue size with the target size. Tolerance 20%; at most one resize per 15 minutes per
subscription. Default mode `trim`: reduce an oversized position with a reduce-only order, never top up an
undersized one (report it). After a resize, re-read the position before touching protection.

### 4.4 Client order ids (idempotency)
`cloid = 0x + md5("{wallet}|{coin}|{tag}|{floor(unix/60)}")`, tag in `open-{buy|sell}`, `close`,
`stop-sl-{long|short}`, `stop-tp-{long|short}`. The venue de-duplicates a cloid, so a retried or doubled
pass within the same minute cannot double an order; SL and TP use different tags so one never clobbers
the other.

### 4.5 Recording
Every intent produces one `orders` row: `status` in filled | partial | rejected | dry_run (plus `blocked`
for gated entries once the status check allows it), `reduce_only`, `qty`, `price` (avg fill), broker id,
`builder_fee_bps10`, `error`/reason. De-duplicate repeated blocked rows: same subscription + same reason +
same qty within the pass cadence = do not insert again.

## 5. Venue-resident exit bracket

The bracket protects the user when our workers are down. It is placed after every entry AND verified on
every pass (restart recovery).

### 5.1 Orders
- Stop: trigger order `{"trigger":{"triggerPx":T,"isMarket":true,"tpsl":"sl"}}`, `reduce_only=true`,
  side opposite to the position, size = CURRENT venue size, limit bound 5% through the trigger
  (a fill guarantee, not a cap), builder code.
- Target: same with `"tpsl":"tp"`.
- Levels: `T_sl = fill x (1 -/+ sl_pct/100)`, `T_tp = fill x (1 +/- tp_pct/100)` using the signal's
  distances; clamp each distance to [0.1%, 50%].
- If the strategy declares no stop, place a catastrophe stop: 1.5 x the strategy's declared stop if any,
  else 15%, clamped to [3%, 25%].
- Exit rules referencing `entry_price` (e.g. `low <= entry_price * 0.97 or high >= entry_price * 1.05`)
  are converted to venue levels by `exit_bracket.parse_exit_bracket(rule, side)`: static tier (entry
  multiples) always; ATR tier re-resolved each pass from the live ATR; dynamic tier (price-valued
  indicators) only if explicitly enabled. Oscillator thresholds are never converted.

### 5.2 Tags
Our protective orders carry a recognisable cloid prefix (fixed 8-hex magic + 12-hex tag token), so a
listing can tell OUR orders from orders the user placed by hand. Only tagged orders are ever cancelled or
replaced. List with `frontendOpenOrders` for both the standard and the `xyz` dex (separate books);
an open order is a stop when `reduceOnly` and `triggerPx` are set; a TP when `orderType` starts with
"Take".

### 5.3 Maintenance (every pass, position open)
- Missing stop -> place.
- Stop size differs from the venue size by > 5% (partial fill, resize) -> replace.
- Level drifted > 0.25% from the wanted level (ATR/dynamic tiers) -> replace.
- Replace = cancel then place; if the new placement is refused, retry once after a short pause; if still
  refused, re-place the previous stop at its old level and alert. A replace must never end with no stop.
- A stop at or beyond the isolated liquidation distance (~100/leverage %, x0.9) cannot protect: alert.
- If the wanted stop is already through the mark, park it at the minimum distance (0.1%) and alert --
  the position should be exiting.

### 5.4 Bracket fill detection
When desired != flat but the venue is flat, first check whether one of our bracket orders filled since
the last pass (user fills / order status). If so: book the realized trade, cancel the sibling leg, and
suppress re-entry on the SAME signal (store the signal's `bar_time` of entry on the subscription or in a
side table). A new entry needs a new signal. Re-entering the same signal re-opens straight into the
level that just stopped it out (observed: three full round trips in 24 minutes).

## 6. Venue reads (Hyperliquid, HIP-3)

- US equities and commodities trade on the HIP-3 builder dex `xyz` (`xyz:NVDA`, `xyz:GOLD`). The SDK /
  signer must be constructed with `perp_dexs=["", "xyz"]` to resolve those names to asset ids
  (asset id offset 110000 for builder dexes).
- `meta` with and without `"dex":"xyz"` gives `szDecimals` and `maxLeverage`.
- Mid: `allMids` with `"dex":"xyz"` for HIP-3 coins.
- Symbol resolution: `dex:COIN` as given if listed; bare name if a standard perp; else `xyz:` + alias
  (`XAU->GOLD`, `XAG->SILVER`, `WTI/USOIL->CL`, `BRENT->BRENTOIL`). Unknown -> refuse.
- Venue map: when a ticker exists on several dexes prefer standard perps, then `xyz`, then the dex with
  the highest 24h notional volume; never route to a delisted market (`isDelisted`). Re-check the `markets`
  table against the live universe daily (`engine/scripts/sync_markets.py`) and deactivate delisted coins.
- Positions: `assetPositions[].position` (`szi` signed size, `entryPx`, `positionValue`, `unrealizedPnl`);
  read both dexes.

## 7. Account protection

### 7.1 Account gates (block entries; closes always allowed)
- trading disabled by the user (`user_risk.trading_enabled=false`);
- daily loss: equity vs the first snapshot of the last 24h <= -`max_daily_loss_pct` (default 5);
- drawdown: equity vs the 30-day equity peak <= -`max_drawdown_pct` (default 20);
- optional rolling 7-day loss vs the best day-start equity of the week;
- kill switch / revoked account: flatten everything (reduce-only) and stop.

### 7.2 Per-order gate (entries only)
- `notional <= pot equity x leverage cap` (and `user_risk.max_gross_leverage` on the account's summed
  open notional);
- non-positive equity or an empty collateral pot -> block with a message telling the user to move USDC
  to the right pot;
- post-fill headroom: `notional x stop_pct` must fit the remaining daily loss budget;
- any exception -> block (fail closed).

## 8. Late-join rule

A user who subscribes (or an entry that was blocked and is retried) while the strategy's position has
already been open for more than 1 hour joins LATE. Anchor the bracket to the strategy's own entry price
(the simulated trade's entry), not the live fill. Refuse the join when, at the current price:
- the anchored stop or target is already through the price, or
- the room left to the stop or target is less than max(0.1% for the stop, 25% of the strategy trade's own
  distance to that level).
Otherwise the join is pointless (it can only buy a stop-out or the fees) and loops entry/stop-out.
A fresh signal (< 1 hour) anchors to the live fill and is never refused here.

## 9. Market gate (entries only)

Read `l2Book` for the coin (20 levels a side). Refuse the entry (record `blocked`, retry next pass) when:

| check | rule (defaults) |
|---|---|
| quote age | book `time` older than 5 s |
| two-sided | bid <= 0, ask <= 0, or ask < bid |
| spread | (ask - bid)/mid > 10 bp (equity, commodity, index); 15 bp crypto |
| depth | resting notional within 10 bp of mid on the side we take (asks for a buy) < 10 x order notional |
| basis | |mark/index - 1| > 25 bp when both are known (l2Book has neither: skipped) |
| chase | signal younger than 1 h and price already ran > 0.5 x stop distance past the signal price in the trade's direction |

An unreadable book blocks (fail closed). Reference implementation and tests:
`engine/aether/execution/market_gate.py`, `engine/tests/test_market_gate.py`.

## 10. Positions sync and fees

- After each account: replace `positions` rows for the account from a fresh venue read.
- Builder-fee ledger: hourly, read the user's fills, sum `builderFee` per fill into the fee table
  (`engine/aether/fees.py` is the reference).

## 11. Configuration summary

| name | default | meaning |
|---|---|---|
| DRY_RUN / HYPERLIQUID_LIVE_CONFIRMED | true / false | live gates |
| HYPERLIQUID_SLIPPAGE | 0.005 | IOC bound |
| BUILDER_ADDRESS / BUILDER_FEE_BPS10 | - / 30 | revenue |
| SIGNAL_MAX_AGE | 2 bars | freshness for entries |
| CLOSE_RESIDUAL_USD | 1.0 | flat threshold after a close |
| RECONCILE_TOLERANCE_PCT / COOLDOWN_S / mode | 20 / 900 / trim | size reconciliation |
| VENUE_STOP_MULT / MIN / MAX / DEFAULT | 1.5 / 3 / 25 / 15 % | catastrophe stop |
| BRACKET_MIN / MAX_PCT | 0.1 / 50 % | strategy bracket clamp |
| BRACKET_QTY_TOLERANCE_PCT / PRICE_TOLERANCE_PCT | 5 / 0.25 % | replace thresholds |
| STOP_FILL_SLIPPAGE | 5 % | trigger fill bound |
| FREE_COLLATERAL_USE | 0.9 | entry fit |
| MARKET_GATE_* | see section 9 | entry gate |
| SIGNAL_ANCHOR_MIN_AGE_S | 3600 | late-join / chase boundary |
| LATE_JOIN_MIN_ROOM_FRAC | 0.25 | late-join room |
