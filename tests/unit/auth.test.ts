import { describe, expect, it } from "vitest";
import { checkPassword } from "@/lib/auth/password";
import { decryptSecret, encryptSecret, randomToken, sha256Hex } from "@/lib/auth/tokens";

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
