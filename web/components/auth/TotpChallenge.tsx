"use client";

import { useEffect, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { Loader2, ShieldCheck } from "lucide-react";
import { supabaseBrowser } from "@/lib/supabase/client";
import { LogoMark } from "@/components/ui/Logo";
import { cx } from "@/components/ui";

const button = "inline-flex w-full items-center justify-center gap-2 rounded-full bg-[#0C1A26] px-5 py-3 text-[15px] font-medium text-white transition-colors hover:bg-[#1E6B62] disabled:opacity-60 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#1E6B62]";
const input = "w-full rounded-xl border border-[#D5DDE0] bg-white px-3.5 py-2.5 text-center font-mono text-lg tracking-[.3em] text-[#0C1A26] placeholder:text-[#8A98A1] focus:border-[#1E6B62] focus:outline-none focus:ring-2 focus:ring-[#1E6B62]/20";

export function TotpChallenge({ next }: { next: string }) {
  const router = useRouter();
  const [factors, setFactors] = useState<{ id: string; friendly_name?: string }[]>([]);
  const [factorId, setFactorId] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const { data, error: listError } = await supabaseBrowser().auth.mfa.listFactors();
        if (!active) return;
        if (listError) setError(listError.message);
        else {
          setFactors(data.totp);
          setFactorId(data.totp[0]?.id ?? "");
          if (!data.totp.length) setError("No verified authenticator was found for this account.");
        }
      } catch (e) {
        if (active) setError((e as Error).message);
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => { active = false; };
  }, []);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      if (!factorId) throw new Error("Choose an authenticator to continue.");
      const { error: verifyError } = await supabaseBrowser().auth.mfa.challengeAndVerify({ factorId, code: code.replace(/\s/g, "") });
      if (verifyError) throw verifyError;
      router.replace(next);
      router.refresh();
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  }

  return (
    <div className="w-full max-w-[440px] rounded-[28px] border border-[#E3E8EA] bg-white p-6 shadow-[0_24px_60px_-30px_rgba(12,26,38,.25)] sm:p-9">
      <div className="mb-6 flex items-center gap-3"><LogoMark size={30} /><div><h1 className="text-[1.35rem] font-semibold tracking-[-0.02em] text-[#0C1A26]">Verify it&apos;s you</h1><p className="mt-0.5 text-[13px] text-[#5A6874]">Enter the current code from your authenticator app.</p></div></div>
      <div className="mb-5 flex items-center gap-2 rounded-xl border border-[#CFE3DE] bg-[#EEF6F4] px-3.5 py-2.5 text-[13px] text-[#1E4F46]"><ShieldCheck className="h-4 w-4 shrink-0" />Your account has two-step verification enabled.</div>
      {error && <p role="alert" className="mb-4 rounded-xl border border-[#F0C9C9] bg-[#FDF3F3] px-3.5 py-2.5 text-[13px] text-[#9B2C2C]">{error}</p>}
      <form onSubmit={submit} className="space-y-4">
        {factors.length > 1 && <label className="block"><span className="mb-1.5 block text-[13px] font-medium text-[#3E4C58]">Authenticator</span><select className={input} value={factorId} onChange={(e) => setFactorId(e.target.value)}>{factors.map((factor) => <option key={factor.id} value={factor.id}>{factor.friendly_name || "Authenticator app"}</option>)}</select></label>}
        <label className="block"><span className="mb-1.5 block text-[13px] font-medium text-[#3E4C58]">6-digit authenticator code</span><input className={input} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))} inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" minLength={6} maxLength={6} required autoFocus /></label>
        <button type="submit" className={cx(button)} disabled={busy || loading || !factorId || code.length !== 6}>{(busy || loading) && <Loader2 className="h-4 w-4 animate-spin" />}Verify and continue</button>
      </form>
    </div>
  );
}
