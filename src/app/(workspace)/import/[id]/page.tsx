import Link from "next/link";
import { notFound } from "next/navigation";
import { BatchActions, MappingEditor, OptionsForm, RowTable } from "@/components/import/ImportWizard";
import { AccessDenied } from "@/components/ui/AccessDenied";
import { Badge, Card, CardHeader, PageHeader } from "@/components/ui/primitives";
import { formatDateTime } from "@/lib/time/zoned";
import { ClinicalError } from "@/server/clinical";
import { guard } from "@/server/guard";
import { getBatch, type RowFilter } from "@/server/importer";

export const metadata = { title: "Import batch" };

const FILTERS: Array<[RowFilter, string]> = [
  ["review", "Needs review"],
  ["blocking", "Unresolved problems"],
  ["pending", "Pending"],
  ["accepted", "To import"],
  ["rejected", "Not imported"],
  ["all", "All rows"],
];

export default async function BatchPage({ params, searchParams }: PageProps<"/import/[id]">) {
  const session = await guard("import:manage");
  if (!session) return <AccessDenied what="the import center" />;
  const { id } = await params;
  const sp = await searchParams;
  const one = (k: string) => (typeof sp[k] === "string" ? (sp[k] as string) : "");
  const filter = (FILTERS.find(([f]) => f === one("filter"))?.[0] ?? "review") as RowFilter;
  let data;
  try {
    data = await getBatch(session, id, { sheet: one("sheet") || undefined, filter, page: Number(one("page")) || 0 });
  } catch (e) {
    if (e instanceof ClinicalError && e.kind === "NOT_FOUND") notFound();
    throw e;
  }
  const { batch, totals, rows, page, pages, filtered } = data;
  const sheet = batch.sheets.find((x) => x.name === one("sheet")) ?? null;
  const staged = batch.status === "STAGED";
  const href = (o: Record<string, string>) => {
    const p = new URLSearchParams({ ...(sheet ? { sheet: sheet.name } : {}), filter, ...o });
    return `/import/${batch.id}?${p.toString()}`;
  };
  return (
    <>
      <PageHeader
        eyebrow="Import Center"
        title={batch.fileName}
        crumbs={[{ label: "Management" }, { label: "Import Center", href: "/import" }, { label: "Batch" }]}
        description={
          <span className="flex flex-wrap items-center gap-2">
            <Badge tone={staged ? "warning" : batch.status === "COMMITTED" ? "success" : "neutral"}>{batch.status.toLowerCase()}</Badge>
            <span className="text-ink-3">
              {batch.service} · staged {formatDateTime(new Date(batch.createdIso))} · {(batch.bytes / 1024).toFixed(0)} KB · SHA-256{" "}
              <code className="text-[11px]">{batch.sha256.slice(0, 16)}…</code>
              {batch.closeReason ? ` · closed: “${batch.closeReason}”` : ""}
            </span>
          </span>
        }
      />
      <div className="mb-4 grid gap-4 lg:grid-cols-2">
        <Card aria-labelledby="sum-h">
          <CardHeader id="sum-h" title="Progress" />
          <p className="text-[13px]">
            {totals.rows} rows · <b>{totals.pending}</b> pending · {totals.accepted} to import · {totals.rejected} not imported ·{" "}
            <b className="text-danger">{totals.blocking}</b> with unresolved problems · {totals.review} need review · {totals.clean} clean
          </p>
          <div className="mt-3">
            <BatchActions batchId={batch.id} status={batch.status} summary={batch.summary} sheet={sheet?.name ?? null} hasOriginal={batch.hasOriginal} />
          </div>
        </Card>
        <Card aria-labelledby="opt-h">
          <CardHeader id="opt-h" title="Your declarations about this workbook" />
          <OptionsForm batchId={batch.id} options={batch.options} disabled={!staged} />
        </Card>
      </div>

      <nav aria-label="Worksheets" className="mb-2 flex flex-wrap gap-2 text-[12px]">
        <Link
          href={href({ sheet: "", page: "0" })}
          className={`rounded-full border px-3 py-1 ${!sheet ? "border-accent bg-accent-soft font-semibold" : "border-line hover:bg-hover"}`}
        >
          All sheets
        </Link>
        {batch.sheets.map((x) => (
          <Link
            key={x.name}
            href={href({ sheet: x.name, page: "0" })}
            className={`rounded-full border px-3 py-1 ${sheet?.name === x.name ? "border-accent bg-accent-soft font-semibold" : "border-line hover:bg-hover"}`}
          >
            {x.name} <span className="text-ink-3">({x.rows})</span>
          </Link>
        ))}
      </nav>

      {sheet ? (
        <Card className="mb-4" aria-labelledby="map-h">
          <CardHeader id="map-h" title={`Column mapping — ${sheet.name}`} />
          <MappingEditor key={JSON.stringify(sheet.mapping)} batchId={batch.id} sheet={sheet} disabled={!staged} />
        </Card>
      ) : (
        <p className="mb-3 text-[12px] text-ink-2">Choose a worksheet to check its column mapping.</p>
      )}

      <Card aria-labelledby="rows-h">
        <CardHeader id="rows-h" title="Rows" subtitle={`${filtered} row(s) in this view · page ${page + 1} of ${pages}`} />
        <nav aria-label="Row filter" className="mb-3 flex flex-wrap gap-2 text-[12px]">
          {FILTERS.map(([f, label]) => (
            <Link
              key={f}
              href={href({ filter: f, page: "0" })}
              className={`rounded-full border px-3 py-1 ${filter === f ? "border-accent bg-accent-soft font-semibold" : "border-line hover:bg-hover"}`}
            >
              {label}
            </Link>
          ))}
        </nav>
        <RowTable rows={rows} disabled={!staged} />
        {pages > 1 ? (
          <div className="mt-3 flex gap-2 text-[12px]">
            {page > 0 ? (
              <Link className="rounded border border-line px-3 py-1 hover:bg-hover" href={href({ page: String(page - 1) })}>
                ← Previous
              </Link>
            ) : null}
            {page < pages - 1 ? (
              <Link className="rounded border border-line px-3 py-1 hover:bg-hover" href={href({ page: String(page + 1) })}>
                Next →
              </Link>
            ) : null}
          </div>
        ) : null}
      </Card>
    </>
  );
}
