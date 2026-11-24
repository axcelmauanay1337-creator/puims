"use client";

import { useState } from "react";
import { deactivateAction, inviteAction, resetAccessAction, type AdminResult } from "@/app/actions/admin";
import { Badge, StatusBadge } from "@/components/ui/primitives";
import { formatDateTime } from "@/lib/time/zoned";
import { ResultNote, useSensitiveAction } from "./useSensitiveAction";

export interface StaffRowView {
  id: string;
  username: string;
  displayName: string;
  role: string;
  accountStatus: string;
  lastActiveAt: string | null;
  activeSessions: number;
}

function LinkBox({ link }: { link: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="mt-2 rounded-[var(--radius-control)] border border-[#f0dfbf] bg-warning-soft p-3 text-[12px]" data-testid="activation-link">
      <p className="font-semibold text-warning">One-time activation link — shown only now, valid 72 hours</p>
      <code className="mt-1 block break-all rounded bg-surface px-2 py-1 text-[12px] text-ink">{link}</code>
      <button
        type="button"
        onClick={() =>
          navigator.clipboard
            ?.writeText(link)
            .then(() => setCopied(true))
            .catch(() => {})
        }
        className="mt-2 min-h-8 rounded-[7px] border border-line bg-surface px-2.5 font-medium hover:bg-hover"
      >
        {copied ? "Copied" : "Copy link"}
      </button>
      <p className="mt-1 text-ink-2">Do not send it by public chat or email. Anyone with the link can claim the account until it is used.</p>
    </div>
  );
}

export function StaffAdmin({ rows, selfId }: { rows: StaffRowView[]; selfId: string }) {
  const { run, busy, element } = useSensitiveAction();
  const [result, setResult] = useState<AdminResult | null>(null);
  const [rowResult, setRowResult] = useState<{ id: string; r: AdminResult } | null>(null);

  return (
    <>
      {element}
      <section aria-labelledby="invite-h" className="mb-5 rounded-[var(--radius-card)] border border-line bg-surface p-4">
        <h2 id="invite-h" className="text-[13px] font-semibold">
          Invite a Respiratory Therapist
        </h2>
        <p className="mt-0.5 text-[12px] text-ink-3">Creates an individual RT account. The RT sets their own password from the activation link.</p>
        <form
          className="mt-3 flex flex-wrap items-end gap-3"
          onSubmit={async (e) => {
            e.preventDefault();
            const f = new FormData(e.currentTarget);
            const form = e.currentTarget;
            const r = await run(() => inviteAction(String(f.get("username")), String(f.get("displayName"))));
            setResult(r);
            if (r.ok) form.reset();
          }}
        >
          <label className="text-[12px] font-medium text-ink-2">
            Username
            <input
              name="username"
              required
              pattern="[a-z0-9][a-z0-9._\-]{2,39}"
              maxLength={40}
              autoComplete="off"
              spellCheck={false}
              placeholder="e.g. jcruz"
              className="mt-1 block min-h-9 w-48 rounded-[7px] border border-line px-2 text-[13px]"
            />
          </label>
          <label className="text-[12px] font-medium text-ink-2">
            Display name
            <input
              name="displayName"
              required
              maxLength={80}
              autoComplete="off"
              className="mt-1 block min-h-9 w-64 rounded-[7px] border border-line px-2 text-[13px]"
            />
          </label>
          <button
            type="submit"
            disabled={busy}
            className="min-h-9 rounded-[7px] border border-accent bg-accent px-3 text-[13px] font-semibold text-white hover:bg-accent-hover disabled:opacity-60"
          >
            Create account
          </button>
        </form>
        <div className="mt-2">
          <ResultNote result={result} />
          {result?.ok && result.link ? <LinkBox link={result.link} /> : null}
        </div>
      </section>

      <div className="overflow-x-auto rounded-[var(--radius-card)] border border-line bg-surface" tabIndex={0} role="region" aria-label="Staff accounts">
        <table className="w-full min-w-[760px] text-[13px]">
          <caption className="sr-only">Staff accounts</caption>
          <thead>
            <tr className="border-b border-line text-left text-[11px] uppercase tracking-[0.04em] text-ink-3">
              <th scope="col" className="px-3 py-2 font-semibold">
                Name
              </th>
              <th scope="col" className="px-3 py-2 font-semibold">
                Role
              </th>
              <th scope="col" className="px-3 py-2 font-semibold">
                Account
              </th>
              <th scope="col" className="px-3 py-2 font-semibold">
                Last sign-in
              </th>
              <th scope="col" className="px-3 py-2 font-semibold">
                Active sessions
              </th>
              <th scope="col" className="px-3 py-2 font-semibold">
                Actions
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((s) => {
              const isRt = s.role === "RESPIRATORY_THERAPIST" && s.id !== selfId;
              return (
                <tr key={s.id} className="border-b border-line-soft align-top last:border-0" data-testid={`staff-${s.username}`}>
                  <th scope="row" className="px-3 py-2.5 text-left font-medium">
                    {s.displayName}
                    <span className="block text-[11px] font-normal text-ink-3">{s.username}</span>
                  </th>
                  <td className="px-3 py-2.5">
                    {s.role === "CHIEF_RT_ADMIN" ? <Badge tone="success">Chief RT (admin)</Badge> : <Badge>Respiratory Therapist</Badge>}
                  </td>
                  <td className="px-3 py-2.5">
                    <StatusBadge status={s.accountStatus} />
                  </td>
                  <td className="tabular px-3 py-2.5">
                    {s.lastActiveAt ? formatDateTime(new Date(s.lastActiveAt)) : <span className="text-ink-3">Never</span>}
                  </td>
                  <td className="tabular px-3 py-2.5">{s.activeSessions}</td>
                  <td className="px-3 py-2.5">
                    {isRt ? (
                      <div className="flex flex-wrap gap-1.5">
                        <button
                          type="button"
                          disabled={busy}
                          onClick={async () => {
                            if (s.accountStatus !== "INVITED" && !confirm(`Reset access for ${s.displayName}? Their password is cleared and all sessions end.`))
                              return;
                            setRowResult({ id: s.id, r: await run(() => resetAccessAction(s.id)) });
                          }}
                          className="min-h-8 rounded-[7px] border border-line px-2 text-[12px] hover:bg-hover"
                        >
                          {s.accountStatus === "DEACTIVATED" ? "Reinstate (new link)" : s.accountStatus === "INVITED" ? "Get activation link" : "Reset access"}
                        </button>
                        {s.accountStatus !== "DEACTIVATED" && (
                          <button
                            type="button"
                            disabled={busy}
                            onClick={async () => {
                              if (!confirm(`Deactivate ${s.displayName}? They lose all access immediately.`)) return;
                              setRowResult({ id: s.id, r: await run(() => deactivateAction(s.id)) });
                            }}
                            className="min-h-8 rounded-[7px] border border-[#f0d0cc] px-2 text-[12px] text-danger hover:bg-danger-soft"
                          >
                            Deactivate
                          </button>
                        )}
                      </div>
                    ) : (
                      <span className="text-[12px] text-ink-3">—</span>
                    )}
                    {rowResult?.id === s.id && (
                      <div className="mt-1 max-w-sm">
                        <ResultNote result={rowResult.r} />
                        {rowResult.r.ok && rowResult.r.link ? <LinkBox link={rowResult.r.link} /> : null}
                      </div>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
}
