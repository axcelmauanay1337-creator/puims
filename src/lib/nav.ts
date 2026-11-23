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

/** Information architecture from PRODUCT_REQUIREMENTS.md §2 (+ tubing tracker, master prompt module 8). */
export const NAV_GROUPS: NavGroup[] = [
  {
    label: "Workspace",
    items: [
      { href: "/", label: "Overview", icon: "overview", permission: "clinical:read", keywords: "dashboard command center home" },
      { href: "/patients", label: "Patient Masterlist", icon: "patients", permission: "patients:read", keywords: "patient search mrn hospital number" },
      { href: "/activities", label: "RT Daily Activities", icon: "activity", permission: "activity:read-own", keywords: "activity log workload" },
      { href: "/handover", label: "Shift Handover", icon: "handover", permission: "shifts:read", keywords: "endorsement handoff acknowledge" },
    ],
  },
  {
    label: "Clinical services",
    items: [
      { href: "/nebulization", label: "Nebulization", icon: "nebulization", permission: "clinical:read", keywords: "neb treatment medication administration" },
      { href: "/ventilation", label: "Mechanical Ventilation", icon: "ventilation", permission: "clinical:read", keywords: "ventilator hook-in disconnection" },
      { href: "/tubing", label: "Change of Tubing", icon: "tubing", permission: "clinical:read", keywords: "change of tubing circuit replacement due overdue" },
    ],
  },
  {
    label: "Diagnostics",
    items: [
      { href: "/diagnostics/pft", label: "PFT Scheduling", icon: "pft", permission: "clinical:read", keywords: "pulmonary function test spirometry" },
      { href: "/diagnostics/abg", label: "ABG", icon: "abg", permission: "clinical:read", keywords: "arterial blood gas" },
      { href: "/diagnostics/sputum", label: "Sputum Induction", icon: "sputum", permission: "clinical:read", keywords: "sputum" },
    ],
  },
  {
    label: "Management",
    items: [
      { href: "/shifts", label: "Shift Management", icon: "shifts", permission: "shifts:read", keywords: "roster schedule assignment" },
      { href: "/staff", label: "RT Staff", icon: "staff", permission: "staff:manage", keywords: "users accounts invite deactivate" },
      { href: "/reports", label: "Reports & Analytics", icon: "reports", permission: "reports:unit", keywords: "census trends monthly" },
      { href: "/import", label: "Import Center", icon: "import", permission: "import:manage", keywords: "legacy workbook spreadsheet" },
    ],
  },
  {
    label: "System",
    items: [
      { href: "/notifications", label: "Notifications", icon: "bell", permission: "notifications:read", keywords: "alerts reminders" },
      { href: "/audit", label: "Audit Logs", icon: "audit", permission: "audit:read", keywords: "history trail" },
      { href: "/settings", label: "Settings", icon: "settings", permission: "settings:read", keywords: "configuration tubing interval" },
      { href: "/devices", label: "Devices & Sync", icon: "devices", permission: "devices:read-own", keywords: "offline sync device revoke" },
    ],
  },
];

export const ALL_NAV_ITEMS = NAV_GROUPS.flatMap((g) => g.items);

export function isActive(pathname: string, href: string): boolean {
  if (href === "/") return pathname === "/";
  return pathname === href || pathname.startsWith(`${href}/`);
}
