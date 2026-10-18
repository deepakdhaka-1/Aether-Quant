-- 0012's policies read auth.mfa_factors directly, but the authenticated role has no SELECT on it
-- ("permission denied for table mfa_factors"). Move the lookup into a SECURITY DEFINER function
-- that only answers for the calling user.
create schema if not exists private;

create or replace function private.mfa_aal_ok()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select (select auth.jwt()->>'aal') = 'aal2'
      or not exists (
        select 1 from auth.mfa_factors
        where user_id = (select auth.uid()) and status = 'verified'
      );
$$;

revoke all on function private.mfa_aal_ok() from public;
grant usage on schema private to authenticated;
grant execute on function private.mfa_aal_ok() to authenticated;

do $$
declare
  t text;
  policy_name text;
begin
  foreach t in array array[
    'profiles',
    'broker_accounts',
    'subscriptions',
    'user_risk',
    'orders',
    'positions',
    'account_snapshots',
    'builder_fees'
  ] loop
    policy_name := t || '_require_aal2_when_mfa_enabled';
    execute format('drop policy if exists %I on public.%I', policy_name, t);
    execute format(
      'create policy %I on public.%I as restrictive for all to authenticated using ((select private.mfa_aal_ok())) with check ((select private.mfa_aal_ok()))',
      policy_name, t
    );
  end loop;
end $$;
