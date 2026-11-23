"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { correctPatientAction, registerPatientAction } from "@/app/actions/clinical";
import type { DuplicateCandidate, PatientInput } from "@/server/clinical";
import { formatShortDate } from "@/lib/time/zoned";

const MATCH_LABEL: Record<DuplicateCandidate["match"], string> = {
  SAME_HOSPITAL_NUMBER: "Same hospital number",
  SAME_NAME: "Same name",
  SAME_DOB_SHARED_NAME: "Same date of birth and a shared name",
};

const input = "mt-1 block min-h-10 w-full rounded-[7px] border border-line bg-surface px-3 text-[14px]";
const labelCls = "block text-[12px] font-medium text-ink-2";

function Err({ msg }: { msg?: string }) {
  return msg ? <span className="mt-1 block text-[12px] text-danger">{msg}</span> : null;
}

export function PatientForm({ mode, initial }: { mode: "register" | "correct"; initial?: PatientInput & { id: string; updatedAt: string } }) {
  const router = useRouter();
  const [values, setValues] = useState<PatientInput>(initial ?? { fullName: "", sex: "", category: "", dateOfBirth: "", hospitalPatientId: "", wardRoom: "" });
  const [reason, setReason] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [candidates, setCandidates] = useState<DuplicateCandidate[] | null>(null);
  const [confirmed, setConfirmed] = useState<Set<string>>(new Set());
  const [existingId, setExistingId] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const set = (k: keyof PatientInput) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
    setValues((v) => ({ ...v, [k]: e.target.value }));
    // Identity changed → previous duplicate review no longer applies.
    if (["fullName", "dateOfBirth", "hospitalPatientId"].includes(k)) {
      setCandidates(null);
      setConfirmed(new Set());
      setExistingId(null);
    }
  };

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setPending(true);
    setFormError(null);
    setErrors({});
    try {
      if (mode === "register") {
        const r = await registerPatientAction(values, [...confirmed]);
        if (!r.ok) return setFormError(r.error);
        const d = r.data!;
        if (d.status === "created") return router.push(`/patients/${d.id}`);
        if (d.status === "invalid") return setErrors(d.errors);
        if (d.status === "exists") return setExistingId(d.existingId);
        setCandidates(d.candidates);
      } else {
        const r = await correctPatientAction(initial!.id, initial!.updatedAt, values, reason);
        if (!r.ok) return setFormError(r.error);
        if (r.data!.status === "invalid") return setErrors((r.data as { errors: Record<string, string> }).errors);
        router.push(`/patients/${initial!.id}`);
        router.refresh();
      }
    } catch {
      setFormError("Could not reach the server. Nothing was saved.");
    } finally {
      setPending(false);
    }
  }

  const allConfirmed = !candidates || candidates.every((c) => confirmed.has(c.id));

  return (
    <form
      onSubmit={submit}
      className="max-w-2xl space-y-4 rounded-[10px] border border-line bg-surface p-5"
      aria-label={mode === "register" ? "Register patient" : "Correct patient details"}
      noValidate
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <label className={`${labelCls} sm:col-span-2`}>
          Full name <span className="text-danger">*</span>
          <input
            className={input}
            value={values.fullName}
            onChange={set("fullName")}
            required
            maxLength={160}
            autoComplete="off"
            placeholder="Surname, Given names"
          />
          <Err msg={errors.fullName} />
        </label>
        <fieldset className="text-[12px] font-medium text-ink-2">
          <legend>
            Sex <span className="text-danger">*</span>
          </legend>
          <div className="mt-2 flex gap-4">
            {[
              ["M", "Male"],
              ["F", "Female"],
            ].map(([v, l]) => (
              <label key={v} className="flex min-h-10 items-center gap-2 text-[14px] font-normal text-ink">
                <input type="radio" name="sex" value={v} checked={values.sex === v} onChange={set("sex")} className="h-4 w-4 accent-[var(--color-accent)]" />
                {l}
              </label>
            ))}
          </div>
          <Err msg={errors.sex} />
        </fieldset>
        <label className={labelCls}>
          Category <span className="text-danger">*</span>
          <select className={input} value={values.category} onChange={set("category")} required>
            <option value="">Select…</option>
            <option value="OPD">OPD</option>
            <option value="INP">INP</option>
            <option value="OTHER">Other / not stated</option>
          </select>
          <Err msg={errors.category} />
        </label>
        <label className={labelCls}>
          Date of birth <span className="font-normal text-ink-3">(optional)</span>
          <input className={input} type="date" value={values.dateOfBirth} onChange={set("dateOfBirth")} />
          <Err msg={errors.dateOfBirth} />
        </label>
        <label className={labelCls}>
          Hospital number <span className="font-normal text-ink-3">(optional)</span>
          <input className={input} value={values.hospitalPatientId} onChange={set("hospitalPatientId")} maxLength={40} autoComplete="off" />
          <Err msg={errors.hospitalPatientId} />
        </label>
        <label className={labelCls}>
          Ward / room <span className="font-normal text-ink-3">(optional)</span>
          <input className={input} value={values.wardRoom} onChange={set("wardRoom")} maxLength={60} autoComplete="off" />
          <Err msg={errors.wardRoom} />
        </label>
        {mode === "correct" && (
          <label className={`${labelCls} sm:col-span-2`}>
            Reason for correction <span className="font-normal text-ink-3">(required when changing name, sex, date of birth or hospital number)</span>
            <input
              className={input}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              maxLength={300}
              placeholder="e.g. Name misspelled at registration; verified against ID"
            />
            <Err msg={errors.reason} />
          </label>
        )}
      </div>

      {existingId && (
        <div role="alert" className="rounded-[7px] border border-[#f0d0cc] bg-danger-soft p-3 text-[13px] text-danger">
          A patient with this hospital number is already registered.{" "}
          <Link href={`/patients/${existingId}`} className="font-semibold underline">
            Open the existing record
          </Link>
          .
        </div>
      )}

      {candidates && candidates.length > 0 && (
        <section aria-labelledby="dup-h" className="rounded-[7px] border border-[#f0dfbf] bg-warning-soft p-3" data-testid="duplicate-review">
          <h2 id="dup-h" className="text-[13px] font-semibold text-warning">
            Possible existing record{candidates.length > 1 ? "s" : ""} — check before registering
          </h2>
          <p className="mt-0.5 text-[12px] text-ink-2">
            Records are never merged automatically. If one of these is the same person, open it instead. Otherwise confirm each is a different person.
          </p>
          <ul className="mt-2 space-y-2">
            {candidates.map((c) => (
              <li key={c.id} className="rounded-[7px] border border-line bg-surface p-2.5 text-[12px]">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span>
                    <b className="text-[13px]">{c.fullName}</b> · {c.hospitalPatientId ?? "no hospital no."} · {c.sex ?? "sex not recorded"} ·{" "}
                    {c.dateOfBirth ? `born ${formatShortDate(c.dateOfBirth)}` : "DOB not recorded"} · {c.category}
                    <span className="ml-2 text-ink-3">({MATCH_LABEL[c.match]})</span>
                  </span>
                  <Link href={`/patients/${c.id}`} target="_blank" className="text-accent-ink underline">
                    Open record
                  </Link>
                </div>
                <label className="mt-1.5 flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={confirmed.has(c.id)}
                    onChange={(e) =>
                      setConfirmed((s) => {
                        const n = new Set(s);
                        if (e.target.checked) n.add(c.id);
                        else n.delete(c.id);
                        return n;
                      })
                    }
                  />
                  This is a different person
                </label>
              </li>
            ))}
          </ul>
        </section>
      )}

      {formError && (
        <p role="alert" className="text-[13px] text-danger">
          {formError}
        </p>
      )}
      <div className="flex gap-2">
        <button
          type="submit"
          disabled={pending || !allConfirmed}
          className="min-h-10 rounded-[7px] border border-accent bg-accent px-4 text-[14px] font-semibold text-white hover:bg-accent-hover disabled:opacity-50"
        >
          {pending ? "Saving…" : mode === "register" ? (candidates ? "Register as a new patient" : "Register patient") : "Save correction"}
        </button>
        <Link
          href={initial ? `/patients/${initial.id}` : "/patients"}
          className="inline-flex min-h-10 items-center rounded-[7px] border border-line px-4 text-[14px] hover:bg-hover"
        >
          Cancel
        </Link>
      </div>
    </form>
  );
}
