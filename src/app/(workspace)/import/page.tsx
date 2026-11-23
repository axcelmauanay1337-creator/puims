import Link from "next/link";
import { UploadWorkbook } from "@/components/import/ImportWizard";
import { AccessDenied } from "@/components/ui/AccessDenied";
import { Badge, Card, CardHeader, EmptyState, PageHeader } from "@/components/ui/primitives";
import { formatDateTime } from "@/lib/time/zoned";
import { guard } from "@/server/guard";
import { listBatches } from "@/server/importer";

export const metadata = { title: "Import Center" };

const STEPS = [
  [
    "Stage",
    "Upload the workbook. PUIMS keeps its SHA-256 checksum, detects worksheets and header rows, drops contact columns (U-08) and keeps every other source value with its sheet and row number.",
  ],
  ["Declare", "State how text dates are written, the workbook year and other facts about the file. Nothing ambiguous is guessed."],
  ["Map", "Check each sheet's column mapping — sheets differ (DATE vs “Column 1”, AGE + SEX vs “Age / Sex”)."],
  [
    "Review",
    "Every row needs a decision. Flagged values are corrected by you from the source; possible duplicates and name matches need an explicit patient choice.",
  ],
  ["Dry run", "See exactly what would be created, and download the exception report (sheet and row numbers only, no patient values)."],
  ["Commit", "Confirm with your password. One appointment per accepted row; the batch can be reversed as a unit."],
];

const STATUS_TONE = { STAGED: "warning", COMMITTED: "success", VOIDED: "neutral", DISCARDED: "neutral" } as const;

export default async function ImportPage() {
  const session = await guard("import:manage");
  if (!session) return <AccessDenied what="the import center" />;
  const batches = await listBatches(session);
  return (
    <>
      <PageHeader
        eyebrow="Management"
        title="Import Center"
        crumbs={[{ label: "Management" }, { label: "Import Center" }]}
        description="Staged, human-reviewed import of legacy scheduling workbooks. Real workbooks may be imported only in an environment approved by hospital IT, DPO/privacy and clinical governance — this environment holds synthetic data only."
      />
      <div className="grid gap-4 lg:grid-cols-[1fr_1.2fr]">
        <Card aria-labelledby="up-h">
          <CardHeader id="up-h" title="Stage a workbook" subtitle="Try it with the synthetic workbook: npm run fixture:workbook" />
          <UploadWorkbook />
        </Card>
        <Card aria-labelledby="steps-h">
          <CardHeader id="steps-h" title="How an import works" />
          <ol className="space-y-2.5 text-[12px]">
            {STEPS.map(([t, d], i) => (
              <li key={t} className="flex gap-3">
                <span className="tabular grid h-6 w-6 shrink-0 place-items-center rounded-full bg-neutral-soft text-[11px] font-semibold">{i + 1}</span>
                <span>
                  <b className="block text-[13px]">{t}</b>
                  <span className="text-ink-2">{d}</span>
                </span>
              </li>
            ))}
          </ol>
        </Card>
      </div>
      <Card className="mt-4" aria-labelledby="b-h">
        <CardHeader id="b-h" title="Import batches" />
        {batches.length ? (
          <ul className="divide-y divide-line-soft text-[13px]">
            {batches.map((b) => (
              <li key={b.id} className="flex flex-wrap items-center gap-2 py-2">
                <Link href={`/import/${b.id}`} className="font-medium hover:underline">
                  {b.fileName}
                </Link>
                <Badge tone={STATUS_TONE[b.status as keyof typeof STATUS_TONE] ?? "neutral"}>{b.status.toLowerCase()}</Badge>
                <span className="text-ink-3">
                  {formatDateTime(new Date(b.createdIso))} · {b.by} · {b.rows} rows · {b.accepted} accepted · {b.appointments} imported
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <EmptyState title="No import batches">Nothing has been staged in this environment.</EmptyState>
        )}
      </Card>
    </>
  );
}
