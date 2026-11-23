"use client";

import { useState } from "react";
import { updateSettingAction, type AdminResult } from "@/app/actions/admin";
import { ResultNote, useSensitiveAction } from "./useSensitiveAction";

export interface EditableSetting {
  key: string;
  label: string;
  value: number;
  min: number;
  max: number;
  description: string;
  updated: string;
}

export function SettingsForm({ settings }: { settings: EditableSetting[] }) {
  const { run, busy, element } = useSensitiveAction();
  const [results, setResults] = useState<Record<string, AdminResult>>({});
  return (
    <>
      {element}
      <ul className="divide-y divide-line-soft">
        {settings.map((s) => (
          <li key={s.key} className="py-3">
            <form
              className="flex flex-wrap items-end gap-3"
              onSubmit={async (e) => {
                e.preventDefault();
                const v = String(new FormData(e.currentTarget).get("value"));
                const r = await run(() => updateSettingAction(s.key, v));
                setResults((x) => ({ ...x, [s.key]: r }));
              }}
            >
              <label className="text-[12px] font-medium text-ink-2">
                {s.label}
                <input
                  name="value"
                  type="number"
                  step="any"
                  min={s.min}
                  max={s.max}
                  defaultValue={s.value}
                  required
                  className="mt-1 block min-h-9 w-28 rounded-[7px] border border-line px-2 text-[13px]"
                />
              </label>
              <button
                type="submit"
                disabled={busy}
                className="min-h-9 rounded-[7px] border border-line px-3 text-[13px] font-medium hover:bg-hover disabled:opacity-60"
              >
                Save
              </button>
              <span className="text-[11px] text-ink-3">
                {s.description} · {s.updated}
              </span>
            </form>
            <ResultNote result={results[s.key] ?? null} />
          </li>
        ))}
      </ul>
    </>
  );
}
