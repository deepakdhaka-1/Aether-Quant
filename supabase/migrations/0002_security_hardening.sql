-- ============================================================
-- 0002 — security hardening after review of 0001.
-- Findings fixed here (see report / supabase/README.md):
--  * Wallet squatting: handle_new_user trusted client-controlled user_metadata.wallet_address,
--    so anyone calling supabase.auth.signUp could claim someone else's wallet.
--  * profiles: users could rewrite email / referral_code (email is what make_admin keys on).
--  * protect_profile_role relied on auth.role() being NULL for direct SQL and did not cover INSERT.
--  * subscriptions: UPDATE skipped the "published" check, so a row could be re-pointed at a
--    draft/retired strategy or another broker account; re-enabling a paused strategy was allowed.
--  * user_risk: no bounds, a user could set max_gross_leverage = 1000.
--  * Supabase default grants left TRUNCATE/REFERENCES/TRIGGER (and INSERT/DELETE) on every
--    table for anon/authenticated; RLS does not apply to TRUNCATE.
--  * SECURITY DEFINER trigger functions were executable via /rest/v1/rpc by anon/authenticated.
--  * Policies applied to PUBLIC (incl. anon) and called is_admin() / auth.uid() per row.
-- ============================================================

-- ---------- table privileges ----------
do $$
declare t text;
begin
  foreach t in array array['profiles','wallet_nonces','markets','strategies','backtests',
    'strategy_signals','broker_accounts','subscriptions','user_risk','orders','positions',
    'account_snapshots','builder_fees','system_state','exec_lock','heartbeats'] loop
    execute format('revoke truncate, references, trigger on public.%I from anon, authenticated', t);
  end loop;
end $$;

-- Server-only tables: no client access at all.
revoke all on public.wallet_nonces, public.exec_lock from anon, authenticated;

-- Per-user / private tables: nothing for anon.
revoke all on public.profiles, public.broker_accounts, public.subscriptions, public.user_risk,
  public.orders, public.positions, public.account_snapshots, public.builder_fees,
  public.heartbeats from anon;

-- Engine-written tables: clients may only read (RLS narrows further).
revoke insert, update, delete on public.orders, public.positions, public.account_snapshots,
  public.builder_fees, public.heartbeats, public.strategy_signals from authenticated;
revoke insert, update, delete on public.markets, public.strategies, public.backtests,
  public.strategy_signals, public.system_state from anon;
revoke insert, delete on public.profiles, public.broker_accounts from authenticated;

-- broker_accounts: re-assert column grants (agent_secret_enc never granted).
revoke select, update on public.broker_accounts from anon, authenticated;
grant select (id, user_id, broker, network, wallet_address, wallet_provider, agent_address,
              agent_approved, builder_approved, builder_max_fee, status, kill_switch,
              last_error, terms_accepted_at, created_at, updated_at)
  on public.broker_accounts to authenticated;
grant update (kill_switch) on public.broker_accounts to authenticated;

-- profiles: only username is client-editable (role/wallet/email/referral are server-owned).
revoke update on public.profiles from authenticated;
grant update (username) on public.profiles to authenticated;

-- Future tables created by postgres in public: never hand out TRUNCATE etc. to clients.
alter default privileges for role postgres in schema public
  revoke truncate, references, trigger on tables from anon, authenticated;

-- ---------- helper: is the caller a privileged (non-client) session? ----------
-- Client requests through PostgREST always carry role anon/authenticated in the JWT.
-- service_role JWTs, GoTrue, the SQL editor and migrations do not.
create or replace function public.is_privileged_caller() returns boolean
language sql stable set search_path = '' as $$
  select coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role', '')
         not in ('anon', 'authenticated');
$$;
revoke execute on function public.is_privileged_caller() from public, anon, authenticated;

-- ---------- is_admin: authenticated only ----------
create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.profiles where id = (select auth.uid()) and role = 'admin');
$$;
revoke execute on function public.is_admin() from public, anon;
grant execute on function public.is_admin() to authenticated, service_role;

-- ---------- handle_new_user: don't trust client metadata for wallet_address ----------
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_wallet   text := lower(nullif(new.raw_app_meta_data ->> 'wallet_address', ''));
  v_meta_w   text := lower(nullif(new.raw_user_meta_data ->> 'wallet_address', ''));
  v_username text := nullif(new.raw_user_meta_data ->> 'username', '');
begin
  -- user_metadata is client-writable (supabase.auth.signUp). Accept a wallet from it only when
  -- the account is the synthetic wallet login created by /api/auth/verify after a signature check.
  if v_wallet is null and v_meta_w is not null
     and lower(new.email) = v_meta_w || '@wallet.aetherquant.local' then
    v_wallet := v_meta_w;
  end if;
  if v_wallet is not null and v_wallet !~ '^0x[0-9a-f]{40}$' then
    v_wallet := null;
  end if;
  if v_wallet is not null and exists (select 1 from public.profiles where wallet_address = v_wallet) then
    v_wallet := null;
  end if;
  -- username is unique; a collision (e.g. same 8-char wallet prefix) must not break sign-up.
  if v_username is not null and exists (select 1 from public.profiles where username = v_username) then
    v_username := null;
  end if;

  insert into public.profiles (id, email, username, wallet_address, referral_code, role)
  values (new.id, new.email, v_username, v_wallet,
          nullif(new.raw_user_meta_data ->> 'referral_code', ''), 'user')
  on conflict (id) do nothing;
  return new;
end; $$;
revoke execute on function public.handle_new_user() from public, anon, authenticated;

-- ---------- profile protection (INSERT + UPDATE) ----------
create or replace function public.protect_profile_role() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if public.is_privileged_caller() then
    return new;
  end if;
  if tg_op = 'INSERT' then
    new.role := 'user';
    return new;
  end if;
  if new.role is distinct from old.role and not public.is_admin() then
    raise exception 'role can only be changed by an admin' using errcode = '42501';
  end if;
  if new.wallet_address is distinct from old.wallet_address
     or new.email is distinct from old.email
     or new.referral_code is distinct from old.referral_code
     or new.id is distinct from old.id
     or new.created_at is distinct from old.created_at then
    raise exception 'only username can be changed by the client' using errcode = '42501';
  end if;
  return new;
end; $$;
revoke execute on function public.protect_profile_role() from public, anon, authenticated;
drop trigger if exists profiles_protect_role on public.profiles;
create trigger profiles_protect_role before insert or update on public.profiles
  for each row execute function public.protect_profile_role();

-- ---------- subscriptions integrity ----------
create or replace function public.check_subscription() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_owner uuid; v_status text;
begin
  if tg_op = 'UPDATE' and (new.user_id is distinct from old.user_id
       or new.strategy_id is distinct from old.strategy_id
       or new.broker_account_id is distinct from old.broker_account_id) then
    raise exception 'user, strategy and broker account of a subscription cannot be changed; delete and re-create'
      using errcode = '42501';
  end if;

  select user_id into v_owner from public.broker_accounts where id = new.broker_account_id;
  if v_owner is distinct from new.user_id then
    raise exception 'broker account does not belong to this user' using errcode = '42501';
  end if;

  select status into v_status from public.strategies where id = new.strategy_id;
  if (tg_op = 'INSERT'
      or (new.enabled and not old.enabled)
      or (new.mode = 'live' and old.mode is distinct from 'live'))
     and v_status is distinct from 'published' then
    raise exception 'strategy is not open for subscriptions';
  end if;

  -- Hyperliquid nets positions per coin: two strategies on one coin in one account would fight.
  if exists (
       select 1 from public.subscriptions x
         join public.strategies a on a.id = x.strategy_id
         join public.strategies b on b.id = new.strategy_id
        where x.broker_account_id = new.broker_account_id and x.id <> new.id
          and a.symbol = b.symbol) then
    raise exception 'you already follow a strategy on this market with this account';
  end if;

  if new.mode = 'live' and not exists (
       select 1 from public.broker_accounts b where b.id = new.broker_account_id
         and b.status = 'active' and b.agent_approved and b.builder_approved) then
    raise exception 'connect and approve your Hyperliquid wallet before going live';
  end if;
  return new;
end; $$;
revoke execute on function public.check_subscription() from public, anon, authenticated;

-- ---------- user_risk bounds ----------
alter table public.user_risk
  add constraint user_risk_daily_loss_chk  check (max_daily_loss_pct > 0 and max_daily_loss_pct <= 100),
  add constraint user_risk_drawdown_chk    check (max_drawdown_pct > 0 and max_drawdown_pct <= 100),
  add constraint user_risk_gross_lev_chk   check (max_gross_leverage > 0 and max_gross_leverage <= 10);

-- ---------- exec lock: pin search_path, service role only ----------
alter function public.try_exec_lock(text, text, int) set search_path = '';
create or replace function public.try_exec_lock(p_name text, p_holder text, p_ttl_s int)
returns boolean language plpgsql security definer set search_path = '' as $$
begin
  insert into public.exec_lock (name, holder, expires_at)
  values (p_name, p_holder, now() + make_interval(secs => p_ttl_s))
  on conflict (name) do update
    set holder = excluded.holder, expires_at = excluded.expires_at
    where public.exec_lock.expires_at < now() or public.exec_lock.holder = excluded.holder;
  return found;
end; $$;
create or replace function public.release_exec_lock(p_name text, p_holder text)
returns void language sql security definer set search_path = '' as $$
  delete from public.exec_lock where name = p_name and holder = p_holder;
$$;
revoke execute on function public.try_exec_lock(text,text,int) from public, anon, authenticated;
revoke execute on function public.release_exec_lock(text,text) from public, anon, authenticated;
grant execute on function public.try_exec_lock(text,text,int) to service_role;
grant execute on function public.release_exec_lock(text,text) to service_role;

-- ============================================================
-- Policies rewritten: explicit roles, (select auth.uid()) initplans, one permissive policy
-- per role/action, and no is_admin() in anon-reachable policies.
-- ============================================================
do $$
declare r record;
begin
  for r in select schemaname, tablename, policyname from pg_policies where schemaname = 'public' loop
    execute format('drop policy %I on %I.%I', r.policyname, r.schemaname, r.tablename);
  end loop;
end $$;

-- profiles
create policy profiles_select on public.profiles for select to authenticated
  using (id = (select auth.uid()) or (select public.is_admin()));
create policy profiles_update on public.profiles for update to authenticated
  using (id = (select auth.uid())) with check (id = (select auth.uid()));

-- markets (public catalogue)
create policy markets_select on public.markets for select to anon, authenticated using (true);
create policy markets_insert on public.markets for insert to authenticated with check ((select public.is_admin()));
create policy markets_update on public.markets for update to authenticated
  using ((select public.is_admin())) with check ((select public.is_admin()));
create policy markets_delete on public.markets for delete to authenticated using ((select public.is_admin()));

-- strategies
create policy strategies_select_anon on public.strategies for select to anon
  using (status in ('published','paused'));
create policy strategies_select on public.strategies for select to authenticated
  using (status in ('published','paused') or (select public.is_admin()));
create policy strategies_insert on public.strategies for insert to authenticated with check ((select public.is_admin()));
create policy strategies_update on public.strategies for update to authenticated
  using ((select public.is_admin())) with check ((select public.is_admin()));
create policy strategies_delete on public.strategies for delete to authenticated using ((select public.is_admin()));

-- backtests
create policy backtests_select_anon on public.backtests for select to anon using (
  exists (select 1 from public.strategies s where s.id = strategy_id and s.status in ('published','paused')));
create policy backtests_select on public.backtests for select to authenticated using (
  (select public.is_admin())
  or exists (select 1 from public.strategies s where s.id = strategy_id and s.status in ('published','paused')));
create policy backtests_insert on public.backtests for insert to authenticated with check ((select public.is_admin()));
create policy backtests_update on public.backtests for update to authenticated
  using ((select public.is_admin())) with check ((select public.is_admin()));
create policy backtests_delete on public.backtests for delete to authenticated using ((select public.is_admin()));

-- strategy_signals (engine writes; read for live strategies)
create policy signals_select_anon on public.strategy_signals for select to anon using (
  exists (select 1 from public.strategies s where s.id = strategy_id and s.status in ('published','paused')));
create policy signals_select on public.strategy_signals for select to authenticated using (
  (select public.is_admin())
  or exists (select 1 from public.strategies s where s.id = strategy_id and s.status in ('published','paused')));

-- per-user data
create policy brokers_select on public.broker_accounts for select to authenticated
  using (user_id = (select auth.uid()) or (select public.is_admin()));
create policy brokers_update on public.broker_accounts for update to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

create policy subs_all on public.subscriptions for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy risk_all on public.user_risk for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

create policy orders_select on public.orders for select to authenticated
  using (user_id = (select auth.uid()) or (select public.is_admin()));
create policy positions_select on public.positions for select to authenticated
  using (user_id = (select auth.uid()) or (select public.is_admin()));
create policy snapshots_select on public.account_snapshots for select to authenticated
  using (user_id = (select auth.uid()) or (select public.is_admin()));

-- ops
create policy fees_select on public.builder_fees for select to authenticated using ((select public.is_admin()));
create policy state_select on public.system_state for select to anon, authenticated using (true);
create policy state_update on public.system_state for update to authenticated
  using ((select public.is_admin())) with check ((select public.is_admin()));
create policy heartbeats_select on public.heartbeats for select to authenticated using ((select public.is_admin()));
-- wallet_nonces, exec_lock: RLS on, no policies, no grants -> service role only (intentional).
comment on table public.wallet_nonces is 'Service role only: RLS enabled with no policies and no client grants.';
comment on table public.exec_lock is 'Service role only: RLS enabled with no policies and no client grants.';
