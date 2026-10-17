"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";
import { supabaseBrowser } from "@/lib/supabase/client";
import { LogoMark } from "@/components/ui/Logo";

const input = "w-full rounded-xl border border-[#D5DDE0] bg-white px-3.5 py-2.5 text-center font-mono text-xl tracking-[.35em] text-[#0C1A26] placeholder:text-[#8A98A1] focus:border-[#1E6B62] focus:outline-none focus:ring-2 focus:ring-[#1E6B62]/20";
const primary = "inline-flex w-full items-center justify-center gap-2 rounded-full bg-[#0C1A26] px-5 py-3 text-[15px] font-medium text-white transition-colors hover:bg-[#1E6B62] disabled:opacity-60";

export function VerifyEmailCard({ email, next }: { email: string; next: string }) {
  const router = useRouter();
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const verify = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const { error: authError } = await supabaseBrowser().auth.verifyOtp({ email, token: code, type: "email" });
      if (authError) throw authError;
      router.replace(next);
      router.refresh();
    } catch (caught) {
      setError((caught as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const resend = async () => {
    setBusy(true);
    setError(null);
    setNote(null);
    try {
      const { error: authError } = await supabaseBrowser().auth.resend({ type: "signup", email });
      if (authError) throw authError;
      setNote(`A new confirmation email was sent to ${email}.`);
    } catch (caught) {
      setError((caught as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="w-full max-w-[440px] rounded-[28px] border border-[#E3E8EA] bg-white p-6 shadow-[0_24px_60px_-30px_rgba(12,26,38,.25)] sm:p-9">
      <div className="mb-6 flex items-center gap-3">
        <LogoMark size={30} />
        <div>
          <h1 className="text-[1.35rem] font-semibold tracking-[-0.02em] text-[#0C1A26]">Confirm your email</h1>
          <p className="mt-0.5 text-[13px] text-[#5A6874]">Confirm your address to access your Aether Quant account.</p>
        </div>
      </div>
      <p className="mb-4 break-all text-sm text-[#3E4C58]">We sent a confirmation link and code to <strong>{email}</strong>.</p>
      {error && <p role="alert" className="mb-4 rounded-xl border border-[#F0C9C9] bg-[#FDF3F3] px-3.5 py-2.5 text-[13.5px] text-[#9B2C2C]">{error}</p>}
      {note && <p role="status" className="mb-4 rounded-xl border border-[#CFE3DE] bg-[#EEF6F4] px-3.5 py-2.5 text-[13.5px] text-[#1E4F46]">{note}</p>}
      <form onSubmit={verify} className="space-y-3">
        <label className="block"><span className="mb-1.5 block text-[13px] font-medium text-[#3E4C58]">6-digit email code</span><input className={input} type="text" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" minLength={6} maxLength={6} required value={code} onChange={(event) => setCode(event.target.value.replace(/\D/g, "").slice(0, 6))} /></label>
        <button type="submit" className={primary} disabled={busy || code.length !== 6}>{busy && <Loader2 className="h-4 w-4 animate-spin" />}Verify email</button>
      </form>
      <button type="button" onClick={resend} disabled={busy} className="mt-4 w-full text-center text-[13px] font-medium text-[#1E6B62] underline disabled:opacity-60">Resend confirmation email</button>
      <p className="mt-6 text-center text-[13px] text-[#5A6874]"><a className="font-medium text-[#1E6B62] underline" href="/login">Back to sign in</a></p>
    </section>
  );
}
