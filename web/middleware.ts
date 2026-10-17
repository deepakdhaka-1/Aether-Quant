import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

const PROTECTED = ["/dashboard", "/strategies", "/connect", "/settings", "/admin", "/api/broker", "/api/admin"];

const isProtected = (path: string) => PROTECTED.some((p) => path === p || path.startsWith(`${p}/`));

export async function middleware(req: NextRequest) {
  let res = NextResponse.next({ request: req });
  const sb = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll: () => req.cookies.getAll(),
        setAll: (list) => {
          list.forEach(({ name, value }) => req.cookies.set(name, value));
          res = NextResponse.next({ request: req });
          list.forEach(({ name, value, options }) => res.cookies.set(name, value, options));
        },
      },
    },
  );
  const { data } = await sb.auth.getUser();
  const path = req.nextUrl.pathname;
  if (!data.user && isProtected(path)) {
    if (path.startsWith("/api/")) return NextResponse.json({ error: "Authentication required" }, { status: 401 });
    const url = req.nextUrl.clone();
    url.pathname = "/login";
    url.searchParams.set("next", `${path}${req.nextUrl.search}`);
    return NextResponse.redirect(url);
  }
  if (data.user && isProtected(path)) {
    const { data: aal } = await sb.auth.mfa.getAuthenticatorAssuranceLevel();
    if (aal.nextLevel === "aal2" && aal.currentLevel !== "aal2") {
      if (path.startsWith("/api/")) return NextResponse.json({ error: "Authenticator verification required", code: "mfa_required" }, { status: 403 });
      const url = req.nextUrl.clone();
      url.pathname = "/verify-totp";
      url.search = "";
      url.searchParams.set("next", `${path}${req.nextUrl.search}`);
      return NextResponse.redirect(url);
    }
  }
  return res;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|brand/|api/auth).*)"],
};
