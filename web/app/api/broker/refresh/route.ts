import { friendlyError, json, ownedAccount, verifyOnChain } from "../_lib";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as { broker_account_id?: string };
  const r = await ownedAccount(body.broker_account_id);
  if ("error" in r) return r.error;
  try {
    return json(await verifyOnChain(r.row));
  } catch (e) {
    return json({ error: friendlyError(String((e as Error).message), r.row.network) }, 502);
  }
}
