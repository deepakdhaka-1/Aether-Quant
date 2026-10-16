// Hyperliquid "user-signed actions" (EIP-712), signed by the user's MAIN wallet in the browser.
// approveAgent      -> lets our server-generated agent key trade (it can never withdraw)
// approveBuilderFee -> lets us attach our builder code (revenue) up to maxFeeRate per order
// Spec: https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/exchange-endpoint

export type Network = "mainnet" | "testnet";

export const HL_API: Record<Network, string> = {
  mainnet: "https://api.hyperliquid.xyz",
  testnet: "https://api.hyperliquid-testnet.xyz",
};
export const HL_APP: Record<Network, string> = {
  mainnet: "https://app.hyperliquid.xyz",
  testnet: "https://app.hyperliquid-testnet.xyz",
};
export const AGENT_NAME = "AetherQuant";

const domain = (chainId: number) => ({
  name: "HyperliquidSignTransaction",
  version: "1",
  chainId,
  verifyingContract: "0x0000000000000000000000000000000000000000",
});

const EIP712Domain = [
  { name: "name", type: "string" },
  { name: "version", type: "string" },
  { name: "chainId", type: "uint256" },
  { name: "verifyingContract", type: "address" },
];

export type UserAction =
  | {
      type: "approveAgent";
      signatureChainId: string;
      hyperliquidChain: "Mainnet" | "Testnet";
      agentAddress: string;
      agentName: string;
      nonce: number;
    }
  | {
      type: "approveBuilderFee";
      signatureChainId: string;
      hyperliquidChain: "Mainnet" | "Testnet";
      maxFeeRate: string;
      builder: string;
      nonce: number;
    };

const chainName = (n: Network) => (n === "mainnet" ? "Mainnet" : "Testnet") as "Mainnet" | "Testnet";

/** chainId = the chain the wallet is on right now (wallets refuse typed data for another chain). */
export function approveAgentAction(n: Network, chainId: number, agentAddress: string): UserAction {
  return {
    type: "approveAgent",
    signatureChainId: `0x${chainId.toString(16)}`,
    hyperliquidChain: chainName(n),
    agentAddress,
    agentName: AGENT_NAME,
    nonce: Date.now(),
  };
}

export function approveBuilderFeeAction(n: Network, chainId: number, builder: string, maxFeeRate: string): UserAction {
  return {
    type: "approveBuilderFee",
    signatureChainId: `0x${chainId.toString(16)}`,
    hyperliquidChain: chainName(n),
    maxFeeRate,
    builder: builder.toLowerCase(),
    nonce: Date.now(),
  };
}

/** eth_signTypedData_v4 payload for an action. */
export function typedData(action: UserAction) {
  const chainId = parseInt(action.signatureChainId, 16);
  if (action.type === "approveAgent") {
    return {
      domain: domain(chainId),
      primaryType: "HyperliquidTransaction:ApproveAgent",
      types: {
        EIP712Domain,
        "HyperliquidTransaction:ApproveAgent": [
          { name: "hyperliquidChain", type: "string" },
          { name: "agentAddress", type: "address" },
          { name: "agentName", type: "string" },
          { name: "nonce", type: "uint64" },
        ],
      },
      message: {
        hyperliquidChain: action.hyperliquidChain,
        agentAddress: action.agentAddress,
        agentName: action.agentName,
        nonce: action.nonce,
      },
    };
  }
  return {
    domain: domain(chainId),
    primaryType: "HyperliquidTransaction:ApproveBuilderFee",
    types: {
      EIP712Domain,
      "HyperliquidTransaction:ApproveBuilderFee": [
        { name: "hyperliquidChain", type: "string" },
        { name: "maxFeeRate", type: "string" },
        { name: "builder", type: "address" },
        { name: "nonce", type: "uint64" },
      ],
    },
    message: {
      hyperliquidChain: action.hyperliquidChain,
      maxFeeRate: action.maxFeeRate,
      builder: action.builder,
      nonce: action.nonce,
    },
  };
}

export async function hlInfo<T = unknown>(n: Network, body: Record<string, unknown>): Promise<T> {
  const r = await fetch(`${HL_API[n]}/info`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    cache: "no-store",
  });
  if (!r.ok) throw new Error(`Hyperliquid info ${body.type} failed (${r.status})`);
  return r.json() as Promise<T>;
}

/** "0.05%" -> 50 (tenths of a basis point, the unit maxBuilderFee returns). */
export function feeRateToBps10(rate: string): number {
  return Math.round(parseFloat(rate.replace("%", "")) * 1000);
}
