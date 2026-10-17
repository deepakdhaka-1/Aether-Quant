// AES-256-GCM envelope shared with the web app and the Python engine:
//   "v1.<iv>.<ciphertext>.<tag>", each part base64url without padding; key = 32 bytes, base64.
// WebCrypto expects ciphertext||tag, which is how the envelope is reassembled here.
import { env } from "./env.ts";

function b64urlDecode(s: string): Uint8Array {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4);
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}
function b64urlEncode(b: Uint8Array): string {
  return btoa(String.fromCharCode(...b)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

async function importKey(raw?: string): Promise<CryptoKey> {
  const configured = raw ?? (Deno.env.get("API_ENCRYPTION_KEY") || env("AETHER_ENCRYPTION_KEY"));
  const k = Uint8Array.from(atob(configured), (c) => c.charCodeAt(0));
  if (k.length !== 32) throw new Error("API_ENCRYPTION_KEY must be 32 bytes, base64-encoded");
  return await crypto.subtle.importKey("raw", k, "AES-GCM", false, ["encrypt", "decrypt"]);
}

export async function decrypt(envelope: string, keyB64?: string): Promise<string> {
  const [v, iv, ct, tag] = envelope.split(".");
  if (v !== "v1") throw new Error(`unknown envelope version ${v}`);
  const c = b64urlDecode(ct), t = b64urlDecode(tag);
  const sealed = new Uint8Array(c.length + t.length);
  sealed.set(c);
  sealed.set(t, c.length);
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: b64urlDecode(iv) }, await importKey(keyB64), sealed);
  return new TextDecoder().decode(pt);
}

export async function encrypt(plaintext: string, keyB64?: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await importKey(keyB64), new TextEncoder().encode(plaintext)));
  return ["v1", b64urlEncode(iv), b64urlEncode(sealed.slice(0, -16)), b64urlEncode(sealed.slice(-16))].join(".");
}
