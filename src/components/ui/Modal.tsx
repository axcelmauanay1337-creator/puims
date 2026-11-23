"use client";

import { useEffect, useRef, type ReactNode } from "react";

/** Accessible modal dialog: focus moves in, Escape closes, focus returns to the opener. */
export function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    ref.current?.querySelector<HTMLElement>("input:not([type=hidden]),select,textarea,button")?.focus();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      prev?.focus?.();
    };
  }, [onClose]);
  return (
    <div
      className="fixed inset-0 z-[80] flex items-end justify-center bg-[#161a1680] p-0 sm:items-center sm:p-4"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="max-h-[92dvh] w-full max-w-lg overflow-y-auto rounded-t-[14px] border border-line bg-surface p-5 shadow-2xl sm:rounded-[12px]"
      >
        <h2 className="text-[16px] font-semibold">{title}</h2>
        <div className="mt-3">{children}</div>
      </div>
    </div>
  );
}
