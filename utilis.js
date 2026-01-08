import crypto from "crypto";

export function hash(text) {
  return crypto.createHash("sha256").update(text).digest("hex");
}

export function generateKey() {
  const r = () => Math.random().toString(36).substring(2, 6).toUpperCase();
  return `ESAMZ-ADFREE-${r()}-${r()}`;
}
