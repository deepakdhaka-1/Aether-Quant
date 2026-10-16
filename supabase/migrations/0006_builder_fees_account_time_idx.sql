-- Per-account fee history (engine / admin): replaces the single-column FK index from 0003,
-- which this composite index covers.
create index if not exists builder_fees_broker_time_idx
  on public.builder_fees (broker_account_id, filled_at desc);
drop index if exists public.builder_fees_broker_idx;
