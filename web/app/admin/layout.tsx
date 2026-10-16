import Link from "next/link";
import { notFound } from "next/navigation";
import { requireAdmin } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";
export const metadata = { title: "Admin", robots: { index: false } };

const NAV = [
  { href: "/admin/lab", label: "Strategy Lab" },
  { href: "/admin/strategies", label: "Strategies" },
  { href: "/admin/ops", label: "Ops" },
];

// Non-admins get a plain 404: the admin area doesn't advertise that it exists.
export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const { isAdmin } = await requireAdmin();
  if (!isAdmin) notFound();
  return (
    <div className="min-h-screen bg-ink-950">
      <header className="border-b border-ink-700 bg-ink-900/80">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-x-6 gap-y-2 px-4 py-3">
          <Link href="/" className="font-semibold text-aether">Aether Quant</Link>
          <span className="rounded bg-ink-800 px-2 py-0.5 font-mono text-xs uppercase tracking-wider text-warn">admin</span>
          <nav className="flex gap-4 text-sm">
            {NAV.map((n) => (
              <Link key={n.href} href={n.href} className="text-mist-300 hover:text-mist-100">{n.label}</Link>
            ))}
          </nav>
        </div>
      </header>
      <main className="mx-auto max-w-7xl px-4 py-8">{children}</main>
    </div>
  );
}
