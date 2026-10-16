import { NextResponse } from "next/server";

export const runtime = "nodejs";

const COINS: Record<string, string> = {
  NVDA: "xyz:NVDA",
  TSLA: "xyz:TSLA",
  AAPL: "xyz:AAPL",
  MSFT: "xyz:MSFT",
  AMZN: "xyz:AMZN",
  GOOGL: "xyz:GOOGL",
  META: "xyz:META",
  XYZ100: "xyz:XYZ100",
  GOLD: "xyz:GOLD",
  SILVER: "xyz:SILVER",
  CL: "xyz:CL",
  NATGAS: "xyz:NATGAS",
  COPPER: "xyz:COPPER",
};

async function info<T>(body: Record<string, unknown>): Promise<T> {
  const response = await fetch("https://api.hyperliquid.xyz/info", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`Hyperliquid returned ${response.status}`);
  return response.json() as Promise<T>;
}

export async function GET(request: Request) {
  const ticker = new URL(request.url).searchParams.get("ticker")?.toUpperCase() ?? "";
  const coin = COINS[ticker];
  if (!coin) return NextResponse.json({ error: "Unknown market" }, { status: 400 });

  const mids = await info<Record<string, string>>({ type: "allMids", dex: "xyz" }).catch(() => null);

  const mid = mids?.[coin] ? Number(mids[coin]) : NaN;
  if (!Number.isFinite(mid)) {
    return NextResponse.json({ error: "Market data is temporarily unavailable" }, { status: 502 });
  }

  return NextResponse.json(
    {
      coin,
      price: mid,
    },
    { headers: { "Cache-Control": "public, s-maxage=15, stale-while-revalidate=30" } },
  );
}
