// Signature parity with the official Hyperliquid Python SDK, plus the AES-GCM envelope.
import { assertEquals } from "jsr:@std/assert@1.0.8";
import { agentAddress, floatToWire, orderAction, orderWire, roundPx, signL1Action } from "../_shared/hyperliquid.ts";
import { decrypt, encrypt } from "../_shared/crypto.ts";

const gold = JSON.parse(Deno.readTextFileSync(new URL("./hl_signing.json", import.meta.url)));
const B = { b: "0x00000000000000000000000000000000000000AA", f: 30 };
const entry = orderWire({ asset: 110002, isBuy: true, sz: 0.37, limitPx: 187.42, orderType: { limit: { tif: "Ioc" } }, reduceOnly: false, cloid: "0xae70c0de0123456789abcdef01234567" });
// Actions rebuilt from primitives in TypeScript (so the wire format is tested too).
const built: Record<string, unknown> = {
  ioc_entry_builder: orderAction([entry], B),
  trigger_stop: orderAction([orderWire({ asset: 110005, isBuy: false, sz: 1.5, limitPx: 3900.1, orderType: { trigger: { triggerPx: 4100, isMarket: true, tpsl: "sl" } }, reduceOnly: true })], B),
  ioc_no_builder_testnet: orderAction([entry]),
  cancel: { type: "cancel", cancels: [{ a: 110002, o: 123456789 }] },
  update_leverage: { type: "updateLeverage", asset: 110002, isCross: false, leverage: 3 },
  big_nonce_small_px: orderAction([orderWire({ asset: 0, isBuy: false, sz: 0.00012, limitPx: 0.000123, orderType: { limit: { tif: "Gtc" } }, reduceOnly: true })]),
};

Deno.test("signing: agent address derivation", () => {
  assertEquals(agentAddress(gold.key), gold.address.toLowerCase());
});

for (const c of gold.cases) {
  Deno.test(`signing: ${c.name} identical to the Python SDK`, async () => {
    assertEquals(JSON.stringify(built[c.name]), JSON.stringify(c.action), "wire format");
    const sig = await signL1Action(gold.key, built[c.name], c.vault, c.nonce, c.mainnet);
    assertEquals([BigInt(sig.r), BigInt(sig.s), sig.v], [BigInt(c.r), BigInt(c.s), c.v]);
  });
}

Deno.test("wire: float and price rounding", () => {
  assertEquals([floatToWire(100), floatToWire(0.1), floatToWire(1e-8), floatToWire(-0)], ["100", "0.1", "0.00000001", "0"]);
  assertEquals([roundPx(187.4251, 2), roundPx(3901.234, 2), roundPx(0.000123456, 0), roundPx(123456.7, 0)], [187.43, 3901.2, 0.000123, 123460]);
});

Deno.test("crypto: decrypts the Python/web envelope and round-trips", async () => {
  const g = JSON.parse(Deno.readTextFileSync(new URL("./crypto_envelope.json", import.meta.url)));
  assertEquals(await decrypt(g.envelope, g.key), g.plaintext);
  assertEquals(await decrypt(await encrypt("hello", g.key), g.key), "hello");
});
