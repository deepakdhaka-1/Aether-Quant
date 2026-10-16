export const pct = (v: number | null | undefined, digits = 1) =>
  v === null || v === undefined || Number.isNaN(v) ? "—" : `${v > 0 ? "+" : ""}${v.toFixed(digits)}%`;

export const usd = (v: number | null | undefined) =>
  v === null || v === undefined ? "—" : v.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 });

export const short = (a?: string | null) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : "");

export const tone = (v: number | null | undefined) =>
  v === null || v === undefined ? "text-mist-300" : v >= 0 ? "text-aether" : "text-loss";

export type Metrics = {
  return_pct?: number;
  max_drawdown_pct?: number;
  sharpe?: number;
  trades?: number;
  win_rate?: number;
  profit_factor?: number | null;
};
