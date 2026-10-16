import { redirect } from "next/navigation";
import { MobileNav, Sidebar, UserMenu } from "@/components/app/AppNav";
import { LogoMark } from "@/components/ui/Logo";
import { requireUser } from "@/lib/supabase/server";
import { short } from "@/lib/format";

export const dynamic = "force-dynamic";

export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const { sb, user } = await requireUser();
  if (!user) redirect("/login");

  const { data: profile } = await sb.from("profiles").select("username,email,wallet_address,role").eq("id", user.id).maybeSingle();
  const { data: sys } = await sb.from("system_state").select("halted,note").eq("id", "global").maybeSingle();
  const isAdmin = profile?.role === "admin";
  const wallet = profile?.wallet_address as string | null | undefined;
  const email = (profile?.email ?? user.email) as string | undefined;
  const isWalletEmail = email?.endsWith("@wallet.aetherquant.local");
  const label = wallet ? short(wallet) : (isWalletEmail ? undefined : email) ?? profile?.username ?? "Account";

  return (
    <div className="flex min-h-screen bg-ink-950">
      <Sidebar isAdmin={isAdmin} />
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="sticky top-0 z-30 flex items-center justify-between gap-3 border-b border-ink-800 bg-ink-950/85 px-4 py-3 backdrop-blur sm:px-6">
          <div className="flex items-center gap-2 lg:hidden"><LogoMark /></div>
          <div className="hidden font-mono text-[11px] uppercase tracking-[0.2em] text-mist-500 lg:block">
            HIP-3 · xyz perps · Hyperliquid
          </div>
          <UserMenu label={label} sub={wallet ?? (isWalletEmail ? undefined : email)} />
        </header>
        {sys?.halted && (
          <div role="alert" className="border-b border-loss/40 bg-loss/10 px-4 py-2 text-center text-xs text-mist-100 sm:px-6">
            Trading is paused platform-wide{sys.note ? `: ${sys.note}` : "."} No new orders will be placed.
          </div>
        )}
        <main className="mx-auto w-full max-w-6xl flex-1 px-4 pb-28 pt-6 sm:px-6 lg:pb-12">{children}</main>
      </div>
      <MobileNav isAdmin={isAdmin} />
    </div>
  );
}
