import Link from "next/link";
import { AccessDenied } from "@/components/ui/AccessDenied";
import { BarChart } from "@/components/ui/BarChart";
import { Card, PageHeader, SyntheticDataNote } from "@/components/ui/primitives";
import { monthShortName } from "@/lib/time/zoned";
import { guard } from "@/server/guard";
import { getTrends } from "@/server/workspace";

export const metadata = { title: "Census trends" };

const SERIES = [
  ["all", "All services", "Patients served per month (any documented service)"],
  ["neb", "Nebulization", "Patients with a documented neb dose per month"],
  ["vent", "Ventilator", "Patients on a ventilator at any time in the month"],
  ["niv", "HFNC & NIV", "Patients on HFNC, BiPAP or CPAP at any time in the month"],
  ["dx", "PFT, ABG & sputum", "Tests done per month"],
] as const;
const MONTHS_LONG = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

export default async function TrendsPage({ searchParams }: PageProps<"/trends">) {
  const session = await guard("clinical:read");
  if (!session) return <AccessDenied what="census trends" />;
  const sp = await searchParams;
  const key = (SERIES.find(([k]) => k === sp.s)?.[0] ?? "all") as (typeof SERIES)[number][0];
  const year = typeof sp.y === "string" && /^20\d\d$/.test(sp.y) ? Number(sp.y) : undefined;
  const t = await getTrends(session, year);
  const data = t.series[key];
  const max = Math.max(...data);
  const peak = max > 0 ? data.indexOf(max) : -1;
  const withData = data.filter((v) => v > 0);
  const avg = withData.length ? Math.round(withData.reduce((a, b) => a + b, 0) / withData.length) : 0;
  const def = SERIES.find(([k]) => k === key)!;
  return (
    <>
      <PageHeader
        eyebrow="Workspace"
        title={`Census trends · ${t.year}`}
        crumbs={[{ label: "Workspace" }, { label: "Trends" }]}
        description="Which months were busiest, from documented records only."
        actions={
          <span className="flex gap-2 text-[13px]">
            <Link
              className="inline-flex min-h-9 items-center rounded-[7px] border border-line bg-surface px-3 hover:bg-hover"
              href={`/trends?s=${key}&y=${t.year - 1}`}
            >
              ← {t.year - 1}
            </Link>
            <Link
              className="inline-flex min-h-9 items-center rounded-[7px] border border-line bg-surface px-3 hover:bg-hover"
              href={`/trends?s=${key}&y=${t.year + 1}`}
            >
              {t.year + 1} →
            </Link>
          </span>
        }
      />
      <nav aria-label="Service" className="mb-4 flex flex-wrap gap-2">
        {SERIES.map(([k, label]) => (
          <Link
            key={k}
            href={`/trends?s=${k}&y=${t.year}`}
            aria-current={k === key ? "page" : undefined}
            className={`inline-flex min-h-9 items-center rounded-full border px-3.5 text-[13px] ${k === key ? "border-accent bg-accent font-semibold text-white" : "border-line bg-surface"}`}
          >
            {label}
          </Link>
        ))}
      </nav>
      <div className="mb-4 grid grid-cols-3 gap-3">
        <div className="rounded-[14px] border border-line bg-surface px-4 py-3">
          <p className="text-[12px] text-ink-2">Busiest month</p>
          <p className="text-[22px] font-bold">{peak >= 0 ? MONTHS_LONG[peak] : "—"}</p>
          <p className="text-[12px] text-ink-2">{peak >= 0 ? max : 0}</p>
        </div>
        <div className="rounded-[14px] border border-line bg-surface px-4 py-3">
          <p className="text-[12px] text-ink-2">Monthly average</p>
          <p className="tabular text-[22px] font-bold">{avg}</p>
          <p className="text-[12px] text-ink-2">months with data</p>
        </div>
        <div className="rounded-[14px] border border-line bg-surface px-4 py-3">
          <p className="text-[12px] text-ink-2">Total for the year</p>
          <p className="tabular text-[22px] font-bold">{key === "dx" ? data.reduce((a, b) => a + b, 0) : "—"}</p>
          <p className="text-[12px] text-ink-2">{key === "dx" ? "tests done" : "patients repeat across months"}</p>
        </div>
      </div>
      <Card>
        <BarChart
          data={data.map((v, i) => ({ label: monthShortName(i + 1), value: v }))}
          highlightIndex={peak >= 0 ? peak : undefined}
          caption={`${def[2]}, ${t.year}. Darkest bar = busiest month.`}
        />
      </Card>
      <SyntheticDataNote />
    </>
  );
}
