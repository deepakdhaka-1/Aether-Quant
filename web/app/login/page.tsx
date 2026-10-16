import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { LoginCard } from "@/components/auth/LoginCard";
import { Logo } from "@/components/ui/Logo";
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
    <main className="relative flex min-h-screen flex-col items-center justify-center overflow-hidden px-4 py-10">
      <div className="bg-grid mask-fade pointer-events-none absolute inset-0" aria-hidden />
      <div className="pointer-events-none absolute -top-40 left-1/2 h-[480px] w-[480px] -translate-x-1/2 rounded-full bg-aether/10 blur-3xl" aria-hidden />
      <div className="relative mb-8"><Logo /></div>
      <div className="relative w-full flex justify-center">
        <LoginCard next={next} referral={sp.ref} initialError={sp.error} />
      </div>
    </main>
  );
}
