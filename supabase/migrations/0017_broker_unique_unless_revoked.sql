-- unique (wallet_address, network) also counted revoked rows, so a wallet could never be
-- reconnected after Disconnect. Keep "one live connection per wallet per network" and let revoked
-- rows stay as history.
alter table public.broker_accounts drop constraint if exists broker_accounts_wallet_address_network_key;
create unique index if not exists broker_accounts_wallet_network_live
  on public.broker_accounts (wallet_address, network)
  where status <> 'revoked';
