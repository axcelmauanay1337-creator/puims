"use client";

import Link from "next/link";
import { DataTable, type Column } from "@/components/ui/DataTable";
import { Badge, StatusBadge } from "@/components/ui/primitives";
import { FlagChips } from "@/components/workspace/Flags";
import type { OwnSupply, Precaution } from "@/lib/clinical/flags";

import { SERVICE_LABELS, type ServiceType } from "@/lib/clinical/vocabulary";
import { SHIFT_DEFINITIONS, type ShiftCode } from "@/lib/time/shifts";
import { formatDateTime, formatDayTime } from "@/lib/time/zoned";

const ts = (iso: string | null) => (iso ? Date.parse(iso) : null);
const dt = (iso: string | null) =>
  iso ? <span className="tabular whitespace-nowrap">{formatDateTime(new Date(iso))}</span> : <span className="text-ink-3">—</span>;

interface PatientRef {
  id: string;
  name: string;
  hospitalId: string;
  category: string;
  wardRoom: string | null;
}

function PatientCell({ p }: { p: PatientRef }) {
  return (
    <Link href={`/patients/${p.id}`} className="group block min-w-0">
      <span className="block font-medium group-hover:underline">{p.name}</span>
      <span className="block text-[11px] text-ink-3">
        {p.hospitalId} · {p.category}
        {p.wardRoom ? ` · ${p.wardRoom}` : ""}
      </span>
    </Link>
  );
}

const statusOptions = (codes: string[]) =>
  codes.map((c) => ({
    value: c,
    label: c
      .replaceAll("_", " ")
      .toLowerCase()
      .replace(/^./, (x) => x.toUpperCase()),
  }));

// ---------------------------------------------------------------- patients

export interface PatientRow {
  id: string;
  hospitalId: string;
  name: string;
  dob: string | null;
  age: number | null;
  sex: string;
  category: string;
  wardRoom: string | null;
  provenance: string;
  contactInfo: string | null;
  attendingPhysician: string | null;
  mghIso: string | null;
  precautions: Precaution[];
  ownSupplies: OwnSupply[];
  endorsement: string | null;
}

export function PatientsTable({ rows }: { rows: PatientRow[] }) {
  const columns: Column<PatientRow>[] = [
    {
      key: "hid",
      header: "Hospital no.",
      cell: (r) => (
        <Link href={`/patients/${r.id}`} className="tabular font-medium text-accent-ink hover:underline">
          {r.hospitalId}
        </Link>
      ),
      sort: (r) => r.hospitalId,
    },
    {
      key: "name",
      header: "Name",
      cell: (r) => (
        <Link href={`/patients/${r.id}`} className="block min-w-0">
          <span className="block font-medium hover:underline">{r.name}</span>
          <span className="mt-1 flex flex-wrap gap-1">
            {r.mghIso ? <span className="rounded-full bg-warning-soft px-2 py-0.5 text-[11px] font-bold text-warning">MGH</span> : null}
            <FlagChips flags={r} />
          </span>
        </Link>
      ),
      sort: (r) => r.name,
    },
    {
      key: "age",
      header: "Age / sex",
      cell: (r) => (
        <span className="tabular">
          {r.age ?? "—"} / {r.sex ?? "—"}
        </span>
      ),
      sort: (r) => r.age,
    },
    { key: "cat", header: "Category", cell: (r) => <Badge tone={r.category === "INP" ? "info" : "neutral"}>{r.category}</Badge>, sort: (r) => r.category },
    { key: "ward", header: "Ward / room", cell: (r) => r.wardRoom ?? <span className="text-ink-3">—</span>, sort: (r) => r.wardRoom },
    {
      key: "src",
      header: "Source",
      cell: (r) => <span className="text-[12px] text-ink-2">{r.provenance === "IMPORT" ? "Imported" : "Manual"}</span>,
      hideOnCard: true,
    },
    { key: "contact", header: "Contact info", cell: (r) => r.contactInfo ?? <span className="text-ink-3">—</span> },
    {
      key: "md",
      header: "Attending physician",
      cell: (r) => r.attendingPhysician ?? <span className="text-ink-3">—</span>,
      sort: (r) => r.attendingPhysician ?? "",
    },
  ];
  return (
    <DataTable
      rows={rows}
      columns={columns}
      rowKey={(r) => r.id}
      caption="Patient masterlist"
      searchPlaceholder="Hospital no. or name"
      searchText={(r) => `${r.hospitalId} ${r.name} ${r.wardRoom ?? ""} ${r.attendingPhysician ?? ""}`}
      filters={[
        {
          key: "mgh",
          label: "Status",
          options: [
            { value: "IN", label: "Admitted / active" },
            { value: "MGH", label: "MGH" },
          ],
          match: (r, v) => (v === "MGH" ? !!r.mghIso : !r.mghIso),
        },
        {
          key: "cat",
          label: "Category",
          options: statusOptions(["OPD", "INP", "OTHER"]).map((o) => ({ ...o, label: o.value })),
          match: (r, v) => r.category === v,
        },
      ]}
      initialSort={{ key: "name", dir: "asc" }}
      emptyTitle="No matching patients"
      emptyText="Try the hospital number. Patients are never merged or matched by name alone."
    />
  );
}

// ---------------------------------------------------------------- nebulization

// ---------------------------------------------------------------- ventilation & tubing

export interface VentRow {
  id: string;
  patient: PatientRef;
  hookedIso: string;
  disconnectedIso: string | null;
  ventilatorRef: string;
  wardRoom: string;
  responsible: string;
  status: string;
  tubingStatus: string | null;
  airway: { type: string | null; size: string | null; position: string | null };
  disconnectReason: string | null;
  disconnectNote: string | null;
  settings: VentSettingView[];
}

export interface VentSettingView {
  id: string;
  atIso: string;
  mode: string;
  modeOther: string | null;
  values: Record<string, number>;
  note: string | null;
  by: string;
  byId: string;
  voided: boolean;
  voidReason: string | null;
}

export interface TubingRowView {
  encounterId: string;
  patient: PatientRef;
  ventilatorRef: string;
  wardRoom: string;
  lastInstalledIso: string | null;
  nextDueIso: string | null;
  msUntilDue: number | null;
  status: string;
  history: Array<{ id: string; installedIso: string; by: string; byId: string; reason: string; voided: boolean; voidReason: string | null }>;
}

// ---------------------------------------------------------------- diagnostics

// ---------------------------------------------------------------- activity

export interface ActivityRow {
  id: string;
  service: ServiceType;
  occurredIso: string;
  status: string;
  staff: string;
  shift: ShiftCode;
  patient: PatientRef;
}

export function ActivityTable({ rows, showStaff }: { rows: ActivityRow[]; showStaff: boolean }) {
  const columns: Column<ActivityRow>[] = [
    {
      key: "time",
      header: "Event time",
      cell: (r) => <span className="tabular font-semibold">{formatDayTime(new Date(r.occurredIso))}</span>,
      sort: (r) => ts(r.occurredIso),
    },
    { key: "shift", header: "Shift", cell: (r) => SHIFT_DEFINITIONS[r.shift].label, sort: (r) => r.shift },
    { key: "svc", header: "Service", cell: (r) => SERVICE_LABELS[r.service], sort: (r) => r.service },
    {
      key: "status",
      header: "Event",
      cell: (r) =>
        r.status === "HOOK_IN" ? (
          <Badge tone="info">Hook-in</Badge>
        ) : r.status === "DISCONNECTION" ? (
          <Badge>Disconnection</Badge>
        ) : (
          <StatusBadge status={r.status} />
        ),
    },
    { key: "patient", header: "Patient", cell: (r) => <PatientCell p={r.patient} /> },
    ...(showStaff ? [{ key: "staff", header: "RT", cell: (r: ActivityRow) => r.staff, sort: (r: ActivityRow) => r.staff }] : []),
  ];
  return (
    <DataTable
      rows={rows}
      columns={columns}
      rowKey={(r) => r.id}
      caption="RT activity events"
      searchPlaceholder="Patient or hospital no."
      searchText={(r) => `${r.patient.name} ${r.patient.hospitalId} ${r.staff}`}
      filters={[
        { key: "svc", label: "Service", options: Object.entries(SERVICE_LABELS).map(([value, label]) => ({ value, label })), match: (r, v) => r.service === v },
        {
          key: "sh",
          label: "Shift",
          options: (["MORNING", "AFTERNOON", "NIGHT"] as const).map((s) => ({ value: s, label: SHIFT_DEFINITIONS[s].label })),
          match: (r, v) => r.shift === v,
        },
      ]}
      initialSort={{ key: "time", dir: "desc" }}
      emptyTitle="No documented events in this operational day"
    />
  );
}

// ---------------------------------------------------------------- admin

export interface AuditRow {
  id: number;
  actor: string;
  action: string;
  target: string;
  occurredAt: string;
  deviceLabel: string;
}

export function AuditTable({ rows }: { rows: AuditRow[] }) {
  const columns: Column<AuditRow>[] = [
    { key: "time", header: "Time", cell: (r) => dt(r.occurredAt), sort: (r) => ts(r.occurredAt) },
    { key: "actor", header: "Actor", cell: (r) => r.actor, sort: (r) => r.actor },
    { key: "action", header: "Action", cell: (r) => <code className="rounded bg-neutral-soft px-1 text-[12px]">{r.action}</code>, sort: (r) => r.action },
    { key: "target", header: "Target", cell: (r) => <code className="text-[12px] text-ink-2">{r.target}</code> },
    { key: "device", header: "Device", cell: (r) => r.deviceLabel },
  ];
  return (
    <DataTable
      rows={rows}
      columns={columns}
      rowKey={(r) => String(r.id)}
      caption="Audit log"
      searchPlaceholder="Actor or action"
      searchText={(r) => `${r.actor} ${r.action}`}
      initialSort={{ key: "time", dir: "desc" }}
    />
  );
}
