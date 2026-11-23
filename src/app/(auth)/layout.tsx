import type { ReactNode } from "react";

export default function AuthLayout({ children }: { children: ReactNode }) {
  const nonClinical = !["lan", "cloud"].includes(process.env.PUIMS_DEPLOYMENT_PROFILE ?? "development");
  return (
    <div className="flex min-h-dvh flex-col">
      {nonClinical && (
        <div className="border-b border-[#f0dfbf] bg-warning-soft px-4 py-1.5 text-center text-[11px] font-medium text-warning" role="note">
          Development environment · synthetic data only · not for clinical use
        </div>
      )}
      <main id="main" className="flex flex-1 items-start justify-center px-4 pb-10 pt-[10vh]">
        <div className="w-full max-w-sm">
          <div className="mb-6 flex items-center gap-2.5">
            <span aria-hidden="true" className="grid h-9 w-9 place-items-center rounded-[9px] bg-accent-soft text-[14px] font-extrabold text-accent-ink">
              P+
            </span>
            <span>
              <span className="block text-[15px] font-semibold leading-tight">PUIMS</span>
              <span className="block text-[12px] text-ink-3">Pulmonary Unit</span>
            </span>
          </div>
          {children}
          <p className="mt-6 text-[11px] text-ink-3">Individual accounts only. Never share your password. All access is audited.</p>
        </div>
      </main>
    </div>
  );
}
