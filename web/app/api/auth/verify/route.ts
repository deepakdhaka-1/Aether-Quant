import { NextResponse } from "next/server";
import { isAddress, verifyMessage } from "viem";
import { supabaseAdmin } from "@/lib/supabase/server";
import { signInMessage } from "@/lib/auth";

// Wallet sign-in (EVM wallet auth): verify the personal_sign
// signature over our nonce message, find-or-create the user, and hand back a one-time magic-link
// token hash the browser exchanges for a normal Supabase session (supabase.auth.verifyOtp).
export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as { address?: string; nonce?: string; signature?: `0x${string}`; referral?: string };
  const { address, nonce, signature } = body;
  if (!address || !isAddress(address) || !nonce || !signature)
    return NextResponse.json({ error: "address, nonce and signature required" }, { status: 400 });
  const wallet = address.toLowerCase();
  const sb = supabaseAdmin();

  const { data: rec } = await sb.from("wallet_nonces").select("*").eq("nonce", nonce).eq("wallet_address", wallet).maybeSingle();
  if (!rec) return NextResponse.json({ error: "invalid or used nonce" }, { status: 401 });
  await sb.from("wallet_nonces").delete().eq("id", rec.id); // single use, even on failure
  if (new Date(rec.expires_at) < new Date()) return NextResponse.json({ error: "nonce expired" }, { status: 401 });

  const message = signInMessage(wallet, nonce, rec.issued_at, new URL(req.url).host);
  const ok = await verifyMessage({ address: wallet as `0x${string}`, message, signature }).catch(() => false);
  if (!ok) return NextResponse.json({ error: "signature does not match wallet" }, { status: 401 });

  const email = `${wallet}@wallet.aetherquant.local`;
  const { data: prof } = await sb.from("profiles").select("id").eq("wallet_address", wallet).maybeSingle();
  if (!prof) {
    // app_metadata is server-only; the DB binds the wallet from it and reserves the e-mail domain.
    const { error } = await sb.auth.admin.createUser({
      email,
      email_confirm: true,
      app_metadata: { wallet_address: wallet },
      user_metadata: { username: `${wallet.slice(0, 8)}`, referral_code: body.referral ?? null },
    });
    if (error) return NextResponse.json({ error: "could not create user" }, { status: 500 });
  }

  const { data: link, error: linkErr } = await sb.auth.admin.generateLink({ type: "magiclink", email });
  if (linkErr || !link?.properties?.hashed_token) return NextResponse.json({ error: "could not create session" }, { status: 500 });
  return NextResponse.json({ token_hash: link.properties.hashed_token });
}
