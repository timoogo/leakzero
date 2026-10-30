export interface ProtectionSettings {
  /** Phone numbers and generic sequences of 3+ digits (key kept for stored settings). */
  maskPhones: boolean;
  /** Reinforced mode: phone masks drawn as an opaque labelled box. Only applies when maskPhones is on. */
  reinforcedPhones: boolean;
  maskMedia: boolean;
}
