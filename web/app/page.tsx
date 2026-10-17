import type { Metadata } from "next";
import Link from "next/link";
import { Shell, focus, pillDark, pillLine } from "@/components/landing/SiteChrome";
import StoryLoader from "@/components/landing/StoryLoader";
import MarketOrbit from "@/components/landing/MarketOrbit";
import GateFunnel from "@/components/landing/sections/GateFunnel";
import FeeCalculator, { ZeroFees } from "@/components/landing/sections/FeeCalculator";

export const metadata: Metadata = {
  title: "Aether Quant: readable, tested strategies for US stocks and commodities",
  description:
    "Aether Quant turns market prices into readable trading rules, tests them hard, and runs the few that pass on your own Hyperliquid account. Your capital stays yours.",
};

const CUSTODY = [
  ["Your money stays with you", "Funds remain in your own exchange account. We never take deposits, so there is nothing to withdraw from us."],
  ["Trade-only access", "You approve an agent key from your wallet. It can place orders, and the exchange never lets it withdraw or transfer funds."],
  ["Protection at the exchange", "Every position has a stop-loss resting on the exchange, so it stays in place even if our systems are offline."],
  ["Stop at any time", "Pause a strategy, set daily-loss and drawdown limits, close everything with one switch, or revoke our key."],
] as const;

const FAQ = [
  ["Who is Aether Quant for?", "People who want rule-based exposure to US stocks and commodities without handing their money to a manager. You do not need to be a trader; the glossary explains every term."],
  ["Why Hyperliquid?", "It lists perpetual contracts on US stocks and commodities that trade around the clock and settle in USDC, and it supports trade-only access keys, which is what lets you keep custody."],
  ["Is AI making the trading decisions?", "No. A model helps suggest candidate rules. What trades your account is a fixed, published rule that passed our tests, and it behaves the same way every time."],
  ["What happens when a strategy stops working?", "We compare live behaviour with the tested behaviour. A strategy that gets worse is paused, which stops new entries, or retired, which closes its positions."],
  ["What do I need to start?", "A wallet such as MetaMask or OKX Wallet, and USDC on Hyperliquid. Accounts open soon."],
] as const;

function SectionHead({ id, kicker, title, children, dark }: { id: string; kicker: string; title: React.ReactNode; children?: React.ReactNode; dark?: boolean }) {
  return (
    <div className="max-w-2xl">
      <p className={`text-sm font-medium ${dark ? "text-[#6CC3AC]" : "text-[#1E6B62]"}`}>{kicker}</p>
      <h2 id={id} className="mt-3 text-[clamp(1.9rem,3.6vw,2.9rem)] font-semibold leading-[1.06] tracking-[-0.035em]">{title}</h2>
      {children && <div className={`mt-5 text-[1.075rem] leading-relaxed ${dark ? "text-[#B4C4CF]" : "text-[#3E4C58]"}`}>{children}</div>}
    </div>
  );
}

const Em = ({ children }: { children: React.ReactNode }) => (
  <span className="font-[family-name:var(--aq-serif)] font-normal tracking-[-0.01em]">{children}</span>
);

export default function Landing() {
  return (
    <Shell>
      {/* Hero */}
      <section className="relative mx-auto flex min-h-[calc(100svh-4rem)] max-w-[1240px] flex-col items-center justify-center px-4 pb-28 pt-16 text-center sm:px-8">
        <h1 className="max-w-[16ch] text-[clamp(2.5rem,7vw,5.8rem)] font-semibold leading-[0.98] tracking-[-0.045em]">
          From price data to a trade, <Em>in rules you can read.</Em>
        </h1>
        <p className="mt-8 max-w-[38rem] text-[1.1rem] leading-relaxed text-[#3E4C58] sm:text-[1.15rem]">
          We turn market prices into indicators, write strategies as plain rules, and test them hard. The few that pass
          run automatically on your own Hyperliquid account. We never hold your funds.
        </p>
        <div className="mt-10 flex flex-wrap justify-center gap-3">
          <a href="#how" className={pillDark}>See how it works</a>
          <Link href="/dashboard" className={pillLine}>Go to dashboard</Link>
        </div>
        <a href="#how" className={`absolute bottom-8 flex flex-col items-center gap-2 text-[12.5px] text-[#5A6874] ${focus}`}>
          Scroll to follow one candle
          <svg width="14" height="22" viewBox="0 0 14 22" aria-hidden><rect x="1" y="1" width="12" height="20" rx="6" fill="none" stroke="#8A97A1" /><line x1="7" x2="7" y1="5" y2="9" stroke="#1E6B62" strokeWidth="1.6" strokeLinecap="round" /></svg>
        </a>
      </section>

      {/* Story */}
      <section id="how" aria-labelledby="how-h" className="scroll-mt-16 border-t border-[#E3E8EA]">
        <div className="mx-auto max-w-[1240px] px-4 pb-4 pt-14 text-center sm:px-8 sm:pt-16">
          <p className="font-[family-name:var(--aq-mono)] text-[12px] uppercase tracking-[0.16em] text-[#1E6B62]">How it works</p>
          <h2 id="how-h" className="mx-auto mt-3 max-w-[1000px] text-[clamp(2rem,4vw,3.5rem)] font-semibold leading-[1.03] tracking-[-0.045em] text-[#0C1A26]">
            One candle, <span className="font-normal">all the way to an order.</span>
          </h2>
          <p className="mx-auto mt-3 max-w-[50rem] text-[clamp(0.95rem,1.1vw,1.05rem)] leading-relaxed text-[#5A6874]">
            Follow a single hour of NVIDIA&apos;s price as it becomes data, then a rule, then a trade on your account.
          </p>
        </div>
        <StoryLoader />
      </section>

      {/* Research standard */}
      <section id="standard" aria-labelledby="standard-h" className="scroll-mt-16 border-t border-[#E3E8EA] bg-white">
        <div className="mx-auto flex max-w-[1240px] flex-col justify-center px-4 py-20 sm:px-8 lg:min-h-[calc(100svh-4rem)] lg:py-12">
          <div className="grid grid-cols-1 gap-6 lg:grid-cols-[1fr_1fr] lg:items-end lg:gap-16">
            <SectionHead id="standard-h" kicker="Research standard" title={<>A strategy has to <Em>earn its place.</Em></>} />
            <div className="max-w-2xl text-[1.05rem] leading-relaxed text-[#3E4C58]">
              <p>
                Most ideas fail our tests, and those never reach you. Every published strategy clears each requirement on
                the period it was designed on and on a later period it never saw. Live strategies are compared with their
                tested behaviour and paused when they drift.
              </p>
            </div>
          </div>
          <div className="mt-8 lg:mt-10">
            <GateFunnel />
          </div>
        </div>
      </section>

      <MarketOrbit />

      {/* Custody */}
      <section id="custody" aria-labelledby="custody-h" className="mx-auto max-w-[1240px] scroll-mt-16 px-4 py-28 sm:px-8">
        <SectionHead id="custody-h" kicker="Custody and control" title={<>Built so that <Em>you stay in control.</Em></>}>
          <p>We run the strategies. You keep the account, the funds and the final say.</p>
        </SectionHead>
        <ol className="mt-14 grid grid-cols-1 gap-x-10 gap-y-12 sm:grid-cols-2 lg:grid-cols-4">
          {CUSTODY.map(([t, b], i) => (
            <li key={t} className="border-t-2 border-[#0C1A26] pt-5">
              <span className="font-[family-name:var(--aq-mono)] text-[12.5px] text-[#1E6B62]">{String(i + 1).padStart(2, "0")}</span>
              <h3 className="mt-3 text-[1.15rem] font-semibold tracking-[-0.015em]">{t}</h3>
              <p className="mt-2 text-[15px] leading-relaxed text-[#3E4C58]">{b}</p>
            </li>
          ))}
        </ol>
      </section>

      {/* Pricing */}
      <section id="pricing" aria-labelledby="pricing-h" className="scroll-mt-16 border-y border-[#E3E8EA] bg-white">
        <div className="mx-auto grid max-w-[1240px] grid-cols-1 gap-12 px-4 py-28 sm:px-8 lg:grid-cols-[1fr_1.1fr] lg:items-center lg:gap-16">
          <SectionHead id="pricing-h" kicker="Pricing" title={<>One small fee, <Em>only when we trade.</Em></>}>
            <p>
              No subscription, no management fee and no performance fee. We charge 0.03% of each order we place, attached
              through Hyperliquid&apos;s builder code and collected when the trade settles.
            </p>
            <ZeroFees />
          </SectionHead>
          <FeeCalculator />
        </div>
      </section>

      {/* FAQ */}
      <section id="faq" aria-labelledby="faq-h" className="mx-auto grid max-w-[1240px] scroll-mt-16 grid-cols-1 gap-12 px-4 py-28 sm:px-8 lg:grid-cols-[0.9fr_1.1fr]">
        <SectionHead id="faq-h" kicker="FAQ" title="Common questions.">
          <p>New to the terms? <Link href="/learn" className="text-[#1E6B62] underline underline-offset-4">Read the glossary.</Link></p>
        </SectionHead>
        <div className="border-t border-[#0C1A26]">
          {FAQ.map(([q, a]) => (
            <details key={q} className="group border-b border-[#DDE3E6]">
              <summary className={`flex cursor-pointer list-none items-center justify-between gap-6 py-5 text-[1.05rem] font-medium [&::-webkit-details-marker]:hidden ${focus}`}>
                {q}
                <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden className="shrink-0 transition-transform group-open:rotate-45">
                  <path d="M7 1v12M1 7h12" stroke="#0C1A26" strokeWidth="1.6" />
                </svg>
              </summary>
              <p className="max-w-[60ch] pb-6 text-[15.5px] leading-relaxed text-[#3E4C58]">{a}</p>
            </details>
          ))}
        </div>
      </section>

    </Shell>
  );
}
