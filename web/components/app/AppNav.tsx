"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { ChevronDown, LayoutDashboard, LineChart, LogOut, Plug, Settings, Shield } from "lucide-react";
import { supabaseBrowser } from "@/lib/supabase/client";
import { Logo } from "@/components/ui/Logo";
import { cx } from "@/components/ui";

const NAV = [
  { href: "/dashboard", label: "Dashboard", icon: LayoutDashboard },
  { href: "/strategies", label: "Strategies", icon: LineChart },
  { href: "/connect", label: "Connect", icon: Plug },
  { href: "/settings", label: "Settings", icon: Settings },
];

export function useSignOut() {
  const router = useRouter();
  return async () => {
    await supabaseBrowser().auth.signOut();
    router.replace("/");
    router.refresh();
  };
}

function isActive(path: string, href: string) {
  return path === href || path.startsWith(`${href}/`);
}

export function Sidebar({ isAdmin }: { isAdmin: boolean }) {
  const path = usePathname();
  const items = isAdmin ? [...NAV, { href: "/admin", label: "Admin", icon: Shield }] : NAV;
  return (
    <aside className="sticky top-0 hidden h-screen w-60 shrink-0 flex-col border-r border-ink-800 bg-ink-950 px-4 py-6 lg:flex">
      <div className="px-2"><Logo href="/dashboard" /></div>
      <nav className="mt-10 flex flex-col gap-1" aria-label="Main">
        {items.map(({ href, label, icon: Icon }) => {
          const on = isActive(path, href);
          return (
            <Link
              key={href}
              href={href}
              aria-current={on ? "page" : undefined}
              className={cx(
                "flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm transition",
                on ? "bg-ink-800 text-mist-100 shadow-[inset_2px_0_0_#1E6B62]" : "text-mist-400 hover:bg-ink-900 hover:text-mist-100",
              )}
            >
              <Icon className={cx("h-4 w-4", on && "text-aether")} aria-hidden />
              {label}
            </Link>
          );
        })}
      </nav>
      <div className="mt-auto rounded-xl border border-ink-800 p-3 text-[11px] leading-relaxed text-mist-500">
        Trading perps is risky. Our agent key can trade but never withdraw.
      </div>
    </aside>
  );
}

export function MobileNav({ isAdmin }: { isAdmin: boolean }) {
  const path = usePathname();
  const items = isAdmin ? [...NAV, { href: "/admin", label: "Admin", icon: Shield }] : NAV;
  return (
    <nav
      aria-label="Main"
      className="fixed inset-x-0 bottom-0 z-40 flex border-t border-ink-800 bg-ink-950/95 pb-[env(safe-area-inset-bottom)] backdrop-blur lg:hidden"
    >
      {items.map(({ href, label, icon: Icon }) => {
        const on = isActive(path, href);
        return (
          <Link
            key={href}
            href={href}
            aria-current={on ? "page" : undefined}
            className={cx("flex flex-1 flex-col items-center gap-1 py-2.5 text-[10px]", on ? "text-aether" : "text-mist-400")}
          >
            <Icon className="h-5 w-5" aria-hidden />
            {label}
          </Link>
        );
      })}
    </nav>
  );
}

export function UserMenu({ label, sub }: { label: string; sub?: string }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const signOut = useSignOut();
  useEffect(() => {
    const close = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) setOpen(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", esc);
    return () => { document.removeEventListener("mousedown", close); document.removeEventListener("keydown", esc); };
  }, []);
  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-2 rounded-full border border-ink-700 py-1 pl-1 pr-3 text-sm hover:border-ink-600"
      >
        <span className="flex h-7 w-7 items-center justify-center rounded-full bg-aether/15 font-mono text-xs text-aether">
          {label.replace(/^0x/, "").slice(0, 1).toUpperCase()}
        </span>
        <span className="max-w-[140px] truncate font-mono text-xs text-mist-300">{label}</span>
        <ChevronDown className="h-3.5 w-3.5 text-mist-500" aria-hidden />
      </button>
      {open && (
        <div role="menu" className="absolute right-0 z-50 mt-2 w-56 overflow-hidden rounded-xl border border-ink-700 bg-ink-900 shadow-2xl">
          {sub && <div className="truncate border-b border-ink-800 px-4 py-3 text-xs text-mist-400">{sub}</div>}
          <Link role="menuitem" href="/settings" onClick={() => setOpen(false)} className="flex items-center gap-2 px-4 py-2.5 text-sm text-mist-300 hover:bg-ink-800 hover:text-mist-100">
            <Settings className="h-4 w-4" aria-hidden /> Settings
          </Link>
          <button role="menuitem" type="button" onClick={signOut} className="flex w-full items-center gap-2 px-4 py-2.5 text-left text-sm text-mist-300 hover:bg-ink-800 hover:text-loss">
            <LogOut className="h-4 w-4" aria-hidden /> Sign out
          </button>
        </div>
      )}
    </div>
  );
}

export function SignOutButton({ className }: { className?: string }) {
  const signOut = useSignOut();
  return (
    <button type="button" onClick={signOut} className={className}>
      <LogOut className="h-4 w-4" aria-hidden /> Sign out
    </button>
  );
}
