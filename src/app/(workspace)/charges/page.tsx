import Link from "next/link";
import { AccessDenied } from "@/components/ui/AccessDenied";
import { PageHeader, SyntheticDataNote } from "@/components/ui/primitives";
import { ChargesBoard } from "@/components/workspace/ChargesBoard";
import { addDays, formatLongDate } from "@/lib/time/zoned";
import { guard } from "@/server/guard";
import { getCharges } from "@/server/workspace";

export const metadata = { title: "Charges" };

export default async function ChargesPage({ searchParams }: PageProps<"/charges">) {
  const session = await guard("reports:unit");
  if (!session) return <AccessDenied what="charges (Chief RT only)" />;
  const sp = await searchParams;
  const date = typeof sp.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(sp.date) ? sp.date : undefined;
  const c = await getCharges(session, date);
  const unset = !c.prices.ventilator && !c.prices.hfnc && !c.prices.niv;
  return (
    <>
      <PageHeader
        eyebrow="Admin & settings"
        title={`Charges · ${formatLongDate(c.date)}`}
        crumbs={[{ label: "Admin & settings" }, { label: "Charges" }]}
        description="Machine charges only: ventilator, HFNC and BiPAP/CPAP per patient per day. A rented ventilator bills its rental rate only. Posted charges cannot be changed."
        actions={
          <span className="flex gap-2 text-[13px]">
            <Link
              className="inline-flex min-h-9 items-center rounded-[7px] border border-line bg-surface px-3 hover:bg-hover"
              href={`/charges?date=${addDays(c.date, -1)}`}
            >
              ← Previous day
            </Link>
            <Link
              className="inline-flex min-h-9 items-center rounded-[7px] border border-line bg-surface px-3 hover:bg-hover"
              href={`/charges?date=${addDays(c.date, 1)}`}
            >
              Next day →
            </Link>
          </span>
        }
      />
      {unset ? (
        <p role="note" className="mb-4 rounded-[10px] bg-warning-soft px-3 py-2 text-[13px] text-warning">
          Machine prices are not set yet (₱0). Set them in{" "}
          <Link href="/settings" className="underline">
            Settings
          </Link>
          .
        </p>
      ) : null}
      <ChargesBoard date={c.date} groups={c.groups} />
      <SyntheticDataNote />
    </>
  );
}
