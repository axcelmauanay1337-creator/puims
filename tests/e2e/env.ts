import { existsSync, readFileSync } from "node:fs";

/** .env.local values (local runs) overlaid by real environment variables (CI). */
export function loadEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  if (existsSync(".env.local")) {
    for (const line of readFileSync(".env.local", "utf8").split("\n")) {
      const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
      if (m) out[m[1]] = m[2];
    }
  }
  for (const [k, v] of Object.entries(process.env)) if (v !== undefined) out[k] = v;
  return out;
}

export const AUTH_DIR = "test-results/.auth";
export const STATE = { chief: `${AUTH_DIR}/chief.json`, rt: `${AUTH_DIR}/rt.json`, steps: `${AUTH_DIR}/totp-steps` };
export const USERS = { chief: "chief.demo", rt: "rt.bravo" } as const;
