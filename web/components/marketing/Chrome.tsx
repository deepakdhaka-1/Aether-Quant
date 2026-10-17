import Link from "next/link";
import Image from "next/image";
import { Logo } from "@/components/ui/Logo";
import { btn } from "@/components/ui";
import { Shell } from "@/components/landing/SiteChrome";

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
            <Link href="/legal-terms" className="hover:text-mist-100">Terms</Link>
            <Link href="/legal-risk" className="hover:text-mist-100">Risk disclosure</Link>
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

// Legal pages share the public site's header, footer and light theme.
export function LegalPage({ title, updated, children }: { title: string; updated: string; children: React.ReactNode }) {
  return (
    <Shell>
      <article className="mx-auto max-w-[760px] px-4 pb-24 pt-14 sm:px-8 sm:pt-20">
        <p className="text-[13px] font-medium text-[#1E6B62]">Legal</p>
        <h1 className="mt-2 text-[clamp(2rem,4vw,2.75rem)] font-semibold leading-[1.08] tracking-[-0.03em] text-[#0C1A26]">{title}</h1>
        <p className="mt-3 text-[13px] text-[#5A6874]">Last updated {updated}</p>
        <div className="mt-10 space-y-8 border-t border-[#DDE5E7] pt-10 text-[15.5px] leading-relaxed text-[#3E4C58] [&_h2]:mb-2.5 [&_h2]:text-[1.1rem] [&_h2]:font-semibold [&_h2]:tracking-[-0.01em] [&_h2]:text-[#0C1A26] [&_li]:ml-5 [&_li]:list-disc [&_li]:pl-1 [&_ul]:space-y-2 [&_a]:text-[#1E6B62] [&_a]:underline">
          {children}
        </div>
      </article>
    </Shell>
  );
}
