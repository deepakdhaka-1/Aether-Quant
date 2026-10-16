-- Promote an existing user to admin.
-- The user must have signed in at least once (that creates their profiles row).
--
-- psql (recommended):
--   psql "$SUPABASE_DB_URL" -v email='founder@example.com' -f supabase/seed/make_admin.sql
-- Supabase SQL editor: replace :'email' below with a quoted literal, e.g. 'founder@example.com'.
-- Wallet sign-in users have the synthetic email '<0xwallet-lowercase>@wallet.aetherquant.local'.
--
-- Matches on auth.users.email (server-owned), not profiles.email, so it cannot be steered by a
-- client-side profile edit. Run as postgres / service role only (the role-protect trigger lets
-- privileged sessions through and blocks everyone else).

update public.profiles p
   set role = 'admin'
  from auth.users u
 where u.id = p.id
   and lower(u.email) = lower(:'email')
returning p.id, u.email, p.role;
