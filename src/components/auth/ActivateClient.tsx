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
  const [view, setView] = useState<ActivationView | "loading" | "missing">("loading");
  const [errors, setErrors] = useState<{ error?: string; problems?: string[] }>({});
  const [pending, setPending] = useState(false);
  const [done, setDone] = useState(false);
  const [showSecret, setShowSecret] = useState(false);

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
    startActivationAction(tokenRef.current)
      .then((v) => setView(v.ok ? v : "missing"))
      .catch(() => setView("missing"));
  }, []);

  if (done) {
    return (
      <div role="status">
        <h1 className="text-[20px] font-semibold">Account ready</h1>
        <p className="mb-4 mt-1 text-[13px] text-ink-2">Your password and authenticator are set. Sign in to continue.</p>
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
          const r = await completeActivationAction(tokenRef.current, String(f.get("password")), String(f.get("confirm")), String(f.get("code")));
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
          1. Choose a password
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
      <section aria-labelledby="mfa-h" className="space-y-3">
        <h2 id="mfa-h" className="text-[13px] font-semibold">
          2. Set up your authenticator app
        </h2>
        <p className="text-[12px] text-ink-2">Scan with Google Authenticator, Microsoft Authenticator or a similar app on your own phone.</p>
        {/* eslint-disable-next-line @next/next/no-img-element -- data URL generated server-side */}
        <img
          src={view.qrDataUrl}
          alt="QR code to add PUIMS to your authenticator app"
          width={180}
          height={180}
          className="rounded border border-line bg-white p-1"
        />
        <button type="button" onClick={() => setShowSecret((x) => !x)} className="text-[12px] text-accent-ink underline">
          {showSecret ? "Hide setup key" : "Can't scan? Show setup key"}
        </button>
        {showSecret && <code className="block break-all rounded bg-neutral-soft px-2 py-1 text-[12px]">{view.secret?.match(/.{1,4}/g)?.join(" ")}</code>}
        <Field label="6-digit code from the app" name="code" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9 ]{6,7}" maxLength={7} required />
      </section>
      <FormError {...errors} />
      <SubmitButton pending={pending}>Activate account</SubmitButton>
    </form>
  );
}
