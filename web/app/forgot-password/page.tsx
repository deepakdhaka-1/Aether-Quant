import type { Metadata } from "next";
import { LoginCard } from "@/components/auth/LoginCard";
import { Shell } from "@/components/landing/SiteChrome";

export const metadata: Metadata = { title: "Forgot password" };

export default async function ForgotPasswordPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const { error } = await searchParams;
  return (
    <Shell>
      <main className="flex min-h-[calc(100svh-4rem)] items-center justify-center px-4 py-16 sm:py-20">
        <LoginCard next="/dashboard" initialError={error} initialView="forgot" />
      </main>
    </Shell>
  );
}
