"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { ArrowLeft, Loader2, Mail, Wallet } from "lucide-react";
import { supabaseBrowser } from "@/lib/supabase/client";
import { connect, personalSign, walletError, type DiscoveredWallet } from "@/lib/wallets";
import { WalletPicker } from "@/components/wallet/WalletPicker";
import { LogoMark } from "@/components/ui/Logo";
import { cx } from "@/components/ui";

// Light styles matching the public site (the in-app components keep the dark theme).
const focus = "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#1E6B62]";
const L = {
  primary: `inline-flex items-center justify-center gap-2 rounded-full bg-[#0C1A26] px-5 text-[15px] font-medium text-white transition-colors hover:bg-[#1E6B62] disabled:opacity-60 ${focus}`,
  ghost: `inline-flex items-center justify-center gap-2 rounded-full border border-[#C9D2D7] bg-white px-5 text-[15px] font-medium text-[#0C1A26] transition-colors hover:border-[#0C1A26] disabled:opacity-60 ${focus}`,
  back: `inline-flex h-8 w-8 items-center justify-center rounded-full border border-[#C9D2D7] bg-white text-[#0C1A26] hover:border-[#0C1A26] ${focus}`,
  input: `w-full rounded-xl border border-[#D5DDE0] bg-white px-3.5 py-2.5 text-[15px] text-[#0C1A26] placeholder:text-[#8A98A1] focus:border-[#1E6B62] focus:outline-none focus:ring-2 focus:ring-[#1E6B62]/20`,
  label: "mb-1.5 block text-[13px] font-medium text-[#3E4C58]",
};

function Notice({ tone, children }: { tone?: "bad"; children: React.ReactNode }) {
  return (
    <div role={tone === "bad" ? "alert" : "status"} className={cx("rounded-xl border px-3.5 py-2.5 text-[13.5px] leading-relaxed",
      tone === "bad" ? "border-[#F0C9C9] bg-[#FDF3F3] text-[#9B2C2C]" : "border-[#CFE3DE] bg-[#EEF6F4] text-[#1E4F46]")}>
      {children}
    </div>
  );
}

type View = "home" | "wallet" | "email";

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const j = (await r.json().catch(() => ({}))) as T & { error?: string };
  if (!r.ok) throw new Error(j.error ?? `Request failed (${r.status})`);
  return j;
}

function GoogleG() {
  return (
    <svg viewBox="0 0 24 24" className="h-4 w-4" aria-hidden>
      <path fill="#EA4335" d="M12 10.2v3.9h5.5c-.2 1.3-1.6 3.8-5.5 3.8-3.3 0-6-2.7-6-6.1s2.7-6.1 6-6.1c1.9 0 3.1.8 3.8 1.5l2.6-2.5C16.8 3.2 14.6 2.2 12 2.2 6.6 2.2 2.3 6.6 2.3 12s4.3 9.8 9.7 9.8c5.6 0 9.3-3.9 9.3-9.5 0-.6-.1-1.1-.2-1.6H12z" />
    </svg>
  );
}

export function LoginCard({ next, referral, initialError }: { next: string; referral?: string; initialError?: string }) {
  const router = useRouter();
  const [view, setView] = useState<View>("home");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(initialError ?? null);
  const [note, setNote] = useState<string | null>(null);
  const [mode, setMode] = useState<"signin" | "signup">("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [ref, setRef] = useState(referral ?? "");

  const go = () => {
    router.replace(next);
    router.refresh();
  };

  const withWallet = async (w: DiscoveredWallet) => {
    setError(null);
    setBusy(w.info.rdns);
    try {
      const { address } = await connect(w.provider);
      const { nonce, message } = await postJson<{ nonce: string; message: string }>("/api/auth/nonce", { address });
      const signature = await personalSign(w.provider, address, message);
      const { token_hash } = await postJson<{ token_hash: string }>("/api/auth/verify", {
        address,
        nonce,
        signature,
        referral: ref.trim() || undefined,
      });
      const { error: otpErr } = await supabaseBrowser().auth.verifyOtp({ type: "magiclink", token_hash });
      if (otpErr) throw otpErr;
      go();
    } catch (e) {
      setError(walletError(e));
      setBusy(null);
    }
  };

  const withGoogle = async () => {
    setError(null);
    setBusy("google");
    const redirectTo = `${window.location.origin}/auth/callback?next=${encodeURIComponent(next)}`;
    const { error: e } = await supabaseBrowser().auth.signInWithOAuth({ provider: "google", options: { redirectTo } });
    if (e) {
      setError(e.message);
      setBusy(null);
    }
  };

  const withEmail = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setNote(null);
    setBusy("email");
    const sb = supabaseBrowser();
    try {
      if (mode === "signin") {
        const { error: err } = await sb.auth.signInWithPassword({ email, password });
        if (err) throw err;
        go();
        return;
      }
      const { data, error: err } = await sb.auth.signUp({
        email,
        password,
        options: {
          emailRedirectTo: `${window.location.origin}/auth/callback?next=${encodeURIComponent(next)}`,
          data: { referral_code: ref.trim() || null },
        },
      });
      if (err) throw err;
      if (data.session) go();
      else {
        setNote("Check your inbox to confirm your email, then come back to sign in.");
        setBusy(null);
      }
    } catch (x) {
      setError((x as Error).message);
      setBusy(null);
    }
  };

  return (
    <div className="w-full max-w-[440px] rounded-[28px] border border-[#E3E8EA] bg-white p-6 shadow-[0_24px_60px_-30px_rgba(12,26,38,.25)] sm:p-9">
      <div className="mb-6 flex items-center gap-3">
        {view !== "home" ? (
          <button type="button" onClick={() => { setView("home"); setError(null); }} className={L.back} aria-label="Back">
            <ArrowLeft className="h-3.5 w-3.5" />
          </button>
        ) : (
          <LogoMark size={30} />
        )}
        <div>
          <h1 className="text-[1.35rem] font-semibold tracking-[-0.02em] text-[#0C1A26]">
            {view === "wallet" ? "Choose a wallet" : view === "email" ? (mode === "signin" ? "Sign in with email" : "Create your account") : "Sign in to Aether Quant"}
          </h1>
          <p className="mt-0.5 text-[13px] text-[#5A6874]">
            {view === "wallet" ? "You'll sign a message. No transaction, no gas." : "Follow tested strategies. Keep custody."}
          </p>
        </div>
      </div>

      {error && <div className="mb-4"><Notice tone="bad">{error}</Notice></div>}
      {note && <div className="mb-4"><Notice>{note}</Notice></div>}

      {view === "home" && (
        <div className="space-y-3">
          <button type="button" className={cx(L.primary, "w-full py-3")} onClick={() => setView("wallet")}>
            <Wallet className="h-4 w-4" aria-hidden /> Continue with wallet
          </button>
          <button type="button" className={cx(L.ghost, "w-full py-3")} onClick={withGoogle} disabled={!!busy}>
            {busy === "google" ? <Loader2 className="h-4 w-4 animate-spin" /> : <GoogleG />} Continue with Google
          </button>
          <button type="button" className={cx(L.ghost, "w-full py-3")} onClick={() => setView("email")}>
            <Mail className="h-4 w-4" aria-hidden /> Continue with email
          </button>
        </div>
      )}

      {view === "wallet" && <WalletPicker onPick={withWallet} busy={busy} light />}

      {view === "email" && (
        <form onSubmit={withEmail} className="space-y-3">
          <div role="tablist" className="grid grid-cols-2 rounded-full border border-[#D5DDE0] bg-[#F5F7F7] p-1 text-[13px]">
            {(["signin", "signup"] as const).map((m) => (
              <button
                key={m}
                type="button"
                role="tab"
                aria-selected={mode === m}
                onClick={() => setMode(m)}
                className={cx("rounded-full py-1.5 font-medium transition", mode === m ? "bg-white text-[#0C1A26] shadow-sm" : "text-[#5A6874] hover:text-[#0C1A26]")}
              >
                {m === "signin" ? "Sign in" : "Sign up"}
              </button>
            ))}
          </div>
          <label className="block">
            <span className={L.label}>Email</span>
            <input className={L.input} type="email" required autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} />
          </label>
          <label className="block">
            <span className={L.label}>Password</span>
            <input
              className={L.input}
              type="password"
              required
              minLength={8}
              autoComplete={mode === "signin" ? "current-password" : "new-password"}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </label>
          <button type="submit" className={cx(L.primary, "w-full py-3")} disabled={!!busy}>
            {busy === "email" && <Loader2 className="h-4 w-4 animate-spin" />}
            {mode === "signin" ? "Sign in" : "Create account"}
          </button>
        </form>
      )}

      {(view === "email" ? mode === "signup" : view !== "home" || !!ref) && (
        <label className="mt-4 block">
          <span className={L.label}>Referral code (optional)</span>
          <input className={L.input} value={ref} onChange={(e) => setRef(e.target.value)} maxLength={64} />
        </label>
      )}

      <p className="mt-7 text-center text-[12px] leading-relaxed text-[#5A6874]">
        By continuing you agree to the <a className="underline hover:text-[#0C1A26]" href="/legal-terms">Terms</a> and acknowledge the{" "}
        <a className="underline hover:text-[#0C1A26]" href="/legal-risk">Risk disclosure</a>.
      </p>
    </div>
  );
}
