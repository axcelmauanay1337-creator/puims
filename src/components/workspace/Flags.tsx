import { OWN_SUPPLY_LABELS, PRECAUTION_LABELS, type OwnSupply, type Precaution } from "@/lib/clinical/flags";

export interface FlagsView {
  precautions: Precaution[];
  ownSupplies: OwnSupply[];
  endorsement: string | null;
}

/** Compact chips for lists: ⚠ precautions, ★ endorsement, ◆ own supplies. */
export function FlagChips({ flags, showOwn = true }: { flags: FlagsView; showOwn?: boolean }) {
  if (!flags.precautions.length && !flags.endorsement && !(showOwn && flags.ownSupplies.length)) return null;
  return (
    <span className="flex flex-wrap gap-1">
      {flags.precautions.map((p) => (
        <span key={p} className="rounded-full bg-danger-soft px-2 py-0.5 text-[11px] font-semibold text-danger">
          ⚠ {PRECAUTION_LABELS[p]}
        </span>
      ))}
      {flags.endorsement ? <span className="rounded-full bg-warning-soft px-2 py-0.5 text-[11px] font-semibold text-warning">★ Endorsement</span> : null}
      {showOwn
        ? flags.ownSupplies.map((o) => (
            <span key={o} className="rounded-full bg-info-soft px-2 py-0.5 text-[11px] font-semibold text-info">
              ◆ {OWN_SUPPLY_LABELS[o]}
            </span>
          ))
        : null}
    </span>
  );
}

/** Full boxes for documenting panels and the patient page. */
export function FlagBoxes({ flags }: { flags: FlagsView }) {
  return (
    <div className="space-y-2">
      {flags.precautions.length ? (
        <p className="rounded-[10px] bg-danger-soft px-3 py-2 text-[13px] text-danger">
          <b>⚠ Precautions:</b> {flags.precautions.map((p) => PRECAUTION_LABELS[p]).join(" · ")}
        </p>
      ) : null}
      {flags.endorsement ? (
        <p className="whitespace-pre-line rounded-[10px] bg-warning-soft px-3 py-2 text-[13px] text-warning">
          <b>★ Special endorsement:</b> {flags.endorsement}
        </p>
      ) : null}
      {flags.ownSupplies.length ? (
        <p className="rounded-[10px] bg-info-soft px-3 py-2 text-[13px] text-info">
          <b>◆ Patient&apos;s own:</b> {flags.ownSupplies.map((o) => OWN_SUPPLY_LABELS[o]).join(" · ")}. Use these, don&apos;t issue unit stock.
        </p>
      ) : null}
    </div>
  );
}
