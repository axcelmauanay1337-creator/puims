"use client";

import { usePathname } from "next/navigation";
import { Icon } from "@/components/ui/Icon";
import type { Role } from "@/lib/clinical/vocabulary";
import { ALL_NAV_ITEMS, isActive } from "@/lib/nav";
import { SearchButton } from "./CommandPalette";
import { NotificationsMenu, UserMenu, type NotificationPreview } from "./Menus";
import { useShellUi } from "./ShellUi";
import { SyncIndicator } from "./SyncStatus";

export function Topbar({
  user,
  notifications,
  shiftLabel,
}: {
  user: { name: string; initials: string; role: Role; username: string };
  notifications: NotificationPreview[];
  shiftLabel?: string;
}) {
  const pathname = usePathname();
  const { setDrawerOpen } = useShellUi();
  const section = [...ALL_NAV_ITEMS].sort((a, b) => b.href.length - a.href.length).find((i) => isActive(pathname, i.href));
  return (
    <header className="no-print sticky top-0 z-30 flex h-14 items-center gap-2 border-b border-line bg-[rgba(255,255,255,0.86)] px-3 backdrop-blur md:px-6">
      <button
        type="button"
        onClick={() => setDrawerOpen(true)}
        className="grid h-10 w-10 place-items-center rounded-[var(--radius-control)] hover:bg-hover md:hidden"
        aria-label="Open navigation"
      >
        <Icon name="menu" />
      </button>
      <p className="hidden min-w-0 truncate text-[12px] text-ink-3 lg:block">
        Pulmonary Unit <span aria-hidden="true">/</span> <span className="font-semibold text-ink">{section?.label ?? "Workspace"}</span>
      </p>
      {shiftLabel ? (
        <span className="ml-2 hidden rounded-full bg-success-soft px-3 py-1 text-[12px] font-semibold text-success sm:inline">{shiftLabel}</span>
      ) : null}
      <div className="ml-auto flex items-center gap-1.5 sm:gap-2">
        <SearchButton />
        <SyncIndicator />
        <NotificationsMenu items={notifications} />
        <UserMenu name={user.name} initials={user.initials} role={user.role} username={user.username} />
      </div>
    </header>
  );
}
