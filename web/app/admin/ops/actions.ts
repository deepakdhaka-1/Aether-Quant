"use server";

import { revalidatePath } from "next/cache";
import { notFound } from "next/navigation";
import { requireAdmin } from "@/lib/supabase/server";

/** Toggle the global halt. Runs through the admin's own session: RLS policy state_admin allows it. */
export async function setHalt(fd: FormData) {
  const { sb, isAdmin } = await requireAdmin();
  if (!isAdmin) notFound();
  const halted = fd.get("halted") === "true";
  const note = String(fd.get("note") ?? "").trim().slice(0, 200) || null;
  const { error } = await sb
    .from("system_state")
    .update({ halted, note, updated_at: new Date().toISOString() })
    .eq("id", "global");
  if (error) throw new Error(`halt update failed: ${error.message}`);
  revalidatePath("/admin/ops");
}
