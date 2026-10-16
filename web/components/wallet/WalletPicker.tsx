"use client";

import { useEffect, useState } from "react";
import { ArrowUpRight, Loader2 } from "lucide-react";
import { discoverWallets, FEATURED, type DiscoveredWallet } from "@/lib/wallets";
import { Lettermark, cx } from "@/components/ui";

export function WalletIcon({ icon, name, size = 28 }: { icon?: string; name: string; size?: number }) {
  const [broken, setBroken] = useState(false);
  if (!icon || broken) return <Lettermark name={name} size={size} />;
  // eslint-disable-next-line @next/next/no-img-element
  return <img src={icon} alt="" width={size} height={size} className="shrink-0 rounded-lg" onError={() => setBroken(true)} />;
}

export function useWallets() {
  const [wallets, setWallets] = useState<DiscoveredWallet[]>([]);
  const [scanned, setScanned] = useState(false);
  useEffect(() => {
    const stop = discoverWallets(setWallets);
    const t = setTimeout(() => setScanned(true), 500);
    return () => { stop(); clearTimeout(t); };
  }, []);
  return { wallets, scanned };
}

/** EIP-6963 wallet list: detected wallets first, then install links for featured ones that are missing. */
export function WalletPicker({
  onPick,
  busy,
  disabled,
}: {
  onPick: (w: DiscoveredWallet) => void;
  busy?: string | null;
  disabled?: boolean;
}) {
  const { wallets, scanned } = useWallets();
  const detected = new Set(wallets.map((w) => w.info.rdns));
  const missing = FEATURED.filter((f) => !detected.has(f.rdns));
  const sorted = [...wallets].sort((a, b) => {
    const ia = FEATURED.findIndex((f) => f.rdns === a.info.rdns);
    const ib = FEATURED.findIndex((f) => f.rdns === b.info.rdns);
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
  });

  return (
    <div className="space-y-2">
      {sorted.map((w) => {
        const isBusy = busy === w.info.rdns;
        const featured = FEATURED.find((f) => f.rdns === w.info.rdns);
        return (
          <button
            key={w.info.uuid}
            type="button"
            disabled={disabled || !!busy}
            onClick={() => onPick(w)}
            className={cx(
              "flex w-full items-center gap-3 rounded-xl border border-ink-700 bg-ink-850 px-3.5 py-3 text-left text-sm transition",
              "hover:border-aether/50 hover:bg-ink-800 focus-visible:outline focus-visible:outline-2 focus-visible:outline-aether disabled:opacity-60",
            )}
          >
            <WalletIcon icon={w.info.icon || featured?.logo} name={w.info.name} />
            <span className="flex-1 font-medium text-mist-100">{w.info.name}</span>
            {isBusy ? (
              <Loader2 className="h-4 w-4 animate-spin text-aether" aria-label="Waiting for wallet" />
            ) : (
              <span className="font-mono text-[10px] uppercase tracking-wider text-aether">Detected</span>
            )}
          </button>
        );
      })}
      {scanned && wallets.length === 0 && (
        <p className="rounded-xl border border-dashed border-ink-700 px-3.5 py-3 text-xs text-mist-400">
          No browser wallet detected. Install one below, then reload this page.
        </p>
      )}
      {missing.map((f) => (
        <a
          key={f.rdns}
          href={f.install}
          target="_blank"
          rel="noreferrer"
          className="flex w-full items-center gap-3 rounded-xl border border-ink-800 px-3.5 py-3 text-sm text-mist-400 transition hover:border-ink-600 hover:text-mist-100"
        >
          <WalletIcon icon={f.logo} name={f.name} />
          <span className="flex-1">{f.name}</span>
          <span className="inline-flex items-center gap-1 text-xs">
            Install <ArrowUpRight className="h-3.5 w-3.5" aria-hidden />
          </span>
        </a>
      ))}
    </div>
  );
}
