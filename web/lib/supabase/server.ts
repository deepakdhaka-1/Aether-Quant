import "server-only";
import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";

/** Request-scoped client acting as the signed-in user (RLS applies). */
export async function supabaseServer() {
  const store = await cookies();
  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll: () => store.getAll(),
        setAll: (list) => {
          try {
            list.forEach(({ name, value, options }) => store.set(name, value, options));
          } catch {
            // Called from a Server Component: middleware refreshes the session instead.
          }
        },
      },
    },
  );
}

export async function requireUser() {
  const sb = await supabaseServer();
  const { data } = await sb.auth.getUser();
  return { sb, user: data.user };
}

export async function requireAdmin() {
  const { sb, user } = await requireUser();
  if (!user) return { sb, user: null, isAdmin: false };
  const { data } = await sb.from("profiles").select("role").eq("id", user.id).single();
  return { sb, user, isAdmin: data?.role === "admin" };
}
