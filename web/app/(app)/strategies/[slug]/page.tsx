import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { EquityChart } from "@/components/charts/EquityChart";
import { FollowPanel } from "@/components/strategies/FollowPanel";
import { Rules } from "@/components/strategies/Rules";
import { riskTone } from "@/components/strategies/StrategyCard";
import { Badge, Card, CardHeader, Empty, SignalPill, Stat, cx, fmtDate, num } from "@/components/ui";
import {
  SELECT_BROKER,
  SELECT_STRATEGY,
  assetLabel,
  normStrategy,
  toCurve,
  type BrokerAccount,
  type Signal,
  type Subscription,
  type Trade,
} from "@/components/types";
import { requireUser } from "@/lib/supabase/server";
import { pct, tone, type Metrics } from "@/lib/format";

type Params = { params: Promise<{ slug: string }> };

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { slug } = await params;
  return { title: slug.replace(/-/g, " ") };
}

const pickMetrics = (o: unknown): Metrics | null => {
  if (!o || typeof o !== "object") return null;
  const r = o as Record<string, unknown>;
  const m = (r.metrics && typeof r.metrics === "object" ? r.metrics : r) as Record<string, unknown>;
  const n = (k: string, ...alt: string[]) => {
    for (const key of [k, ...alt]) if (typeof m[key] === "number") return m[key] as number;
    return undefined;
  };
  const out: Metrics = {
    return_pct: n("return_pct", "total_return_pct"),
    max_drawdown_pct: n("max_drawdown_pct", "max_dd_pct"),
    sharpe: n("sharpe"),
    trades: n("trades", "num_trades"),
    win_rate: n("win_rate"),
    profit_factor: n("profit_factor", "pf") ?? null,
  };
  return Object.values(out).some((v) => v !== undefined && v !== null) ? out : null;
};

function MetricsGrid({ m }: { m: Metrics }) {
  const wr = m.win_rate === undefined ? "—" : `${(m.win_rate <= 1 ? m.win_rate * 100 : m.win_rate).toFixed(1)}%`;
  return (
    <div className="grid grid-cols-2 gap-x-4 gap-y-5 p-5 sm:grid-cols-3 lg:grid-cols-6">
      <Stat label="Return" value={<span className={tone(m.return_pct)}>{pct(m.return_pct)}</span>} />
      <Stat label="Sharpe" value={m.sharpe?.toFixed(2) ?? "—"} />
      <Stat label="Max drawdown" value={<span className="text-loss">{m.max_drawdown_pct === undefined ? "—" : `${(-Math.abs(m.max_drawdown_pct)).toFixed(1)}%`}</span>} />
      <Stat label="Win rate" value={wr} />
      <Stat label="Profit factor" value={m.profit_factor ? m.profit_factor.toFixed(2) : "—"} />
      <Stat label="Trades" value={m.trades ?? "—"} />
    </div>
  );
}

const TRADE_COLS = ["entry_time", "exit_time", "side", "entry_price", "exit_price", "pnl_pct", "reason"];

function TradeTable({ trades }: { trades: Trade[] }) {
  const keys = Object.keys(trades[0] ?? {});
  const cols = TRADE_COLS.filter((c) => keys.includes(c));
  const use = cols.length >= 3 ? cols : keys.slice(0, 6);
  const cell = (k: string, v: unknown) => {
    if (v === null || v === undefined) return "—";
    if (/time|date|_at$/.test(k)) return fmtDate(v as string | number);
    if (k === "pnl_pct" && typeof v === "number") return <span className={tone(v)}>{pct(v, 2)}</span>;
    if (k === "side") return <SignalPill desired={String(v) === "buy" ? "long" : String(v) === "sell" ? "short" : String(v)} />;
    if (typeof v === "number") return num(v, 4);
    return String(v);
  };
  return (
    <div className="max-h-[420px] overflow-auto">
      <table className="w-full min-w-[560px] text-left text-xs">
        <thead className="sticky top-0 bg-ink-900 font-mono text-[10px] uppercase tracking-wider text-mist-500">
          <tr>{use.map((c) => <th key={c} scope="col" className="px-5 py-2.5 font-normal">{c.replace(/_/g, " ")}</th>)}</tr>
        </thead>
        <tbody className="divide-y divide-ink-800 font-mono text-mist-300">
          {trades.slice(-100).reverse().map((t, i) => (
            <tr key={i}>{use.map((c) => <td key={c} className="whitespace-nowrap px-5 py-2">{cell(c, t[c])}</td>)}</tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default async function StrategyDetail({ params }: Params) {
  const { slug } = await params;
  const { sb, user } = await requireUser();
  const { data: row, error } = await sb.from("strategies").select(SELECT_STRATEGY).eq("slug", slug).maybeSingle();
  if (error) throw new Error(error.message);
  if (!row) notFound();
  const s = normStrategy(row);

  const [bt, sig, accts, subs] = await Promise.all([
    sb.from("backtests").select("metrics,equity_curve,trades,period_start,period_end,created_at").eq("strategy_id", s.id).order("created_at", { ascending: false }).limit(1).maybeSingle(),
    sb.from("strategy_signals").select("bar_time,desired,price,reason").eq("strategy_id", s.id).order("bar_time", { ascending: false }).limit(12),
    user ? sb.from("broker_accounts").select(SELECT_BROKER).order("created_at") : Promise.resolve({ data: [] }),
    user ? sb.from("subscriptions").select("id,strategy_id,broker_account_id,allocation_pct,leverage,mode,enabled").eq("strategy_id", s.id) : Promise.resolve({ data: [] }),
  ]);

  const backtest = bt.data;
  const curve = toCurve(backtest?.equity_curve);
  const trades = (Array.isArray(backtest?.trades) ? backtest.trades : []) as Trade[];
  const metrics = pickMetrics(backtest?.metrics) ?? s.headline_metrics ?? {};
  const signals = (sig.data ?? []) as Signal[];
  const meta = (s.generation_meta ?? {}) as Record<string, unknown>;
  const findKey = (re: RegExp) => Object.keys(meta).find((k) => re.test(k));
  const isKey = findKey(/^(in_?sample|is|train(ing)?)(_metrics)?$/i);
  const oosKey = findKey(/^(out_?of_?sample|oos|test|validation)(_metrics)?$/i);
  const isM = isKey ? pickMetrics(meta[isKey]) : null;
  const oosM = oosKey ? pickMetrics(meta[oosKey]) : null;

  return (
    <>
      <Link href="/strategies" className="mb-4 inline-flex items-center gap-1.5 text-xs text-mist-400 hover:text-aether">
        <ArrowLeft className="h-3.5 w-3.5" aria-hidden /> All strategies
      </Link>
      <div className="mb-6">
        <div className="flex flex-wrap items-center gap-2 font-mono text-[11px] uppercase tracking-[0.18em] text-mist-500">
          <span className="text-aether">{s.symbol}</span><span>·</span><span>{s.markets?.name ?? s.symbol}</span><span>·</span><span>{s.timeframe}</span>
          {s.markets?.asset_class && (<><span>·</span><span>{assetLabel[s.markets.asset_class] ?? s.markets.asset_class}</span></>)}
        </div>
        <h1 className="mt-2 text-2xl font-semibold tracking-tight sm:text-3xl">{s.name}</h1>
        {s.description && <p className="mt-2 max-w-3xl text-sm leading-relaxed text-mist-300">{s.description}</p>}
        <div className="mt-3 flex flex-wrap gap-1.5">
          <Badge tone={riskTone[s.risk_level] ?? "default"}>{s.risk_level} risk</Badge>
          <Badge>{s.direction === "both" ? "long/short" : `${s.direction} only`}</Badge>
          {s.status !== "published" && <Badge tone="warn">{s.status}</Badge>}
          {s.model_name && <Badge>model · {s.model_name}</Badge>}
        </div>
      </div>

      <div className="grid gap-5 lg:grid-cols-[1fr_340px]">
        <div className="min-w-0 space-y-5">
          <Card>
            <CardHeader
              title="Backtest equity"
              sub={backtest ? `${fmtDate(backtest.period_start, false)} to ${fmtDate(backtest.period_end, false)} · hover for details` : undefined}
            />
            <div className="p-3 sm:p-5"><EquityChart data={curve} /></div>
            <div className="border-t border-ink-800"><MetricsGrid m={metrics} /></div>
          </Card>

          <Card>
            <CardHeader title="In-sample vs out-of-sample" sub="Out-of-sample data was never seen while the strategy was generated." />
            {isM || oosM ? (
              <div className="grid divide-y divide-ink-800 md:grid-cols-2 md:divide-x md:divide-y-0">
                {[["In-sample", isM], ["Out-of-sample", oosM]].map(([label, m]) => (
                  <div key={label as string}>
                    <div className="px-5 pt-4 font-mono text-[11px] uppercase tracking-wider text-mist-400">{label as string}</div>
                    {m ? <MetricsGridCompact m={m as Metrics} /> : <p className="px-5 py-4 text-sm text-mist-500">Not reported.</p>}
                  </div>
                ))}
              </div>
            ) : (
              <p className="px-5 py-4 text-sm text-mist-400">This strategy has no separate in-sample / out-of-sample report.</p>
            )}
          </Card>

          <Card>
            <CardHeader title="Rules" />
            <Rules s={s} />
          </Card>

          <Card>
            <CardHeader title="Backtest trades" sub={trades.length ? `${trades.length} trades${trades.length > 100 ? " · latest 100 shown" : ""}` : undefined} />
            {trades.length ? <TradeTable trades={trades} /> : <Empty title="No trades recorded">The latest backtest didn&apos;t store a trade list.</Empty>}
          </Card>
        </div>

        <div className="space-y-5 lg:sticky lg:top-20 lg:self-start">
          <Card>
            <CardHeader title="Follow" />
            {user ? (
              <FollowPanel
                strategyId={s.id}
                defaultLeverage={Number(s.default_leverage)}
                accounts={(accts.data ?? []) as BrokerAccount[]}
                subs={(subs.data ?? []) as Subscription[]}
                userId={user.id}
              />
            ) : null}
          </Card>
          <Card>
            <CardHeader title="Recent signals" />
            {signals.length ? (
              <ul className="divide-y divide-ink-800">
                {signals.map((g) => (
                  <li key={g.bar_time} className="flex items-center justify-between gap-3 px-5 py-2.5 text-xs">
                    <span className="font-mono text-mist-400">{fmtDate(g.bar_time)}</span>
                    <span className="flex items-center gap-2">
                      <span className="font-mono text-mist-300">{num(g.price, 4)}</span>
                      <SignalPill desired={g.desired} />
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <Empty title="No live signals yet">Signals appear here once the strategy runs on each closed {s.timeframe} bar.</Empty>
            )}
          </Card>
        </div>
      </div>
    </>
  );
}

function MetricsGridCompact({ m }: { m: Metrics }) {
  return (
    <div className={cx("grid grid-cols-3 gap-4 p-5")}>
      <Stat label="Return" value={<span className={tone(m.return_pct)}>{pct(m.return_pct)}</span>} />
      <Stat label="Sharpe" value={m.sharpe?.toFixed(2) ?? "—"} />
      <Stat label="Max DD" value={m.max_drawdown_pct === undefined ? "—" : `${(-Math.abs(m.max_drawdown_pct)).toFixed(1)}%`} />
    </div>
  );
}
