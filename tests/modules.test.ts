import { describe, expect, it } from 'vitest';
import { evaluate, isDisabled, isVisible } from '../src/modules/conditions';
import { iconExists, iconExportName } from '../src/modules/icons';
import { buildRegistry, modules } from '../src/modules/registry';
import { ModuleConfigError, validateModuleDeclaration, type SettingDefinition } from '../src/modules/schema';
import { bindModuleUi, componentFiles } from '../src/modules/ui';
import { settingKey } from '../src/shared/keys';
import { PROTECTION_FIELDS } from '../src/shared/settings';

function declaration(id: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    title: `Module ${id}`,
    icon: 'phone',
    order: 10,
    settings: [{ id: 'enabled', type: 'switch', label: 'Activer', default: false, primary: true }],
    ...extra,
  };
}

function issuesOf(fn: () => unknown): string[] {
  try {
    fn();
  } catch (error) {
    if (error instanceof ModuleConfigError) return error.issues;
    throw error;
  }
  throw new Error('expected a ModuleConfigError');
}

const validate = (raw: unknown) => validateModuleDeclaration(raw, 'fixture/module.yaml');

describe('module discovery', () => {
  it('discovers every src/modules/*/module.yaml, sorted by order', () => {
    expect(modules.map((module) => module.id)).toEqual(['phone', 'media', 'notes']);
    expect(modules.map((module) => module.order)).toEqual([10, 20, 30]);
  });

  it('declares the settings content scripts read', () => {
    const keys = modules.flatMap((module) => module.allSettings.map((setting) => settingKey(module.id, setting.id)));
    for (const key of Object.values(PROTECTION_FIELDS)) expect(keys).toContain(key);
    expect(modules.map((module) => module.primary.id)).toEqual(['enabled', 'enabled', 'enabled']);
  });

  it('migrates the existing protections with every protection off by default', () => {
    const phone = modules.find((module) => module.id === 'phone')!;
    expect(phone.settings.map((setting) => [setting.id, setting.type, setting.default])).toEqual([
      ['enabled', 'switch', false],
      ['reinforced', 'switch', false],
    ]);
    expect(phone.settings[1].disabledWhen).toEqual({ setting: 'enabled', equals: false });
    expect(phone.advanced?.component).toBe('AdvancedSettings');
    const media = modules.find((module) => module.id === 'media')!;
    expect(media.settings.map((setting) => [setting.id, setting.default])).toEqual([['enabled', false]]);
    expect(media.advanced).toBeUndefined();
  });

  it('declares the Notes module, disabled by default, with its "Ouvrir Notes" component', () => {
    const notes = modules.find((module) => module.id === 'notes')!;
    expect(notes.settings.map((setting) => [setting.id, setting.type, setting.default])).toEqual([['enabled', 'switch', false]]);
    expect(notes.component).toBe('OpenNotesButton');
    expect(bindModuleUi(modules, componentFiles).get('notes')!.Component).toBeTypeOf('function');
  });

  it('binds icons and custom components of the real modules', () => {
    const ui = bindModuleUi(modules, componentFiles);
    expect(ui.get('phone')!.AdvancedComponent).toBeTypeOf('function');
    expect(ui.get('media')!.AdvancedComponent).toBeUndefined();
    expect(ui.get('media')!.Icon).toBeDefined();
  });
});

describe('registry', () => {
  it('sorts by order, then by id for equal orders, whatever the discovery order', () => {
    const registry = buildRegistry({
      './zeta/module.yaml': declaration('zeta', { order: 5 }),
      './beta/module.yaml': declaration('beta', { order: 20 }),
      './alpha/module.yaml': declaration('alpha', { order: 20 }),
    });
    expect(registry.map((module) => module.id)).toEqual(['zeta', 'alpha', 'beta']);
  });

  it('rejects duplicate module ids', () => {
    const issues = issuesOf(() => buildRegistry({ './a/dup/module.yaml': declaration('dup'), './b/dup/module.yaml': declaration('dup') }));
    expect(issues).toEqual(['./b/dup/module.yaml: duplicate module id "dup" (also declared in ./a/dup/module.yaml)']);
  });

  it('requires the id to match the directory', () => {
    expect(issuesOf(() => buildRegistry({ './phone/module.yaml': declaration('phones') }))).toEqual([
      './phone/module.yaml: id "phones" must match its directory name "phone"',
    ]);
  });

  it('reports the problems of every invalid module at once, with their file', () => {
    const issues = issuesOf(() => buildRegistry({ './a/module.yaml': declaration('a', { icon: 'Phone' }), './b/module.yaml': { id: 'b' } }));
    expect(issues.some((issue) => issue.startsWith('./a/module.yaml: icon:'))).toBe(true);
    expect(issues.some((issue) => issue.startsWith('./b/module.yaml: title:'))).toBe(true);
    expect(issues.some((issue) => issue.startsWith('./b/module.yaml: settings:'))).toBe(true);
  });

  it('exposes the primary switch and all settings', () => {
    const [module] = buildRegistry({
      './x/module.yaml': declaration('x', {
        advanced: { settings: [{ id: 'level', type: 'slider', label: 'Niveau', min: 0, max: 10, default: 3 }] },
      }),
    });
    expect(module.primary.id).toBe('enabled');
    expect(module.allSettings.map((setting) => setting.id)).toEqual(['enabled', 'level']);
    expect(module.allSettings[1]).toMatchObject({ step: 1 });
  });
});

describe('module.yaml validation', () => {
  it('accepts every setting type with valid defaults', () => {
    const module = validate(declaration('all', {
      settings: [
        { id: 'enabled', type: 'switch', label: 'On', default: false, primary: true },
        { id: 'mode', type: 'select', label: 'Mode', options: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }], default: 'b' },
        { id: 'level', type: 'slider', label: 'Niveau', min: 0, max: 100, step: 5, unit: '%', default: 50 },
        { id: 'name', type: 'input', label: 'Nom', placeholder: 'x' },
        { id: 'notes', type: 'textarea', label: 'Notes', default: 'abc', maxLength: 10 },
      ],
    }));
    expect(module.settings.map((setting) => setting.default)).toEqual([false, 'b', 50, '', 'abc']);
  });

  it('rejects unknown setting types and unknown keys (typos)', () => {
    expect(issuesOf(() => validate(declaration('x', { settings: [{ id: 'enabled', type: 'checkbox', label: 'On', default: false, primary: true }] }))).length).toBeGreaterThan(0);
    const typo = issuesOf(() => validate(declaration('x', { settings: [{ id: 'enabled', type: 'switch', label: 'On', default: false, primary: true, disabledwhen: {} }] })));
    expect(typo.join()).toContain('disabledwhen');
    expect(issuesOf(() => validate(declaration('x', { colour: 'red' }))).join()).toContain('colour');
  });

  it('checks default values against the setting type', () => {
    const issues = issuesOf(() => validate(declaration('x', {
      settings: [
        { id: 'enabled', type: 'switch', label: 'On', default: 'yes', primary: true },
      ],
    })));
    expect(issues.join()).toContain('settings.0.default');
    const select = issuesOf(() => validate(declaration('x', {
      settings: [
        { id: 'enabled', type: 'switch', label: 'On', default: false, primary: true },
        { id: 'mode', type: 'select', label: 'Mode', options: [{ value: 'a', label: 'A' }], default: 'z' },
        { id: 'level', type: 'slider', label: 'Niveau', min: 0, max: 10, default: 11 },
        { id: 'range', type: 'slider', label: 'Plage', min: 5, max: 5, default: 5 },
      ],
    })));
    expect(select).toEqual([
      'fixture/module.yaml: setting "mode": default "z" is not one of its options',
      'fixture/module.yaml: setting "level": default 11 is outside [0, 10]',
      'fixture/module.yaml: setting "range": min must be lower than max',
    ]);
  });

  it('requires exactly one primary switch, in the main settings, without dependencies', () => {
    expect(issuesOf(() => validate(declaration('x', { settings: [{ id: 'a', type: 'switch', label: 'A', default: false }] }))))
      .toEqual(['fixture/module.yaml: exactly one setting must be `primary: true` (found 0)']);
    expect(issuesOf(() => validate(declaration('x', {
      settings: [
        { id: 'a', type: 'switch', label: 'A', default: false, primary: true },
        { id: 'b', type: 'switch', label: 'B', default: false, primary: true },
      ],
    })))).toEqual(['fixture/module.yaml: exactly one setting must be `primary: true` (found 2)']);
    expect(issuesOf(() => validate(declaration('x', { settings: [{ id: 'a', type: 'input', label: 'A', primary: true }] }))))
      .toContain('fixture/module.yaml: primary setting "a" must be a switch');
    expect(issuesOf(() => validate(declaration('x', {
      settings: [{ id: 'a', type: 'switch', label: 'A', default: false }],
      advanced: { settings: [{ id: 'b', type: 'switch', label: 'B', default: false, primary: true }] },
    })))).toContain('fixture/module.yaml: primary setting "b" must be in `settings`, not `advanced`');
    expect(issuesOf(() => validate(declaration('x', {
      settings: [
        { id: 'a', type: 'switch', label: 'A', default: false, primary: true, disabledWhen: { setting: 'b', equals: true } },
        { id: 'b', type: 'switch', label: 'B', default: false },
      ],
    })))).toEqual(['fixture/module.yaml: primary setting "a" cannot depend on other settings']);
  });

  it('rejects duplicate setting ids across main and advanced settings', () => {
    expect(issuesOf(() => validate(declaration('x', {
      advanced: { settings: [{ id: 'enabled', type: 'switch', label: 'Bis', default: false }] },
    })))).toContain('fixture/module.yaml: duplicate setting id "enabled"');
  });

  it('rejects dependencies on unknown settings, invalid compared values and non-switch requirements', () => {
    const issues = issuesOf(() => validate(declaration('x', {
      settings: [
        { id: 'enabled', type: 'switch', label: 'On', default: false, primary: true },
        { id: 'mode', type: 'select', label: 'Mode', options: [{ value: 'a', label: 'A' }], default: 'a' },
        { id: 'a', type: 'switch', label: 'A', default: false, disabledWhen: { setting: 'missing', equals: true } },
        { id: 'b', type: 'switch', label: 'B', default: false, visibleWhen: { any: [{ setting: 'mode', equals: 'zzz' }, { setting: 'enabled', equals: 1 }] } },
        { id: 'c', type: 'switch', label: 'C', default: false, requires: ['enabled', 'mode', 'ghost'] },
      ],
    })));
    expect(issues).toEqual([
      'fixture/module.yaml: setting "a": disabledWhen references unknown setting "missing"',
      'fixture/module.yaml: setting "b": visibleWhen compares "mode" (select) with invalid value "zzz"',
      'fixture/module.yaml: setting "b": visibleWhen compares "enabled" (switch) with invalid value 1',
      'fixture/module.yaml: setting "c": requires "mode", which is not a switch',
      'fixture/module.yaml: setting "c": requires unknown setting "ghost"',
    ]);
  });

  it('rejects circular dependencies, including self references', () => {
    const issues = issuesOf(() => validate(declaration('x', {
      settings: [
        { id: 'enabled', type: 'switch', label: 'On', default: false, primary: true },
        { id: 'a', type: 'switch', label: 'A', default: false, disabledWhen: { setting: 'b', equals: true } },
        { id: 'b', type: 'switch', label: 'B', default: false, requires: 'a' },
        { id: 'c', type: 'switch', label: 'C', default: false, visibleWhen: { setting: 'c', equals: true } },
      ],
    })));
    expect(issues).toEqual([
      'fixture/module.yaml: circular dependency: a → b → a',
      'fixture/module.yaml: circular dependency: c → c',
    ]);
  });

  it('checks icons and component files when given the context (as the build plugin does)', () => {
    const raw = declaration('x', { icon: 'not-an-icon', component: 'Extra', advanced: { component: 'AdvancedSettings' } });
    expect(issuesOf(() => validateModuleDeclaration(raw, 'x/module.yaml', { directory: 'x', components: ['AdvancedSettings'], iconExists }))).toEqual([
      'x/module.yaml: unknown Lucide icon "not-an-icon"',
      'x/module.yaml: component "Extra" not found in components/Extra.tsx',
    ]);
    expect(issuesOf(() => validate(declaration('x', { advanced: {} })))[0]).toContain('needs `settings` and/or `component`');
  });

  it('maps kebab-case icon names to Lucide exports', () => {
    expect(iconExportName('circle-help')).toBe('CircleHelp');
    expect(iconExists('phone')).toBe(true);
    expect(iconExists('image')).toBe(true);
  });

  it('only binds components from the module own components/ directory', () => {
    const [module] = buildRegistry({ './x/module.yaml': declaration('x', { advanced: { component: 'AdvancedSettings' } }) });
    // phone's component exists, but not under ./x/.
    expect(issuesOf(() => bindModuleUi([module], componentFiles))).toEqual([
      'x: component "AdvancedSettings" not found in components/AdvancedSettings.tsx (default export)',
    ]);
  });
});

describe('declarative dependencies', () => {
  const setting = (extra: Partial<SettingDefinition>) => ({ id: 's', type: 'switch', label: 'S', default: false, ...extra }) as SettingDefinition;

  it('evaluates equals, all and any', () => {
    const values = { enabled: true, mode: 'b', level: 3 };
    expect(evaluate({ setting: 'enabled', equals: true }, values)).toBe(true);
    expect(evaluate({ all: [{ setting: 'enabled', equals: true }, { setting: 'mode', equals: 'a' }] }, values)).toBe(false);
    expect(evaluate({ any: [{ setting: 'mode', equals: 'a' }, { setting: 'level', equals: 3 }] }, values)).toBe(true);
    expect(evaluate({ all: [{ any: [{ setting: 'mode', equals: 'b' }] }, { setting: 'enabled', equals: true }] }, values)).toBe(true);
  });

  it('disables with disabledWhen or an unmet requirement, hides with visibleWhen', () => {
    expect(isDisabled(setting({ disabledWhen: { setting: 'enabled', equals: false } }), { enabled: false })).toBe(true);
    expect(isDisabled(setting({ disabledWhen: { setting: 'enabled', equals: false } }), { enabled: true })).toBe(false);
    expect(isDisabled(setting({ requires: ['enabled', 'other'] }), { enabled: true, other: false })).toBe(true);
    expect(isDisabled(setting({ requires: ['enabled', 'other'] }), { enabled: true, other: true })).toBe(false);
    expect(isVisible(setting({ visibleWhen: { setting: 'enabled', equals: true } }), { enabled: false })).toBe(false);
    expect(isVisible(setting({}), {})).toBe(true);
  });
});
