import type { Metadata } from "next";
import { notFound } from "next/navigation";
import {
  FindingsList, HaltControl, HeartbeatCard, Panel, Stat, Table,
  ageSeconds, fmtAge, freshness, type Finding,
} from "@/components/ops";
import { requireAdmin } from "@/lib/supabase/server";
import { setHalt } from "./actions";

export const metadata: Metadata = { title: "Ops" };
export const dynamic = "force-dynamic";

const TF_S: Record<string, number> = { "15m": 900, "1h": 3600, "4h": 14400, "1d": 86400 };
const HEARTBEATS = [
  { id: "executor", limit: 300 },
  { id: "signals", limit: 1200 },
  { id: "monitor", limit: 600 },
  { id: "fees", limit: 3 * 3600 },
];
const usd = (v: number) => v.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 });
const short = (a?: string | null) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : "");
const tone = { ok: "text-aether", warn: "text-warn", bad: "text-loss" } as const;

type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

export default async function OpsPage() {
  const { sb, isAdmin } = await requireAdmin();
  if (!isAdmin) notFound();

  const now = Date.now();
  const iso = (ms: number) => new Date(now - ms).toISOString();
  const H = 3600_000;

  // All reads go through the admin's session (RLS: is_admin()). broker_accounts columns are listed
  // explicitly because agent_secret_enc is not selectable by clients.
  const [hb, state, accts, snaps, rejected, fees, strategies, daily] = await Promise.all([
    sb.from("heartbeats").select("id, last_run, detail"),
    sb.from("system_state").select("halted, note, updated_at").eq("id", "global").maybeSingle(),
    sb.from("broker_accounts")
      .select("id, user_id, network, wallet_address, status, kill_switch, last_error, updated_at")
      .in("status", ["active", "error", "pending"]).order("created_at", { ascending: false }).limit(200),
    // Executor snapshots every minute: a 10 min window keeps this under PostgREST's 1000-row cap.
    sb.from("account_snapshots").select("broker_account_id, equity, created_at")
      .gte("created_at", iso(10 * 60_000)).order("created_at", { ascending: false }).limit(1000),
    sb.from("orders").select("id, broker_account_id, symbol, side, qty, error, created_at")
      .eq("status", "rejected").order("created_at", { ascending: false }).limit(25),
    // Raw fills only for the rolling 24h; 7d/30d come from the revenue_daily view (aggregated in SQL).
    sb.from("builder_fees").select("fee_usd, filled_at").gte("filled_at", iso(24 * H)).limit(1000),
    sb.from("strategies").select("id, slug, symbol, timeframe").eq("status", "published").order("slug"),
    sb.from("revenue_daily").select("day, fee_usd")
      .gte("day", new Date(now - 30 * 24 * H).toISOString().slice(0, 10)),
  ]);

  const hbById = new Map<string, Row>((hb.data ?? []).map((h: Row) => [h.id, h]));
  const monitor = hbById.get("monitor")?.detail as { findings?: unknown } | null | undefined;
  // detail is free-form jsonb: accept only well-formed findings.
  const findings: Finding[] = (Array.isArray(monitor?.findings) ? monitor.findings : []).filter(
    (f): f is Finding => !!f && typeof f === "object" && typeof (f as Finding).key === "string"
      && typeof (f as Finding).message === "string" && ["crit", "warn", "info"].includes((f as Finding).severity),
  );

  const equity = new Map<string, number>();
  for (const s of (snaps.data ?? []) as Row[]) if (!equity.has(s.broker_account_id)) equity.set(s.broker_account_id, Number(s.equity));

  const fee24h = ((fees.data ?? []) as Row[]).reduce((a, f) => a + Number(f.fee_usd || 0), 0);
  const feeDays = (days: number) => {
    const from = new Date(now - (days - 1) * 24 * H).toISOString().slice(0, 10); // today counts as day 1
    return ((daily.data ?? []) as Row[]).filter((d) => String(d.day) >= from).reduce((a, d) => a + Number(d.fee_usd || 0), 0);
  };

  // Latest signal per published strategy (one small query each; published set is small).
  const strats = (strategies.data ?? []) as Row[];
  const latest = await Promise.all(
    strats.map((s) =>
      sb.from("strategy_signals").select("bar_time, desired").eq("strategy_id", s.id)
        .order("bar_time", { ascending: false }).limit(1).maybeSingle(),
    ),
  );

  const errors = [hb, state, accts, snaps, rejected, fees, strategies, daily].map((r) => r.error?.message).filter(Boolean);

  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-xl font-semibold text-mist-100">Operations</h1>
        <p className="text-sm text-mist-400">Workers, alerts, accounts and revenue. Rendered {new Date(now).toUTCString()}.</p>
      </div>

      {errors.length ? (
        <div className="rounded-lg border border-loss/50 bg-loss/10 p-3 text-sm text-loss">Some queries failed: {errors.join(" · ")}</div>
      ) : null}

      <HaltControl halted={!!state.data?.halted} note={state.data?.note} updatedAt={state.data?.updated_at} action={setHalt} />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {HEARTBEATS.map((h) => {
          const row = hbById.get(h.id);
          const d = row?.detail as Row | undefined;
          const detail =
            h.id === "executor" && d ? `${d.accounts ?? 0} accts · ${d.orders ?? 0} orders · ${d.errors ?? 0} err${d.dry_run ? " · DRY" : ""}`
            : h.id === "signals" && d ? `${d.written ?? 0}/${d.strategies ?? 0} written`
            : h.id === "monitor" && d?.counts ? `${d.counts.crit ?? 0} crit · ${d.counts.warn ?? 0} warn`
            : undefined;
          return <HeartbeatCard key={h.id} name={h.id} lastRun={row?.last_run} limitS={h.limit} detail={detail} />;
        })}
      </div>

      <Panel title="Monitor findings" sub="From heartbeats['monitor'], refreshed every 5 min. crit/warn are alerted (30 min de-dupe).">
        <FindingsList findings={findings} />
      </Panel>

      <div className="grid gap-3 sm:grid-cols-3">
        <Stat label="Builder fees 24h" value={usd(fee24h)} tone="text-aether" />
        <Stat label="Builder fees 7 UTC days" value={usd(feeDays(7))} />
        <Stat label="Builder fees 30 UTC days" value={usd(feeDays(30))} />
      </div>

      <Panel title="Accounts" sub="Equity = latest snapshot in the last 10 min (— = none, e.g. executor down).">
        <Table head={["Account", "Wallet", "Net", "Status", "Equity", "Kill", "Last error"]} empty={!(accts.data ?? []).length}>
          {((accts.data ?? []) as Row[]).map((a) => (
            <tr key={a.id} className="align-top">
              <td className="py-2 pr-3 font-mono text-xs text-mist-300">{a.id.slice(0, 8)}</td>
              <td className="py-2 pr-3 font-mono text-xs text-mist-300">{short(a.wallet_address)}</td>
              <td className="py-2 pr-3 text-mist-300">{a.network}</td>
              <td className={`py-2 pr-3 ${a.status === "active" ? "text-aether" : a.status === "error" ? "text-loss" : "text-warn"}`}>{a.status}</td>
              <td className="py-2 pr-3 font-mono text-mist-100">{equity.has(a.id) ? usd(equity.get(a.id)!) : "—"}</td>
              <td className={`py-2 pr-3 ${a.kill_switch ? "font-semibold text-loss" : "text-mist-500"}`}>{a.kill_switch ? "ON" : "off"}</td>
              <td className="max-w-xs truncate py-2 pr-3 text-xs text-loss" title={a.last_error ?? ""}>{a.last_error ?? ""}</td>
            </tr>
          ))}
        </Table>
      </Panel>

      <div className="grid gap-5 xl:grid-cols-2">
        <Panel title="Signal freshness" sub="Stale after 2 bars: the executor stops opening entries.">
          <Table head={["Strategy", "Market", "TF", "Last bar", "Desired"]} empty={!strats.length}>
            {strats.map((s, i) => {
              const sig = latest[i].data as Row | null;
              const age = ageSeconds(sig?.bar_time, now);
              const t = freshness(age, 2 * (TF_S[s.timeframe] ?? 3600));
              return (
                <tr key={s.id}>
                  <td className="py-2 pr-3 text-mist-100">{s.slug}</td>
                  <td className="py-2 pr-3 text-mist-300">{s.symbol}</td>
                  <td className="py-2 pr-3 text-mist-300">{s.timeframe}</td>
                  <td className={`py-2 pr-3 font-mono ${tone[t]}`}>{fmtAge(age)}</td>
                  <td className="py-2 pr-3 text-mist-300">{sig?.desired ?? "—"}</td>
                </tr>
              );
            })}
          </Table>
        </Panel>

        <Panel title="Recent rejected orders" sub="Last 25.">
          <Table head={["When", "Account", "Symbol", "Side", "Error"]} empty={!(rejected.data ?? []).length}>
            {((rejected.data ?? []) as Row[]).map((o) => (
              <tr key={o.id} className="align-top">
                <td className="py-2 pr-3 font-mono text-xs text-mist-300">{fmtAge(ageSeconds(o.created_at, now))}</td>
                <td className="py-2 pr-3 font-mono text-xs text-mist-300">{String(o.broker_account_id).slice(0, 8)}</td>
                <td className="py-2 pr-3 text-mist-100">{o.symbol}</td>
                <td className="py-2 pr-3 text-mist-300">{o.side}</td>
                <td className="max-w-xs truncate py-2 pr-3 text-xs text-loss" title={o.error ?? ""}>{o.error ?? ""}</td>
              </tr>
            ))}
          </Table>
        </Panel>
      </div>
    </div>
  );
}
