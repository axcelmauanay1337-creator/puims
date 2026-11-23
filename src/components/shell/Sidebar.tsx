"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef } from "react";
import { Icon } from "@/components/ui/Icon";
import { isActive, type NavGroup } from "@/lib/nav";
import { useShellUi } from "./ShellUi";

function NavList({ groups, compact, onNavigate }: { groups: NavGroup[]; compact: boolean; onNavigate?: () => void }) {
  const pathname = usePathname();
  return (
    <nav aria-label="Main" className="flex-1 overflow-y-auto px-2 pb-4">
      {groups.map((g) => (
        <div key={g.label} className="mt-3 first:mt-0">
          <p className={`px-2.5 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-[0.09em] text-ink-3 ${compact ? "sr-only" : ""}`}>{g.label}</p>
          <ul>
            {g.items.map((item) => {
              const active = isActive(pathname, item.href);
              return (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    onClick={onNavigate}
                    aria-current={active ? "page" : undefined}
                    title={compact ? item.label : undefined}
                    className={`my-px flex min-h-9 items-center gap-2.5 rounded-[var(--radius-control)] px-2.5 text-[13px] ${compact ? "justify-center" : ""} ${
                      active ? "bg-hover font-medium text-ink" : "text-ink-2 hover:bg-hover hover:text-ink"
                    }`}
                  >
                    <Icon name={item.icon} size={16} className={active ? "text-accent" : "text-ink-3"} />
                    <span className={compact ? "sr-only" : ""}>{item.label}</span>
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </nav>
  );
}

function Brand({ compact }: { compact: boolean }) {
  return (
    <Link href="/" className={`flex items-center gap-2.5 px-4 pb-4 pt-5 ${compact ? "justify-center px-0" : ""}`}>
      <span aria-hidden="true" className="grid h-8 w-8 place-items-center rounded-[9px] bg-accent-soft text-[13px] font-extrabold text-accent-ink">
        P+
      </span>
      <span className={compact ? "sr-only" : ""}>
        <span className="block text-[14px] font-semibold leading-tight">PUIMS</span>
        <span className="block text-[11px] text-ink-3">Pulmonary Unit</span>
      </span>
    </Link>
  );
}

/** Desktop: full sidebar. Tablet: icon rail. Phone: hidden (drawer below). */
export function Sidebar({ groups }: { groups: NavGroup[] }) {
  return (
    <>
      <aside className="no-print sticky top-0 hidden h-dvh w-16 shrink-0 flex-col border-r border-line bg-sidebar md:flex lg:hidden" aria-label="Sidebar">
        <Brand compact />
        <NavList groups={groups} compact />
      </aside>
      <aside className="no-print sticky top-0 hidden h-dvh w-[248px] shrink-0 flex-col border-r border-line bg-sidebar lg:flex" aria-label="Sidebar">
        <Brand compact={false} />
        <div className="mx-3 mb-3 rounded-[var(--radius-control)] bg-[#f3f4f1] px-3 py-2 text-[12px] text-ink-2">
          <b className="block text-ink">Clinical workspace</b>
          Respiratory Therapy
        </div>
        <NavList groups={groups} compact={false} />
        <p className="border-t border-line px-4 py-3 text-[11px] text-ink-3">Not validated for clinical use · Synthetic data</p>
      </aside>
      <MobileDrawer groups={groups} />
    </>
  );
}

function MobileDrawer({ groups }: { groups: NavGroup[] }) {
  const { drawerOpen, setDrawerOpen } = useShellUi();
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!drawerOpen) return;
    const prev = document.activeElement as HTMLElement | null;
    panelRef.current?.querySelector<HTMLElement>("a,button")?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setDrawerOpen(false);
    };
    document.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = "";
      prev?.focus?.();
    };
  }, [drawerOpen, setDrawerOpen]);

  if (!drawerOpen) return null;
  return (
    <div className="fixed inset-0 z-50 md:hidden">
      <button type="button" aria-label="Close navigation" className="absolute inset-0 bg-[#161a1680]" onClick={() => setDrawerOpen(false)} />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label="Navigation"
        className="absolute inset-y-0 left-0 flex w-[min(19rem,85vw)] flex-col bg-sidebar shadow-xl"
      >
        <div className="flex items-center justify-between pr-2">
          <Brand compact={false} />
          <button
            type="button"
            onClick={() => setDrawerOpen(false)}
            className="grid h-10 w-10 place-items-center rounded-[var(--radius-control)] hover:bg-hover"
            aria-label="Close navigation"
          >
            <Icon name="close" />
          </button>
        </div>
        <NavList groups={groups} compact={false} onNavigate={() => setDrawerOpen(false)} />
      </div>
    </div>
  );
}

/** Phone bottom navigation: four primary destinations + "More" (opens drawer). */
export function MobileBottomNav({ groups }: { groups: NavGroup[] }) {
  const pathname = usePathname();
  const { setDrawerOpen } = useShellUi();
  const allowed = new Set(groups.flatMap((g) => g.items.map((i) => i.href)));
  const primary = [
    { href: "/", label: "Overview", icon: "overview" },
    { href: "/patients", label: "Patients", icon: "patients" },
    { href: "/nebulization", label: "Neb", icon: "nebulization" },
    { href: "/handover", label: "Handover", icon: "handover" },
  ].filter((p) => allowed.has(p.href));
  return (
    <nav
      aria-label="Primary (mobile)"
      className="no-print fixed inset-x-0 bottom-0 z-30 border-t border-line bg-surface pb-[env(safe-area-inset-bottom)] md:hidden"
    >
      <ul className="grid grid-cols-5">
        {primary.map((p) => {
          const active = isActive(pathname, p.href);
          return (
            <li key={p.href}>
              <Link
                href={p.href}
                aria-current={active ? "page" : undefined}
                className={`flex min-h-14 flex-col items-center justify-center gap-0.5 text-[11px] ${active ? "font-semibold text-accent-ink" : "text-ink-2"}`}
              >
                <Icon name={p.icon} size={18} />
                {p.label}
              </Link>
            </li>
          );
        })}
        <li>
          <button
            type="button"
            onClick={() => setDrawerOpen(true)}
            className="flex min-h-14 w-full flex-col items-center justify-center gap-0.5 text-[11px] text-ink-2"
          >
            <Icon name="more" size={18} />
            More
          </button>
        </li>
      </ul>
    </nav>
  );
}
