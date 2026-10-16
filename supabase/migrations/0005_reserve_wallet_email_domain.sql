-- The synthetic e-mail domain used by wallet sign-in is reserved for accounts the server creates
-- with app_metadata.wallet_address (which clients cannot set). Blocks squatting a wallet's
-- account by e-mail sign-up as 0x<victim>@wallet.aetherquant.local.
create or replace function public.reserve_wallet_email_domain() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if lower(new.email) like '%@wallet.aetherquant.local'
     and lower(coalesce(new.raw_app_meta_data->>'wallet_address', '')) || '@wallet.aetherquant.local'
         <> lower(new.email) then
    raise exception 'this e-mail domain is reserved for wallet sign-in';
  end if;
  return new;
end; $$;
revoke execute on function public.reserve_wallet_email_domain() from public, anon, authenticated;

drop trigger if exists reserve_wallet_email_domain on auth.users;
create trigger reserve_wallet_email_domain before insert or update of email on auth.users
  for each row execute function public.reserve_wallet_email_domain();
