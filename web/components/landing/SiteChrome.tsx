import Image from "next/image";
import Link from "next/link";
import { LogoMark } from "@/components/ui/Logo";

export const NAV = [
  ["How it works", "/#how"],
  ["Standard", "/#standard"],
  ["Markets", "/#markets"],
  ["Custody", "/#custody"],
  ["Pricing", "/#pricing"],
  ["FAQ", "/#faq"],
  ["Glossary", "/learn"],
] as const;

export const focus =
  "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#1E6B62]";
export const pillDark = `inline-flex items-center justify-center rounded-full bg-[#0C1A26] px-6 py-3 text-[15px] font-medium text-white transition-colors hover:bg-[#1E6B62] ${focus}`;
export const pillLine = `inline-flex items-center justify-center rounded-full border border-[#C9D2D7] bg-white/60 px-6 py-3 text-[15px] font-medium text-[#0C1A26] transition-colors hover:border-[#0C1A26] ${focus}`;

export function Mark() {
  return <LogoMark size={22} />;
}

export function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen overflow-x-clip bg-[#F5F7F7] font-[family-name:var(--aq-sans)] text-[#0C1A26] antialiased">
      <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-[60] focus:rounded focus:bg-white focus:px-3 focus:py-2">
        Skip to content
      </a>
      <header className="sticky top-0 z-50 border-b border-[#E3E8EA] bg-[#F5F7F7]/85 backdrop-blur-md">
        <div className="mx-auto flex h-16 max-w-[1240px] items-center justify-between gap-6 px-4 sm:px-8">
          <Link href="/" className={`flex items-center gap-2.5 ${focus}`}>
            <Mark />
            <span className="text-[17px] font-semibold tracking-[-0.02em]">Aether Quant</span>
          </Link>
          <nav aria-label="Primary" className="hidden items-center gap-7 text-[14px] text-[#3E4C58] lg:flex">
            {NAV.slice(0, 4).map(([l, h]) => (
              <Link key={h} href={h} className={`transition-colors hover:text-[#0C1A26] ${focus}`}>{l}</Link>
            ))}
          </nav>
          <div className="flex items-center gap-2">
            <nav aria-label="Resources" className="hidden items-center gap-5 text-[14px] text-[#3E4C58] lg:flex">
              {NAV.slice(4).map(([l, h]) => (
                <Link key={h} href={h} className={`transition-colors hover:text-[#0C1A26] ${focus}`}>{l}</Link>
              ))}
            </nav>
            <Link href="/dashboard" className={`${pillDark} !px-4 !py-2 !text-[14px]`}>Dashboard</Link>
            <details className="relative lg:hidden">
              <summary className={`flex h-10 w-10 cursor-pointer list-none items-center justify-center rounded-full border border-[#C9D2D7] [&::-webkit-details-marker]:hidden ${focus}`} aria-label="Menu">
                <svg width="16" height="16" viewBox="0 0 18 18" aria-hidden><path d="M2 5h14M2 9h14M2 13h14" stroke="#0C1A26" strokeWidth="1.6" /></svg>
              </summary>
              <nav aria-label="Mobile" className="absolute right-0 mt-2 w-52 rounded-2xl border border-[#E3E8EA] bg-white p-2 shadow-lg">
                {NAV.map(([l, h]) => (
                  <Link key={h} href={h} className="block rounded-xl px-3 py-2 text-[15px] hover:bg-[#F0F4F4]">{l}</Link>
                ))}
              </nav>
            </details>
          </div>
        </div>
      </header>
      <main id="main">{children}</main>
      <footer className="bg-[#0C1A26] text-[#B4C4CF]">
        <div className="mx-auto max-w-[1240px] px-4 py-16 sm:px-8">
          <div className="grid grid-cols-1 gap-10 md:grid-cols-[1.4fr_1fr_1fr_1fr]">
            <div>
              <p className="text-[18px] font-semibold tracking-[-0.02em] text-white">Aether Quant</p>
              <p className="mt-3 max-w-[34ch] text-[14.5px] leading-relaxed">
                Readable, tested trading rules for US stocks and commodities, run on your own account.
              </p>
              <p className="mt-6 flex items-center gap-2 text-[13px]">
                Executes on
                <Image src="/brand/Hyperliquid_Blob_Light.svg" alt="" width={18} height={18} className="h-[18px] w-[18px]" />
                <span className="text-white">Hyperliquid</span>
              </p>
            </div>
            <nav aria-label="Footer: product">
              <h2 className="text-[13px] font-semibold text-white">Product</h2>
              <ul className="mt-4 space-y-2.5 text-[14.5px]">
                {NAV.slice(0, 4).map(([l, h]) => <li key={h}><Link href={h} className="hover:text-white">{l}</Link></li>)}
              </ul>
            </nav>
            <nav aria-label="Footer: resources">
              <h2 className="text-[13px] font-semibold text-white">Resources</h2>
              <ul className="mt-4 space-y-2.5 text-[14.5px]">
                {NAV.slice(4).map(([l, h]) => <li key={h}><Link href={h} className="hover:text-white">{l}</Link></li>)}
              </ul>
            </nav>
            <nav aria-label="Footer: legal">
              <h2 className="text-[13px] font-semibold text-white">Legal</h2>
              <ul className="mt-4 space-y-2.5 text-[14.5px]">
                <li><Link href="/legal-terms" className="hover:text-white">Terms of use</Link></li>
                <li><Link href="/legal-risk" className="hover:text-white">Risk disclosure</Link></li>
              </ul>
            </nav>
          </div>
          <div className="mt-14 space-y-3 border-t border-[#1D3243] pt-6 text-[12.5px] leading-relaxed text-[#7F96A6]">
            <p>
              Trading perpetual contracts involves substantial risk of loss and is not suitable for every investor.
              Leverage magnifies losses, and you can lose more than you expect in fast markets. Backtested and
              hypothetical results have inherent limitations and do not indicate future performance. A stop-loss does
              not guarantee an exit price.
            </p>
            <p>
              Nothing on this site is an offer, solicitation or investment advice. Aether Quant is not affiliated with
              Hyperliquid. © {new Date().getFullYear()} Aether Quant.
            </p>
          </div>
        </div>
      </footer>
    </div>
  );
}
