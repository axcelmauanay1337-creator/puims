import { DiagnosticsPage } from "@/components/DiagnosticsPage";

export const metadata = { title: "Sputum Induction" };

export default function Page({ searchParams }: PageProps<"/diagnostics/sputum">) {
  return <DiagnosticsPage service="SPUTUM_INDUCTION" searchParams={searchParams} />;
}
