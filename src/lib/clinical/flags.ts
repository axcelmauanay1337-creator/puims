/** Patient flags, HFNC/NIV devices and equipment kinds (redesign, 2026-11-23). */

export const PRECAUTIONS = ["AIRBORNE", "DROPLET", "CONTACT", "FALL_RISK", "ASPIRATION", "BLEEDING_RISK"] as const;
export type Precaution = (typeof PRECAUTIONS)[number];
export const PRECAUTION_LABELS: Record<Precaution, string> = {
  AIRBORNE: "Airborne",
  DROPLET: "Droplet",
  CONTACT: "Contact",
  FALL_RISK: "Fall risk",
  ASPIRATION: "Aspiration",
  BLEEDING_RISK: "Bleeding risk",
};

export const OWN_SUPPLIES = ["OWN_MEDICATION", "OWN_MESH_NEBULIZER", "OWN_NEBULIZER_MACHINE"] as const;
export type OwnSupply = (typeof OWN_SUPPLIES)[number];
export const OWN_SUPPLY_LABELS: Record<OwnSupply, string> = {
  OWN_MEDICATION: "Own medication",
  OWN_MESH_NEBULIZER: "Own mesh nebulizer",
  OWN_NEBULIZER_MACHINE: "Own nebulizer machine",
};

export const NIV_DEVICES = ["HFNC", "BIPAP", "CPAP"] as const;
export type NivDevice = (typeof NIV_DEVICES)[number];
export const NIV_LABELS: Record<NivDevice, string> = { HFNC: "HFNC", BIPAP: "BiPAP", CPAP: "CPAP" };
export const NIV_SETTING_HINT: Record<NivDevice, string> = {
  HFNC: "e.g. 40 L/min · FiO₂ 35%",
  BIPAP: "e.g. IPAP 12 · EPAP 5 · FiO₂ 40%",
  CPAP: "e.g. CPAP 8 · FiO₂ 40%",
};

export const EQUIPMENT_KINDS = ["VENTILATOR", "HFNC", "BIPAP"] as const;
export type EquipmentKind = (typeof EQUIPMENT_KINDS)[number];
export const EQUIPMENT_KIND_LABELS: Record<EquipmentKind, string> = { VENTILATOR: "Ventilator", HFNC: "HFNC", BIPAP: "BiPAP / CPAP" };
