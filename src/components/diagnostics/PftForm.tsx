"use client";

import { useRouter } from "next/navigation";
import { useState, type ReactNode } from "react";
import { amendPftAction, finalizePftAction, savePftAction, signPftAction, voidPftAction } from "@/app/actions/diagnostics";
import type { AdminResult } from "@/app/actions/admin";
import { useSensitiveAction } from "@/components/admin/useSensitiveAction";
import { FormError, inputCls, labelCls, useClientId } from "@/components/clinical/fields";
import { Modal } from "@/components/ui/Modal";
import { formatDateTime, formatLongDate } from "@/lib/time/zoned";
import type { PftDraft, PftFormView } from "@/server/pft";

const btn = "inline-flex min-h-10 items-center rounded-[7px] border border-line bg-surface px-3 text-[13px] font-medium hover:bg-hover disabled:opacity-60";
const btnPrimary =
  "inline-flex min-h-10 items-center rounded-[7px] border border-accent bg-accent px-4 text-[13px] font-semibold text-white hover:bg-accent-hover disabled:opacity-60";
const unreachable = { ok: false as const, error: "Could not reach the server. Nothing was saved." };

const SECTIONS: Array<{ key: keyof PftDraft; label: string; rows: number; max: number }> = [
  { key: "technicianComments", label: "Technician's comments", rows: 3, max: 2000 },
  { key: "spirometryHistory", label: "1. Patient's spirometry Hx", rows: 2, max: 1000 },
  { key: "purposeOfTest", label: "2. Purpose of test", rows: 2, max: 1000 },
  { key: "smokingHistory", label: "3. Patient's smoking Hx", rows: 2, max: 1000 },
  { key: "medication", label: "4. Patient's medication", rows: 2, max: 1000 },
  { key: "observation", label: "5. Patient observation", rows: 3, max: 2000 },
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

/** One "Label: value" cell of the paper form; empty values print as a blank line to write on. */
function Line({ label, value, className = "" }: { label: string; value: ReactNode; className?: string }) {
  return (
    <div className={`flex min-w-0 items-end gap-1.5 ${className}`}>
      <span className="shrink-0 text-[12px] font-semibold">{label}</span>
      <span className="min-h-5 min-w-0 flex-1 border-b border-ink/60 px-1 text-[13px] break-words">{value || "\u00a0"}</span>
    </div>
  );
}

function Numbered({ n, label, value }: { n: number; label: string; value: string }) {
  return (
    <div className="mt-2">
      <p className="text-[12px] font-bold uppercase">
        {n}. {label}
      </p>
      <p className="min-h-6 border-b border-ink/40 px-1 text-[13px] whitespace-pre-wrap">{value || "\u00a0"}</p>
    </div>
  );
}

/**
 * The record as it prints. Layout and labels follow the hospital's PFT guide (form AS-PUL-PFT-006):
 * header, PULMONARY FUNCTION TEST, DATE, PATIENT INFORMATION, technician's comments, items 1–6,
 * INTERPRETATION, RTOD / DOCTOR signature lines and the form code.
 */
function FormDocument({ f }: { f: PftFormView }) {
  const d = f.draft;
  const t = f.template;
  const sex = d.sex === "M" ? "Male" : d.sex === "F" ? "Female" : "";
  return (
    <article className="pft-paper rounded-[10px] border border-line bg-surface p-5 text-ink print:rounded-none print:border-0 print:p-0" aria-label="PFT form">
      {f.status !== "FINAL" ? (
        <p className="mb-3 rounded-[7px] border border-warning bg-warning-soft px-3 py-1.5 text-center text-[12px] font-semibold text-warning">
          {f.status === "DRAFT" ? "DRAFT — not signed, not an official record" : "RT SIGNED — awaiting pulmonologist sign-off; not yet final"}
        </p>
      ) : null}
      {!t.hospitalConfirmed ? (
        <p className="no-print mb-3 text-center text-[11px] text-ink-3">
          Template v{t.version}: not yet confirmed as current by the Chief RT (Settings → PFT form template).
        </p>
      ) : null}
      <header className="text-center">
        {t.hasLogo ? (
          // eslint-disable-next-line @next/next/no-img-element -- authenticated, versioned image that must print exactly
          <img src={`/api/pft/logo/${t.id}`} alt={`${t.facilityHeader} logo`} className="mx-auto mb-1 h-16 w-auto print:h-[18mm]" />
        ) : null}
        <p className="text-[15px] font-bold">{t.facilityHeader}</p>
        {t.facilityAddress ? <p className="text-[11px] whitespace-pre-line">{t.facilityAddress}</p> : null}
        <h2 className="mt-3 text-[18px] font-bold tracking-[0.08em]">PULMONARY FUNCTION TEST</h2>
      </header>

      <div className="mt-3 max-w-[260px]">
        <Line label="DATE:" value={d.testDate ? formatLongDate(d.testDate) : ""} />
      </div>

      <h3 className="mt-4 text-[13px] font-bold tracking-[0.04em]">PATIENT INFORMATION</h3>
      <div className="mt-1 grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-12 print:grid-cols-12">
        <Line className="col-span-2 sm:col-span-6 print:col-span-6" label="Name:" value={d.patientName} />
        <Line className="sm:col-span-2 print:col-span-2" label="Sex:" value={sex} />
        <Line className="sm:col-span-1 print:col-span-1" label="Age:" value={d.ageText} />
        <Line className="col-span-2 sm:col-span-3 print:col-span-3" label="Birthdate:" value={d.birthdate ? formatLongDate(d.birthdate) : ""} />
        <Line className="col-span-2 sm:col-span-3 print:col-span-3" label="Hospital No.:" value={d.hospitalNumber} />
        <Line className="sm:col-span-3 print:col-span-3" label="Weight (kg):" value={d.weightKg} />
        <Line className="sm:col-span-3 print:col-span-3" label="Height (cm):" value={d.heightCm} />
        <Line className="col-span-2 sm:col-span-3 print:col-span-3" label="Room:" value={d.roomOrOpd} />
        <Line className="col-span-2 sm:col-span-8 print:col-span-8" label="Requesting Physician:" value={d.requestingPhysician} />
        <Line className="col-span-2 sm:col-span-4 print:col-span-4" label="HMO:" value={d.hmo} />
        <Line className="col-span-2 sm:col-span-12 print:col-span-12" label="Test Type:" value={d.testType} />
      </div>

      <div className="mt-3">
        <p className="text-[12px] font-semibold">Technician&apos;s comments:</p>
        <p className="min-h-10 border-b border-ink/40 px-1 text-[13px] whitespace-pre-wrap">{d.technicianComments || "\u00a0"}</p>
      </div>
      <Numbered n={1} label="Patient's spirometry Hx" value={d.spirometryHistory} />
      <Numbered n={2} label="Purpose of test" value={d.purposeOfTest} />
      <Numbered n={3} label="Patient's smoking Hx" value={d.smokingHistory} />
      <Numbered n={4} label="Patient's medication" value={d.medication} />
      <Numbered n={5} label="Patient observation" value={d.observation} />
      {t.bronchodilatorNote ? (
        <p className="mt-2 text-[12px] font-bold">
          6. {t.bronchodilatorNote}
          {!t.hospitalConfirmed ? <span className="no-print ml-1 font-normal text-ink-3">(form statement — Chief RT to confirm it is current)</span> : null}
        </p>
      ) : null}

      <h3 className="mt-4 text-[13px] font-bold tracking-[0.04em]">INTERPRETATION:</h3>
      <div className="mt-1 min-h-28 rounded-[4px] border border-ink/50 px-3 py-2 text-[13px] whitespace-pre-wrap print:min-h-[60mm]">
        {f.interpretation ?? <span className="no-print text-ink-3">Written by the pulmonologist.</span>}
      </div>

      <div className="mt-8 grid grid-cols-2 gap-8 text-center text-[12px]">
        <div>
          <p className="text-left text-[11px] font-bold">RTOD</p>
          <div className="flex min-h-10 items-end justify-center border-b border-ink">
            {f.rtSignature?.hasImage ? (
              // eslint-disable-next-line @next/next/no-img-element -- approved e-signature image, must print exactly
              <img
                src={`/api/signatory/${f.rtSignature.signatoryId}/signature`}
                alt={`E-signature of ${f.rtSignature.name}`}
                className="max-h-14 w-auto print:max-h-[16mm]"
              />
            ) : f.rtSignature ? (
              <span className="text-[10px] text-ink-2">Signed electronically {formatDateTime(new Date(f.rtSignature.signedIso))}</span>
            ) : null}
          </div>
          <p className="mt-1 font-semibold">{f.rtSignature?.name ?? "\u00a0"}</p>
          {f.rtSignature?.credentials ? <p className="text-[11px]">{f.rtSignature.credentials}</p> : null}
          <p className="text-[11px]">Respiratory Therapist</p>
        </div>
        <div>
          <p className="text-left text-[11px] font-bold">DOCTOR</p>
          <div className="flex min-h-10 items-end justify-center border-b border-ink">
            {f.pulmoSignoff?.method === "E_SIGNATURE_APPLIED_BY_RT" && f.pulmoSignoff.hasImage ? (
              // eslint-disable-next-line @next/next/no-img-element -- approved e-signature image, must print exactly
              <img
                src={`/api/signatory/${f.pulmoSignoff.signatoryId}/signature`}
                alt={`E-signature of ${f.pulmoSignoff.name}`}
                className="max-h-14 w-auto print:max-h-[16mm]"
              />
            ) : f.pulmoSignoff ? (
              <span className="text-[10px] text-ink-2">
                Signed on the printed copy · recorded {formatDateTime(new Date(f.pulmoSignoff.recordedIso))} by {f.pulmoSignoff.recordedBy}
              </span>
            ) : null}
          </div>
          <p className="mt-1 font-semibold">{f.pulmoSignoff?.name ?? "\u00a0"}</p>
          {f.pulmoSignoff?.credentials ? <p className="text-[11px]">{f.pulmoSignoff.credentials}</p> : null}
          <p className="text-[11px]">Pulmonologist</p>
          {f.pulmoSignoff?.method === "E_SIGNATURE_APPLIED_BY_RT" ? (
            <p className="text-[9px] text-ink-3">
              E-signature applied {formatDateTime(new Date(f.pulmoSignoff.recordedIso))} by {f.pulmoSignoff.recordedBy}
            </p>
          ) : null}
        </div>
      </div>

      {f.amendments.length ? (
        <section className="mt-6" aria-label="Amendments">
          <h3 className="text-[12px] font-bold uppercase tracking-[0.06em]">Amendments (appended after finalization)</h3>
          <ol className="mt-1 space-y-2">
            {f.amendments.map((a, i) => (
              <li key={a.id} className="rounded-[7px] border border-line px-3 py-2 text-[12px]">
                <p className="font-semibold">
                  {i + 1}. {SECTION_LABEL[a.section] ?? a.section} · {formatDateTime(new Date(a.createdIso))} · {a.createdBy}
                </p>
                <p className="whitespace-pre-wrap">{a.text}</p>
                <p className="text-ink-2">Reason: {a.reason}</p>
              </li>
            ))}
          </ol>
        </section>
      ) : null}

      <footer className="mt-6 flex justify-between text-[10px] text-ink-3">
        <span>{t.formCode}</span>
        <span>PUIMS record {f.id.slice(0, 8)}</span>
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
              <textarea className={`${inputCls} py-2`} rows={s.rows} maxLength={s.max} value={draft[s.key]} onChange={set(s.key)} />
            </label>
          ))}
          <p className="text-[12px] text-ink-3">The interpretation is written by the pulmonologist and recorded at sign-off.</p>
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
