// Loose row types for the UI. The database agent may later add lib/database.types.ts.
import type { Metrics } from "@/lib/format";

export type Strategy = {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  symbol: string;
  timeframe: "15m" | "1h" | "4h" | "1d";
  direction: "long" | "short" | "both";
  entry_long: string | null;
  exit_long: string | null;
  entry_short: string | null;
  exit_short: string | null;
  stop_loss_pct: number | null;
  take_profit_pct: number | null;
  default_leverage: number;
  risk_level: "low" | "medium" | "high";
  status: string;
  source: string;
  model_name: string | null;
  generation_meta: Record<string, unknown> | null;
  headline_metrics: Metrics | null;
  published_at: string | null;
  markets?: { name: string; asset_class: string; hl_coin: string } | null;
};

export type EquityPoint = [number, number];

export type BrokerAccount = {
  id: string;
  network: "mainnet" | "testnet";
  wallet_address: string;
  wallet_provider: string | null;
  agent_address: string;
  agent_approved: boolean;
  builder_approved: boolean;
  builder_max_fee: string | null;
  status: "pending" | "active" | "error" | "revoked";
  kill_switch: boolean;
  last_error: string | null;
  created_at: string;
};

export const SELECT_BROKER =
  "id,network,wallet_address,wallet_provider,agent_address,agent_approved,builder_approved,builder_max_fee,status,kill_switch,last_error,created_at";

export type Subscription = {
  id: string;
  strategy_id: string;
  broker_account_id: string;
  allocation_pct: number;
  leverage: number;
  mode: "paper" | "live";
  enabled: boolean;
};

export type Signal = {
  strategy_id?: string;
  bar_time: string;
  desired: "long" | "short" | "flat";
  price: number | null;
  reason?: string | null;
};

export type Trade = Record<string, unknown>;

export const SELECT_STRATEGY =
  "id,slug,name,description,symbol,timeframe,direction,entry_long,exit_long,entry_short,exit_short,stop_loss_pct,take_profit_pct,default_leverage,risk_level,status,source,model_name,generation_meta,headline_metrics,published_at,markets(name,asset_class,hl_coin)";

/** Supabase returns embedded to-one relations as object (or array on older typings). */
export function normStrategy(row: unknown): Strategy {
  const r = row as Strategy & { markets?: unknown };
  const m = Array.isArray(r.markets) ? r.markets[0] : r.markets;
  return { ...r, markets: (m as Strategy["markets"]) ?? null, headline_metrics: r.headline_metrics ?? {} };
}

/** Normalise a jsonb equity curve into sorted [epoch_s, equity] pairs. */
export function toCurve(raw: unknown): EquityPoint[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((p): EquityPoint | null => {
      if (Array.isArray(p) && p.length >= 2) return [Number(p[0]), Number(p[1])];
      if (p && typeof p === "object") {
        const o = p as Record<string, unknown>;
        const t = o.t ?? o.time ?? o.ts;
        const v = o.equity ?? o.v ?? o.value;
        if (t !== undefined && v !== undefined)
          return [typeof t === "string" ? Date.parse(t) / 1000 : Number(t), Number(v)];
      }
      return null;
    })
    .filter((p): p is EquityPoint => !!p && Number.isFinite(p[0]) && Number.isFinite(p[1]))
    .sort((a, b) => a[0] - b[0]);
}

export const assetLabel: Record<string, string> = {
  equity: "Equity",
  index: "Index",
  commodity: "Commodity",
  crypto: "Crypto",
};
