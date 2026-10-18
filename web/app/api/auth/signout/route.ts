import { NextResponse } from "next/server";
import { supabaseServer } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

// Server-side sign-out: revokes the session and clears the auth cookies on this response, so the
// server can never keep seeing a session the browser thinks it dropped.
export async function POST() {
  const sb = await supabaseServer();
  const { error } = await sb.auth.signOut();
  // Revocation can fail (expired/already-revoked session); still drop the local cookies.
  if (error) await sb.auth.signOut({ scope: "local" });
  return NextResponse.json({ ok: true });
}
