"use client";

import { useMemo, useState } from "react";
import { SlidersHorizontal } from "lucide-react";
import { Empty, btn, cx } from "@/components/ui";
import { assetLabel } from "@/components/types";
import { StrategyCard } from "./StrategyCard";
import type { StrategyWithCurve } from "./data";

type SortKey = "return" | "sharpe" | "drawdown";

const select =
  "rounded-full border border-ink-700 bg-ink-900 px-3 py-1.5 text-xs text-mist-100 focus:border-aether/60 focus:outline-none";

export function Marketplace({ strategies }: { strategies: StrategyWithCurve[] }) {
  const [asset, setAsset] = useState("all");
  const [tf, setTf] = useState("all");
  const [risk, setRisk] = useState("all");
  const [dir, setDir] = useState("all");
  const [sort, setSort] = useState<SortKey>("return");

  const assets = useMemo(
    () => [...new Set(strategies.map((s) => s.markets?.asset_class).filter(Boolean) as string[])],
    [strategies],
  );

  const shown = useMemo(() => {
    const list = strategies.filter(
      (s) =>
        (asset === "all" || s.markets?.asset_class === asset) &&
        (tf === "all" || s.timeframe === tf) &&
        (risk === "all" || s.risk_level === risk) &&
        (dir === "all" || s.direction === dir),
    );
    const v = (s: StrategyWithCurve) => {
      const m = s.headline_metrics ?? {};
      if (sort === "return") return m.return_pct ?? -Infinity;
      if (sort === "sharpe") return m.sharpe ?? -Infinity;
      return m.max_drawdown_pct === undefined ? -Infinity : -Math.abs(m.max_drawdown_pct); // shallowest first
    };
    return [...list].sort((a, b) => v(b) - v(a));
  }, [strategies, asset, tf, risk, dir, sort]);

  const reset = () => { setAsset("all"); setTf("all"); setRisk("all"); setDir("all"); };
  const filtered = asset !== "all" || tf !== "all" || risk !== "all" || dir !== "all";

  return (
    <div>
      <div className="mb-5 flex flex-wrap items-center gap-2" role="group" aria-label="Filter strategies">
        <SlidersHorizontal className="h-4 w-4 text-mist-500" aria-hidden />
        <label className="sr-only" htmlFor="f-asset">Asset class</label>
        <select id="f-asset" className={select} value={asset} onChange={(e) => setAsset(e.target.value)}>
          <option value="all">All assets</option>
          {assets.map((a) => <option key={a} value={a}>{assetLabel[a] ?? a}</option>)}
        </select>
        <label className="sr-only" htmlFor="f-tf">Timeframe</label>
        <select id="f-tf" className={select} value={tf} onChange={(e) => setTf(e.target.value)}>
          <option value="all">Any timeframe</option>
          {["15m", "1h", "4h", "1d"].map((t) => <option key={t} value={t}>{t}</option>)}
        </select>
        <label className="sr-only" htmlFor="f-risk">Risk</label>
        <select id="f-risk" className={select} value={risk} onChange={(e) => setRisk(e.target.value)}>
          <option value="all">Any risk</option>
          <option value="low">Low risk</option>
          <option value="medium">Medium risk</option>
          <option value="high">High risk</option>
        </select>
        <label className="sr-only" htmlFor="f-dir">Direction</label>
        <select id="f-dir" className={select} value={dir} onChange={(e) => setDir(e.target.value)}>
          <option value="all">Any direction</option>
          <option value="both">Long & short</option>
          <option value="long">Long only</option>
          <option value="short">Short only</option>
        </select>
        <div className="ml-auto flex items-center gap-2">
          <label htmlFor="f-sort" className="text-xs text-mist-500">Sort</label>
          <select id="f-sort" className={select} value={sort} onChange={(e) => setSort(e.target.value as SortKey)}>
            <option value="return">Highest return</option>
            <option value="sharpe">Best Sharpe</option>
            <option value="drawdown">Smallest drawdown</option>
          </select>
        </div>
      </div>
      <p className="mb-4 font-mono text-[11px] text-mist-500" aria-live="polite">
        {shown.length} of {strategies.length} strategies
      </p>
      {shown.length ? (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
          {shown.map((s) => <StrategyCard key={s.id} s={s} />)}
        </div>
      ) : (
        <div className="rounded-2xl border border-ink-700">
          <Empty
            title="No strategies match these filters"
            action={filtered ? <button type="button" className={cx(btn.small)} onClick={reset}>Clear filters</button> : undefined}
          />
        </div>
      )}
    </div>
  );
}
