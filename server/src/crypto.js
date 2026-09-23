import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { config } from "./config.js";

// AES-256-GCM: iv(12) | tag(16) | ciphertext  → base64
export function encrypt(plain) {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", config.tokenKey, iv);
  const enc = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), enc]).toString("base64");
}
export function decrypt(b64) {
  const buf = Buffer.from(b64, "base64");
  const d = createDecipheriv("aes-256-gcm", config.tokenKey, buf.subarray(0, 12));
  d.setAuthTag(buf.subarray(12, 28));
  return Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString("utf8");
}
export const randomCode = (n = 32) => randomBytes(n).toString("base64url");
