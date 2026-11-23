import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { AppShell } from "@/components/shell/AppShell";
import { getSession } from "@/server/session";

export default async function WorkspaceLayout({ children }: { children: React.ReactNode }) {
  const session = await getSession();
  if (!session) {
    const path = (await headers()).get("x-puims-path") ?? "/";
    const next = /^\/[A-Za-z0-9/_-]*$/.test(path) && path !== "/" ? `?next=${encodeURIComponent(path)}` : "";
    redirect(`/login${next}`);
  }
  return <AppShell session={session}>{children}</AppShell>;
}
