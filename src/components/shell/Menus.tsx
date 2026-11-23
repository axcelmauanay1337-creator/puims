"use client";

import Link from "next/link";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { logoutAction } from "@/app/actions/auth";
import { Icon } from "@/components/ui/Icon";
import { ROLE_LABELS, type Role } from "@/lib/clinical/vocabulary";

function usePopover() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false);
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);
  return { open, setOpen, ref };
}

function Popover({ label, children, panel, width = "w-80" }: { label: string; children: ReactNode; panel: (close: () => void) => ReactNode; width?: string }) {
  const { open, setOpen, ref } = usePopover();
  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        aria-label={label}
        aria-expanded={open}
        aria-haspopup="true"
        onClick={() => setOpen((o) => !o)}
        className="relative grid min-h-9 min-w-9 place-items-center rounded-[var(--radius-control)] hover:bg-hover"
      >
        {children}
      </button>
      {open && (
        <div className={`absolute right-0 z-40 mt-2 ${width} max-w-[calc(100vw-1.5rem)] rounded-[var(--radius-card)] border border-line bg-surface shadow-lg`}>
          {panel(() => setOpen(false))}
        </div>
      )}
    </div>
  );
}

export interface NotificationPreview {
  id: string;
  severity: "danger" | "warning" | "info";
  title: string;
  detail: string;
  href: string;
}

const SEV: Record<NotificationPreview["severity"], { glyph: string; cls: string; label: string }> = {
  danger: { glyph: "‼", cls: "text-danger", label: "Urgent" },
  warning: { glyph: "!", cls: "text-warning", label: "Attention" },
  info: { glyph: "i", cls: "text-info", label: "Info" },
};

export function NotificationsMenu({ items }: { items: NotificationPreview[] }) {
  const urgent = items.filter((i) => i.severity !== "info").length;
  return (
    <Popover
      label={`Notifications, ${items.length} item${items.length === 1 ? "" : "s"}`}
      panel={(close) => (
        <div>
          <p className="border-b border-line px-4 py-2.5 text-[13px] font-semibold">Needs attention</p>
          {items.length === 0 ? (
            <p className="px-4 py-6 text-center text-[12px] text-ink-3">Nothing needs attention right now.</p>
          ) : (
            <ul className="max-h-80 overflow-y-auto py-1">
              {items.slice(0, 8).map((n) => (
                <li key={n.id}>
                  <Link href={n.href} onClick={close} className="flex gap-2.5 px-4 py-2 hover:bg-hover">
                    <span aria-label={SEV[n.severity].label} className={`mt-0.5 w-3 text-center font-bold ${SEV[n.severity].cls}`}>
                      {SEV[n.severity].glyph}
                    </span>
                    <span className="min-w-0">
                      <span className="block text-[12px] font-medium">{n.title}</span>
                      <span className="block text-[11px] text-ink-3">{n.detail}</span>
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
          <Link href="/notifications" onClick={close} className="block border-t border-line px-4 py-2.5 text-[12px] font-medium text-accent-ink hover:bg-hover">
            View all notifications
          </Link>
        </div>
      )}
    >
      <Icon name="bell" size={17} />
      {urgent > 0 && (
        <span
          aria-hidden="true"
          className="absolute -right-0.5 -top-0.5 min-w-4 rounded-full bg-danger px-1 text-center text-[10px] font-bold leading-4 text-white"
        >
          {urgent > 9 ? "9+" : urgent}
        </span>
      )}
    </Popover>
  );
}

export function UserMenu({ name, initials, role, username }: { name: string; initials: string; role: Role; username: string }) {
  return (
    <Popover
      label={`Account: ${name}`}
      width="w-72"
      panel={(close) => (
        <div className="text-[12px]">
          <div className="border-b border-line px-4 py-3">
            <p className="text-[13px] font-semibold">{name}</p>
            <p className="text-ink-3">
              {ROLE_LABELS[role]} · {username}
            </p>
          </div>
          <ul className="py-1">
            <li>
              <Link href="/devices" onClick={close} className="block px-4 py-2 hover:bg-hover">
                My devices & sync status
              </Link>
            </li>
            <li>
              <Link href="/activities" onClick={close} className="block px-4 py-2 hover:bg-hover">
                My activity
              </Link>
            </li>
            <li>
              <Link href="/settings" onClick={close} className="block px-4 py-2 hover:bg-hover">
                Settings
              </Link>
            </li>
          </ul>
          <form action={logoutAction} className="border-t border-line px-4 py-3">
            <button type="submit" className="min-h-8 w-full rounded-[var(--radius-control)] border border-line px-2 text-left font-medium hover:bg-hover">
              Sign out
            </button>
          </form>
        </div>
      )}
    >
      <span aria-hidden="true" className="grid h-7 w-7 place-items-center rounded-full bg-accent-soft text-[11px] font-bold text-accent-ink">
        {initials}
      </span>
    </Popover>
  );
}
