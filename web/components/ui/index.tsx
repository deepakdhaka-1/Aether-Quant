import type { ReactNode } from "react";
import { AlertTriangle, Info, OctagonAlert } from "lucide-react";

export const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(" ");

export const btn = {
  primary:
    "inline-flex items-center justify-center gap-2 rounded-full bg-aether px-5 py-2.5 text-sm font-semibold text-ink-950 transition hover:bg-aether-soft focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-aether disabled:cursor-not-allowed disabled:opacity-50",
  ghost:
    "inline-flex items-center justify-center gap-2 rounded-full border border-ink-600 px-5 py-2.5 text-sm font-medium text-mist-100 transition hover:border-aether/60 hover:text-aether focus-visible:outline focus-visible:outline-2 focus-visible:outline-aether disabled:cursor-not-allowed disabled:opacity-50",
  small:
    "inline-flex items-center justify-center gap-1.5 rounded-full border border-ink-600 px-3 py-1.5 text-xs font-medium text-mist-100 transition hover:border-aether/60 hover:text-aether focus-visible:outline focus-visible:outline-2 focus-visible:outline-aether disabled:cursor-not-allowed disabled:opacity-50",
};

export const input =
  "w-full rounded-xl border border-ink-600 bg-ink-850 px-3.5 py-2.5 text-sm text-mist-100 placeholder:text-mist-500 focus:border-aether/70 focus:outline-none focus:ring-2 focus:ring-aether/20";

export function Card({ children, className }: { children: ReactNode; className?: string }) {
  return <section className={cx("rounded-2xl border border-ink-700 bg-ink-900/70", className)}>{children}</section>;
}

export function CardHeader({ title, action, sub }: { title: string; action?: ReactNode; sub?: string }) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-2 border-b border-ink-700/70 px-5 py-4">
      <div>
        <h2 className="text-sm font-semibold tracking-wide text-mist-100">{title}</h2>
        {sub && <p className="mt-0.5 text-xs text-mist-400">{sub}</p>}
      </div>
      {action}
    </div>
  );
}

export function Badge({ children, tone = "default" }: { children: ReactNode; tone?: "default" | "good" | "bad" | "warn" | "accent" }) {
  const t = {
    default: "border-ink-600 text-mist-300",
    good: "border-aether/40 text-aether bg-aether/5",
    bad: "border-loss/40 text-loss bg-loss/5",
    warn: "border-warn/40 text-warn bg-warn/5",
    accent: "border-aether/60 text-ink-950 bg-aether",
  }[tone];
  return (
    <span className={cx("inline-flex items-center gap-1 whitespace-nowrap rounded-full border px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider", t)}>
      {children}
    </span>
  );
}

export function Stat({ label, value, className }: { label: string; value: ReactNode; className?: string }) {
  return (
    <div className={cx("min-w-0", className)}>
      <div className="font-mono text-[10px] uppercase tracking-[0.18em] text-mist-500">{label}</div>
      <div className="mt-1 truncate font-mono text-lg text-mist-100">{value}</div>
    </div>
  );
}

export function Banner({ tone = "info", children, action }: { tone?: "info" | "warn" | "bad"; children: ReactNode; action?: ReactNode }) {
  const Icon = tone === "bad" ? OctagonAlert : tone === "warn" ? AlertTriangle : Info;
  const t = {
    info: "border-aether/30 bg-aether/[0.06]",
    warn: "border-warn/40 bg-warn/[0.07]",
    bad: "border-loss/40 bg-loss/[0.08]",
  }[tone];
  const ic = { info: "text-aether", warn: "text-warn", bad: "text-loss" }[tone];
  return (
    <div role={tone === "bad" ? "alert" : "status"} className={cx("flex flex-col gap-3 rounded-xl border px-4 py-3 text-sm text-mist-100 sm:flex-row sm:items-center", t)}>
      <Icon className={cx("h-4 w-4 shrink-0", ic)} aria-hidden />
      <div className="flex-1">{children}</div>
      {action}
    </div>
  );
}

export function Empty({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 px-6 py-10 text-center">
      <div className="h-8 w-8 rounded-full border border-dashed border-ink-600" aria-hidden />
      <p className="text-sm font-medium text-mist-100">{title}</p>
      {children && <p className="max-w-sm text-xs leading-relaxed text-mist-400">{children}</p>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}

export function ErrorNote({ message }: { message: string }) {
  return <Banner tone="bad">Couldn&apos;t load this data: {message}</Banner>;
}

export function Lettermark({ name, size = 28 }: { name: string; size?: number }) {
  return (
    <span
      aria-hidden
      style={{ width: size, height: size }}
      className="inline-flex shrink-0 items-center justify-center rounded-lg bg-ink-700 font-mono text-xs font-semibold text-aether"
    >
      {name.slice(0, 1).toUpperCase()}
    </span>
  );
}

export function PageTitle({ title, sub, action }: { title: string; sub?: string; action?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-mist-100 sm:text-3xl">{title}</h1>
        {sub && <p className="mt-1 max-w-2xl text-sm text-mist-400">{sub}</p>}
      </div>
      {action}
    </div>
  );
}

export function SignalPill({ desired }: { desired?: string | null }) {
  if (!desired) return <Badge>No signal</Badge>;
  return <Badge tone={desired === "long" ? "good" : desired === "short" ? "bad" : "default"}>{desired}</Badge>;
}

export const fmtDate = (v?: string | number | null, withTime = true) => {
  if (v === null || v === undefined || v === "") return "—";
  const d = typeof v === "number" ? new Date(v < 1e12 ? v * 1000 : v) : new Date(v);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleString("en-US", {
    month: "short",
    day: "numeric",
    year: withTime ? undefined : "numeric",
    hour: withTime ? "2-digit" : undefined,
    minute: withTime ? "2-digit" : undefined,
    timeZone: "UTC",
  }) + (withTime ? " UTC" : "");
};

export const num = (v: unknown, digits = 2) => {
  const n = typeof v === "number" ? v : v === null || v === undefined || v === "" ? NaN : Number(v);
  return Number.isFinite(n) ? n.toLocaleString("en-US", { maximumFractionDigits: digits }) : "—";
};
