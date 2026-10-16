"use client";

// EVM wallet discovery via EIP-6963: every installed wallet (MetaMask, OKX Wallet, Rabby,
// Coinbase, Brave...) announces itself with its own name and official icon, so we never ship or
// hot-link third-party logos and multiple installed wallets never fight over window.ethereum.

export type Eip1193 = {
  request: (args: { method: string; params?: unknown[] | Record<string, unknown> }) => Promise<unknown>;
};

export type WalletInfo = { uuid: string; name: string; icon: string; rdns: string };
export type DiscoveredWallet = { info: WalletInfo; provider: Eip1193 };

export const FEATURED: { rdns: string; name: string; install: string; logo?: string }[] = [
  { rdns: "io.metamask", name: "MetaMask", install: "https://metamask.io/download/" },
  { rdns: "com.okex.wallet", name: "OKX Wallet", install: "https://web3.okx.com/download", logo: "/brand/okx.svg" },
  { rdns: "io.rabby", name: "Rabby", install: "https://rabby.io/" },
];

export function discoverWallets(onChange: (w: DiscoveredWallet[]) => void): () => void {
  const found = new Map<string, DiscoveredWallet>();
  const handler = (e: Event) => {
    const d = (e as CustomEvent<DiscoveredWallet>).detail;
    if (!d?.info?.rdns) return;
    found.set(d.info.rdns, d);
    onChange([...found.values()]);
  };
  window.addEventListener("eip6963:announceProvider", handler);
  window.dispatchEvent(new Event("eip6963:requestProvider"));

  // Legacy fallbacks for wallets/browsers without EIP-6963.
  const w = window as unknown as { ethereum?: Eip1193 & { isMetaMask?: boolean }; okxwallet?: Eip1193 };
  const t = setTimeout(() => {
    if (!found.has("com.okex.wallet") && w.okxwallet) {
      found.set("com.okex.wallet", {
        info: { uuid: "okx-legacy", name: "OKX Wallet", icon: "/brand/okx.svg", rdns: "com.okex.wallet" },
        provider: w.okxwallet,
      });
    }
    if (found.size === 0 && w.ethereum) {
      found.set("injected", {
        info: { uuid: "injected", name: w.ethereum.isMetaMask ? "MetaMask" : "Browser wallet", icon: "", rdns: w.ethereum.isMetaMask ? "io.metamask" : "injected" },
        provider: w.ethereum,
      });
    }
    onChange([...found.values()]);
  }, 400);

  return () => {
    clearTimeout(t);
    window.removeEventListener("eip6963:announceProvider", handler);
  };
}

export async function connect(p: Eip1193): Promise<{ address: `0x${string}`; chainId: number }> {
  const accounts = (await p.request({ method: "eth_requestAccounts" })) as string[];
  if (!accounts?.[0]) throw new Error("No account returned by the wallet");
  const chainHex = (await p.request({ method: "eth_chainId" })) as string;
  return { address: accounts[0].toLowerCase() as `0x${string}`, chainId: parseInt(chainHex, 16) };
}

export async function personalSign(p: Eip1193, address: string, message: string): Promise<`0x${string}`> {
  const hex = "0x" + Array.from(new TextEncoder().encode(message)).map((b) => b.toString(16).padStart(2, "0")).join("");
  return (await p.request({ method: "personal_sign", params: [hex, address] })) as `0x${string}`;
}

export async function signTypedData(p: Eip1193, address: string, data: unknown): Promise<`0x${string}`> {
  return (await p.request({ method: "eth_signTypedData_v4", params: [address, JSON.stringify(data)] })) as `0x${string}`;
}

export function walletError(e: unknown): string {
  const err = e as { code?: number; message?: string };
  if (err?.code === 4001) return "You rejected the request in your wallet.";
  return err?.message ?? "Wallet error";
}
