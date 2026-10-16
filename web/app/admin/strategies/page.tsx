"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

type Strategy = {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  symbol: string;
  timeframe: string;
  direction: string;
  risk_level: "low" | "medium" | "high";
  status: "draft" | "backtested" | "published" | "paused" | "retired";
  source: string;
  model_name: string | null;
  default_leverage: number;
  headline_metrics: { return_pct?: number; sharpe?: number; max_drawdown_pct?: number; trades?: number; win_rate?: number };
  generation_meta: { out_of_sample?: { return_pct?: number; sharpe?: number } };
  created_at: string;
  published_at: string | null;
};

const ORDER = ["backtested", "published", "paused", "draft", "retired"] as const;
const BADGE: Record<string, string> = {
  published: "bg-aether/15 text-aether",
  backtested: "bg-ink-700 text-mist-100",
  paused: "bg-warn/15 text-warn",
  draft: "bg-ink-800 text-mist-400",
  retired: "bg-loss/10 text-loss",
};
const ACTIONS: Record<string, { to: string; label: string; confirm?: string }[]> = {
  draft: [{ to: "retired", label: "Retire" }],
  backtested: [{ to: "published", label: "Publish", confirm: "Publish this strategy? Users will be able to follow it with real money." }, { to: "retired", label: "Retire" }],
  published: [{ to: "paused", label: "Pause" }, { to: "retired", label: "Retire", confirm: "Retire? Followers' positions in this strategy will be closed." }],
  paused: [{ to: "published", label: "Resume" }, { to: "retired", label: "Retire", confirm: "Retire? Followers' positions in this strategy will be closed." }],
  retired: [],
};

const pct = (v?: number) => (v === undefined || v === null ? "-" : `${v}%`);
const tone = (v?: number) => (v === undefined ? "" : v >= 0 ? "text-aether" : "text-loss");

export default function StrategiesAdmin() {
  const [rows, setRows] = useState<Strategy[]>([]);
  const [filter, setFilter] = useState<string>("all");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState({ description: "", risk_level: "medium" });

  const load = useCallback(async () => {
    const r = await fetch("/api/admin/strategies", { cache: "no-store" });
    const j = await r.json();
    if (!r.ok) setErr(j.error ?? "failed to load");
    else setRows(j.strategies);
  }, []);
  useEffect(() => {
    load();
  }, [load]);

  async function patch(id: string, body: Record<string, unknown>) {
    setBusy(id);
    setErr("");
    const r = await fetch("/api/admin/strategies", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id, ...body }) });
    const j = await r.json();
    setBusy(null);
    if (!r.ok) return setErr(j.error ?? "update failed");
    await load();
  }

  const counts = useMemo(() => Object.fromEntries(ORDER.map((s) => [s, rows.filter((r) => r.status === s).length])), [rows]);
  const shown = useMemo(
    () => rows.filter((r) => filter === "all" || r.status === filter).sort((a, b) => ORDER.indexOf(a.status) - ORDER.indexOf(b.status)),
    [rows, filter],
  );

  return (
    <div>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold">Strategies</h1>
          <p className="mt-1 text-sm text-mist-400">Publish, pause or retire. Pausing keeps followers&apos; open positions but stops new trades. Retiring closes them.</p>
        </div>
        <div className="flex flex-wrap gap-1 text-sm">
          {["all", ...ORDER].map((s) => (
            <button key={s} onClick={() => setFilter(s)} className={`rounded-md px-3 py-1 ${filter === s ? "bg-ink-700 text-mist-100" : "text-mist-400 hover:text-mist-100"}`}>
              {s}{s !== "all" ? ` (${counts[s] ?? 0})` : ""}
            </button>
          ))}
        </div>
      </div>
      {err && <p className="mt-4 text-sm text-loss">{err}</p>}
      <div className="mt-6 overflow-x-auto rounded-xl border border-ink-700 bg-ink-900">
        <table className="w-full min-w-[960px] text-left text-sm">
          <thead className="text-xs uppercase tracking-wider text-mist-400">
            <tr className="border-b border-ink-700">
              {["Strategy", "Market", "Status", "Risk", "Return", "Sharpe", "Max DD", "Trades / win", "OOS return", "Actions"].map((h) => (
                <th key={h} className="px-3 py-3 font-medium">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {shown.map((s) => {
              const m = s.headline_metrics ?? {};
              const oos = s.generation_meta?.out_of_sample;
              return (
                <tr key={s.id} className="border-b border-ink-800 align-top last:border-0">
                  <td className="max-w-xs px-3 py-3">
                    <div className="font-medium text-mist-100">{s.name}</div>
                    {editing === s.id ? (
                      <div className="mt-2 space-y-2">
                        <textarea className="h-20 w-full rounded-md border border-ink-600 bg-ink-850 p-2 text-xs" value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} />
                        <div className="flex gap-2">
                          <select className="rounded-md border border-ink-600 bg-ink-850 px-2 py-1 text-xs" value={draft.risk_level} onChange={(e) => setDraft({ ...draft, risk_level: e.target.value })}>
                            {["low", "medium", "high"].map((r) => <option key={r}>{r}</option>)}
                          </select>
                          <button className="rounded-md bg-aether px-2 py-1 text-xs text-ink-950" onClick={async () => { await patch(s.id, draft); setEditing(null); }}>Save</button>
                          <button className="text-xs text-mist-400" onClick={() => setEditing(null)}>Cancel</button>
                        </div>
                      </div>
                    ) : (
                      <>
                        <div className="mt-1 line-clamp-2 text-xs text-mist-400">{s.description ?? "No description"}</div>
                        <div className="mt-1 font-mono text-[11px] text-mist-500">{s.source}{s.model_name ? ` · ${s.model_name}` : ""} · {s.direction} · {s.default_leverage}x</div>
                      </>
                    )}
                  </td>
                  <td className="px-3 py-3 font-mono">{s.symbol} · {s.timeframe}</td>
                  <td className="px-3 py-3"><span className={`rounded px-2 py-0.5 text-xs ${BADGE[s.status]}`}>{s.status}</span></td>
                  <td className="px-3 py-3 text-mist-300">{s.risk_level}</td>
                  <td className={`px-3 py-3 font-mono ${tone(m.return_pct)}`}>{pct(m.return_pct)}</td>
                  <td className="px-3 py-3 font-mono">{m.sharpe ?? "-"}</td>
                  <td className="px-3 py-3 font-mono text-loss">{pct(m.max_drawdown_pct)}</td>
                  <td className="px-3 py-3 font-mono">{m.trades ?? "-"} / {pct(m.win_rate)}</td>
                  <td className={`px-3 py-3 font-mono ${tone(oos?.return_pct)}`}>{pct(oos?.return_pct)}</td>
                  <td className="px-3 py-3">
                    <div className="flex flex-wrap gap-2">
                      {ACTIONS[s.status].map((a) => (
                        <button
                          key={a.to}
                          disabled={busy === s.id}
                          onClick={() => (!a.confirm || confirm(a.confirm)) && patch(s.id, { status: a.to })}
                          className={`rounded-md border px-2 py-1 text-xs disabled:opacity-50 ${a.to === "published" ? "border-aether text-aether hover:bg-aether/10" : a.to === "retired" ? "border-loss/50 text-loss hover:bg-loss/10" : "border-ink-600 text-mist-300 hover:bg-ink-800"}`}
                        >
                          {a.label}
                        </button>
                      ))}
                      {s.status !== "retired" && editing !== s.id && (
                        <button className="rounded-md px-2 py-1 text-xs text-mist-400 hover:text-mist-100" onClick={() => { setEditing(s.id); setDraft({ description: s.description ?? "", risk_level: s.risk_level }); }}>Edit</button>
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}
            {!shown.length && (
              <tr><td colSpan={10} className="px-3 py-10 text-center text-mist-400">No strategies here. Generate some in the Strategy Lab.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
