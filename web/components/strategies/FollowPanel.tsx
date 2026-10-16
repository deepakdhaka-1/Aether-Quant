"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { Loader2 } from "lucide-react";
import { supabaseBrowser } from "@/lib/supabase/client";
import { short } from "@/lib/format";
import { Badge, Banner, btn, cx } from "@/components/ui";
import type { BrokerAccount, Subscription } from "@/components/types";

/** Turn Postgres trigger/constraint errors into something a user can act on. */
export function friendlySubError(msg: string): string {
  if (/already follow a strategy on this market/i.test(msg))
    return "This account already follows another strategy on the same market. Unfollow that one first, or use a different account.";
  if (/connect and approve/i.test(msg))
    return "Live mode needs a fully approved Hyperliquid account (agent and builder fee). Finish the steps on the Connect page, or follow in paper mode.";
  if (/not open for subscriptions/i.test(msg)) return "This strategy isn't accepting new followers right now.";
  if (/does not belong/i.test(msg)) return "That broker account doesn't belong to you.";
  if (/duplicate key|subscriptions_broker_account_id_strategy_id/i.test(msg)) return "You already follow this strategy with that account.";
  if (/allocation_pct/i.test(msg)) return "Allocation must be between 1% and 100%.";
  if (/leverage/i.test(msg)) return "Leverage must be between 1x and 10x.";
  return msg;
}

export function FollowPanel({
  strategyId,
  defaultLeverage,
  accounts,
  subs,
  userId,
}: {
  strategyId: string;
  defaultLeverage: number;
  accounts: BrokerAccount[];
  subs: Subscription[];
  userId: string;
}) {
  const router = useRouter();
  const maxLev = Math.max(1, Math.min(10, Math.floor(defaultLeverage * 2)));
  const usable = accounts.filter((a) => a.status !== "revoked");
  const [editing, setEditing] = useState<Subscription | null>(subs[0] ?? null);
  const [accountId, setAccountId] = useState<string>(subs[0]?.broker_account_id ?? usable.find((a) => !subs.some((s) => s.broker_account_id === a.id))?.id ?? usable[0]?.id ?? "");
  const [alloc, setAlloc] = useState<number>(Math.round((subs[0]?.allocation_pct ?? 0.2) * 100));
  const [lev, setLev] = useState<number>(Math.min(subs[0]?.leverage ?? defaultLeverage, maxLev));
  const [mode, setMode] = useState<"paper" | "live">(subs[0]?.mode ?? "paper");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [ok, setOk] = useState<string | null>(null);

  const account = useMemo(() => usable.find((a) => a.id === accountId), [usable, accountId]);
  const liveReady = !!account && account.status === "active" && account.agent_approved && account.builder_approved;

  if (!usable.length)
    return (
      <div className="space-y-3 p-5">
        <p className="text-sm text-mist-300">Connect a Hyperliquid wallet to follow this strategy. It takes two signatures and you keep custody.</p>
        <Link href="/connect" className={cx(btn.primary, "w-full")}>Connect Hyperliquid</Link>
      </div>
    );

  const pick = (id: string) => {
    setAccountId(id);
    const s = subs.find((x) => x.broker_account_id === id) ?? null;
    setEditing(s);
    if (s) { setAlloc(Math.round(s.allocation_pct * 100)); setLev(Math.min(s.leverage, maxLev)); setMode(s.mode); }
    setErr(null); setOk(null);
  };

  const save = async () => {
    setBusy(true); setErr(null); setOk(null);
    const sb = supabaseBrowser();
    const fields = { allocation_pct: alloc / 100, leverage: lev, mode, enabled: true };
    const res = editing
      ? await sb.from("subscriptions").update(fields).eq("id", editing.id).select().single()
      : await sb.from("subscriptions").insert({ ...fields, user_id: userId, strategy_id: strategyId, broker_account_id: accountId }).select().single();
    setBusy(false);
    if (res.error) return setErr(friendlySubError(res.error.message));
    setEditing(res.data as Subscription);
    setOk(editing ? "Settings saved." : mode === "live" ? "You're following this strategy live." : "You're following this strategy in paper mode.");
    router.refresh();
  };

  const toggleEnabled = async () => {
    if (!editing) return;
    setBusy(true); setErr(null); setOk(null);
    const { data, error } = await supabaseBrowser().from("subscriptions").update({ enabled: !editing.enabled }).eq("id", editing.id).select().single();
    setBusy(false);
    if (error) return setErr(friendlySubError(error.message));
    setEditing(data as Subscription);
    router.refresh();
  };

  const unfollow = async () => {
    if (!editing || !confirm("Unfollow this strategy? Open positions it opened are not closed automatically by unfollowing.")) return;
    setBusy(true); setErr(null);
    const { error } = await supabaseBrowser().from("subscriptions").delete().eq("id", editing.id);
    setBusy(false);
    if (error) return setErr(friendlySubError(error.message));
    setEditing(null);
    setOk("Unfollowed.");
    router.refresh();
  };

  return (
    <div className="space-y-5 p-5">
      {editing && (
        <div className="flex items-center justify-between">
          <Badge tone={editing.enabled ? "good" : "warn"}>{editing.enabled ? `Following · ${editing.mode}` : "Paused"}</Badge>
          <button type="button" className={btn.small} onClick={toggleEnabled} disabled={busy}>{editing.enabled ? "Pause" : "Resume"}</button>
        </div>
      )}

      <label className="block">
        <span className="mb-1.5 block text-xs text-mist-400">Broker account</span>
        <select
          className="w-full rounded-xl border border-ink-600 bg-ink-850 px-3 py-2.5 font-mono text-sm text-mist-100 focus:border-aether/60 focus:outline-none"
          value={accountId}
          onChange={(e) => pick(e.target.value)}
        >
          {usable.map((a) => (
            <option key={a.id} value={a.id}>
              {short(a.wallet_address)} · {a.network} · {a.status}{subs.some((s) => s.broker_account_id === a.id) ? " · following" : ""}
            </option>
          ))}
        </select>
      </label>

      <div>
        <div className="mb-1.5 flex justify-between text-xs">
          <label htmlFor="alloc" className="text-mist-400">Allocation of account equity</label>
          <span className="font-mono text-mist-100">{alloc}%</span>
        </div>
        <input id="alloc" type="range" min={1} max={100} value={alloc} onChange={(e) => setAlloc(Number(e.target.value))} className="w-full" />
      </div>

      <div>
        <div className="mb-1.5 flex justify-between text-xs">
          <label htmlFor="lev" className="text-mist-400">Leverage (max {maxLev}x)</label>
          <span className="font-mono text-mist-100">{lev}x</span>
        </div>
        <input id="lev" type="range" min={1} max={maxLev} step={1} value={lev} onChange={(e) => setLev(Number(e.target.value))} className="w-full" />
        {lev > defaultLeverage && <p className="mt-1 text-[11px] text-warn">Above the strategy default of {defaultLeverage}x. Drawdowns scale with leverage.</p>}
      </div>

      <fieldset>
        <legend className="mb-1.5 text-xs text-mist-400">Mode</legend>
        <div className="grid grid-cols-2 gap-2">
          {(["paper", "live"] as const).map((m) => (
            <label
              key={m}
              className={cx(
                "cursor-pointer rounded-xl border px-3 py-2.5 text-sm transition",
                mode === m ? "border-aether/60 bg-aether/[0.07] text-mist-100" : "border-ink-700 text-mist-400 hover:border-ink-600",
              )}
            >
              <input type="radio" name="mode" value={m} checked={mode === m} onChange={() => setMode(m)} className="sr-only" />
              <span className="block font-medium capitalize">{m}</span>
              <span className="block text-[11px] text-mist-500">{m === "paper" ? "Simulated fills, no funds at risk" : "Real orders on Hyperliquid"}</span>
            </label>
          ))}
        </div>
        {mode === "live" && !liveReady && (
          <p className="mt-2 text-[11px] text-warn">
            This account isn&apos;t fully approved yet. <Link href="/connect" className="underline">Finish connecting</Link> to go live.
          </p>
        )}
      </fieldset>

      {err && <Banner tone="bad">{err}</Banner>}
      {ok && <Banner>{ok}</Banner>}

      <div className="flex flex-col gap-2">
        <button type="button" className={btn.primary} onClick={save} disabled={busy || !accountId}>
          {busy && <Loader2 className="h-4 w-4 animate-spin" />}
          {editing ? "Save changes" : "Follow strategy"}
        </button>
        {editing && (
          <button type="button" className={cx(btn.ghost, "hover:border-loss/60 hover:text-loss")} onClick={unfollow} disabled={busy}>
            Unfollow
          </button>
        )}
      </div>
      <p className="text-[11px] leading-relaxed text-mist-500">
        Each live order carries a small Hyperliquid builder fee, capped at the rate you approved. No subscription fee.
      </p>
    </div>
  );
}
