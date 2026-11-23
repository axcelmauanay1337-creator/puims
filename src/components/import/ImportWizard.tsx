"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import type { AdminResult } from "@/app/actions/admin";
import {
  bulkAcceptAction,
  candidatesAction,
  commitAction,
  confirmOriginalDownloadAction,
  decideRowAction,
  discardImportAction,
  dryRunAction,
  mappingAction,
  optionsAction,
  reverseImportAction,
} from "@/app/actions/diagnostics";
import { ResultNote, useSensitiveAction } from "@/components/admin/useSensitiveAction";
import { FormError, inputCls, labelCls } from "@/components/clinical/fields";
import { Modal } from "@/components/ui/Modal";
import { Badge } from "@/components/ui/primitives";
import { FIELD_LABELS, FLAG_INFO, IMPORT_FIELDS, type ImportFlag, type ImportOptions, type ResolvableField } from "@/lib/import/parse";
import type { DryRun, ImportRowView, SheetMeta } from "@/server/importer";

const btn = "inline-flex min-h-10 items-center rounded-[7px] border border-line bg-surface px-3 text-[13px] font-medium hover:bg-hover disabled:opacity-60";
const btnPrimary =
  "inline-flex min-h-10 items-center rounded-[7px] border border-accent bg-accent px-4 text-[13px] font-semibold text-white hover:bg-accent-hover disabled:opacity-60";
const unreachable = { ok: false as const, error: "Could not reach the server. Nothing was changed." };

// ---------------------------------------------------------------- upload

export function UploadWorkbook() {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [existing, setExisting] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  return (
    <form
      className="space-y-3"
      onSubmit={async (e) => {
        e.preventDefault();
        setPending(true);
        setError(null);
        setExisting(null);
        const fd = new FormData(e.currentTarget);
        try {
          const res = await fetch("/api/import/upload", { method: "POST", body: fd });
          // A hosting platform may refuse large uploads before PUIMS sees them (plain-text 413).
          const j = (await res.json().catch(() => ({ error: res.status === 413 ? "The file is too large for this server." : "Upload failed." }))) as {
            batchId?: string;
            error?: string;
            detail?: { id?: string };
          };
          if (res.ok && j.batchId) router.push(`/import/${j.batchId}`);
          else {
            setError(j.error ?? "The workbook could not be staged.");
            if (j.detail?.id) setExisting(j.detail.id);
          }
        } catch {
          setError("Could not reach the server. Nothing was saved.");
        } finally {
          setPending(false);
        }
      }}
    >
      <label className={labelCls}>
        Scheduling workbook (.xlsx)
        <input
          name="file"
          type="file"
          accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
          required
          className={`${inputCls} py-2`}
        />
      </label>
      <label className={labelCls}>
        Service
        <select name="service" className={inputCls} defaultValue="PFT">
          <option value="PFT">PFT</option>
          <option value="ABG">ABG</option>
          <option value="SPUTUM_INDUCTION">Sputum induction</option>
        </select>
      </label>
      <p className="text-[12px] text-ink-2">
        The file is read on this PUIMS server only — never stored as a file, never sent to any other service. Contact columns are dropped on upload (U-08).
        Nothing reaches patient records until you review every row and commit.
      </p>
      <FormError error={error} />
      {existing ? (
        <p className="text-[12px]">
          <Link href={`/import/${existing}`} className="text-accent-ink hover:underline">
            Open the existing batch →
          </Link>
        </p>
      ) : null}
      <button type="submit" className={btnPrimary} disabled={pending}>
        {pending ? "Reading workbook…" : "Stage for review"}
      </button>
    </form>
  );
}

// ---------------------------------------------------------------- declarations

export function OptionsForm({ batchId, options, disabled }: { batchId: string; options: ImportOptions; disabled: boolean }) {
  const router = useRouter();
  const [v, setV] = useState({
    dateOrder: options.dateOrder ?? "",
    workbookYear: options.workbookYear ? String(options.workbookYear) : "",
    times24h: options.times24h,
    categoryWhenMissing: options.categoryWhenMissing ?? "",
  });
  const [result, setResult] = useState<AdminResult | null>(null);
  const [pending, setPending] = useState(false);
  return (
    <form
      className="grid gap-3 sm:grid-cols-2"
      onSubmit={async (e) => {
        e.preventDefault();
        if (!confirm("Saving re-checks every row and resets all decisions to “pending”. Continue?")) return;
        setPending(true);
        const r = await optionsAction(batchId, v).catch(() => unreachable);
        setPending(false);
        setResult(r as AdminResult);
        if (r.ok) router.refresh();
      }}
    >
      <label className={labelCls}>
        Text dates like 6/3/2025 are written as…
        <select className={inputCls} value={v.dateOrder} onChange={(e) => setV({ ...v, dateOrder: e.target.value })} disabled={disabled}>
          <option value="">Not declared — flag every ambiguous date</option>
          <option value="MDY">Month / day / year</option>
          <option value="DMY">Day / month / year</option>
        </select>
      </label>
      <label className={labelCls}>
        Year this workbook covers <span className="font-normal text-ink-3">(used only for dates written without a year)</span>
        <input
          className={inputCls}
          inputMode="numeric"
          value={v.workbookYear}
          onChange={(e) => setV({ ...v, workbookYear: e.target.value })}
          placeholder="e.g. 2025"
          disabled={disabled}
        />
      </label>
      <label className="flex items-start gap-2 text-[13px]">
        <input type="checkbox" className="mt-1" checked={v.times24h} onChange={(e) => setV({ ...v, times24h: e.target.checked })} disabled={disabled} />
        <span>Times without AM/PM (e.g. 8:00) are 24-hour clock</span>
      </label>
      <label className={labelCls}>
        OPD/INP when the cell is empty
        <select className={inputCls} value={v.categoryWhenMissing} onChange={(e) => setV({ ...v, categoryWhenMissing: e.target.value })} disabled={disabled}>
          <option value="">Not declared — flag empty cells</option>
          <option value="OPD">OPD</option>
          <option value="INP">INP</option>
          <option value="OTHER">Other</option>
        </select>
      </label>
      <div className="sm:col-span-2">
        <p className="mb-2 text-[11px] text-ink-3">
          These are your declarations about the workbook, recorded in the audit log. A year that differs from the stated year is never changed — it is flagged.
        </p>
        <ResultNote result={result} />
        {!disabled ? (
          <button type="submit" className={`${btn} mt-1`} disabled={pending}>
            {pending ? "Re-checking…" : "Save declarations"}
          </button>
        ) : null}
      </div>
    </form>
  );
}

// ---------------------------------------------------------------- mapping

export function MappingEditor({ batchId, sheet, disabled }: { batchId: string; sheet: SheetMeta; disabled: boolean }) {
  const router = useRouter();
  const [map, setMap] = useState<Record<string, string>>(() => Object.fromEntries(sheet.headers.map((_, i) => [String(i), sheet.mapping[i] ?? "IGNORE"])));
  const [result, setResult] = useState<AdminResult | null>(null);
  const [pending, setPending] = useState(false);
  return (
    <form
      onSubmit={async (e) => {
        e.preventDefault();
        if (!confirm(`Save the mapping for ${sheet.name}? Its rows are re-checked and their decisions reset.`)) return;
        setPending(true);
        const r = await mappingAction(batchId, sheet.name, map).catch(() => unreachable);
        setPending(false);
        setResult(r as AdminResult);
        if (r.ok) router.refresh();
      }}
    >
      <p className="mb-2 text-[12px] text-ink-2">
        Header found on row {sheet.headerRow ?? "—"} · {sheet.rows} data row(s) · {sheet.blankRowsSkipped} blank row(s) skipped
        {sheet.truncated ? " · TRUNCATED: sheet exceeds the row limit" : ""}
      </p>
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
        {sheet.headers.map((h, i) => (
          <label key={i} className={labelCls}>
            <span className="font-mono">{h}</span>
            {sheet.inferredFromValues.includes(i) ? <Badge tone="warning">suggested from values — check</Badge> : null}
            <select className={inputCls} value={map[String(i)]} onChange={(e) => setMap({ ...map, [String(i)]: e.target.value })} disabled={disabled}>
              {IMPORT_FIELDS.map((f) => (
                <option key={f} value={f}>
                  {FIELD_LABELS[f]}
                </option>
              ))}
            </select>
          </label>
        ))}
      </div>
      <div className="mt-2">
        <ResultNote result={result} />
        {!disabled ? (
          <button type="submit" className={`${btn} mt-1`} disabled={pending}>
            {pending ? "Re-checking…" : `Save mapping for ${sheet.name}`}
          </button>
        ) : null}
      </div>
    </form>
  );
}

// ---------------------------------------------------------------- rows

function FlagList({ flags, blocking }: { flags: ImportFlag[]; blocking: ImportFlag[] }) {
  if (!flags.length) return <span className="text-[11px] text-success">✓ no flags</span>;
  return (
    <ul className="space-y-0.5">
      {flags.map((f) => (
        <li
          key={f}
          className={`text-[11px] ${blocking.includes(f) ? "font-semibold text-danger" : FLAG_INFO[f].blocking ? "text-ink-3 line-through" : "text-warning"}`}
        >
          {blocking.includes(f) ? "● " : FLAG_INFO[f].blocking ? "✓ " : "◆ "}
          {FLAG_INFO[f].label}
        </li>
      ))}
    </ul>
  );
}

export function RowTable({ rows, disabled }: { rows: ImportRowView[]; disabled: boolean }) {
  const [open, setOpen] = useState<ImportRowView | null>(null);
  return (
    <>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[860px] text-[12px]">
          <caption className="sr-only">Staged rows</caption>
          <thead>
            <tr className="border-b border-line text-left text-[11px] uppercase tracking-[0.04em] text-ink-3">
              <th scope="col" className="py-1.5 pr-2">
                Row
              </th>
              <th scope="col" className="py-1.5 pr-2">
                Source values (raw)
              </th>
              <th scope="col" className="py-1.5 pr-2">
                Will import as
              </th>
              <th scope="col" className="py-1.5 pr-2">
                Flags
              </th>
              <th scope="col" className="py-1.5 pr-2">
                Decision
              </th>
              <th scope="col" className="py-1.5" />
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className="border-b border-line-soft align-top">
                <th scope="row" className="py-2 pr-2 text-left font-mono font-normal">
                  {r.sheet}!{r.rowNumber}
                </th>
                <td className="max-w-[260px] py-2 pr-2">
                  {r.raw.map((c, i) => (
                    <span key={i} className="mr-2 inline-block">
                      <span className="text-ink-3">{c.header}:</span> {c.value}
                    </span>
                  ))}
                </td>
                <td className="py-2 pr-2">
                  <span className="block font-medium">{r.effective.name ?? <span className="text-danger">no name</span>}</span>
                  <span className="block">
                    {r.effective.date ?? "?"} {r.effective.time ?? "?"} · {r.effective.status ?? "?"} · {r.effective.category ?? "?"}
                  </span>
                  <span className="block text-ink-3">{r.effective.procedure ?? "no procedure"}</span>
                  {r.effective.sex || r.effective.ageYears !== null ? (
                    <span className="block text-ink-3">
                      {r.effective.ageYears ?? "?"} / {r.effective.sex ?? "?"}
                    </span>
                  ) : null}
                </td>
                <td className="py-2 pr-2">
                  <FlagList flags={r.flags} blocking={r.blocking} />
                </td>
                <td className="py-2 pr-2">
                  <Badge tone={r.decision === "ACCEPT" ? "success" : r.decision === "REJECT" ? "neutral" : "warning"}>
                    {r.decision === "ACCEPT" ? "Import" : r.decision === "REJECT" ? "Not imported" : "Pending"}
                  </Badge>
                  {r.patientLink ? (
                    <span className="mt-0.5 block text-[11px] text-ink-3">
                      {r.patientLink === "NEW" ? "new patient" : r.patientLink === "EXISTING" ? "existing patient" : "same person as another row"}
                    </span>
                  ) : null}
                  {r.decisionReason ? <span className="mt-0.5 block text-[11px] text-ink-3">“{r.decisionReason}”</span> : null}
                  {r.appointmentId ? (
                    <Link href={`/diagnostics/appointments/${r.appointmentId}`} className="mt-0.5 block text-[11px] text-accent-ink hover:underline">
                      appointment →
                    </Link>
                  ) : null}
                </td>
                <td className="py-2">
                  {!disabled ? (
                    <button type="button" className={`${btn} min-h-8 text-[12px]`} onClick={() => setOpen(r)}>
                      Review
                    </button>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {open ? <ReviewDialog row={open} onClose={() => setOpen(null)} /> : null}
    </>
  );
}

type Cands = {
  patients: Array<{ id: string; name: string; hospitalId: string | null; dob: string | null; sex: string | null; category: string }>;
  rows: Array<{ id: string; sheet: string; rowNumber: number; date: string | null; decision: string; patientLink: string | null }>;
};

function ReviewDialog({ row, onClose }: { row: ImportRowView; onClose: () => void }) {
  const router = useRouter();
  const fields = [...new Set(row.flags.map((f) => FLAG_INFO[f].field).filter((x): x is ResolvableField => !!x))];
  const [res, setRes] = useState<Record<string, string>>({ ...row.resolved });
  const [link, setLink] = useState<string>(
    row.patientLink ?? (row.flags.some((f) => f === "NAME_MATCHES_EXISTING" || f === "NAME_REPEATS_IN_BATCH") ? "" : "NEW"),
  );
  const [patientId, setPatientId] = useState(row.patientId ?? "");
  const [sameAs, setSameAs] = useState(row.sameAsRowId ?? "");
  const [reason, setReason] = useState(row.decisionReason ?? "");
  const [cands, setCands] = useState<Cands | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const needCands = row.flags.some((f) => f === "NAME_MATCHES_EXISTING" || f === "NAME_REPEATS_IN_BATCH");

  async function decide(decision: "ACCEPT" | "REJECT" | "PENDING") {
    setPending(true);
    setError(null);
    const r = await decideRowAction(row.id, {
      resolved: res,
      decision,
      reason,
      patientLink: decision === "ACCEPT" ? ((link || null) as "NEW" | "EXISTING" | "SAME_AS_ROW" | null) : null,
      patientId: link === "EXISTING" ? patientId : null,
      sameAsRowId: link === "SAME_AS_ROW" ? sameAs : null,
    }).catch(() => unreachable);
    setPending(false);
    if (!r.ok) return setError(r.error);
    onClose();
    router.refresh();
  }

  return (
    <Modal title={`Review ${row.sheet}!${row.rowNumber}`} onClose={onClose}>
      <div className="space-y-3 text-[13px]">
        <div className="rounded-[7px] bg-neutral-soft p-2 text-[12px]">
          <p className="mb-1 font-semibold">Source values</p>
          {row.raw.map((c, i) => (
            <p key={i}>
              <span className="text-ink-3">{c.header}:</span> {c.value}
            </p>
          ))}
        </div>
        <FlagList flags={row.flags} blocking={row.blocking} />
        {fields.map((f) => (
          <label key={f} className={labelCls}>
            {f === "date"
              ? "Date (YYYY-MM-DD) — from the source/paper record, never guessed"
              : f === "time"
                ? "Time (24-hour HH:MM)"
                : f === "status"
                  ? "Status"
                  : f === "category"
                    ? "OPD / INP"
                    : f === "name"
                      ? "Patient name"
                      : "Procedure"}
            {f === "status" ? (
              <select className={inputCls} value={res[f] ?? ""} onChange={(e) => setRes({ ...res, [f]: e.target.value })}>
                <option value="">— keep parsed value —</option>
                {["SCHEDULED", "PENDING", "COMPLETED", "NO_SHOW", "CANCELLED", "FOR_RESCHEDULE", "RESCHEDULED"].map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
            ) : f === "category" ? (
              <select className={inputCls} value={res[f] ?? ""} onChange={(e) => setRes({ ...res, [f]: e.target.value })}>
                <option value="">— keep parsed value —</option>
                <option value="OPD">OPD</option>
                <option value="INP">INP</option>
                <option value="OTHER">Other</option>
              </select>
            ) : (
              <input
                className={inputCls}
                type={f === "date" ? "date" : f === "time" ? "time" : "text"}
                value={res[f] ?? ""}
                onChange={(e) => setRes({ ...res, [f]: e.target.value })}
              />
            )}
          </label>
        ))}
        <fieldset>
          <legend className={labelCls}>Patient</legend>
          {needCands && !cands ? (
            <button
              type="button"
              className={`${btn} mt-1 min-h-8 text-[12px]`}
              onClick={async () => {
                const r = await candidatesAction(row.id).catch(() => unreachable);
                if (r.ok && r.data) setCands(r.data as Cands);
                else if (!r.ok) setError(r.error);
              }}
            >
              Show possible matches
            </button>
          ) : null}
          <div className="mt-1 space-y-1">
            <label className="flex items-center gap-2">
              <input type="radio" checked={link === "NEW"} onChange={() => setLink("NEW")} /> New patient record
            </label>
            {cands?.patients.map((p) => (
              <label key={p.id} className="flex items-center gap-2">
                <input
                  type="radio"
                  checked={link === "EXISTING" && patientId === p.id}
                  onChange={() => {
                    setLink("EXISTING");
                    setPatientId(p.id);
                  }}
                />
                Existing: {p.name} · {p.hospitalId ?? "no hospital no."} · {p.sex ?? "sex not recorded"} · DOB {p.dob ?? "—"} · {p.category}
              </label>
            ))}
            {cands?.rows
              .filter((o) => o.patientLink !== "SAME_AS_ROW")
              .map((o) => (
                <label key={o.id} className="flex items-center gap-2">
                  <input
                    type="radio"
                    checked={link === "SAME_AS_ROW" && sameAs === o.id}
                    onChange={() => {
                      setLink("SAME_AS_ROW");
                      setSameAs(o.id);
                    }}
                  />
                  Same person as {o.sheet}!{o.rowNumber} ({o.date ?? "no date"}, {o.decision.toLowerCase()})
                </label>
              ))}
          </div>
          <p className="mt-1 text-[11px] text-ink-3">
            A matching name is never proof of the same person. Choose only when another identifier or the source record confirms it.
          </p>
        </fieldset>
        <label className={labelCls}>
          Reviewer note <span className="font-normal text-ink-3">(required when not importing)</span>
          <input className={inputCls} value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} />
        </label>
        <FormError error={error} />
        <div className="flex flex-wrap justify-end gap-2">
          <button type="button" className={btn} disabled={pending} onClick={() => decide("PENDING")}>
            Leave pending
          </button>
          <button type="button" className={btn} disabled={pending} onClick={() => decide("REJECT")}>
            Do not import
          </button>
          <button type="button" className={btnPrimary} disabled={pending} onClick={() => decide("ACCEPT")}>
            Import this row
          </button>
        </div>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------- batch actions

export function BatchActions({
  batchId,
  status,
  summary,
  sheet,
  hasOriginal,
}: {
  batchId: string;
  status: string;
  summary: DryRun | null;
  sheet: string | null;
  hasOriginal: boolean;
}) {
  const router = useRouter();
  const { run, busy, element } = useSensitiveAction();
  const [result, setResult] = useState<AdminResult | null>(null);
  const [dry, setDry] = useState<DryRun | null>(summary);
  const [dialog, setDialog] = useState<null | "reverse" | "discard">(null);
  return (
    <div className="space-y-3 text-[13px]">
      {element}
      {status === "STAGED" ? (
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            className={btn}
            disabled={busy}
            onClick={async () => {
              const r = await bulkAcceptAction(batchId, sheet).catch(() => unreachable);
              setResult(
                r.ok
                  ? { ok: true, message: `${(r.data as { accepted: number }).accepted} clean row(s) marked for import as new patients.` }
                  : (r as AdminResult),
              );
              router.refresh();
            }}
          >
            Accept clean rows{sheet ? ` on ${sheet}` : ""}
          </button>
          <button
            type="button"
            className={btn}
            disabled={busy}
            onClick={async () => {
              const r = await dryRunAction(batchId).catch(() => unreachable);
              if (r.ok) setDry(r.data as DryRun);
              else setResult(r as AdminResult);
            }}
          >
            Dry run
          </button>
          <a className={btn} href={`/api/import/${batchId}/report`}>
            Exception report (CSV)
          </a>
          <button
            type="button"
            className={btnPrimary}
            disabled={busy || !dry?.ready}
            title={dry?.ready ? "" : "Run a dry run with no problems first"}
            onClick={async () => {
              if (
                !confirm(
                  `Commit ${dry?.appointments ?? 0} appointment(s) and ${dry?.newPatients ?? 0} new patient record(s)? You can reverse a committed import as a unit.`,
                )
              )
                return;
              const r = await run(() => commitAction(batchId) as Promise<AdminResult>);
              setResult(r);
              if (r.ok) router.refresh();
            }}
          >
            Commit import…
          </button>
          <button type="button" className={`${btn} text-danger`} onClick={() => setDialog("discard")}>
            Discard batch
          </button>
        </div>
      ) : (
        <div className="flex flex-wrap gap-2">
          <a className={btn} href={`/api/import/${batchId}/report`}>
            Exception report (CSV)
          </a>
          {status === "COMMITTED" ? (
            <button type="button" className={`${btn} text-danger`} onClick={() => setDialog("reverse")}>
              Reverse this import…
            </button>
          ) : null}
        </div>
      )}
      {dry ? (
        <div className={`rounded-[7px] border p-3 ${dry.ready ? "border-success bg-success-soft" : "border-warning bg-warning-soft"}`} role="status">
          <p className="font-semibold">{status === "COMMITTED" ? "Committed" : dry.ready ? "Dry run: ready to commit" : "Dry run: not ready"}</p>
          <p className="text-[12px]">
            {dry.rows} rows · {dry.accepted} to import · {dry.rejected} not imported · {dry.pending} pending · {dry.newPatients} new patient(s) ·{" "}
            {dry.existingPatients} existing · {dry.linkedRows} linked to another row · {dry.appointments} appointment(s)
          </p>
          {dry.problems.map((p) => (
            <p key={p} className="text-[12px] text-danger">
              ● {p}
            </p>
          ))}
        </div>
      ) : null}
      {hasOriginal ? (
        <button
          type="button"
          className={btn}
          disabled={busy}
          onClick={async () => {
            const r = await run(() => confirmOriginalDownloadAction() as Promise<AdminResult>);
            if (r.ok) {
              // A file download (API route), not a page navigation.
              const a = document.createElement("a");
              a.href = `/api/import/${batchId}/original`;
              a.click();
            } else setResult(r);
          }}
        >
          Download original workbook…
        </button>
      ) : null}
      <ResultNote result={result} />
      {dialog ? (
        <ReasonDialog
          title={dialog === "reverse" ? "Reverse import" : "Discard staged batch"}
          intro={
            dialog === "reverse"
              ? "Voids every appointment this import created and the patient records it created (if nothing else refers to them). Refused if any imported appointment was changed since."
              : "Closes the batch without importing anything and erases its staged workbook values."
          }
          onClose={() => setDialog(null)}
          run={async (reason) => {
            const r =
              dialog === "reverse"
                ? await run(() => reverseImportAction(batchId, reason) as Promise<AdminResult>)
                : ((await discardImportAction(batchId, reason).catch(() => unreachable)) as AdminResult);
            if (r.ok) router.refresh();
            return r;
          }}
        />
      ) : null}
    </div>
  );
}

function ReasonDialog({ title, intro, onClose, run }: { title: string; intro: string; onClose: () => void; run: (reason: string) => Promise<AdminResult> }) {
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  return (
    <Modal title={title} onClose={onClose}>
      <p className="text-[12px] text-ink-2">{intro}</p>
      <form
        className="mt-3"
        onSubmit={async (e) => {
          e.preventDefault();
          const r = await run(reason);
          if (!r.ok) return setError(r.error);
          onClose();
        }}
      >
        <label className={labelCls}>
          Reason
          <input className={inputCls} value={reason} onChange={(e) => setReason(e.target.value)} required minLength={5} maxLength={300} />
        </label>
        <FormError error={error} />
        <div className="mt-4 flex justify-end gap-2">
          <button type="button" className={btn} onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className={btnPrimary}>
            {title}
          </button>
        </div>
      </form>
    </Modal>
  );
}
