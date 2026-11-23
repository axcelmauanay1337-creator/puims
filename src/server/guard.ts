import "server-only";
import { redirect } from "next/navigation";
import type { Permission } from "@/lib/authz/permissions";
import { can, getSession, type Session } from "./session";

/**
 * Page guard. Unauthenticated → redirect to sign-in. Authenticated but lacking
 * the permission → null (page renders <AccessDenied/>). Data-access functions
 * ALSO enforce permissions, and PostgreSQL RLS enforces them a third time.
 */
export async function guard(permission: Permission): Promise<Session | null> {
  const session = await getSession();
  if (!session) redirect("/login");
  return can(session, permission) ? session : null;
}
