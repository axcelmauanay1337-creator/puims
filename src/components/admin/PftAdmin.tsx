"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import type { AdminResult } from "@/app/actions/admin";
import {
  addSignatoryAction,
  completeSignatoryAction,
  confirmStepUpAction,
  deactivateSignatoryAction,
  decideProposalAction,
  templateAction,
} from "@/app/actions/diagnostics";
import { inputCls, labelCls } from "@/components/clinical/fields";
import { Badge } from "@/components/ui/primitives";
import { formatDateTime } from "@/lib/time/zoned";
import { ResultNote, useSensitiveAction } from "./useSensitiveAction";

interface Template {
  id: string;
  hasLogo: boolean;
  version: number;
  formCode: string;
  facilityHeader: string;
  facilityAddress: string | null;
  formRevision: string;
  bronchodilatorNote: string | null;
  hospitalConfirmed: boolean;
  createdIso: string;
}
interface Signatory {
  id: string;
  kind: "RESPIRATORY_THERAPIST" | "PULMONOLOGIST";
  displayName: string;
  credentials: string | null;
  staffId: string | null;
  username: string | null;
  active: boolean;
  hasSignature: boolean;
  source: string | null;
}

const btn = "inline-flex min-h-10 items-center rounded-[7px] border border-line bg-surface px-3 text-[13px] font-medium hover:bg-hover disabled:opacity-60";
const btnPrimary =
  "inline-flex min-h-10 items-center rounded-[7px] border border-accent bg-accent px-4 text-[13px] font-semibold text-white hover:bg-accent-hover disabled:opacity-60";

export function PftTemplateAdmin({ current, editable }: { current: Template; editable: boolean }) {
  const router = useRouter();
  const { run, busy, element } = useSensitiveAction();
  const [result, setResult] = useState<AdminResult | null>(null);
  const [logoFile, setLogoFile] = useState<File | null>(null);
  const [removeLogo, setRemoveLogo] = useState(false);
  const [preview, setPreview] = useState<string | null>(null);
  const [v, setV] = useState({
    facilityHeader: current.facilityHeader,
    facilityAddress: current.facilityAddress ?? "",
    formRevision: current.formRevision,
    bronchodilatorNote: current.bronchodilatorNote ?? "",
    hospitalConfirmed: current.hospitalConfirmed,
  });
  return (
    <div className="text-[13px]">
      {element}
      <dl className="space-y-1">
        <div>
          <dt className="inline text-ink-3">Current version: </dt>
          <dd className="inline">
            v{current.version} · {current.formCode} · created {formatDateTime(new Date(current.createdIso))}{" "}
            {current.hospitalConfirmed ? <Badge tone="success">hospital-confirmed</Badge> : <Badge tone="warning">not yet confirmed as current</Badge>}
          </dd>
        </div>
      </dl>
      <div className="mt-2 flex items-center gap-3">
        {current.hasLogo ? (
          // eslint-disable-next-line @next/next/no-img-element -- authenticated, versioned image; next/image optimisation not wanted
          <img
            src={`/api/pft/logo/${current.id}`}
            alt="Current hospital logo on the PFT form"
            className="h-14 w-auto rounded border border-line bg-white p-1"
          />
        ) : (
          <span className="text-[12px] text-ink-3">No logo on the form yet.</span>
        )}
      </div>
      {editable ? <GuideUpload run={run} busy={busy} onDone={(r) => (setResult(r), r.ok && router.refresh())} /> : null}
      {editable ? (
        <form
          className="mt-3 space-y-3"
          onSubmit={async (e) => {
            e.preventDefault();
            const fd = new FormData();
            fd.set("facilityHeader", v.facilityHeader);
            fd.set("facilityAddress", v.facilityAddress);
            fd.set("formRevision", v.formRevision);
            fd.set("bronchodilatorNote", v.bronchodilatorNote);
            if (v.hospitalConfirmed) fd.set("hospitalConfirmed", "on");
            if (logoFile) fd.set("logo", logoFile);
            else if (removeLogo) fd.set("removeLogo", "on");
            const r = await run(() => templateAction(fd) as Promise<AdminResult>);
            setResult(r);
            if (r.ok) router.refresh();
          }}
        >
          <label className={labelCls}>
            Facility header
            <input className={inputCls} value={v.facilityHeader} onChange={(e) => setV({ ...v, facilityHeader: e.target.value })} required maxLength={200} />
          </label>
          <label className={labelCls}>
            Address / trunkline <span className="font-normal text-ink-3">(one line each)</span>
            <textarea
              className={`${inputCls} py-2`}
              rows={2}
              value={v.facilityAddress}
              onChange={(e) => setV({ ...v, facilityAddress: e.target.value })}
              maxLength={300}
            />
          </label>
          <label className={labelCls}>
            Hospital logo <span className="font-normal text-ink-3">(official PNG or JPEG, up to 512 KB; prints at the top of the PFT form)</span>
            <input
              className={`${inputCls} py-2`}
              type="file"
              accept="image/png,image/jpeg"
              onChange={(e) => {
                const f = e.target.files?.[0] ?? null;
                setLogoFile(f);
                setPreview(f ? URL.createObjectURL(f) : null);
                if (f) setRemoveLogo(false);
              }}
            />
          </label>
          {preview ? (
            // eslint-disable-next-line @next/next/no-img-element -- local preview of the chosen file
            <img src={preview} alt="New logo preview" className="h-14 w-auto rounded border border-line bg-white p-1" />
          ) : null}
          {current.hasLogo && !logoFile ? (
            <label className="flex items-start gap-2">
              <input type="checkbox" className="mt-1" checked={removeLogo} onChange={(e) => setRemoveLogo(e.target.checked)} />
              <span>Remove the logo in the new version</span>
            </label>
          ) : null}
          <label className={labelCls}>
            Form revision
            <input className={inputCls} value={v.formRevision} onChange={(e) => setV({ ...v, formRevision: e.target.value })} required maxLength={60} />
          </label>
          <label className={labelCls}>
            Bronchodilator statement from the source template{" "}
            <span className="font-normal text-ink-3">(leave empty to omit; include only if the hospital confirms it is current)</span>
            <textarea
              className={`${inputCls} py-2`}
              rows={2}
              value={v.bronchodilatorNote}
              onChange={(e) => setV({ ...v, bronchodilatorNote: e.target.value })}
              maxLength={400}
            />
          </label>
          <label className="flex items-start gap-2">
            <input type="checkbox" className="mt-1" checked={v.hospitalConfirmed} onChange={(e) => setV({ ...v, hospitalConfirmed: e.target.checked })} />
            <span>The hospital has confirmed this header, revision and statement for production use.</span>
          </label>
          <ResultNote result={result} />
          <button type="submit" className={btnPrimary} disabled={busy}>
            Save as new version…
          </button>
          <p className="text-[11px] text-ink-3">Versions are never edited. Existing forms keep the version they were made with.</p>
        </form>
      ) : null}
    </div>
  );
}

type Proposal = { id: string; kind: "RESPIRATORY_THERAPIST" | "PULMONOLOGIST"; displayName: string | null; source: string };
type Rt = { id: string; displayName: string; username: string };

function SigThumb({ src, alt }: { src: string; alt: string }) {
  // eslint-disable-next-line @next/next/no-img-element -- authenticated image served by PUIMS
  return <img src={src} alt={alt} className="h-10 w-auto max-w-[140px] rounded border border-line bg-white object-contain p-0.5" />;
}

export function SignatoryDirectory({
  signatories,
  proposals,
  activeRts,
  editable,
}: {
  signatories: Signatory[];
  proposals: Proposal[];
  activeRts: Rt[];
  editable: boolean;
}) {
  const router = useRouter();
  const { run, busy, element } = useSensitiveAction();
  const [result, setResult] = useState<AdminResult | null>(null);
  const [kind, setKind] = useState<"RESPIRATORY_THERAPIST" | "PULMONOLOGIST">("PULMONOLOGIST");
  const [name, setName] = useState("");
  const [cred, setCred] = useState("");
  const [staffId, setStaffId] = useState("");
  const [sigFile, setSigFile] = useState<File | null>(null);
  const linked = new Set(signatories.filter((s) => s.active && s.staffId).map((s) => s.staffId));
  const freeRts = activeRts.filter((r) => !linked.has(r.id));
  const done = (r: AdminResult) => {
    setResult(r);
    if (r.ok) router.refresh();
  };
  return (
    <div className="text-[13px]">
      {element}
      <ResultNote result={result} />
      {editable && proposals.length ? (
        <section className="mb-3 rounded-[7px] border border-warning bg-warning-soft p-3" aria-label="Signatures found in the PFT guide workbook">
          <p className="font-semibold">Signatures found in the PFT guide workbook ({proposals.length})</p>
          <p className="text-[12px] text-ink-2">
            Each image and the name written under it, exactly as in the workbook. Add the ones that are approved signatories; dismiss decorations or duplicates.
          </p>
          <ul className="mt-2 divide-y divide-line-soft">
            {proposals.map((p) => (
              <ProposalRow key={p.id} p={p} freeRts={freeRts} busy={busy} onDone={done} run={run} />
            ))}
          </ul>
        </section>
      ) : null}
      <ul className="divide-y divide-line-soft">
        {signatories.map((s) => (
          <li key={s.id} className="flex flex-wrap items-center gap-2 py-2" data-testid="signatory-row">
            {s.hasSignature ? <SigThumb src={`/api/signatory/${s.id}/signature`} alt={`E-signature of ${s.displayName}`} /> : null}
            <span className="font-medium">{s.displayName}</span>
            <Badge tone={s.kind === "PULMONOLOGIST" ? "info" : "neutral"}>{s.kind === "PULMONOLOGIST" ? "Pulmonologist" : "RT"}</Badge>
            {s.credentials ? <span className="text-ink-3">{s.credentials}</span> : null}
            {s.username ? (
              <span className="text-ink-3">· account {s.username}</span>
            ) : s.kind === "RESPIRATORY_THERAPIST" && s.active ? (
              <Badge tone="warning">no account linked</Badge>
            ) : null}
            {!s.hasSignature && s.active ? <span className="text-ink-3">· no e-signature</span> : null}
            {s.source ? <span className="text-[11px] text-ink-3">· {s.source}</span> : null}
            {!s.active ? <Badge>inactive</Badge> : null}
            {editable && s.active ? (
              <span className="ml-auto flex flex-wrap gap-2">
                {!s.hasSignature ? (
                  <label className={`${btn} min-h-8 cursor-pointer text-[12px]`}>
                    Add e-signature…
                    <input
                      type="file"
                      accept="image/png,image/jpeg"
                      className="sr-only"
                      onChange={async (e) => {
                        const f = e.target.files?.[0];
                        if (!f) return;
                        const fd = new FormData();
                        fd.set("signature", f);
                        done(await run(() => completeSignatoryAction(s.id, fd) as Promise<AdminResult>));
                      }}
                    />
                  </label>
                ) : null}
                {s.kind === "RESPIRATORY_THERAPIST" && !s.staffId && freeRts.length ? (
                  <select
                    aria-label={`Link ${s.displayName} to an RT account`}
                    className="min-h-8 rounded-[7px] border border-line px-2 text-[12px]"
                    defaultValue=""
                    onChange={async (e) => {
                      if (!e.target.value) return;
                      const fd = new FormData();
                      fd.set("staffId", e.target.value);
                      done(await run(() => completeSignatoryAction(s.id, fd) as Promise<AdminResult>));
                    }}
                  >
                    <option value="">Link RT account…</option>
                    {freeRts.map((r) => (
                      <option key={r.id} value={r.id}>
                        {r.displayName} ({r.username})
                      </option>
                    ))}
                  </select>
                ) : null}
                <button
                  type="button"
                  className={`${btn} min-h-8 text-[12px]`}
                  disabled={busy}
                  onClick={async () => {
                    if (!confirm(`Deactivate ${s.displayName}? Signed forms keep showing this entry.`)) return;
                    done(await run(() => deactivateSignatoryAction(s.id) as Promise<AdminResult>));
                  }}
                >
                  Deactivate
                </button>
              </span>
            ) : null}
          </li>
        ))}
      </ul>
      {editable ? (
        <form
          className="mt-3 grid gap-3 rounded-[7px] border border-line p-3 sm:grid-cols-2"
          onSubmit={async (e) => {
            e.preventDefault();
            const fd = new FormData();
            fd.set("kind", kind);
            fd.set("displayName", name);
            fd.set("credentials", cred);
            fd.set("staffId", kind === "RESPIRATORY_THERAPIST" ? staffId : "");
            if (sigFile) fd.set("signature", sigFile);
            const r = await run(() => addSignatoryAction(fd) as Promise<AdminResult>);
            done(r);
            if (r.ok) {
              setName("");
              setCred("");
              setStaffId("");
              setSigFile(null);
            }
          }}
        >
          <label className={labelCls}>
            Type
            <select className={inputCls} value={kind} onChange={(e) => setKind(e.target.value as typeof kind)}>
              <option value="PULMONOLOGIST">Pulmonologist</option>
              <option value="RESPIRATORY_THERAPIST">Respiratory Therapist</option>
            </select>
          </label>
          {kind === "RESPIRATORY_THERAPIST" ? (
            <label className={labelCls}>
              PUIMS account (the only account that can sign as this entry)
              <select
                className={inputCls}
                value={staffId}
                onChange={(e) => {
                  setStaffId(e.target.value);
                  const rt = activeRts.find((r) => r.id === e.target.value);
                  if (rt && !name) setName(rt.displayName);
                }}
              >
                <option value="">Link later…</option>
                {freeRts.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.displayName} ({r.username})
                  </option>
                ))}
              </select>
            </label>
          ) : (
            <span />
          )}
          <label className={labelCls}>
            Name as it prints
            <input className={inputCls} value={name} onChange={(e) => setName(e.target.value)} required minLength={2} maxLength={120} />
          </label>
          <label className={labelCls}>
            Credentials / licence (as approved)
            <input className={inputCls} value={cred} onChange={(e) => setCred(e.target.value)} maxLength={120} />
          </label>
          <label className={`${labelCls} sm:col-span-2`}>
            E-signature image <span className="font-normal text-ink-3">(PNG or JPEG, ≤ 512 KB, optional — can be added later)</span>
            <input className={`${inputCls} py-2`} type="file" accept="image/png,image/jpeg" onChange={(e) => setSigFile(e.target.files?.[0] ?? null)} />
          </label>
          <div className="sm:col-span-2">
            <button type="submit" className={`${btnPrimary} mt-1`} disabled={busy}>
              Add to directory…
            </button>
            <p className="mt-1 text-[11px] text-ink-3">
              Entries are never edited — deactivate and add a new one. A signature or account link, once added, cannot be replaced.
            </p>
          </div>
        </form>
      ) : null}
    </div>
  );
}

function ProposalRow({
  p,
  freeRts,
  busy,
  onDone,
  run,
}: {
  p: Proposal;
  freeRts: Rt[];
  busy: boolean;
  onDone: (r: AdminResult) => void;
  run: ReturnType<typeof useSensitiveAction>["run"];
}) {
  const [name, setName] = useState("");
  const [staffId, setStaffId] = useState("");
  return (
    <li className="flex flex-wrap items-center gap-2 py-2" data-testid="signature-proposal">
      <SigThumb src={`/api/signatory/proposal/${p.id}`} alt={`Signature found at ${p.source}`} />
      <span className="font-medium">{p.displayName ?? <span className="text-ink-3">(no name under this image)</span>}</span>
      <Badge tone={p.kind === "PULMONOLOGIST" ? "info" : "neutral"}>{p.kind === "PULMONOLOGIST" ? "Pulmonologist" : "RT"}</Badge>
      <span className="text-[11px] text-ink-3">{p.source}</span>
      <span className="ml-auto flex flex-wrap items-center gap-2">
        {!p.displayName ? (
          <input
            aria-label="Name for this signature"
            placeholder="Name as it prints"
            className="min-h-8 rounded-[7px] border border-line px-2 text-[12px]"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        ) : null}
        {p.kind === "RESPIRATORY_THERAPIST" && freeRts.length ? (
          <select
            aria-label="RT account"
            className="min-h-8 rounded-[7px] border border-line px-2 text-[12px]"
            value={staffId}
            onChange={(e) => setStaffId(e.target.value)}
          >
            <option value="">Link account later</option>
            {freeRts.map((r) => (
              <option key={r.id} value={r.id}>
                {r.displayName} ({r.username})
              </option>
            ))}
          </select>
        ) : null}
        <button
          type="button"
          className={`${btnPrimary} min-h-8 text-[12px]`}
          disabled={busy || (!p.displayName && name.trim().length < 2)}
          onClick={async () => onDone(await run(() => decideProposalAction(p.id, true, { displayName: name, staffId }) as Promise<AdminResult>))}
        >
          Add…
        </button>
        <button
          type="button"
          className={`${btn} min-h-8 text-[12px]`}
          disabled={busy}
          onClick={async () => onDone(await run(() => decideProposalAction(p.id, false, {}) as Promise<AdminResult>))}
        >
          Dismiss
        </button>
      </span>
    </li>
  );
}

function GuideUpload({ run, busy, onDone }: { run: ReturnType<typeof useSensitiveAction>["run"]; busy: boolean; onDone: (r: AdminResult) => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [pending, setPending] = useState(false);
  return (
    <div className="mt-3 rounded-[7px] border border-accent bg-accent-soft p-3">
      <p className="font-semibold">Load from the hospital&apos;s PFT guide workbook</p>
      <p className="text-[12px] text-ink-2">
        Uses the workbook exactly as it is: logo, header, address, item 6 and form code become a new template version; signatures on the RT and Pulmo sheets are
        listed below for you to add. Nothing in the workbook is retyped or corrected. The file is not stored.
      </p>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <input aria-label="PFT guide workbook" type="file" accept=".xlsx" className="text-[12px]" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
        <button
          type="button"
          className={btnPrimary}
          disabled={!file || busy || pending}
          onClick={async () => {
            if (!file) return;
            const ok = await run(() => confirmStepUpAction() as Promise<AdminResult>);
            if (!ok.ok) return onDone(ok);
            setPending(true);
            const fd = new FormData();
            fd.set("file", file);
            try {
              const res = await fetch("/api/pft/guide", { method: "POST", body: fd });
              const j = (await res.json().catch(() => ({ error: res.status === 413 ? "The file is too large for this server." : "Upload failed." }))) as {
                version?: number;
                logo?: boolean;
                proposals?: number;
                error?: string;
              };
              onDone(
                res.ok
                  ? { ok: true, message: `Template v${j.version} created${j.logo ? " with the logo" : ""}; ${j.proposals} signature(s) found for review.` }
                  : { ok: false, error: j.error ?? "Could not load the workbook." },
              );
            } catch {
              onDone({ ok: false, error: "Could not reach the server. Nothing was changed." });
            } finally {
              setPending(false);
            }
          }}
        >
          {pending ? "Loading…" : "Load guide…"}
        </button>
      </div>
    </div>
  );
}
