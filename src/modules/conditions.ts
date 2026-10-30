import type { Condition, SettingDefinition, SettingValue } from './schema';

export function evaluate(condition: Condition, values: Record<string, SettingValue>): boolean {
  if ('setting' in condition) return values[condition.setting] === condition.equals;
  if ('all' in condition) return condition.all.every((child) => evaluate(child, values));
  return condition.any.some((child) => evaluate(child, values));
}

/** Greyed out: its stored value is kept as is, it just cannot be edited. */
export function isDisabled(setting: SettingDefinition, values: Record<string, SettingValue>): boolean {
  if (setting.disabledWhen && evaluate(setting.disabledWhen, values)) return true;
  return (setting.requires ?? []).some((id) => values[id] !== true);
}

export function isVisible(setting: SettingDefinition, values: Record<string, SettingValue>): boolean {
  return !setting.visibleWhen || evaluate(setting.visibleWhen, values);
}
