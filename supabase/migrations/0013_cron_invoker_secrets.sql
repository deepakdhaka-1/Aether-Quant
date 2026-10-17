-- Route every scheduled Edge Function through the project URL and cron secret stored in Vault.
-- The functions perform their own constant-time x-cron-secret check, so JWT verification is
-- disabled at the gateway and the secret remains the authentication boundary.
create or replace function public.aether_invoke(p_fn text, p_body jsonb default '{}'::jsonb)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_url text;
  v_secret text;
begin
  if p_fn not in ('ingest', 'signals', 'execute', 'fees', 'monitor', 'market-candles') then
    raise exception 'unknown runtime function %', p_fn;
  end if;

  select decrypted_secret into v_url
  from vault.decrypted_secrets
  where name = 'aether_project_url'
  limit 1;

  select decrypted_secret into v_secret
  from vault.decrypted_secrets
  where name = 'aether_cron_secret'
  limit 1;

  if v_url is null or v_secret is null then
    raise exception 'vault secrets aether_project_url / aether_cron_secret are not set';
  end if;

  return net.http_post(
    url := rtrim(v_url, '/') || '/functions/v1/' || p_fn,
    body := p_body,
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', v_secret
    ),
    timeout_milliseconds := 150000
  );
end
$$;

revoke all on function public.aether_invoke(text, jsonb) from public, anon, authenticated;
grant execute on function public.aether_invoke(text, jsonb) to service_role;
