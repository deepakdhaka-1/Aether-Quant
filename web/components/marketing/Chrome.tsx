import Link from "next/link";
import Image from "next/image";
import { Logo } from "@/components/ui/Logo";
import { btn } from "@/components/ui";

export function SiteHeader({ signedIn }: { signedIn: boolean }) {
  return (
    <header className="relative z-20 mx-auto flex max-w-6xl items-center justify-between px-4 py-5 sm:px-6">
      <Logo />
      <nav className="flex items-center gap-2" aria-label="Site">
        <Link href="/#how" className="hidden px-3 text-sm text-mist-400 hover:text-mist-100 sm:inline">How it works</Link>
        <Link href="/#strategies" className="hidden px-3 text-sm text-mist-400 hover:text-mist-100 sm:inline">Strategies</Link>
        <Link href={signedIn ? "/dashboard" : "/login"} className={btn.primary}>{signedIn ? "Open app" : "Sign in"}</Link>
      </nav>
    </header>
  );
}

export function SiteFooter() {
  return (
    <footer className="border-t border-ink-800">
      <div className="mx-auto max-w-6xl space-y-6 px-4 py-10 sm:px-6">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <Logo />
          <div className="flex items-center gap-2 text-xs text-mist-500">
            Execution on
            <Image src="/brand/hyperliquid.svg" alt="Hyperliquid" width={96} height={18} className="h-4 w-auto opacity-80" />
          </div>
          <nav className="flex gap-4 text-xs text-mist-400" aria-label="Legal">
            <Link href="/legal/terms" className="hover:text-mist-100">Terms</Link>
            <Link href="/legal/risk" className="hover:text-mist-100">Risk disclosure</Link>
          </nav>
        </div>
        <p className="max-w-4xl text-[11px] leading-relaxed text-mist-500">
          Risk disclaimer: trading leveraged perpetual futures is high risk and you can lose your entire deposit. Strategy metrics are
          backtested or simulated and do not guarantee future results. Aether Quant is software, not a broker, adviser or fiduciary,
          and nothing here is investment advice. HIP-3 markets on Hyperliquid may be unavailable in your jurisdiction; you are
          responsible for complying with local law.
        </p>
      </div>
    </footer>
  );
}

export function LegalPage({ title, updated, children }: { title: string; updated: string; children: React.ReactNode }) {
  return (
    <div className="min-h-screen">
      <SiteHeader signedIn={false} />
      <main className="mx-auto max-w-3xl px-4 pb-20 pt-8 sm:px-6">
        <h1 className="text-3xl font-semibold tracking-tight">{title}</h1>
        <p className="mt-2 font-mono text-xs text-mist-500">Last updated {updated}</p>
        <div className="mt-8 space-y-6 text-sm leading-relaxed text-mist-300 [&_h2]:mb-2 [&_h2]:text-base [&_h2]:font-semibold [&_h2]:text-mist-100 [&_li]:ml-5 [&_li]:list-disc [&_ul]:space-y-1.5">
          {children}
        </div>
      </main>
      <SiteFooter />
    </div>
  );
}
