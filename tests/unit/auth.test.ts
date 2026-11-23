import { describe, expect, it } from "vitest";
import { checkPassword } from "@/lib/auth/password";
import { decryptSecret, encryptSecret, randomToken, sha256Hex } from "@/lib/auth/tokens";
import { base32Decode, base32Encode, generateTotpSecret, otpauthUri, totpCode, totpStep, verifyTotp } from "@/lib/auth/totp";

// RFC 6238 Appendix B, SHA-1 secret "12345678901234567890".
const RFC_SECRET = base32Encode(Buffer.from("12345678901234567890", "ascii"));

describe("TOTP (RFC 6238)", () => {
  it.each([
    [59, "94287082"],
    [1111111109, "07081804"],
    [1111111111, "14050471"],
    [1234567890, "89005924"],
    [2000000000, "69279037"],
    [20000000000, "65353130"],
  ])("T=%i → %s", (t, expected) => {
    expect(totpCode(RFC_SECRET, t * 1000, 8)).toBe(expected);
  });

  it("base32 round-trips and matches the RFC secret encoding", () => {
    expect(RFC_SECRET).toBe("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ");
    expect(base32Decode(RFC_SECRET).toString("ascii")).toBe("12345678901234567890");
    expect(() => base32Decode("not*base32")).toThrow();
  });

  it("generated secrets are 160-bit and unique", () => {
    const a = generateTotpSecret();
    expect(base32Decode(a)).toHaveLength(20);
    expect(generateTotpSecret()).not.toBe(a);
  });

  it("accepts ±1 step of clock drift, rejects further drift", () => {
    const s = generateTotpSecret();
    const t = 1_800_000_000_000;
    expect(verifyTotp(s, totpCode(s, t - 30_000), t, null)).toBe(totpStep(t) - 1);
    expect(verifyTotp(s, totpCode(s, t + 30_000), t, null)).toBe(totpStep(t) + 1);
    expect(verifyTotp(s, totpCode(s, t - 90_000), t, null)).toBeNull();
  });

  it("rejects replay of the same or an older step", () => {
    const s = generateTotpSecret();
    const t = 1_800_000_000_000;
    const code = totpCode(s, t);
    expect(verifyTotp(s, code, t, totpStep(t))).toBeNull();
    expect(verifyTotp(s, code, t, totpStep(t) - 1)).toBe(totpStep(t));
  });

  it("rejects malformed codes", () => {
    const s = generateTotpSecret();
    for (const bad of ["", "12345", "1234567", "abcdef", "12 345"]) expect(verifyTotp(s, bad, Date.now(), null)).toBeNull();
  });

  it("otpauth URI carries issuer and standard parameters", () => {
    const u = otpauthUri("ABC", "rt.alpha");
    expect(u).toBe("otpauth://totp/PUIMS%3Art.alpha?secret=ABC&issuer=PUIMS&algorithm=SHA1&digits=6&period=30");
  });
});

describe("password policy (NIST SP 800-63B style)", () => {
  const ctx = { username: "jcruz", displayName: "Juana Cruz" };
  it("accepts long passphrases without composition rules", () => {
    expect(checkPassword("correct horse battery staple", ctx).ok).toBe(true);
  });
  it.each([
    ["short", /at least 12/],
    ["password1234", /too common/],
    ["Password123!", /too common/],
    ["jcruz-is-the-best", /username or name/],
    ["my name is juana!", /username or name/],
    ["aaaaaaaaaaaaaa", /repeat/],
  ])("rejects %s", (pw, msg) => {
    const r = checkPassword(pw, ctx);
    expect(r.ok).toBe(false);
    expect(r.problems.join(" ")).toMatch(msg);
  });
  it("rejects absurdly long input", () => {
    expect(checkPassword("x".repeat(200) + "yz", ctx).ok).toBe(false);
  });
});

describe("tokens and at-rest encryption", () => {
  const key = Buffer.alloc(32, 7).toString("base64");
  it("random tokens are 256-bit, URL-safe and unique", () => {
    const t = randomToken();
    expect(t).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(randomToken()).not.toBe(t);
  });
  it("sha256Hex is deterministic", () => {
    expect(sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
  it("AES-256-GCM round-trips with a random IV per encryption", () => {
    const a = encryptSecret("JBSWY3DPEHPK3PXP", key);
    const b = encryptSecret("JBSWY3DPEHPK3PXP", key);
    expect(a).not.toBe(b);
    expect(decryptSecret(a, key)).toBe("JBSWY3DPEHPK3PXP");
  });
  it("tampering or a wrong key is detected", () => {
    const blob = encryptSecret("secret", key);
    const parts = blob.split(".");
    parts[3] = Buffer.from("tampered").toString("base64url");
    expect(() => decryptSecret(parts.join("."), key)).toThrow();
    expect(() => decryptSecret(blob, Buffer.alloc(32, 9).toString("base64"))).toThrow();
  });
  it("refuses a missing or short key", () => {
    expect(() => encryptSecret("x", undefined)).toThrow(/PUIMS_DATA_KEY/);
    expect(() => encryptSecret("x", Buffer.alloc(16).toString("base64"))).toThrow(/32 bytes/);
  });
});
