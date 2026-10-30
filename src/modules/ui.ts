import type { ComponentType } from 'react';
import type { LucideIcon } from 'lucide-react';
import moduleIcons from 'virtual:leakzero-module-icons';
import type { ModuleDefinition } from './registry';
import { ModuleConfigError, type SettingValue } from './schema';

// Popup-only bindings between declarations and React code. Kept out of registry.ts so the service
// worker never bundles React components nor icons.

export interface ModuleComponentProps {
  module: ModuleDefinition;
  /** Current value of every setting of the module (stored value, or the YAML default). */
  values: Record<string, SettingValue>;
  /** Saves a setting of this module immediately. */
  setValue: (settingId: string, value: SettingValue) => void;
}

export type ModuleComponent = ComponentType<ModuleComponentProps>;

export interface ModuleUi {
  Icon: LucideIcon;
  Component?: ModuleComponent;
  AdvancedComponent?: ModuleComponent;
}

/**
 * Resolves each module's icon and the components its declaration names. A component is only looked up
 * in `./<module id>/components/<Name>.tsx`, never by arbitrary path.
 */
export function bindModuleUi(
  modules: readonly ModuleDefinition[],
  componentFiles: Record<string, ModuleComponent>,
  icons: Record<string, LucideIcon> = moduleIcons,
): Map<string, ModuleUi> {
  const issues: string[] = [];
  const bindings = new Map<string, ModuleUi>();
  const component = (module: ModuleDefinition, name: string | undefined) => {
    if (!name) return undefined;
    const found = componentFiles[`./${module.id}/components/${name}.tsx`];
    if (typeof found !== 'function') issues.push(`${module.id}: component "${name}" not found in components/${name}.tsx (default export)`);
    return found;
  };
  for (const module of modules) {
    const Icon = icons[module.icon];
    if (!Icon) issues.push(`${module.id}: unknown Lucide icon "${module.icon}"`);
    bindings.set(module.id, { Icon: Icon!, Component: component(module, module.component), AdvancedComponent: component(module, module.advanced?.component) });
  }
  if (issues.length > 0) throw new ModuleConfigError(issues);
  return bindings;
}

export const componentFiles = import.meta.glob<ModuleComponent>('./*/components/*.tsx', { eager: true, import: 'default' });
