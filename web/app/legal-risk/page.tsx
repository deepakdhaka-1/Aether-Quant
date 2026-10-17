import type { Metadata } from "next";
import { LegalPage } from "@/components/marketing/Chrome";

export const metadata: Metadata = { title: "Risk disclosure" };

export default function Risk() {
  return (
    <LegalPage title="Risk disclosure" updated="October 2026">
      <p>Read this before connecting a wallet or following a strategy live.</p>
      <section>
        <h2>Leverage and liquidation</h2>
        <p>
          Perpetual futures are leveraged. A small adverse price move can liquidate a position and lose the margin behind it.
          Higher leverage settings multiply both gains and losses.
        </p>
      </section>
      <section>
        <h2>Backtests are not predictions</h2>
        <p>
          Headline returns, Sharpe ratios and drawdowns come from historical simulation. Real results differ because of slippage,
          fees, funding, gaps, overfitting and changing market regimes. Out-of-sample results reduce, but do not remove, this risk.
        </p>
      </section>
      <section>
        <h2>Synthetic equity and commodity markets</h2>
        <ul>
          <li>HIP-3 markets track US stocks and commodities but are perpetual contracts on Hyperliquid, not the underlying asset.</li>
          <li>They can trade when the underlying market is closed, may have thin liquidity, and rely on oracle prices.</li>
          <li>A market can be delisted or have its parameters changed by its deployer.</li>
        </ul>
      </section>
      <section>
        <h2>Operational risk</h2>
        <ul>
          <li>Our servers, Hyperliquid, or your wallet can fail or be delayed. Stop-loss and take-profit trigger orders live on Hyperliquid to limit this, but fills are not guaranteed.</li>
          <li>Smart-contract, bridge and custody risks of Hyperliquid apply to your deposit.</li>
        </ul>
      </section>
      <section>
        <h2>Controls you have</h2>
        <ul>
          <li>Paper mode lets you watch a strategy before risking funds.</li>
          <li>Account-wide limits for daily loss, drawdown and gross leverage in Settings.</li>
          <li>A kill switch per account, and agent revocation directly on Hyperliquid.</li>
        </ul>
      </section>
      <p>Only trade with money you can afford to lose.</p>
    </LegalPage>
  );
}
