/**
 * Role → permission matrix. Pure and isomorphic so it can be unit-tested and
 * used by the UI to hide links — but the UI is NEVER the enforcement point.
 * Every server page, route handler and (from Milestone 2) database RLS policy
 * enforces the same permissions independently.
 */
import type { Role } from "@/lib/clinical/vocabulary";

export const PERMISSIONS = [
  "patients:read",
  "patients:write",
  "clinical:read",
  "clinical:document",
  "orders:enter",
  "diagnostics:schedule",
  "handover:write",
  "shifts:read",
  "shifts:manage",
  "activity:read-own",
  "activity:read-all",
  "reports:unit",
  "reports:export",
  "staff:manage",
  "import:manage",
  "audit:read",
  "settings:read",
  "settings:manage",
  "devices:read-own",
  "devices:manage",
  "notifications:read",
] as const;

export type Permission = (typeof PERMISSIONS)[number];

const RT: Permission[] = [
  "patients:read",
  "patients:write",
  "clinical:read",
  "clinical:document",
  "orders:enter",
  "diagnostics:schedule",
  "handover:write",
  "shifts:read",
  "activity:read-own",
  "settings:read",
  "devices:read-own",
  "notifications:read",
];

// Decision 2026-11-22: ONLY Respiratory Therapists enter nebulization orders — not the Chief RT.
const CHIEF: Permission[] = [
  ...RT.filter((p) => p !== "orders:enter"),
  "shifts:manage",
  "activity:read-all",
  "reports:unit",
  "reports:export",
  "staff:manage",
  "import:manage",
  "audit:read",
  "settings:manage",
  "devices:manage",
];

export const ROLE_PERMISSIONS: Record<Role, ReadonlySet<Permission>> = {
  RESPIRATORY_THERAPIST: new Set(RT),
  CHIEF_RT_ADMIN: new Set(CHIEF),
};

export function roleHas(role: Role, permission: Permission): boolean {
  return ROLE_PERMISSIONS[role]?.has(permission) ?? false;
}
