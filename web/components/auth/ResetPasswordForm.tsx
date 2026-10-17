"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";
import { supabaseBrowser } from "@/lib/supabase/client";
import { LogoMark } from "@/components/ui/Logo";
import { cx } from "@/components/ui";

const input = "w-full rounded-xl border border-[#D5DDE0] bg-white px-3.5 py-2.5 text-[15px] text-[#0C1A26] focus:border-[#1E6B62] focus:outline-none focus:ring-2 focus:ring-[#1E6B62]/20";

export function ResetPasswordForm({ initialError }: { initialError?: string }) {
  const router = useRouter();
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(initialError ?? "");

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const { error: updateError } = await supabaseBrowser().auth.updateUser({ password });
      if (updateError) {
        setError(updateError.message);
        setBusy(false);
        return;
      }
      router.replace("/dashboard");
      router.refresh();
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="w-full max-w-[440px] space-y-5 rounded-[28px] border border-[#E3E8EA] bg-white p-6 shadow-[0_24px_60px_-30px_rgba(12,26,38,.25)] sm:p-9">
      <div className="flex items-center gap-3">
        <LogoMark size={30} />
        <div>
          <h1 className="text-[1.35rem] font-semibold tracking-[-0.02em] text-[#0C1A26]">Choose a new password</h1>
          <p className="mt-0.5 text-[13px] text-[#5A6874]">Use at least 8 characters.</p>
        </div>
      </div>
      {error && <p role="alert" className="rounded-xl border border-[#F0C9C9] bg-[#FDF3F3] px-3.5 py-2.5 text-[13.5px] text-[#9B2C2C]">{error}</p>}
      <label className="block">
        <span className="mb-1.5 block text-[13px] font-medium text-[#3E4C58]">New password</span>
        <input className={input} type="password" autoComplete="new-password" minLength={8} required value={password} onChange={(e) => setPassword(e.target.value)} />
      </label>
      <button type="submit" disabled={busy} className={cx("inline-flex w-full items-center justify-center gap-2 rounded-full bg-[#0C1A26] py-3 text-[15px] font-medium text-white hover:bg-[#1E6B62] disabled:opacity-60")}>
        {busy && <Loader2 className="h-4 w-4 animate-spin" />} Update password
      </button>
    </form>
  );
}
