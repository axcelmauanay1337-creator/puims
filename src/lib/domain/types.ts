/**
 * Domain read models shared by server and UI. They mirror the entity map in
 * docs/00-MILESTONE-0-PLAN.md §6 and will be backed by PostgreSQL in Milestone 2.
 * Timestamps cross the server→client boundary as ISO-8601 UTC strings.
 */
import type { DiagnosticService, DiagnosticStatus, FrequencyPreset, NebulizationStatus, PatientCategory, Role, ServiceType } from "@/lib/clinical/vocabulary";
import type { ShiftCode } from "@/lib/time/shifts";
import type { IsoDate } from "@/lib/time/zoned";

export type Uuid = string;
export type IsoInstant = string;

export interface StaffMember {
  id: Uuid;
  displayName: string;
  initials: string;
  role: Role;
  accountStatus: "ACTIVE" | "INVITED" | "DEACTIVATED";
  createdAt: IsoInstant;
  lastActiveAt: IsoInstant | null;
}

export interface Patient {
  id: Uuid;
  /** Optional (decision U-13). */
  hospitalPatientId: string | null;
  fullName: string;
  dateOfBirth: IsoDate | null;
  /** Only M or F (decision U-07); null = not recorded. */
  sex: "M" | "F" | null;
  category: PatientCategory;
  wardRoom: string | null;
  createdAt: IsoInstant;
  updatedAt: IsoInstant;
  provenance: "MANUAL" | "IMPORT";
}

export interface ShiftAssignment {
  id: Uuid;
  operationalDate: IsoDate;
  shift: ShiftCode;
  staffId: Uuid;
}

export interface NebulizationOrder {
  id: Uuid;
  patientId: Uuid;
  orderReference: string;
  prescriber: string;
  medicationAsOrdered: string;
  frequency: FrequencyPreset;
  /** Times explicitly written on the clinician's order — never derived from frequency. */
  prescribedTimes: string[];
  startAt: IsoInstant;
  endAt: IsoInstant | null;
}

export interface NebulizationAdministration {
  id: Uuid;
  orderId: Uuid;
  patientId: Uuid;
  scheduledAt: IsoInstant | null;
  actualAt: IsoInstant | null;
  status: NebulizationStatus;
  performedBy: Uuid | null;
  reason: string | null;
}

export interface VentilatorEncounter {
  id: Uuid;
  patientId: Uuid;
  hookedAt: IsoInstant;
  disconnectedAt: IsoInstant | null;
  ventilatorRef: string;
  wardRoom: string;
  responsibleStaffId: Uuid;
  status: "ACTIVE" | "DISCONTINUED";
}

export interface TubingReplacement {
  id: Uuid;
  encounterId: Uuid;
  tubingType: string;
  installedAt: IsoInstant;
  performedBy: Uuid;
  reason: string;
}

export interface DiagnosticAppointment {
  id: Uuid;
  patientId: Uuid;
  service: DiagnosticService;
  scheduledAt: IsoInstant;
  status: DiagnosticStatus;
  /** Raw status label as entered/imported; kept alongside the normalized code. */
  rawStatus: string;
  procedureLabel: string;
  requestingPhysician: string;
  category: PatientCategory;
  schedulerId: Uuid;
  performedBy: Uuid | null;
  /** Lineage: the appointment this one reschedules (separate event, never collapsed). */
  reschedulesId: Uuid | null;
  remarks: string | null;
}

export interface HandoverItemRef {
  kind: "VENTILATOR_ENCOUNTER" | "NEBULIZATION_ADMIN" | "NEBULIZATION_ORDER" | "TUBING" | "DIAGNOSTIC";
  refId: Uuid;
  summary: string;
}

export interface ShiftHandover {
  id: Uuid;
  operationalDate: IsoDate;
  shift: ShiftCode;
  outgoingStaffId: Uuid;
  incomingStaffId: Uuid | null;
  /** Open items carried forward BY REFERENCE to the original records. */
  pendingItems: HandoverItemRef[];
  equipmentConcerns: string | null;
  notes: string;
  createdAt: IsoInstant;
  acknowledgedAt: IsoInstant | null;
}

export interface ActivityEvent {
  id: Uuid;
  service: ServiceType;
  patientId: Uuid;
  staffId: Uuid;
  occurredAt: IsoInstant;
  status: string;
  sourceId: Uuid;
}

export interface AuditEntry {
  id: number;
  actorId: Uuid;
  action: string;
  target: string;
  occurredAt: IsoInstant;
  deviceLabel: string;
}

export interface DeviceRecord {
  id: Uuid;
  label: string;
  platform: string;
  ownerId: Uuid;
  registeredAt: IsoInstant;
  lastSeenAt: IsoInstant;
  offlinePhiStorage: "DISABLED";
  status: "ACTIVE" | "REVOKED";
}
