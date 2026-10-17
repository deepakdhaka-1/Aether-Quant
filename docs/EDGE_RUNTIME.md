# Edge runtime

Everything that runs live (data, indicators, signals, orders, fees, alerts) is a Supabase Edge
Function (Deno/TypeScript) on project `slkrvhpvflfweoetxfki`, triggered by `pg_cron`. The Python
`engine/` is only for research and backtesting; nothing live depends on it.

## Functions

| Function | Schedule (UTC) | Does |
|---|---|---|
| `ingest` | `1 * * * *` (1 min after each hour) | Fetch closed candles (CoinGlass for US equities, Hyperliquid candles for commodities/index, fallback to Hyperliquid), compute indicators, upsert the indicator tables (`<SYMBOL>_<1H\|4H>_TAAPI_Indicator_snapshot`) |
| `signals` | `3 * * * *` | For every `published` strategy: evaluate its rules on the latest bars (same semantics as the Python backtester), write `strategy_signals`, pause strategies whose rules don't compile |
| `execute` | `* * * * *` | Per active broker account: decrypt agent key, risk gates, desired-vs-actual reconcile, market gate, late-join check, orders with builder fee, venue stop/take-profit brackets, record orders/positions/snapshots |
| `fees` | `7 * * * *` | Builder-fee revenue ledger (`builder_fees`) from user fills |
| `monitor` | `*/5 * * * *` | Heartbeats, stale signals, broker errors, rejection rates, drawdown vs limits, divergence; alerts via Telegram/webhook (de-duplicated) |
| `market-candles` | `10 0 * * *` | 30 daily candles per market for the landing-page charts (`market_candles`) |
| daily prune | `17 3 * * *` | `prune_account_snapshots` (SQL, no function) |

Cron jobs call functions through `public.aether_invoke(fn)`, which reads the project URL and
`aether_cron_secret` from Supabase **Vault** and sends it as `x-cron-secret`. Every function checks
that header (or the service-role key) with `authorize()` in `_shared/db.ts`; nothing is callable
anonymously. Schedules live in `supabase/migrations/0008_cron.sql` and `0009`/`0010`.

## Shared code (`supabase/functions/_shared/`)

| File | Contents |
|---|---|
| `candles.ts` | OHLCV sources (CoinGlass, Hyperliquid), closed bars only |
| `indicators.ts` | ~130 indicator columns (`EDGE_COLUMNS`), matched to the Python engine |
| `rules.ts` | Safe rule parser/evaluator (no `eval`), same dialect as `engine/aether/rules.py` |
| `backtest.ts` | Bar simulation shared by signals (fill next open, stops, flips) |
| `gates.ts` | Market gate (spread/depth), late-join refusal, bracket percentages |
| `hyperliquid.ts` | Info + exchange client, EIP-712/L1 signing, HIP-3 asset ids, builder field, live gates |
| `crypto.ts` | AES-256-GCM agent-key envelope (same format as `web/lib/crypto.ts`) |
| `db.ts`, `env.ts` | Service client, auth check, heartbeats, env helpers |

Parity tests (`supabase/functions/tests/`) check indicators and positions against golden files
made by the Python engine (`engine/fixtures/`), and order signatures against the official
Hyperliquid Python SDK.

## Secrets (`npx supabase secrets set NAME=value`)

| Secret | Purpose |
|---|---|
| `API_ENCRYPTION_KEY` | Decrypts users' agent keys. Same 32-byte base64 value as the web app. Keep it outside the database. |
| `CRON_SECRET` | Must equal Vault `aether_cron_secret` |
| `DRY_RUN` | `true` = record intended orders only (**default**) |
| `HYPERLIQUID_LIVE_CONFIRMED` | Second live gate, default `false` |
| `BUILDER_ADDRESS`, `BUILDER_FEE_BPS10` | Revenue wallet; fee in tenths of a bp (30 = 0.03%) |
| `HYPERLIQUID_API_URL` | Mainnet by default |
| `COINGLASS_BASE_URL`, `COINGLASS_API_KEY` | Optional; the endpoint used needs no key |
| `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_IDS`, `MONITOR_WEBHOOK_URL`, `MONITOR_PING_URL`, `MONITOR_ENV_LABEL` | Monitor alerts (optional) |

`SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are provided automatically.

## Deploy

```powershell
$env:SUPABASE_ACCESS_TOKEN = '<personal access token>'      # never commit it
npx supabase functions deploy ingest signals execute fees monitor market-candles
npx supabase db query --linked -f supabase/migrations/00NN_name.sql   # new migrations
```

The migrations were applied through the Management API, so the CLI's migration history does not
list them; run `npx supabase migration repair --status applied <versions>` before any `db push`.

## Going live

1. Builder wallet: set `BUILDER_ADDRESS`, fund it with ≥ 100 USDC in perps.
2. Confirm builder fees apply on HIP-3 `xyz` markets with one small order (check `builderFee` on the fill).
3. Publish a strategy, connect one test account, watch `execute` in dry run (`orders.status = 'dry_run'`).
4. Testnet if possible, then mainnet with a small allocation.
5. Flip **both** `DRY_RUN=false` and `HYPERLIQUID_LIVE_CONFIRMED=true`, redeploy `execute`.

Stop everything: set `system_state.halted = true` (global) or `broker_accounts.kill_switch = true`
(one account, flattens it). See [OPERATIONS.md](OPERATIONS.md).

## Known limits

- CoinGlass serves ~4 months of 1h US-equity history; 4h and commodities have more.
- Edge computes ~130 of the ~145 research columns; strategies using others get paused with a reason.
- Edge Functions have per-invocation CPU/time limits; ingest runs per market and bar to stay within them.
