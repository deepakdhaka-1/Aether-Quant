import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { Shell } from "@/components/landing/SiteChrome";
import { VerifyEmailCard } from "@/components/auth/VerifyEmailCard";
import { supabaseServer } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "Confirm your email" };

const safeNext = (value?: string) => value && value.startsWith("/") && !value.startsWith("//") && !value.startsWith("/\\") ? value : "/dashboard";

export default async function VerifyEmailPage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  const params = await searchParams;
  const next = safeNext(params.next);
  const sb = await supabaseServer();
  const { data } = await sb.auth.getUser();
  if (!data.user) redirect(`/login?next=${encodeURIComponent(next)}`);
  if (data.user.email_confirmed_at) redirect(next);
  if (!data.user.email) redirect("/login?error=missing_email");

  return (
    <Shell>
      <main className="flex min-h-[calc(100svh-4rem)] items-center justify-center px-4 py-16 sm:py-20">
        <VerifyEmailCard email={data.user.email} next={next} />
      </main>
    </Shell>
  );
}
