-- Browser-created agent keys are encrypted to a public key owned by the trusted
-- executor. Existing AES envelopes stay tagged v1 for the executor's current reader.
alter table public.broker_accounts
  add column if not exists agent_key_format text not null default 'v1';
alter table public.broker_accounts
  alter column agent_key_format set default 'rsa1';

drop policy if exists brokers_insert on public.broker_accounts;
create policy brokers_insert on public.broker_accounts for insert to authenticated
  with check (user_id = (select auth.uid()));

-- The browser may permanently revoke its own account, but cannot mark it active.
-- Only the trusted executor can activate an rsa1 envelope after it supports decryption.
create or replace function public.guard_browser_broker_status()
returns trigger language plpgsql set search_path = '' as $$
declare caller_role text;
begin
  caller_role := coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role', '');
  if caller_role = 'authenticated' and new.status is distinct from old.status
     and new.status <> 'revoked' then
    raise exception 'authenticated users may only revoke a broker account';
  end if;
  return new;
end; $$;
drop trigger if exists broker_status_guard on public.broker_accounts;
create trigger broker_status_guard before update of status on public.broker_accounts
  for each row execute function public.guard_browser_broker_status();

-- RLS already limits these writes to the authenticated row owner. Column grants
-- deliberately keep status and ownership fields outside the user's control.
grant insert (user_id, broker, network, wallet_address, wallet_provider,
              agent_address, agent_secret_enc, agent_key_format)
  on public.broker_accounts to authenticated;
grant update (agent_secret_enc, agent_approved, builder_approved, builder_max_fee,
              kill_switch, status, last_error, updated_at)
  on public.broker_accounts to authenticated;

comment on column public.broker_accounts.agent_key_format is
  'Encryption envelope version: v1 AES-GCM legacy; rsa1 RSA-OAEP browser encrypted.';
