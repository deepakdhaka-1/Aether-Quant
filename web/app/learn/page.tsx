import type { Metadata } from "next";
import Link from "next/link";
import { Shell, pillDark } from "@/components/landing/SiteChrome";

export const metadata: Metadata = {
  title: "Glossary",
  description: "Plain-English definitions of the terms used on Aether Quant: candle, OHLCV, indicator, strategy, backtest, drawdown, Sharpe, leverage, agent key and builder fee.",
};

const TERMS: [string, string][] = [
  ["Candle", "A summary of what a price did over a fixed slice of time, such as one hour. It is drawn as a box (the body) with thin lines above and below (the wicks)."],
  ["OHLCV", "The five numbers in every candle: Open (first price), High (highest), Low (lowest), Close (last price) and Volume (how much was traded)."],
  ["Indicator", "A small formula over recent candles that answers one question, such as \"is the price above its usual level?\" or \"is it moving fast?\". We compute about 140 of them."],
  ["EMA", "Exponential moving average: an average price that gives more weight to recent candles. A short EMA reacts quickly; a long EMA shows the bigger trend."],
  ["Strategy", "A written rule that says when to buy, when to sell and where to place the stop-loss. Every Aether strategy is a rule a person can read."],
  ["Backtest", "Replaying a strategy on past prices, with fees, to see how it would have behaved. It shows the past, not the future."],
  ["Out-of-sample", "A later stretch of history that was kept hidden while the strategy was designed. Passing it is evidence that the rule is not just fitted to old data."],
  ["Drawdown", "The fall from a peak in account value to the lowest point that follows, in percent. Our limit is no worse than −35%."],
  ["Sharpe ratio", "Return divided by how bumpy the ride was. Higher is better; we require at least 0.5 on both the design period and the unseen period."],
  ["Leverage", "Trading a position larger than your deposit. 2× leverage doubles both gains and losses."],
  ["Stop-loss", "An order that closes a position if the price falls to a set level, to limit the loss. Ours rest on the exchange itself. In fast markets the exit price can be worse."],
  ["Agent key", "A key you approve from your wallet that lets us place orders on your Hyperliquid account. Hyperliquid does not let it withdraw or transfer funds, and you can revoke it at any time."],
  ["Builder fee", "Hyperliquid's built-in way for an app to charge a fee per order. Ours is 0.03% per trade, and your wallet signature caps it at 0.05%."],
];

export default function Learn() {
  return (
    <Shell>
      <section className="mx-auto max-w-[880px] px-4 pb-24 pt-20 sm:px-8">
        <p className="text-sm font-medium text-[#1E6B62]">Glossary</p>
        <h1 className="mt-4 text-[clamp(2.2rem,5vw,3.4rem)] font-semibold leading-[1.04] tracking-[-0.035em]">
          The words, <span className="font-[family-name:var(--aq-serif)] font-normal">in plain English.</span>
        </h1>
        <p className="mt-5 max-w-[38rem] text-[1.075rem] leading-relaxed text-[#3E4C58]">
          Everything on this site in one or two sentences each. No prior trading knowledge needed.
        </p>
        <dl className="mt-14 border-t border-[#0C1A26]">
          {TERMS.map(([t, d]) => (
            <div key={t} id={t.toLowerCase().replace(/[^a-z]+/g, "-")} className="grid grid-cols-1 gap-2 border-b border-[#DDE3E6] py-6 sm:grid-cols-[200px_1fr] sm:gap-8">
              <dt className="text-[1.05rem] font-semibold">{t}</dt>
              <dd className="text-[16px] leading-relaxed text-[#3E4C58]">{d}</dd>
            </div>
          ))}
        </dl>
        <div className="mt-12"><Link href="/#how" className={pillDark}>See it step by step</Link></div>
      </section>
    </Shell>
  );
}
