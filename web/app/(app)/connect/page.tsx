import type { Metadata } from "next";
import { ConnectFlow } from "@/components/connect/ConnectFlow";
import { BrokerAccounts } from "@/components/connect/BrokerAccounts";
import { Card, CardHeader, ErrorNote, PageTitle } from "@/components/ui";
import { SELECT_BROKER, type BrokerAccount } from "@/components/types";
import { supabaseServer } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "Connect Hyperliquid" };

export default async function ConnectPage() {
  const sb = await supabaseServer();
  const { data, error } = await sb.from("broker_accounts").select(SELECT_BROKER).order("created_at", { ascending: false });
  return (
    <>
      <PageTitle
        title="Connect Hyperliquid"
        sub="Two signatures from your wallet: one to approve our trading agent, one to approve the builder fee. Your funds never leave your Hyperliquid account."
      />
      <div className="space-y-5">
        <Card><ConnectFlow /></Card>
        <Card>
          <CardHeader title="Connected wallets" sub="Kill switch stops new trades and flattens positions on that account." />
          {error ? <div className="p-5"><ErrorNote message={error.message} /></div> : <BrokerAccounts accounts={(data ?? []) as BrokerAccount[]} />}
        </Card>
      </div>
    </>
  );
}
