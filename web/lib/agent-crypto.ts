"use client";

/** Encrypt an agent private key for the trusted executor's RSA-OAEP public key. */
export async function encryptAgentKey(privateKey: `0x${string}`): Promise<string> {
  const encodedKey = process.env.NEXT_PUBLIC_AGENT_ENCRYPTION_PUBLIC_KEY;
  if (!encodedKey) throw new Error("Agent encryption public key is not configured");

  const binary = atob(encodedKey.replace(/-/g, "+").replace(/_/g, "/"));
  const spki = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  const publicKey = await crypto.subtle
    .importKey("spki", spki, { name: "RSA-OAEP", hash: "SHA-256" }, false, ["encrypt"])
    .catch(() => {
      throw new Error("Agent encryption public key is invalid (expected base64 DER SPKI RSA key, see docs/AGENT_KEY_ENCRYPTION.md)");
    });
  const ciphertext = await crypto.subtle.encrypt(
    { name: "RSA-OAEP" },
    publicKey,
    new TextEncoder().encode(privateKey),
  );
  const bytes = new Uint8Array(ciphertext);
  let binaryCiphertext = "";
  bytes.forEach((byte) => (binaryCiphertext += String.fromCharCode(byte)));
  const base64url = btoa(binaryCiphertext).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `rsa1.${base64url}`;
}
