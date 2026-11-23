import Link from "next/link";
import { AccessDenied } from "@/components/ui/AccessDenied";
import { Badge, Card, EmptyState, PageHeader, SyntheticDataNote } from "@/components/ui/primitives";
import { getNotifications } from "@/server/data";
import { guard } from "@/server/guard";

export const metadata = { title: "Notifications" };

const SEV = {
  danger: { tone: "danger", label: "Urgent", glyph: "‼" },
  warning: { tone: "warning", label: "Attention", glyph: "!" },
  info: { tone: "info", label: "Info", glyph: "i" },
} as const;

export default async function NotificationsPage() {
  if (!(await guard("notifications:read"))) return <AccessDenied what="notifications" />;
  const items = await getNotifications();
  return (
    <>
      <PageHeader
        eyebrow="System"
        title="Notifications"
        crumbs={[{ label: "System" }, { label: "Notifications" }]}
        description="In-app reminders computed from current records. Notification text never contains patient names or hospital numbers, so previews on lock screens cannot leak PHI."
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
      <p className="mt-3 text-[12px] text-ink-3">
        Configurable reminder rules (Chief RT, within approved policy) and optional push delivery arrive with Milestones 4 and 7.
      </p>
      <SyntheticDataNote />
    </>
  );
}
