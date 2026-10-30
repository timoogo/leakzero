import type { ModuleDefinition } from '../modules/registry';
import type { SettingDefinition, SettingValue } from '../modules/schema';
import { SCHEMA_VERSION, settingKey, StorageKeys } from './keys';
import { legacyProtectionSettings, PROTECTION_FIELDS } from './settings';
import type { ProtectionSettings } from './types';

export type StorageItems = Record<string, unknown>;

function isValid(setting: SettingDefinition, value: unknown): value is SettingValue {
  switch (setting.type) {
    case 'switch': return typeof value === 'boolean';
    case 'select': return setting.options.some((option) => option.value === value);
    case 'slider': return typeof value === 'number' && value >= setting.min && value <= setting.max;
    case 'input':
    case 'textarea': return typeof value === 'string';
  }
}

/**
 * Every setting of a module: its stored value, or the YAML default when missing or invalid (off for the
 * primary switch, as content scripts read it).
 */
export function moduleValues(items: StorageItems, module: ModuleDefinition): Record<string, SettingValue> {
  const values: Record<string, SettingValue> = {};
  for (const setting of module.allSettings) {
    const stored = items[settingKey(module.id, setting.id)];
    values[setting.id] = isValid(setting, stored) ? stored : setting.primary ? false : setting.default;
  }
  return values;
}

export function isModuleActive(items: StorageItems, module: ModuleDefinition): boolean {
  return items[settingKey(module.id, module.primary.id)] === true;
}

/** Values of a new or reset module: YAML defaults, with its protection off whatever the YAML says. */
export function initialValues(module: ModuleDefinition): StorageItems {
  const items: StorageItems = {};
  for (const setting of module.allSettings) items[settingKey(module.id, setting.id)] = setting.primary ? false : setting.default;
  return items;
}

export function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

export type InstallReason = 'install' | 'update';

/**
 * Computes the writes that bring storage up to date with the registry. Idempotent: returns `{}` once
 * applied.
 * - First run of the module layout: a fresh install (reason "install" and no legacy settings) starts
 *   with every protection off and the welcome screen; an existing install gets its legacy `settings`
 *   copied (with the legacy defaults, so nothing is turned on or off) and skips the welcome screen.
 *   The legacy key is left in place.
 * - Modules missing from storage are added with their protection off and flagged "Nouveau", except on a
 *   fresh install and for the modules migrated from the legacy settings.
 * - Settings added to an existing module get their YAML default; stored values are never overwritten.
 */
export function planInitialization(items: StorageItems, modules: readonly ModuleDefinition[], reason: InstallReason): StorageItems {
  const patch: StorageItems = {};
  const migrating = items[StorageKeys.schemaVersion] === undefined;
  // Legacy settings prove an existing install, whatever the reported reason (Chrome can report
  // "install" for an unpacked extension reloaded into a profile that already has its storage).
  const fresh = migrating && reason === 'install' && items[StorageKeys.legacySettings] === undefined;
  if (migrating) {
    patch[StorageKeys.schemaVersion] = SCHEMA_VERSION;
    patch[StorageKeys.onboarded] = !fresh;
    if (!fresh) {
      const legacy = legacyProtectionSettings(items[StorageKeys.legacySettings]);
      for (const field of Object.keys(PROTECTION_FIELDS) as (keyof ProtectionSettings)[]) patch[PROTECTION_FIELDS[field]] = legacy[field];
    }
  }
  const current = { ...items, ...patch };
  const added: string[] = [];
  for (const module of modules) {
    if (current[settingKey(module.id, module.primary.id)] === undefined && !fresh) added.push(module.id);
    for (const [key, value] of Object.entries(initialValues(module))) {
      if (current[key] === undefined) patch[key] = value;
    }
  }
  if (added.length > 0) patch[StorageKeys.newModules] = [...new Set([...stringList(current[StorageKeys.newModules]), ...added])];
  return patch;
}

/** Runs `planInitialization` against chrome.storage.local and applies it in a single (atomic) write. */
export async function initializeState(modules: readonly ModuleDefinition[], reason: InstallReason): Promise<void> {
  const items = await chrome.storage.local.get(null);
  const patch = planInitialization(items, modules, reason);
  if (Object.keys(patch).length > 0) await chrome.storage.local.set(patch);
}
