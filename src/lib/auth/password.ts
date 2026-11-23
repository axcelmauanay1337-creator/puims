/**
 * Password policy aligned with NIST SP 800-63B: length over composition rules,
 * block common/contextual passwords, allow long passphrases, no forced rotation.
 */
export const PASSWORD_MIN = 12;
export const PASSWORD_MAX = 128;

const COMMON = new Set([
  "password",
  "password1",
  "password123",
  "passw0rd",
  "123456789012",
  "1234567890",
  "qwertyuiop",
  "qwerty123456",
  "iloveyou",
  "letmein",
  "welcome",
  "welcome123",
  "admin",
  "administrator",
  "changeme",
  "hospital",
  "pulmonary",
  "respiratory",
  "therapist",
  "puims",
  "manila",
  "philippines",
  "abc123",
  "111111111111",
  "000000000000",
]);

export interface PasswordCheck {
  ok: boolean;
  problems: string[];
}

export function checkPassword(pw: string, context: { username: string; displayName?: string }): PasswordCheck {
  const problems: string[] = [];
  if (pw.length < PASSWORD_MIN) problems.push(`Use at least ${PASSWORD_MIN} characters.`);
  if (pw.length > PASSWORD_MAX) problems.push(`Use at most ${PASSWORD_MAX} characters.`);
  const lower = pw.toLowerCase();
  const stripped = lower.replace(/[^a-z0-9]/g, "");
  if (COMMON.has(lower) || COMMON.has(stripped) || COMMON.has(stripped.replace(/\d+$/, ""))) {
    problems.push("This password is too common.");
  }
  const tokens = [context.username, ...(context.displayName ?? "").split(/\s+/)]
    .map((t) => t.toLowerCase().replace(/[^a-z0-9]/g, ""))
    .filter((t) => t.length >= 4);
  if (tokens.some((t) => stripped.includes(t))) problems.push("Do not include your username or name.");
  if (/^(.)\1+$/.test(pw)) problems.push("Do not repeat a single character.");
  return { ok: problems.length === 0, problems };
}
