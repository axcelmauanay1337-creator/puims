/**
 * Controlled vocabularies. Every list here is POLICY-PENDING: the hospital must
 * approve final values (docs/00-MILESTONE-0-PLAN.md, U-05/U-06). Raw imported
 * values are always preserved separately from these normalized codes.
 */

export type Role = "CHIEF_RT_ADMIN" | "RESPIRATORY_THERAPIST";

export const ROLE_LABELS: Record<Role, string> = {
  CHIEF_RT_ADMIN: "Chief RT (Administrator)",
  RESPIRATORY_THERAPIST: "Respiratory Therapist",
};

export type PatientCategory = "OPD" | "INP" | "OTHER";

export type ServiceType = "NEBULIZATION" | "MECHANICAL_VENTILATION" | "TUBING_REPLACEMENT" | "PFT" | "ABG" | "SPUTUM_INDUCTION";

export const SERVICE_LABELS: Record<ServiceType, string> = {
  NEBULIZATION: "Nebulization",
  MECHANICAL_VENTILATION: "Mechanical ventilation",
  TUBING_REPLACEMENT: "Tubing replacement",
  PFT: "PFT",
  ABG: "ABG",
  SPUTUM_INDUCTION: "Sputum induction",
};

export type DiagnosticService = "PFT" | "ABG" | "SPUTUM_INDUCTION";

export type NebulizationStatus = "SCHEDULED" | "PENDING" | "IN_PROGRESS" | "COMPLETED" | "DELAYED" | "NOT_GIVEN" | "REFUSED" | "CANCELLED";

export type DiagnosticStatus = "SCHEDULED" | "PENDING" | "COMPLETED" | "NO_SHOW" | "CANCELLED" | "FOR_RESCHEDULE" | "RESCHEDULED";

/** Statuses that require a documented reason. */
export const REASON_REQUIRED_STATUSES: readonly NebulizationStatus[] = ["NOT_GIVEN", "REFUSED", "CANCELLED", "DELAYED"];

export const FREQUENCY_PRESETS = ["STAT", "ONCE", "BID", "TID", "QID", "Q4H", "Q6H", "Q8H", "Q12H", "PRN", "CUSTOM"] as const;
export type FrequencyPreset = (typeof FREQUENCY_PRESETS)[number];

export type Tone = "neutral" | "info" | "success" | "warning" | "danger";

export interface StatusPresentation {
  label: string;
  tone: Tone;
  /** Non-colour cue so status is never conveyed by colour alone. */
  glyph: string;
}

export const STATUS_PRESENTATION: Record<string, StatusPresentation> = {
  SCHEDULED: { label: "Scheduled", tone: "info", glyph: "○" },
  PENDING: { label: "Pending", tone: "warning", glyph: "◔" },
  IN_PROGRESS: { label: "In progress", tone: "info", glyph: "◑" },
  COMPLETED: { label: "Completed", tone: "success", glyph: "✓" },
  DELAYED: { label: "Delayed", tone: "warning", glyph: "!" },
  NOT_GIVEN: { label: "Not given", tone: "danger", glyph: "✕" },
  REFUSED: { label: "Refused", tone: "danger", glyph: "✕" },
  CANCELLED: { label: "Cancelled", tone: "neutral", glyph: "–" },
  NO_SHOW: { label: "No-show", tone: "danger", glyph: "✕" },
  FOR_RESCHEDULE: { label: "For reschedule", tone: "warning", glyph: "↻" },
  RESCHEDULED: { label: "Rescheduled", tone: "neutral", glyph: "↻" },
  ACTIVE: { label: "Active", tone: "success", glyph: "●" },
  DISCONTINUED: { label: "Discontinued", tone: "neutral", glyph: "■" },
  // Tubing
  NO_RECORD: { label: "No record", tone: "danger", glyph: "?" },
  CURRENT: { label: "Current", tone: "success", glyph: "✓" },
  UPCOMING: { label: "Upcoming", tone: "info", glyph: "◷" },
  DUE: { label: "Due today", tone: "warning", glyph: "!" },
  OVERDUE: { label: "Overdue", tone: "danger", glyph: "‼" },
  // Handover
  ACKNOWLEDGED: { label: "Acknowledged", tone: "success", glyph: "✓" },
  AWAITING_ACK: { label: "Awaiting acknowledgment", tone: "warning", glyph: "◔" },
  // Accounts
  INVITED: { label: "Invited", tone: "info", glyph: "✉" },
  DEACTIVATED: { label: "Deactivated", tone: "neutral", glyph: "■" },
};

export function presentStatus(code: string): StatusPresentation {
  return STATUS_PRESENTATION[code] ?? { label: code, tone: "neutral", glyph: "·" };
}
