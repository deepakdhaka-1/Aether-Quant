"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { ArrowUpRight, Loader2, Power, RefreshCw } from "lucide-react";
import { supabaseBrowser } from "@/lib/supabase/client";
import { HL_APP } from "@/lib/hyperliquid";
import { short } from "@/lib/format";
import { Badge, Banner, Empty, btn, cx } from "@/components/ui";
import type { BrokerAccount } from "@/components/types";
import { Checklist } from "./ConnectFlow";

const statusTone = { active: "good", pending: "warn", error: "bad", revoked: "default" } as const;

export function BrokerAccounts({ accounts: initial, compact = false }: { accounts: BrokerAccount[]; compact?: boolean }) {
  const [accounts, setAccounts] = useState(initial);
  if (!accounts.length)
    return <Empty title="No Hyperliquid wallets connected">Connect the wallet that holds your Hyperliquid funds to start trading.</Empty>;
  return (
    <ul className="divide-y divide-ink-800">
      {accounts.map((a) => (
        <Row key={a.id} a={a} compact={compact} onChange={(n) => setAccounts((all) => all.map((x) => (x.id === n.id ? n : x)))} />
      ))}
    </ul>
  );
}

function Row({ a, onChange, compact }: { a: BrokerAccount; onChange: (a: BrokerAccount) => void; compact: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);

  const toggleKill = async () => {
    const next = !a.kill_switch;
    if (next && !confirm("Activate the kill switch? We stop opening trades on this account and close open positions with reduce-only orders.")) return;
    setBusy("kill"); setErr(null);
    const { error } = await supabaseBrowser().from("broker_accounts").update({ kill_switch: next }).eq("id", a.id);
    setBusy(null);
    if (error) return setErr(error.message);
    onChange({ ...a, kill_switch: next });
    router.refresh();
  };

  const refresh = async () => {
    setBusy("refresh"); setErr(null); setMsg(null);
    const r = await fetch("/api/broker/refresh", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ broker_account_id: a.id }) });
    const j = (await r.json().catch(() => ({}))) as Partial<BrokerAccount> & { error?: string };
    setBusy(null);
    if (!r.ok || j.error) return setErr(j.error ?? `Refresh failed (${r.status})`);
    onChange({ ...a, ...j, last_error: j.last_error ?? null });
    setMsg("Approvals re-checked on Hyperliquid.");
    router.refresh();
  };

  const revoke = async () => {
    if (!confirm("Disconnect this wallet? Trading stops, open positions are closed and all follows on this account are disabled.")) return;
    setBusy("revoke"); setErr(null);
    const r = await fetch("/api/broker/revoke", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ broker_account_id: a.id }) });
    const j = (await r.json().catch(() => ({}))) as { error?: string; message?: string };
    setBusy(null);
    if (!r.ok) return setErr(j.error ?? `Disconnect failed (${r.status})`);
    onChange({ ...a, status: "revoked", kill_switch: true });
    setMsg(j.message ?? "Disconnected.");
    router.refresh();
  };

  const revoked = a.status === "revoked";

  return (
    <li className="space-y-3 px-5 py-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-sm text-mist-100">{short(a.wallet_address)}</span>
        <Badge tone={statusTone[a.status] ?? "default"}>{a.status}</Badge>
        <Badge>{a.network}</Badge>
        {a.wallet_provider && <Badge>{a.wallet_provider}</Badge>}
        {a.kill_switch && !revoked && <Badge tone="bad">kill switch on</Badge>}
      </div>
      {!compact && (
        <Checklist
          items={[
            { label: "Agent approved", detail: short(a.agent_address), done: a.agent_approved },
            { label: `Builder fee approved${a.builder_max_fee ? ` (max ${a.builder_max_fee})` : ""}`, done: a.builder_approved },
          ]}
        />
      )}
      {a.last_error && !revoked && <p className="text-xs text-loss">{a.last_error}</p>}
      {err && <Banner tone="bad">{err}</Banner>}
      {msg && <Banner>{msg}</Banner>}
      {!revoked && (
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            role="switch"
            aria-checked={a.kill_switch}
            onClick={toggleKill}
            disabled={!!busy}
            className={cx(btn.small, a.kill_switch ? "border-loss/60 bg-loss/10 text-loss hover:text-loss" : "")}
          >
            {busy === "kill" ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Power className="h-3.5 w-3.5" aria-hidden />}
            {a.kill_switch ? "Kill switch on, tap to resume" : "Kill switch"}
          </button>
          <button type="button" onClick={refresh} disabled={!!busy} className={btn.small}>
            <RefreshCw className={cx("h-3.5 w-3.5", busy === "refresh" && "animate-spin")} aria-hidden /> Refresh
          </button>
          {!compact && (
            <>
              <a href={`${HL_APP[a.network]}/API`} target="_blank" rel="noreferrer" className={btn.small}>
                Manage on Hyperliquid <ArrowUpRight className="h-3.5 w-3.5" aria-hidden />
              </a>
              <button type="button" onClick={revoke} disabled={!!busy} className={cx(btn.small, "hover:border-loss/60 hover:text-loss")}>
                Disconnect
              </button>
            </>
          )}
        </div>
      )}
      {a.status === "pending" && !compact && (
        <p className="text-xs text-mist-400">Approvals incomplete. Run the connect flow above with this wallet to finish, then refresh.</p>
      )}
    </li>
  );
}
