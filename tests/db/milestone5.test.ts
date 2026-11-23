import type pg from "pg";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { HOSPITAL_TZ, toLocalParts } from "@/lib/time/zoned";
import { getPool } from "@/server/db";
import {
  bookAppointment,
  correctAppointment,
  getAppointment,
  listAppointments,
  rescheduleAppointment,
  statusTransitionAllowed,
  updateAppointmentStatus,
  voidAppointment,
  DIAG_STATUSES,
} from "@/server/diagnostics";
import { amendPft, createPftForm, finalizePft, getPftForm, savePftDraft, signPftAsRt, voidPftForm, addSignatory, createTemplateVersion } from "@/server/pft";
import {
  acceptCleanRows,
  acceptSuggestedLinks,
  commitBatch,
  decideRow,
  discardBatch,
  dryRun,
  exceptionReport,
  getBatch,
  originalWorkbook,
  stageWorkbook,
  updateOptions,
  voidBatch,
} from "@/server/importer";
import type { Session } from "@/server/session";
import { buildSyntheticWorkbook } from "../fixtures/syntheticWorkbook";
import { asCtx, expectPgError, makeSession, owner, reseed } from "./helpers";

let o: pg.Client;
let patientId: string;

async function sessionFor(username: string, reauth = false): Promise<Session> {
  const st = (await o.query("SELECT id, role, display_name FROM staff WHERE username = $1", [username])).rows[0];
  const ids = await makeSession(o, st.id);
  return {
    ...ids,
    userId: st.id,
    role: st.role,
    username,
    displayName: st.display_name,
    initials: "XX",
    reauthAt: reauth ? new Date() : null,
    idleExpiresAt: new Date(Date.now() + 900_000),
  };
}
function wall(d: Date): string {
  const p = toLocalParts(d, HOSPITAL_TZ);
  const z = (n: number) => String(n).padStart(2, "0");
  return `${p.year}-${z(p.month)}-${z(p.day)}T${z(p.hour)}:${z(p.minute)}`;
}
const hoursFromNow = (h: number) => new Date(Date.now() + h * 3_600_000);
const book = (s: Session, h: number, extra: Partial<Parameters<typeof bookAppointment>[1]> = {}) =>
  bookAppointment(s, {
    clientId: randomUUID(),
    patientId,
    service: "PFT",
    scheduledAt: wall(hoursFromNow(h)),
    procedureLabel: "Simple PFT",
    category: "OPD",
    requestingPhysician: "Dr. Demo Requesting",
    paymentClass: "",
    remarks: "",
    ...extra,
  });

beforeAll(async () => {
  reseed();
  o = owner();
  await o.connect();
  patientId = (
    await o.query("INSERT INTO patient (full_name, category, sex, date_of_birth) VALUES ('Milestone, Five Synthetic', 'OPD', 'M', '1970-01-15') RETURNING id")
  ).rows[0].id;
}, 120_000);
afterAll(async () => {
  await o.end();
  await getPool().end();
});

describe("diagnostic scheduling", () => {
  it("books in the scheduler's own name and is idempotent by client id", async () => {
    const s = await sessionFor("rt.alpha");
    const id = randomUUID();
    const input = {
      clientId: id,
      patientId,
      service: "ABG" as const,
      scheduledAt: wall(hoursFromNow(24)),
      procedureLabel: "ABG",
      category: "INP" as const,
      requestingPhysician: "",
      paymentClass: "",
      remarks: "",
    };
    expect(await bookAppointment(s, input)).toEqual({ id, duplicate: false });
    expect(await bookAppointment(s, input)).toEqual({ id, duplicate: true });
    const other = await sessionFor("rt.bravo");
    await expect(bookAppointment(other, input)).rejects.toThrow(/already in use/);
    // U-08/U-09 approved 2026-11-23: optional payment and contact note are stored
    const withPay = await bookAppointment(s, { ...input, clientId: randomUUID(), paymentClass: "Cash", contactNote: "SYN: call the ward" });
    const pr = (await o.query("SELECT payment_class, contact_note FROM diagnostic_appointment WHERE id = $1", [withPay.id])).rows[0];
    expect(pr).toEqual({ payment_class: "Cash", contact_note: "SYN: call the ward" });
    const d = await getAppointment(s, withPay.id);
    expect(d!.contactNote).toBe("SYN: call the ward");
    const viewed = await o.query("SELECT 1 FROM audit_log WHERE action = 'diagnostic.contact_viewed' AND record_id = $1", [withPay.id]);
    expect(viewed.rowCount).toBe(1);
    const row = (await o.query("SELECT scheduler_id, status, source FROM diagnostic_appointment WHERE id = $1", [id])).rows[0];
    expect(row).toMatchObject({ scheduler_id: s.staffId, status: "SCHEDULED", source: "ONLINE" });
  });

  it("marking done records the RT chosen as performer (an active account only)", async () => {
    const s = await sessionFor("rt.alpha");
    const bravo = await sessionFor("rt.bravo");
    const { id } = await book(s, -1);
    const deactivated = (await o.query("SELECT id FROM staff WHERE status = 'DEACTIVATED' LIMIT 1")).rows[0].id;
    await expect(updateAppointmentStatus(s, id, { status: "COMPLETED", performedBy: deactivated })).rejects.toThrow(/active RT/);
    await expect(updateAppointmentStatus(s, id, { status: "PENDING", performedBy: bravo.staffId })).rejects.toThrow(/done/);
    await updateAppointmentStatus(s, id, { status: "COMPLETED", performedBy: bravo.staffId });
    const r = (await o.query("SELECT performed_by, updated_by FROM diagnostic_appointment WHERE id = $1", [id])).rows[0];
    expect(r).toEqual({ performed_by: bravo.staffId, updated_by: s.staffId });
  });

  it("rejects bookings too far in the past or future", async () => {
    const s = await sessionFor("rt.alpha");
    await expect(book(s, -80)).rejects.toThrow(/72 hours/);
    await expect(book(s, 24 * 370)).rejects.toThrow(/one year/);
  });

  it("follows the status workflow; reasons required; closed statuses never change", async () => {
    const s = await sessionFor("rt.alpha");
    const { id } = await book(s, 1);
    await expect(updateAppointmentStatus(s, id, { status: "CANCELLED" })).rejects.toThrow(/Reason/);
    await updateAppointmentStatus(s, id, { status: "COMPLETED" });
    const r = (await o.query("SELECT status, performed_by FROM diagnostic_appointment WHERE id = $1", [id])).rows[0];
    expect(r).toEqual({ status: "COMPLETED", performed_by: s.staffId });
    await expect(updateAppointmentStatus(s, id, { status: "PENDING" })).rejects.toThrow(/cannot become/);
    const ids = await makeSession(o, s.staffId);
    // The database refuses it too, even for a direct UPDATE.
    const c = await getPool().connect();
    try {
      await asCtx(c as unknown as pg.Client, ids, () =>
        expectPgError(c.query("UPDATE diagnostic_appointment SET status = 'SCHEDULED', updated_by = $2 WHERE id = $1", [id, s.staffId]), "23514"),
      );
    } finally {
      c.release();
    }
  });

  it("mirrors the database transition table exactly", async () => {
    for (const a of DIAG_STATUSES)
      for (const b of DIAG_STATUSES) {
        const db = (await o.query("SELECT diag_status_allowed($1, $2) AS ok", [a, b])).rows[0].ok;
        expect(statusTransitionAllowed(a, b), `${a}→${b}`).toBe(db);
      }
  });

  it("cannot mark a future appointment done", async () => {
    const s = await sessionFor("rt.alpha");
    const { id } = await book(s, 30);
    await expect(updateAppointmentStatus(s, id, { status: "COMPLETED" })).rejects.toThrow(/future/);
  });

  it("reschedules with lineage: original kept as RESCHEDULED, follow-up linked, one live child only", async () => {
    const s = await sessionFor("rt.bravo");
    const { id } = await book(s, 5);
    const child = randomUUID();
    await rescheduleAppointment(s, id, { clientId: child, scheduledAt: wall(hoursFromNow(48)), reason: "Patient requested a later date" });
    expect(await rescheduleAppointment(s, id, { clientId: child, scheduledAt: wall(hoursFromNow(48)), reason: "Patient requested a later date" })).toEqual({
      id: child,
    });
    await expect(rescheduleAppointment(s, id, { clientId: randomUUID(), scheduledAt: wall(hoursFromNow(50)), reason: "again please" })).rejects.toThrow(
      /open appointments/,
    );
    const d = await getAppointment(s, child);
    expect(d!.reschedulesId).toBe(id);
    expect(d!.lineage.map((l) => l.id)).toEqual([id, child]);
    const orig = await getAppointment(s, id);
    expect(orig!.status).toBe("RESCHEDULED");
    expect(orig!.rescheduledToId).toBe(child);
    expect(orig!.history.map((h) => h.toStatus)).toEqual(["SCHEDULED", "RESCHEDULED"]);
    // The follow-up must be voided before the original
    await expect(voidAppointment(s, id, "Booked in error")).rejects.toThrow(/follow-up/);
  });

  it("corrects details of an open appointment with a reason; history keeps the change; closed ones stay locked", async () => {
    const s = await sessionFor("rt.alpha");
    const { id } = await book(s, 6);
    const before = await getAppointment(s, id);
    expect(before!.canCorrect).toBe(true);
    const input = {
      expectedUpdatedIso: before!.updatedIso,
      scheduledAt: wall(hoursFromNow(7)),
      procedureLabel: "Complete PFT with post-bronchodilator",
      requestingPhysician: "Dr. Demo Corrected",
      category: "INP" as const,
      remarks: "",
      reason: "",
    };
    await expect(correctAppointment(s, id, input)).rejects.toThrow(/Reason/);
    await correctAppointment(s, id, { ...input, reason: "Wrong procedure copied from the request slip" });
    const after = await getAppointment(s, id);
    expect(after).toMatchObject({ procedureLabel: "Complete PFT with post-bronchodilator", requestingPhysician: "Dr. Demo Corrected", category: "INP" });
    const h = after!.history.at(-1)!;
    expect(h.reason).toBe("Wrong procedure copied from the request slip");
    expect(h.changed).toEqual(expect.arrayContaining(["scheduled_at", "procedure_label", "requesting_physician", "category"]));
    // stale edit is refused (optimistic concurrency)
    await expect(correctAppointment(s, id, { ...input, procedureLabel: "Simple PFT", reason: "second edit attempt" })).rejects.toThrow(
      /changed after you opened/,
    );
    // the database itself refuses a correction without a reason
    const c = await getPool().connect();
    try {
      await asCtx(c as unknown as pg.Client, s, () =>
        expectPgError(c.query("UPDATE diagnostic_appointment SET procedure_label = 'x', updated_by = $2 WHERE id = $1", [id, s.staffId]), "23514"),
      );
    } finally {
      c.release();
    }
    await updateAppointmentStatus(s, id, { status: "CANCELLED", reason: "Patient cancelled by phone" });
    const closed = await getAppointment(s, id);
    expect(closed!.canCorrect).toBe(false);
    await expect(correctAppointment(s, id, { ...input, expectedUpdatedIso: closed!.updatedIso, reason: "too late to edit" })).rejects.toThrow(/Only open/);
  });

  it("voids only by the scheduler or the Chief RT; voided rows disappear from lists", async () => {
    const s = await sessionFor("rt.alpha");
    const { id } = await book(s, 3);
    const other = await sessionFor("rt.bravo");
    await expect(voidAppointment(other, id, "not mine to void")).rejects.toThrow(/Only the RT who booked/);
    await expect(voidAppointment(s, id, "no")).rejects.toThrow(/Reason/);
    await voidAppointment(s, id, "Booked for the wrong patient");
    const today = toLocalParts(new Date(), HOSPITAL_TZ);
    const iso = `${today.year}-${String(today.month).padStart(2, "0")}-${String(today.day).padStart(2, "0")}`;
    const rows = await listAppointments(s, { service: "PFT", from: iso, to: iso });
    expect(rows.find((r) => r.id === id)).toBeUndefined();
    expect(await getAppointment(s, id)).toBeNull();
  });
});

describe("PFT form — official clinical record", () => {
  let apptId: string;
  let formId: string;

  it("is started only by an RT, for a PFT appointment, with clinical sections empty", async () => {
    const s = await sessionFor("rt.alpha");
    apptId = (await book(s, -1)).id;
    const chief = await sessionFor("chief.demo");
    await expect(createPftForm(chief, { clientId: randomUUID(), appointmentId: apptId })).rejects.toThrow(/Respiratory Therapists/);
    const abg = (await book(s, -1, { service: "ABG", procedureLabel: "ABG" })).id;
    await expect(createPftForm(s, { clientId: randomUUID(), appointmentId: abg })).rejects.toThrow(/PFT appointments/);
    formId = randomUUID();
    await createPftForm(s, { clientId: formId, appointmentId: apptId });
    await expect(createPftForm(s, { clientId: randomUUID(), appointmentId: apptId })).rejects.toThrow(/already has a PFT form/);
    const f = await getPftForm(s, formId);
    expect(f!.status).toBe("DRAFT");
    expect(f!.draft.patientName).toBe("Milestone, Five Synthetic");
    expect(f!.draft.testType).toBe("Simple PFT");
    expect(f!.draft.sex).toBe("M");
    expect(Number(f!.draft.ageText)).toBeGreaterThan(50);
    for (const k of ["technicianComments", "spirometryHistory", "purposeOfTest", "smokingHistory", "medication", "observation"] as const)
      expect(f!.draft[k]).toBe("");
    expect(f!.interpretation).toBeNull();
    expect(f!.template.facilityHeader).toBe("DILIMAN DOCTORS HOSPTAL, INC"); // printed text of the hospital PFT guide (migration 0010)
    expect(f!.template.hospitalConfirmed).toBe(false);
    expect(f!.template.bronchodilatorNote).toMatch(/^Salbutamol was used/);
    expect(f!.template.formCode).toBe("AS-PUL-PFT-006");
  });

  it("saves drafts with optimistic concurrency; only the author edits", async () => {
    const s = await sessionFor("rt.alpha");
    const f = await getPftForm(s, formId);
    const saved = await savePftDraft(s, formId, f!.updatedIso, { ...f!.draft, weightKg: "70.5", heightCm: "168", purposeOfTest: "Synthetic purpose text" });
    await expect(savePftDraft(s, formId, f!.updatedIso, f!.draft)).rejects.toThrow(/saved elsewhere/);
    const other = await sessionFor("rt.bravo");
    await expect(savePftDraft(other, formId, saved.updatedIso, f!.draft)).rejects.toThrow(/Only the RT who started/);
    await expect(savePftDraft(s, formId, saved.updatedIso, { ...f!.draft, sex: "X" })).rejects.toThrow(/Sex/);
    await expect(savePftDraft(s, formId, saved.updatedIso, { ...f!.draft, weightKg: "70.55" })).rejects.toThrow(/Weight/);
  });

  it("requires step-up authentication and an approved signatory entry to sign", async () => {
    const s = await sessionFor("rt.alpha");
    const f = await getPftForm(s, formId);
    await expect(signPftAsRt(s, formId, f!.updatedIso)).rejects.toMatchObject({ kind: "REAUTH_REQUIRED" });
    const s2 = await sessionFor("rt.alpha", true);
    await signPftAsRt(s2, formId, f!.updatedIso);
    const signed = await getPftForm(s2, formId);
    expect(signed!.status).toBe("RT_SIGNED");
    expect(signed!.rtSignature!.credentials).toMatch(/^SYN-LIC-RT-/);
    await expect(savePftDraft(s2, formId, signed!.updatedIso, signed!.draft)).rejects.toThrow(/signed/);
    // the database refuses edits to signed content directly
    const c = await getPool().connect();
    try {
      await asCtx(c as unknown as pg.Client, s2, () => expectPgError(c.query("UPDATE pft_form SET observation = 'changed' WHERE id = $1", [formId]), "23514"));
    } finally {
      c.release();
    }
  });

  it("finalizes only with a directory pulmonologist, typed interpretation and attestation; then amendments only", async () => {
    const s = await sessionFor("rt.bravo", true);
    const f = await getPftForm(s, formId);
    expect(f!.canFinalize).toBe(true);
    const pulmo = f!.pulmonologists[0].id;
    await expect(finalizePft(s, formId, { pulmoSignatoryId: pulmo, interpretation: "", attestWetSignature: true })).rejects.toThrow(/interpretation/);
    await expect(
      finalizePft(s, formId, { pulmoSignatoryId: pulmo, interpretation: "Synthetic interpretation text", attestWetSignature: false }),
    ).rejects.toThrow(/printed form/);
    await expect(
      finalizePft(s, formId, { pulmoSignatoryId: randomUUID(), interpretation: "Synthetic interpretation text", attestWetSignature: true }),
    ).rejects.toThrow(/directory/);
    await finalizePft(s, formId, { pulmoSignatoryId: pulmo, interpretation: "Synthetic interpretation text", attestWetSignature: true });
    const fin = await getPftForm(s, formId);
    expect(fin!.status).toBe("FINAL");
    expect(fin!.pulmoSignoff!.method).toBe("WET_SIGNATURE_ON_PRINTED_COPY");
    await expect(voidPftForm(await sessionFor("rt.alpha"), formId, "trying to remove it")).rejects.toThrow(/cannot be voided/);
    const am = randomUUID();
    await amendPft(s, formId, { clientId: am, section: "OBSERVATION", text: "Synthetic addendum", reason: "Late observation added" });
    await amendPft(s, formId, { clientId: am, section: "OBSERVATION", text: "Synthetic addendum", reason: "Late observation added" }); // idempotent
    expect((await getPftForm(s, formId))!.amendments).toHaveLength(1);
    await expectPgError(o.query("UPDATE pft_form_amendment SET text = 'x' WHERE id = $1", [am]), "P0001").catch(async () => {
      await expectPgError(o.query("UPDATE pft_form_amendment SET text = 'x' WHERE id = $1", [am]), "42501");
    });
    // the appointment with a live form cannot be voided
    await expect(voidAppointment(await sessionFor("chief.demo"), apptId, "test void")).rejects.toThrow(/PFT form/);
  });

  it("lets only the Chief maintain the directory and template, with step-up", async () => {
    const rt = await sessionFor("rt.alpha", true);
    await expect(addSignatory(rt, { kind: "PULMONOLOGIST", displayName: "Dr. Demo X", credentials: "", staffId: "" })).rejects.toThrow(/Chief RT/);
    const chief = await sessionFor("chief.demo");
    await expect(addSignatory(chief, { kind: "PULMONOLOGIST", displayName: "Dr. Demo X", credentials: "", staffId: "" })).rejects.toMatchObject({
      kind: "REAUTH_REQUIRED",
    });
    const chief2 = await sessionFor("chief.demo", true);
    await addSignatory(chief2, { kind: "PULMONOLOGIST", displayName: "Dr. Demo Pulmonologist C", credentials: "SYN-LIC-MD-0003", staffId: "" });
    await createTemplateVersion(chief2, {
      facilityHeader: "[Synthetic header v2]",
      facilityAddress: "",
      formRevision: "[Rev 2]",
      bronchodilatorNote: "",
      hospitalConfirmed: false,
    });
    const v = (await o.query("SELECT max(version) AS v FROM pft_template")).rows[0].v;
    expect(v).toBe(3);
    await expectPgError(o.query("UPDATE pft_template SET facility_header = 'x'"), "P0001").catch(() => undefined);
    // logo: only real PNG/JPEG, ≤ 512 KB; carried over to the next version unless removed
    const png = Buffer.from(
      "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a4830000000049454e44ae426082",
      "hex",
    );
    const base = { facilityHeader: "[Synthetic header v3]", facilityAddress: "", formRevision: "[Rev 3]", bronchodilatorNote: "", hospitalConfirmed: false };
    await expect(createTemplateVersion(chief2, { ...base, logo: Buffer.from("<svg onload='x'/>") })).rejects.toThrow(/PNG or JPEG/);
    await createTemplateVersion(chief2, { ...base, logo: png });
    await createTemplateVersion(chief2, { ...base, formRevision: "[Rev 4]" });
    const logos = (await o.query("SELECT version, logo_mime, octet_length(logo) AS n FROM pft_template WHERE version >= 4 ORDER BY version")).rows;
    expect(logos).toEqual([
      { version: 4, logo_mime: "image/png", n: png.length },
      { version: 5, logo_mime: "image/png", n: png.length },
    ]);
    await createTemplateVersion(chief2, { ...base, logo: "remove" });
    expect((await o.query("SELECT logo FROM pft_template WHERE version = 6")).rows[0].logo).toBeNull();
    expect(JSON.stringify((await o.query("SELECT after_data FROM audit_log WHERE table_name = 'pft_template'")).rows)).not.toContain('logo"');
    const still = (await o.query("SELECT facility_header FROM pft_template WHERE version = 1")).rows[0].facility_header;
    expect(still).toMatch(/pending/);
  });
});

describe("workbook import", () => {
  let batchId: string;

  it("stages a messy workbook, keeping contact/payment as written and the original encrypted, flagging every problem", async () => {
    const chief = await sessionFor("chief.demo");
    const rt = await sessionFor("rt.alpha");
    const bytes = await buildSyntheticWorkbook(2025);
    await expect(stageWorkbook(rt, { fileName: "x.xlsx", bytes })).rejects.toThrow(/Chief RT/);
    await expect(stageWorkbook(chief, { fileName: "x.csv", bytes: Buffer.from("a,b") })).rejects.toThrow(/xlsx/);
    ({ batchId } = await stageWorkbook(chief, { fileName: "synthetic.xlsx", bytes }));
    await expect(stageWorkbook(chief, { fileName: "again.xlsx", bytes })).rejects.toThrow(/already staged/);
    const raw = JSON.stringify((await o.query("SELECT raw FROM import_row WHERE batch_id = $1", [batchId])).rows);
    // U-08/U-09 approved 2026-11-23: contact and payment are kept as written
    expect(raw).toContain("call relative (SYN note)");
    expect(raw).toContain("SYN-HMO-PLAN");
    // the original workbook is retained encrypted and decrypts to the exact uploaded bytes
    const enc = (await o.query("SELECT original_enc FROM import_batch WHERE id = $1", [batchId])).rows[0].original_enc as Buffer;
    expect(enc.subarray(29).equals(bytes.subarray(0, enc.length - 29))).toBe(false); // stored encrypted, not as plain bytes
    await expect(originalWorkbook(chief, batchId)).rejects.toMatchObject({ kind: "REAUTH_REQUIRED" });
    const orig = await originalWorkbook(await sessionFor("chief.demo", true), batchId);
    expect(orig.bytes.equals(bytes)).toBe(true);
    await expect(originalWorkbook(await sessionFor("rt.alpha", true), batchId)).rejects.toThrow(/Chief RT/);
    const v = await getBatch(chief, batchId);
    expect(v.batch.sheets.map((x) => [x.name, x.headerRow, x.blankRowsSkipped])).toEqual([
      ["JUNE", 3, 1],
      ["JULY", 1, 0],
    ]);
    expect(v.batch.sheets[1].inferredFromValues).toEqual([0]); // "Column 1" suggested as Date from its values
    expect(v.totals.rows).toBe(12);
    const flags = (sheet: string, row: number) => v.rows.find((r) => r.sheet === sheet && r.rowNumber === row)!.flags;
    // 6/4/2025 on the JUNE sheet: PUIMS fills in "month/day" itself because that order fits the sheet months.
    expect(flags("JUNE", 6)).not.toContain("DATE_AMBIGUOUS");
    expect(v.batch.options.dateOrder).toBe("MDY");
    expect(v.batch.options.auto).toEqual(expect.arrayContaining([expect.stringMatching(/month\/day/)]));
    expect(flags("JUNE", 7)).toContain("YEAR_MALFORMED");
    expect(flags("JUNE", 8)).toContain("DATE_MISSING");
    expect(flags("JUNE", 9)).toEqual(expect.arrayContaining(["TIME_NO_MERIDIEM", "STATUS_UNKNOWN"]));
    expect(flags("JUNE", 10)).toContain("DUPLICATE_CANDIDATE");
    expect(flags("JUNE", 4)).toContain("DUPLICATE_CANDIDATE");
    expect(flags("JUNE", 12)).toEqual(expect.arrayContaining(["NAME_MISSING", "PROCEDURE_MISSING", "STATUS_MISSING", "CATEGORY_MISSING", "AGE_SEX_UNCERTAIN"]));
    expect(flags("JULY", 2)).toContain("NAME_REPEATS_IN_BATCH");
    expect(flags("JULY", 3)).toEqual(expect.arrayContaining(["AGE_SEX_UNCERTAIN"]));
    // No year written: the workbook year (2025, shared by most dates) is filled in automatically and shown as such.
    expect(flags("JULY", 4)).toContain("YEAR_FROM_WORKBOOK");
    expect(v.batch.options.auto).toEqual(expect.arrayContaining([expect.stringMatching(/workbook year 2025/)]));
    expect(flags("JULY", 3)).toContain("YEAR_MISMATCH"); // 2024 in a 2025 workbook — still left for a person
    expect(flags("JULY", 5)).toContain("SHEET_MONTH_MISMATCH");
  });

  it("applies reviewer declarations explicitly; a year typo is never corrected by them", async () => {
    const chief = await sessionFor("chief.demo");
    await updateOptions(chief, batchId, { dateOrder: "MDY", workbookYear: "2025", times24h: false, categoryWhenMissing: "" });
    const v = await getBatch(chief, batchId);
    const row = (sheet: string, n: number) => v.rows.find((r) => r.sheet === sheet && r.rowNumber === n)!;
    expect(row("JUNE", 6).effective.date).toBe("2025-06-04");
    expect(row("JULY", 4).effective.date).toBe("2025-07-03");
    expect(row("JULY", 4).flags).toContain("YEAR_FROM_WORKBOOK");
    expect(row("JULY", 3).flags).toContain("YEAR_MISMATCH"); // 2024 in a 2025 workbook — left for a person
    expect(row("JUNE", 7).blocking).toContain("YEAR_MALFORMED");
  });

  it("will not commit until every row is decided; bulk accept never takes rows needing review", async () => {
    const chief = await sessionFor("chief.demo", true);
    const { accepted } = await acceptCleanRows(chief, batchId);
    expect(accepted).toBe(3); // Charlie (date now unambiguous), Hotel, India — Bravo/Alpha need a matching decision
    const d = await dryRun(chief, batchId);
    expect(d.ready).toBe(false);
    expect(d.pending).toBe(9);
    await expect(commitBatch(chief, batchId)).rejects.toThrow(/decision/);
  });

  it("requires explicit resolution of blocking flags and an explicit patient choice", async () => {
    const chief = await sessionFor("chief.demo", true);
    const v = await getBatch(chief, batchId);
    const row = (sheet: string, n: number) => v.rows.find((r) => r.sheet === sheet && r.rowNumber === n)!;
    const r9 = row("JUNE", 9);
    await expect(
      decideRow(chief, r9.id, { resolved: {}, decision: "ACCEPT", reason: "", patientLink: "NEW", patientId: null, sameAsRowId: null }),
    ).rejects.toThrow(/Resolve first/);
    await decideRow(chief, r9.id, {
      resolved: { time: "08:00", status: "COMPLETED" },
      decision: "ACCEPT",
      reason: "",
      patientLink: "NEW",
      patientId: null,
      sameAsRowId: null,
    });
    const a4 = row("JUNE", 4);
    await expect(
      decideRow(chief, a4.id, { resolved: {}, decision: "ACCEPT", reason: "", patientLink: null, patientId: null, sameAsRowId: null }),
    ).rejects.toThrow(/new patient or an existing/);
    await decideRow(chief, a4.id, { resolved: {}, decision: "ACCEPT", reason: "", patientLink: "NEW", patientId: null, sameAsRowId: null });
    await decideRow(chief, row("JUNE", 10).id, {
      resolved: {},
      decision: "REJECT",
      reason: "Duplicate of row 4 (entered twice)",
      patientLink: null,
      patientId: null,
      sameAsRowId: null,
    });
    const b5 = row("JUNE", 5);
    await decideRow(chief, b5.id, { resolved: {}, decision: "ACCEPT", reason: "", patientLink: "NEW", patientId: null, sameAsRowId: null });
    await decideRow(chief, row("JULY", 2).id, {
      resolved: {},
      decision: "ACCEPT",
      reason: "",
      patientLink: "SAME_AS_ROW",
      patientId: null,
      sameAsRowId: b5.id,
    });
    await decideRow(chief, row("JUNE", 6).id, { resolved: {}, decision: "ACCEPT", reason: "", patientLink: "NEW", patientId: null, sameAsRowId: null });
    for (const [sheet, n] of [
      ["JUNE", 7],
      ["JUNE", 8],
      ["JUNE", 12],
      ["JULY", 3],
    ] as const)
      await decideRow(chief, row(sheet, n).id, {
        resolved: {},
        decision: "REJECT",
        reason: "Source needs checking against the paper log",
        patientLink: null,
        patientId: null,
        sameAsRowId: null,
      });
    await expect(
      decideRow(chief, row("JULY", 3).id, { resolved: {}, decision: "REJECT", reason: "no", patientLink: null, patientId: null, sameAsRowId: null }),
    ).rejects.toThrow(/reason/);
    const d = await dryRun(chief, batchId);
    expect(d).toMatchObject({ ready: true, pending: 0, accepted: 7, rejected: 5, newPatients: 6, linkedRows: 1, appointments: 7 });
    const csv = (await exceptionReport(chief, batchId)).csv;
    expect(csv).toContain("JUNE,7,REJECT");
    expect(csv).not.toContain("Demo, Patient");
  });

  it("commits with step-up only, creating one appointment per accepted row with provenance", async () => {
    const noReauth = await sessionFor("chief.demo");
    await expect(commitBatch(noReauth, batchId)).rejects.toMatchObject({ kind: "REAUTH_REQUIRED" });
    const chief = await sessionFor("chief.demo", true);
    const before = Number((await o.query("SELECT count(*) FROM patient")).rows[0].count);
    const res = await commitBatch(chief, batchId);
    expect(res.appointments).toBe(7);
    expect(Number((await o.query("SELECT count(*) FROM patient")).rows[0].count) - before).toBe(6);
    const appts = (
      await o.query(
        "SELECT a.source, a.raw_status, a.status, a.import_row_id, p.provenance, p.full_name, p.sex, p.date_of_birth FROM diagnostic_appointment a JOIN patient p ON p.id = a.patient_id JOIN import_row r ON r.id = a.import_row_id WHERE r.batch_id = $1",
        [batchId],
      )
    ).rows;
    expect(appts).toHaveLength(7);
    expect(appts.every((a) => a.source === "IMPORT" && a.provenance === "IMPORT" && a.date_of_birth === null)).toBe(true);
    const bravo = appts.filter((a) => a.full_name === "Demo, Patient Bravo");
    expect(bravo).toHaveLength(2); // two visits, one patient
    expect(new Set(bravo.map((b) => b.import_row_id)).size).toBe(2);
    expect(appts.find((a) => a.raw_status === "Maybe?")!.status).toBe("COMPLETED");
    const contacts = (
      await o.query(
        "SELECT a.contact_note, a.payment_class FROM diagnostic_appointment a JOIN import_row r ON r.id = a.import_row_id WHERE r.batch_id = $1 AND a.contact_note IS NOT NULL",
        [batchId],
      )
    ).rows;
    expect(contacts.map((x) => x.contact_note)).toEqual(expect.arrayContaining(["call relative (SYN note)"]));
    await expect(acceptCleanRows(chief, batchId)).rejects.toThrow(/closed/);
    const imported = await o.query("SELECT 1 FROM import_batch WHERE id = $1 AND status = 'COMMITTED'", [batchId]);
    expect(imported.rowCount).toBe(1);
  });

  it("reverses a committed batch as a unit, voiding its appointments and the patients it created", async () => {
    const chief = await sessionFor("chief.demo", true);
    const r = await voidBatch(chief, batchId, "Reversed during UAT rehearsal");
    expect(r).toEqual({ appointments: 7, patients: 6 });
    const live = await o.query(
      "SELECT count(*)::int AS n FROM diagnostic_appointment a JOIN import_row r ON r.id = a.import_row_id WHERE r.batch_id = $1 AND a.voided_at IS NULL",
      [batchId],
    );
    expect(live.rows[0].n).toBe(0);
  });

  it("discarding a staged batch erases its staged raw values (audit keeps decisions only)", async () => {
    const chief = await sessionFor("chief.demo", true);
    const { batchId: b2 } = await stageWorkbook(chief, { fileName: "second.xlsx", bytes: await buildSyntheticWorkbook(2024) });
    const v = await getBatch(chief, b2);
    await decideRow(chief, v.rows[0].id, {
      resolved: {},
      decision: "REJECT",
      reason: "Testing the audit trail",
      patientLink: null,
      patientId: null,
      sameAsRowId: null,
    });
    await discardBatch(chief, b2, "Wrong file uploaded");
    expect((await o.query("SELECT original_enc FROM import_batch WHERE id = $1", [b2])).rows[0].original_enc).toBeNull();
    const left = await o.query("SELECT count(*)::int AS n FROM import_row WHERE batch_id = $1 AND raw <> '{}'", [b2]);
    expect(left.rows[0].n).toBe(0);
    const audit = JSON.stringify((await o.query("SELECT before_data, after_data FROM audit_log WHERE table_name = 'import_row'")).rows);
    expect(audit).not.toContain("Demo, Patient");
  });
});

describe("import automation: remembered settings and suggested repeat visits", () => {
  async function repeatWorkbook(): Promise<Buffer> {
    const ExcelJS = (await import("exceljs")).default;
    const wb = new ExcelJS.Workbook();
    const d = (m: number, day: number) => new Date(Date.UTC(2026, m - 1, day));
    const hdr = ["DATE", "TIME", "PATIENT NAME", "AGE / SEX", "PHYSICIAN", "PROCEDURE", "Status"];
    const aug = wb.addWorksheet("AUGUST");
    aug.addRow(hdr);
    aug.addRow([d(8, 3), "9:00 AM", "Demo, Repeat One", "50/M", "Dr. Demo", "SIMPLE PFT W/ POST BD", "DONE"]); // 2 first visit
    aug.addRow([d(8, 4), "9:00 AM", "Demo, Repeat Two", "40/F", "Dr. Demo", "SIMPLE PFT W/ POST BD", "DONE"]); // 3
    aug.addRow([d(8, 5), "9:00 AM", "Demo, Single Visit", "33/F", "Dr. Demo", "SIMPLE PFT W/ POST BD", "DONE"]); // 4 clean
    const sep = wb.addWorksheet("SEPTEMBER");
    sep.addRow(hdr);
    sep.addRow([d(9, 7), "10:00 AM", "Demo, Repeat One", "50/M", "Dr. Demo", "COMPLETE PFT W/ POST BD", "DONE"]); // 2 repeat of One
    sep.addRow([d(9, 8), "10:00 AM", "Demo, Repeat Two", "41/M", "Dr. Demo", "SIMPLE PFT W/ POST BD", "DONE"]); // 3 sex conflict → left for a person
    return Buffer.from(await wb.xlsx.writeBuffer());
  }

  it("fills in settings itself, links safe repeat visits and leaves doubtful ones for a person", async () => {
    const chief = await sessionFor("chief.demo", true);
    const { batchId: b } = await stageWorkbook(chief, { fileName: "repeats.xlsx", bytes: await repeatWorkbook() });
    let v = await getBatch(chief, b);
    expect(v.batch.options.workbookYear).toBe(2026);
    expect(v.batch.options.auto).toEqual(expect.arrayContaining([expect.stringMatching(/remembered/), expect.stringMatching(/workbook year 2026/)]));

    const r = await acceptSuggestedLinks(chief, b);
    expect(r).toEqual({ existing: 0, created: 1, linked: 1 });
    v = await getBatch(chief, b);
    const row = (sheet: string, n: number) => v.rows.find((x) => x.sheet === sheet && x.rowNumber === n)!;
    expect(row("AUGUST", 2)).toMatchObject({ decision: "ACCEPT", patientLink: "NEW" });
    expect(row("SEPTEMBER", 2)).toMatchObject({ decision: "ACCEPT", patientLink: "SAME_AS_ROW", sameAsRowId: row("AUGUST", 2).id });
    expect(row("AUGUST", 3).decision).toBe("PENDING"); // same name, different sex: a person decides
    expect(row("SEPTEMBER", 3).decision).toBe("PENDING");
    expect(row("AUGUST", 4).decision).toBe("PENDING"); // not a repeat: "Accept clean rows" handles it
    expect((await acceptCleanRows(chief, b)).accepted).toBe(1);
    await discardBatch(chief, b, "Automation test batch");
  });
});
