"use client";

import { useId, useMemo, useState, type ReactNode } from "react";
import { Icon } from "./Icon";

export interface Column<T> {
  key: string;
  header: string;
  cell: (row: T) => ReactNode;
  /** Value used for sorting; omit to make the column unsortable. */
  sort?: (row: T) => string | number | null;
  className?: string;
  /** Hide in the phone card layout. */
  hideOnCard?: boolean;
}

export interface FilterOption<T> {
  key: string;
  label: string;
  options: Array<{ value: string; label: string }>;
  match: (row: T, value: string) => boolean;
}

/**
 * Filterable/sortable table (FIGMA_HANDOFF "Filterable/sortable data table").
 * Filtering happens in memory on data the server already authorized; filter
 * text is never written to the URL (PHI must not appear in URLs).
 * Phones get a card layout instead of a dense table.
 */
export function DataTable<T>({
  rows,
  columns,
  rowKey,
  caption,
  searchPlaceholder,
  searchText,
  filters = [],
  initialSort,
  emptyTitle = "No records",
  emptyText,
  pageSize = 50,
}: {
  rows: T[];
  columns: Column<T>[];
  rowKey: (row: T) => string;
  caption: string;
  searchPlaceholder?: string;
  searchText?: (row: T) => string;
  filters?: FilterOption<T>[];
  initialSort?: { key: string; dir: "asc" | "desc" };
  emptyTitle?: string;
  emptyText?: string;
  pageSize?: number;
}) {
  const id = useId();
  const [query, setQuery] = useState("");
  const [filterValues, setFilterValues] = useState<Record<string, string>>({});
  const [sort, setSort] = useState(initialSort ?? null);
  const [limit, setLimit] = useState(pageSize);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    let out = rows.filter((r) => (!q || !searchText ? true : searchText(r).toLowerCase().includes(q)));
    for (const f of filters) {
      const v = filterValues[f.key];
      if (v) out = out.filter((r) => f.match(r, v));
    }
    if (sort) {
      const col = columns.find((c) => c.key === sort.key);
      if (col?.sort) {
        const s = col.sort;
        out = [...out].sort((a, b) => {
          const av = s(a);
          const bv = s(b);
          if (av === bv) return 0;
          if (av === null) return 1;
          if (bv === null) return -1;
          const r = av < bv ? -1 : 1;
          return sort.dir === "asc" ? r : -r;
        });
      }
    }
    return out;
  }, [rows, query, searchText, filters, filterValues, sort, columns]);

  const visible = filtered.slice(0, limit);
  const toggleSort = (key: string) => setSort((s) => (s?.key === key ? { key, dir: s.dir === "asc" ? "desc" : "asc" } : { key, dir: "asc" }));

  return (
    <div>
      {(searchText || filters.length > 0) && (
        <div className="mb-3 flex flex-wrap items-center gap-2" role="search" aria-label={`Filter ${caption}`}>
          {searchText && (
            <label className="relative flex min-w-0 flex-1 items-center sm:max-w-xs">
              <span className="sr-only">Search {caption}</span>
              <Icon name="search" size={14} className="pointer-events-none absolute left-2.5 text-ink-3" />
              <input
                type="search"
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value);
                  setLimit(pageSize);
                }}
                placeholder={searchPlaceholder ?? "Search"}
                autoComplete="off"
                className="min-h-9 w-full rounded-[var(--radius-control)] border border-line bg-surface py-1.5 pl-8 pr-2 text-[13px] placeholder:text-ink-3"
              />
            </label>
          )}
          {filters.map((f) => (
            <label key={f.key} className="flex items-center gap-1.5 text-[12px] text-ink-3">
              <span>{f.label}</span>
              <select
                value={filterValues[f.key] ?? ""}
                onChange={(e) => {
                  setFilterValues((v) => ({ ...v, [f.key]: e.target.value }));
                  setLimit(pageSize);
                }}
                className="min-h-9 rounded-[var(--radius-control)] border border-line bg-surface px-2 text-[13px] text-ink"
              >
                <option value="">All</option>
                {f.options.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </label>
          ))}
          <p className="ml-auto text-[12px] text-ink-3" aria-live="polite" id={`${id}-count`}>
            {filtered.length} of {rows.length}
          </p>
        </div>
      )}

      {filtered.length === 0 ? (
        <div className="rounded-[var(--radius-card)] border border-dashed border-line bg-surface px-6 py-8 text-center">
          <p className="text-[13px] font-semibold">{emptyTitle}</p>
          {emptyText ? <p className="mt-1 text-[12px] text-ink-3">{emptyText}</p> : null}
        </div>
      ) : (
        <>
          {/* Desktop / tablet table */}
          <div className="hidden overflow-x-auto rounded-[var(--radius-card)] border border-line bg-surface md:block">
            <table className="w-full border-collapse text-[13px]">
              <caption className="sr-only">{caption}</caption>
              <thead>
                <tr>
                  {columns.map((c) => {
                    const active = sort?.key === c.key;
                    return (
                      <th
                        key={c.key}
                        scope="col"
                        aria-sort={active ? (sort!.dir === "asc" ? "ascending" : "descending") : undefined}
                        className={`whitespace-nowrap border-b border-line px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-[0.04em] text-ink-3 ${c.className ?? ""}`}
                      >
                        {c.sort ? (
                          <button type="button" onClick={() => toggleSort(c.key)} className="inline-flex items-center gap-1 uppercase hover:text-ink">
                            {c.header}
                            <span aria-hidden="true" className="text-[10px]">
                              {active ? (sort!.dir === "asc" ? "▲" : "▼") : "↕"}
                            </span>
                          </button>
                        ) : (
                          c.header
                        )}
                      </th>
                    );
                  })}
                </tr>
              </thead>
              <tbody>
                {visible.map((r) => (
                  <tr key={rowKey(r)} className="border-b border-line-soft last:border-0 hover:bg-[#fafaf8]">
                    {columns.map((c) => (
                      <td key={c.key} className={`px-3 py-2.5 align-top ${c.className ?? ""}`}>
                        {c.cell(r)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Phone cards */}
          <ul className="space-y-2 md:hidden" aria-label={caption}>
            {visible.map((r) => (
              <li key={rowKey(r)} className="rounded-[var(--radius-card)] border border-line bg-surface p-3">
                <dl className="grid grid-cols-[minmax(0,40%)_1fr] gap-x-3 gap-y-1.5 text-[13px]">
                  {columns
                    .filter((c) => !c.hideOnCard)
                    .map((c) => (
                      <div key={c.key} className="contents">
                        <dt className="text-[11px] uppercase tracking-[0.04em] text-ink-3">{c.header}</dt>
                        <dd className="min-w-0 break-words">{c.cell(r)}</dd>
                      </div>
                    ))}
                </dl>
              </li>
            ))}
          </ul>

          {filtered.length > limit && (
            <div className="mt-3 text-center">
              <button
                type="button"
                onClick={() => setLimit((l) => l + pageSize)}
                className="min-h-9 rounded-[var(--radius-control)] border border-line bg-surface px-3 text-[13px] hover:bg-hover"
              >
                Show more ({filtered.length - limit} remaining)
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
