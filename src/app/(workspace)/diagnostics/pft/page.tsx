import { DiagnosticsPage } from "@/components/DiagnosticsPage";

export const metadata = { title: "PFT Scheduling" };

export default function Page({ searchParams }: PageProps<"/diagnostics/pft">) {
  return <DiagnosticsPage service="PFT" searchParams={searchParams} />;
}
