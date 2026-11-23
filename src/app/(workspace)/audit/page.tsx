import { AuditTable } from "@/components/tables/ModuleTables";
import { AccessDenied } from "@/components/ui/AccessDenied";
import { PageHeader } from "@/components/ui/primitives";
import { listAudit } from "@/server/data";
import { guard } from "@/server/guard";

export const metadata = { title: "Audit Logs" };

const CATEGORIES = [
  ["", "All actions"],
  ["auth.", "Sign-in & sessions"],
  ["admin.", "Administration"],
  ["patient", "Patients"],
  ["handover", "Handover"],
  ["shift_assignment", "Roster"],
  ["setting", "Settings"],
] as const;

export default async function AuditPage({ searchParams }: PageProps<"/audit">) {
  if (!(await guard("audit:read"))) return <AccessDenied what="audit logs" />;
  const sp = await searchParams;
  const category = CATEGORIES.find(([v]) => v === sp.action)?.[0] ?? "";
  const rows = await listAudit(300, category);
  return (
    <>
      <PageHeader
        eyebrow="System"
        title="Audit Logs"
        crumbs={[{ label: "System" }, { label: "Audit Logs" }]}
        description="Who did what, to which record, from which device, and when. Read-only for every role — including the Chief RT."
      />
      <p className="mb-4 rounded-[var(--radius-card)] border border-line bg-surface px-4 py-3 text-[12px] text-ink-2">
        Entries are written by database triggers and by the application into an append-only table: the application role cannot update or delete them, and a
        trigger blocks UPDATE, DELETE and TRUNCATE. Secrets (password hashes, authenticator secrets, token hashes) are redacted before logging. Showing the
        latest 300 entries.
      </p>
      <form method="get" className="mb-3 flex items-end gap-2" aria-label="Filter audit log">
        <label className="text-[12px] text-ink-3">
          <span className="mb-1 block">Category</span>
          <select name="action" defaultValue={category} className="min-h-9 rounded-[7px] border border-line bg-surface px-2 text-[13px] text-ink">
            {CATEGORIES.map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </select>
        </label>
        <button type="submit" className="min-h-9 rounded-[7px] border border-line bg-surface px-3 text-[13px] font-medium hover:bg-hover">
          Show
        </button>
      </form>
      <AuditTable rows={rows} />
    </>
  );
}
