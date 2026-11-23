import type { Permission } from "@/lib/authz/permissions";

export interface NavItem {
  href: string;
  label: string;
  icon: string;
  permission: Permission;
  keywords?: string;
}

export interface NavGroup {
  label: string;
  items: NavItem[];
}

/** Redesigned workspace (2026-11-23): eight primary destinations, everything else under "More". */
export const NAV_GROUPS: NavGroup[] = [
  {
    label: "Workspace",
    items: [
      { href: "/", label: "Today", icon: "today", permission: "clinical:read", keywords: "tasks due overview home dashboard" },
      { href: "/patients", label: "Patients", icon: "patients", permission: "patients:read", keywords: "patient master search hospital number precautions" },
      {
        href: "/nebulization",
        label: "Nebs",
        icon: "nebulization",
        permission: "clinical:read",
        keywords: "nebulization neb treatment medication orders doses",
      },
      { href: "/ventilation", label: "Vents / NIV", icon: "ventilation", permission: "clinical:read", keywords: "ventilator hook-in hfnc bipap cpap niv" },
      { href: "/schedule", label: "Schedule", icon: "schedule", permission: "clinical:read", keywords: "pft abg sputum appointments booking" },
      { href: "/handover", label: "Handover", icon: "handover", permission: "shifts:read", keywords: "endorsement handoff acknowledge" },
      { href: "/equipment", label: "Equipment", icon: "equipment", permission: "clinical:read", keywords: "machines ventilator hfnc bipap rental maintenance" },
      { href: "/trends", label: "Trends", icon: "trends", permission: "clinical:read", keywords: "census monthly busiest" },
    ],
  },
  {
    label: "More",
    items: [
      { href: "/tubing", label: "Change of tubing", icon: "tubing", permission: "clinical:read", keywords: "circuit replacement due overdue" },
      { href: "/diagnostics/pft", label: "PFT calendar", icon: "pft", permission: "clinical:read", keywords: "pulmonary function test spirometry" },
      { href: "/diagnostics/abg", label: "ABG", icon: "abg", permission: "clinical:read", keywords: "arterial blood gas" },
      { href: "/diagnostics/sputum", label: "Sputum induction", icon: "sputum", permission: "clinical:read", keywords: "sputum" },
      { href: "/shifts", label: "Roster", icon: "shifts", permission: "shifts:read", keywords: "shift schedule assignment" },
      { href: "/activities", label: "My activity", icon: "activity", permission: "activity:read-own", keywords: "activity log workload" },
      { href: "/notifications", label: "Alerts", icon: "bell", permission: "notifications:read", keywords: "alerts reminders overdue" },
    ],
  },
  {
    label: "Admin & settings",
    items: [
      { href: "/charges", label: "Charges", icon: "charges", permission: "reports:unit", keywords: "billing machine rental" },
      { href: "/reports", label: "Reports", icon: "reports", permission: "reports:unit", keywords: "census trends export" },
      { href: "/staff", label: "RT Staff", icon: "staff", permission: "staff:manage", keywords: "users accounts invite deactivate" },
      { href: "/import", label: "Import workbook", icon: "import", permission: "import:manage", keywords: "legacy workbook spreadsheet" },
      { href: "/audit", label: "Audit log", icon: "audit", permission: "audit:read", keywords: "history trail" },
      { href: "/settings", label: "Settings", icon: "settings", permission: "settings:read", keywords: "configuration tubing interval prices" },
      { href: "/devices", label: "Devices & Sync", icon: "devices", permission: "devices:read-own", keywords: "offline sync device revoke" },
    ],
  },
];

export const ALL_NAV_ITEMS = NAV_GROUPS.flatMap((g) => g.items);

export function isActive(pathname: string, href: string): boolean {
  if (href === "/") return pathname === "/";
  return pathname === href || pathname.startsWith(`${href}/`);
}
