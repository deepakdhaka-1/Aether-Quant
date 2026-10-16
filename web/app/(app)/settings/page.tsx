import type { Metadata } from "next";
import Link from "next/link";
import { SignOutButton } from "@/components/app/AppNav";
import { BrokerAccounts } from "@/components/connect/BrokerAccounts";
import { ProfileForm, RiskForm, type Risk } from "@/components/settings/SettingsForms";
import { Card, CardHeader, ErrorNote, PageTitle, btn } from "@/components/ui";
import { SELECT_BROKER, type BrokerAccount } from "@/components/types";
import { requireUser } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "Settings" };

const DEFAULT_RISK: Risk = { max_daily_loss_pct: 5, max_drawdown_pct: 20, max_gross_leverage: 3, trading_enabled: true };

export default async function SettingsPage() {
  const { sb, user } = await requireUser();
  if (!user) return null;
  const [prof, risk, accts] = await Promise.all([
    sb.from("profiles").select("username,email,wallet_address,created_at").eq("id", user.id).maybeSingle(),
    sb.from("user_risk").select("max_daily_loss_pct,max_drawdown_pct,max_gross_leverage,trading_enabled").eq("user_id", user.id).maybeSingle(),
    sb.from("broker_accounts").select(SELECT_BROKER).order("created_at", { ascending: false }),
  ]);
  const p = prof.data;
  const email = p?.email && !String(p.email).endsWith("@wallet.aetherquant.local") ? String(p.email) : null;
  const r = risk.data
    ? {
        max_daily_loss_pct: Number(risk.data.max_daily_loss_pct),
        max_drawdown_pct: Number(risk.data.max_drawdown_pct),
        max_gross_leverage: Number(risk.data.max_gross_leverage),
        trading_enabled: !!risk.data.trading_enabled,
      }
    : DEFAULT_RISK;

  return (
    <>
      <PageTitle title="Settings" />
      <div className="grid gap-5 lg:grid-cols-2">
        <Card>
          <CardHeader title="Profile" />
          <dl className="grid grid-cols-[110px_1fr] gap-y-2 border-b border-ink-800 px-5 py-4 text-sm">
            <dt className="text-mist-500">Email</dt><dd className="truncate text-mist-100">{email ?? "—"}</dd>
            <dt className="text-mist-500">Sign-in wallet</dt><dd className="truncate font-mono text-xs text-mist-100">{p?.wallet_address ?? "—"}</dd>
          </dl>
          {prof.error ? <div className="p-5"><ErrorNote message={prof.error.message} /></div> : <ProfileForm username={(p?.username as string) ?? ""} />}
        </Card>
        <Card>
          <CardHeader title="Risk limits" sub="Applied to every account you own, on top of each strategy's stops." />
          {risk.error ? <div className="p-5"><ErrorNote message={risk.error.message} /></div> : <RiskForm initial={r} />}
        </Card>
        <Card className="lg:col-span-2">
          <CardHeader title="Connected wallets" action={<Link href="/connect" className={btn.small}>Connect another</Link>} />
          {accts.error ? <div className="p-5"><ErrorNote message={accts.error.message} /></div> : <BrokerAccounts accounts={(accts.data ?? []) as BrokerAccount[]} compact />}
        </Card>
        <Card className="lg:col-span-2">
          <div className="flex flex-wrap items-center justify-between gap-3 p-5">
            <p className="text-sm text-mist-400">Signing out doesn&apos;t stop your strategies. Use the kill switch for that.</p>
            <SignOutButton className={btn.ghost} />
          </div>
        </Card>
      </div>
    </>
  );
}
