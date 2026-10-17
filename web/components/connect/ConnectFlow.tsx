"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { ArrowUpRight, Check, Loader2, PenLine, ShieldCheck } from "lucide-react";
import { WalletPicker, WalletIcon } from "@/components/wallet/WalletPicker";
import { Banner, btn, cx } from "@/components/ui";
import { connect, signTypedData, walletError, type DiscoveredWallet } from "@/lib/wallets";
import { HL_APP, approveAgentAction, approveBuilderFeeAction, typedData, type Network } from "@/lib/hyperliquid";
import { short } from "@/lib/format";
import { encryptAgentKey } from "@/lib/agent-crypto";
import { supabaseBrowser } from "@/lib/supabase/client";

const NETWORK: Network = process.env.NEXT_PUBLIC_HL_NETWORK === "testnet" ? "testnet" : "mainnet";
const DEFAULT_FEE = process.env.NEXT_PUBLIC_BUILDER_MAX_FEE ?? "0.05%";

type Prepared = { broker_account_id: string; agent_address: string; builder_address: string; max_fee_rate: string; network: Network };
type SubmitResult = { agent_approved?: boolean; builder_approved?: boolean; status?: string; error?: string };

async function post<T>(url: string, body: unknown): Promise<T & { error?: string; _status: number }> {
  const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const j = (await r.json().catch(() => ({}))) as T & { error?: string };
  return { ...j, error: j.error ?? (r.ok ? undefined : `Request failed (${r.status})`), _status: r.status };
}

const STEPS = ["Accept terms", "Connect wallet", "Create agent", "Approve agent", "Approve builder fee"];

export function ConnectFlow() {
  const router = useRouter();
  const [step, setStep] = useState(0); // 0..4, 5 = done
  const [terms, setTerms] = useState(false);
  const [wallet, setWallet] = useState<{ w: DiscoveredWallet; address: string } | null>(null);
  const [prep, setPrep] = useState<Prepared | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [needsDeposit, setNeedsDeposit] = useState(false);

  const fail = (msg: string) => {
    setError(msg);
    setNeedsDeposit(/deposit/i.test(msg) || /does not exist/i.test(msg));
    setBusy(null);
  };

  const pickWallet = async (w: DiscoveredWallet) => {
    setError(null);
    setBusy(w.info.rdns);
    try {
      const { address } = await connect(w.provider);
      setWallet({ w, address });
      setBusy(null);
      await prepare(w, address);
    } catch (e) {
      fail(walletError(e));
    }
  };

  const prepare = async (w = wallet?.w, address = wallet?.address) => {
    if (!w || !address) return;
    setStep(2);
    setError(null);
    setBusy("prepare");
    try {
      const sb = supabaseBrowser();
      const { data: auth } = await sb.auth.getUser();
      if (!auth.user) return fail("Your session expired. Sign in again and retry.");

      // Create in this browser, encrypt to the executor's public key, and send only ciphertext.
      const agentKey = generatePrivateKey();
      const agent = privateKeyToAccount(agentKey);
      if (agent.address.toLowerCase() === address.toLowerCase()) return fail("Agent key collision. Please retry.");
      const agentSecretEnc = await encryptAgentKey(agentKey);
      const { data, error: insertError } = await sb
        .from("broker_accounts")
        .insert({
          user_id: auth.user.id,
          broker: "hyperliquid",
          network: NETWORK,
          wallet_address: address.toLowerCase(),
          wallet_provider: w.info.name.toLowerCase().replace(/\s+wallet$/, ""),
          agent_address: agent.address.toLowerCase(),
          agent_secret_enc: agentSecretEnc,
          agent_key_format: "rsa1",
        })
        .select("id")
        .single();
      if (insertError || !data) {
        if (insertError?.code === "23505") return fail("This wallet already has a saved connection. Revoke it before creating a replacement.");
        return fail(insertError?.message ?? "Could not save your encrypted agent key.");
      }

      setPrep({
        broker_account_id: data.id,
        agent_address: agent.address.toLowerCase(),
        builder_address: process.env.NEXT_PUBLIC_BUILDER_ADDRESS ?? "0x42A8B8e6f960D399DeB81c5C103b6313f828d06F",
        max_fee_rate: DEFAULT_FEE,
        network: NETWORK,
      });
      setBusy(null);
      setStep(3);
    } catch (e) {
      fail(e instanceof Error ? e.message : "Could not create the encrypted agent key.");
    }
  };

  const chainId = async (w: DiscoveredWallet) => parseInt((await w.provider.request({ method: "eth_chainId" })) as string, 16);

  const sign = async (kind: "agent" | "builder") => {
    if (!wallet || !prep) return;
    setError(null);
    setNeedsDeposit(false);
    setBusy(kind);
    try {
      const cid = await chainId(wallet.w);
      const action =
        kind === "agent"
          ? approveAgentAction(prep.network, cid, prep.agent_address)
          : approveBuilderFeeAction(prep.network, cid, prep.builder_address, prep.max_fee_rate);
      const signature = await signTypedData(wallet.w.provider, wallet.address, typedData(action));
      setBusy(`${kind}-submit`);
      const r = await post<SubmitResult>("/api/broker/submit", { broker_account_id: prep.broker_account_id, action, signature });
      const done = kind === "agent" ? r.agent_approved : r.builder_approved;
      if (!done) return fail(r.error ?? "Hyperliquid hasn't confirmed this approval yet. Try again in a moment.");
      setBusy(null);
      if (kind === "agent") setStep(r.builder_approved ? 5 : 4);
      else setStep(r.agent_approved ? 5 : 3);
      router.refresh();
    } catch (e) {
      fail(walletError(e));
    }
  };

  const restart = () => {
    setStep(0); setTerms(false); setWallet(null); setPrep(null); setError(null); setNeedsDeposit(false); setBusy(null);
  };

  const fee = prep?.max_fee_rate ?? DEFAULT_FEE;

  return (
    <div className="grid gap-0 md:grid-cols-[220px_1fr]">
      <ol className="flex gap-2 overflow-x-auto border-b border-ink-800 p-4 md:flex-col md:gap-1 md:border-b-0 md:border-r md:p-5" aria-label="Progress">
        {STEPS.map((label, i) => {
          const state = step > i ? "done" : step === i ? "now" : "todo";
          return (
            <li key={label} aria-current={state === "now" ? "step" : undefined} className="flex shrink-0 items-center gap-2.5 py-1 text-xs">
              <span
                className={cx(
                  "flex h-6 w-6 items-center justify-center rounded-full border font-mono text-[10px]",
                  state === "done" && "border-aether bg-aether text-ink-950",
                  state === "now" && "border-aether text-aether",
                  state === "todo" && "border-ink-600 text-mist-500",
                )}
              >
                {state === "done" ? <Check className="h-3.5 w-3.5" aria-hidden /> : i + 1}
              </span>
              <span className={cx("hidden sm:inline", state === "todo" ? "text-mist-500" : "text-mist-100")}>{label}</span>
            </li>
          );
        })}
      </ol>

      <div className="space-y-4 p-5">
        {error && (
          <Banner
            tone="bad"
            action={
              needsDeposit ? (
                <a href={HL_APP[NETWORK]} target="_blank" rel="noreferrer" className={btn.small}>
                  Deposit on Hyperliquid <ArrowUpRight className="h-3.5 w-3.5" aria-hidden />
                </a>
              ) : undefined
            }
          >
            {error}
            {needsDeposit && (
              <span className="mt-1 block text-xs text-mist-400">
                Hyperliquid only accepts approvals from wallets that have deposited. Deposit any amount of USDC, then sign again.
              </span>
            )}
          </Banner>
        )}

        {step === 0 && (
          <div className="space-y-4">
            <h3 className="text-base font-semibold">Before you connect</h3>
            <ul className="space-y-2.5 text-sm text-mist-300">
              <li className="flex gap-2.5"><ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-aether" aria-hidden />We create an agent (API) wallet that can place and cancel trades on your Hyperliquid account. It can never withdraw or transfer funds.</li>
              <li className="flex gap-2.5"><ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-aether" aria-hidden />You approve a builder fee of up to <span className="font-mono text-mist-100">{fee}</span> per order. That fee is how we&apos;re paid. There is no subscription.</li>
              <li className="flex gap-2.5"><ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-aether" aria-hidden />You can revoke the agent at any time on Hyperliquid (More &gt; API), or hit the kill switch here.</li>
            </ul>
            <label className="flex cursor-pointer items-start gap-3 rounded-xl border border-ink-700 p-3.5 text-sm">
              <input type="checkbox" checked={terms} onChange={(e) => setTerms(e.target.checked)} className="mt-0.5 h-4 w-4 accent-[#1E6B62]" />
              <span className="text-mist-300">
                I understand the above and accept the <a href="/legal-terms" target="_blank" className="underline">Terms</a> and{" "}
                <a href="/legal-risk" target="_blank" className="underline">Risk disclosure</a>. Trading leveraged perpetuals can lose more than expected.
              </span>
            </label>
            <button type="button" className={btn.primary} disabled={!terms} onClick={() => setStep(1)}>Continue</button>
          </div>
        )}

        {step === 1 && (
          <div className="space-y-3">
            <h3 className="text-base font-semibold">Pick the wallet that holds your Hyperliquid funds</h3>
            <p className="text-xs text-mist-400">Network: <span className="font-mono text-mist-300">{NETWORK}</span></p>
            <WalletPicker onPick={pickWallet} busy={busy} />
          </div>
        )}

        {step >= 2 && wallet && (
          <div className="flex items-center gap-3 rounded-xl border border-ink-700 bg-ink-850 p-3">
            <WalletIcon icon={wallet.w.info.icon} name={wallet.w.info.name} />
            <div className="min-w-0 flex-1">
              <div className="text-sm text-mist-100">{wallet.w.info.name}</div>
              <div className="font-mono text-xs text-mist-400">{short(wallet.address)}</div>
            </div>
            {step < 5 && <button type="button" onClick={restart} className={btn.small}>Change</button>}
          </div>
        )}

        {step === 2 && (
          <div className="space-y-3">
            <h3 className="text-base font-semibold">Creating your agent wallet</h3>
            {busy === "prepare" ? (
              <p className="flex items-center gap-2 text-sm text-mist-300"><Loader2 className="h-4 w-4 animate-spin text-aether" /> Generating and encrypting your trading key in this browser…</p>
            ) : (
              <button type="button" className={btn.primary} onClick={() => prepare()}>Try again</button>
            )}
          </div>
        )}

        {(step === 3 || step === 4) && prep && (
          <div className="space-y-4">
            <Checklist
              items={[
                { label: "Agent wallet created", detail: short(prep.agent_address), done: true },
                { label: "Agent approved on Hyperliquid", detail: "Lets the agent trade. It can't withdraw.", done: step > 3 },
                { label: `Builder fee approved (max ${prep.max_fee_rate})`, detail: `Builder ${short(prep.builder_address)}`, done: false },
              ]}
            />
            {step === 3 ? (
              <SignButton busy={busy} kind="agent" onClick={() => sign("agent")} label="Sign: approve agent" />
            ) : (
              <SignButton busy={busy} kind="builder" onClick={() => sign("builder")} label={`Sign: approve builder fee (max ${prep.max_fee_rate})`} />
            )}
            <p className="text-[11px] leading-relaxed text-mist-500">
              Your wallet will show a typed-data signature request from Hyperliquid. It is not a transaction and costs no gas.
              If your wallet asks to switch networks, you can stay on your current one.
            </p>
          </div>
        )}

        {step === 5 && (
          <div className="space-y-4">
            <div className="flex items-center gap-3 rounded-xl border border-aether/40 bg-aether/[0.06] p-4">
              <span className="flex h-9 w-9 items-center justify-center rounded-full bg-aether text-ink-950"><Check className="h-5 w-5" aria-hidden /></span>
              <div>
                <div className="font-semibold">Hyperliquid approvals saved</div>
                <div className="text-xs text-mist-400">Your encrypted agent key and approvals are saved. Live execution stays pending until the executor supports this key format.</div>
              </div>
            </div>
            <div className="flex flex-wrap gap-2">
              <a href="/strategies" className={btn.primary}>Browse strategies</a>
              <button type="button" className={btn.ghost} onClick={restart}>Connect another wallet</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function SignButton({ busy, kind, onClick, label }: { busy: string | null; kind: string; onClick: () => void; label: string }) {
  const signing = busy === kind;
  const submitting = busy === `${kind}-submit`;
  return (
    <button type="button" className={btn.primary} onClick={onClick} disabled={!!busy}>
      {signing || submitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <PenLine className="h-4 w-4" aria-hidden />}
      {signing ? "Waiting for your wallet…" : submitting ? "Confirming on Hyperliquid…" : label}
    </button>
  );
}

export function Checklist({ items }: { items: { label: string; detail?: string; done: boolean; bad?: boolean }[] }) {
  return (
    <ul className="space-y-2">
      {items.map((it) => (
        <li key={it.label} className="flex items-start gap-3 text-sm">
          <span
            className={cx(
              "mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full border",
              it.done ? "border-aether bg-aether text-ink-950" : it.bad ? "border-loss text-loss" : "border-ink-600",
            )}
            aria-hidden
          >
            {it.done && <Check className="h-3 w-3" />}
          </span>
          <span>
            <span className={it.done ? "text-mist-100" : "text-mist-300"}>{it.label}</span>
            <span className="sr-only">{it.done ? " (done)" : " (pending)"}</span>
            {it.detail && <span className="block font-mono text-[11px] text-mist-500">{it.detail}</span>}
          </span>
        </li>
      ))}
    </ul>
  );
}
