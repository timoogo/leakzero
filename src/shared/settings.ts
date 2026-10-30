import { settingKey, StorageKeys } from './keys';
import type { ProtectionSettings } from './types';

/** Where each scanner option is stored: the `phone` and `media` modules (src/modules/*\/module.yaml). */
export const PROTECTION_FIELDS: Record<keyof ProtectionSettings, string> = {
  maskPhones: settingKey('phone', 'enabled'),
  reinforcedPhones: settingKey('phone', 'reinforced'),
  maskMedia: settingKey('media', 'enabled'),
};

/** Applied by content scripts until the stored settings are read: nothing is shown unprotected meanwhile. */
export const FAIL_CLOSED: ProtectionSettings = { maskPhones: true, reinforcedPhones: false, maskMedia: true };

// Defaults of the legacy `settings` key: an install that never changed them had everything but the
// reinforced mode on.
const LEGACY_DEFAULTS: ProtectionSettings = { maskPhones: true, reinforcedPhones: false, maskMedia: true };

/** Settings of an install that predates the module layout, as the previous version applied them. */
export function legacyProtectionSettings(stored: unknown): ProtectionSettings {
  const legacy = typeof stored === 'object' && stored ? (stored as Record<string, unknown>) : {};
  const result = { ...LEGACY_DEFAULTS };
  for (const field of Object.keys(result) as (keyof ProtectionSettings)[]) {
    if (typeof legacy[field] === 'boolean') result[field] = legacy[field];
  }
  return result;
}

const READ_KEYS = [StorageKeys.schemaVersion, StorageKeys.legacySettings, ...Object.values(PROTECTION_FIELDS)];

export function toProtectionSettings(items: Record<string, unknown>): ProtectionSettings {
  // Not migrated yet (the service worker migrates on install/update): keep the previous behaviour.
  if (items[StorageKeys.schemaVersion] === undefined) return legacyProtectionSettings(items[StorageKeys.legacySettings]);
  // A missing value means off: modules start disabled.
  const result = {} as ProtectionSettings;
  for (const [field, key] of Object.entries(PROTECTION_FIELDS)) result[field as keyof ProtectionSettings] = items[key] === true;
  return result;
}

/**
 * Calls `listener` with the stored settings now, then whenever they change in any context. Returns a
 * function that stops listening. If storage cannot be read, the previous settings stay applied.
 */
export function watchProtectionSettings(listener: (settings: ProtectionSettings) => void, storage = chrome.storage): () => void {
  // chrome.storage processes calls in order, so the last read always reflects the latest write.
  const read = () => {
    storage.local.get(READ_KEYS).then(
      (items) => listener(toProtectionSettings(items)),
      (error: unknown) => console.warn('LeakZero: settings could not be read', error),
    );
  };
  const onChanged = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
    if (area === 'local' && READ_KEYS.some((key) => key in changes)) read();
  };
  storage.onChanged.addListener(onChanged);
  read();
  return () => {
    try {
      storage.onChanged.removeListener(onChanged);
    } catch {
      // Extension context already invalidated: no event can arrive anyway.
    }
  };
}
