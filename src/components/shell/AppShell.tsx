import type { ReactNode } from "react";
import { roleHas } from "@/lib/authz/permissions";
import { NAV_GROUPS } from "@/lib/nav";
import { SHIFT_DEFINITIONS, classifyInstant } from "@/lib/time/shifts";
import { getNow } from "@/server/clock";
import { getSettings } from "@/server/data";
import { getAlerts } from "@/server/workspace";
import type { Session } from "@/server/session";
import { CommandPalette } from "./CommandPalette";
import { IdleWatcher } from "./IdleWatcher";
import { ConnectivityProvider } from "./Connectivity";
import { ServiceWorkerRegistration } from "./ServiceWorkerRegistration";
import { ShellUiProvider } from "./ShellUi";
import { MobileBottomNav, Sidebar } from "./Sidebar";
import { OfflineBanner } from "./SyncStatus";
import { Topbar } from "./Topbar";

/**
 * Navigation is filtered by role for convenience only. Each destination is
 * independently permission-checked on the server.
 */
export async function AppShell({ session, children }: { session: Session; children: ReactNode }) {
  const groups = NAV_GROUPS.map((g) => ({ ...g, items: g.items.filter((i) => roleHas(session.role, i.permission)) })).filter((g) => g.items.length);
  const [notifications, settings] = await Promise.all([getAlerts(session).catch(() => []), getSettings()]);
  const shift = SHIFT_DEFINITIONS[classifyInstant(getNow()).shift];
  const idleMinutes = settings.find((x) => x.key === "session.idle_minutes")?.value ?? 15;
  const nonClinical = !["lan", "cloud"].includes(process.env.PUIMS_DEPLOYMENT_PROFILE ?? "development");
  return (
    <ConnectivityProvider>
      <ShellUiProvider>
        <a href="#main" className="sr-only z-[70] rounded bg-surface px-3 py-2 focus:not-sr-only focus:fixed focus:left-3 focus:top-3">
          Skip to content
        </a>
        <div className="flex min-h-dvh">
          <Sidebar groups={groups} nonClinical={nonClinical} />
          <div className="flex min-w-0 flex-1 flex-col">
            {nonClinical && (
              <div className="no-print border-b border-[#f0dfbf] bg-warning-soft px-4 py-1.5 text-center text-[11px] font-medium text-warning" role="note">
                Development environment · synthetic data only · not for clinical use
              </div>
            )}
            <Topbar
              user={{ name: session.displayName, initials: session.initials, role: session.role, username: session.username }}
              notifications={notifications}
              shiftLabel={`${shift.label} · ${shift.rangeLabel}`}
            />
            <OfflineBanner />
            <main id="main" tabIndex={-1} className="mx-auto w-full max-w-[1400px] flex-1 px-4 pb-24 pt-6 outline-none md:px-8 md:pb-12">
              {children}
            </main>
          </div>
        </div>
        <MobileBottomNav groups={groups} />
        <CommandPalette modules={groups.flatMap((g) => g.items)} />
        <ServiceWorkerRegistration />
        <IdleWatcher idleMinutes={idleMinutes} />
      </ShellUiProvider>
    </ConnectivityProvider>
  );
}
