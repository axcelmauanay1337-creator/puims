import { AcknowledgeButton, HandoverComposer } from "@/components/handover/HandoverComposer";
import { AccessDenied } from "@/components/ui/AccessDenied";
import { Badge, Card, EmptyState, PageHeader, ShiftBadge, StatusBadge, SyntheticDataNote } from "@/components/ui/primitives";
import { formatDateTime, formatShortDate } from "@/lib/time/zoned";
import { getHandoverDrafts } from "@/server/clinical";
import { getHandoverBoard } from "@/server/data";
import { guard } from "@/server/guard";

export const metadata = { title: "Shift Handover" };

const KIND_LABEL = {
  VENTILATOR_ENCOUNTER: "Ventilator",
  NEBULIZATION_ADMIN: "Nebulization",
  NEBULIZATION_ORDER: "Nebulization",
  TUBING: "Tubing",
  DIAGNOSTIC: "Diagnostic",
} as const;
const RESOLVED = new Set(["COMPLETED", "DISCONTINUED", "CANCELLED", "CURRENT", "NOT_GIVEN", "REFUSED", "NO_SHOW", "RESCHEDULED"]);

export default async function HandoverPage() {
  const session = await guard("shifts:read");
  if (!session) return <AccessDenied what="shift handover" />;
  const [board, drafts] = await Promise.all([getHandoverBoard(), getHandoverDrafts(session)]);
  return (
    <>
      <PageHeader
        eyebrow="Workspace"
        title="Shift Handover"
        crumbs={[{ label: "Workspace", href: "/" }, { label: "Shift Handover" }]}
        description="One handover per shift. Open items are carried forward as references to the original records — the clinical event is never duplicated, and each item shows its status right now."
      />
      <div className="mb-5 space-y-3">
        {drafts.map((d) => (
          <HandoverComposer key={`${d.shift.operationalDate}-${d.shift.shift}`} draft={d} isChief={session.role === "CHIEF_RT_ADMIN"} />
        ))}
      </div>
      <h2 className="mb-2 text-[15px] font-semibold">Recent handovers</h2>
      {board.length === 0 ? (
        <EmptyState title="No handovers yet" />
      ) : (
        <ol className="space-y-3">
          {board.map((h) => (
            <li key={h.id}>
              <Card as="article" aria-label={`Handover ${h.shift} ${h.operationalDate}`}>
                <div className="flex flex-wrap items-center gap-2">
                  <ShiftBadge shift={h.shift} />
                  <span className="text-[13px] font-semibold">Operational date {formatShortDate(h.operationalDate)}</span>
                  <span className="ml-auto flex items-center gap-2">
                    <StatusBadge status={h.acknowledgedIso ? "ACKNOWLEDGED" : "AWAITING_ACK"} />
                    {!h.acknowledgedIso && h.outgoingId !== session.staffId ? <AcknowledgeButton id={h.id} /> : null}
                  </span>
                </div>
                <dl className="mt-3 grid gap-x-6 gap-y-2 text-[12px] sm:grid-cols-4">
                  <div>
                    <dt className="text-ink-3">Outgoing RT</dt>
                    <dd className="font-medium">{h.outgoing}</dd>
                  </div>
                  <div>
                    <dt className="text-ink-3">Incoming RT</dt>
                    <dd className="font-medium">{h.incoming}</dd>
                  </div>
                  <div>
                    <dt className="text-ink-3">Written</dt>
                    <dd className="tabular">{formatDateTime(new Date(h.createdIso))}</dd>
                  </div>
                  <div>
                    <dt className="text-ink-3">Acknowledged</dt>
                    <dd className="tabular">
                      {h.acknowledgedIso ? `${formatDateTime(new Date(h.acknowledgedIso))}${h.acknowledgedBy ? ` by ${h.acknowledgedBy}` : ""}` : "Not yet"}
                    </dd>
                  </div>
                </dl>
                {h.pendingItems.length > 0 && (
                  <div className="mt-3">
                    <p className="text-[11px] font-semibold uppercase tracking-[0.04em] text-ink-3">Carried-forward items · live status</p>
                    <ul className="mt-1 divide-y divide-line-soft text-[12px]">
                      {h.pendingItems.map((i) => (
                        <li key={`${i.kind}-${i.refId}-${i.summary}`} className="flex flex-wrap items-center gap-2 py-1.5">
                          <Badge tone="info">{KIND_LABEL[i.kind]}</Badge>
                          <span className={RESOLVED.has(i.liveStatus) ? "text-ink-3 line-through decoration-ink-3/50" : ""}>{i.summary}</span>
                          {i.patient ? <span className="text-ink-3">· {i.patient}</span> : null}
                          <span className="ml-auto">
                            <StatusBadge status={i.liveStatus} />
                          </span>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                {h.equipmentConcerns && (
                  <p className="mt-2 text-[12px]">
                    <b>Equipment:</b> {h.equipmentConcerns}
                  </p>
                )}
                {h.notes ? <p className="mt-2 whitespace-pre-wrap text-[12px] text-ink-2">{h.notes}</p> : null}
              </Card>
            </li>
          ))}
        </ol>
      )}
      <SyntheticDataNote />
    </>
  );
}
