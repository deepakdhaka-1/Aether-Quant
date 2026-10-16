-- ============================================================
-- 0004 — leaderboard, portfolio summary, admin revenue view, snapshot retention.
-- ============================================================

-- ---------- strategy_leaderboard ----------
-- SECURITY DEFINER because follower counts aggregate over other users' subscriptions, which
-- RLS hides. It returns only catalogue columns of published/paused strategies plus aggregate
-- counts: no user ids, no allocations, no created_by / generation_meta.
create or replace function public.strategy_leaderboard()
returns table (
  id                   uuid,
  slug                 text,
  name                 text,
  description          text,
  symbol               text,
  market_name          text,
  asset_class          text,
  timeframe            text,
  direction            text,
  risk_level           text,
  status               text,
  default_leverage     numeric,
  headline_metrics     jsonb,
  published_at         timestamptz,
  follower_count       bigint,
  live_follower_count  bigint
)
language sql stable security definer set search_path = '' as $$
  select s.id, s.slug, s.name, s.description, s.symbol, m.name, m.asset_class, s.timeframe,
         s.direction, s.risk_level, s.status, s.default_leverage, s.headline_metrics, s.published_at,
         coalesce(f.followers, 0), coalesce(f.live_followers, 0)
    from public.strategies s
    join public.markets m on m.symbol = s.symbol
    left join (
      select strategy_id,
             count(distinct user_id)                               as followers,
             count(distinct user_id) filter (where mode = 'live')  as live_followers
        from public.subscriptions
       where enabled
       group by strategy_id
    ) f on f.strategy_id = s.id
   where s.status in ('published', 'paused')
   order by case when jsonb_typeof(s.headline_metrics -> 'sharpe') = 'number'
                 then (s.headline_metrics ->> 'sharpe')::numeric end desc nulls last,
            s.published_at desc nulls last;
$$;
revoke execute on function public.strategy_leaderboard() from public;
grant execute on function public.strategy_leaderboard() to anon, authenticated, service_role;
comment on function public.strategy_leaderboard() is
  'Published/paused strategies with headline metrics and aggregate follower counts. No per-user data.';

-- ---------- my_portfolio_summary ----------
-- SECURITY INVOKER: RLS on account_snapshots/positions/subscriptions/broker_accounts applies.
create or replace function public.my_portfolio_summary()
returns table (
  total_equity         numeric,
  unrealized_pnl       numeric,
  open_positions       integer,
  followed_strategies  integer,
  broker_accounts      integer,
  equity_as_of         timestamptz
)
language sql stable security invoker set search_path = '' as $$
  with me as (select (select auth.uid()) as uid),
  latest as (
    select distinct on (a.broker_account_id) a.broker_account_id, a.equity, a.created_at
      from public.account_snapshots a, me
     where a.user_id = me.uid
     order by a.broker_account_id, a.created_at desc
  )
  select
    (select coalesce(sum(equity), 0) from latest),
    (select coalesce(sum(p.unrealized_pnl), 0) from public.positions p, me
      where p.user_id = me.uid and p.qty <> 0),
    (select count(*)::int from public.positions p, me where p.user_id = me.uid and p.qty <> 0),
    (select count(distinct s.strategy_id)::int from public.subscriptions s, me
      where s.user_id = me.uid and s.enabled),
    (select count(*)::int from public.broker_accounts b, me where b.user_id = me.uid),
    (select min(created_at) from latest);
$$;
revoke execute on function public.my_portfolio_summary() from public, anon;
grant execute on function public.my_portfolio_summary() to authenticated, service_role;

-- ---------- revenue_daily (admin only) ----------
-- security_invoker: builder_fees RLS (fees_select = is_admin()) applies to the caller, so
-- non-admins get zero rows; anon has no grant at all.
create or replace view public.revenue_daily with (security_invoker = true) as
  select (filled_at at time zone 'utc')::date as day,
         sum(fee_usd)                         as fee_usd,
         sum(notional)                        as notional_usd,
         count(*)                             as fills,
         count(distinct broker_account_id)    as paying_accounts
    from public.builder_fees
   group by 1;
revoke all on public.revenue_daily from anon, public;
grant select on public.revenue_daily to authenticated, service_role;
comment on view public.revenue_daily is 'Builder-fee revenue by UTC day. Admin only via builder_fees RLS.';

-- ---------- account_snapshots retention ----------
-- Snapshots are written every engine run (minutes). Policy: keep full resolution for
-- p_full_days, then thin to the last snapshot per broker account per UTC day (enough for
-- equity curves). Service role only. Schedule daily, e.g. with pg_cron:
--   select cron.schedule('prune-snapshots', '17 3 * * *', $$select public.prune_account_snapshots(30)$$);
-- or call it from the engine's daily job.
create or replace function public.prune_account_snapshots(p_full_days int default 30)
returns bigint language plpgsql security definer set search_path = '' as $$
declare v_deleted bigint;
begin
  if p_full_days < 7 then
    raise exception 'p_full_days must be >= 7';
  end if;
  with ranked as (
    select id,
           row_number() over (partition by broker_account_id, (created_at at time zone 'utc')::date
                              order by created_at desc) as rn
      from public.account_snapshots
     where created_at < now() - make_interval(days => p_full_days)
  )
  delete from public.account_snapshots a using ranked r
   where a.id = r.id and r.rn > 1;
  get diagnostics v_deleted = row_count;
  return v_deleted;
end; $$;
revoke execute on function public.prune_account_snapshots(int) from public, anon, authenticated;
grant execute on function public.prune_account_snapshots(int) to service_role;
