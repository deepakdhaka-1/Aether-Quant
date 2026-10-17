import "server-only";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

// AES-256-GCM envelope shared with engine/aether/crypto.py: "v1.<iv>.<ct>.<tag>" (base64url).

function key(): Buffer {
  const raw = process.env.API_ENCRYPTION_KEY || process.env.AETHER_ENCRYPTION_KEY || "";
  const k = Buffer.from(raw, "base64");
  if (k.length !== 32) throw new Error("API_ENCRYPTION_KEY must be 32 bytes, base64-encoded");
  return k;
}

export function encrypt(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return ["v1", iv, ct, cipher.getAuthTag()].map((p) => (typeof p === "string" ? p : p.toString("base64url"))).join(".");
}

export function decrypt(envelope: string): string {
  const [v, iv, ct, tag] = envelope.split(".");
  if (v !== "v1") throw new Error(`unknown envelope version ${v}`);
  const d = createDecipheriv("aes-256-gcm", key(), Buffer.from(iv, "base64url"));
  d.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([d.update(Buffer.from(ct, "base64url")), d.final()]).toString("utf8");
}
