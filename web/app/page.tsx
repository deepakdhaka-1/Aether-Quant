import type { Metadata } from "next";
import Link from "next/link";
import { Shell, focus, pillDark, pillLine } from "@/components/landing/SiteChrome";
import StoryLoader from "@/components/landing/StoryLoader";

export const metadata: Metadata = {
  title: "Aether Quant: readable, tested strategies for US stocks and commodities",
  description:
    "Aether Quant turns market prices into readable trading rules, tests them hard, and runs the few that pass on your own Hyperliquid account. Your capital stays yours.",
};

const GATES: [string, string, string][] = [
  ["Out-of-sample test", "Last 30% of history", "Held back during design"],
  ["Risk-adjusted return", "Sharpe ≥ 0.5", "In both periods"],
  ["Drawdown ceiling", "No worse than −35%", "Peak to trough, both periods"],
  ["Evidence", "15+ trades", "No conclusions from a handful"],
  ["Costs", "Fees charged on every fill", "Exchange fee plus ours"],
];

const MARKETS: [string, [string, string][]][] = [
  ["US stocks", [["NVIDIA", "NVDA"], ["Tesla", "TSLA"], ["Apple", "AAPL"], ["Microsoft", "MSFT"], ["Amazon", "AMZN"], ["Alphabet", "GOOGL"], ["Meta", "META"]]],
  ["Index", [["US Tech 100", "XYZ100"]]],
  ["Commodities", [["Gold", "GOLD"], ["Silver", "SILVER"], ["WTI crude", "CL"], ["Brent crude", "BRENTOIL"], ["Natural gas", "NATGAS"], ["Copper", "COPPER"]]],
];

const CUSTODY = [
  ["Your money stays with you", "Funds remain in your own Hyperliquid account. We never take deposits, so there is nothing to withdraw from us."],
  ["Trade-only access", "You approve an agent key from your wallet. Hyperliquid lets it place orders, and never lets it withdraw or transfer funds."],
  ["Protection at the exchange", "Every position has a stop-loss resting on Hyperliquid, so it stays in place even if our systems are offline."],
  ["Stop at any time", "Pause a strategy, set daily-loss and drawdown limits, close everything with one switch, or revoke our key on Hyperliquid."],
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
  <span className="font-[family-name:var(--aq-serif)] font-normal italic tracking-[-0.01em]">{children}</span>
);

export default function Landing() {
  return (
    <Shell>
      {/* Hero */}
      <section className="relative mx-auto flex min-h-[calc(100svh-4rem)] max-w-[1240px] flex-col items-center justify-center px-4 pb-28 pt-16 text-center sm:px-8">
        <p className="rounded-full border border-[#D5DDE0] bg-white px-4 py-1.5 text-[13px] text-[#3E4C58]">
          US stocks and commodities · executes on Hyperliquid
        </p>
        <h1 className="mt-8 max-w-[16ch] text-[clamp(2.5rem,7vw,5.8rem)] font-semibold leading-[0.98] tracking-[-0.045em]">
          From price data to a trade, <Em>in rules you can read.</Em>
        </h1>
        <p className="mt-8 max-w-[38rem] text-[1.1rem] leading-relaxed text-[#3E4C58] sm:text-[1.15rem]">
          We turn market prices into indicators, write strategies as plain rules, and test them hard. The few that pass
          run automatically on your own Hyperliquid account. We never hold your funds.
        </p>
        <div className="mt-10 flex flex-wrap justify-center gap-3">
          <a href="#how" className={pillDark}>See how it works</a>
          <a href="#access" className={pillLine}>Get ready for launch</a>
        </div>
        <a href="#how" className={`absolute bottom-8 flex flex-col items-center gap-2 text-[12.5px] text-[#5A6874] ${focus}`}>
          Scroll to follow one candle
          <svg width="14" height="22" viewBox="0 0 14 22" aria-hidden><rect x="1" y="1" width="12" height="20" rx="6" fill="none" stroke="#8A97A1" /><line x1="7" x2="7" y1="5" y2="9" stroke="#1E6B62" strokeWidth="1.6" strokeLinecap="round" /></svg>
        </a>
      </section>

      {/* Story */}
      <section id="how" aria-labelledby="how-h" className="scroll-mt-16 border-t border-[#E3E8EA]">
        <div className="mx-auto max-w-[1240px] px-4 pb-6 pt-20 sm:px-8">
          <SectionHead id="how-h" kicker="How it works" title={<>One candle, <Em>all the way to an order.</Em></>}>
            <p>Follow a single hour of NVIDIA&apos;s price as it becomes data, then a rule, then a trade on your account.</p>
          </SectionHead>
        </div>
        <StoryLoader />
      </section>

      {/* Research standard */}
      <section id="standard" aria-labelledby="standard-h" className="scroll-mt-16 border-t border-[#E3E8EA] bg-white">
        <div className="mx-auto grid max-w-[1240px] grid-cols-1 gap-14 px-4 py-28 sm:px-8 lg:grid-cols-[0.9fr_1.1fr]">
          <SectionHead id="standard-h" kicker="Research standard" title={<>A strategy has to <Em>earn its place.</Em></>}>
            <p>
              Most ideas fail our tests, and those never reach you. Every published strategy clears each requirement on
              the period it was designed on and on a later period it never saw.
            </p>
            <p className="mt-4">Live strategies are compared with their tested behaviour and paused when they drift.</p>
          </SectionHead>
          <div className="min-w-0 overflow-x-auto rounded-3xl border border-[#E3E8EA]">
            <table className="w-full min-w-[480px] text-left text-[15px]">
              <caption className="sr-only">Requirements every published strategy must meet</caption>
              <thead>
                <tr className="border-b border-[#E3E8EA] text-[13px] text-[#5A6874]">
                  <th scope="col" className="px-6 py-4 font-medium">Requirement</th>
                  <th scope="col" className="px-6 py-4 font-medium">Threshold</th>
                  <th scope="col" className="px-6 py-4 font-medium">Applies to</th>
                </tr>
              </thead>
              <tbody>
                {GATES.map(([r, t, a]) => (
                  <tr key={r} className="border-b border-[#EEF2F3] last:border-0">
                    <th scope="row" className="px-6 py-4 font-medium">{r}</th>
                    <td className="px-6 py-4 font-[family-name:var(--aq-mono)] text-[14px] text-[#1E6B62]">{t}</td>
                    <td className="px-6 py-4 text-[#5A6874]">{a}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </section>

      {/* Markets */}
      <section id="markets" aria-labelledby="markets-h" className="scroll-mt-16 bg-[#0C1A26] text-white">
        <div className="mx-auto grid max-w-[1240px] grid-cols-1 gap-14 px-4 py-28 sm:px-8 lg:grid-cols-[0.9fr_1.1fr]">
          <SectionHead dark id="markets-h" kicker="Markets" title={<>US stocks and commodities, <Em>around the clock.</Em></>}>
            <p>
              Traded as perpetual contracts on Hyperliquid, settled in USDC, with no market-hours gaps. Coverage grows as
              new strategies pass our standard.
            </p>
          </SectionHead>
          <div className="grid grid-cols-1 gap-10 sm:grid-cols-3">
            {MARKETS.map(([group, rows]) => (
              <div key={group}>
                <h3 className="border-b border-[#24394A] pb-3 text-[13px] font-medium text-[#8FA3B3]">{group}</h3>
                <ul className="mt-2">
                  {rows.map(([n, s]) => (
                    <li key={s} className="flex items-baseline justify-between gap-3 border-b border-[#16293A] py-2.5">
                      <span className="text-[15.5px]">{n}</span>
                      <span className="font-[family-name:var(--aq-mono)] text-[12.5px] text-[#7F96A6]">{s}</span>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Custody */}
      <section id="custody" aria-labelledby="custody-h" className="mx-auto max-w-[1240px] scroll-mt-16 px-4 py-28 sm:px-8">
        <SectionHead id="custody-h" kicker="Custody and control" title={<>Built so that <Em>you stay in control.</Em></>}>
          <p>We run the strategies. You keep the account, the funds and the final say.</p>
        </SectionHead>
        <div className="mt-14 grid grid-cols-1 gap-4 sm:grid-cols-2">
          {CUSTODY.map(([t, b], i) => (
            <div key={t} className="rounded-3xl border border-[#E3E8EA] bg-white p-8">
              <p className="font-[family-name:var(--aq-mono)] text-[12.5px] text-[#1E6B62]">{String(i + 1).padStart(2, "0")}</p>
              <h3 className="mt-4 text-[1.15rem] font-semibold tracking-[-0.015em]">{t}</h3>
              <p className="mt-2.5 text-[15.5px] leading-relaxed text-[#3E4C58]">{b}</p>
            </div>
          ))}
        </div>
      </section>

      {/* Pricing */}
      <section id="pricing" aria-labelledby="pricing-h" className="scroll-mt-16 border-y border-[#E3E8EA] bg-white">
        <div className="mx-auto grid max-w-[1240px] grid-cols-1 gap-12 px-4 py-28 sm:px-8 lg:grid-cols-[0.9fr_1.1fr] lg:items-center">
          <SectionHead id="pricing-h" kicker="Pricing" title={<>One small fee, <Em>only when we trade.</Em></>}>
            <p>
              No subscription, no management fee and no performance fee. The fee is attached to each order through
              Hyperliquid&apos;s builder code and collected by Hyperliquid when the trade settles.
            </p>
          </SectionHead>
          <dl className="grid grid-cols-1 divide-y divide-[#E3E8EA] rounded-3xl border border-[#E3E8EA] sm:grid-cols-3 sm:divide-x sm:divide-y-0">
            {[
              ["Per trade", "0.03%", "of each order we place"],
              ["Fee ceiling", "0.05%", "capped by your own signature"],
              ["Everything else", "$0", "subscription, management, performance"],
            ].map(([k, v, d]) => (
              <div key={k} className="p-7">
                <dt className="text-[13px] text-[#5A6874]">{k}</dt>
                <dd className="mt-2 text-[2.5rem] font-semibold leading-none tracking-[-0.04em]">{v}</dd>
                <dd className="mt-2 text-[14px] text-[#5A6874]">{d}</dd>
              </div>
            ))}
          </dl>
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

      {/* Access */}
      <section id="access" aria-labelledby="access-h" className="mx-auto max-w-[1240px] scroll-mt-16 px-4 pb-28 sm:px-8">
        <div className="rounded-[32px] bg-[#E3EEEC] px-6 py-16 text-center sm:px-12 sm:py-20">
          <h2 id="access-h" className="mx-auto max-w-[18ch] text-[clamp(2rem,4.4vw,3.4rem)] font-semibold leading-[1.04] tracking-[-0.04em]">
            Accounts open <Em>soon.</Em>
          </h2>
          <p className="mx-auto mt-5 max-w-[36rem] text-[1.075rem] leading-relaxed text-[#3E4C58]">
            We are finishing validation of our first strategies. To be ready on day one, set up a wallet such as MetaMask
            or OKX and fund a Hyperliquid account with USDC.
          </p>
          <div className="mt-9 flex flex-wrap justify-center gap-3">
            <a href="https://app.hyperliquid.xyz" target="_blank" rel="noopener noreferrer" className={pillDark}>Open Hyperliquid</a>
            <Link href="/legal/risk" className={pillLine}>Read the risk disclosure</Link>
          </div>
        </div>
      </section>
    </Shell>
  );
}
