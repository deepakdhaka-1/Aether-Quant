# Aether Quant: Operations runbook

## 1. Architecture

```
                 users (browser + wallet)
                          |
                   Next.js web (Vercel)  ---- /admin/ops (admins only)
                          | anon key + RLS          | admin session (RLS is_admin)
                          v                         v
   +------------------------- Supabase (Postgres) -------------------------+
   | strategies  strategy_signals  subscriptions  broker_accounts (enc key) |
   | orders  positions  account_snapshots  builder_fees  user_risk          |
   | system_state(halt)  exec_lock(lease)  heartbeats(signals/executor/...) |
   +------------------------------------------------------------------------+
        ^ service role         ^ service role        ^ service role
        |                      |                     |
  aether-signals         aether-executor        aether-monitor ---> Telegram / webhook
  1,16,31,46 * * * *     * * * * * (lease 110s)  */5 * * * *  ---> MONITOR_PING_URL (dead-man)
        |                      |
        |  candles             |  orders (agent key, builder code, IOC + native stops)
        v                      v
            Hyperliquid  (HIP-3 dex "xyz": equities, commodities)
  aether-fees (hourly) -> builder_fees      aether-prune (daily 03:17 UTC) -> prune_account_snapshots(30)
  aether-api (uvicorn aether.api:app): backtests / generation for the web app, private
```

Runners: Cloud Run Jobs + Scheduler (`deploy/cloudrun.sh`), one VM with docker compose
(`deploy/docker-compose.yml` + `deploy/scheduler.py` + `deploy/crontab`), or Windows Task Scheduler
for local runs (`deploy/windows_tasks.ps1`). The image is `deploy/engine.Dockerfile` (context `engine/`).
It contains no secrets.

## 2. Environment variables

| Var | Where | Notes |
|---|---|---|
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | engine | service role: server only, Secret Manager `aether-supabase-service-key` |
| `AETHER_ENCRYPTION_KEY` | engine + web | 32 bytes base64, must be the SAME in both. Secret `aether-encryption-key` |
| `ENGINE_API_TOKEN` | engine + web | bearer for the engine API. Secret `aether-engine-api-token` |
| `BUILDER_ADDRESS`, `BUILDER_FEE_BPS10` | engine (+ `NEXT_PUBLIC_BUILDER_*` web) | revenue wallet and fee (30 = 0.03 %) |
| `HIP3_DEX`, `HYPERLIQUID_API_URL`, `HYPERLIQUID_SLIPPAGE` | engine | venue |
| `DRY_RUN` (default true), `HYPERLIQUID_LIVE_CONFIRMED` (default false) | engine | the two live gates |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_IDS` | monitor | optional; comma list. Secret `aether-telegram-bot-token` |
| `MONITOR_WEBHOOK_URL`, `MONITOR_PING_URL`, `MONITOR_ALERT_COOLDOWN_S`, `MONITOR_ENV_LABEL` | monitor | see `engine/.env.monitor.example` |

`gcloud run jobs deploy --set-env-vars` replaces the full set. Change env only by editing and
re-running `deploy/cloudrun.sh`, never in the console, or the next deploy silently drops it.

## 3. Go-live checklist (in order, verify each)

1. **Secrets** created in Secret Manager (header of `deploy/cloudrun.sh`). Nothing in git or images.
2. **DB**: migrations applied; `select try_exec_lock('probe','x',5)` returns true (then `select release_exec_lock('probe','x')`).
3. **DRY_RUN deploy**: `PROJECT=.. SUPABASE_URL=.. ./deploy/cloudrun.sh`. Run each job once (`gcloud run jobs execute aether-executor --wait`).
   `/admin/ops` shows executor, signals and monitor green, findings all clear, executor detail says `DRY`.
4. **Alerts**: halt from `/admin/ops`, wait 5 min, confirm a Telegram `[WARN] GLOBAL HALT` arrives and that a
   `[RESOLVED]` arrives after resuming. Point `MONITOR_PING_URL` at healthchecks.io (or similar) so a dead monitor alerts too.
5. **Testnet**: one internal account with `network=testnet`, both gates on, small allocation. Watch a full
   signal cycle: open, native stop placed, close. Orders show `filled`, no rejections, positions match signals (no divergence findings).
6. **Mainnet small**: `GO_LIVE=yes ./deploy/cloudrun.sh` (types LIVE to confirm; sets `DRY_RUN=false` and
   `HYPERLIQUID_LIVE_CONFIRMED=true`). One founder account, $100 to $500, 1x leverage, 48 h of observation. Check the
   builder fee lands in `builder_fees` and the 24 h revenue tile moves.
7. **Scale**: open to users in waves; watch rejection rate, divergence and drawdown findings after each wave.

Rollback at any step: global halt (below), or pause the schedulers, or redeploy without `GO_LIVE` (back to DRY_RUN).

## 4. Procedures

### Halt globally
`/admin/ops` -> "Halt all trading" (a reason is required). Or SQL:
`update system_state set halted = true, note = '<why>' where id = 'global';`
Halt blocks NEW entries for every account. Closes, stops and kill switches still run. To stop the engine
entirely: `for j in executor signals monitor fees prune; do gcloud scheduler jobs pause aether-$j-tick --location $REGION; done`.
Pausing the executor also stops closes, so prefer the halt.

### Kill-switch one user
`update broker_accounts set kill_switch = true where id = '<id>';` (users can also flip their own). On the next
pass (<= 1 min) the executor cancels stops, flattens every position reduce-only, and does nothing else for that account.
Confirm on `/admin/ops` (Kill = ON, equity, no positions) and on Hyperliquid. The user's own wallet can always revoke
the agent at app.hyperliquid.xyz/API, which is the hard stop.

### Rotate the encryption key (re-encrypt agent secrets)
Envelopes are `v1.<iv>.<ct>.<tag>` (AES-256-GCM), with no key id, so rotation is a stop-the-world re-encrypt:
1. Halt globally and pause `aether-executor-tick` (nothing may decrypt mid-rotation).
2. Generate the new key: `python -c "import os,base64;print(base64.b64encode(os.urandom(32)).decode())"` (do not paste it into chat or logs).
3. Run a one-off script with `OLD_KEY` and `NEW_KEY` in env, using the service role: for each `broker_accounts` row,
   `decrypt` with the old key and `encrypt` with the new key (same functions as `engine/aether/crypto.py`), and update
   `agent_secret_enc` in one transaction per row. Verify every row decrypts with the NEW key before continuing.
4. `gcloud secrets versions add aether-encryption-key --data-file=-` and update the web's `AETHER_ENCRYPTION_KEY`, then redeploy web.
5. Resume the executor and un-halt. Watch for `last_error` findings (decrypt failures). Destroy the old secret version.
If the key leaked, rotating it is not enough: agent keys may be exposed. Have users re-connect (new agent, approveAgent)
and revoke the old agents.

### Rotate the builder wallet
1. New wallet (hardware or multisig). Users must `approveBuilderFee` for the NEW address, since approvals are per builder.
2. Ship web with the new `NEXT_PUBLIC_BUILDER_ADDRESS` and re-prompt users. Set `builder_approved=false` for unapproved accounts.
3. Set `BUILDER_ADDRESS` in `deploy/cloudrun.sh` and redeploy. Orders whose builder is not approved are rejected, which the
   rejection-rate alert catches. Roll out after most users have re-approved, or keep the old address until then.
4. Sweep fees from the old wallet.

### Add a market
1. Confirm the coin is listed on the `xyz` dex (Hyperliquid `meta` for dex `xyz`) and check its max leverage.
2. `insert into markets (symbol, name, asset_class, hl_coin, max_leverage) values ('AMD','AMD','equity','xyz:AMD', 10);`
3. Generate and backtest strategies for it (`python -m aether.cli generate AMD 1h`). The engine deactivates markets the venue delists.

### Publish or retire a strategy
- Publish: from the admin UI, or `update strategies set status='published', published_at=now() where slug='..'`.
  The next signals run writes its first signal. `/admin/ops` signal freshness should show it within 15 min.
- Pause (`status='paused'`): keeps open positions, no new trades, no new subscriptions.
- Retire (`status='retired'`): the executor closes positions for live subscribers on the next pass (desired = flat).
  Tell subscribers first.

## 5. Responding to monitor alerts

The monitor runs every 5 min, writes all findings to `heartbeats['monitor'].detail`, and alerts crit/warn. The same
finding key is not re-sent for 30 min (`MONITOR_ALERT_COOLDOWN_S`). When it clears, one `[RESOLVED] <key>` is sent.
If delivery fails, the finding is retried on the next run.

| Finding (key) | Meaning | Do |
|---|---|---|
| `heartbeat:executor` (crit, >5 min) | executor not completing passes | Check `gcloud run jobs executions list --job aether-executor`, logs, and the scheduler. A stuck lease self-heals after 110 s. With no executor, only native venue stops protect positions. |
| `heartbeat:signals` (crit, >20 min) | signal runner down | Check job logs and Hyperliquid candle API. Entries stop after 2 bars; positions are held. |
| `heartbeat:fees` (warn) | fee sync stale | Revenue only; check the job. |
| `executor:errors` | some accounts failed last pass | See the account's `last_error`. |
| `signal_stale:<strategy>` | no signal for > 2 bars | Per-strategy data issue (market delisted or halted, candle gaps). Pause the strategy if persistent. |
| `acct_status:<id>` (crit) | account in error | Read `last_error`. Usually the agent was revoked or the key failed to decrypt. Contact the user to reconnect. |
| `acct_error:<id>:<hash>` (warn) | last_error set | Insufficient margin, below min size, or venue error. Fix or kill-switch. |
| `reject_rate:<id>` / `reject_rate:global` (crit) | >=50 % of an account's (>=3) orders or >=20 % of all (>=5) rejected in 1 h | Global: venue outage, builder not approved, or a bad deploy. Halt, then investigate. Account: margin, leverage, or builder approval. |
| `partial:<id>:<coins>` (warn) | partial fill in 1 h | Thin liquidity. The executor diffs side only, so the position stays under-sized. Check size versus book depth. |
| `daily_loss:<id>:warn/crit` | 24 h loss at >=80 %/100 % of `user_risk.max_daily_loss_pct` | At crit the executor already blocks entries. Check it is not a bug, and inform the user. |
| `drawdown:<id>:warn/crit` | drawdown from 30-day peak versus `max_drawdown_pct` | The executor does not enforce this yet. At crit, set the kill switch (or confirm with the user). |
| `divergence:<sub>:<desired>` | position does not match a fresh signal for > 2 executor passes | crit = should be flat but is not (failed close): act now and close by hand if needed. warn = entry not taken (risk block, rejection, user disabled). Check orders for that account. |
| `system:halted` (warn) | global halt on | Expected during incidents. Re-sent every 30 min as a reminder. |
| `monitor_load:*` / `monitor_check_failed:*` | monitor could not read or evaluate | Schema drift or permissions. The other checks still ran. |
| `revenue:24h` (info) | builder fees in the last 24 h | Dashboard only. |

If no alerts arrive at all, check the dead-man ping (`MONITOR_PING_URL`) and the `monitor` heartbeat card on `/admin/ops`.

## 6. Operating lessons

- **Exposed admin ports get owned.** The previous VM was suspended for crypto-mining after an n8n port (`:5678`) was left
  public. Here the compose API binds `127.0.0.1` only, the Cloud Run API is IAM-private by default, there is no SSH
  surface on Cloud Run, and no admin UI is public. Everything that touched a compromised host gets rotated: agent keys,
  service-role key, bot token.
- **Rotate keys before go-live, and know the procedure** (section 4). Secrets live only in Secret Manager or `deploy/.env`
  (chmod 600), never in images, scripts or git. Revoke a leaked Telegram token with @BotFather `/revoke`.
- **Native venue stops.** A bridge that polls stops instead, so when the host died a short bled for 13 h. Aether places a
  native reduce-only trigger stop on Hyperliquid with each entry (`place_stop`) and cancels it on close, so stops hold even
  when every job is down. Keep it that way. A strategy without `stop_loss_pct` has no gap protection.
- **Lease lock, not advisory lock.** `exec_lock` with a 110 s TTL works over PostgREST. Keep the job timeout (100 s) under the TTL.
- **`--max-retries 0`**: a failed pass is not retried; the next minute's pass reconciles idempotently.
- **`--set-env-vars` replaces everything.** Keep the deploy script as the single source of truth.
- **Telegram group ids change** when a group becomes a supergroup (`-100...`), and alerts then stop silently. Use the
  dead-man ping and check the RESOLVED messages.
