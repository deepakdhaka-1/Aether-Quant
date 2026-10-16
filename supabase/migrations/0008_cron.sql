-- 0008: Edge runtime -- schema the execution spec needs, and the pg_cron + pg_net schedules that
-- drive the Edge Functions (supabase/functions/*, docs/EDGE_RUNTIME.md).
--
-- Secrets are NOT in this file. The invoker reads two Vault entries, created once per project:
--   select vault.create_secret('<https://<ref>.supabase.co>', 'aether_project_url');
--   select vault.create_secret('<same value as the CRON_SECRET function secret>', 'aether_cron_secret');

create extension if not exists pg_cron;
create extension if not exists pg_net;

-- ---------------------------------------------------------------------------------------------
-- Schema gaps from docs/EXECUTION_SPEC.md
-- ---------------------------------------------------------------------------------------------
-- 4.5: entries refused by a gate are recorded as 'blocked'.
do $$
declare c text;
begin
  for c in select conname from pg_constraint
            where conrelid = 'public.orders'::regclass and contype = 'c'
              and pg_get_constraintdef(oid) ilike '%status%' loop
    execute format('alter table public.orders drop constraint %I', c);
  end loop;
end $$;
alter table public.orders add constraint orders_status_check
  check (status in ('filled','partial','rejected','dry_run','paper','blocked'));

-- 5.4: re-entry suppression -- the trade (entry bar) of the signal this subscription last entered on.
-- 4.3: size reconciliation cooldown.
alter table public.subscriptions
  add column if not exists last_entry_signal text,
  add column if not exists last_resize_at timestamptz;

-- 1 / 5 / 8: the simulation's protective distances and, while the strategy holds a trade, that
-- trade's own entry (the late-join anchor).
alter table public.strategy_signals
  add column if not exists sl_pct numeric,
  add column if not exists tp_pct numeric,
  add column if not exists entry_price numeric,
  add column if not exists entry_time timestamptz;

create index if not exists orders_sub_blocked_idx on public.orders (subscription_id, created_at desc) where status = 'blocked';

-- ---------------------------------------------------------------------------------------------
-- Invoker: POST to an Edge Function with the cron secret from Vault (never hard-coded).
-- ---------------------------------------------------------------------------------------------
create or replace function public.aether_invoke(p_fn text, p_body jsonb default '{}'::jsonb)
returns bigint language plpgsql security definer set search_path = '' as $$
declare
  v_url text;
  v_secret text;
begin
  if p_fn not in ('ingest', 'signals', 'execute', 'fees', 'monitor') then
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

-- ---------------------------------------------------------------------------------------------
-- Schedules (UTC). cron.schedule upserts by job name, so re-running this file is safe.
-- ---------------------------------------------------------------------------------------------
-- Bars close on the hour (1h every hour, 4h at 00/04/08/12/16/20 UTC): ingest one minute later.
-- ingest chains signals as soon as its feeds are written; the 3-minute job is the backstop.
select cron.schedule('aether-ingest',   '1 * * * *',   $$select public.aether_invoke('ingest')$$);
select cron.schedule('aether-signals',  '3 * * * *',   $$select public.aether_invoke('signals')$$);
select cron.schedule('aether-execute',  '* * * * *',   $$select public.aether_invoke('execute')$$);
select cron.schedule('aether-fees',     '7 * * * *',   $$select public.aether_invoke('fees')$$);
select cron.schedule('aether-monitor',  '*/5 * * * *', $$select public.aether_invoke('monitor')$$);
select cron.schedule('aether-prune-account-snapshots', '17 3 * * *', $$select public.prune_account_snapshots(30)$$);
