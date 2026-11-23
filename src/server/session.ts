import "server-only";
import { cookies } from "next/headers";
import { cache } from "react";
import { roleHas, type Permission } from "@/lib/authz/permissions";
import type { Role } from "@/lib/clinical/vocabulary";
import { SESSION_COOKIE } from "./auth/cookies";
import { getAuthedSession, type AuthedSession } from "./auth/service";

/**
 * The authenticated session for the current request (validated against the
 * database on every request — revocation and deactivation take effect immediately).
 */
export interface Session extends AuthedSession {
  /** Alias of staffId, kept for readability in data-access code. */
  userId: string;
  initials: string;
  role: Role;
}

function initialsOf(name: string): string {
  const parts = name
    .replace(/\(.*?\)/g, "")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  return ((parts[0]?.[0] ?? "?") + (parts.length > 1 ? parts[parts.length - 1][0] : "")).toUpperCase();
}

export const getSession = cache(async (): Promise<Session | null> => {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE())?.value;
  if (!token) return null;
  const s = await getAuthedSession(token);
  if (!s) return null;
  return { ...s, userId: s.staffId, initials: initialsOf(s.displayName) };
});

export function can(session: Session | null, permission: Permission): boolean {
  return !!session && roleHas(session.role, permission);
}

export class AuthorizationError extends Error {
  constructor(public readonly permission: Permission) {
    super("Forbidden");
  }
}

export class AuthenticationError extends Error {
  constructor() {
    super("Unauthenticated");
  }
}

/** Throws unless the current session holds `permission`. Used by every data-access function. */
export async function requirePermission(permission: Permission): Promise<Session> {
  const session = await getSession();
  if (!session) throw new AuthenticationError();
  if (!roleHas(session.role, permission)) throw new AuthorizationError(permission);
  return session;
}
