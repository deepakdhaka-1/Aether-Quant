import Link from "next/link";
import { ArrowUpRight } from "lucide-react";
import { Sparkline } from "@/components/charts/Sparkline";
import { Badge, cx } from "@/components/ui";
import { assetLabel } from "@/components/types";
import { pct, tone } from "@/lib/format";
import type { StrategyWithCurve } from "./data";

export const riskTone = { low: "good", medium: "warn", high: "bad" } as const;

export function StrategyCard({ s, href }: { s: StrategyWithCurve; href?: string }) {
  const m = s.headline_metrics ?? {};
  return (
    <Link
      href={href ?? `/strategies/${s.slug}`}
      className="group flex flex-col rounded-2xl border border-ink-700 bg-ink-900/70 p-5 transition hover:-translate-y-0.5 hover:border-aether/40 hover:shadow-glow focus-visible:outline focus-visible:outline-2 focus-visible:outline-aether"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 font-mono text-[11px] uppercase tracking-[0.18em] text-mist-500">
            <span className="text-aether">{s.symbol}</span>
            <span>·</span>
            <span>{s.timeframe}</span>
            {s.markets?.asset_class && (<><span>·</span><span>{assetLabel[s.markets.asset_class] ?? s.markets.asset_class}</span></>)}
          </div>
          <h3 className="mt-1.5 truncate text-base font-semibold text-mist-100">{s.name}</h3>
        </div>
        <ArrowUpRight className="h-4 w-4 shrink-0 text-mist-500 transition group-hover:text-aether" aria-hidden />
      </div>
      <Sparkline data={s.curve} className="mt-4 h-14 w-full" />
      <dl className="mt-4 grid grid-cols-3 gap-3 border-t border-ink-800 pt-4">
        <div>
          <dt className="font-mono text-[10px] uppercase tracking-wider text-mist-500">Return</dt>
          <dd className={cx("mt-0.5 font-mono text-sm", tone(m.return_pct))}>{pct(m.return_pct)}</dd>
        </div>
        <div>
          <dt className="font-mono text-[10px] uppercase tracking-wider text-mist-500">Sharpe</dt>
          <dd className="mt-0.5 font-mono text-sm text-mist-100">{m.sharpe?.toFixed(2) ?? "—"}</dd>
        </div>
        <div>
          <dt className="font-mono text-[10px] uppercase tracking-wider text-mist-500">Max DD</dt>
          <dd className="mt-0.5 font-mono text-sm text-loss">
            {m.max_drawdown_pct === undefined ? "—" : `${(-Math.abs(m.max_drawdown_pct)).toFixed(1)}%`}
          </dd>
        </div>
      </dl>
      <div className="mt-4 flex flex-wrap gap-1.5">
        <Badge tone={riskTone[s.risk_level] ?? "default"}>{s.risk_level} risk</Badge>
        <Badge>{s.direction === "both" ? "long/short" : `${s.direction} only`}</Badge>
        <Badge>{s.default_leverage}x</Badge>
        {s.follower_count > 0 && <Badge tone="good">{s.follower_count} following</Badge>}
      </div>
    </Link>
  );
}
