"use client";

/** Generic error UI: never shows stack traces, messages or record details (no PHI leakage). */
export default function WorkspaceError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <div role="alert" className="mx-auto mt-16 max-w-md rounded-[10px] border border-line bg-surface p-6 text-center">
      <h1 className="text-[18px] font-semibold">Something went wrong</h1>
      <p className="mt-2 text-[13px] text-ink-2">
        This screen could not be loaded. No changes were saved. If it keeps happening, report the time to the system administrator.
      </p>
      <button type="button" onClick={reset} className="mt-4 min-h-9 rounded-[7px] border border-line px-3 text-[13px] font-medium hover:bg-hover">
        Try again
      </button>
    </div>
  );
}
