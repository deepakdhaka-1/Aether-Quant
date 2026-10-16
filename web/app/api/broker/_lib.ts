import "server-only";
import { NextResponse } from "next/server";
import { HL_API, HL_APP, hlInfo, feeRateToBps10, type Network } from "@/lib/hyperliquid";
import { requireUser, supabaseAdmin } from "@/lib/supabase/server";

export const BUILDER_ADDRESS = (process.env.NEXT_PUBLIC_BUILDER_ADDRESS ?? "").toLowerCase();
export const BUILDER_MAX_FEE = process.env.NEXT_PUBLIC_BUILDER_MAX_FEE ?? "0.05%";

export const json = (body: unknown, status = 200) => NextResponse.json(body, { status });
export const isNetwork = (n: unknown): n is Network => n === "mainnet" || n === "testnet";

export type BrokerRow = {
  id: string;
  user_id: string;
  network: Network;
  wallet_address: string;
  agent_address: string;
  agent_approved: boolean;
  builder_approved: boolean;
  builder_max_fee: string | null;
  status: string;
  kill_switch: boolean;
};

const COLS =
  "id,user_id,network,wallet_address,agent_address,agent_approved,builder_approved,builder_max_fee,status,kill_switch";

/** Signed-in user + the broker row they own, or an error response. Never selects the agent secret. */
export async function ownedAccount(id: unknown): Promise<{ row: BrokerRow; userId: string } | { error: NextResponse }> {
  const { user } = await requireUser();
  if (!user) return { error: json({ error: "sign in first" }, 401) };
  if (typeof id !== "string" || !id) return { error: json({ error: "broker_account_id required" }, 400) };
  const { data } = await supabaseAdmin().from("broker_accounts").select(COLS).eq("id", id).maybeSingle();
  if (!data || data.user_id !== user.id) return { error: json({ error: "broker account not found" }, 404) };
  return { row: data as BrokerRow, userId: user.id };
}

type ExtraAgent = { name?: string; address: string; validUntil?: number };

/** Ask Hyperliquid what is actually approved, then persist it. Source of truth is the venue. */
export async function verifyOnChain(row: BrokerRow, lastError: string | null = null) {
  const [agents, maxFee] = await Promise.all([
    hlInfo<ExtraAgent[]>(row.network, { type: "extraAgents", user: row.wallet_address }),
    BUILDER_ADDRESS
      ? hlInfo<number>(row.network, { type: "maxBuilderFee", user: row.wallet_address, builder: BUILDER_ADDRESS })
      : Promise.resolve(0),
  ]);
  const now = Date.now();
  const agent = (agents ?? []).find((a) => a.address?.toLowerCase() === row.agent_address.toLowerCase());
  const agentApproved = !!agent && (!agent.validUntil || agent.validUntil > now);
  // Approved rate must cover what the engine actually charges (BUILDER_FEE_BPS10 <= configured max).
  const builderApproved = Number(maxFee ?? 0) >= feeRateToBps10(BUILDER_MAX_FEE);
  const bothOk = agentApproved && builderApproved;
  const update = {
    agent_approved: agentApproved,
    builder_approved: builderApproved,
    builder_max_fee: Number(maxFee) > 0 ? `${Number(maxFee) / 1000}%` : null,
    status: row.status === "revoked" ? "revoked" : bothOk ? "active" : lastError ? "error" : "pending",
    last_error: lastError,
    updated_at: new Date().toISOString(),
  };
  await supabaseAdmin().from("broker_accounts").update(update).eq("id", row.id);
  return { ...update, agent_valid_until: agent?.validUntil ?? null };
}

/** Hyperliquid error strings -> something a user can act on. */
export function friendlyError(raw: string, network: Network): string {
  const s = raw.toLowerCase();
  if (s.includes("deposit")) return `Deposit USDC on Hyperliquid first (${HL_APP[network]}), then try again.`;
  if (s.includes("extra agent") || s.includes("too many agents") || s.includes("max number"))
    return "Your wallet has too many API wallets. Remove an unused one under More > API on Hyperliquid, then try again.";
  if (s.includes("nonce")) return "That signature has expired. Please sign again.";
  if (s.includes("chain")) return "Your wallet signed for the wrong network. Switch networks and sign again.";
  if (s.includes("builder") && s.includes("fee")) return "The builder fee approval was rejected by Hyperliquid.";
  if (s.includes("does not exist") || s.includes("signature"))
    return "Hyperliquid could not match the signature to your wallet. Please sign again with the connected wallet.";
  return `Hyperliquid rejected the request: ${raw.slice(0, 200)}`;
}

export async function relay(network: Network, payload: unknown): Promise<{ ok: boolean; error?: string }> {
  const r = await fetch(`${HL_API[network]}/exchange`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
    cache: "no-store",
  });
  const text = await r.text();
  let body: { status?: string; response?: unknown } | null = null;
  try {
    body = JSON.parse(text);
  } catch {
    /* non-JSON error */
  }
  if (r.ok && body?.status === "ok") return { ok: true };
  const err = typeof body?.response === "string" ? body.response : text || `HTTP ${r.status}`;
  return { ok: false, error: err };
}
