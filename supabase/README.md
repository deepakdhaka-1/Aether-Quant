# Supabase (project `slkrvhpvflfweoetxfki`)

Migrations are applied in order and must never be edited once applied; add a new numbered file.

| File | Purpose |
|---|---|
| `0001_init.sql` | Base schema, RLS, column grants on `broker_accounts` |
| `0002_security_hardening.sql` | Grant cleanup, wallet-squatting fix, profile/subscription integrity, risk bounds, policy rewrite |
| `0003_indexes_updated_at.sql` | FK / hot-query indexes, `updated_at` triggers |
| `0004_leaderboard_portfolio_revenue.sql` | `strategy_leaderboard()`, `my_portfolio_summary()`, `revenue_daily`, `prune_account_snapshots()` |
| `0009_market_candles.sql` | Public 1d OHLCV cache and daily Edge Function schedule |

## Client contract
- `broker_accounts`: never `select('*')`; list columns explicitly. `agent_secret_enc` is not granted to
  any client role (admins included); only the service role reads it. Clients may update `kill_switch` only.
- `profiles`: clients may update `username` only. `role`, `wallet_address`, `email`, `referral_code` are server-owned.
- `subscriptions`: `user_id`, `strategy_id`, `broker_account_id` are immutable; delete and re-create to change them.
- `orders`, `positions`, `account_snapshots`, `builder_fees`, `strategy_signals`, `heartbeats`: written by the engine (service role) only.
- `wallet_nonces`, `exec_lock`: service role only.
- RPCs: `strategy_leaderboard()` (anon + authenticated), `my_portfolio_summary()` (authenticated),
  view `revenue_daily` (admins; others get zero rows).
- Wallet sign-in: a profile's `wallet_address` is taken from `app_metadata.wallet_address`, or from
  `user_metadata.wallet_address` only when the email is `<wallet>@wallet.aetherquant.local`.

## Retention
`select public.prune_account_snapshots(30);` daily (pg_cron or engine job) keeps 30 days at full
resolution and one snapshot per account per UTC day after that.

## Make an admin
```
psql "$SUPABASE_DB_URL" -v email='you@example.com' -f supabase/seed/make_admin.sql
```
The user must have signed in once. In the SQL editor, replace `:'email'` with a quoted literal.

## Types
`web/lib/database.types.ts` is generated from the Management API
(`GET /v1/projects/{ref}/types/typescript`) or `supabase gen types typescript --project-id slkrvhpvflfweoetxfki`.
Regenerate after each migration.
