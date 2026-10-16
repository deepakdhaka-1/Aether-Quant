import type { Strategy } from "@/components/types";

/** Make machine-ish rule expressions readable: crossover(a,b) -> "a crosses above b", && -> and, etc. */
export function humanize(rule: string): string {
  return rule
    .replace(/crossover\(\s*([^,]+?)\s*,\s*([^)]+?)\s*\)/gi, "$1 crosses above $2")
    .replace(/crossunder\(\s*([^,]+?)\s*,\s*([^)]+?)\s*\)/gi, "$1 crosses below $2")
    .replace(/\s*&&\s*|\s+AND\s+/g, " and ")
    .replace(/\s*\|\|\s*|\s+OR\s+/g, " or ")
    .replace(/\s*>=\s*/g, " is at least ")
    .replace(/\s*<=\s*/g, " is at most ")
    .replace(/\s*>\s*/g, " is above ")
    .replace(/\s*<\s*/g, " is below ")
    .replace(/\s*==\s*/g, " equals ")
    .replace(/\b(sma|ema|rsi|atr|adx|vwap|macd)\s*\(\s*([^)]*?)\s*\)/gi, (_, f: string, a: string) => `${f.toUpperCase()}(${a})`)
    .replace(/\bclose\b/gi, "price")
    .trim();
}

export function Rules({ s }: { s: Strategy }) {
  const rows: { label: string; rule: string | null; tone: string }[] = [];
  if (s.direction !== "short") rows.push({ label: "Enter long", rule: s.entry_long, tone: "text-aether" }, { label: "Exit long", rule: s.exit_long, tone: "text-mist-300" });
  if (s.direction !== "long") rows.push({ label: "Enter short", rule: s.entry_short, tone: "text-loss" }, { label: "Exit short", rule: s.exit_short, tone: "text-mist-300" });
  const visible = rows.filter((r) => r.rule);
  return (
    <div className="divide-y divide-ink-800">
      {visible.length === 0 && <p className="px-5 py-4 text-sm text-mist-400">Rules for this strategy haven&apos;t been published.</p>}
      {visible.map((r) => (
        <div key={r.label} className="grid gap-1 px-5 py-3.5 sm:grid-cols-[120px_1fr] sm:gap-4">
          <div className={`font-mono text-[11px] uppercase tracking-wider ${r.tone}`}>{r.label}</div>
          <div>
            <p className="text-sm text-mist-100">When {humanize(r.rule!)}</p>
            <code className="mt-1 block break-words font-mono text-[11px] text-mist-500">{r.rule}</code>
          </div>
        </div>
      ))}
      <div className="grid grid-cols-2 gap-4 px-5 py-3.5 sm:grid-cols-4">
        <Item label="Stop loss" value={s.stop_loss_pct ? `${s.stop_loss_pct}%` : "None"} />
        <Item label="Take profit" value={s.take_profit_pct ? `${s.take_profit_pct}%` : "None"} />
        <Item label="Default leverage" value={`${s.default_leverage}x`} />
        <Item label="Venue" value={s.markets?.hl_coin ?? s.symbol} />
      </div>
      <p className="px-5 py-3 text-[11px] text-mist-500">Stops and take-profits are placed on Hyperliquid as trigger orders, so they work even if our servers don&apos;t.</p>
    </div>
  );
}

function Item({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="font-mono text-[10px] uppercase tracking-wider text-mist-500">{label}</div>
      <div className="mt-0.5 font-mono text-sm text-mist-100">{value}</div>
    </div>
  );
}
