import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { LoginCard } from "@/components/auth/LoginCard";
import { Shell } from "@/components/landing/SiteChrome";
import { supabaseServer } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "Sign in" };

const safeNext = (n?: string) => (n && n.startsWith("/") && !n.startsWith("//") ? n : "/dashboard");

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string; ref?: string; error?: string }>;
}) {
  const sp = await searchParams;
  const next = safeNext(sp.next);
  const sb = await supabaseServer();
  const { data } = await sb.auth.getUser();
  if (data.user) redirect(next);

  return (
    <Shell>
      <div className="flex min-h-[calc(100svh-4rem)] items-center justify-center px-4 py-16 sm:py-20">
        <LoginCard next={next} referral={sp.ref} initialError={sp.error} />
      </div>
    </Shell>
  );
}
