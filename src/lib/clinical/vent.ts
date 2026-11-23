/** Ventilator documentation vocabulary shared by the server and the forms. Documentation only — no advice or interpretation. */

export const VENT_MODES = ["VC_AC", "PC_AC", "PRVC", "SIMV_VC", "SIMV_PC", "PSV_CPAP", "APRV", "NIV_BIPAP", "NIV_CPAP", "OTHER"] as const;
export const VENT_MODE_LABEL: Record<(typeof VENT_MODES)[number], string> = {
  VC_AC: "Volume control A/C",
  PC_AC: "Pressure control A/C",
  PRVC: "PRVC",
  SIMV_VC: "SIMV (volume)",
  SIMV_PC: "SIMV (pressure)",
  PSV_CPAP: "PSV / CPAP (spontaneous)",
  APRV: "APRV",
  NIV_BIPAP: "NIV BiPAP",
  NIV_CPAP: "NIV CPAP",
  OTHER: "Other",
};

export const AIRWAY_TYPES = ["ETT", "TRACHEOSTOMY", "NIV_MASK", "OTHER"] as const;
export const AIRWAY_LABEL: Record<(typeof AIRWAY_TYPES)[number], string> = {
  ETT: "Endotracheal tube",
  TRACHEOSTOMY: "Tracheostomy",
  NIV_MASK: "NIV mask",
  OTHER: "Other",
};

export const DISCONNECT_REASONS = ["EXTUBATED", "LIBERATED_TRACH", "CHANGED_TO_NIV", "TRANSFERRED", "EXPIRED", "EQUIPMENT_CHANGE", "OTHER"] as const;
export const DISCONNECT_LABEL: Record<(typeof DISCONNECT_REASONS)[number], string> = {
  EXTUBATED: "Extubated",
  LIBERATED_TRACH: "Off ventilator (trach collar / T-piece)",
  CHANGED_TO_NIV: "Changed to NIV",
  TRANSFERRED: "Transferred out",
  EXPIRED: "Expired",
  EQUIPMENT_CHANGE: "Ventilator changed",
  OTHER: "Other",
};

/** Numeric fields: [label, min, max, integer, group]. Ranges only stop typing errors; they are not clinical limits. */
export const VENT_NUMBERS = {
  fio2: ["FiO₂ (%)", 21, 100, true, "set"],
  peep: ["PEEP / EPAP (cmH₂O)", 0, 30, false, "set"],
  tidalVolume: ["Tidal volume (mL)", 20, 2000, true, "set"],
  setRate: ["Rate (/min)", 0, 80, true, "set"],
  pressureSupport: ["Pressure support (cmH₂O)", 0, 40, false, "set"],
  inspiratoryPressure: ["Insp. pressure / IPAP (cmH₂O)", 0, 60, false, "set"],
  inspiratoryTime: ["Insp. time (s)", 0.1, 5, false, "set"],
  peakPressure: ["Peak pressure (cmH₂O)", 0, 80, false, "measured"],
  plateauPressure: ["Plateau pressure (cmH₂O)", 0, 60, false, "measured"],
  totalRate: ["Total rate (/min)", 0, 90, true, "measured"],
  exhaledVt: ["Exhaled Vt (mL)", 0, 3000, true, "measured"],
  minuteVentilation: ["Minute ventilation (L/min)", 0, 50, false, "measured"],
  spo2: ["SpO₂ (%)", 50, 100, true, "measured"],
  cuffPressure: ["Cuff pressure (cmH₂O)", 0, 60, true, "measured"],
} as const;
export type VentNumberKey = keyof typeof VENT_NUMBERS;
export const REQUIRED_VENT_NUMBERS: VentNumberKey[] = ["fio2", "peep"];
