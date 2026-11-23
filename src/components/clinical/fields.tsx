"use client";

import { useEffect, useId, useRef, useState } from "react";
import { HOSPITAL_TZ, toLocalParts } from "@/lib/time/zoned";

export const inputCls = "mt-1 block min-h-10 w-full rounded-[7px] border border-line bg-surface px-3 text-[14px]";
export const labelCls = "block text-[12px] font-medium text-ink-2";

/** Current Asia/Manila wall time as "YYYY-MM-DDTHH:MM" (independent of the device's own timezone). */
export function manilaNowLocal(): string {
  const p = toLocalParts(new Date(), HOSPITAL_TZ);
  const z = (n: number) => String(n).padStart(2, "0");
  return `${p.year}-${z(p.month)}-${z(p.day)}T${z(p.hour)}:${z(p.minute)}`;
}

export function manilaLocalOf(iso: string): string {
  const p = toLocalParts(new Date(iso), HOSPITAL_TZ);
  const z = (n: number) => String(n).padStart(2, "0");
  return `${p.year}-${z(p.month)}-${z(p.day)}T${z(p.hour)}:${z(p.minute)}`;
}

/** Date-time input whose value is Asia/Manila wall time (labelled as such). */
export function ManilaDateTime({ label, value, onChange, required }: { label: string; value: string; onChange: (v: string) => void; required?: boolean }) {
  return (
    <label className={labelCls}>
      {label} <span className="font-normal text-ink-3">(Asia/Manila)</span>
      <input type="datetime-local" className={inputCls} value={value} onChange={(e) => onChange(e.target.value)} required={required} />
    </label>
  );
}

/** A client-generated id, created once per form, reused on retry → the server treats retries as the same entry. */
export function useClientId(): string {
  const [id] = useState(() => crypto.randomUUID());
  return id;
}

export function FormError({ error }: { error: string | null }) {
  return error ? (
    <p role="alert" className="mt-2 text-[12px] text-danger">
      {error}
    </p>
  ) : null;
}

export function Buttons({ pending, submit, onCancel }: { pending: boolean; submit: string; onCancel: () => void }) {
  return (
    <div className="mt-4 flex justify-end gap-2">
      <button type="button" onClick={onCancel} className="min-h-10 rounded-[7px] border border-line px-3 text-[13px] hover:bg-hover">
        Cancel
      </button>
      <button
        type="submit"
        disabled={pending}
        className="min-h-10 rounded-[7px] border border-accent bg-accent px-4 text-[13px] font-semibold text-white hover:bg-accent-hover disabled:opacity-60"
      >
        {pending ? "Saving…" : submit}
      </button>
    </div>
  );
}

interface Hit {
  id: string;
  title: string;
  subtitle: string;
}

/** Patient picker: server-side search via POST (terms never in URLs). */
export function PatientPicker({ value, onChange }: { value: Hit | null; onChange: (h: Hit | null) => void }) {
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<Hit[]>([]);
  const listId = useId();
  const ctl = useRef<AbortController | null>(null);
  useEffect(() => {
    if (q.trim().length < 2) return;
    ctl.current?.abort();
    const c = new AbortController();
    ctl.current = c;
    const t = setTimeout(async () => {
      const res = await fetch("/api/search", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ q }),
        signal: c.signal,
      }).catch(() => null);
      if (res?.ok) setHits(((await res.json()) as { hits: Hit[] }).hits);
    }, 180);
    return () => clearTimeout(t);
  }, [q]);
  if (value)
    return (
      <div className={labelCls}>
        Patient
        <div className="mt-1 flex items-center justify-between rounded-[7px] border border-line bg-neutral-soft px-3 py-2 text-[13px] text-ink">
          <span>
            <b>{value.title}</b> <span className="text-ink-3">· {value.subtitle}</span>
          </span>
          <button type="button" onClick={() => onChange(null)} className="text-[12px] text-accent-ink underline">
            Change
          </button>
        </div>
      </div>
    );
  return (
    <div>
      <label className={labelCls}>
        Patient
        <input
          className={inputCls}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search hospital no. or name"
          aria-controls={listId}
          autoComplete="off"
        />
      </label>
      {q.trim().length >= 2 && (
        <ul id={listId} role="listbox" aria-label="Matching patients" className="mt-1 max-h-48 overflow-y-auto rounded-[7px] border border-line">
          {hits.length === 0 && <li className="px-3 py-2 text-[12px] text-ink-3">No matches.</li>}
          {hits.map((h) => (
            <li key={h.id} role="option" aria-selected="false">
              <button type="button" onClick={() => onChange(h)} className="block w-full px-3 py-2 text-left text-[13px] hover:bg-hover">
                <b>{h.title}</b> <span className="text-ink-3">· {h.subtitle}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
