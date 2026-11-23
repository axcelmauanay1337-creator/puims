import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { VerifyForm } from "@/components/auth/LoginForms";
import { PENDING_COOKIE } from "@/server/auth/cookies";

export const metadata = { title: "Verify sign-in" };

export default async function VerifyPage({ searchParams }: PageProps<"/login/verify">) {
  if (!(await cookies()).get(PENDING_COOKIE())) redirect("/login");
  const sp = await searchParams;
  const next = typeof sp.next === "string" && sp.next.startsWith("/") && !sp.next.startsWith("//") ? sp.next : "/";
  return (
    <>
      <h1 className="text-[20px] font-semibold">Two-step verification</h1>
      <p className="mb-4 mt-1 text-[13px] text-ink-2">Password accepted. Confirm it is you with your authenticator app.</p>
      <VerifyForm next={next} />
    </>
  );
}
