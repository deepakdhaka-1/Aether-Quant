import { NextResponse } from "next/server";
import { isAddress } from "viem";
import { signInMessage } from "@/lib/auth";
import { supabaseAdmin } from "@/lib/supabase/server";

export async function POST(req: Request) {
  const { address } = (await req.json().catch(() => ({}))) as { address?: string };
  if (!address || !isAddress(address)) return NextResponse.json({ error: "valid wallet address required" }, { status: 400 });
  const wallet = address.toLowerCase();
  const sb = supabaseAdmin();
  await sb.from("wallet_nonces").delete().eq("wallet_address", wallet).lt("expires_at", new Date().toISOString());
  const nonce = crypto.randomUUID();
  const issuedAt = new Date().toISOString();
  const { error } = await sb.from("wallet_nonces").insert({ wallet_address: wallet, nonce, issued_at: issuedAt });
  if (error) return NextResponse.json({ error: "could not create nonce" }, { status: 500 });
  const host = new URL(req.url).host;
  return NextResponse.json({ nonce, message: signInMessage(wallet, nonce, issuedAt, host) });
}
