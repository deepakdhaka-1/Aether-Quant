-- 0007: indicator snapshot tables -- the indicators database strategies are built from.
--
-- One table per feed: <SYMBOL>_<TOKEN>_TAAPI_Indicator_snapshot, TOKEN in (1H, 4H), e.g.
-- "NVDA_1H_TAAPI_Indicator_snapshot". Written by `python -m aether.cli ingest SYMBOL TF`
-- (engine/aether/ingest.py), keyed on "timestamp" (bar open, epoch SECONDS) for idempotent upserts.
--
-- Column names are the engine's exact names, double-quoted so camelCase survives
-- (rules reference "macdext_MACD", not macdext_macd). Semantics:
--   * every indicator is causal (computed from bars <= this one); price_change is the
--     BACKWARD % change; dpo_value is close[i-11] - SMA20[i];
--   * price_after_<tf> is a LABEL (next bar's close), NULL until that bar closes.
--     Never reference it in a live rule;
--   * equities: regular-session bars only on 1H (bar_et_hour / is_final_rth_bar stamped);
--     4H keeps every bar. funding/open-interest columns are reserved (NULL for now).
--
-- Access: authenticated users may read; only the service role (engine) writes.

create or replace function public.aether_snapshot_table_name(p_symbol text, p_timeframe text)
returns text language sql immutable set search_path = '' as $$
  select upper(p_symbol) || '_' || case p_timeframe when '1h' then '1H' when '4h' then '4H'
    when '15m' then '15min' when '5m' then '5min' when '1d' then '1D' end || '_TAAPI_Indicator_snapshot'
$$;

create or replace function public.aether_create_snapshot_table(p_symbol text, p_timeframe text)
returns text language plpgsql security definer set search_path = '' as $fn$
declare
  tbl text := public.aether_snapshot_table_name(p_symbol, p_timeframe);
  label text := 'price_after_' || case p_timeframe when '1h' then '1_h' when '4h' then '4_h'
    when '15m' then '15_min' when '5m' then '5_min' when '1d' then '1_d' end;
begin
  if p_symbol !~ '^[A-Za-z0-9]{1,20}$' or tbl is null then
    raise exception 'bad symbol/timeframe: % %', p_symbol, p_timeframe;
  end if;
  execute format($f$
    create table if not exists public.%I (
      id bigint generated always as identity primary key,
      "timestamp" bigint not null unique,
      ts_utc timestamptz generated always as (to_timestamp("timestamp")) stored,
      "timestampHuman" text,
      open double precision, high double precision, low double precision,
      close double precision, volume double precision,
      price_value double precision,
      %I double precision,
      price_change double precision,
      "rsi_value" double precision,
      "stoch_K" double precision,
      "stoch_D" double precision,
      "stochf_FastK" double precision,
      "stochf_FastD" double precision,
      "stochrsi_FastK" double precision,
      "stochrsi_FastD" double precision,
      "cci_value" double precision,
      "mom_value" double precision,
      "roc_value" double precision,
      "ppo_value" double precision,
      "apo_value" double precision,
      "trix_value" double precision,
      "kdj_K" double precision,
      "kdj_D" double precision,
      "kdj_J" double precision,
      "cmo_value" double precision,
      "ema_value" double precision,
      "dema_value" double precision,
      "zlema_value" double precision,
      "hma_value" double precision,
      "kama_value" double precision,
      "macdext_MACD" double precision,
      "macdext_MACDSignal" double precision,
      "macdext_MACDHist" double precision,
      "supertrend_value" double precision,
      "supertrend_Advice" text,
      "ht_trendline_value" double precision,
      "ht_trendmode_value" double precision,
      "psar_value" double precision,
      "aroon_AroonDown" double precision,
      "aroon_AroonUp" double precision,
      "aroonosc_value" double precision,
      "dpo_value" double precision,
      "atr_value" double precision,
      "natr_value" double precision,
      "bbands_UpperBand" double precision,
      "bbands_MiddleBand" double precision,
      "bbands_LowerBand" double precision,
      "bbw_value" double precision,
      "bbw_upperBand" double precision,
      "bbw_lowerBand" double precision,
      "bbw_middleBand" double precision,
      "accbands_UpperBand" double precision,
      "accbands_MiddleBand" double precision,
      "accbands_LowerBand" double precision,
      "chop_value" double precision,
      "ultosc_value" double precision,
      "obv_value" double precision,
      "adosc_value" double precision,
      "mfi_value" double precision,
      "cmf_value" double precision,
      "vosc_value" double precision,
      "kvo_value" double precision,
      "volumesplit_Total" double precision,
      "volumesplit_Buy" double precision,
      "volumesplit_Sell" double precision,
      "volumesplit_percentBuy" double precision,
      "volumesplit_percentSell" double precision,
      "wad_value" double precision,
      "ad_value" double precision,
      "accosc_value" double precision,
      "marketfi_value" double precision,
      "eom_value" double precision,
      "doji_value" double precision,
      "hangingman_value" double precision,
      "harami_value" double precision,
      "belthold_value" double precision,
      "closingmarubozu_value" double precision,
      "highwave_value" double precision,
      "spinningtop_value" double precision,
      "ao_value" double precision,
      "bop_value" double precision,
      "coppockcurve_value" double precision,
      "ichimoku_conversion" double precision,
      "ichimoku_base" double precision,
      "ichimoku_spanA" double precision,
      "ichimoku_spanB" double precision,
      "ichimoku_currentSpanA" double precision,
      "ichimoku_currentSpanB" double precision,
      "ichimoku_laggingSpanA" double precision,
      "ichimoku_laggingSpanB" double precision,
      "tdsequential_buySetupIndex" double precision,
      "tdsequential_sellSetupIndex" double precision,
      "tdsequential_buyCoundownIndex" double precision,
      "tdsequential_sellCoundownIndex" double precision,
      "tdsequential_countdownIndexIsEqualToPreviousElement" double precision,
      "tdsequential_sellSetup" double precision,
      "tdsequential_buySetup" double precision,
      "tdsequential_sellSetupPerfection" double precision,
      "tdsequential_buySetupPerfection" double precision,
      "tdsequential_bearishFlip" double precision,
      "tdsequential_bullishFlip" double precision,
      "tdsequential_TDSTBuy" double precision,
      "tdsequential_TDSTSell" double precision,
      "tdsequential_countdownResetForTDST" double precision,
      "vortex_plus" double precision,
      "vortex_minus" double precision,
      "rvgi_value" double precision,
      "rvgi_signal" double precision,
      "rvgi_trend" text,
      "williamsalligator_Jaws" double precision,
      "williamsalligator_Teeth" double precision,
      "williamsalligator_Lips" double precision,
      "willr_value" double precision,
      "fisher_fisher" double precision,
      "fisher_fisher_signal" double precision,
      "msw_msw_sine" double precision,
      "msw_msw_lead" double precision,
      "dmi_adx" double precision,
      "dmi_plusdi" double precision,
      "dmi_minusdi" double precision,
      "adx_value" double precision,
      "adxr_value" double precision,
      "plus_di_value" double precision,
      "minus_di_value" double precision,
      "plus_dm_value" double precision,
      "minus_dm_value" double precision,
      "dx_value" double precision,
      "ht_dcperiod_value" double precision,
      "ht_dcphase_value" double precision,
      "ht_phasor_InPhase" double precision,
      "ht_phasor_Quadrature" double precision,
      "ht_sine_Sine" double precision,
      "ht_sine_LeadSine" double precision,
      "abs_value" double precision,
      "add_value" double precision,
      "mul_value" double precision,
      "mult_value" double precision,
      "cos_value" double precision,
      "sin_value" double precision,
      "ceil_value" double precision,
      "avgprice_value" double precision,
      "vwap_value" double precision,
      "pd_value" double precision,
      "beta_value" double precision,
      "volume_value" double precision,
      bar_et_hour smallint,
      is_final_rth_bar smallint,
      funding_rate double precision,
      funding_rate_annualized double precision,
      open_interest double precision,
      open_interest_value double precision,
      source text,
      created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    )$f$, tbl, label);
  execute format('create index if not exists %I on public.%I ("timestamp" desc)', left(tbl, 50) || '_ts_idx', tbl);
  execute format('alter table public.%I enable row level security', tbl);
  execute format('revoke all on public.%I from anon, authenticated', tbl);
  execute format('grant select on public.%I to authenticated', tbl);
  execute format('drop policy if exists snapshot_read on public.%I', tbl);
  execute format('create policy snapshot_read on public.%I for select to authenticated using (true)', tbl);
  return tbl;
end $fn$;

revoke all on function public.aether_create_snapshot_table(text, text) from public, anon, authenticated;
grant execute on function public.aether_create_snapshot_table(text, text) to service_role;

-- Every active market x {1h, 4h}. New markets: select aether_create_snapshot_table('SYM','1h');
do $$
declare m record; tf text;
begin
  for m in select symbol from public.markets where active loop
    foreach tf in array array['1h','4h'] loop
      perform public.aether_create_snapshot_table(m.symbol, tf);
    end loop;
  end loop;
end $$;

notify pgrst, 'reload schema';
