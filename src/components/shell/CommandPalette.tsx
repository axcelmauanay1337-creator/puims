"use client";

import { useRouter } from "next/navigation";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Icon } from "@/components/ui/Icon";
import type { NavItem } from "@/lib/nav";
import { useShellUi } from "./ShellUi";

interface Hit {
  kind: "patient" | "module";
  id: string;
  title: string;
  subtitle: string;
  href: string;
  icon?: string;
}

/**
 * Global search (⌘K / Ctrl+K / "/"). Modules are filtered locally; patients are
 * searched on the server via POST so that names and hospital numbers never
 * appear in URLs, server access logs or browser history.
 */
export function CommandPalette({ modules }: { modules: NavItem[] }) {
  const { paletteOpen, setPaletteOpen } = useShellUi();
  const router = useRouter();
  const [q, setQ] = useState("");
  const [patients, setPatients] = useState<Hit[]>([]);
  const [status, setStatus] = useState<"idle" | "loading" | "error">("idle");
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const listId = useId();

  const [wasOpen, setWasOpen] = useState(paletteOpen);
  if (paletteOpen !== wasOpen) {
    setWasOpen(paletteOpen);
    if (paletteOpen) {
      setQ("");
      setPatients([]);
      setActive(0);
      setStatus("idle");
    }
  }

  useEffect(() => {
    if (paletteOpen) setTimeout(() => inputRef.current?.focus(), 0);
  }, [paletteOpen]);

  useEffect(() => {
    if (!paletteOpen) return;
    const term = q.trim();
    if (term.length < 2) return;
    const ctl = new AbortController();
    const t = setTimeout(async () => {
      setStatus("loading");
      try {
        const res = await fetch("/api/search", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ q: term }),
          signal: ctl.signal,
          cache: "no-store",
        });
        if (!res.ok) throw new Error(String(res.status));
        const body = (await res.json()) as { hits: Hit[] };
        setPatients(body.hits);
        setStatus("idle");
      } catch (e) {
        if ((e as Error).name !== "AbortError") setStatus("error");
      }
    }, 180);
    return () => {
      clearTimeout(t);
      ctl.abort();
    };
  }, [q, paletteOpen]);

  const moduleHits: Hit[] = useMemo(() => {
    const term = q.trim().toLowerCase();
    return modules
      .filter((m) => !term || m.label.toLowerCase().includes(term) || (m.keywords ?? "").includes(term))
      .slice(0, term ? 6 : 8)
      .map((m) => ({ kind: "module" as const, id: m.href, title: m.label, subtitle: "Go to module", href: m.href, icon: m.icon }));
  }, [q, modules]);

  const shownPatients = q.trim().length >= 2 ? patients : [];
  const hits = [...shownPatients, ...moduleHits];

  if (!paletteOpen) return null;

  const go = (h: Hit) => {
    setPaletteOpen(false);
    router.push(h.href);
  };

  return (
    <div
      className="fixed inset-0 z-[60] flex items-start justify-center bg-[#161a1680] p-3 pt-[10vh]"
      onMouseDown={(e) => e.target === e.currentTarget && setPaletteOpen(false)}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Search PUIMS"
        className="w-full max-w-xl overflow-hidden rounded-[12px] border border-line bg-surface shadow-2xl"
      >
        <div className="flex items-center gap-2 border-b border-line px-3">
          <Icon name="search" className="text-ink-3" />
          <input
            ref={inputRef}
            role="combobox"
            aria-expanded="true"
            aria-controls={listId}
            aria-activedescendant={hits[active] ? `${listId}-${active}` : undefined}
            aria-label="Search patients by hospital number or name, or jump to a module"
            placeholder="Search hospital no. / name, or a module…"
            value={q}
            autoComplete="off"
            spellCheck={false}
            onChange={(e) => {
              setQ(e.target.value);
              setActive(0);
            }}
            onKeyDown={(e) => {
              if (e.key === "Escape") setPaletteOpen(false);
              else if (e.key === "ArrowDown") {
                e.preventDefault();
                setActive((a) => Math.min(a + 1, hits.length - 1));
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setActive((a) => Math.max(a - 1, 0));
              } else if (e.key === "Enter" && hits[active]) {
                e.preventDefault();
                go(hits[active]);
              }
            }}
            className="min-h-12 flex-1 bg-transparent text-[14px] outline-none placeholder:text-ink-3"
          />
          <kbd className="hidden rounded border border-line px-1.5 text-[11px] text-ink-3 sm:inline">Esc</kbd>
        </div>
        <ul id={listId} role="listbox" aria-label="Results" className="max-h-[60vh] overflow-y-auto p-1.5">
          {status === "loading" && <li className="px-3 py-2 text-[12px] text-ink-3">Searching patients…</li>}
          {status === "error" && <li className="px-3 py-2 text-[12px] text-danger">Patient search unavailable — server unreachable.</li>}
          {q.trim().length >= 2 && status === "idle" && shownPatients.length === 0 && (
            <li className="px-3 py-2 text-[12px] text-ink-3">No matching patients.</li>
          )}
          {hits.map((h, i) => (
            <li
              key={`${h.kind}-${h.id}`}
              id={`${listId}-${i}`}
              role="option"
              aria-selected={i === active}
              onMouseEnter={() => setActive(i)}
              onClick={() => go(h)}
              className={`flex cursor-pointer items-center gap-3 rounded-[var(--radius-control)] px-3 py-2 ${i === active ? "bg-hover" : ""}`}
            >
              <span className="grid h-7 w-7 place-items-center rounded-md bg-neutral-soft text-ink-2">
                <Icon name={h.kind === "patient" ? "patients" : (h.icon ?? "chevron")} size={14} />
              </span>
              <span className="min-w-0">
                <span className="block truncate text-[13px] font-medium">{h.title}</span>
                <span className="block truncate text-[11px] text-ink-3">{h.subtitle}</span>
              </span>
              <span className="ml-auto text-[10px] uppercase tracking-wide text-ink-3">{h.kind}</span>
            </li>
          ))}
        </ul>
        <p className="border-t border-line px-3 py-2 text-[11px] text-ink-3">
          ↑↓ to move · Enter to open · Patient search runs on the server and is permission-checked.
        </p>
      </div>
    </div>
  );
}

export function SearchButton() {
  const { setPaletteOpen } = useShellUi();
  return (
    <button
      type="button"
      onClick={() => setPaletteOpen(true)}
      className="flex min-h-9 items-center gap-2 rounded-[var(--radius-control)] border border-line bg-surface px-2.5 text-[13px] text-ink-3 hover:bg-hover sm:min-w-56"
      aria-label="Search (Ctrl+K)"
    >
      <Icon name="search" size={15} />
      <span className="hidden sm:inline">Search patients, modules…</span>
      <kbd className="ml-auto hidden rounded border border-line px-1.5 text-[11px] sm:inline">Ctrl K</kbd>
    </button>
  );
}
