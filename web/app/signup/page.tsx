import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { LoginCard } from "@/components/auth/LoginCard";
import { Shell } from "@/components/landing/SiteChrome";
import { supabaseServer } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "Create account" };

const safeNext = (value?: string) => value && value.startsWith("/") && !value.startsWith("//") && !value.startsWith("/\\") ? value : "/dashboard";

export default async function SignupPage({ searchParams }: { searchParams: Promise<{ next?: string; ref?: string; error?: string }> }) {
  const params = await searchParams;
  const next = safeNext(params.next);
  const sb = await supabaseServer();
  const { data } = await sb.auth.getUser();
  if (data.user) redirect(next);

  return (
    <Shell>
      <main className="flex min-h-[calc(100svh-4rem)] items-center justify-center px-4 py-16 sm:py-20">
        <LoginCard next={next} referral={params.ref} initialError={params.error} initialMode="signup" />
      </main>
    </Shell>
  );
}
