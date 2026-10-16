import type { SupabaseClient } from "@supabase/supabase-js";
import { toCurve, type EquityPoint, type Strategy } from "@/components/types";

export type StrategyWithCurve = Strategy & { curve: EquityPoint[]; follower_count: number; live_follower_count: number };

type LeaderRow = {
  id: string; slug: string; name: string; description: string | null; symbol: string;
  market_name: string | null; asset_class: string | null; timeframe: Strategy["timeframe"];
  direction: Strategy["direction"]; risk_level: Strategy["risk_level"]; status: string;
  default_leverage: number; headline_metrics: Strategy["headline_metrics"]; published_at: string | null;
  follower_count: number | string | null; live_follower_count: number | string | null;
};

/** Downsample a curve for cards so pages stay light. */
export function thin(curve: EquityPoint[], n = 80): EquityPoint[] {
  if (curve.length <= n) return curve;
  const step = (curve.length - 1) / (n - 1);
  return Array.from({ length: n }, (_, i) => curve[Math.round(i * step)]);
}

/** Published strategies via strategy_leaderboard() plus the latest backtest's (thinned) equity curve. */
export async function loadPublished(
  sb: SupabaseClient,
  limit?: number,
): Promise<{ data: StrategyWithCurve[]; error: string | null }> {
  const { data, error } = await sb.rpc("strategy_leaderboard");
  if (error) return { data: [], error: error.message };
  let rows = ((data ?? []) as LeaderRow[])
    .filter((r) => r.status === "published")
    .sort((a, b) => (b.published_at ?? "").localeCompare(a.published_at ?? ""));
  if (limit) rows = rows.slice(0, limit);
  if (!rows.length) return { data: [], error: null };

  const { data: bts } = await sb
    .from("backtests")
    .select("strategy_id,equity_curve,created_at")
    .in("strategy_id", rows.map((r) => r.id))
    .order("created_at", { ascending: false });
  const curves = new Map<string, EquityPoint[]>();
  for (const b of (bts ?? []) as { strategy_id: string; equity_curve: unknown }[])
    if (!curves.has(b.strategy_id)) curves.set(b.strategy_id, thin(toCurve(b.equity_curve)));

  return {
    data: rows.map((r) => ({
      id: r.id, slug: r.slug, name: r.name, description: r.description, symbol: r.symbol,
      timeframe: r.timeframe, direction: r.direction, risk_level: r.risk_level, status: r.status,
      default_leverage: Number(r.default_leverage), headline_metrics: r.headline_metrics ?? {},
      published_at: r.published_at,
      entry_long: null, exit_long: null, entry_short: null, exit_short: null,
      stop_loss_pct: null, take_profit_pct: null, source: "", model_name: null, generation_meta: null,
      markets: { name: r.market_name ?? r.symbol, asset_class: r.asset_class ?? "", hl_coin: "" },
      follower_count: Number(r.follower_count ?? 0),
      live_follower_count: Number(r.live_follower_count ?? 0),
      curve: curves.get(r.id) ?? [],
    })),
    error: null,
  };
}
