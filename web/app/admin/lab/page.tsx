"use client";

import { useState } from "react";

type Metrics = {
  return_pct: number;
  max_drawdown_pct: number;
  sharpe: number;
  trades: number;
  win_rate: number;
  profit_factor: number | null;
  avg_trade_pct: number;
};
type ReportRow = {
  name: string | null;
  passed?: boolean;
  strategy_id?: string | null;
  error?: string;
  in_sample?: Metrics;
  out_of_sample?: Metrics;
};

const TIMEFRAMES = ["15m", "1h", "4h", "1d"];
const SYMBOLS = ["NVDA", "TSLA", "AAPL", "MSFT", "AMZN", "GOOGL", "META", "XYZ100", "GOLD", "SILVER", "CL", "BRENTOIL", "NATGAS", "COPPER"];

const card = "rounded-xl border border-ink-700 bg-ink-900 p-5";
const input = "w-full rounded-md border border-ink-600 bg-ink-850 px-3 py-2 text-sm text-mist-100 placeholder:text-mist-500 focus:border-aether focus:outline-none";
const label = "mb-1 block text-xs uppercase tracking-wider text-mist-400";
const btn = "rounded-md bg-aether px-4 py-2 text-sm font-medium text-ink-950 hover:bg-aether-soft disabled:cursor-not-allowed disabled:opacity-50";

async function engine(path: string, init: RequestInit) {
  const r = await fetch(`/api/admin/engine/${path}`, { method: "POST", ...init });
  if (!r.ok) {
    const t = await r.text();
    let msg = t;
    try {
      const j = JSON.parse(t);
      msg = j.detail ?? j.error ?? t;
    } catch {}
    throw new Error(typeof msg === "string" ? msg : JSON.stringify(msg));
  }
  return r;
}

function SymbolTf({ symbol, setSymbol, tf, setTf }: { symbol: string; setSymbol: (s: string) => void; tf: string; setTf: (s: string) => void }) {
  return (
    <>
      <div>
        <label className={label}>Symbol</label>
        <input className={input} list="aq-symbols" value={symbol} onChange={(e) => setSymbol(e.target.value.toUpperCase())} />
      </div>
      <div>
        <label className={label}>Timeframe</label>
        <select className={input} value={tf} onChange={(e) => setTf(e.target.value)}>
          {TIMEFRAMES.map((t) => <option key={t}>{t}</option>)}
        </select>
      </div>
    </>
  );
}

function MetricsCells({ m }: { m?: Metrics }) {
  if (!m) return <td className="px-2 py-2 text-mist-500" colSpan={4}>-</td>;
  const tone = (v: number) => (v >= 0 ? "text-aether" : "text-loss");
  return (
    <>
      <td className={`px-2 py-2 font-mono ${tone(m.return_pct)}`}>{m.return_pct}%</td>
      <td className="px-2 py-2 font-mono">{m.sharpe}</td>
      <td className="px-2 py-2 font-mono text-loss">{m.max_drawdown_pct}%</td>
      <td className="px-2 py-2 font-mono">{m.trades} / {m.win_rate}%</td>
    </>
  );
}

function Report({ rows }: { rows: ReportRow[] }) {
  return (
    <div className="mt-5 overflow-x-auto">
      <table className="w-full min-w-[820px] text-left text-sm">
        <thead className="text-xs uppercase tracking-wider text-mist-400">
          <tr>
            <th className="px-2 py-2" rowSpan={2}>Candidate</th>
            <th className="px-2 py-2" rowSpan={2}>Result</th>
            <th className="border-l border-ink-700 px-2 py-1" colSpan={4}>In-sample (70%)</th>
            <th className="border-l border-ink-700 px-2 py-1" colSpan={4}>Out-of-sample (30%)</th>
          </tr>
          <tr>
            {["Return", "Sharpe", "Max DD", "Trades / win"].concat(["Return", "Sharpe", "Max DD", "Trades / win"]).map((h, i) => (
              <th key={i} className={`px-2 py-1 font-normal ${i % 4 === 0 ? "border-l border-ink-700" : ""}`}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className="border-t border-ink-800 align-top">
              <td className="px-2 py-2 text-mist-100">{r.name ?? "Untitled"}</td>
              <td className="px-2 py-2">
                {r.error ? (
                  <span className="text-loss" title={r.error}>invalid: {r.error.slice(0, 80)}</span>
                ) : r.passed ? (
                  <span className="text-aether">pass{r.strategy_id ? " · saved" : ""}</span>
                ) : (
                  <span className="text-warn">fail{r.strategy_id ? " · saved" : ""}</span>
                )}
              </td>
              {r.error ? <td colSpan={8} /> : (<><MetricsCells m={r.in_sample} /><MetricsCells m={r.out_of_sample} /></>)}
            </tr>
          ))}
        </tbody>
      </table>
      <p className="mt-3 text-xs text-mist-500">
        Saved candidates land as <span className="font-mono">backtested</span>. Review and publish them on the Strategies page.
      </p>
    </div>
  );
}

function IndicatorsCard() {
  const [file, setFile] = useState<File | null>(null);
  const [tf, setTf] = useState("1h");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  async function run() {
    if (!file) return;
    setBusy(true);
    setErr("");
    try {
      const fd = new FormData();
      fd.append("file", file);
      fd.append("timeframe", tf);
      const blob = await (await engine("indicators", { body: fd })).blob();
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = file.name.replace(/\.csv$/i, "") + `_indicators_${tf}.csv`;
      a.click();
      URL.revokeObjectURL(a.href);
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className={card}>
      <h2 className="text-lg font-semibold">Indicators from CSV</h2>
      <p className="mt-1 text-sm text-mist-400">Upload OHLCV with columns timestamp, open, high, low, close, volume. You get the same file back with every indicator column added.</p>
      <div className="mt-4 grid gap-3 sm:grid-cols-[1fr_140px_auto] sm:items-end">
        <div>
          <label className={label}>OHLCV CSV</label>
          <input type="file" accept=".csv,text/csv" className={input} onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
        </div>
        <div>
          <label className={label}>Timeframe</label>
          <select className={input} value={tf} onChange={(e) => setTf(e.target.value)}>
            {TIMEFRAMES.map((t) => <option key={t}>{t}</option>)}
          </select>
        </div>
        <button className={btn} disabled={!file || busy} onClick={run}>{busy ? "Computing..." : "Download indicators"}</button>
      </div>
      {err && <p className="mt-3 text-sm text-loss">{err}</p>}
    </section>
  );
}

function GenerateCard() {
  const [symbol, setSymbol] = useState("NVDA");
  const [tf, setTf] = useState("1h");
  const [n, setN] = useState(5);
  const [pasted, setPasted] = useState("");
  const [keepFailed, setKeepFailed] = useState(false);
  const [busy, setBusy] = useState<"" | "model" | "paste">("");
  const [err, setErr] = useState("");
  const [rows, setRows] = useState<ReportRow[] | null>(null);

  async function run(mode: "model" | "paste") {
    setErr("");
    let candidates: unknown = undefined;
    if (mode === "paste") {
      try {
        const parsed = JSON.parse(pasted);
        candidates = Array.isArray(parsed) ? parsed : [parsed];
      } catch {
        setErr("Pasted text is not valid JSON. Expect an array of strategy objects.");
        return;
      }
    }
    setBusy(mode);
    setRows(null);
    try {
      const r = await engine("generate", {
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ symbol, timeframe: tf, n, candidates, keep_failed: keepFailed }),
      });
      setRows(await r.json());
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy("");
    }
  }

  return (
    <section className={card}>
      <h2 className="text-lg font-semibold">Generate strategies</h2>
      <p className="mt-1 text-sm text-mist-400">
        Ask the offline model for candidates, or paste candidates from your own model. Each one is compiled against the real indicator columns and tested in-sample and out-of-sample. Only candidates that pass both are saved, unless you choose to keep failures.
      </p>
      <div className="mt-4 grid gap-3 sm:grid-cols-[1fr_140px_100px]">
        <SymbolTf symbol={symbol} setSymbol={setSymbol} tf={tf} setTf={setTf} />
        <div>
          <label className={label}>Count</label>
          <input type="number" min={1} max={20} className={input} value={n} onChange={(e) => setN(Math.max(1, Math.min(20, +e.target.value || 1)))} />
        </div>
      </div>
      <label className="mt-3 flex items-center gap-2 text-sm text-mist-300">
        <input type="checkbox" checked={keepFailed} onChange={(e) => setKeepFailed(e.target.checked)} /> Save failed candidates too
      </label>
      <div className="mt-4 flex flex-wrap gap-3">
        <button className={btn} disabled={!!busy} onClick={() => run("model")}>{busy === "model" ? "Generating (this can take minutes)..." : "Generate with offline model"}</button>
      </div>
      <div className="mt-5">
        <label className={label}>Or paste JSON candidates</label>
        <textarea
          className={`${input} h-40 font-mono text-xs`}
          placeholder='[{"name":"RSI bounce","description":"...","direction":"long","entry_long":"rsi_value crosses above 30","exit_long":"rsi_value > 60","entry_short":null,"exit_short":null,"stop_loss_pct":3,"take_profit_pct":6,"leverage":2}]'
          value={pasted}
          onChange={(e) => setPasted(e.target.value)}
        />
        <button className={`${btn} mt-3`} disabled={!!busy || !pasted.trim()} onClick={() => run("paste")}>{busy === "paste" ? "Testing..." : "Test pasted candidates"}</button>
      </div>
      {err && <p className="mt-3 text-sm text-loss">{err}</p>}
      {rows && (rows.length ? <Report rows={rows} /> : <p className="mt-4 text-sm text-mist-400">No candidates returned.</p>)}
    </section>
  );
}

type BacktestOut = { metrics: Metrics; position: string; period_start: number | null; period_end: number | null; trades: unknown[] };

function BacktestCard() {
  const [symbol, setSymbol] = useState("NVDA");
  const [tf, setTf] = useState("1h");
  const [r, setR] = useState({
    entry_long: "close crosses above ema_value",
    exit_long: "close crosses below ema_value",
    entry_short: "",
    exit_short: "",
    direction: "long",
    stop_loss_pct: "3",
    take_profit_pct: "",
    leverage: "1",
  });
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [out, setOut] = useState<BacktestOut | null>(null);
  const set = (k: keyof typeof r) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setR({ ...r, [k]: e.target.value });

  async function run() {
    setBusy(true);
    setErr("");
    setOut(null);
    const num = (s: string) => (s.trim() === "" ? null : Number(s));
    const str = (s: string) => (s.trim() === "" ? null : s);
    try {
      const res = await engine("backtest", {
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          symbol,
          timeframe: tf,
          rules: {
            entry_long: str(r.entry_long), exit_long: str(r.exit_long),
            entry_short: str(r.entry_short), exit_short: str(r.exit_short),
            direction: r.direction, stop_loss_pct: num(r.stop_loss_pct), take_profit_pct: num(r.take_profit_pct),
            leverage: num(r.leverage) ?? 1,
          },
        }),
      });
      setOut(await res.json());
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const date = (s: number | null) => (s ? new Date(s * 1000).toISOString().slice(0, 10) : "-");

  return (
    <section className={card}>
      <h2 className="text-lg font-semibold">Ad-hoc rule backtest</h2>
      <p className="mt-1 text-sm text-mist-400">
        Rules use indicator columns, <span className="font-mono">and/or/not</span>, comparisons, arithmetic, <span className="font-mono">abs/min/max</span>, <span className="font-mono">_prevN</span> and <span className="font-mono">X crosses above Y</span>. Signals act at the next bar&apos;s open, with fees included.
      </p>
      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        <SymbolTf symbol={symbol} setSymbol={setSymbol} tf={tf} setTf={setTf} />
        {(["entry_long", "exit_long", "entry_short", "exit_short"] as const).map((k) => (
          <div key={k}>
            <label className={label}>{k.replace("_", " ")}</label>
            <input className={`${input} font-mono`} value={r[k]} onChange={set(k)} />
          </div>
        ))}
      </div>
      <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <div>
          <label className={label}>Direction</label>
          <select className={input} value={r.direction} onChange={set("direction")}>
            {["long", "short", "both"].map((d) => <option key={d}>{d}</option>)}
          </select>
        </div>
        <div><label className={label}>Stop loss %</label><input className={input} value={r.stop_loss_pct} onChange={set("stop_loss_pct")} /></div>
        <div><label className={label}>Take profit %</label><input className={input} value={r.take_profit_pct} onChange={set("take_profit_pct")} /></div>
        <div><label className={label}>Leverage</label><input className={input} value={r.leverage} onChange={set("leverage")} /></div>
      </div>
      <button className={`${btn} mt-4`} disabled={busy} onClick={run}>{busy ? "Running..." : "Run backtest"}</button>
      {err && <p className="mt-3 text-sm text-loss">{err}</p>}
      {out && (
        <div className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-4">
          {[
            ["Return", `${out.metrics.return_pct}%`],
            ["Sharpe", out.metrics.sharpe],
            ["Max drawdown", `${out.metrics.max_drawdown_pct}%`],
            ["Trades", out.metrics.trades],
            ["Win rate", `${out.metrics.win_rate}%`],
            ["Profit factor", out.metrics.profit_factor ?? "-"],
            ["Position now", out.position],
            ["Period", `${date(out.period_start)} to ${date(out.period_end)}`],
          ].map(([k, v]) => (
            <div key={String(k)} className="rounded-lg bg-ink-850 p-3">
              <div className="text-xs uppercase tracking-wider text-mist-400">{k}</div>
              <div className="mt-1 font-mono text-mist-100">{String(v)}</div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

export default function LabPage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Strategy Lab</h1>
        <p className="mt-1 text-sm text-mist-400">Build, test and save candidate strategies. Nothing reaches users until you publish it.</p>
      </div>
      <datalist id="aq-symbols">{SYMBOLS.map((s) => <option key={s} value={s} />)}</datalist>
      <GenerateCard />
      <BacktestCard />
      <IndicatorsCard />
    </div>
  );
}
