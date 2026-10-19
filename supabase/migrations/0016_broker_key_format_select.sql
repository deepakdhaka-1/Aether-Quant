-- 0014 added agent_key_format but no column SELECT grant, so every user read that lists it
-- (the broker API's ownedAccount: submit/refresh/revoke) failed with a permission error.
grant select (agent_key_format) on public.broker_accounts to authenticated;
