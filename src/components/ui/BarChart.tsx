/**
 * Simple accessible column chart (single series). Values are rendered as
 * text as well as bars, and a visually-hidden table carries the data for
 * screen readers. Only real computed values are passed in — no placeholders.
 */
export function BarChart({
  data,
  caption,
  highlightIndex,
  unit = "",
}: {
  data: Array<{ label: string; value: number }>;
  caption: string;
  highlightIndex?: number;
  unit?: string;
}) {
  const max = Math.max(1, ...data.map((d) => d.value));
  return (
    <figure>
      <div className="flex h-44 items-end gap-1.5 border-b border-line px-1 sm:gap-3" aria-hidden="true">
        {data.map((d, i) => (
          <div key={d.label} className="flex h-full min-w-0 flex-1 flex-col items-center justify-end gap-1">
            <span className="tabular text-[10px] text-ink-3">{d.value > 0 ? d.value : ""}</span>
            <div
              className={`w-full max-w-9 rounded-t-[4px] ${i === highlightIndex ? "bg-accent" : "bg-[#b8cbbf]"}`}
              style={{ height: `${d.value === 0 ? 0 : Math.max(3, (d.value / max) * 85)}%` }}
            />
          </div>
        ))}
      </div>
      <div className="mt-1.5 flex gap-1.5 px-1 sm:gap-3" aria-hidden="true">
        {data.map((d) => (
          <span key={d.label} className="min-w-0 flex-1 truncate text-center text-[10px] text-ink-3">
            {d.label}
          </span>
        ))}
      </div>
      <figcaption className="mt-2 text-[11px] text-ink-3">{caption}</figcaption>
      <div className="sr-only">
        <table>
          <caption>{caption}</caption>
          <thead>
            <tr>
              <th scope="col">Period</th>
              <th scope="col">Value{unit ? ` (${unit})` : ""}</th>
            </tr>
          </thead>
          <tbody>
            {data.map((d) => (
              <tr key={d.label}>
                <th scope="row">{d.label}</th>
                <td>{d.value}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </figure>
  );
}
