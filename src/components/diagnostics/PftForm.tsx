"use client";

import { useRouter } from "next/navigation";
import { useState, type ReactNode } from "react";
import { amendPftAction, finalizePftAction, savePftAction, signPftAction, voidPftAction } from "@/app/actions/diagnostics";
import type { AdminResult } from "@/app/actions/admin";
import { useSensitiveAction } from "@/components/admin/useSensitiveAction";
import { FormError, inputCls, labelCls, useClientId } from "@/components/clinical/fields";
import { Modal } from "@/components/ui/Modal";
import { formatDateTime } from "@/lib/time/zoned";
import type { PftDraft, PftFormView } from "@/server/pft";

const btn = "inline-flex min-h-10 items-center rounded-[7px] border border-line bg-surface px-3 text-[13px] font-medium hover:bg-hover disabled:opacity-60";
const btnPrimary =
  "inline-flex min-h-10 items-center rounded-[7px] border border-accent bg-accent px-4 text-[13px] font-semibold text-white hover:bg-accent-hover disabled:opacity-60";
const unreachable = { ok: false as const, error: "Could not reach the server. Nothing was saved." };

// Items 1–5 print as the numbered "Technician's comments" sentences, exactly as typed (item 6 is the bronchodilator statement).
const SECTIONS: Array<{ key: keyof PftDraft; label: string; rows: number; max: number; example: string }> = [
  { key: "spirometryHistory", label: "1. Patient's spirometry Hx", rows: 2, max: 1000, example: "e.g. This is the patient's first time doing the test." },
  { key: "purposeOfTest", label: "2. Purpose of test", rows: 2, max: 1000, example: "e.g. The purpose of the test is for comprehensive check up." },
  { key: "smokingHistory", label: "3. Patient's smoking Hx", rows: 2, max: 1000, example: "e.g. The patient is a non-smoker." },
  {
    key: "medication",
    label: "4. Patient's medication",
    rows: 2,
    max: 1000,
    example: "e.g. The patient did not take any respiratory medication before the procedure.",
  },
  { key: "observation", label: "5. Patient observation", rows: 3, max: 2000, example: "e.g. The patient experienced difficulty during the procedure." },
  {
    key: "technicianComments",
    label: "Other comments (optional — printed after item 6)",
    rows: 2,
    max: 2000,
    example: "Anything else for the pulmonologist",
  },
];

const SECTION_LABEL: Record<string, string> = {
  PATIENT_INFORMATION: "Patient information",
  TECHNICIAN_COMMENTS: "Technician's comments",
  SPIROMETRY_HISTORY: "Spirometry history",
  PURPOSE_OF_TEST: "Purpose of test",
  SMOKING_HISTORY: "Smoking history",
  MEDICATION: "Medication",
  OBSERVATION: "Patient observation",
  INTERPRETATION: "Interpretation",
  SIGNATURES: "Signatures",
  OTHER: "Other / not stated",
};

const MONTHS_LONG = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** "2026-11-25" → "November 25, 2026" (as on the hospital's printed form). */
function paperDate(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  return `${MONTHS_LONG[m - 1]} ${String(d).padStart(2, "0")}, ${y}`;
}

const COMMENT_HINTS = ["Patient's spirometry history", "Purpose of test", "Patient's smoking history", "Patient's medication", "Patient observation", ""];

/** Signature caption as on the form: "JUAN D. CRUZ , RTRP" / "MARIA SANTOS , MD". */
function signatureCaption(name: string | undefined, credentials: string | null | undefined, fallback: string): string {
  if (!name) return "";
  const clean = name
    .replace(/^\s*dr\.?\s+/i, "")
    .trim()
    .toUpperCase();
  return `${clean} , ${(credentials || fallback).toUpperCase()}`;
}

/** One bordered cell of the PATIENT INFORMATION table: bold label, plain value. */
function Cell({ label, value, span = 1 }: { label: string; value: ReactNode; span?: number }) {
  return (
    <td colSpan={span} className="border border-black px-1 py-[1px] align-top break-words">
      <b>{label}</b> {value || "\u00a0"}
    </td>
  );
}

/**
 * The record as it prints — matches the hospital's printed PFT result (form AS-PUL-PFT-006):
 * logo beside the hospital header, PULMONARY FUNCTION TEST, DATE, PATIENT INFORMATION table, Technician's comments
 * as numbered sentences (guide items 1–5 filled in, 6 = bronchodilator statement), INTERPRETATION, RT and
 * pulmonologist signatures with "NAME , RTRP" / "NAME , MD", and the form code centred at the bottom.
 */
function FormDocument({ f }: { f: PftFormView }) {
  const d = f.draft;
  const t = f.template;
  const sex = d.sex === "M" ? "MALE" : d.sex === "F" ? "FEMALE" : "";
  // Fixed numbering as on the guide: 1–5 the RT's sentences, 6 the bronchodilator statement, extra comments after.
  const comments = [d.spirometryHistory, d.purposeOfTest, d.smokingHistory, d.medication, d.observation, t.bronchodilatorNote ?? ""].map((x) =>
    (x ?? "").trim(),
  );
  if ((d.technicianComments ?? "").trim()) comments.push(d.technicianComments.trim());
  const rtCaption = signatureCaption(f.rtSignature?.name, "RTRP", "RTRP");
  const mdCaption = signatureCaption(f.pulmoSignoff?.name, null, "MD");
  return (
    <article
      className="pft-paper mx-auto flex max-w-[210mm] flex-col rounded-[10px] border border-line bg-white p-6 font-[Times_New_Roman,Times,serif] text-[13px] text-black print:min-h-[268mm] print:max-w-none print:rounded-none print:border-0 print:p-0"
      aria-label="PFT form"
    >
      {f.status !== "FINAL" ? (
        <p className="mb-3 rounded-[7px] border border-warning bg-warning-soft px-3 py-1.5 text-center font-sans text-[12px] font-semibold text-warning">
          {f.status === "DRAFT" ? "DRAFT — not signed, not an official record" : "RT SIGNED — awaiting pulmonologist sign-off; not yet final"}
        </p>
      ) : null}
      {!t.hospitalConfirmed ? (
        <p className="no-print mb-3 text-center font-sans text-[11px] text-ink-3">
          Template v{t.version}: not yet confirmed as current by the Chief RT (Settings → PFT form template).
        </p>
      ) : null}

      <header className="flex items-center justify-center gap-6 font-[Arial,Helvetica,sans-serif]">
        {t.hasLogo ? (
          // eslint-disable-next-line @next/next/no-img-element -- authenticated, versioned image that must print exactly
          <img src={`/api/pft/logo/${t.id}`} alt={`${t.facilityHeader} logo`} className="h-16 w-auto print:h-[17mm]" />
        ) : null}
        <div className="text-center">
          <p className="text-[19px] leading-tight font-bold">{t.facilityHeader}</p>
          {t.facilityAddress ? <p className="text-[9.5px] leading-snug font-bold whitespace-pre-line">{t.facilityAddress}</p> : null}
        </div>
      </header>
      <h2 className="mt-8 text-center font-[Arial,Helvetica,sans-serif] text-[17px] font-bold">PULMONARY FUNCTION TEST</h2>

      <p className="mt-6">
        <b>DATE:</b> {d.testDate ? paperDate(d.testDate).toUpperCase() : "\u00a0"}
      </p>
      <h3 className="mt-1 text-center text-[15px] font-bold">PATIENT INFORMATION</h3>

      <table className="mt-3 w-full table-fixed border-collapse border border-black leading-snug" aria-label="Patient information">
        <colgroup>
          <col className="w-[10.7%]" />
          <col className="w-[14.3%]" />
          <col className="w-[18.3%]" />
          <col className="w-[17.1%]" />
          <col className="w-[10.4%]" />
          <col className="w-[29.2%]" />
        </colgroup>
        <tbody>
          <tr>
            <Cell label="Name:" value={d.patientName.toUpperCase()} span={3} />
            <Cell label="Sex:" value={sex} />
            <Cell label="Age:" value={d.ageText} />
            <Cell label="Birthdate:" value={d.birthdate ? paperDate(d.birthdate) : ""} />
          </tr>
          <tr>
            <Cell label="Hospital No.:" value={d.hospitalNumber} span={2} />
            <Cell label="Weight (kg):" value={d.weightKg} />
            <Cell label="Height (cm):" value={d.heightCm} />
            <Cell label="Room:" value={(d.roomOrOpd || "").toUpperCase()} span={2} />
          </tr>
          <tr>
            <Cell label="Requesting Physician:" value={(d.requestingPhysician || "").toUpperCase()} span={4} />
            <Cell label="HMO:" value={(d.hmo || "").toUpperCase()} span={2} />
          </tr>
          <tr>
            <td className="border border-black px-1 py-[1px] align-top font-bold">Test Type:</td>
            <td colSpan={5} className="border border-black px-1 py-[1px] align-top break-words">
              {(d.testType || "").toUpperCase() || "\u00a0"}
            </td>
          </tr>
        </tbody>
      </table>

      <section className="mt-12" aria-label="Technician's comments">
        <p className="font-bold">Technician&apos;s comments:</p>
        <ol className="mt-0.5 leading-snug">
          {comments.map((c, i) => (
            <li key={i} className="min-h-[1.3em] whitespace-pre-wrap">
              {i + 1}. {c || <span className="no-print font-sans text-[11px] text-ink-3">{COMMENT_HINTS[i]}</span>}
            </li>
          ))}
        </ol>
        {!t.hospitalConfirmed && t.bronchodilatorNote ? (
          <p className="no-print mt-1 font-sans text-[11px] text-ink-3">
            Bronchodilator statement is from the form template — Chief RT to confirm it is current.
          </p>
        ) : null}
      </section>

      <section className="mt-12 flex-1" aria-label="Interpretation">
        <p className="font-bold">INTERPRETATION:</p>
        <div className="mt-1 min-h-40 whitespace-pre-wrap print:min-h-[70mm]">
          {f.interpretation ?? <span className="no-print font-sans text-[12px] text-ink-3">Written by the pulmonologist.</span>}
        </div>
      </section>

      {f.amendments.length ? (
        <section className="mt-4" aria-label="Amendments">
          <p className="font-bold">AMENDMENTS (appended after finalization):</p>
          <ol className="mt-1 space-y-1">
            {f.amendments.map((a, i) => (
              <li key={a.id}>
                <b>
                  {i + 1}. {SECTION_LABEL[a.section] ?? a.section} · {formatDateTime(new Date(a.createdIso))} · {a.createdBy}:
                </b>{" "}
                <span className="whitespace-pre-wrap">{a.text}</span> <i>(Reason: {a.reason})</i>
              </li>
            ))}
          </ol>
        </section>
      ) : null}

      <div className="mt-10 grid grid-cols-2 gap-10 font-[Calibri,Carlito,Arial,sans-serif] text-[13px]">
        <div className="text-center">
          <div className="relative flex h-14 items-end justify-center">
            {f.rtSignature?.hasImage ? (
              // eslint-disable-next-line @next/next/no-img-element -- approved e-signature image, must print exactly
              <img
                src={`/api/signatory/${f.rtSignature.signatoryId}/signature`}
                alt={`E-signature of ${f.rtSignature.name}`}
                className="absolute bottom-[-10px] left-1/2 max-h-16 w-auto -translate-x-1/2 print:max-h-[17mm]"
              />
            ) : f.rtSignature ? (
              <span className="no-print text-[10px] text-ink-2">Signed electronically {formatDateTime(new Date(f.rtSignature.signedIso))}</span>
            ) : null}
          </div>
          <p className="relative">{rtCaption || "______________________ , RTRP"}</p>
          <p className="font-bold">Respiratory Therapist</p>
        </div>
        <div className="text-center">
          <div className="relative flex h-14 items-end justify-center">
            {f.pulmoSignoff?.method === "E_SIGNATURE_APPLIED_BY_RT" && f.pulmoSignoff.hasImage ? (
              // eslint-disable-next-line @next/next/no-img-element -- approved e-signature image, must print exactly
              <img
                src={`/api/signatory/${f.pulmoSignoff.signatoryId}/signature`}
                alt={`E-signature of ${f.pulmoSignoff.name}`}
                className="absolute bottom-[-10px] left-1/2 max-h-16 w-auto -translate-x-1/2 print:max-h-[17mm]"
              />
            ) : f.pulmoSignoff ? (
              <span className="no-print text-[10px] text-ink-2">
                Signed on the printed copy · recorded {formatDateTime(new Date(f.pulmoSignoff.recordedIso))} by {f.pulmoSignoff.recordedBy}
              </span>
            ) : null}
          </div>
          <p className="relative">{mdCaption || "______________________ , MD"}</p>
          <p className="font-bold">Pulmonologist</p>
          {f.pulmoSignoff?.method === "E_SIGNATURE_APPLIED_BY_RT" ? (
            <p className="no-print text-[9px] text-ink-3">
              E-signature applied {formatDateTime(new Date(f.pulmoSignoff.recordedIso))} by {f.pulmoSignoff.recordedBy}
            </p>
          ) : null}
        </div>
      </div>

      <footer className="mt-10 font-[Calibri,Carlito,Arial,sans-serif] text-[11px]">
        <p className="text-center">{t.formCode}</p>
        <p className="no-print text-right text-[10px] text-ink-3">PUIMS record {f.id.slice(0, 8)}</p>
      </footer>
    </article>
  );
}

export function PftFormScreen({ form }: { form: PftFormView }) {
  const router = useRouter();
  const { run, busy, element } = useSensitiveAction();
  const [draft, setDraft] = useState<PftDraft>(form.draft);
  const [updatedIso, setUpdatedIso] = useState(form.updatedIso);
  const [dirty, setDirty] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const [dialog, setDialog] = useState<null | "void" | "amend">(null);

  const set = (k: keyof PftDraft) => (e: { target: { value: string } }) => {
    setDraft((d) => ({ ...d, [k]: e.target.value }));
    setDirty(true);
  };
  async function save(): Promise<string | null> {
    setSaving(true);
    const r = await savePftAction(form.id, updatedIso, draft).catch(() => unreachable);
    setSaving(false);
    if (!r.ok) {
      setMsg({ ok: false, text: r.error });
      return null;
    }
    setUpdatedIso(r.data!.updatedIso);
    setDirty(false);
    setMsg({ ok: true, text: "Draft saved." });
    return r.data!.updatedIso;
  }

  const input = (k: keyof PftDraft, label: string, props: Record<string, unknown> = {}) => (
    <label className={labelCls}>
      {label}
      <input className={inputCls} value={draft[k]} onChange={set(k)} {...props} />
    </label>
  );

  return (
    <div>
      {element}
      {form.canEdit ? (
        <form
          className="no-print space-y-4 rounded-[10px] border border-line bg-surface p-4"
          onSubmit={async (e) => {
            e.preventDefault();
            await save();
          }}
        >
          <p className="text-[12px] text-ink-2">
            Administrative fields were copied from the patient and appointment records; check them. Clinical sections start empty — write only what you
            observed. Nothing here is generated.
          </p>
          <fieldset className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            <legend className="mb-1 text-[12px] font-bold uppercase tracking-[0.06em]">Patient information</legend>
            {input("testDate", "Date", { type: "date", required: true })}
            {input("patientName", "Name", { required: true, maxLength: 160 })}
            <label className={labelCls}>
              Sex
              <select className={inputCls} value={draft.sex} onChange={set("sex")}>
                <option value="">Not recorded</option>
                <option value="M">Male</option>
                <option value="F">Female</option>
              </select>
            </label>
            {input("ageText", "Age", { maxLength: 20 })}
            {input("birthdate", "Birthdate", { type: "date" })}
            {input("hospitalNumber", "Hospital number", { maxLength: 40 })}
            {input("weightKg", "Weight (kg)", { inputMode: "decimal", pattern: "\\d{1,3}(\\.\\d)?" })}
            {input("heightCm", "Height (cm)", { inputMode: "decimal", pattern: "\\d{1,3}(\\.\\d)?" })}
            {input("roomOrOpd", "Room (or OUTPATIENT)", { maxLength: 60 })}
            {input("requestingPhysician", "Requesting physician", { maxLength: 120 })}
            {input("hmo", "HMO", { maxLength: 80 })}
            {input("testType", "Test type", { maxLength: 160 })}
          </fieldset>
          {SECTIONS.map((s) => (
            <label key={s.key} className={labelCls}>
              {s.label}
              <textarea className={`${inputCls} py-2`} rows={s.rows} maxLength={s.max} value={draft[s.key]} onChange={set(s.key)} placeholder={s.example} />
            </label>
          ))}
          <p className="text-[12px] text-ink-3">
            Write items 1–5 as full sentences — they print as the numbered Technician&apos;s comments. Item 6 (bronchodilator) is added automatically. The
            interpretation is written by the pulmonologist and recorded at sign-off.
          </p>
          {msg ? (
            <p role={msg.ok ? "status" : "alert"} className={`text-[12px] ${msg.ok ? "text-success" : "text-danger"}`}>
              {msg.ok ? "✓ " : ""}
              {msg.text}
            </p>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <button type="submit" className={btn} disabled={saving}>
              {saving ? "Saving…" : dirty ? "Save draft" : "Saved"}
            </button>
            {form.canSign ? (
              <button
                type="button"
                className={btnPrimary}
                disabled={busy || saving}
                onClick={async () => {
                  const at = dirty ? await save() : updatedIso;
                  if (!at) return;
                  if (!confirm("Sign this PFT form? Its content will be locked. Corrections after finalization are added as amendments.")) return;
                  const r = (await run(() => signPftAction(form.id, at) as Promise<AdminResult>)) as AdminResult;
                  if (!r.ok) setMsg({ ok: false, text: r.error });
                  else router.refresh();
                }}
              >
                Sign as RT…
              </button>
            ) : (
              <span className="self-center text-[12px] text-warning">
                You are not in the approved signatory directory — ask the Chief RT to add you before signing.
              </span>
            )}
            <button type="button" className={`${btn} ml-auto text-danger`} onClick={() => setDialog("void")}>
              Void draft
            </button>
          </div>
        </form>
      ) : null}

      {form.canFinalize ? <FinalizePanel form={form} run={run} busy={busy} /> : null}

      <div className={form.canEdit ? "hidden print:block" : ""}>
        <FormDocument f={form.canEdit ? { ...form, draft } : form} />
      </div>

      {form.canAmend ? (
        <div className="no-print mt-4">
          <button type="button" className={btn} onClick={() => setDialog("amend")}>
            Add amendment…
          </button>
        </div>
      ) : null}
      {dialog === "void" ? <VoidDialog id={form.id} appointmentId={form.appointmentId} onClose={() => setDialog(null)} /> : null}
      {dialog === "amend" ? <AmendDialog id={form.id} run={run} onClose={() => setDialog(null)} /> : null}
    </div>
  );
}

type Runner = ReturnType<typeof useSensitiveAction>["run"];

type Method = "E_SIGNATURE_APPLIED_BY_RT" | "WET_SIGNATURE_ON_PRINTED_COPY";

function FinalizePanel({ form, run, busy }: { form: PftFormView; run: Runner; busy: boolean }) {
  const router = useRouter();
  const [pulmo, setPulmo] = useState(form.pulmonologists[0]?.id ?? "");
  const selected = form.pulmonologists.find((p) => p.id === pulmo);
  const [method, setMethod] = useState<Method>(selected?.hasSignature ? "E_SIGNATURE_APPLIED_BY_RT" : "WET_SIGNATURE_ON_PRINTED_COPY");
  const [interp, setInterp] = useState("");
  const [attest, setAttest] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const esign = method === "E_SIGNATURE_APPLIED_BY_RT";
  return (
    <form
      className="no-print mb-4 space-y-3 rounded-[10px] border border-accent bg-accent-soft p-4"
      onSubmit={async (e) => {
        e.preventDefault();
        setError(null);
        const r = (await run(() => finalizePftAction(form.id, pulmo, interp, attest, method) as Promise<AdminResult>)) as AdminResult;
        if (!r.ok) setError(r.error);
        else router.refresh();
      }}
    >
      <h2 className="text-[14px] font-semibold">Pulmonologist sign-off</h2>
      <label className={labelCls}>
        Pulmonologist (approved directory)
        <select
          className={inputCls}
          value={pulmo}
          onChange={(e) => {
            setPulmo(e.target.value);
            const p = form.pulmonologists.find((x) => x.id === e.target.value);
            if (!p?.hasSignature) setMethod("WET_SIGNATURE_ON_PRINTED_COPY");
          }}
          required
        >
          {form.pulmonologists.length ? null : <option value="">No active pulmonologist in the directory</option>}
          {form.pulmonologists.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
              {p.credentials ? ` — ${p.credentials}` : ""}
              {p.hasSignature ? " (e-signature on file)" : ""}
            </option>
          ))}
        </select>
      </label>
      <fieldset>
        <legend className={labelCls}>How the pulmonologist signs</legend>
        <div className="mt-1 space-y-1 text-[13px]">
          <label className="flex items-start gap-2">
            <input
              type="radio"
              name="method"
              className="mt-1"
              checked={esign}
              disabled={!selected?.hasSignature}
              onChange={() => setMethod("E_SIGNATURE_APPLIED_BY_RT")}
            />
            <span>
              Apply the pulmonologist&apos;s approved e-signature (as in the Excel guide)
              {!selected?.hasSignature ? <span className="text-ink-3"> — no e-signature on file for this pulmonologist</span> : null}
            </span>
          </label>
          <label className="flex items-start gap-2">
            <input type="radio" name="method" className="mt-1" checked={!esign} onChange={() => setMethod("WET_SIGNATURE_ON_PRINTED_COPY")} />
            <span>Signature on the printed copy</span>
          </label>
        </div>
      </fieldset>
      <label className={labelCls}>
        Interpretation — exactly as given by the pulmonologist
        <textarea className={`${inputCls} py-2`} rows={4} maxLength={4000} value={interp} onChange={(e) => setInterp(e.target.value)} required />
      </label>
      <label className="flex items-start gap-2 text-[13px]">
        <input type="checkbox" className="mt-1" checked={attest} onChange={(e) => setAttest(e.target.checked)} required />
        <span>
          {esign
            ? "I confirm the pulmonologist gave this interpretation and authorized applying their e-signature to this result."
            : "I confirm the pulmonologist signed the printed form and that the interpretation above is transcribed from it."}
        </span>
      </label>
      <FormError error={error} />
      <div className="flex gap-2">
        {!esign ? (
          <button type="button" className={btn} onClick={() => window.print()}>
            Print for signature
          </button>
        ) : null}
        <button type="submit" className={btnPrimary} disabled={busy || !pulmo}>
          Finalize record…
        </button>
      </div>
    </form>
  );
}

function VoidDialog({ id, appointmentId, onClose }: { id: string; appointmentId: string; onClose: () => void }) {
  const router = useRouter();
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  return (
    <Modal title="Void PFT form" onClose={onClose}>
      <p className="text-[12px] text-ink-2">Only an unsigned or RT-signed form started in error can be voided. A final record cannot.</p>
      <form
        className="mt-3"
        onSubmit={async (e) => {
          e.preventDefault();
          const r = await voidPftAction(id, reason).catch(() => unreachable);
          if (!r.ok) return setError(r.error);
          router.push(`/diagnostics/appointments/${appointmentId}`);
        }}
      >
        <label className={labelCls}>
          Reason
          <textarea className={`${inputCls} py-2`} value={reason} onChange={(e) => setReason(e.target.value)} required minLength={5} maxLength={300} />
        </label>
        <FormError error={error} />
        <div className="mt-4 flex justify-end gap-2">
          <button type="button" className={btn} onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className={btnPrimary}>
            Void
          </button>
        </div>
      </form>
    </Modal>
  );
}

function AmendDialog({ id, run, onClose }: { id: string; run: Runner; onClose: () => void }) {
  const router = useRouter();
  const clientId = useClientId();
  const [section, setSection] = useState("OBSERVATION");
  const [text, setText] = useState("");
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  return (
    <Modal title="Add amendment" onClose={onClose}>
      <p className="text-[12px] text-ink-2">The final record is never changed. An amendment is appended with your name, the time and a reason.</p>
      <form
        className="mt-3 space-y-3"
        onSubmit={async (e) => {
          e.preventDefault();
          const r = (await run(() => amendPftAction(id, clientId, section, text, reason) as Promise<AdminResult>)) as AdminResult;
          if (!r.ok) return setError(r.error);
          onClose();
          router.refresh();
        }}
      >
        <label className={labelCls}>
          Section
          <select className={inputCls} value={section} onChange={(e) => setSection(e.target.value)}>
            {Object.entries(SECTION_LABEL).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>
        </label>
        <label className={labelCls}>
          Amendment
          <textarea className={`${inputCls} py-2`} rows={4} value={text} onChange={(e) => setText(e.target.value)} required minLength={3} maxLength={2000} />
        </label>
        <label className={labelCls}>
          Reason
          <input className={inputCls} value={reason} onChange={(e) => setReason(e.target.value)} required minLength={5} maxLength={300} />
        </label>
        <FormError error={error} />
        <div className="flex justify-end gap-2">
          <button type="button" className={btn} onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className={btnPrimary}>
            Add amendment…
          </button>
        </div>
      </form>
    </Modal>
  );
}
