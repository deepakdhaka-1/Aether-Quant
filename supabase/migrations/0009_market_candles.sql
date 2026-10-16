-- Daily public OHLCV cache for the landing-page asset charts.
create extension if not exists pg_cron;
create extension if not exists pg_net;

create table if not exists public.market_candles (
  ticker text not null check (ticker in (
    'NVDA', 'TSLA', 'AAPL', 'MSFT', 'AMZN', 'GOOGL', 'META', 'XYZ100',
    'GOLD', 'SILVER', 'CL', 'NATGAS', 'COPPER'
  )),
  coin text not null,
  interval text not null default '1d' check (interval = '1d'),
  candle_time timestamptz not null,
  open numeric(32, 12) not null,
  high numeric(32, 12) not null,
  low numeric(32, 12) not null,
  close numeric(32, 12) not null,
  volume numeric(36, 12) not null default 0,
  updated_at timestamptz not null default now(),
  primary key (ticker, interval, candle_time),
  check (high >= low),
  check (volume >= 0)
);

create index if not exists market_candles_recent_idx
  on public.market_candles (ticker, candle_time desc);

alter table public.market_candles enable row level security;
drop policy if exists market_candles_public_read on public.market_candles;
create policy market_candles_public_read on public.market_candles
  for select to anon, authenticated using (true);
grant select on public.market_candles to anon, authenticated;
revoke insert, update, delete, truncate, references, trigger on public.market_candles from anon, authenticated;
grant all on public.market_candles to service_role;

-- Allow the existing Vault-backed daily scheduler to invoke the candle updater.
create or replace function public.aether_invoke(p_fn text, p_body jsonb default '{}'::jsonb)
returns bigint language plpgsql security definer set search_path = '' as $$
declare
  v_url text;
  v_secret text;
begin
  if p_fn not in ('ingest', 'signals', 'execute', 'fees', 'monitor', 'market-candles') then
    raise exception 'unknown runtime function %', p_fn;
  end if;
  select decrypted_secret into v_url from vault.decrypted_secrets where name = 'aether_project_url' limit 1;
  select decrypted_secret into v_secret from vault.decrypted_secrets where name = 'aether_cron_secret' limit 1;
  if v_url is null or v_secret is null then
    raise exception 'vault secrets aether_project_url / aether_cron_secret are not set';
  end if;
  return net.http_post(
    url := rtrim(v_url, '/') || '/functions/v1/' || p_fn,
    body := p_body,
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-cron-secret', v_secret),
    timeout_milliseconds := 150000
  );
end $$;
revoke all on function public.aether_invoke(text, jsonb) from public, anon, authenticated;
grant execute on function public.aether_invoke(text, jsonb) to service_role;

-- Run shortly after the UTC daily candle closes.
select cron.schedule('aether-market-candles', '10 0 * * *', $$select public.aether_invoke('market-candles')$$);
