import type { ReactNode } from "react";

/** Ops dashboard building blocks (server components, no client JS). */

export type Severity = "crit" | "warn" | "info";
export type Finding = { key: string; severity: Severity; check: string; message: string };

export function ageSeconds(iso?: string | null, now = Date.now()): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : Math.max(0, (now - t) / 1000);
}

export function fmtAge(s: number | null): string {
  if (s === null) return "never";
  if (s < 120) return `${Math.round(s)}s`;
  if (s < 7200) return `${Math.round(s / 60)}m`;
  if (s < 172800) return `${Math.floor(s / 3600)}h ${Math.round((s % 3600) / 60)}m`;
  return `${Math.floor(s / 86400)}d`;
}

/** ok when age <= limit, warn up to 2x, bad beyond (or never). */
export function freshness(age: number | null, limit: number): "ok" | "warn" | "bad" {
  if (age === null) return "bad";
  if (age <= limit) return "ok";
  return age <= limit * 2 ? "warn" : "bad";
}

const toneText = { ok: "text-aether", warn: "text-warn", bad: "text-loss" } as const;
const toneDot = { ok: "bg-aether", warn: "bg-warn", bad: "bg-loss" } as const;
const toneRing = { ok: "border-aether/30", warn: "border-warn/40", bad: "border-loss/50" } as const;

export function Panel({ title, sub, children, right }: { title: string; sub?: string; children: ReactNode; right?: ReactNode }) {
  return (
    <section className="rounded-xl border border-ink-700 bg-ink-900/70 p-4 sm:p-5">
      <header className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <h2 className="text-sm font-semibold uppercase tracking-wider text-mist-100">{title}</h2>
          {sub ? <p className="mt-0.5 text-xs text-mist-400">{sub}</p> : null}
        </div>
        {right}
      </header>
      {children}
    </section>
  );
}

export function HeartbeatCard({ name, lastRun, limitS, detail }: { name: string; lastRun?: string | null; limitS: number; detail?: string }) {
  const age = ageSeconds(lastRun);
  const t = freshness(age, limitS);
  return (
    <div className={`rounded-xl border ${toneRing[t]} bg-ink-850 p-4`}>
      <div className="flex items-center justify-between">
        <span className="text-xs uppercase tracking-wider text-mist-400">{name}</span>
        <span className={`h-2.5 w-2.5 rounded-full ${toneDot[t]}`} aria-label={t} />
      </div>
      <div className={`mt-2 font-mono text-2xl ${toneText[t]}`}>{fmtAge(age)}</div>
      <div className="mt-1 text-xs text-mist-500">limit {fmtAge(limitS)}{detail ? ` · ${detail}` : ""}</div>
    </div>
  );
}

const sevStyle: Record<Severity, string> = {
  crit: "border-loss/50 bg-loss/10 text-loss",
  warn: "border-warn/40 bg-warn/10 text-warn",
  info: "border-ink-600 bg-ink-850 text-mist-300",
};

export function SeverityBadge({ s }: { s: Severity }) {
  return <span className={`rounded border px-1.5 py-0.5 font-mono text-[10px] uppercase ${sevStyle[s]}`}>{s}</span>;
}

export function FindingsList({ findings }: { findings: Finding[] }) {
  if (!findings.length) return <p className="text-sm text-aether">All clear. No findings.</p>;
  return (
    <ul className="space-y-2">
      {findings.map((f) => (
        <li key={f.key} className="flex items-start gap-2 text-sm">
          <SeverityBadge s={f.severity} />
          <span className="text-mist-100">{f.message}</span>
          <span className="ml-auto hidden shrink-0 font-mono text-[10px] text-mist-500 sm:inline">{f.check}</span>
        </li>
      ))}
    </ul>
  );
}

export function Table({ head, children, empty }: { head: string[]; children: ReactNode; empty?: boolean }) {
  return (
    <div className="-mx-4 overflow-x-auto px-4 sm:mx-0 sm:px-0">
      <table className="w-full min-w-[560px] text-left text-sm">
        <thead>
          <tr className="border-b border-ink-700 text-xs uppercase tracking-wider text-mist-400">
            {head.map((h) => (
              <th key={h} className="py-2 pr-3 font-medium">{h}</th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-ink-800">{children}</tbody>
      </table>
      {empty ? <p className="py-4 text-sm text-mist-500">Nothing here.</p> : null}
    </div>
  );
}

export function Stat({ label, value, tone = "text-mist-100" }: { label: string; value: string; tone?: string }) {
  return (
    <div className="rounded-lg border border-ink-700 bg-ink-850 p-3">
      <div className="text-xs uppercase tracking-wider text-mist-400">{label}</div>
      <div className={`mt-1 font-mono text-xl ${tone}`}>{value}</div>
    </div>
  );
}

export function HaltControl({ halted, note, updatedAt, action }: {
  halted: boolean; note?: string | null; updatedAt?: string | null; action: (fd: FormData) => Promise<void>;
}) {
  return (
    <div className={`rounded-xl border p-4 ${halted ? "border-loss/60 bg-loss/10" : "border-ink-700 bg-ink-900/70"}`}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className={`text-sm font-semibold ${halted ? "text-loss" : "text-aether"}`}>
            {halted ? "GLOBAL HALT ON: new entries blocked for every account" : "Trading enabled (not halted)"}
          </div>
          <div className="mt-0.5 text-xs text-mist-400">
            {note ? `Note: ${note} · ` : ""}changed {fmtAge(ageSeconds(updatedAt))} ago. Closes and kill switches still run while halted.
          </div>
        </div>
        <form action={action} className="flex flex-wrap items-center gap-2">
          <input type="hidden" name="halted" value={halted ? "false" : "true"} />
          <input
            name="note"
            placeholder={halted ? "Resume note" : "Reason (required)"}
            required={!halted}
            maxLength={200}
            className="w-56 rounded-md border border-ink-600 bg-ink-950 px-2 py-1.5 text-sm text-mist-100 placeholder:text-mist-500"
          />
          <button
            className={`rounded-md px-3 py-1.5 text-sm font-semibold ${halted ? "bg-aether text-ink-950 hover:bg-aether-soft" : "bg-loss text-ink-950 hover:opacity-90"}`}
          >
            {halted ? "Resume trading" : "Halt all trading"}
          </button>
        </form>
      </div>
    </div>
  );
}
