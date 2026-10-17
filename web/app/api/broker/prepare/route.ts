import { isAddress } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { encrypt } from "@/lib/crypto";
import { requireUser, supabaseAdmin } from "@/lib/supabase/server";
import { BUILDER_ADDRESS, BUILDER_MAX_FEE, isNetwork, json } from "../_lib";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Step 1 of connecting Hyperliquid: mint a fresh agent wallet for (user, wallet, network).
// The private key is encrypted at rest and never leaves the server.
export async function POST(req: Request) {
  const { user } = await requireUser();
  if (!user) return json({ error: "sign in first" }, 401);
  const body = (await req.json().catch(() => ({}))) as { wallet_address?: string; wallet_provider?: string; network?: string };
  const network = body.network ?? "mainnet";
  if (!body.wallet_address || !isAddress(body.wallet_address)) return json({ error: "valid wallet_address required" }, 400);
  if (!isNetwork(network)) return json({ error: "network must be mainnet or testnet" }, 400);
  if (!BUILDER_ADDRESS) return json({ error: "builder address not configured" }, 500);
  const wallet = body.wallet_address.toLowerCase();

  // Generate and encrypt before any database call. The plaintext key stays in this
  // server process and is never sent to Supabase, the browser, or the API response.
  const key = generatePrivateKey();
  const agent = privateKeyToAccount(key);
  if (agent.address.toLowerCase() === wallet) return json({ error: "agent collision, retry" }, 500);
  const agentSecretEnc = encrypt(key);

  const sb = supabaseAdmin();
  const { data: existing } = await sb
    .from("broker_accounts").select("id,user_id").eq("wallet_address", wallet).eq("network", network).maybeSingle();
  if (existing && existing.user_id !== user.id)
    return json({ error: "This wallet is already connected to another Aether Quant account." }, 409);

  const row = {
    user_id: user.id,
    network,
    wallet_address: wallet,
    wallet_provider: body.wallet_provider?.slice(0, 40) ?? null,
    agent_address: agent.address.toLowerCase(),
    agent_secret_enc: agentSecretEnc,
    // A new agent needs fresh approvals; reset state (builder approval is re-verified on submit).
    agent_approved: false,
    builder_approved: false,
    builder_max_fee: null,
    status: "pending",
    last_error: null,
    updated_at: new Date().toISOString(),
  };
  const q = existing
    ? sb.from("broker_accounts").update(row).eq("id", existing.id).select("id").single()
    : sb.from("broker_accounts").insert(row).select("id").single();
  const { data, error } = await q;
  if (error || !data) {
    // Lost a race with another user on the unique (wallet, network) constraint.
    if (error?.code === "23505") return json({ error: "This wallet is already connected to another Aether Quant account." }, 409);
    return json({ error: "could not save broker account" }, 500);
  }
  return json({
    broker_account_id: data.id,
    agent_address: row.agent_address,
    builder_address: BUILDER_ADDRESS,
    max_fee_rate: BUILDER_MAX_FEE,
    network,
  });
}
