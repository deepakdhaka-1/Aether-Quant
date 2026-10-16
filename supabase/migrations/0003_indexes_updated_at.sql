-- ============================================================
-- 0003 — indexes for hot queries + FK coverage, and updated_at triggers.
-- ============================================================

-- Latest signal per strategy: the unique (strategy_id, bar_time) btree already serves
-- "order by bar_time desc limit 1" (backward scan), so the 0001 duplicate index is dropped.
drop index if exists public.strategy_signals_latest_idx;

-- subscriptions by broker_account_id: covered by unique (broker_account_id, strategy_id).
create index if not exists subscriptions_user_idx      on public.subscriptions (user_id);
create index if not exists subscriptions_strategy_idx  on public.subscriptions (strategy_id) where enabled;
create index if not exists subscriptions_strategy_fk   on public.subscriptions (strategy_id);

create index if not exists broker_accounts_user_idx    on public.broker_accounts (user_id);

-- orders by user: orders_user_idx (user_id, created_at desc) from 0001.
create index if not exists orders_broker_idx           on public.orders (broker_account_id, created_at desc);
create index if not exists orders_subscription_idx     on public.orders (subscription_id);
create index if not exists orders_strategy_idx         on public.orders (strategy_id, created_at desc);

create index if not exists positions_user_idx          on public.positions (user_id);
create index if not exists positions_strategy_idx      on public.positions (strategy_id);

create index if not exists account_snapshots_user_idx  on public.account_snapshots (user_id, created_at desc);

create index if not exists builder_fees_broker_idx     on public.builder_fees (broker_account_id);
create index if not exists builder_fees_filled_idx     on public.builder_fees (filled_at);

create index if not exists strategies_symbol_idx       on public.strategies (symbol);
create index if not exists strategies_created_by_idx   on public.strategies (created_by);

-- ---------- updated_at ----------
create or replace function public.set_updated_at() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.updated_at := now();
  return new;
end; $$;
revoke execute on function public.set_updated_at() from public, anon, authenticated;

drop trigger if exists broker_accounts_updated_at on public.broker_accounts;
create trigger broker_accounts_updated_at before update on public.broker_accounts
  for each row execute function public.set_updated_at();

drop trigger if exists positions_updated_at on public.positions;
create trigger positions_updated_at before update on public.positions
  for each row execute function public.set_updated_at();

drop trigger if exists system_state_updated_at on public.system_state;
create trigger system_state_updated_at before update on public.system_state
  for each row execute function public.set_updated_at();
