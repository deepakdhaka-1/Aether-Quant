# Pushing strategies

Strategies go straight into the `strategies` table in Supabase (SQL editor or Table Editor). There is
no admin screen in the loop. The signal runner (every 15 min) picks up anything with
`status = 'published'`:

1. **Validates the rules** against the real indicator columns. A typo or forbidden syntax sets the
   strategy to `paused` and writes the reason to `generation_meta.error`. Fix it, then set it back
   to `published`.
2. **Backfills a backtest** (last 5000 bars from Hyperliquid) if `headline_metrics` is empty, so
   the marketplace card and detail page show real numbers. To recompute after editing the rules,
   set `headline_metrics = '{}'`.
3. **Writes the live signal** (`strategy_signals`), which the executor trades for followers.

## Template

```sql
insert into strategies
  (slug, name, description, symbol, timeframe, direction,
   entry_long, exit_long, entry_short, exit_short,
   stop_loss_pct, take_profit_pct, default_leverage, risk_level,
   status, source, model_name, published_at)
values
  ('nvda-1h-rsi-revert-v1',                         -- unique, url-safe
   'NVDA RSI Reversion',
   'Buys short-term oversold dips in an uptrend; exits on mean reversion.',
   'NVDA',                                          -- must exist in markets.symbol
   '1h',                                            -- 15m | 1h | 4h | 1d
   'long',                                          -- long | short | both
   'rsi_value < 30 and close > ema_value',          -- entry_long
   'rsi_value > 55',                                -- exit_long
   null, null,                                      -- entry_short, exit_short
   3,                                               -- stop_loss_pct (also placed as a venue stop)
   null,                                            -- take_profit_pct
   2,                                               -- default_leverage (1-10)
   'medium',                                        -- low | medium | high
   'published', 'offline_model', 'my-local-model', now());
```

Push as `status = 'draft'` first if you want to see the backtest before users can follow. Drafts
are skipped by the runner, so either compute it yourself (`python -m aether.cli backtest-csv`) or
publish, then check `headline_metrics` after the next pass.

## Markets

`select symbol, name, asset_class, hl_coin, max_leverage from markets where active;`

To add a market: insert a row with `hl_coin` as listed on the `xyz` dex (e.g. `xyz:AMD`), or run
`engine/.venv/Scripts/python engine/scripts/sync_markets.py --add-new --apply`.

## Rule language

- Comparisons joined with `and` / `or` / `not` (or `AND`/`OR`/`NOT`), `+ - * /`, numbers,
  `abs()`, `min(a, b)`, `max(a, b)`.
- `X crosses above Y`, `X crosses below Y`.
- `column_prev` = the previous bar, `column_prev3` = 3 bars back.
- Rules are evaluated on the close of each bar and fill at the next bar's open.

Columns: `open high low close volume price_value price_change rsi_value stoch_K stoch_D
stochrsi_FastK stochrsi_FastD cci_value mom_value roc_value willr_value fisher_fisher
fisher_fisher_signal ema_value dema_value macdext_MACD macdext_MACDSignal macdext_MACDHist
dmi_plusdi dmi_minusdi dmi_adx adx_value aroon_AroonUp aroon_AroonDown aroonosc_value
supertrend_value atr_value natr_value bbands_UpperBand bbands_MiddleBand bbands_LowerBand
bbw_value chop_value obv_value cmf_value mfi_value vosc_value vwap_value volume_value`.
The built-in indicator engine (`engine/aether/ta/engine.py`) adds ~140 columns in total; the full list is in `docs/INDICATOR_TABLES.md`. Rules can use any of them (names are case-insensitive), plus the research dialect: `historical[n].x`, `x.diff() > 0`, labels, `entry_price` in exit rules, and TP/SL text such as `SL 1.5 * atr_value` or `TP: 3%`.

## Lifecycle

| status | effect |
|---|---|
| `draft` / `backtested` | hidden from users, no signals |
| `published` | listed, followable, traded |
| `paused` | listed, no new follows, no new entries; open positions are kept until you publish or retire |
| `retired` | hidden; followers' positions are closed on the next executor pass |
