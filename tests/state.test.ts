// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createScanner } from '../src/core/scanner';
import mediaYaml from '../src/modules/media/module.yaml';
import phoneYaml from '../src/modules/phone/module.yaml';
import { buildRegistry, modules } from '../src/modules/registry';
import { SCHEMA_VERSION, settingKey, StorageKeys } from '../src/shared/keys';
import { FAIL_CLOSED, toProtectionSettings, watchProtectionSettings } from '../src/shared/settings';
import { initialValues, initializeState, isModuleActive, moduleValues, planInitialization } from '../src/shared/state';
import { fakeChrome } from './helpers/chrome';

afterEach(() => vi.unstubAllGlobals());

const PHONE = settingKey('phone', 'enabled');
const REINFORCED = settingKey('phone', 'reinforced');
const MEDIA = settingKey('media', 'enabled');

/** Applies the initialization twice and checks the second run writes nothing. */
/** The modules that existed before the module layout, which the legacy `settings` key describes. */
const LEGACY_MODULES = buildRegistry({ './phone/module.yaml': phoneYaml, './media/module.yaml': mediaYaml });

function initialize(items: Record<string, unknown>, reason: 'install' | 'update', registry = modules) {
  const patch = planInitialization(items, registry, reason);
  const result = { ...items, ...patch };
  expect(planInitialization(result, registry, reason)).toEqual({});
  return { patch, result };
}

const extraModule = (id: string, order = 30) => ({
  [`./${id}/module.yaml`]: {
    id,
    title: id,
    icon: 'image',
    order,
    settings: [
      { id: 'enabled', type: 'switch', label: 'On', default: true, primary: true },
      { id: 'strict', type: 'switch', label: 'Strict', default: true },
      { id: 'mode', type: 'select', label: 'Mode', options: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }], default: 'b' },
    ],
  },
});

describe('fresh install', () => {
  it('starts with every protection off, the welcome screen, and no "Nouveau" badge', () => {
    const { result } = initialize({}, 'install');
    expect(result).toEqual({
      [StorageKeys.schemaVersion]: SCHEMA_VERSION,
      [StorageKeys.onboarded]: false,
      [PHONE]: false,
      [REINFORCED]: false,
      [MEDIA]: false,
      [settingKey('notes', 'enabled')]: false,
    });
    expect(toProtectionSettings(result)).toEqual({ maskPhones: false, reinforcedPhones: false, maskMedia: false });
  });
});

describe('migration of the legacy `settings` key', () => {
  it.each([
    ['never saved (legacy defaults)', undefined, { phone: true, reinforced: false, media: true }],
    ['everything off', { maskPhones: false, reinforcedPhones: false, maskMedia: false }, { phone: false, reinforced: false, media: false }],
    ['reinforced mode on', { maskPhones: true, reinforcedPhones: true, maskMedia: false }, { phone: true, reinforced: true, media: false }],
    ['reinforced kept while phones are off', { maskPhones: false, reinforcedPhones: true, maskMedia: true }, { phone: false, reinforced: true, media: true }],
    ['saved before the reinforced mode existed', { maskPhones: true, maskMedia: false }, { phone: true, reinforced: false, media: false }],
    ['corrupted values', { maskPhones: 'no', reinforcedPhones: 1, maskMedia: null }, { phone: true, reinforced: false, media: true }],
  ])('%s', (_name, legacy, expected) => {
    const items = legacy === undefined ? {} : { settings: legacy };
    const { result } = initialize(items, 'update', LEGACY_MODULES);
    expect(result[PHONE]).toBe(expected.phone);
    expect(result[REINFORCED]).toBe(expected.reinforced);
    expect(result[MEDIA]).toBe(expected.media);
    // Existing users are not shown the welcome screen nor "Nouveau" on the modules they already had.
    expect(result[StorageKeys.onboarded]).toBe(true);
    expect(result[StorageKeys.newModules]).toBeUndefined();
    // The legacy key is kept (rollback), and the scanner applies exactly what it applied before.
    expect(result.settings).toEqual(items.settings);
    expect(toProtectionSettings(result)).toEqual(toProtectionSettings(items));
  });

  it('migrates even when the browser reports an install, if legacy settings exist', () => {
    const { result } = initialize({ settings: { maskPhones: false, reinforcedPhones: true, maskMedia: true } }, 'install', LEGACY_MODULES);
    expect(result).toMatchObject({ [PHONE]: false, [REINFORCED]: true, [MEDIA]: true, [StorageKeys.onboarded]: true });
  });

  it('is idempotent and never overwrites migrated values, even if the legacy key changes later', () => {
    const { result } = initialize({ settings: { maskPhones: false, reinforcedPhones: true, maskMedia: true } }, 'update');
    expect(planInitialization({ ...result, settings: { maskPhones: true } }, modules, 'update')).toEqual({});
  });

  it('reads the legacy key until migrated, so content scripts behave as before during the update', () => {
    expect(toProtectionSettings({})).toEqual({ maskPhones: true, reinforcedPhones: false, maskMedia: true });
    expect(toProtectionSettings({ settings: { maskPhones: false, reinforcedPhones: true, maskMedia: true } }))
      .toEqual({ maskPhones: false, reinforcedPhones: true, maskMedia: true });
    // Once migrated, a missing value means off.
    expect(toProtectionSettings({ [StorageKeys.schemaVersion]: 1, settings: { maskPhones: true } }))
      .toEqual({ maskPhones: false, reinforcedPhones: false, maskMedia: false });
  });
});

describe('modules added by an update', () => {
  const registry = buildRegistry({ './phone/module.yaml': phoneYaml, './media/module.yaml': mediaYaml, ...extraModule('extra') });
  const migrated = { schemaVersion: 1, [StorageKeys.onboarded]: true, [PHONE]: true, [REINFORCED]: true, [MEDIA]: false };

  it('adds the module with its protection off (whatever its YAML), YAML defaults elsewhere, and flags it "Nouveau"', () => {
    const { patch, result } = initialize(migrated, 'update', registry);
    expect(patch).toEqual({
      [settingKey('extra', 'enabled')]: false,
      [settingKey('extra', 'strict')]: true,
      [settingKey('extra', 'mode')]: 'b',
      [StorageKeys.newModules]: ['extra'],
    });
    // Existing preferences untouched.
    expect(result).toMatchObject(migrated);
  });

  it('keeps earlier unopened new modules flagged', () => {
    const { result } = initialize({ ...migrated, [StorageKeys.newModules]: ['older'] }, 'update', registry);
    expect(result[StorageKeys.newModules]).toEqual(['older', 'extra']);
  });

  it('does not flag modules on a fresh install or on the initial migration of their protections', () => {
    expect(initialize({}, 'install', registry).result[StorageKeys.newModules]).toBeUndefined();
    // The migration itself brings a module that never existed before: that one is new.
    expect(initialize({}, 'update', registry).result[StorageKeys.newModules]).toEqual(['extra']);
  });

  it('gives a setting added to an existing module its default without touching the others', () => {
    const [extended] = buildRegistry({
      './phone/module.yaml': {
        ...(phoneYaml as object),
        settings: [...modules[0].settings, { id: 'extraSetting', type: 'switch', label: 'X', default: true }],
      },
    });
    const { patch } = initialize(migrated, 'update', [extended, modules[1]]);
    expect(patch).toEqual({ [settingKey('phone', 'extraSetting')]: true });
  });
});

describe('module values', () => {
  const [extra] = buildRegistry(extraModule('extra'));

  it('reset values are the YAML defaults with the protection off', () => {
    expect(initialValues(extra)).toEqual({ [settingKey('extra', 'enabled')]: false, [settingKey('extra', 'strict')]: true, [settingKey('extra', 'mode')]: 'b' });
  });

  it('reads stored values, falling back to defaults (primary: off) for missing or invalid ones', () => {
    expect(moduleValues({}, extra)).toEqual({ enabled: false, strict: true, mode: 'b' });
    expect(moduleValues({ [settingKey('extra', 'enabled')]: true, [settingKey('extra', 'mode')]: 'zzz', [settingKey('extra', 'strict')]: 'x' }, extra))
      .toEqual({ enabled: true, strict: true, mode: 'b' });
    expect(isModuleActive({ [settingKey('extra', 'enabled')]: true }, extra)).toBe(true);
    expect(isModuleActive({}, extra)).toBe(false);
  });
});

describe('initializeState', () => {
  it('applies the plan in one write, and writes nothing once up to date', async () => {
    const storage = fakeChrome({ settings: { maskPhones: false, reinforcedPhones: true, maskMedia: true } });
    await initializeState(modules, 'update');
    expect(storage.local.set).toHaveBeenCalledTimes(1);
    expect(storage.stored).toMatchObject({ [PHONE]: false, [REINFORCED]: true, [MEDIA]: true, schemaVersion: 1 });
    await initializeState(modules, 'update');
    expect(storage.local.set).toHaveBeenCalledTimes(1);
  });

  it('runs from the service worker with the install reason', async () => {
    const storage = fakeChrome();
    let onInstalled: ((details: { reason: string }) => void) | undefined;
    (chrome as unknown as { runtime: Record<string, unknown> }).runtime.onInstalled = { addListener: (listener: typeof onInstalled) => (onInstalled = listener) };
    vi.resetModules();
    await import('../src/background/index');
    onInstalled!({ reason: 'install' });
    await vi.waitFor(() => expect(storage.stored[StorageKeys.onboarded]).toBe(false));
    expect(toProtectionSettings(storage.stored)).toEqual({ maskPhones: false, reinforcedPhones: false, maskMedia: false });
  });
});

describe('content script settings', () => {
  it('applies stored settings, then every change, immediately', async () => {
    const storage = fakeChrome({ schemaVersion: 1, [PHONE]: true, [REINFORCED]: false, [MEDIA]: false });
    const received: unknown[] = [];
    watchProtectionSettings((settings) => received.push(settings));
    await vi.waitFor(() => expect(received).toEqual([{ maskPhones: true, reinforcedPhones: false, maskMedia: false }]));
    await storage.externalSet({ [REINFORCED]: true });
    await vi.waitFor(() => expect(received.at(-1)).toEqual({ maskPhones: true, reinforcedPhones: true, maskMedia: false }));
    // Popup-only state does not wake content scripts.
    await storage.externalSet({ [StorageKeys.openSections]: ['phone'] });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(received).toHaveLength(2);
  });

  it('switches classic ↔ reinforced from storage without ever putting the digits back', async () => {
    const storage = fakeChrome({ schemaVersion: 1, [PHONE]: true, [REINFORCED]: false, [MEDIA]: true });
    document.body.innerHTML = '<p id="m">Appelle le 06 12 34 56 78 stp</p>';
    const text = document.getElementById('m')!.firstChild as Text;
    const seen: string[] = [];
    const recorder = new MutationObserver(() => seen.push(text.data));
    recorder.observe(text, { characterData: true });
    const scanner = createScanner(document, ['FR']);
    scanner.apply(FAIL_CLOSED);
    watchProtectionSettings((settings) => scanner.apply(settings));
    for (const reinforced of [true, false, true]) {
      await storage.externalSet({ [REINFORCED]: reinforced });
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    expect(text.data).toBe('Appelle le ********** stp');
    expect(seen.every((data) => !/\d/.test(data))).toBe(true);
    // Turning the module off restores the exact original text.
    await storage.externalSet({ [PHONE]: false });
    await vi.waitFor(() => expect(text.data).toBe('Appelle le 06 12 34 56 78 stp'));
    scanner.stop();
    recorder.disconnect();
  });
});
