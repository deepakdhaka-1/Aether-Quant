import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { TotpChallenge } from "@/components/auth/TotpChallenge";
import { Shell } from "@/components/landing/SiteChrome";
import { supabaseServer } from "@/lib/supabase/server";

export const metadata: Metadata = { title: "Authenticator verification" };

const safeNext = (value?: string) => value && value.startsWith("/") && !value.startsWith("//") && !value.startsWith("/\\") ? value : "/dashboard";

export default async function VerifyTotpPage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  const { next: rawNext } = await searchParams;
  const next = safeNext(rawNext);
  const sb = await supabaseServer();
  const { data: userData } = await sb.auth.getUser();
  if (!userData.user) redirect(`/login?next=${encodeURIComponent(next)}`);
  const { data: aal } = await sb.auth.mfa.getAuthenticatorAssuranceLevel();
  if (aal && (aal.currentLevel === "aal2" || aal.nextLevel !== "aal2")) redirect(next);

  return (
    <Shell>
      <main className="flex min-h-[calc(100svh-4rem)] items-center justify-center px-4 py-16 sm:py-20">
        <TotpChallenge next={next} />
      </main>
    </Shell>
  );
}
