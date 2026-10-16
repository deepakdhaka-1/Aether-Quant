import { isAddress, isHex, parseSignature, recoverTypedDataAddress } from "viem";
import { AGENT_NAME, typedData, type UserAction } from "@/lib/hyperliquid";
import { BUILDER_ADDRESS, BUILDER_MAX_FEE, friendlyError, json, ownedAccount, relay, verifyOnChain } from "../_lib";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NONCE_WINDOW_MS = 5 * 60_000;
const eq = (a: unknown, b: string) => typeof a === "string" && a.toLowerCase() === b.toLowerCase();

/** Rebuild the action from whitelisted fields only, so nothing extra is relayed. */
function validate(raw: Record<string, unknown>, row: { agent_address: string; network: string }): UserAction | string {
  const chain = row.network === "mainnet" ? "Mainnet" : "Testnet";
  if (raw.hyperliquidChain !== chain) return `hyperliquidChain must be ${chain}`;
  const sigChain = raw.signatureChainId;
  if (typeof sigChain !== "string" || !/^0x[0-9a-fA-F]{1,16}$/.test(sigChain)) return "bad signatureChainId";
  const nonce = raw.nonce;
  if (typeof nonce !== "number" || !Number.isSafeInteger(nonce) || Math.abs(Date.now() - nonce) > NONCE_WINDOW_MS)
    return "nonce must be a timestamp within 5 minutes";
  if (raw.type === "approveAgent") {
    if (typeof raw.agentAddress !== "string" || !isAddress(raw.agentAddress) || !eq(raw.agentAddress, row.agent_address))
      return "agentAddress does not match this account's agent";
    if (raw.agentName !== AGENT_NAME) return `agentName must be "${AGENT_NAME}"`;
    return { type: "approveAgent", signatureChainId: sigChain, hyperliquidChain: chain, agentAddress: raw.agentAddress, agentName: AGENT_NAME, nonce };
  }
  if (raw.type === "approveBuilderFee") {
    if (!BUILDER_ADDRESS || typeof raw.builder !== "string" || !eq(raw.builder, BUILDER_ADDRESS)) return "builder does not match";
    if (raw.maxFeeRate !== BUILDER_MAX_FEE) return `maxFeeRate must be ${BUILDER_MAX_FEE}`;
    return { type: "approveBuilderFee", signatureChainId: sigChain, hyperliquidChain: chain, maxFeeRate: BUILDER_MAX_FEE, builder: raw.builder, nonce };
  }
  return "action type must be approveAgent or approveBuilderFee";
}

// Step 2: the browser had the user's MAIN wallet sign approveAgent / approveBuilderFee. We check
// exactly what was signed, relay it to Hyperliquid, then confirm on the venue.
export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as { broker_account_id?: string; action?: Record<string, unknown>; signature?: string };
  const r = await ownedAccount(body.broker_account_id);
  if ("error" in r) return r.error;
  const { row } = r;
  if (row.status === "revoked") return json({ error: "This connection was revoked. Connect again to create a new one." }, 409);
  if (!body.action || typeof body.action !== "object") return json({ error: "action required" }, 400);
  if (typeof body.signature !== "string" || !isHex(body.signature)) return json({ error: "signature required" }, 400);

  const action = validate(body.action, row);
  if (typeof action === "string") return json({ error: action }, 400);

  const td = typedData(action);
  const { EIP712Domain: _omit, ...types } = td.types;
  let signer: string;
  let sig: { r: `0x${string}`; s: `0x${string}`; v: number };
  try {
    signer = await recoverTypedDataAddress({
      domain: { ...td.domain, verifyingContract: td.domain.verifyingContract as `0x${string}` },
      types,
      primaryType: td.primaryType,
      message: td.message,
      signature: body.signature as `0x${string}`,
    } as Parameters<typeof recoverTypedDataAddress>[0]);
    const p = parseSignature(body.signature as `0x${string}`);
    sig = { r: p.r, s: p.s, v: p.v !== undefined ? Number(p.v) : 27 + (p.yParity ?? 0) };
  } catch {
    return json({ error: "malformed signature" }, 400);
  }
  if (!eq(signer, row.wallet_address))
    return json({ error: "Signature is not from the connected wallet. Sign with the wallet you are connecting." }, 400);

  let relayError: string | null = null;
  try {
    const res = await relay(row.network, { action, nonce: action.nonce, signature: sig });
    if (!res.ok) relayError = friendlyError(res.error ?? "unknown error", row.network);
  } catch {
    relayError = "Could not reach Hyperliquid. Please try again.";
  }
  try {
    const state = await verifyOnChain(row, relayError);
    return json({ ...state, error: relayError ?? undefined }, relayError ? 400 : 200);
  } catch {
    return json({ error: relayError ?? "Submitted, but could not confirm on Hyperliquid yet. Press refresh." }, 502);
  }
}
