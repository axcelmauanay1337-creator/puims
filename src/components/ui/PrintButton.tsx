"use client";

import { Icon } from "./Icon";

export function PrintButton({ label = "Print" }: { label?: string }) {
  return (
    <button
      type="button"
      onClick={() => window.print()}
      className="no-print inline-flex min-h-9 items-center gap-1.5 rounded-[var(--radius-control)] border border-line bg-surface px-3 text-[13px] font-medium hover:bg-hover"
    >
      <Icon name="print" size={15} />
      {label}
    </button>
  );
}
