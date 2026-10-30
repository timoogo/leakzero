import { allSettings, ModuleConfigError, validateModuleDeclaration, type ModuleDeclaration, type SettingDefinition, type SwitchSetting } from './schema';

export interface ModuleDefinition extends ModuleDeclaration {
  /** The module's main switch (`primary: true`). */
  primary: SwitchSetting;
  /** Main then advanced settings. */
  allSettings: SettingDefinition[];
}

/**
 * Validates declarations keyed by their path (`…/<directory>/module.yaml`) and returns them sorted by
 * `order`, then id. Collects every problem of every module before throwing a single ModuleConfigError.
 */
export function buildRegistry(entries: Record<string, unknown>): ModuleDefinition[] {
  const issues: string[] = [];
  const modules: ModuleDefinition[] = [];
  const seen = new Map<string, string>();
  for (const [path, raw] of Object.entries(entries)) {
    const directory = /([^/]+)\/module\.ya?ml$/.exec(path)?.[1];
    try {
      const declaration = validateModuleDeclaration(raw, path, { directory });
      const duplicate = seen.get(declaration.id);
      if (duplicate) {
        issues.push(`${path}: duplicate module id "${declaration.id}" (also declared in ${duplicate})`);
        continue;
      }
      seen.set(declaration.id, path);
      const settings = allSettings(declaration);
      modules.push({ ...declaration, primary: settings.find((setting) => setting.primary) as SwitchSetting, allSettings: settings });
    } catch (error) {
      if (!(error instanceof ModuleConfigError)) throw error;
      issues.push(...error.issues);
    }
  }
  if (issues.length > 0) throw new ModuleConfigError(issues);
  return modules.sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
}

// Discovered at build time: adding `src/modules/<id>/module.yaml` is enough to register a module.
// YAML files are converted to JSON (and validated) by the `leakzero-module-yaml` plugin in vite.config.ts.
// React components and icons are bound separately, in the popup only (see ./ui.ts).
export const modules: readonly ModuleDefinition[] = buildRegistry(import.meta.glob('./*/module.yaml', { eager: true, import: 'default' }));
