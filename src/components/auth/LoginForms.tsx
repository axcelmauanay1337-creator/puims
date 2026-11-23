"use client";

import { useActionState } from "react";
import { loginAction, type FormState } from "@/app/actions/auth";
import { Field, FormError, SubmitButton } from "./Field";

export function LoginForm({ next }: { next: string }) {
  const [state, action, pending] = useActionState<FormState, FormData>(loginAction, {});
  return (
    <form action={action} className="space-y-3" aria-label="Sign in">
      <input type="hidden" name="next" value={next} />
      <Field label="Username" name="username" autoComplete="username" autoCapitalize="none" spellCheck={false} required maxLength={40} autoFocus />
      <Field label="Password" name="password" type="password" autoComplete="current-password" required maxLength={256} />
      <FormError error={state.error} />
      <SubmitButton pending={pending}>Sign in</SubmitButton>
    </form>
  );
}
