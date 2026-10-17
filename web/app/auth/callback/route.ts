import { NextResponse } from "next/server";
import { supabaseServer } from "@/lib/supabase/server";

function safeNext(value: string | null) {
  return value && value.startsWith("/") && !value.startsWith("//") && !value.startsWith("/\\")
    ? value
    : "/dashboard";
}

// OAuth, email confirmation, and password recovery links land here with a PKCE code.
export async function GET(req: Request) {
  const url = new URL(req.url);
  const next = safeNext(url.searchParams.get("next"));
  const authError = url.searchParams.get("error_description") ?? url.searchParams.get("error");
  if (authError) {
    const target = next === "/reset-password" ? "/reset-password" : "/login";
    const redirect = new URL(target, url.origin);
    redirect.searchParams.set("error", authError.slice(0, 240));
    return NextResponse.redirect(redirect);
  }

  const code = url.searchParams.get("code");
  if (code) {
    const sb = await supabaseServer();
    const { error } = await sb.auth.exchangeCodeForSession(code);
    if (error) {
      const target = next === "/reset-password" ? "/reset-password" : "/login";
      const redirect = new URL(target, url.origin);
      redirect.searchParams.set("error", "This link is invalid or has expired. Please request a new one.");
      return NextResponse.redirect(redirect);
    }
  }
  return NextResponse.redirect(new URL(next, url.origin));
}
