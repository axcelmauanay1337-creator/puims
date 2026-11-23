import type { DiagnosticService } from "./vocabulary";

/**
 * Procedure choices for booking, taken from the labels the Pulmonary Unit uses in its
 * PFT scheduling workbook. "Other" lets the RT type a label as requested; imported
 * appointments keep their label exactly as written.
 */
export const PROCEDURE_OPTIONS: Record<DiagnosticService, readonly string[]> = {
  PFT: [
    "SIMPLE PFT W/ POST BD",
    "COMPLETE PFT W/ POST BD",
    "COMPLETE PFT W/ POST BD & DLCO",
    "SIMPLE PFT W/ POST BD & DLCO & LUNG VOLUME",
    "LUNG VOLUME STUDIES",
    "LUNG VOLUME AND DLCO",
  ],
  ABG: ["ABG"],
  SPUTUM_INDUCTION: ["SPUTUM INDUCTION"],
};

export const OTHER_PROCEDURE = "__other__";
