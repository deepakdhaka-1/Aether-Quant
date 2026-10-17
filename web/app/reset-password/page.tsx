import type { Metadata } from "next";
import { Shell } from "@/components/landing/SiteChrome";
import { ResetPasswordForm } from "@/components/auth/ResetPasswordForm";

export const metadata: Metadata = { title: "Reset password" };

export default async function ResetPasswordPage({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const { error } = await searchParams;
  return (
    <Shell>
      <div className="flex min-h-[calc(100svh-4rem)] items-center justify-center px-4 py-16 sm:py-20">
        <ResetPasswordForm initialError={error} />
      </div>
    </Shell>
  );
}
