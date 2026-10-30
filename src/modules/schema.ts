import { z } from 'zod';

// Schema of `src/modules/<id>/module.yaml`. The YAML only describes settings and how they relate;
// protection algorithms stay in TypeScript and nothing in a declaration is ever executed.
// Imported by vite.config.ts too, so an invalid declaration fails `pnpm build` (and `pnpm dev`).

export type SettingValue = boolean | string | number;

export type Condition =
  | { setting: string; equals: SettingValue }
  | { all: Condition[] }
  | { any: Condition[] };

const condition: z.ZodType<Condition> = z.lazy(() =>
  z.union([
    z.strictObject({ setting: z.string(), equals: z.union([z.boolean(), z.string(), z.number()]) }),
    z.strictObject({ all: z.array(condition).min(1) }),
    z.strictObject({ any: z.array(condition).min(1) }),
  ]),
);

const settingBase = {
  id: z.string().regex(/^[a-z][a-zA-Z0-9]*$/, 'must be camelCase ([a-z][a-zA-Z0-9]*)'),
  label: z.string().min(1),
  description: z.string().min(1).optional(),
  /** The module's main switch: drives the Actif/Inactif state and is forced off for new modules and on reset. */
  primary: z.boolean().optional(),
  disabledWhen: condition.optional(),
  visibleWhen: condition.optional(),
  /** Switches that must be on for this setting to be editable. */
  requires: z.union([z.string(), z.array(z.string()).min(1)]).transform((value) => (Array.isArray(value) ? value : [value])).optional(),
};

const textBase = { placeholder: z.string().optional(), maxLength: z.number().int().positive().optional() };

const setting = z.discriminatedUnion('type', [
  z.strictObject({ ...settingBase, type: z.literal('switch'), default: z.boolean() }),
  z.strictObject({
    ...settingBase,
    type: z.literal('select'),
    options: z.array(z.strictObject({ value: z.string().min(1), label: z.string().min(1) })).min(1),
    default: z.string(),
  }),
  z.strictObject({
    ...settingBase,
    type: z.literal('slider'),
    min: z.number(),
    max: z.number(),
    step: z.number().positive().default(1),
    unit: z.string().optional(),
    default: z.number(),
  }),
  z.strictObject({ ...settingBase, ...textBase, type: z.literal('input'), default: z.string().default('') }),
  z.strictObject({ ...settingBase, ...textBase, type: z.literal('textarea'), default: z.string().default('') }),
]);

const componentName = z.string().regex(/^[A-Z][A-Za-z0-9]*$/, 'must be the PascalCase name of a file in components/');

export const moduleSchema = z.strictObject({
  id: z.string().regex(/^[a-z][a-z0-9-]*$/, 'must be kebab-case ([a-z][a-z0-9-]*)'),
  title: z.string().min(1),
  description: z.string().min(1).optional(),
  icon: z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, 'must be a kebab-case Lucide icon name'),
  order: z.number().int(),
  settings: z.array(setting).min(1),
  /** Custom React component rendered in the accordion after the generated settings. */
  component: componentName.optional(),
  advanced: z
    .strictObject({
      title: z.string().min(1).optional(),
      settings: z.array(setting).min(1).optional(),
      component: componentName.optional(),
    })
    .refine((advanced) => advanced.settings || advanced.component, 'needs `settings` and/or `component`')
    .optional(),
});

export type ModuleDeclaration = z.output<typeof moduleSchema>;
export type SettingDefinition = ModuleDeclaration['settings'][number];
export type SettingType = SettingDefinition['type'];
export type SwitchSetting = Extract<SettingDefinition, { type: 'switch' }>;

export class ModuleConfigError extends Error {
  constructor(readonly issues: string[]) {
    super(`Invalid LeakZero module configuration:\n${issues.map((issue) => `  - ${issue}`).join('\n')}`);
    this.name = 'ModuleConfigError';
  }
}

export interface ValidationContext {
  /** Name of the module directory, which must equal the module id. */
  directory?: string;
  /** Component files (without extension) found in the module's `components/` directory. */
  components?: readonly string[];
  iconExists?: (name: string) => boolean;
}

/** Every setting of a module, main ones first. Ids are unique across both lists. */
export function allSettings(module: ModuleDeclaration): SettingDefinition[] {
  return [...module.settings, ...(module.advanced?.settings ?? [])];
}

function conditionRefs(cond: Condition, refs: { setting: string; equals: SettingValue }[] = []) {
  if ('setting' in cond) refs.push(cond);
  else for (const child of 'all' in cond ? cond.all : cond.any) conditionRefs(child, refs);
  return refs;
}

function acceptsValue(target: SettingDefinition, value: SettingValue): boolean {
  switch (target.type) {
    case 'switch': return typeof value === 'boolean';
    case 'select': return target.options.some((option) => option.value === value);
    case 'slider': return typeof value === 'number';
    case 'input':
    case 'textarea': return typeof value === 'string';
  }
}

function checkDefault(setting: SettingDefinition): string | undefined {
  if (setting.type === 'select' && !setting.options.some((option) => option.value === setting.default)) {
    return `default "${setting.default}" is not one of its options`;
  }
  if (setting.type === 'slider') {
    if (setting.min >= setting.max) return 'min must be lower than max';
    if (setting.default < setting.min || setting.default > setting.max) return `default ${setting.default} is outside [${setting.min}, ${setting.max}]`;
  }
  if ((setting.type === 'input' || setting.type === 'textarea') && setting.maxLength !== undefined && setting.default.length > setting.maxLength) {
    return 'default is longer than maxLength';
  }
  return undefined;
}

/** Cross-field checks zod cannot express: unique ids, a single primary switch, references, cycles, files. */
function checkModule(module: ModuleDeclaration, context: ValidationContext): string[] {
  const issues: string[] = [];
  if (context.directory !== undefined && module.id !== context.directory) {
    issues.push(`id "${module.id}" must match its directory name "${context.directory}"`);
  }
  if (context.iconExists && !context.iconExists(module.icon)) issues.push(`unknown Lucide icon "${module.icon}"`);

  const settings = allSettings(module);
  const byId = new Map<string, SettingDefinition>();
  for (const setting of settings) {
    if (byId.has(setting.id)) issues.push(`duplicate setting id "${setting.id}"`);
    byId.set(setting.id, setting);
    const defaultIssue = checkDefault(setting);
    if (defaultIssue) issues.push(`setting "${setting.id}": ${defaultIssue}`);
  }

  const primaries = settings.filter((setting) => setting.primary);
  if (primaries.length !== 1) issues.push(`exactly one setting must be \`primary: true\` (found ${primaries.length})`);
  for (const primary of primaries) {
    if (primary.type !== 'switch') issues.push(`primary setting "${primary.id}" must be a switch`);
    if (!module.settings.includes(primary)) issues.push(`primary setting "${primary.id}" must be in \`settings\`, not \`advanced\``);
    if (primary.disabledWhen || primary.visibleWhen || primary.requires) {
      issues.push(`primary setting "${primary.id}" cannot depend on other settings`);
    }
  }

  const graph = new Map<string, string[]>();
  for (const setting of settings) {
    const deps: string[] = [];
    for (const [field, cond] of [['disabledWhen', setting.disabledWhen], ['visibleWhen', setting.visibleWhen]] as const) {
      if (!cond) continue;
      for (const ref of conditionRefs(cond)) {
        const target = byId.get(ref.setting);
        if (!target) issues.push(`setting "${setting.id}": ${field} references unknown setting "${ref.setting}"`);
        else if (!acceptsValue(target, ref.equals)) {
          issues.push(`setting "${setting.id}": ${field} compares "${ref.setting}" (${target.type}) with invalid value ${JSON.stringify(ref.equals)}`);
        }
        deps.push(ref.setting);
      }
    }
    for (const ref of setting.requires ?? []) {
      const target = byId.get(ref);
      if (!target) issues.push(`setting "${setting.id}": requires unknown setting "${ref}"`);
      else if (target.type !== 'switch') issues.push(`setting "${setting.id}": requires "${ref}", which is not a switch`);
      deps.push(ref);
    }
    graph.set(setting.id, deps);
  }

  // Conditions only read values, so a cycle would not loop at runtime, but it always is a declaration mistake.
  const state = new Map<string, 'visiting' | 'done'>();
  const visit = (id: string, path: string[]): void => {
    if (state.get(id) === 'done') return;
    if (state.get(id) === 'visiting') {
      issues.push(`circular dependency: ${[...path.slice(path.indexOf(id)), id].join(' → ')}`);
      return;
    }
    state.set(id, 'visiting');
    for (const dep of graph.get(id) ?? []) if (graph.has(dep)) visit(dep, [...path, id]);
    state.set(id, 'done');
  };
  for (const id of graph.keys()) visit(id, []);

  if (context.components) {
    for (const name of [module.component, module.advanced?.component]) {
      if (name && !context.components.includes(name)) issues.push(`component "${name}" not found in components/${name}.tsx`);
    }
  }
  return issues;
}

/** Parses one raw declaration. Throws a ModuleConfigError listing every problem, prefixed by `source`. */
export function validateModuleDeclaration(raw: unknown, source: string, context: ValidationContext = {}): ModuleDeclaration {
  const parsed = moduleSchema.safeParse(raw);
  if (!parsed.success) {
    throw new ModuleConfigError(parsed.error.issues.map((issue) => `${source}: ${issue.path.join('.') || '(root)'}: ${issue.message}`));
  }
  const issues = checkModule(parsed.data, context);
  if (issues.length > 0) throw new ModuleConfigError(issues.map((issue) => `${source}: ${issue}`));
  return parsed.data;
}
