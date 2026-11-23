"use client";

import Link from "next/link";
import { useActionState } from "react";
import { loginAction, verifyAction, type FormState } from "@/app/actions/auth";
import { Field, FormError, SubmitButton } from "./Field";

export function LoginForm({ next }: { next: string }) {
  const [state, action, pending] = useActionState<FormState, FormData>(loginAction, {});
  return (
    <form action={action} className="space-y-3" aria-label="Sign in">
      <input type="hidden" name="next" value={next} />
      <Field label="Username" name="username" autoComplete="username" autoCapitalize="none" spellCheck={false} required maxLength={40} autoFocus />
      <Field label="Password" name="password" type="password" autoComplete="current-password" required maxLength={256} />
      <FormError error={state.error} />
      <SubmitButton pending={pending}>Continue</SubmitButton>
    </form>
  );
}

export function VerifyForm({ next }: { next: string }) {
  const [state, action, pending] = useActionState<FormState, FormData>(verifyAction, {});
  return (
    <form action={action} className="space-y-3" aria-label="Verify sign-in">
      <input type="hidden" name="next" value={next} />
      <Field
        label="Authenticator code"
        name="code"
        inputMode="numeric"
        autoComplete="one-time-code"
        pattern="[0-9 ]{6,7}"
        maxLength={7}
        required
        autoFocus
        hint="Open your authenticator app and enter the 6-digit PUIMS code."
      />
      <FormError error={state.error} />
      <SubmitButton pending={pending}>Sign in</SubmitButton>
      <p className="text-center text-[12px]">
        <Link href="/login" className="text-accent-ink hover:underline">
          Start again
        </Link>
      </p>
    </form>
  );
}
