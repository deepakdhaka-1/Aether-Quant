import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/supabase/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 600; // offline model generation can be slow

const ALLOWED = new Set(["indicators", "backtest", "generate"]);
const notFound = () => NextResponse.json({ error: "not found" }, { status: 404 });

// Admin-only pass-through to the engine API. The engine token never reaches the browser.
export async function POST(req: Request, ctx: { params: Promise<{ path: string[] }> }) {
  const { isAdmin } = await requireAdmin();
  if (!isAdmin) return notFound();
  const { path } = await ctx.params;
  if (path.length !== 1 || !ALLOWED.has(path[0])) return notFound();
  const base = process.env.ENGINE_URL;
  const token = process.env.ENGINE_API_TOKEN;
  if (!base || !token) return NextResponse.json({ error: "engine not configured" }, { status: 500 });

  const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
  const ct = req.headers.get("content-type");
  if (ct) headers["Content-Type"] = ct; // keeps the multipart boundary for CSV uploads
  let upstream: Response;
  try {
    upstream = await fetch(`${base.replace(/\/$/, "")}/${path[0]}`, {
      method: "POST",
      headers,
      body: await req.arrayBuffer(),
      cache: "no-store",
    });
  } catch {
    return NextResponse.json({ error: "engine unreachable" }, { status: 502 });
  }
  const out = new Headers();
  for (const h of ["content-type", "content-disposition"]) {
    const v = upstream.headers.get(h);
    if (v) out.set(h, v);
  }
  return new Response(upstream.body, { status: upstream.status, headers: out });
}
