import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

/** 256-bit random token, URL-safe. Only its SHA-256 is stored. */
export function randomToken(): string {
  return randomBytes(32).toString("base64url");
}

export function sha256Hex(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

function key(raw: string | undefined): Buffer {
  if (!raw) throw new Error("PUIMS_DATA_KEY is not configured");
  const k = Buffer.from(raw, "base64");
  if (k.length !== 32) throw new Error("PUIMS_DATA_KEY must be 32 bytes, base64-encoded");
  return k;
}

/** AES-256-GCM. Output: v1.<iv>.<tag>.<ciphertext> (base64url). */
export function encryptSecret(plain: string, rawKey = process.env.PUIMS_DATA_KEY): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key(rawKey), iv);
  const ct = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return ["v1", iv.toString("base64url"), c.getAuthTag().toString("base64url"), ct.toString("base64url")].join(".");
}

export function decryptSecret(blob: string, rawKey = process.env.PUIMS_DATA_KEY): string {
  const [v, iv, tag, ct] = blob.split(".");
  if (v !== "v1" || !iv || !tag || !ct) throw new Error("Unsupported secret format");
  const d = createDecipheriv("aes-256-gcm", key(rawKey), Buffer.from(iv, "base64url"));
  d.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([d.update(Buffer.from(ct, "base64url")), d.final()]).toString("utf8");
}

export const USERNAME_RE = /^[a-z0-9][a-z0-9._-]{2,39}$/;

/** AES-256-GCM for binary blobs (e.g. a retained original workbook): [0x01 | iv(12) | tag(16) | ciphertext]. */
export function encryptBytes(plain: Buffer, rawKey = process.env.PUIMS_DATA_KEY): Buffer {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key(rawKey), iv);
  const ct = Buffer.concat([c.update(plain), c.final()]);
  return Buffer.concat([Buffer.from([1]), iv, c.getAuthTag(), ct]);
}

export function decryptBytes(blob: Buffer, rawKey = process.env.PUIMS_DATA_KEY): Buffer {
  if (blob[0] !== 1 || blob.length < 29) throw new Error("Unsupported blob format");
  const d = createDecipheriv("aes-256-gcm", key(rawKey), blob.subarray(1, 13));
  d.setAuthTag(blob.subarray(13, 29));
  return Buffer.concat([d.update(blob.subarray(29)), d.final()]);
}
