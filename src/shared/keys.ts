// chrome.storage.local layout. Protection settings (`protection:*`, read by content scripts) and popup
// state (`ui:*`) live under separate prefixes; each setting has its own key, so a write never has to
// read-modify-write another setting and concurrent writers cannot overwrite each other's changes.

/** Present once the per-module layout below has been initialized (see shared/state.ts). */
export const SCHEMA_VERSION = 1;

export const StorageKeys = {
  schemaVersion: 'schemaVersion',
  /** Pre-module layout: `{ maskPhones, reinforcedPhones, maskMedia }`. Read for migration, never written or removed. */
  legacySettings: 'settings',
  onboarded: 'ui:onboarded',
  /** Ids of the expanded accordions. */
  openSections: 'ui:openSections',
  /** Ids of modules added by an update and not opened yet ("Nouveau" badge). */
  newModules: 'ui:newModules',
} as const;

export function settingKey(moduleId: string, settingId: string): string {
  return `protection:${moduleId}.${settingId}`;
}
