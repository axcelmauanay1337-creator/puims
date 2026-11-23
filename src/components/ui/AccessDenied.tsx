import { Icon } from "./Icon";

/** Rendered when the SERVER determines the session lacks a permission. */
export function AccessDenied({ what }: { what: string }) {
  return (
    <div className="mx-auto mt-10 max-w-md rounded-[var(--radius-card)] border border-line bg-surface p-6 text-center" data-testid="access-denied">
      <span className="mx-auto mb-3 grid h-10 w-10 place-items-center rounded-full bg-danger-soft text-danger">
        <Icon name="lock" />
      </span>
      <h1 className="text-[17px] font-semibold">Access denied</h1>
      <p className="mt-1 text-[13px] text-ink-2">Your role does not include access to {what}. This is enforced by the server, not only hidden in the menu.</p>
      <p className="mt-3 text-[12px] text-ink-3">If you need access, ask the Chief RT administrator.</p>
    </div>
  );
}
