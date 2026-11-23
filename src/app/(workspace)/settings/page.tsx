import { AccessDenied } from "@/components/ui/AccessDenied";
import { Badge, Card, CardHeader, PageHeader, ShiftBadge } from "@/components/ui/primitives";
import { FREQUENCY_PRESETS } from "@/lib/clinical/vocabulary";
import { HOSPITAL_TZ } from "@/lib/time/zoned";
import { SettingsForm } from "@/components/admin/SettingsForm";
import { PftTemplateAdmin, SignatoryDirectory } from "@/components/admin/PftAdmin";
import { getPftAdmin } from "@/server/pft";
import { EDITABLE_SETTINGS, type SettingKey } from "@/server/auth/admin";
import { getSettings } from "@/server/data";
import { guard } from "@/server/guard";
import { formatDateTime } from "@/lib/time/zoned";
import { can } from "@/server/session";

export const metadata = { title: "Settings" };

export default async function SettingsPage() {
  const session = await guard("settings:read");
  if (!session) return <AccessDenied what="settings" />;
  const admin = can(session, "settings:manage");
  const settings = await getSettings();
  const pft = await getPftAdmin(session);
  const val = (k: string) => settings.find((x) => x.key === k)?.value ?? NaN;
  const editable = settings
    .filter((x) => x.key in EDITABLE_SETTINGS)
    .map((x) => {
      const spec = EDITABLE_SETTINGS[x.key as SettingKey];
      return {
        key: x.key,
        label: spec.label,
        value: x.value,
        min: spec.min,
        max: spec.max,
        description: x.description,
        updated: `last changed ${formatDateTime(new Date(x.updatedIso))}${x.updatedBy ? ` by ${x.updatedBy}` : ""}`,
      };
    });
  return (
    <>
      <PageHeader
        eyebrow="System"
        title="Settings"
        crumbs={[{ label: "System" }, { label: "Settings" }]}
        description="Current configuration. Values marked policy-pending must be confirmed by the hospital before production."
      />
      {admin && (
        <Card className="mb-4" aria-labelledby="edit-h">
          <CardHeader id="edit-h" title="Edit configuration" subtitle="Chief RT only · validated by the server and the database · every change is audited" />
          <SettingsForm settings={editable} />
        </Card>
      )}
      <div className="mb-4 grid gap-4 lg:grid-cols-2">
        <Card aria-labelledby="pft-t-h">
          <CardHeader
            id="pft-t-h"
            title="PFT form template"
            subtitle="Form AS-PUL-PFT-006 · header, revision and bronchodilator statement need hospital confirmation"
          />
          <PftTemplateAdmin current={pft.templates[0]} editable={admin} />
        </Card>
        <Card aria-labelledby="pft-s-h">
          <CardHeader
            id="pft-s-h"
            title="Approved signatory directory"
            subtitle="Only these identities appear on PFT signature lines. Synthetic entries in this environment."
          />
          <SignatoryDirectory signatories={pft.signatories} proposals={pft.proposals} activeRts={pft.activeRts} editable={admin} />
        </Card>
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <Card aria-labelledby="time-h">
          <CardHeader id="time-h" title="Time & shifts" />
          <dl className="space-y-2 text-[13px]">
            <Row k="Hospital timezone" v={<code>{HOSPITAL_TZ}</code>} />
            <Row k="Operational day" v="06:00 → 06:00 next day" />
            <Row
              k="Shifts"
              v={
                <span className="flex flex-wrap gap-1.5">
                  <ShiftBadge shift="MORNING" />
                  <ShiftBadge shift="AFTERNOON" />
                  <ShiftBadge shift="NIGHT" />
                </span>
              }
            />
          </dl>
        </Card>
        <Card aria-labelledby="tub-h">
          <CardHeader id="tub-h" title="Change of tubing" subtitle="Infection prevention / manufacturer confirmation required" />
          <dl className="space-y-2 text-[13px]">
            <Row
              k="Replacement interval"
              v={
                <>
                  {val("tubing.interval_days")} calendar days <Badge tone="warning">policy-pending</Badge>
                </>
              }
            />
            <Row
              k="“Upcoming” window"
              v={
                <>
                  {val("tubing.upcoming_window_hours")} hours before due <Badge tone="warning">policy-pending</Badge>
                </>
              }
            />
            <Row k="“Due” rule" v="Due instant falls later in the current operational day" />
            <Row k="Auto-complete" v="Never — an RT must document each replacement" />
          </dl>
        </Card>
        <Card aria-labelledby="vocab-h">
          <CardHeader id="vocab-h" title="Vocabularies" subtitle="Final lists to be approved by the Pulmonary Unit" />
          <dl className="space-y-2 text-[13px]">
            <Row k="Patient sex" v="Male, Female (decision U-07); blank only for imported rows awaiting review" />
            <Row k="Hospital number" v="Optional; unique when entered (decision U-13)" />
            <Row k="Handover" v="One per shift (decision U-11)" />
            <Row k="Nebulization frequency presets" v={FREQUENCY_PRESETS.join(", ")} />
            <Row k="Nebulization statuses" v="Scheduled, Pending, In progress, Completed, Delayed, Not given, Refused, Cancelled" />
            <Row k="Diagnostic statuses" v="Scheduled, Pending, Completed, No-show, Cancelled, For reschedule, Rescheduled" />
          </dl>
        </Card>
        <Card aria-labelledby="sec-h">
          <CardHeader id="sec-h" title="Security & offline" />
          <dl className="space-y-2 text-[13px]">
            <Row
              k="Offline capture"
              v={
                <>
                  Only on devices the Chief RT approves (Devices &amp; Sync); nebulization doses and tubing replacements; 12-hour lease; encrypted on the device{" "}
                  <Badge tone="warning">interim — U-03 pending</Badge>
                </>
              }
            />
            <Row
              k="Inactivity lock"
              v={
                <>
                  Sign-out after {val("session.idle_minutes")} minutes without activity; sessions last at most {val("session.absolute_hours")} hours
                </>
              }
            />
            <Row k="Authentication" v={<>Individual accounts · Argon2id password + authenticator app (TOTP) · re-authentication for sensitive actions</>} />
          </dl>
        </Card>
      </div>
    </>
  );
}

function Row({ k, v }: { k: string; v: React.ReactNode }) {
  return (
    <div className="grid gap-1 sm:grid-cols-[13rem_1fr]">
      <dt className="text-ink-3">{k}</dt>
      <dd>{v}</dd>
    </div>
  );
}
