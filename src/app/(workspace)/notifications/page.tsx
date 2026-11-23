import Link from "next/link";
import { AccessDenied } from "@/components/ui/AccessDenied";
import { Badge, Card, EmptyState, PageHeader, SyntheticDataNote } from "@/components/ui/primitives";
import { guard } from "@/server/guard";
import { getAlerts } from "@/server/workspace";

export const metadata = { title: "Alerts" };

const SEV = {
  danger: { tone: "danger", label: "Urgent", glyph: "‼" },
  warning: { tone: "warning", label: "Attention", glyph: "!" },
  info: { tone: "info", label: "Info", glyph: "i" },
} as const;

export default async function NotificationsPage() {
  const session = await guard("notifications:read");
  if (!session) return <AccessDenied what="alerts" />;
  const items = await getAlerts(session);
  return (
    <>
      <PageHeader
        eyebrow="More"
        title="Alerts"
        crumbs={[{ label: "More" }, { label: "Alerts" }]}
        description="Computed from current records: neb doses past their time, tubing past its interval, handovers not acknowledged, tests within the hour, equipment due for maintenance and no free machine. Alert text never contains patient names."
      />
      {items.length === 0 ? (
        <EmptyState title="Nothing needs attention" />
      ) : (
        <Card>
          <ul className="divide-y divide-line-soft">
            {items.map((n) => (
              <li key={n.id}>
                <Link href={n.href} className="flex items-center gap-3 py-2.5 hover:bg-[#fafaf8]">
                  <Badge tone={SEV[n.severity].tone}>
                    <span aria-hidden="true">{SEV[n.severity].glyph}</span>
                    {SEV[n.severity].label}
                  </Badge>
                  <span className="min-w-0">
                    <span className="block text-[13px] font-medium">{n.title}</span>
                    <span className="block text-[12px] text-ink-3">{n.detail}</span>
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </Card>
      )}
      <SyntheticDataNote />
    </>
  );
}
