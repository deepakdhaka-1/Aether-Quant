import { HL_APP } from "@/lib/hyperliquid";
import { supabaseAdmin } from "@/lib/supabase/server";
import { json, ownedAccount } from "../_lib";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Stops all trading for this account. kill_switch makes the executor flatten open positions with
// reduce-only orders on its next pass; the subscriptions are disabled so nothing re-opens.
export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as { broker_account_id?: string };
  const r = await ownedAccount(body.broker_account_id);
  if ("error" in r) return r.error;
  const sb = supabaseAdmin();
  const { error } = await sb
    .from("broker_accounts")
    .update({ status: "revoked", kill_switch: true, updated_at: new Date().toISOString() })
    .eq("id", r.row.id);
  if (error) return json({ error: "could not revoke" }, 500);
  await sb.from("subscriptions").update({ enabled: false }).eq("broker_account_id", r.row.id);
  return json({
    status: "revoked",
    agent_address: r.row.agent_address,
    message:
      "Trading is stopped and any open positions are being closed. To remove our access on Hyperliquid as well, " +
      `open ${HL_APP[r.row.network]}/API, find the API wallet "AetherQuant" (${r.row.agent_address}) and remove it.`,
  });
}
