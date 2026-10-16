import type { Metadata } from "next";
import Link from "next/link";
import { Sparkline } from "@/components/charts/Sparkline";
import { Badge, Banner, Card, CardHeader, Empty, ErrorNote, PageTitle, SignalPill, Stat, btn, fmtDate, num } from "@/components/ui";
import { SELECT_BROKER, type BrokerAccount, type EquityPoint } from "@/components/types";
import { requireUser } from "@/lib/supabase/server";
import { usd, tone } from "@/lib/format";

export const metadata: Metadata = { title: "Dashboard" };

type Summary = { total_equity: number; unrealized_pnl: number; open_positions: number; followed_strategies: number; broker_accounts: number; equity_as_of: string | null };

/** Sum per-account snapshots into one series, carrying each account's last value forward. */
function combine(rows: { broker_account_id: string; equity: number; created_at: string }[]): EquityPoint[] {
  const last = new Map<string, number>();
  const out: EquityPoint[] = [];
  for (const r of rows) {
    last.set(r.broker_account_id, Number(r.equity));
    const t = Math.floor(Date.parse(r.created_at) / 1000);
    const total = [...last.values()].reduce((a, b) => a + b, 0);
    if (out.length && t - out[out.length - 1][0] < 60) out[out.length - 1] = [t, total];
    else out.push([t, total]);
  }
  return out;
}

export default async function Dashboard() {
  const { sb, user } = await requireUser();
  if (!user) return null;
  const since = new Date(Date.now() - 30 * 86400_000).toISOString();

  const [sum, accts, snaps, pos, ords, subs] = await Promise.all([
    sb.rpc("my_portfolio_summary"),
    sb.from("broker_accounts").select(SELECT_BROKER),
    sb.from("account_snapshots").select("broker_account_id,equity,created_at").gte("created_at", since).order("created_at").limit(5000),
    sb.from("positions").select("broker_account_id,symbol,side,qty,entry_price,mark_price,unrealized_pnl,updated_at,strategies(name,slug)").neq("qty", 0).order("symbol"),
    sb.from("orders").select("id,symbol,side,qty,price,status,error,reduce_only,created_at").order("created_at", { ascending: false }).limit(12),
    sb.from("subscriptions").select("id,strategy_id,mode,enabled,allocation_pct,leverage,strategies(name,slug,symbol,timeframe)").order("created_at"),
  ]);

  const summary = (Array.isArray(sum.data) ? sum.data[0] : sum.data) as Summary | null;
  const accounts = (accts.data ?? []) as BrokerAccount[];
  const curve = combine((snaps.data ?? []) as { broker_account_id: string; equity: number; created_at: string }[]);
  type Sub = { id: string; strategy_id: string; mode: string; enabled: boolean; allocation_pct: number; leverage: number; strategies: { name: string; slug: string; symbol: string; timeframe: string } | { name: string; slug: string; symbol: string; timeframe: string }[] | null };
  const followed = ((subs.data ?? []) as Sub[]).map((s) => ({ ...s, strategy: Array.isArray(s.strategies) ? s.strategies[0] : s.strategies }));

  const ids = [...new Set(followed.map((s) => s.strategy_id))];
  const latestSignal = new Map<string, { desired: string; bar_time: string; price: number | null }>();
  if (ids.length) {
    const { data: sig } = await sb.from("strategy_signals").select("strategy_id,desired,bar_time,price").in("strategy_id", ids).order("bar_time", { ascending: false }).limit(ids.length * 5);
    for (const g of (sig ?? []) as { strategy_id: string; desired: string; bar_time: string; price: number | null }[])
      if (!latestSignal.has(g.strategy_id)) latestSignal.set(g.strategy_id, g);
  }

  const live = accounts.filter((a) => a.status !== "revoked");
  const killed = live.filter((a) => a.kill_switch);
  const anyLiveActive = live.some((a) => a.status === "active");
  const allPaper = followed.length > 0 && followed.every((s) => s.mode === "paper");
  const change = curve.length > 1 ? curve[curve.length - 1][1] - curve[0][1] : null;
  const firstErr = sum.error ?? accts.error ?? pos.error ?? ords.error ?? subs.error;

  return (
    <>
      <PageTitle title="Dashboard" sub="Your accounts, positions and the strategies you follow." />
      <div className="mb-5 space-y-3">
        {firstErr && <ErrorNote message={firstErr.message} />}
        {!live.length && (
          <Banner action={<Link href="/connect" className={btn.primary}>Connect wallet</Link>}>
            Connect your Hyperliquid wallet to start following strategies. Two signatures, you keep custody.
          </Banner>
        )}
        {killed.length > 0 && (
          <Banner tone="bad" action={<Link href="/connect" className={btn.small}>Manage</Link>}>
            Kill switch active on {killed.length === 1 ? "1 account" : `${killed.length} accounts`}. No new trades are placed there and open positions are being closed.
          </Banner>
        )}
        {live.length > 0 && !anyLiveActive && (
          <Banner tone="warn" action={<Link href="/connect" className={btn.small}>Finish setup</Link>}>
            Your wallet approvals aren&apos;t complete yet, so only paper trading is available.
          </Banner>
        )}
        {allPaper && (
          <Banner tone="warn">Paper mode: every strategy you follow is simulated. No real orders are sent until you switch a follow to live.</Banner>
        )}
      </div>

      <div className="grid gap-5 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <div className="flex flex-wrap items-end justify-between gap-4 p-5">
            <div>
              <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-mist-500">Total equity</div>
              <div className="mt-1 font-mono text-3xl text-mist-100 sm:text-4xl">{usd(summary?.total_equity ?? 0)}</div>
              <div className="mt-1 text-xs text-mist-500">
                {change !== null && <span className={tone(change)}>{change >= 0 ? "+" : ""}{usd(change)} · 30d </span>}
                {summary?.equity_as_of ? `as of ${fmtDate(summary.equity_as_of)}` : "No snapshots yet"}
              </div>
            </div>
            <div className="grid grid-cols-3 gap-6">
              <Stat label="Unrealized" value={<span className={tone(summary?.unrealized_pnl)}>{usd(summary?.unrealized_pnl ?? 0)}</span>} />
              <Stat label="Positions" value={summary?.open_positions ?? 0} />
              <Stat label="Following" value={summary?.followed_strategies ?? 0} />
            </div>
          </div>
          <div className="px-5 pb-5"><Sparkline data={curve} height={90} className="h-24 w-full" /></div>
        </Card>

        <Card>
          <CardHeader title="Followed strategies" action={<Link href="/strategies" className="text-xs text-aether hover:underline">Browse</Link>} />
          {followed.length ? (
            <ul className="divide-y divide-ink-800">
              {followed.map((f) => {
                const g = latestSignal.get(f.strategy_id);
                return (
                  <li key={f.id} className="flex items-center justify-between gap-3 px-5 py-3">
                    <div className="min-w-0">
                      <Link href={`/strategies/${f.strategy?.slug ?? ""}`} className="block truncate text-sm text-mist-100 hover:text-aether">{f.strategy?.name ?? "Strategy"}</Link>
                      <div className="font-mono text-[10px] uppercase tracking-wider text-mist-500">
                        {f.strategy?.symbol} · {Math.round(f.allocation_pct * 100)}% · {f.leverage}x · {f.enabled ? f.mode : "paused"}
                      </div>
                    </div>
                    <div className="text-right">
                      <SignalPill desired={g?.desired} />
                      {g && <div className="mt-1 font-mono text-[10px] text-mist-500">{fmtDate(g.bar_time)}</div>}
                    </div>
                  </li>
                );
              })}
            </ul>
          ) : (
            <Empty title="Not following anything yet" action={<Link href="/strategies" className={btn.small}>Find a strategy</Link>}>
              Start in paper mode to watch a strategy trade before committing funds.
            </Empty>
          )}
        </Card>

        <Card className="lg:col-span-3">
          <CardHeader title="Open positions" />
          {(pos.data ?? []).length ? (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[640px] text-left text-xs">
                <thead className="font-mono text-[10px] uppercase tracking-wider text-mist-500">
                  <tr>{["Market", "Side", "Size", "Entry", "Mark", "Unrealized PnL", "Strategy"].map((h) => <th key={h} scope="col" className="px-5 py-2.5 font-normal">{h}</th>)}</tr>
                </thead>
                <tbody className="divide-y divide-ink-800 font-mono text-mist-300">
                  {(pos.data ?? []).map((p) => {
                    const st = (Array.isArray(p.strategies) ? p.strategies[0] : p.strategies) as { name: string; slug: string } | null;
                    return (
                      <tr key={`${p.broker_account_id}-${p.symbol}`}>
                        <td className="px-5 py-2.5 text-mist-100">{p.symbol}</td>
                        <td className="px-5 py-2.5"><SignalPill desired={p.side as string} /></td>
                        <td className="px-5 py-2.5">{num(p.qty, 4)}</td>
                        <td className="px-5 py-2.5">{num(p.entry_price, 4)}</td>
                        <td className="px-5 py-2.5">{num(p.mark_price, 4)}</td>
                        <td className={`px-5 py-2.5 ${tone(p.unrealized_pnl as number)}`}>{usd(p.unrealized_pnl as number)}</td>
                        <td className="px-5 py-2.5">{st ? <Link className="hover:text-aether" href={`/strategies/${st.slug}`}>{st.name}</Link> : "—"}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          ) : (
            <Empty title="No open positions">Positions appear here when a followed strategy enters a trade.</Empty>
          )}
        </Card>

        <Card className="lg:col-span-3">
          <CardHeader title="Recent orders" />
          {(ords.data ?? []).length ? (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[640px] text-left text-xs">
                <thead className="font-mono text-[10px] uppercase tracking-wider text-mist-500">
                  <tr>{["Time", "Market", "Side", "Qty", "Price", "Status"].map((h) => <th key={h} scope="col" className="px-5 py-2.5 font-normal">{h}</th>)}</tr>
                </thead>
                <tbody className="divide-y divide-ink-800 font-mono text-mist-300">
                  {(ords.data ?? []).map((o) => (
                    <tr key={o.id as number}>
                      <td className="whitespace-nowrap px-5 py-2.5">{fmtDate(o.created_at as string)}</td>
                      <td className="px-5 py-2.5 text-mist-100">{o.symbol as string}</td>
                      <td className={`px-5 py-2.5 ${o.side === "buy" ? "text-aether" : "text-loss"}`}>{o.side as string}{o.reduce_only ? " · reduce" : ""}</td>
                      <td className="px-5 py-2.5">{num(o.qty, 4)}</td>
                      <td className="px-5 py-2.5">{num(o.price, 4)}</td>
                      <td className="px-5 py-2.5" title={(o.error as string) ?? undefined}>
                        <Badge tone={o.status === "filled" ? "good" : o.status === "rejected" ? "bad" : o.status === "partial" ? "warn" : "default"}>
                          {(o.status as string).replace("_", "-")}
                        </Badge>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <Empty title="No orders yet">Orders, including paper and dry-run fills, are listed here.</Empty>
          )}
        </Card>
      </div>
    </>
  );
}
