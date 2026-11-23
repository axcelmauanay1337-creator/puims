import type pg from "pg";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { HOSPITAL_TZ, toLocalParts } from "@/lib/time/zoned";
import { getPool } from "@/server/db";
import { bookAppointment } from "@/server/diagnostics";
import { completeSignatory, createPftForm, decideProposal, finalizePft, getPftAdmin, getPftForm, signatureImage, signPftAsRt } from "@/server/pft";
import { extractGuide, importPftGuide } from "@/server/pftGuide";
import type { Session } from "@/server/session";
import { buildSyntheticGuide, solidPng } from "../fixtures/syntheticGuide";
import { expectPgError, makeSession, owner, reseed } from "./helpers";

let o: pg.Client;
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
const wall = (d: Date) => {
  const p = toLocalParts(d, HOSPITAL_TZ);
  const z = (n: number) => String(n).padStart(2, "0");
  return `${p.year}-${z(p.month)}-${z(p.day)}T${z(p.hour)}:${z(p.minute)}`;
};

beforeAll(async () => {
  reseed();
  o = owner();
  await o.connect();
}, 120_000);
afterAll(async () => {
  await o.end();
  await getPool().end();
});

describe("PFT guide workbook is used exactly as is", () => {
  it("extracts header lines, item 6, form code, logo and signatures without changing them", async () => {
    const g = await buildSyntheticGuide();
    const x = await extractGuide(g.bytes);
    expect(x.facilityHeader).toBe("SYNTHETIC DEMO HOSPTAL, INC"); // spelling kept as written
    expect(x.facilityAddress).toBe("1 DEMO AVE., DEMO CITY\nTRUNKLINE: (000) 0000-0000");
    expect(x.bronchodilatorNote).toBe("Salbutamol was used as the bronchodilator and administered via metered-dose inhaler (MDI).");
    expect(x.formCode).toBe("AS-PUL-PFT-006");
    expect(x.logo!.bytes.equals(g.logo)).toBe(true);
    expect(x.signatures).toHaveLength(2); // the logo copy on the RT sheet is not a signature
    const rt = x.signatures.find((s) => s.kind === "RESPIRATORY_THERAPIST")!;
    expect(rt.name).toBe("RT DEMO  SIGNER, RRT"); // double space kept
    expect(rt.bytes.equals(g.rtSig)).toBe(true);
    expect(x.signatures.find((s) => s.kind === "PULMONOLOGIST")!.name).toBe("Dr. Demo Pulmo Signer");
  });

  it("loads only for the Chief RT with step-up, creating a confirmed template and staged signatures", async () => {
    const g = await buildSyntheticGuide();
    await expect(importPftGuide(await sessionFor("rt.alpha", true), g.bytes)).rejects.toThrow(/Chief RT/);
    await expect(importPftGuide(await sessionFor("chief.demo"), g.bytes)).rejects.toMatchObject({ kind: "REAUTH_REQUIRED" });
    const chief = await sessionFor("chief.demo", true);
    const r = await importPftGuide(chief, g.bytes);
    expect(r).toMatchObject({ logo: true, proposals: 2 });
    const t = (
      await o.query("SELECT facility_header, facility_address, bronchodilator_note, hospital_confirmed, logo FROM pft_template WHERE version = $1", [r.version])
    ).rows[0];
    expect(t.facility_header).toBe("SYNTHETIC DEMO HOSPTAL, INC");
    expect(t.hospital_confirmed).toBe(true);
    expect((t.logo as Buffer).equals(g.logo)).toBe(true);
    const audit = JSON.stringify((await o.query("SELECT after_data FROM audit_log WHERE table_name IN ('signatory_proposal', 'pft_template')")).rows);
    expect(audit).not.toContain("signature_image");
    await expect(extractGuide(Buffer.from("PK not really"))).rejects.toThrow(/Excel/);
  });

  it("adds accepted signatures to the directory unchanged; once set they cannot be replaced", async () => {
    const chief = await sessionFor("chief.demo", true);
    const admin = await getPftAdmin(chief);
    const p = admin.proposals.find((x) => x.kind === "PULMONOLOGIST")!;
    await decideProposal(chief, p.id, { accept: true });
    const entry = (await getPftAdmin(chief)).signatories.find((s) => s.displayName === "Dr. Demo Pulmo Signer")!;
    expect(entry.hasSignature).toBe(true);
    expect(entry.source).toMatch(/^PFT guide workbook · Pulmo Signature!B3/);
    const img = await signatureImage(await sessionFor("rt.alpha"), entry.id);
    expect(img!.bytes.equals((await buildSyntheticGuide()).pulmoSig)).toBe(true);
    await expect(completeSignatory(chief, entry.id, { signature: solidPng(1, 2, 3) })).rejects.toThrow(/already has a signature/);
    await expectPgError(o.query("UPDATE signatory SET signature_image = $2 WHERE id = $1", [entry.id, solidPng(9, 9, 9)]), "23514");
    const rtp = admin.proposals.find((x) => x.kind === "RESPIRATORY_THERAPIST")!;
    await decideProposal(chief, rtp.id, { accept: false });
    expect((await getPftAdmin(chief)).proposals).toHaveLength(0);
  });
});

describe("pulmonologist e-signature on the PFT record", () => {
  it("finalizes with the approved e-signature (refused when the pulmonologist has none)", async () => {
    const rt = await sessionFor("rt.alpha", true);
    const patient = (await o.query("INSERT INTO patient (full_name, category) VALUES ('Esign, Synthetic', 'OPD') RETURNING id")).rows[0].id;
    const appt = randomUUID();
    await bookAppointment(rt, {
      clientId: appt,
      patientId: patient,
      service: "PFT",
      scheduledAt: wall(new Date(Date.now() - 3_600_000)),
      procedureLabel: "Simple PFT",
      category: "OPD",
      requestingPhysician: "",
      paymentClass: "",
      remarks: "",
    });
    const formId = randomUUID();
    await createPftForm(rt, { clientId: formId, appointmentId: appt });
    // the RT's own signature image prints when they sign
    const chief = await sessionFor("chief.demo", true);
    const mine = (await getPftAdmin(chief)).signatories.find((s) => s.staffId === rt.staffId)!;
    await completeSignatory(chief, mine.id, { signature: solidPng(5, 5, 5) });
    await signPftAsRt(rt, formId, (await getPftForm(rt, formId))!.updatedIso);
    expect((await getPftForm(rt, formId))!.rtSignature!.hasImage).toBe(true);

    const f = (await getPftForm(rt, formId))!;
    const without = f.pulmonologists.find((p) => !p.hasSignature)!;
    const withSig = f.pulmonologists.find((p) => p.hasSignature)!;
    await expect(
      finalizePft(rt, formId, {
        pulmoSignatoryId: without.id,
        interpretation: "Synthetic reading",
        attestWetSignature: true,
        method: "E_SIGNATURE_APPLIED_BY_RT",
      }),
    ).rejects.toThrow(/no approved e-signature/);
    await expect(
      finalizePft(rt, formId, {
        pulmoSignatoryId: withSig.id,
        interpretation: "Synthetic reading",
        attestWetSignature: false,
        method: "E_SIGNATURE_APPLIED_BY_RT",
      }),
    ).rejects.toThrow(/authorized their e-signature/);
    await finalizePft(rt, formId, {
      pulmoSignatoryId: withSig.id,
      interpretation: "Synthetic reading",
      attestWetSignature: true,
      method: "E_SIGNATURE_APPLIED_BY_RT",
    });
    const fin = (await getPftForm(rt, formId))!;
    expect(fin.status).toBe("FINAL");
    expect(fin.pulmoSignoff).toMatchObject({ method: "E_SIGNATURE_APPLIED_BY_RT", hasImage: true, name: "Dr. Demo Pulmo Signer" });
  });
});
