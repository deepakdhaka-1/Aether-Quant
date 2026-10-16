// fees: builder-fee revenue ledger (hourly).
//
// For every active broker account, pull userFillsByTime since the last recorded fill and upsert one
// builder_fees row per fill that carries a builderFee (the field is omitted when 0; the fill's `fee`
// already includes it). Idempotent: fill_hash = "<tx hash>:<tid>" -- a tx hash alone is NOT unique
// (one taker order crossing several makers yields several fills with the same hash).
import { db, heartbeat, serve } from "../_shared/db.ts";
import { info, MAINNET, TESTNET } from "../_shared/hyperliquid.ts";
import { env } from "../_shared/env.ts";

const PAGE = 2000; // venue max per userFillsByTime response
const DEFAULT_LOOKBACK_MS = 30 * 86_400_000;

// deno-lint-ignore no-explicit-any
export function feeRows(fills: any[], brokerAccountId: string) {
  const rows = [];
  for (const f of fills) {
    const fee = Number(f.builderFee || 0);
    if (!(fee > 0)) continue;
    rows.push({
      broker_account_id: brokerAccountId, fill_hash: `${f.hash}:${f.tid}`, coin: f.coin,
      notional: Number(f.px || 0) * Number(f.sz || 0), fee_usd: fee, filled_at: new Date(Number(f.time)).toISOString(),
    });
  }
  return rows;
}

// deno-lint-ignore no-explicit-any
async function fetchFills(user: string, startMs: number, base: string): Promise<any[]> {
  // deno-lint-ignore no-explicit-any
  const out: any[] = [];
  for (;;) {
    // deno-lint-ignore no-explicit-any
    const page = await info<any[]>({ type: "userFillsByTime", user, startTime: startMs, endTime: Date.now() }, base) || [];
    out.push(...page);
    if (page.length < PAGE) return out;
    startMs = Math.max(...page.map((f) => Number(f.time))) + 1; // startTime is inclusive
  }
}

serve("fees", async () => {
  const sb = db();
  const { data: accounts, error } = await sb.from("broker_accounts").select("id, wallet_address, network").eq("status", "active");
  if (error) throw new Error(`accounts: ${error.message}`);
  let total = 0;
  const errors: string[] = [];
  for (const a of accounts ?? []) {
    try {
      const { data: last } = await sb.from("builder_fees").select("filled_at").eq("broker_account_id", a.id).order("filled_at", { ascending: false }).limit(1);
      const start = last?.length ? Date.parse(last[0].filled_at) : Date.now() - DEFAULT_LOOKBACK_MS;
      const base = a.network === "testnet" ? TESTNET : env("HYPERLIQUID_API_URL", MAINNET);
      const rows = feeRows(await fetchFills(a.wallet_address, start, base), a.id);
      if (rows.length) {
        const { error: e } = await sb.from("builder_fees").upsert(rows, { onConflict: "fill_hash", ignoreDuplicates: true });
        if (e) throw new Error(e.message);
      }
      total += rows.length;
    } catch (e) {
      errors.push(`${a.id}: ${(e as Error).message}`.slice(0, 200));
    }
  }
  const detail = { accounts: accounts?.length ?? 0, fee_rows: total, errors: errors.slice(0, 10) };
  await heartbeat("fees", detail);
  return detail;
});
