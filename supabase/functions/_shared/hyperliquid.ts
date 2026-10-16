// Hyperliquid client for one user's PERSONAL account, signed by that user's agent wallet.
//
//   * HIP-3 builder dex `xyz` is where US equities and commodities trade (`xyz:NVDA`, `xyz:GOLD`);
//     builder-dex asset ids are 110000 + 10000 * (dex position in perpDexs, minus the default) + index;
//   * standard perps and the xyz dex hold SEPARATE collateral on a classic account -- size each order
//     against the pot it draws from; a unified account shares one pool;
//   * prices: 5 significant figures and at most (6 - szDecimals) decimals; sizes to szDecimals;
//   * entries are IOC with a slippage bound; closes are reduce-only so they can never flip;
//   * every order carries the builder code {b, f} (revenue);
//   * L1 actions are signed exactly like the official SDK: msgpack(action) || nonce(8, BE) ||
//     vault flag -> keccak256 -> EIP-712 "Agent" {source, connectionId} on chain 1337.
//     tests/signing_test.ts proves byte-identical signatures against the Python SDK.
import { encode as msgpackEncode } from "npm:@msgpack/msgpack@2.8.0";
import { keccak256, type Hex } from "npm:viem@2.21.55";
import { privateKeyToAccount } from "npm:viem@2.21.55/accounts";
import { crypto as stdCrypto } from "jsr:@std/crypto@1.0.3";
import { env, envBool, envNum } from "./env.ts";

export const MAINNET = "https://api.hyperliquid.xyz";
export const TESTNET = "https://api.hyperliquid-testnet.xyz";
export const MIN_NOTIONAL_USD = 10;
export const HIP3_OFFSET = 110000;
const ALIASES: Record<string, string> = { XAU: "GOLD", XAG: "SILVER", WTI: "CL", USOIL: "CL", BRENT: "BRENTOIL" };
/** Every order we place carries this 4-byte cloid prefix, so our orders are told apart from the user's. */
export const CLOID_MAGIC = "ae70c0de";

export class BrokerError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "BrokerError";
  }
}

export interface Position {
  coin: string;
  side: "long" | "short";
  qty: number;
  entry_price: number | null;
  mark_price: number | null;
  unrealized_pnl: number;
  leverage: number | null;
  liquidation_px: number | null;
}

export interface AccountState {
  equity: number;
  pots: Record<string, number>; // {"": perps, "xyz": xyz}; empty when unified
  withdrawable: Record<string, number>;
  positions: Position[];
}

// ------------------------------------------------------------------------------------------------
// Wire helpers (identical to the SDK)
// ------------------------------------------------------------------------------------------------
export function floatToWire(x: number): string {
  const rounded = x.toFixed(8);
  if (Math.abs(Number(rounded) - x) >= 1e-12) throw new BrokerError(`float_to_wire causes rounding: ${x}`);
  let s = rounded.includes(".") ? rounded.replace(/0+$/, "").replace(/\.$/, "") : rounded;
  if (s === "-0" || s === "") s = "0";
  return s;
}

/** 5 significant figures, at most (6 - szDecimals) decimals (perps). */
export function roundPx(raw: number, szDecimals: number): number {
  const sig = Number(raw.toPrecision(5));
  const d = Math.max(0, 6 - szDecimals);
  return Number(sig.toFixed(d));
}
export function roundSz(qty: number, szDecimals: number): number {
  const m = 10 ** szDecimals;
  return Math.round(qty * m) / m;
}

export type OrderType =
  | { limit: { tif: "Ioc" | "Gtc" | "Alo" } }
  | { trigger: { triggerPx: number; isMarket: boolean; tpsl: "sl" | "tp" } };

export interface OrderReq {
  asset: number;
  isBuy: boolean;
  sz: number;
  limitPx: number;
  orderType: OrderType;
  reduceOnly: boolean;
  cloid?: string | null;
}

// Key order matters: msgpack preserves it and the venue hashes the bytes.
export function orderWire(o: OrderReq) {
  // deno-lint-ignore no-explicit-any
  const t: any = "limit" in o.orderType
    ? { limit: o.orderType.limit }
    : { trigger: { isMarket: o.orderType.trigger.isMarket, triggerPx: floatToWire(o.orderType.trigger.triggerPx), tpsl: o.orderType.trigger.tpsl } };
  // deno-lint-ignore no-explicit-any
  const w: any = { a: o.asset, b: o.isBuy, p: floatToWire(o.limitPx), s: floatToWire(o.sz), r: o.reduceOnly, t };
  if (o.cloid) w.c = o.cloid;
  return w;
}

export function orderAction(wires: unknown[], builder?: { b: string; f: number } | null, grouping = "na") {
  // deno-lint-ignore no-explicit-any
  const a: any = { type: "order", orders: wires, grouping };
  if (builder) a.builder = { b: builder.b.toLowerCase(), f: builder.f };
  return a;
}

function hexToBytes(h: string): Uint8Array {
  const s = h.startsWith("0x") ? h.slice(2) : h;
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(2 * i, 2 * i + 2), 16);
  return out;
}

export function actionHash(action: unknown, vault: string | null, nonce: number): Hex {
  const packed = msgpackEncode(action, { ignoreUndefined: true });
  const tail = vault ? 1 + 1 + 20 : 1;
  const buf = new Uint8Array(packed.length + 8 + tail);
  buf.set(packed, 0);
  new DataView(buf.buffer).setBigUint64(packed.length, BigInt(nonce), false);
  if (vault) {
    buf[packed.length + 8] = 1;
    buf.set(hexToBytes(vault), packed.length + 9);
  } else buf[packed.length + 8] = 0;
  return keccak256(buf);
}

export async function signL1Action(privateKey: Hex, action: unknown, vault: string | null, nonce: number, mainnet: boolean) {
  const account = privateKeyToAccount(privateKey);
  const sig = await account.signTypedData({
    domain: { chainId: 1337, name: "Exchange", verifyingContract: "0x0000000000000000000000000000000000000000", version: "1" },
    types: { Agent: [{ name: "source", type: "string" }, { name: "connectionId", type: "bytes32" }] },
    primaryType: "Agent",
    message: { source: mainnet ? "a" : "b", connectionId: actionHash(action, vault, nonce) },
  });
  return { r: `0x${sig.slice(2, 66)}`, s: `0x${sig.slice(66, 130)}`, v: parseInt(sig.slice(130, 132), 16) };
}

export function agentAddress(privateKey: Hex): string {
  return privateKeyToAccount(privateKey).address.toLowerCase();
}

export async function cloidFor(wallet: string, coin: string, tag: string, nowMs = Date.now()): Promise<string> {
  const raw = `${wallet}|${coin}|${tag}|${Math.floor(nowMs / 60000)}`;
  const d = new Uint8Array(await stdCrypto.subtle.digest("MD5", new TextEncoder().encode(raw)));
  const hex = [...d].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `0x${CLOID_MAGIC}${hex.slice(0, 24)}`;
}
export const isOurCloid = (c: string | null | undefined) => !!c && c.toLowerCase().startsWith(`0x${CLOID_MAGIC}`);

// ------------------------------------------------------------------------------------------------
// Info endpoint
// ------------------------------------------------------------------------------------------------
export async function info<T = unknown>(payload: Record<string, unknown>, baseUrl = MAINNET, retries = 2): Promise<T> {
  let last: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const r = await fetch(`${baseUrl}/info`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),
        signal: AbortSignal.timeout(15000),
      });
      if (r.status >= 500 || r.status === 429) throw new Error(`HTTP ${r.status}`);
      if (!r.ok) throw new BrokerError(`info ${payload.type}: HTTP ${r.status} ${(await r.text()).slice(0, 200)}`);
      return await r.json() as T;
    } catch (e) {
      last = e;
      if (e instanceof BrokerError) throw e;
      if (attempt < retries) await new Promise((res) => setTimeout(res, 500 * 2 ** attempt));
    }
  }
  throw new BrokerError(`info ${payload.type} failed: ${String((last as Error)?.message ?? last)}`);
}

export const builderConfig = () => {
  const b = env("BUILDER_ADDRESS", "").toLowerCase();
  return b ? { b, f: Math.trunc(envNum("BUILDER_FEE_BPS10", 30)) } : null;
};
export const liveGatesOpen = () => !envBool("DRY_RUN", true) && envBool("HYPERLIQUID_LIVE_CONFIRMED", false);

// ------------------------------------------------------------------------------------------------
// Account client
// ------------------------------------------------------------------------------------------------
export class HyperliquidAccount {
  readonly user: string;
  readonly dex: string;
  readonly mainnet: boolean;
  szDecimals = new Map<string, number>();
  maxLev = new Map<string, number>();
  assetId = new Map<string, number>();
  private constructor(readonly baseUrl: string, wallet: string, private readonly key: Hex) {
    this.user = wallet.toLowerCase();
    this.dex = env("HIP3_DEX", "xyz");
    this.mainnet = baseUrl === MAINNET;
  }

  /** Refuses a master key (one whose address IS the wallet) before any I/O. */
  static async open(wallet: string, agentKey: string, network: string): Promise<HyperliquidAccount> {
    const key = (agentKey.startsWith("0x") ? agentKey : `0x${agentKey}`) as Hex;
    if (agentAddress(key) === wallet.toLowerCase()) throw new BrokerError("refusing to use a master wallet key as an agent key");
    const base = network === "testnet" ? TESTNET : env("HYPERLIQUID_API_URL", MAINNET).replace(/\/$/, "");
    const acct = new HyperliquidAccount(base, wallet, key);
    await acct.loadMeta();
    return acct;
  }

  private async loadMeta() {
    // deno-lint-ignore no-explicit-any
    const meta = await info<any>({ type: "meta" }, this.baseUrl);
    meta.universe.forEach((a: { name: string; szDecimals: number; maxLeverage?: number }, i: number) => {
      this.szDecimals.set(a.name, Number(a.szDecimals));
      this.maxLev.set(a.name, Number(a.maxLeverage || 0));
      this.assetId.set(a.name, i);
    });
    // deno-lint-ignore no-explicit-any
    const dexes = await info<any[]>({ type: "perpDexs" }, this.baseUrl);
    const k = (dexes || []).slice(1).findIndex((d) => d && d.name === this.dex);
    if (k < 0) throw new BrokerError(`HIP-3 dex '${this.dex}' not listed`);
    const offset = HIP3_OFFSET + k * 10000;
    // deno-lint-ignore no-explicit-any
    const m = await info<any>({ type: "meta", dex: this.dex }, this.baseUrl);
    (m?.universe || []).forEach((a: { name: string; szDecimals: number; maxLeverage?: number }, i: number) => {
      this.szDecimals.set(a.name, Number(a.szDecimals));
      this.maxLev.set(a.name, Number(a.maxLeverage || 0));
      this.assetId.set(a.name, offset + i);
    });
  }

  toCoin(symbol: string): string {
    if (symbol.includes(":")) {
      const [d, c] = symbol.split(":", 2);
      const name = `${d.toLowerCase()}:${c.toUpperCase()}`;
      if (this.szDecimals.has(name)) return name;
    }
    const base = symbol.split(":").pop()!.toUpperCase();
    if (this.szDecimals.has(base) && !symbol.includes(":")) return base;
    const name = `${this.dex}:${ALIASES[base] ?? base}`;
    if (this.szDecimals.has(name)) return name;
    throw new BrokerError(`'${symbol}' is not listed on Hyperliquid perps or HIP-3 '${this.dex}'`);
  }

  px(coin: string, raw: number) { return roundPx(raw, this.szDecimals.get(coin) ?? 4); }
  sz(coin: string, qty: number) { return roundSz(qty, this.szDecimals.get(coin) ?? 4); }

  async mid(coin: string): Promise<number> {
    const mids = await info<Record<string, string>>(coin.includes(":") ? { type: "allMids", dex: coin.split(":")[0] } : { type: "allMids" }, this.baseUrl);
    const px = Number(mids?.[coin]);
    if (!px) throw new BrokerError(`no mid price for ${coin}`);
    return px;
  }

  // deno-lint-ignore no-explicit-any
  async l2Book(coin: string): Promise<any> {
    return await info({ type: "l2Book", coin }, this.baseUrl);
  }

  // deno-lint-ignore no-explicit-any
  private async state(dex = ""): Promise<any> {
    return await info(dex ? { type: "clearinghouseState", user: this.user, dex } : { type: "clearinghouseState", user: this.user }, this.baseUrl);
  }

  // deno-lint-ignore no-explicit-any
  static parse(st: any): Position[] {
    const out: Position[] = [];
    for (const ap of st?.assetPositions || []) {
      const p = ap.position || {};
      const szi = Number(p.szi || 0);
      if (!szi) continue;
      const qty = Math.abs(szi);
      out.push({
        coin: p.coin || "", side: szi > 0 ? "long" : "short", qty,
        entry_price: Number(p.entryPx || 0) || null, mark_price: Number(p.positionValue || 0) / qty,
        unrealized_pnl: Number(p.unrealizedPnl || 0), leverage: p.leverage?.value ? Number(p.leverage.value) : null,
        liquidation_px: p.liquidationPx ? Number(p.liquidationPx) : null,
      });
    }
    return out;
  }

  async account(): Promise<AccountState> {
    const [perp, xyz] = await Promise.all([this.state(), this.state(this.dex)]);
    // A partial read would look like a drawdown and could trip the risk halt.
    if (!perp?.marginSummary) throw new BrokerError("perps clearinghouse read failed");
    if (!xyz || !xyz.marginSummary) throw new BrokerError(`HIP-3 '${this.dex}' clearinghouse read failed`);
    const pe = Number(perp.marginSummary.accountValue), xe = Number(xyz.marginSummary.accountValue || 0);
    const positions = [...HyperliquidAccount.parse(perp), ...HyperliquidAccount.parse(xyz)];
    let equity = pe + xe;
    let pots: Record<string, number> = { "": pe, [this.dex]: xe };
    const withdrawable = { "": Number(perp.withdrawable || 0), [this.dex]: Number(xyz.withdrawable || 0) };
    try {
      const abs = await info<string>({ type: "userAbstraction", user: this.user }, this.baseUrl);
      if (abs === "unifiedAccount") {
        // deno-lint-ignore no-explicit-any
        const spot = await info<any>({ type: "spotClearinghouseState", user: this.user }, this.baseUrl);
        const usdc = (spot?.balances || []).filter((b: { coin: string }) => b.coin === "USDC").reduce((s: number, b: { total: string }) => s + Number(b.total), 0);
        equity = usdc + positions.reduce((s, p) => s + p.unrealized_pnl, 0);
        pots = {};
      }
    } catch (_e) { /* abstraction unknown: per-dex sum stands */ }
    return { equity, pots, withdrawable, positions };
  }

  sizingEquity(st: AccountState, coin: string): number {
    if (!Object.keys(st.pots).length) return st.equity;
    return Number(st.pots[coin.includes(":") ? coin.split(":")[0] : ""] ?? 0);
  }

  // deno-lint-ignore no-explicit-any
  async openOrders(): Promise<any[]> {
    const [a, b] = await Promise.all([
      info<unknown[]>({ type: "frontendOpenOrders", user: this.user }, this.baseUrl),
      info<unknown[]>({ type: "frontendOpenOrders", user: this.user, dex: this.dex }, this.baseUrl),
    ]);
    return [...(a || []), ...(b || [])];
  }

  async maxBuilderFee(builder: string): Promise<number> {
    return Number(await info({ type: "maxBuilderFee", user: this.user, builder }, this.baseUrl) || 0);
  }

  // deno-lint-ignore no-explicit-any
  async userFills(startMs: number): Promise<any[]> {
    return await info({ type: "userFillsByTime", user: this.user, startTime: startMs, endTime: Date.now() }, this.baseUrl) || [];
  }

  // ---- exchange (signed) ----
  private requireLive() {
    if (!liveGatesOpen()) throw new BrokerError("live gates closed (DRY_RUN / HYPERLIQUID_LIVE_CONFIRMED)");
  }

  // deno-lint-ignore no-explicit-any
  private async post(action: any): Promise<any> {
    this.requireLive();
    const nonce = Date.now();
    const signature = await signL1Action(this.key, action, null, nonce, this.mainnet);
    const r = await fetch(`${this.baseUrl}/exchange`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, nonce, signature, vaultAddress: null, expiresAfter: null }),
      signal: AbortSignal.timeout(15000),
    });
    const text = await r.text();
    let body: unknown;
    try { body = JSON.parse(text); } catch { body = text; }
    // deno-lint-ignore no-explicit-any
    if (!r.ok || (body as any)?.status !== "ok") throw new BrokerError(`exchange ${action.type} rejected: ${text.slice(0, 300)}`);
    return body;
  }

  private asset(coin: string): number {
    const a = this.assetId.get(coin);
    if (a === undefined) throw new BrokerError(`no asset id for ${coin}`);
    return a;
  }

  async setLeverage(coin: string, leverage: number): Promise<number> {
    let lev = Math.max(1, Math.trunc(leverage));
    const cap = this.maxLev.get(coin) || lev;
    lev = Math.min(lev, cap);
    await this.post({ type: "updateLeverage", asset: this.asset(coin), isCross: false, leverage: lev });
    return lev;
  }

  async cancel(coin: string, oid: number) {
    return await this.post({ type: "cancel", cancels: [{ a: this.asset(coin), o: oid }] });
  }

  /** IOC market order. Entries need explicit leverage (set right before); closes are reduce-only. */
  async marketOrder(coin: string, isBuy: boolean, qty: number, opts: { reduceOnly?: boolean; leverage?: number; tag: string; slippage?: number }) {
    this.requireLive();
    const reduceOnly = !!opts.reduceOnly;
    const sz = this.sz(coin, qty);
    if (sz <= 0) throw new BrokerError(`${coin}: size rounds to 0`);
    const mid = await this.mid(coin);
    if (sz * mid < MIN_NOTIONAL_USD && !reduceOnly) throw new BrokerError(`${coin}: notional $${(sz * mid).toFixed(2)} is below the $10 venue minimum`);
    if (!reduceOnly) {
      if (!opts.leverage) throw new BrokerError(`${coin}: refusing an entry without explicit leverage`);
      await this.setLeverage(coin, opts.leverage);
    }
    const slip = opts.slippage ?? envNum("HYPERLIQUID_SLIPPAGE", 0.005);
    const limit = this.px(coin, mid * (isBuy ? 1 + slip : 1 - slip));
    const cloid = await cloidFor(this.user, coin, opts.tag);
    const resp = await this.post(orderAction([orderWire({ asset: this.asset(coin), isBuy, sz, limitPx: limit, orderType: { limit: { tif: "Ioc" } }, reduceOnly, cloid })], builderConfig()));
    const s0 = resp.response?.data?.statuses?.[0] || {};
    if (s0.error) throw new BrokerError(`order error: ${s0.error}`);
    const fill = s0.filled || {};
    const filled = Number(fill.totalSz || 0);
    if (filled <= 0) throw new BrokerError(`${coin}: IOC got no fill`);
    return { oid: String(fill.oid ?? ""), filled, avg_px: Number(fill.avgPx || 0), status: filled >= sz * 0.999 ? "filled" : "partial", requested: sz, cloid };
  }

  /** Venue-resident reduce-only trigger (stop-loss or take-profit), market on trigger. */
  async placeTrigger(coin: string, posSide: "long" | "short", qty: number, triggerPx: number, tpsl: "sl" | "tp", slip = 0.05) {
    this.requireLive();
    const isBuy = posSide === "short";
    const trigger = this.px(coin, triggerPx);
    const limit = this.px(coin, trigger * (isBuy ? 1 + slip : 1 - slip));
    const cloid = await cloidFor(this.user, coin, `stop-${tpsl}-${posSide}`);
    const resp = await this.post(orderAction([orderWire({
      asset: this.asset(coin), isBuy, sz: this.sz(coin, qty), limitPx: limit,
      orderType: { trigger: { triggerPx: trigger, isMarket: true, tpsl } }, reduceOnly: true, cloid,
    })], builderConfig()));
    const s0 = resp.response?.data?.statuses?.[0] || {};
    if (s0.error) throw new BrokerError(`${tpsl} error: ${s0.error}`);
    return { oid: String((s0.resting || s0.filled || {}).oid ?? ""), trigger, cloid };
  }
}
