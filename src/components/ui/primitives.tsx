import Link from "next/link";
import type { ReactNode } from "react";
import { presentStatus, type Tone } from "@/lib/clinical/vocabulary";
import { SHIFT_DEFINITIONS, type ShiftCode } from "@/lib/time/shifts";
import { Icon } from "./Icon";

const TONE_CLASSES: Record<Tone, string> = {
  neutral: "bg-neutral-soft text-ink-2 border-line",
  info: "bg-info-soft text-info border-[#d6e3ee]",
  success: "bg-success-soft text-success border-[#cfe3d6]",
  warning: "bg-warning-soft text-warning border-[#f0dfbf]",
  danger: "bg-danger-soft text-danger border-[#f0d0cc]",
};

export function Badge({ tone = "neutral", children, title }: { tone?: Tone; children: ReactNode; title?: string }) {
  return (
    <span
      title={title}
      className={`inline-flex items-center gap-1 whitespace-nowrap rounded-[5px] border px-1.5 py-0.5 text-[11px] font-semibold ${TONE_CLASSES[tone]}`}
    >
      {children}
    </span>
  );
}

/** Status is always shown as glyph + text, never colour alone. */
export function StatusBadge({ status }: { status: string }) {
  const p = presentStatus(status);
  return (
    <Badge tone={p.tone}>
      <span aria-hidden="true">{p.glyph}</span>
      {p.label}
    </Badge>
  );
}

export function ShiftBadge({ shift, current = false }: { shift: ShiftCode; current?: boolean }) {
  const d = SHIFT_DEFINITIONS[shift];
  return (
    <Badge tone={current ? "success" : "neutral"} title={`${d.label} shift ${d.rangeLabel} Asia/Manila`}>
      {d.label} <span className="font-normal">{d.rangeLabel}</span>
    </Badge>
  );
}

export function Card({
  children,
  className = "",
  as: As = "section",
  ...rest
}: {
  children: ReactNode;
  className?: string;
  as?: "section" | "div" | "article";
  "aria-labelledby"?: string;
}) {
  return (
    <As className={`rounded-[var(--radius-card)] border border-line bg-surface p-4 ${className}`} {...rest}>
      {children}
    </As>
  );
}

export function CardHeader({ title, subtitle, action, id }: { title: string; subtitle?: ReactNode; action?: ReactNode; id?: string }) {
  return (
    <div className="mb-3 flex items-start justify-between gap-3">
      <div className="min-w-0">
        <h2 id={id} className="text-[13px] font-semibold text-ink">
          {title}
        </h2>
        {subtitle ? <p className="mt-0.5 text-[12px] text-ink-3">{subtitle}</p> : null}
      </div>
      {action}
    </div>
  );
}

export interface Crumb {
  label: string;
  href?: string;
}

export function PageHeader({
  eyebrow,
  title,
  description,
  crumbs,
  actions,
}: {
  eyebrow?: string;
  title: string;
  description?: ReactNode;
  crumbs?: Crumb[];
  actions?: ReactNode;
}) {
  return (
    <header className="mb-5">
      {crumbs?.length ? (
        <nav aria-label="Breadcrumb" className="mb-2 text-[12px] text-ink-3">
          <ol className="flex flex-wrap items-center gap-1">
            {crumbs.map((c, i) => (
              <li key={i} className="flex items-center gap-1">
                {c.href ? (
                  <Link href={c.href} className="hover:text-ink hover:underline">
                    {c.label}
                  </Link>
                ) : (
                  <span aria-current="page" className="text-ink-2">
                    {c.label}
                  </span>
                )}
                {i < crumbs.length - 1 ? <span aria-hidden="true">/</span> : null}
              </li>
            ))}
          </ol>
        </nav>
      ) : null}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          {eyebrow ? <p className="text-[11px] font-medium uppercase tracking-[0.06em] text-ink-3">{eyebrow}</p> : null}
          <h1 className="mt-1 text-[24px] font-semibold leading-tight tracking-[-0.02em] text-ink">{title}</h1>
          {description ? <div className="mt-1 max-w-3xl text-[13px] text-ink-2">{description}</div> : null}
        </div>
        {actions ? <div className="flex flex-wrap gap-2">{actions}</div> : null}
      </div>
    </header>
  );
}

export function EmptyState({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="rounded-[var(--radius-card)] border border-dashed border-line bg-surface px-6 py-8 text-center">
      <p className="text-[13px] font-semibold text-ink">{title}</p>
      {children ? <div className="mx-auto mt-1 max-w-md text-[12px] text-ink-3">{children}</div> : null}
    </div>
  );
}

/**
 * Honest placeholder for workflows scheduled in a later milestone. Shown
 * instead of a fake or dead button, and states exactly what will be built.
 */
export function PlannedWorkflow({ milestone, title, children }: { milestone: number; title: string; children: ReactNode }) {
  return (
    <aside
      className="mb-4 rounded-[var(--radius-card)] border border-[#e1e7de] bg-[#f3f6f1] px-4 py-3 text-[12px] text-ink-2"
      aria-label={`${title} — planned`}
    >
      <p className="flex items-center gap-2 font-semibold text-ink">
        <Icon name="info" size={14} /> {title} <Badge tone="info">Milestone {milestone}</Badge>
      </p>
      <div className="mt-1 leading-relaxed">{children}</div>
    </aside>
  );
}

export function MetricCard({
  label,
  value,
  note,
  definition,
  tone,
}: {
  label: string;
  value: ReactNode;
  note?: ReactNode;
  definition?: { definition: string; counts: string; excludes: string; timeRule: string };
  tone?: Tone;
}) {
  return (
    <Card as="div" className="flex flex-col">
      <p className="text-[12px] text-ink-3">{label}</p>
      <p
        className={`tabular mt-2 text-[26px] font-semibold leading-none tracking-[-0.03em] ${tone === "danger" ? "text-danger" : tone === "warning" ? "text-warning" : "text-ink"}`}
      >
        {value}
      </p>
      {note ? <p className="mt-1.5 text-[11px] text-ink-3">{note}</p> : null}
      {definition ? (
        <details className="mt-2 text-[11px] text-ink-3">
          <summary className="cursor-pointer select-none hover:text-ink">Metric definition</summary>
          <dl className="mt-1 space-y-1">
            <div>
              <dt className="inline font-semibold">Definition: </dt>
              <dd className="inline">{definition.definition}</dd>
            </div>
            <div>
              <dt className="inline font-semibold">Counts: </dt>
              <dd className="inline">{definition.counts}</dd>
            </div>
            <div>
              <dt className="inline font-semibold">Excludes: </dt>
              <dd className="inline">{definition.excludes}</dd>
            </div>
            <div>
              <dt className="inline font-semibold">Time rule: </dt>
              <dd className="inline">{definition.timeRule}</dd>
            </div>
          </dl>
        </details>
      ) : null}
    </Card>
  );
}

export function ButtonLink({ href, children, variant = "secondary" }: { href: string; children: ReactNode; variant?: "primary" | "secondary" }) {
  const cls = variant === "primary" ? "bg-accent text-white border-accent hover:bg-accent-hover" : "bg-surface text-ink border-line hover:bg-hover";
  return (
    <Link href={href} className={`inline-flex min-h-9 items-center gap-1.5 rounded-[var(--radius-control)] border px-3 text-[13px] font-medium ${cls}`}>
      {children}
    </Link>
  );
}

export function SyntheticDataNote() {
  return (
    <p className="mt-6 text-[11px] text-ink-3">
      All records shown are synthetic demonstration data. No real patient, staff or provider information is present.
    </p>
  );
}
