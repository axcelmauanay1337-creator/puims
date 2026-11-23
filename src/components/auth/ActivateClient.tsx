"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { completeActivationAction, startActivationAction, type ActivationView } from "@/app/actions/auth";
import { PASSWORD_MIN } from "@/lib/auth/password";
import { Field, FormError, SubmitButton } from "./Field";

/**
 * Activation link format: /activate#<token>. The token is in the URL FRAGMENT,
 * which browsers never send to servers, proxies or access logs. It is read here,
 * removed from the address bar immediately, and posted to the server action.
 */
export function ActivateClient() {
  const tokenRef = useRef<string>("");
  const [view, setView] = useState<ActivationView | "loading" | "missing" | "unavailable">("loading");
  const [errors, setErrors] = useState<{ error?: string; problems?: string[] }>({});
  const [pending, setPending] = useState(false);
  const [done, setDone] = useState(false);

  useEffect(() => {
    const token = window.location.hash.slice(1);
    if (token) {
      tokenRef.current = token;
      history.replaceState(null, "", window.location.pathname);
    }
    if (!tokenRef.current) {
      queueMicrotask(() => setView("missing"));
      return;
    }
    check();
  }, []);

  // A server/database outage must not be shown as an invalid link: the link is still good.
  function check() {
    setView("loading");
    startActivationAction(tokenRef.current)
      .then((v) => setView(v.ok ? v : "missing"))
      .catch(() => setView("unavailable"));
  }

  if (done) {
    return (
      <div role="status">
        <h1 className="text-[20px] font-semibold">Account ready</h1>
        <p className="mb-4 mt-1 text-[13px] text-ink-2">Your password is set. Sign in to continue.</p>
        <Link
          href="/login"
          className="inline-flex min-h-10 items-center rounded-[var(--radius-control)] bg-accent px-4 text-[14px] font-semibold text-white hover:bg-accent-hover"
        >
          Go to sign in
        </Link>
      </div>
    );
  }
  if (view === "loading") return <p className="text-[13px] text-ink-2">Checking your activation link…</p>;
  if (view === "unavailable")
    return (
      <div role="alert">
        <h1 className="text-[20px] font-semibold">PUIMS can&apos;t be reached right now</h1>
        <p className="mb-4 mt-1 text-[13px] text-ink-2">Your activation link is still valid. Keep this page open and try again in a few minutes.</p>
        <button
          type="button"
          onClick={check}
          className="inline-flex min-h-10 items-center rounded-[var(--radius-control)] bg-accent px-4 text-[14px] font-semibold text-white hover:bg-accent-hover"
        >
          Try again
        </button>
      </div>
    );
  if (view === "missing")
    return (
      <div>
        <h1 className="text-[20px] font-semibold">Activation link not valid</h1>
        <p className="mt-1 text-[13px] text-ink-2">The link is missing, already used, or expired (links last 72 hours). Ask the Chief RT for a new one.</p>
      </div>
    );

  return (
    <form
      className="space-y-4"
      aria-label="Activate account"
      onSubmit={async (e) => {
        e.preventDefault();
        const f = new FormData(e.currentTarget);
        setPending(true);
        setErrors({});
        try {
          const r = await completeActivationAction(tokenRef.current, String(f.get("password")), String(f.get("confirm")));
          if (r.ok) setDone(true);
          else setErrors(r);
        } catch {
          setErrors({ error: "Could not reach the server. Try again." });
        } finally {
          setPending(false);
        }
      }}
    >
      <div>
        <h1 className="text-[20px] font-semibold">{view.purpose === "RESET" ? "Reset your access" : "Activate your account"}</h1>
        <p className="mt-1 text-[13px] text-ink-2">
          {view.displayName} · username <b>{view.username}</b>
        </p>
      </div>
      <section aria-labelledby="pw-h" className="space-y-3">
        <h2 id="pw-h" className="text-[13px] font-semibold">
          Choose a password
        </h2>
        <Field
          label="New password"
          name="password"
          type="password"
          autoComplete="new-password"
          minLength={PASSWORD_MIN}
          maxLength={128}
          required
          hint={`At least ${PASSWORD_MIN} characters. A passphrase of several words works well.`}
        />
        <Field label="Confirm password" name="confirm" type="password" autoComplete="new-password" minLength={PASSWORD_MIN} maxLength={128} required />
      </section>
      <FormError {...errors} />
      <SubmitButton pending={pending}>Activate account</SubmitButton>
    </form>
  );
}
