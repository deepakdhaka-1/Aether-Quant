import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const STATUSES = ["draft", "backtested", "published", "paused", "retired"] as const;
const RISK = ["low", "medium", "high"] as const;
// Allowed lifecycle moves. Retired is terminal: followers' positions get closed by the executor.
const NEXT: Record<string, string[]> = {
  draft: ["backtested", "retired"],
  backtested: ["published", "retired"],
  published: ["paused", "retired"],
  paused: ["published", "retired"],
  retired: [],
};

export async function GET() {
  const { isAdmin, sb } = await requireAdmin();
  if (!isAdmin) return NextResponse.json({ error: "not found" }, { status: 404 });
  const { data, error } = await sb
    .from("strategies")
    .select("id,slug,name,description,symbol,timeframe,direction,risk_level,status,source,model_name,headline_metrics,generation_meta,default_leverage,stop_loss_pct,take_profit_pct,entry_long,exit_long,entry_short,exit_short,created_at,published_at")
    .order("created_at", { ascending: false });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ strategies: data });
}

export async function PATCH(req: Request) {
  const { isAdmin, sb } = await requireAdmin();
  if (!isAdmin) return NextResponse.json({ error: "not found" }, { status: 404 });
  const body = (await req.json().catch(() => ({}))) as { id?: string; status?: string; description?: string; risk_level?: string };
  if (!body.id) return NextResponse.json({ error: "id required" }, { status: 400 });
  const { data: cur } = await sb.from("strategies").select("status").eq("id", body.id).maybeSingle();
  if (!cur) return NextResponse.json({ error: "strategy not found" }, { status: 404 });

  const update: Record<string, unknown> = {};
  if (body.status !== undefined && body.status !== cur.status) {
    if (!(STATUSES as readonly string[]).includes(body.status)) return NextResponse.json({ error: "bad status" }, { status: 400 });
    if (!NEXT[cur.status]?.includes(body.status))
      return NextResponse.json({ error: `cannot move ${cur.status} -> ${body.status}` }, { status: 409 });
    update.status = body.status;
    if (body.status === "published" && cur.status !== "paused") update.published_at = new Date().toISOString();
  }
  if (body.description !== undefined) {
    if (typeof body.description !== "string" || body.description.length > 2000)
      return NextResponse.json({ error: "description must be a string up to 2000 chars" }, { status: 400 });
    update.description = body.description;
  }
  if (body.risk_level !== undefined) {
    if (!(RISK as readonly string[]).includes(body.risk_level)) return NextResponse.json({ error: "bad risk_level" }, { status: 400 });
    update.risk_level = body.risk_level;
  }
  if (!Object.keys(update).length) return NextResponse.json({ error: "nothing to update" }, { status: 400 });
  const { data, error } = await sb.from("strategies").update(update).eq("id", body.id).select("id,status,published_at,description,risk_level").single();
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  return NextResponse.json({ strategy: data });
}
