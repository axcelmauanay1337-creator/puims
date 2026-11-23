import { DiagnosticsPage } from "@/components/DiagnosticsPage";

export const metadata = { title: "ABG" };

export default function Page({ searchParams }: PageProps<"/diagnostics/abg">) {
  return <DiagnosticsPage service="ABG" searchParams={searchParams} />;
}
