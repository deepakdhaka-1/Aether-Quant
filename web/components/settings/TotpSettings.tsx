"use client";

import { useEffect, useState, type FormEvent } from "react";
import { Loader2, ShieldCheck } from "lucide-react";
import { supabaseBrowser } from "@/lib/supabase/client";
import { Banner, btn, input } from "@/components/ui";

type Factor = { id: string; friendly_name?: string; status: string };

export function TotpSettings() {
  const [factors, setFactors] = useState<Factor[]>([]);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [qr, setQr] = useState("");
  const [secret, setSecret] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const { data, error } = await supabaseBrowser().auth.mfa.listFactors();
        if (!active) return;
        if (error) setMessage({ ok: false, text: error.message });
        else {
          setFactors(data.totp);
          setPendingId(data.all.find((item) => item.factor_type === "totp" && item.status === "unverified")?.id ?? null);
        }
      } catch (e) {
        if (active) setMessage({ ok: false, text: (e as Error).message });
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => { active = false; };
  }, []);

  async function startSetup() {
    setBusy(true);
    setMessage(null);
    try {
      const sb = supabaseBrowser();
      if (pendingId) {
        const { error } = await sb.auth.mfa.unenroll({ factorId: pendingId });
        if (error) throw error;
        setPendingId(null);
      }
      const { data, error } = await sb.auth.mfa.enroll({ factorType: "totp", friendlyName: `Aether Quant ${factors.length + 1}` });
      if (error) throw error;
      setPendingId(data.id);
      setQr(data.totp.qr_code);
      setSecret(data.totp.secret);
      setMessage({ ok: true, text: "Scan this QR code with your authenticator app, then enter its current 6-digit code." });
    } catch (e) {
      setMessage({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }

  async function confirmSetup(e: FormEvent) {
    e.preventDefault();
    if (!pendingId) return;
    setBusy(true);
    setMessage(null);
    try {
      const { error } = await supabaseBrowser().auth.mfa.challengeAndVerify({ factorId: pendingId, code });
      if (error) throw error;
      setFactors((current) => [...current, { id: pendingId, friendly_name: `Aether Quant ${current.length + 1}`, status: "verified" }]);
      setPendingId(null);
      setQr("");
      setSecret("");
      setCode("");
      setMessage({ ok: true, text: "Authenticator verification is enabled for this account." });
    } catch (e) {
      setMessage({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }

  async function removeFactor(factor: Factor) {
    if (!window.confirm(`Remove ${factor.friendly_name || "this authenticator"}?`)) return;
    setBusy(true);
    setMessage(null);
    try {
      const { error } = await supabaseBrowser().auth.mfa.unenroll({ factorId: factor.id });
      if (error) throw error;
      setFactors((current) => current.filter((item) => item.id !== factor.id));
      await supabaseBrowser().auth.refreshSession();
      setMessage({ ok: true, text: "Authenticator removed." });
    } catch (e) {
      setMessage({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-4 p-5">
      <div className="flex items-start gap-3"><ShieldCheck className="mt-0.5 h-5 w-5 shrink-0 text-[#7cf5d4]" /><div><p className="text-sm font-medium text-mist-100">Authenticator app</p><p className="mt-1 text-xs leading-relaxed text-mist-400">Add one or more time-based codes. You&apos;ll enter a code after signing in with your password or email link.</p></div></div>
      {message && <Banner tone={message.ok ? "info" : "bad"}>{message.text}</Banner>}
      {loading ? <div className="flex items-center gap-2 text-sm text-mist-400"><Loader2 className="h-4 w-4 animate-spin" />Loading verification settings…</div> : <>
        {factors.map((factor) => <div key={factor.id} className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-ink-700 p-3.5"><div><p className="text-sm text-mist-100">{factor.friendly_name || "Authenticator app"}</p><p className="mt-1 text-xs text-mist-400">Enabled for sign-in verification.</p></div><button type="button" className={btn.ghost} onClick={() => removeFactor(factor)} disabled={busy}>{busy && <Loader2 className="h-4 w-4 animate-spin" />}Remove</button></div>)}
        {qr ? (
          <form onSubmit={confirmSetup} className="space-y-4 rounded-xl border border-ink-700 p-4">
            <img src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(qr)}`} alt="Authenticator setup QR code" className="mx-auto h-44 w-44 rounded-lg bg-white p-2" />
            <p className="text-center text-xs text-mist-400">Can&apos;t scan? Enter this setup key manually:</p>
            <code className="block break-all rounded-lg bg-ink-900 p-3 text-center text-xs text-mist-100">{secret}</code>
            <label className="block"><span className="mb-1 block text-xs text-mist-400">6-digit code from your app</span><input className={input} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))} inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} required /></label>
            <button className={btn.primary} disabled={busy || code.length !== 6}>{busy && <Loader2 className="h-4 w-4 animate-spin" />}Verify and enable</button>
          </form>
        ) : (
          <div className="space-y-3">{pendingId && <p className="text-xs text-mist-400">There is an unfinished setup. Starting again replaces its pending key.</p>}<button type="button" className={btn.primary} onClick={startSetup} disabled={busy}>{busy && <Loader2 className="h-4 w-4 animate-spin" />}{factors.length ? "Add another authenticator" : "Set up authenticator"}</button></div>
        )}
      </>}
    </div>
  );
}
