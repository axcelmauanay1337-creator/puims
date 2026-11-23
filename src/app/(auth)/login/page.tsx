import { redirect } from "next/navigation";
import { LoginForm } from "@/components/auth/LoginForms";
import { getSession } from "@/server/session";

export const metadata = { title: "Sign in" };

const REASONS: Record<string, string> = {
  idle: "You were signed out after a period of inactivity.",
  "signed-out": "You have signed out.",
};

export default async function LoginPage({ searchParams }: PageProps<"/login">) {
  if (await getSession()) redirect("/");
  const sp = await searchParams;
  const next = typeof sp.next === "string" && sp.next.startsWith("/") && !sp.next.startsWith("//") ? sp.next : "/";
  const reason = typeof sp.reason === "string" ? REASONS[sp.reason] : undefined;
  return (
    <>
      <h1 className="text-[20px] font-semibold">Sign in</h1>
      <p className="mb-4 mt-1 text-[13px] text-ink-2">Use your own PUIMS account. You will then be asked for your authenticator code.</p>
      {reason ? (
        <p role="status" className="mb-3 rounded-[var(--radius-control)] border border-line bg-neutral-soft px-3 py-2 text-[12px] text-ink-2">
          {reason}
        </p>
      ) : null}
      <LoginForm next={next} />
      <p className="mt-4 text-[12px] text-ink-3">Forgot your password or lost your phone? Ask the Chief RT to reset your access.</p>
    </>
  );
}
