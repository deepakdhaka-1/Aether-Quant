"use client";

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";
import { supabaseBrowser } from "@/lib/supabase/client";
import { LogoMark } from "@/components/ui/Logo";
import { cx } from "@/components/ui";

const focus = "focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#1E6B62]";
const primary = `inline-flex w-full items-center justify-center gap-2 rounded-full bg-[#0C1A26] px-5 py-3 text-[15px] font-medium text-white transition-colors hover:bg-[#1E6B62] disabled:opacity-60 ${focus}`;
const input = "w-full rounded-xl border border-[#D5DDE0] bg-white px-3.5 py-2.5 text-[15px] text-[#0C1A26] placeholder:text-[#8A98A1] focus:border-[#1E6B62] focus:outline-none focus:ring-2 focus:ring-[#1E6B62]/20";
const label = "mb-1.5 block text-[13px] font-medium text-[#3E4C58]";

function Notice({ tone, children }: { tone?: "bad"; children: React.ReactNode }) {
  return <div role={tone === "bad" ? "alert" : "status"} className={cx("rounded-xl border px-3.5 py-2.5 text-[13.5px] leading-relaxed", tone === "bad" ? "border-[#F0C9C9] bg-[#FDF3F3] text-[#9B2C2C]" : "border-[#CFE3DE] bg-[#EEF6F4] text-[#1E4F46]")}>{children}</div>;
}

type Mode = "signin" | "signup";
type View = "email" | "forgot";
type SigninMethod = "password" | "magiclink";

export function LoginCard({ next, referral, initialError, initialMode = "signin", initialView = "email" }: {
  next: string;
  referral?: string;
  initialError?: string;
  initialMode?: Mode;
  initialView?: View;
}) {
  const router = useRouter();
  const view = initialView;
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(initialError ?? null);
  const [note, setNote] = useState<string | null>(null);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [ref, setRef] = useState(referral ?? "");
  const [signinMethod, setSigninMethod] = useState<SigninMethod>("password");
  const [signupPending, setSignupPending] = useState(false);
  const [confirmationCode, setConfirmationCode] = useState("");
  const [magicLinkPending, setMagicLinkPending] = useState(false);
  const [magicLinkCode, setMagicLinkCode] = useState("");

  const go = () => { router.replace(next); router.refresh(); };

  const submitEmail = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setNote(null);
    if (initialMode === "signup" && password !== confirmPassword) {
      setError("Passwords do not match.");
      return;
    }
    setBusy("email");
    const sb = supabaseBrowser();
    try {
      if (initialMode === "signin") {
        const { error: authError } = await sb.auth.signInWithPassword({ email, password });
        if (authError) throw authError;
        go();
        return;
      }
      const { data, error: authError } = await sb.auth.signUp({
        email,
        password,
        options: {
          emailRedirectTo: `${window.location.origin}/auth/callback?next=${encodeURIComponent(next)}`,
          data: { referral_code: ref.trim() || null },
        },
      });
      if (authError) throw authError;
      if (data.session) go();
      else {
        setSignupPending(true);
        setNote(`We sent a confirmation link and 6-digit code to ${email}. Confirm using either one.`);
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const verifySignupCode = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setBusy("verify-signup");
    try {
      const { error: authError } = await supabaseBrowser().auth.verifyOtp({ email, token: confirmationCode, type: "signup" });
      if (authError) throw authError;
      go();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const verifyMagicLinkCode = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setBusy("verify-magiclink");
    try {
      const { error: authError } = await supabaseBrowser().auth.verifyOtp({ email, token: magicLinkCode, type: "email" });
      if (authError) throw authError;
      go();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const resendConfirmation = async () => {
    setError(null);
    setNote(null);
    setBusy("resend");
    try {
      const { error: authError } = await supabaseBrowser().auth.resend({ type: "signup", email });
      if (authError) setError(authError.message);
      else setNote(`A new confirmation link was sent to ${email}.`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const sendResetLink = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setNote(null);
    setBusy("reset");
    try {
      const { error: authError } = await supabaseBrowser().auth.resetPasswordForEmail(email, {
        redirectTo: `${window.location.origin}/auth/callback?next=${encodeURIComponent("/reset-password")}`,
      });
      if (authError) setError(authError.message);
      else setNote(`If an account exists for ${email}, a password reset link is on its way.`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const sendMagicLink = async () => {
    setError(null);
    setNote(null);
    setBusy("magiclink");
    try {
      const { error: authError } = await supabaseBrowser().auth.signInWithOtp({
        email,
        options: {
          shouldCreateUser: false,
          emailRedirectTo: `${window.location.origin}/auth/callback?next=${encodeURIComponent(next)}`,
        },
      });
      if (authError) throw authError;
      setMagicLinkPending(true);
      setNote(`If an account exists for ${email}, a sign-in link and one-time code are on their way.`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="w-full max-w-[440px] rounded-[28px] border border-[#E3E8EA] bg-white p-6 shadow-[0_24px_60px_-30px_rgba(12,26,38,.25)] sm:p-9">
      <div className="mb-6 flex items-center gap-3">
        <LogoMark size={30} />
        <div>
          <h1 className="text-[1.35rem] font-semibold tracking-[-0.02em] text-[#0C1A26]">
            {view === "forgot" ? "Reset your password" : signupPending ? "Check your inbox" : initialMode === "signin" ? "Welcome back" : "Create your account"}
          </h1>
          <p className="mt-0.5 text-[13px] text-[#5A6874]">
            {view === "forgot" ? "We'll email you a secure reset link." : signupPending ? "Confirm your email to activate your account." : initialMode === "signin" ? "Sign in to continue to Aether Quant." : "Create an account to follow tested strategies."}
          </p>
        </div>
      </div>

      {error && <div className="mb-4"><Notice tone="bad">{error}</Notice></div>}
      {note && <div className="mb-4"><Notice>{note}</Notice>{initialMode === "signup" && view === "email" && <button type="button" onClick={resendConfirmation} disabled={!!busy} className="mt-2 text-[13px] font-medium underline disabled:opacity-60">Resend confirmation email</button>}{initialMode === "signin" && magicLinkPending && view === "email" && <button type="button" onClick={sendMagicLink} disabled={!!busy} className="mt-2 text-[13px] font-medium underline disabled:opacity-60">Resend sign-in email</button>}</div>}

      {view === "email" && initialMode === "signup" && signupPending ? (
        <form onSubmit={verifySignupCode} className="space-y-3">
          <label className="block"><span className={label}>6-digit email code</span><input className={`${input} text-center font-mono text-xl tracking-[.35em]`} type="text" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" minLength={6} maxLength={6} required value={confirmationCode} onChange={(e) => setConfirmationCode(e.target.value.replace(/\D/g, "").slice(0, 6))} /></label>
          <button type="submit" className={primary} disabled={!!busy || confirmationCode.length !== 6}>{busy === "verify-signup" && <Loader2 className="h-4 w-4 animate-spin" />}Verify email</button>
        </form>
      ) : view === "email" && initialMode === "signin" && magicLinkPending ? (
        <form onSubmit={verifyMagicLinkCode} className="space-y-3">
          <label className="block"><span className={label}>6-digit email sign-in code</span><input className={`${input} text-center font-mono text-xl tracking-[.35em]`} type="text" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" minLength={6} maxLength={6} required value={magicLinkCode} onChange={(e) => setMagicLinkCode(e.target.value.replace(/\D/g, "").slice(0, 6))} /></label>
          <button type="submit" className={primary} disabled={!!busy || magicLinkCode.length !== 6}>{busy === "verify-magiclink" && <Loader2 className="h-4 w-4 animate-spin" />}Verify code</button>
          <p className="text-center text-xs text-[#5A6874]">You can also sign in by clicking the link in the email.</p>
        </form>
      ) : view === "email" ? (
        <form onSubmit={signinMethod === "magiclink" && initialMode === "signin" ? (e) => { e.preventDefault(); void sendMagicLink(); } : submitEmail} className="space-y-3">
          {initialMode === "signin" && <div role="tablist" aria-label="Sign-in method" className="grid grid-cols-2 rounded-full border border-[#D5DDE0] bg-[#F5F7F7] p-1 text-[13px]">
            {(["password", "magiclink"] as const).map((method) => <button key={method} type="button" role="tab" aria-selected={signinMethod === method} onClick={() => { setSigninMethod(method); setMagicLinkPending(false); setMagicLinkCode(""); setError(null); setNote(null); }} className={cx("rounded-full py-1.5 font-medium transition", signinMethod === method ? "bg-white text-[#0C1A26] shadow-sm" : "text-[#5A6874] hover:text-[#0C1A26]")}>{method === "password" ? "Password" : "Email link / code"}</button>)}
          </div>}
          <label className="block"><span className={label}>Email</span><input className={input} type="email" required autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} /></label>
          {!(initialMode === "signin" && signinMethod === "magiclink") && <label className="block">
            <span className={label}>Password</span>
            <input className={input} type="password" required minLength={8} autoComplete={initialMode === "signin" ? "current-password" : "new-password"} value={password} onChange={(e) => setPassword(e.target.value)} />
          </label>}
          {initialMode === "signup" && <label className="block"><span className={label}>Confirm password</span><input className={input} type="password" required minLength={8} autoComplete="new-password" value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)} /></label>}
          {initialMode === "signup" && <label className="block"><span className={label}>Referral code <span className="font-normal text-[#7A8790]">(optional)</span></span><input className={input} value={ref} onChange={(e) => setRef(e.target.value)} maxLength={64} /></label>}
          {initialMode === "signin" && signinMethod === "password" && <div className="text-right"><a href="/forgot-password" className="text-[13px] font-medium text-[#1E6B62] underline">Forgot password?</a></div>}
          <button type="submit" className={primary} disabled={!!busy}>{busy && <Loader2 className="h-4 w-4 animate-spin" />}{initialMode === "signin" ? signinMethod === "password" ? "Sign in" : "Email me a sign-in link" : "Create account"}</button>
        </form>
      ) : view === "forgot" ? (
        <form onSubmit={sendResetLink} className="space-y-3">
          <label className="block"><span className={label}>Email</span><input className={input} type="email" required autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} /></label>
          <button type="submit" className={primary} disabled={!!busy}>{busy === "reset" && <Loader2 className="h-4 w-4 animate-spin" />} Send reset link</button>
        </form>
      ) : null}

      <p className="mt-7 text-center text-[12px] leading-relaxed text-[#5A6874]">By continuing you agree to the <a className="underline hover:text-[#0C1A26]" href="/legal-terms">Terms</a> and acknowledge the <a className="underline hover:text-[#0C1A26]" href="/legal-risk">Risk disclosure</a>.</p>
      <p className="mt-4 text-center text-[13px] text-[#5A6874]">
        {view === "forgot" ? <a className="font-medium text-[#1E6B62] underline" href="/login">Back to sign in</a> : signupPending ? "Check your email for the confirmation link or code." : initialMode === "signin" ? <>New to Aether Quant? <a className="font-medium text-[#1E6B62] underline" href="/signup">Create an account</a></> : <>Already have an account? <a className="font-medium text-[#1E6B62] underline" href="/login">Sign in</a></>}
      </p>
    </div>
  );
}
