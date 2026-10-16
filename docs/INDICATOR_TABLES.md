# Indicator snapshot tables (contract)

The indicators database strategies are designed from. One table per market x timeframe, created by
`supabase/migrations/0007_indicator_snapshots.sql` for every active market x {1h, 4h}. Any writer
(the Python `ingest` command today, the Edge ingest later) must follow this contract exactly.

## Naming

`<SYMBOL>_<TOKEN>_TAAPI_Indicator_snapshot` -- SYMBOL = `markets.symbol` upper-case, TOKEN:

| timeframe | TOKEN | label column |
|---|---|---|
| 1h | `1H` | `price_after_1_h` |
| 4h | `4H` | `price_after_4_h` |
| 15m / 5m / 1d (not created yet) | `15min` / `5min` / `1D` | `price_after_15_min` / `price_after_5_min` / `price_after_1_d` |

SQL helpers: `aether_snapshot_table_name(symbol, tf)` and `aether_create_snapshot_table(symbol, tf)`
(service role only; idempotent). A new market: `select aether_create_snapshot_table('AMD','1h');`.
The identifiers are mixed-case: always double-quote them in SQL (`"NVDA_1H_TAAPI_Indicator_snapshot"`).

## Columns

| column | type | meaning |
|---|---|---|
| `id` | bigint identity | surrogate key |
| `timestamp` | bigint, UNIQUE | **bar OPEN time, epoch SECONDS (UTC)**. Upsert key (`on_conflict=timestamp`) |
| `ts_utc` | timestamptz, generated | `to_timestamp("timestamp")` |
| `timestampHuman` | text | `YYYY-MM-DD HH:MM UTC` |
| `open` `high` `low` `close` `volume` | double | the bar |
| `price_value` | double | = close |
| `price_change` | double | **backward** % change: `100 * (close / close[-1] - 1)` |
| `price_after_<tf>` | double | LABEL: the NEXT bar's close; NULL until that bar has closed. Research only, never a live rule input |
| indicator columns (below) | double (text for `supertrend_Advice`, `rvgi_trend`) | engine output, exact engine names, camelCase kept |
| `bar_et_hour` | smallint | equities on 1h: bar-open hour in America/New_York |
| `is_final_rth_bar` | smallint | equities on 1h: 1 on the 15:00 ET bar (early-close days are not detected yet) |
| `funding_rate`, `funding_rate_annualized`, `open_interest`, `open_interest_value` | double | reserved, NULL today |
| `source` | text | `coinglass` or `hyperliquid` -- where the OHLCV came from |
| `created_at`, `updated_at` | timestamptz | write bookkeeping (writers set `updated_at`) |

Indicator columns (engine names, 137): `rsi_value`, `stoch_K`, `stoch_D`, `stochf_FastK`, `stochf_FastD`, `stochrsi_FastK`, `stochrsi_FastD`, `cci_value`, `mom_value`, `roc_value`, `ppo_value`, `apo_value`, `trix_value`, `kdj_K`, `kdj_D`, `kdj_J`, `cmo_value`, `ema_value`, `dema_value`, `zlema_value`, `hma_value`, `kama_value`, `macdext_MACD`, `macdext_MACDSignal`, `macdext_MACDHist`, `supertrend_value`, `supertrend_Advice`, `ht_trendline_value`, `ht_trendmode_value`, `psar_value`, `aroon_AroonDown`, `aroon_AroonUp`, `aroonosc_value`, `dpo_value`, `atr_value`, `natr_value`, `bbands_UpperBand`, `bbands_MiddleBand`, `bbands_LowerBand`, `bbw_value`, `bbw_upperBand`, `bbw_lowerBand`, `bbw_middleBand`, `accbands_UpperBand`, `accbands_MiddleBand`, `accbands_LowerBand`, `chop_value`, `ultosc_value`, `obv_value`, `adosc_value`, `mfi_value`, `cmf_value`, `vosc_value`, `kvo_value`, `volumesplit_Total`, `volumesplit_Buy`, `volumesplit_Sell`, `volumesplit_percentBuy`, `volumesplit_percentSell`, `wad_value`, `ad_value`, `accosc_value`, `marketfi_value`, `eom_value`, `doji_value`, `hangingman_value`, `harami_value`, `belthold_value`, `closingmarubozu_value`, `highwave_value`, `spinningtop_value`, `ao_value`, `bop_value`, `coppockcurve_value`, `ichimoku_conversion`, `ichimoku_base`, `ichimoku_spanA`, `ichimoku_spanB`, `ichimoku_currentSpanA`, `ichimoku_currentSpanB`, `ichimoku_laggingSpanA`, `ichimoku_laggingSpanB`, `tdsequential_buySetupIndex`, `tdsequential_sellSetupIndex`, `tdsequential_buyCoundownIndex`, `tdsequential_sellCoundownIndex`, `tdsequential_countdownIndexIsEqualToPreviousElement`, `tdsequential_sellSetup`, `tdsequential_buySetup`, `tdsequential_sellSetupPerfection`, `tdsequential_buySetupPerfection`, `tdsequential_bearishFlip`, `tdsequential_bullishFlip`, `tdsequential_TDSTBuy`, `tdsequential_TDSTSell`, `tdsequential_countdownResetForTDST`, `vortex_plus`, `vortex_minus`, `rvgi_value`, `rvgi_signal`, `rvgi_trend`, `williamsalligator_Jaws`, `williamsalligator_Teeth`, `williamsalligator_Lips`, `willr_value`, `fisher_fisher`, `fisher_fisher_signal`, `msw_msw_sine`, `msw_msw_lead`, `dmi_adx`, `dmi_plusdi`, `dmi_minusdi`, `adx_value`, `adxr_value`, `plus_di_value`, `minus_di_value`, `plus_dm_value`, `minus_dm_value`, `dx_value`, `ht_dcperiod_value`, `ht_dcphase_value`, `ht_phasor_InPhase`, `ht_phasor_Quadrature`, `ht_sine_Sine`, `ht_sine_LeadSine`, `abs_value`, `add_value`, `mul_value`, `mult_value`, `cos_value`, `sin_value`, `ceil_value`, `avgprice_value`, `vwap_value`, `pd_value`, `beta_value`, `volume_value`.

Boolean indicators (`tdsequential_*Setup`, `*Flip`, `*Perfection`, `countdown*`) are stored as 1/0.

## Data rules (every writer)

1. **Closed bars only.** A bar is written only once `timestamp + interval <= now`. Never store or compute
   on the forming candle.
2. **Sources.** Equities: CoinGlass `GET https://fapi.coinglass.com/stocks/api/v2/kline?symbol=US_<SYM>%23kline&interval=<h1|h4|m15|m5|d1>&limit=<n>&session=extended_hours`
   -> rows `[ts_sec, o, h, l, c, v, session]`. `limit` counts round-the-clock bars and out-of-session bars
   are dropped afterwards, so ask for 3x the bars you need (max 7200). Commodities / indices: Hyperliquid
   `POST /info {"type":"candleSnapshot","req":{"coin":"xyz:GOLD","interval":"4h","startTime":ms,"endTime":ms}}`
   (latest 5000 candles only). If CoinGlass fails, equities fall back to Hyperliquid candles (`source` says so).
3. **Session.** Equities on 1h (and 15m/5m): regular trading hours only -- 1h keeps bars whose ET open hour
   is 9..15 (the :00 grid), 15m/5m keep 09:30..15:59 ET; never weekends. 4h and 1d keep every bar.
   Indicators are computed on the filtered series.
4. **Warm-up.** Indicators need history to settle (most ~300 bars, KVO ~550). Compute over a long window
   (we use up to 5000 bars) and never write the first `warmup` (default 300) bars of that window.
5. **No history rewrites.** A run writes only bars the table lacks, plus the newest 2 bars (so the previous
   bar's `price_after_<tf>` fills in). Rewriting old rows from a short window is how rows rot.
6. **Running totals.** `obv_value`, `ad_value`, `wad_value` depend on where the window starts. Shift
   written values by (stored - computed) at the newest stored bar the run does not rewrite, so the series
   is continuous.
7. **Causality.** Every stored indicator at bar i uses bars <= i only. `dpo_value = close[i-11] - SMA20(close)[i]`
   (the classic centred DPO looks ahead and must not be stored). No correlation or forward columns.
8. **NaN/Inf -> NULL.**

## Access

RLS on; `authenticated` may SELECT; `anon` has no access; only the service role writes.

## Writers today

`python -m aether.cli ingest SYMBOL TF [--bars N --warmup N --dry-run]` (engine/aether/ingest.py), which
implements rules 1-8. Golden values for a TS port: `engine/fixtures/*.json` (`engine/scripts/parity_fixture.py`).
