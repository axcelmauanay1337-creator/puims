"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { reauthAction } from "@/app/actions/auth";
import type { AdminResult } from "@/app/actions/admin";

/**
 * Runs an admin server action. If the server answers "re-authentication
 * required", shows a password dialog, then retries once.
 */
export function useSensitiveAction() {
  const [dialog, setDialog] = useState<null | { resolve: (ok: boolean) => void }>(null);
  const [busy, setBusy] = useState(false);

  const run = useCallback(async (fn: () => Promise<AdminResult>): Promise<AdminResult> => {
    setBusy(true);
    try {
      let r = await fn();
      if (!r.ok && r.reauth) {
        const confirmed = await new Promise<boolean>((resolve) => setDialog({ resolve }));
        setDialog(null);
        if (!confirmed) return { ok: false, error: "Cancelled. Nothing was changed." };
        r = await fn();
      }
      return r;
    } catch {
      return { ok: false, error: "Could not reach the server. Nothing was changed." };
    } finally {
      setBusy(false);
    }
  }, []);

  const element = dialog ? <ReauthDialog onDone={(ok) => dialog.resolve(ok)} /> : null;
  return { run, busy, element };
}

function ReauthDialog({ onDone }: { onDone: (ok: boolean) => void }) {
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const first = useRef<HTMLInputElement>(null);
  useEffect(() => {
    first.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onDone(false);
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onDone]);
  return (
    <div className="fixed inset-0 z-[80] flex items-center justify-center bg-[#161a1680] p-4">
      <form
        role="dialog"
        aria-modal="true"
        aria-labelledby="reauth-h"
        className="w-full max-w-sm rounded-[12px] border border-line bg-surface p-5 shadow-2xl"
        onSubmit={async (e) => {
          e.preventDefault();
          const f = new FormData(e.currentTarget);
          setPending(true);
          setError(null);
          const r = await reauthAction(String(f.get("password"))).catch(() => ({ ok: false, error: "Could not reach the server." }));
          setPending(false);
          if (r.ok) onDone(true);
          else setError(r.error ?? "Not accepted.");
        }}
      >
        <h2 id="reauth-h" className="text-[16px] font-semibold">
          Confirm it&apos;s you
        </h2>
        <p className="mt-1 text-[12px] text-ink-2">This is a sensitive action. Enter your password again.</p>
        <label className="mt-3 block text-[12px] font-medium text-ink-2">
          Password
          <input
            ref={first}
            name="password"
            type="password"
            autoComplete="current-password"
            required
            className="mt-1 block min-h-10 w-full rounded-[7px] border border-line px-3 text-[14px]"
          />
        </label>
        {error && (
          <p role="alert" className="mt-2 text-[12px] text-danger">
            {error}
          </p>
        )}
        <div className="mt-4 flex justify-end gap-2">
          <button type="button" onClick={() => onDone(false)} className="min-h-9 rounded-[7px] border border-line px-3 text-[13px] hover:bg-hover">
            Cancel
          </button>
          <button
            type="submit"
            disabled={pending}
            className="min-h-9 rounded-[7px] border border-accent bg-accent px-3 text-[13px] font-semibold text-white hover:bg-accent-hover disabled:opacity-60"
          >
            {pending ? "Checking…" : "Confirm"}
          </button>
        </div>
      </form>
    </div>
  );
}

export function ResultNote({ result }: { result: AdminResult | null }) {
  if (!result) return null;
  return result.ok ? (
    <p role="status" className="text-[12px] text-success">
      ✓ {result.message}
    </p>
  ) : (
    <p role="alert" className="text-[12px] text-danger">
      {result.error}
    </p>
  );
}
