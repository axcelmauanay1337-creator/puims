/**
 * TOTP (RFC 6238, HMAC-SHA1, 30 s, 6 digits) — the parameters every mainstream
 * authenticator app supports. Implemented on node:crypto (no third-party OTP library)
 * and verified against the RFC test vectors in tests/unit/auth.test.ts.
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
export const TOTP_STEP_SECONDS = 30;
export const TOTP_DIGITS = 6;

export function base32Encode(buf: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(s: string): Buffer {
  const clean = s.toUpperCase().replace(/=+$/, "").replace(/\s+/g, "");
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = B32.indexOf(ch);
    if (idx < 0) throw new Error("Invalid base32");
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** 160-bit secret, base32 (RFC 4226 recommends ≥128 bits). */
export function generateTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

export function hotp(secret: Buffer, counter: number, digits = TOTP_DIGITS): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const mac = createHmac("sha1", secret).update(msg).digest();
  const offset = mac[mac.length - 1] & 0x0f;
  const bin = ((mac[offset] & 0x7f) << 24) | (mac[offset + 1] << 16) | (mac[offset + 2] << 8) | mac[offset + 3];
  return String(bin % 10 ** digits).padStart(digits, "0");
}

export function totpStep(atMs: number): number {
  return Math.floor(atMs / 1000 / TOTP_STEP_SECONDS);
}

export function totpCode(secretB32: string, atMs: number, digits = TOTP_DIGITS): string {
  return hotp(base32Decode(secretB32), totpStep(atMs), digits);
}

/**
 * Verifies a code within ±`window` steps (tolerates small clock drift). Returns the
 * matched step, or null. A step at or below `lastUsedStep` is rejected (replay protection).
 */
export function verifyTotp(secretB32: string, code: string, atMs: number, lastUsedStep: number | null, window = 1): number | null {
  if (!/^\d{6}$/.test(code)) return null;
  const secret = base32Decode(secretB32);
  const now = totpStep(atMs);
  const given = Buffer.from(code);
  let matched: number | null = null;
  for (let s = now - window; s <= now + window; s++) {
    const expected = Buffer.from(hotp(secret, s));
    // Evaluate every candidate (constant work regardless of which matches).
    if (timingSafeEqual(expected, given) && matched === null) matched = s;
  }
  if (matched === null) return null;
  if (lastUsedStep !== null && matched <= lastUsedStep) return null;
  return matched;
}

export function otpauthUri(secretB32: string, accountName: string, issuer = "PUIMS"): string {
  const label = encodeURIComponent(`${issuer}:${accountName}`);
  return `otpauth://totp/${label}?secret=${secretB32}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=${TOTP_DIGITS}&period=${TOTP_STEP_SECONDS}`;
}
