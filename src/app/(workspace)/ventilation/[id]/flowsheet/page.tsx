import Link from "next/link";
import { notFound } from "next/navigation";
import { AccessDenied } from "@/components/ui/AccessDenied";
import { PrintButton } from "@/components/ui/PrintButton";
import { AIRWAY_LABEL, DISCONNECT_LABEL, VENT_MODE_LABEL, VENT_NUMBERS, type VentNumberKey } from "@/lib/clinical/vent";
import { formatDateTime } from "@/lib/time/zoned";
import { getVentFlowsheet } from "@/server/data";
import { guard } from "@/server/guard";

export const metadata = { title: "Ventilator flowsheet" };

const COLS: Array<[VentNumberKey, string]> = [
  ["fio2", "FiO₂ %"],
  ["peep", "PEEP"],
  ["tidalVolume", "Vt"],
  ["setRate", "RR set"],
  ["pressureSupport", "PS"],
  ["inspiratoryPressure", "Pi"],
  ["inspiratoryTime", "Ti"],
  ["peakPressure", "PIP"],
  ["plateauPressure", "Pplat"],
  ["totalRate", "RR tot"],
  ["exhaledVt", "VTe"],
  ["minuteVentilation", "MV"],
  ["spo2", "SpO₂"],
  ["cuffPressure", "Cuff"],
];

const th = "border border-[#999] px-1 py-1 text-left font-semibold";
const td = "border border-[#999] px-1 py-1 align-top";

export default async function FlowsheetPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await guard("clinical:read");
  if (!session) return <AccessDenied what="the ventilator flowsheet" />;
  const { id } = await params;
  const f = await getVentFlowsheet(id);
  if (!f) notFound();
  const a = f.airway;
  const airway = a.type ? [AIRWAY_LABEL[a.type as keyof typeof AIRWAY_LABEL] ?? a.type, a.size, a.position].filter(Boolean).join(" · ") : "Not recorded";
  const sexAge = [f.patientInfo.sex, f.patientInfo.dob ? `DOB ${f.patientInfo.dob}` : null].filter(Boolean).join(" · ") || "—";
  return (
    <div className="mx-auto max-w-[1100px] bg-surface text-[12px] text-ink print:text-[10px]">
      <style>{`@media print { @page { size: A4 landscape; margin: 10mm; } }`}</style>
      <div className="no-print mb-4 flex flex-wrap items-center gap-2">
        <Link
          href="/ventilation"
          className="inline-flex min-h-9 items-center rounded-[var(--radius-control)] border border-line px-3 text-[13px] hover:bg-hover"
        >
          ← Mechanical Ventilation
        </Link>
        <PrintButton label="Print flowsheet" />
        <span className="text-[12px] text-ink-3">Prints on A4 landscape. Units: pressures cmH₂O, volumes mL, MV L/min, Ti seconds.</span>
      </div>

      <header className="mb-3 border-b-2 border-ink pb-2">
        <p className="text-[11px] uppercase tracking-wide text-ink-2">Pulmonary Unit · Respiratory Therapy</p>
        <h1 className="text-[18px] font-bold print:text-[15px]">Mechanical Ventilation Flowsheet</h1>
      </header>

      <section className="mb-3 grid grid-cols-2 gap-x-6 gap-y-1 sm:grid-cols-4">
        <p>
          <b>Patient:</b> {f.patient.name}
        </p>
        <p>
          <b>Hospital no.:</b> {f.patient.hospitalId || "—"}
        </p>
        <p>
          <b>Sex / DOB:</b> {sexAge}
        </p>
        <p>
          <b>Ward / room:</b> {f.wardRoom}
        </p>
        <p>
          <b>Ventilator:</b> {f.ventilatorRef}
        </p>
        <p>
          <b>Airway:</b> {airway}
        </p>
        <p>
          <b>Hook-in:</b> {formatDateTime(new Date(f.hookedIso))} · {f.responsible}
        </p>
        <p>
          <b>Disconnection:</b>{" "}
          {f.disconnectedIso
            ? `${formatDateTime(new Date(f.disconnectedIso))}${f.disconnectReason ? ` · ${DISCONNECT_LABEL[f.disconnectReason as keyof typeof DISCONNECT_LABEL] ?? f.disconnectReason}` : ""}${f.disconnectNote ? ` · ${f.disconnectNote}` : ""}`
            : "Still on ventilator"}
        </p>
      </section>

      <h2 className="mb-1 text-[13px] font-semibold">Settings and readings</h2>
      {f.settings.length === 0 ? (
        <p className="mb-3 text-ink-3">No settings recorded.</p>
      ) : (
        <div className="mb-3 overflow-x-auto print:overflow-visible">
          <table className="w-full border-collapse tabular">
            <thead>
              <tr className="bg-[#f0f0ec]">
                <th className={th}>Date / time</th>
                <th className={th}>Mode</th>
                {COLS.map(([k, h]) => (
                  <th key={k} className={th} title={VENT_NUMBERS[k][0]}>
                    {h}
                  </th>
                ))}
                <th className={th}>Note</th>
                <th className={th}>RT</th>
              </tr>
            </thead>
            <tbody>
              {f.settings.map((x) => (
                <tr key={x.id} className={x.voided ? "text-ink-3" : ""}>
                  <td className={`${td} whitespace-nowrap`}>
                    <span className={x.voided ? "line-through" : ""}>{formatDateTime(new Date(x.atIso))}</span>
                  </td>
                  <td className={td}>
                    <span className={x.voided ? "line-through" : ""}>
                      {x.mode === "OTHER" ? x.modeOther : (VENT_MODE_LABEL[x.mode as keyof typeof VENT_MODE_LABEL] ?? x.mode)}
                    </span>
                  </td>
                  {COLS.map(([k]) => (
                    <td key={k} className={td}>
                      <span className={x.voided ? "line-through" : ""}>{x.values[k] ?? ""}</span>
                    </td>
                  ))}
                  <td className={td}>{x.voided ? <span>VOIDED: {x.voidReason}</span> : x.note}</td>
                  <td className={td}>{x.by}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <h2 className="mb-1 text-[13px] font-semibold">Change of tubing</h2>
      {f.tubing.length === 0 ? (
        <p className="mb-3 text-ink-3">No change of tubing documented.</p>
      ) : (
        <table className="mb-3 border-collapse">
          <thead>
            <tr className="bg-[#f0f0ec]">
              <th className={th}>Date / time</th>
              <th className={th}>Reason</th>
              <th className={th}>RT</th>
            </tr>
          </thead>
          <tbody>
            {f.tubing.map((t) => (
              <tr key={t.id} className={t.voided ? "text-ink-3" : ""}>
                <td className={`${td} whitespace-nowrap`}>
                  <span className={t.voided ? "line-through" : ""}>{formatDateTime(new Date(t.atIso))}</span>
                </td>
                <td className={td}>{t.voided ? `VOIDED: ${t.voidReason}` : t.reason}</td>
                <td className={td}>{t.by}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <footer className="mt-6 grid grid-cols-2 gap-8 text-[11px]">
        <p>Checked by: ______________________________</p>
        <p>Date / time: ______________________________</p>
        <p className="col-span-2 text-ink-3">
          Printed from PUIMS {formatDateTime(new Date(f.printedIso))} by {session.displayName}. Values are as documented by the RT; struck-through rows were
          voided with the reason shown.
        </p>
      </footer>
    </div>
  );
}
