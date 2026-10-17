-- If a user has opted into verified MFA, require an AAL2 JWT for private account data.
-- Users without a verified factor can continue at AAL1 or AAL2.
do $$
declare
  t text;
  policy_name text;
  mfa_check text := $mfa$
    array[(select auth.jwt()->>'aal')] <@ (
      select case
        when count(id) > 0 then array['aal2']
        else array['aal1', 'aal2']
      end
      from auth.mfa_factors
      where user_id = (select auth.uid()) and status = 'verified'
    )
  $mfa$;
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
    execute format(
      'create policy %I on public.%I as restrictive for all to authenticated using (%s) with check (%s)',
      policy_name, t, mfa_check, mfa_check
    );
  end loop;
end $$;
