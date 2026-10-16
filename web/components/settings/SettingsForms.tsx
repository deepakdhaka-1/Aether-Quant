"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { Loader2 } from "lucide-react";
import { supabaseBrowser } from "@/lib/supabase/client";
import { Banner, btn, input } from "@/components/ui";

export type Risk = { max_daily_loss_pct: number; max_drawdown_pct: number; max_gross_leverage: number; trading_enabled: boolean };

export function ProfileForm({ username }: { username: string }) {
  const router = useRouter();
  const [v, setV] = useState(username);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const save = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true); setMsg(null);
    const sb = supabaseBrowser();
    const { data } = await sb.auth.getUser();
    const { error } = await sb.from("profiles").update({ username: v.trim() || null }).eq("id", data.user?.id ?? "");
    setBusy(false);
    setMsg(error ? { ok: false, text: /duplicate|unique/i.test(error.message) ? "That username is taken." : error.message } : { ok: true, text: "Saved." });
    if (!error) router.refresh();
  };
  return (
    <form onSubmit={save} className="space-y-3 p-5">
      <label className="block">
        <span className="mb-1 block text-xs text-mist-400">Username</span>
        <input className={input} value={v} onChange={(e) => setV(e.target.value)} maxLength={32} pattern="[A-Za-z0-9_.\-]{3,32}" title="3-32 letters, numbers, _ . -" />
      </label>
      {msg && <Banner tone={msg.ok ? "info" : "bad"}>{msg.text}</Banner>}
      <button className={btn.primary} disabled={busy}>{busy && <Loader2 className="h-4 w-4 animate-spin" />}Save profile</button>
    </form>
  );
}

const FIELDS: { key: keyof Omit<Risk, "trading_enabled">; label: string; min: number; max: number; step: number; suffix: string; help: string }[] = [
  { key: "max_daily_loss_pct", label: "Max daily loss", min: 0.5, max: 50, step: 0.5, suffix: "%", help: "Trading pauses for the day if equity falls this much." },
  { key: "max_drawdown_pct", label: "Max drawdown", min: 1, max: 90, step: 1, suffix: "%", help: "Trading stops if equity falls this far from its peak." },
  { key: "max_gross_leverage", label: "Max gross leverage", min: 0.5, max: 10, step: 0.5, suffix: "x", help: "Cap on total exposure across all followed strategies." },
];

export function RiskForm({ initial }: { initial: Risk }) {
  const [r, setR] = useState<Risk>(initial);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const save = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true); setMsg(null);
    const sb = supabaseBrowser();
    const { data } = await sb.auth.getUser();
    if (!data.user) { setBusy(false); return setMsg({ ok: false, text: "Your session expired. Sign in again." }); }
    const { error } = await sb.from("user_risk").upsert({ user_id: data.user.id, ...r });
    setBusy(false);
    setMsg(error ? { ok: false, text: error.message } : { ok: true, text: "Risk limits saved. The engine applies them on its next run." });
  };
  return (
    <form onSubmit={save} className="space-y-5 p-5">
      <label className="flex items-center justify-between gap-4 rounded-xl border border-ink-700 p-3.5">
        <span>
          <span className="block text-sm text-mist-100">Trading enabled</span>
          <span className="block text-xs text-mist-400">Turn off to pause all new live and paper orders across your accounts.</span>
        </span>
        <input type="checkbox" role="switch" checked={r.trading_enabled} onChange={(e) => setR({ ...r, trading_enabled: e.target.checked })} className="h-5 w-5 accent-[#7cf5d4]" />
      </label>
      {FIELDS.map((f) => (
        <div key={f.key}>
          <div className="mb-1.5 flex justify-between text-xs">
            <label htmlFor={f.key} className="text-mist-400">{f.label}</label>
            <span className="font-mono text-mist-100">{r[f.key]}{f.suffix}</span>
          </div>
          <input id={f.key} type="range" min={f.min} max={f.max} step={f.step} value={r[f.key]} onChange={(e) => setR({ ...r, [f.key]: Number(e.target.value) })} className="w-full" />
          <p className="mt-1 text-[11px] text-mist-500">{f.help}</p>
        </div>
      ))}
      {msg && <Banner tone={msg.ok ? "info" : "bad"}>{msg.text}</Banner>}
      <button className={btn.primary} disabled={busy}>{busy && <Loader2 className="h-4 w-4 animate-spin" />}Save risk limits</button>
    </form>
  );
}
