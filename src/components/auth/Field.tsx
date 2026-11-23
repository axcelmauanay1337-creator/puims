import type { InputHTMLAttributes } from "react";

export function Field({ label, hint, ...props }: InputHTMLAttributes<HTMLInputElement> & { label: string; hint?: string }) {
  return (
    <label className="block text-[12px] font-medium text-ink-2">
      {label}
      <input
        {...props}
        className="mt-1 block min-h-10 w-full rounded-[var(--radius-control)] border border-line bg-surface px-3 text-[14px] text-ink placeholder:text-ink-3"
      />
      {hint ? <span className="mt-1 block text-[11px] font-normal text-ink-3">{hint}</span> : null}
    </label>
  );
}

export function SubmitButton({ children, pending }: { children: React.ReactNode; pending?: boolean }) {
  return (
    <button
      type="submit"
      disabled={pending}
      className="min-h-10 w-full rounded-[var(--radius-control)] border border-accent bg-accent px-3 text-[14px] font-semibold text-white hover:bg-accent-hover disabled:opacity-60"
    >
      {pending ? "Please wait…" : children}
    </button>
  );
}

export function FormError({ error, problems }: { error?: string; problems?: string[] }) {
  if (!error && !problems?.length) return null;
  return (
    <div role="alert" className="rounded-[var(--radius-control)] border border-[#f0d0cc] bg-danger-soft px-3 py-2 text-[12px] text-danger">
      {error}
      {problems?.length ? (
        <ul className="list-disc pl-4">
          {problems.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
