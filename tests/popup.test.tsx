// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import mediaYaml from '../src/modules/media/module.yaml';
import phoneYaml from '../src/modules/phone/module.yaml';
import { buildRegistry, type ModuleDefinition } from '../src/modules/registry';
import type { ModuleComponentProps } from '../src/modules/ui';
import App from '../src/popup/App';
import { settingKey, StorageKeys } from '../src/shared/keys';
import { fakeChrome } from './helpers/chrome';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const PHONE = settingKey('phone', 'enabled');
const REINFORCED = settingKey('phone', 'reinforced');
const MEDIA = settingKey('media', 'enabled');
/** An existing install, already migrated, which has seen the welcome screen. */
const MIGRATED = { schemaVersion: 1, [StorageKeys.onboarded]: true, [PHONE]: true, [REINFORCED]: false, [MEDIA]: true };

let root: Root | undefined;

afterEach(() => {
  if (root) act(() => root!.unmount());
  root = undefined;
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});

const flush = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });

async function render(props: Parameters<typeof App>[0] = {}) {
  if (root) act(() => root!.unmount());
  document.body.innerHTML = '';
  root = createRoot(document.body.appendChild(document.createElement('div')));
  await act(async () => root!.render(<App {...props} />));
  await flush();
  await flush();
}

const item = (id: string) => document.querySelector<HTMLElement>(`[data-module="${id}"]`);
const trigger = (id: string) => item(id)!.querySelector<HTMLButtonElement>('[data-slot="accordion-trigger"]')!;
const status = (id: string) => item(id)!.querySelector('[data-testid="module-status"]')!.textContent;
const control = (id: string) => document.getElementById(id) as HTMLButtonElement | HTMLInputElement | null;
const buttons = (text: string) => [...document.querySelectorAll<HTMLButtonElement>('button')].filter((button) => button.textContent!.includes(text));
const button = (text: string) => {
  const found = buttons(text);
  expect(found, `button "${text}"`).toHaveLength(1);
  return found[0];
};
const byLabel = (label: string) => document.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!;
const warning = () => [...document.querySelectorAll('[role="status"]')].find((node) => node.textContent!.includes('Aucune protection active'));
const click = (element: HTMLElement) => act(async () => element.click());
const open = async (id: string) => { await click(trigger(id)); await flush(); };

function fixtureModule(id: string, order: number, extra: Record<string, unknown> = {}) {
  return {
    [`./${id}/module.yaml`]: {
      id,
      title: `Module ${id}`,
      description: `Description ${id}`,
      icon: 'image',
      order,
      settings: [{ id: 'enabled', type: 'switch', label: `Activer ${id}`, default: false, primary: true }],
      ...extra,
    },
  };
}

const REAL = { './phone/module.yaml': phoneYaml, './media/module.yaml': mediaYaml };

describe('onboarding', () => {
  it('shows the welcome screen once on a fresh install, with every protection off', async () => {
    const storage = fakeChrome({ schemaVersion: 1, [StorageKeys.onboarded]: false, [PHONE]: false, [REINFORCED]: false, [MEDIA]: false });
    await render();
    expect(document.body.textContent).toContain('Bienvenue sur LeakZero');
    expect(document.body.textContent).toContain('Protégez vos informations sensibles pendant vos lives.');
    expect(document.body.textContent).toContain('Numéros de téléphone');
    expect(document.body.textContent).toContain('Images et vidéos');
    expect(document.body.textContent).toContain('n’est pas garantie instantanée');
    await click(button('Commencer'));
    expect(storage.stored[StorageKeys.onboarded]).toBe(true);
    expect(item('phone')).not.toBeNull();
    expect(status('phone')).toBe('Inactif');
    expect(status('media')).toBe('Inactif');
    expect(warning()).toBeDefined();
    await render();
    expect(document.body.textContent).not.toContain('Bienvenue sur LeakZero');
  });

  it('reopens from the help icon without touching settings or open sections', async () => {
    const storage = fakeChrome({ ...MIGRATED, [StorageKeys.openSections]: ['media'] });
    await render();
    expect(document.body.textContent).not.toContain('Bienvenue sur LeakZero');
    const before = structuredClone(storage.stored);
    const writes = storage.local.set.mock.calls.length;
    await click(byLabel('Aide'));
    expect(document.body.textContent).toContain('Bienvenue sur LeakZero');
    await click(button('Fermer'));
    expect(item('media')!.getAttribute('data-state')).toBe('open');
    expect(storage.stored).toEqual(before);
    expect(storage.local.set.mock.calls.length).toBe(writes);
  });

  it('does not show the welcome screen to existing installs migrated from the legacy settings', async () => {
    const storage = fakeChrome({ settings: { maskPhones: false, reinforcedPhones: true, maskMedia: true } });
    await render();
    expect(document.body.textContent).not.toContain('Bienvenue sur LeakZero');
    expect(storage.stored).toMatchObject({ [PHONE]: false, [REINFORCED]: true, [MEDIA]: true });
    expect(status('phone')).toBe('Inactif');
    expect(status('media')).toBe('Actif');
  });
});

describe('accordions', () => {
  it('lists the modules in order with an informative state, all controls inside', async () => {
    fakeChrome(MIGRATED);
    await render();
    expect([...document.querySelectorAll('[data-module]')].map((node) => node.getAttribute('data-module'))).toEqual(['phone', 'media', 'notes']);
    expect(status('phone')).toBe('Actif');
    expect(trigger('phone').querySelector('[role="switch"]')).toBeNull();
    expect(control('phone-enabled')).toBeNull();
    await open('phone');
    expect(control('phone-enabled')!.getAttribute('aria-checked')).toBe('true');
    expect(document.querySelector('label[for="phone-reinforced"]')!.textContent).toBe('Mode renforcé');
  });

  it('keeps several sections open and restores them when the popup reopens', async () => {
    const storage = fakeChrome(MIGRATED);
    await render();
    await open('phone');
    await open('media');
    expect(item('phone')!.getAttribute('data-state')).toBe('open');
    expect(item('media')!.getAttribute('data-state')).toBe('open');
    expect(storage.stored[StorageKeys.openSections]).toEqual(['phone', 'media']);
    await open('phone');
    expect(storage.stored[StorageKeys.openSections]).toEqual(['media']);
    await render();
    expect(item('phone')!.getAttribute('data-state')).toBe('closed');
    expect(item('media')!.getAttribute('data-state')).toBe('open');
  });

  it('shows "Aucune protection active" only while every module is off', async () => {
    const storage = fakeChrome({ ...MIGRATED, [PHONE]: false, [MEDIA]: false });
    await render();
    expect(warning()).toBeDefined();
    await open('media');
    await click(control('media-enabled') as HTMLButtonElement);
    expect(storage.stored[MEDIA]).toBe(true);
    expect(status('media')).toBe('Actif');
    expect(warning()).toBeUndefined();
  });
});

describe('Notes module', () => {
  const NOTES = settingKey('notes', 'enabled');

  it('shows "Ouvrir Notes" only while the module is enabled, and opens the floating window itself', async () => {
    // No service worker listening (stopped, crashed or outdated): opening does not depend on it.
    const storage = fakeChrome(MIGRATED);
    await render();
    await open('notes');
    expect(buttons('Ouvrir Notes')).toHaveLength(0);
    await click(control('notes-enabled') as HTMLButtonElement);
    expect(storage.stored[NOTES]).toBe(true);
    await click(button('Ouvrir Notes'));
    await flush();
    expect([...storage.windows.values()]).toEqual([expect.objectContaining({ type: 'popup', url: 'chrome-extension://leakzero-test/notes.html' })]);
    expect(document.querySelector('[role="alert"]')).toBeNull();
  });

  it('reports an error when the window cannot be opened', async () => {
    const storage = fakeChrome({ ...MIGRATED, [NOTES]: true, [StorageKeys.openSections]: ['notes'] });
    vi.mocked(storage.api.windows.create).mockRejectedValue(new Error('boom'));
    await render();
    await click(button('Ouvrir Notes'));
    await flush();
    expect(document.querySelector('[role="alert"]')!.textContent).toContain('boom');
  });

  it('is not a protection: "Aucune protection active" stays while only Notes is on', async () => {
    fakeChrome({ ...MIGRATED, [PHONE]: false, [MEDIA]: false, [NOTES]: true });
    await render();
    expect(status('notes')).toBe('Actif');
    expect(warning()).toBeDefined();
  });
});

describe('settings', () => {
  it('saves each switch immediately, in its own key', async () => {
    const storage = fakeChrome(MIGRATED);
    await render();
    await open('phone');
    await open('media');
    await click(control('phone-reinforced') as HTMLButtonElement);
    expect(storage.stored).toMatchObject({ [PHONE]: true, [REINFORCED]: true, [MEDIA]: true });
    expect(storage.local.set).toHaveBeenLastCalledWith({ [REINFORCED]: true });
    await click(control('media-enabled') as HTMLButtonElement);
    expect(storage.local.set).toHaveBeenLastCalledWith({ [MEDIA]: false });
    expect(storage.stored).toMatchObject({ [PHONE]: true, [REINFORCED]: true, [MEDIA]: false });
  });

  it('greys out the reinforced mode while phone masking is off, keeping its value', async () => {
    const storage = fakeChrome({ ...MIGRATED, [REINFORCED]: true, [StorageKeys.openSections]: ['phone'] });
    await render();
    const reinforced = () => control('phone-reinforced') as HTMLButtonElement;
    expect(reinforced().disabled).toBe(false);
    await click(control('phone-enabled') as HTMLButtonElement);
    expect(reinforced().disabled).toBe(true);
    expect(reinforced().getAttribute('aria-checked')).toBe('true');
    expect(storage.stored).toMatchObject({ [PHONE]: false, [REINFORCED]: true });
    await click(reinforced());
    expect(storage.stored[REINFORCED]).toBe(true);
    await click(control('phone-enabled') as HTMLButtonElement);
    expect(reinforced().disabled).toBe(false);
    expect(status('phone')).toBe('Actif');
  });

  it('follows changes made in another popup', async () => {
    const storage = fakeChrome({ ...MIGRATED, [StorageKeys.openSections]: ['phone'] });
    await render();
    await act(() => storage.externalSet({ [REINFORCED]: true, [MEDIA]: false }));
    expect(control('phone-reinforced')!.getAttribute('aria-checked')).toBe('true');
    expect(status('media')).toBe('Inactif');
  });

  it('reports a failed save and shows the stored value again', async () => {
    const storage = fakeChrome({ ...MIGRATED, [StorageKeys.openSections]: ['phone'] });
    await render();
    storage.failNextSet();
    await click(control('phone-enabled') as HTMLButtonElement);
    await flush();
    expect(document.querySelector('[role="alert"]')!.textContent).toContain('Échec de l’enregistrement');
    expect(storage.stored[PHONE]).toBe(true);
    expect(control('phone-enabled')!.getAttribute('aria-checked')).toBe('true');
    expect(status('phone')).toBe('Actif');
  });

  it('does not rewrite values that did not change', async () => {
    const storage = fakeChrome({ ...MIGRATED, [MEDIA]: false, [StorageKeys.openSections]: ['media'] });
    await render();
    const writes = storage.local.set.mock.calls.length;
    await click(button('Réinitialiser ce module'));
    await click([...document.querySelectorAll<HTMLButtonElement>('[role="alertdialog"] button')].find((b) => b.textContent === 'Réinitialiser')!);
    expect(storage.local.set.mock.calls.length).toBe(writes);
  });

  it('generates every standard control from YAML, with visibleWhen and requires', async () => {
    const registry = buildRegistry(fixtureModule('form', 10, {
      settings: [
        { id: 'enabled', type: 'switch', label: 'Activer', default: false, primary: true },
        { id: 'name', type: 'input', label: 'Nom', default: 'abc', requires: 'enabled' },
        { id: 'notes', type: 'textarea', label: 'Notes', default: '' },
        { id: 'mode', type: 'select', label: 'Mode', options: [{ value: 'a', label: 'Option A' }, { value: 'b', label: 'Option B' }], default: 'b' },
        { id: 'level', type: 'slider', label: 'Niveau', min: 0, max: 10, default: 4, unit: ' px', visibleWhen: { setting: 'mode', equals: 'b' } },
      ],
    }));
    const storage = fakeChrome({ schemaVersion: 1, [StorageKeys.onboarded]: true, [StorageKeys.openSections]: ['form'] });
    await render({ modules: registry });
    expect(storage.stored).toMatchObject({ [settingKey('form', 'name')]: 'abc', [settingKey('form', 'mode')]: 'b', [settingKey('form', 'level')]: 4 });
    const name = control('form-name') as HTMLInputElement;
    expect(name.value).toBe('abc');
    expect(name.disabled).toBe(true);
    expect(control('form-notes')!.tagName).toBe('TEXTAREA');
    expect(control('form-mode')!.textContent).toContain('Option B');
    expect(document.querySelector('[data-setting="level"]')!.textContent).toContain('4 px');
    await act(() => storage.externalSet({ [settingKey('form', 'mode')]: 'a', [settingKey('form', 'enabled')]: true }));
    expect(document.querySelector('[data-setting="level"]')).toBeNull();
    expect((control('form-name') as HTMLInputElement).disabled).toBe(false);
  });
});

describe('advanced settings', () => {
  it('opens a dedicated view for modules that declare one, and returns with sections preserved', async () => {
    const storage = fakeChrome({ ...MIGRATED, [StorageKeys.openSections]: ['phone', 'media'] });
    await render();
    expect(item('phone')!.textContent).toContain('Paramètres avancés');
    expect(item('media')!.textContent).not.toContain('Paramètres avancés');
    await click(button('Paramètres avancés'));
    expect(document.querySelector('h1')!.textContent).toBe('Numéros de téléphone');
    expect(document.querySelector('[data-testid="phone-preview"]')!.textContent).toContain('**********');
    // The custom component edits the module's settings like the generated form does.
    await click(control('phone-advanced-reinforced') as HTMLButtonElement);
    expect(storage.stored[REINFORCED]).toBe(true);
    expect(document.querySelector('[data-testid="phone-preview"]')!.textContent).toContain('Numéro masqué');
    await click(byLabel('Retour'));
    expect(item('phone')!.getAttribute('data-state')).toBe('open');
    expect(item('media')!.getAttribute('data-state')).toBe('open');
    expect(control('phone-reinforced')!.getAttribute('aria-checked')).toBe('true');
  });

  it('renders declarative advanced settings and custom components from a module directory', async () => {
    const Custom = ({ values, setValue }: ModuleComponentProps) => (
      <button type="button" data-testid="custom" onClick={() => setValue('extra', !values.extra)}>extra={String(values.extra)}</button>
    );
    const registry = buildRegistry(fixtureModule('adv', 10, {
      component: 'Inline',
      advanced: { title: 'Avancé', settings: [{ id: 'extra', type: 'switch', label: 'Option avancée', default: true }], component: 'Custom' },
    }));
    const storage = fakeChrome({ schemaVersion: 1, [StorageKeys.onboarded]: true, [StorageKeys.openSections]: ['adv'] });
    await render({ modules: registry, componentFiles: { './adv/components/Custom.tsx': Custom, './adv/components/Inline.tsx': () => <p>inline component</p> } });
    expect(item('adv')!.textContent).toContain('inline component');
    expect(control('adv-extra')).toBeNull();
    await click(button('Paramètres avancés'));
    expect(document.body.textContent).toContain('Avancé');
    expect(control('adv-extra')!.getAttribute('aria-checked')).toBe('true');
    await click(document.querySelector<HTMLButtonElement>('[data-testid="custom"]')!);
    expect(storage.stored[settingKey('adv', 'extra')]).toBe(false);
    expect(control('adv-extra')!.getAttribute('aria-checked')).toBe('false');
  });
});

describe('reset', () => {
  it('asks for confirmation, then restores only that module, with its protection off', async () => {
    const storage = fakeChrome({ ...MIGRATED, [REINFORCED]: true, [StorageKeys.openSections]: ['phone'] });
    await render();
    await click(button('Réinitialiser ce module'));
    expect(document.querySelector('[role="alertdialog"]')!.textContent).toContain('Réinitialiser « Numéros de téléphone » ?');
    await click(button('Annuler'));
    expect(storage.stored).toMatchObject({ [PHONE]: true, [REINFORCED]: true });
    await click(button('Réinitialiser ce module'));
    const writes = storage.local.set.mock.calls.length;
    await click([...document.querySelectorAll<HTMLButtonElement>('[role="alertdialog"] button')].find((b) => b.textContent === 'Réinitialiser')!);
    expect(storage.local.set.mock.calls.length).toBe(writes + 1);
    expect(storage.local.set).toHaveBeenLastCalledWith({ [PHONE]: false, [REINFORCED]: false });
    expect(storage.stored).toMatchObject({ [PHONE]: false, [REINFORCED]: false, [MEDIA]: true, [StorageKeys.openSections]: ['phone'] });
    expect(status('phone')).toBe('Inactif');
    expect(status('media')).toBe('Actif');
  });
});

describe('modules added by an update', () => {
  const registry = () => buildRegistry({ ...REAL, ...fixtureModule('extra', 30) });

  it('adds them disabled with a "Nouveau" badge that disappears for good once opened', async () => {
    const storage = fakeChrome(MIGRATED);
    await render({ modules: registry() });
    expect(storage.stored).toMatchObject({ [settingKey('extra', 'enabled')]: false, [StorageKeys.newModules]: ['extra'] });
    expect(item('extra')!.textContent).toContain('Nouveau');
    expect(item('phone')!.textContent).not.toContain('Nouveau');
    expect(status('extra')).toBe('Inactif');
    expect(status('phone')).toBe('Actif');
    await open('extra');
    expect(item('extra')!.textContent).not.toContain('Nouveau');
    expect(storage.stored[StorageKeys.newModules]).toEqual([]);
    expect(storage.stored[settingKey('extra', 'enabled')]).toBe(false);
    await open('extra');
    await render({ modules: registry() });
    expect(item('extra')!.textContent).not.toContain('Nouveau');
  });
});

describe('search', () => {
  const five = (): ModuleDefinition[] => buildRegistry({
    ...REAL,
    ...fixtureModule('clipboard', 30, { title: 'Presse-papiers', description: 'Contenu copié' }),
    ...fixtureModule('email', 40, { title: 'Adresses e-mail', description: 'Masquage des courriels' }),
    ...fixtureModule('address', 50, { title: 'Adresses postales', description: 'Rues et codes' }),
  });

  it('is hidden below 5 modules', async () => {
    fakeChrome(MIGRATED);
    await render();
    expect(document.querySelector('input[type="search"]')).toBeNull();
  });

  it('appears from 5 modules and filters by title or description, accent-insensitive, keeping order and open sections', async () => {
    const storage = fakeChrome({ ...MIGRATED, [StorageKeys.openSections]: ['phone', 'address'] });
    await render({ modules: five() });
    const search = document.querySelector<HTMLInputElement>('input[type="search"]')!;
    expect(search).not.toBeNull();
    const type = (value: string) => act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(search, value);
      search.dispatchEvent(new Event('input', { bubbles: true }));
    });
    const shown = () => [...document.querySelectorAll('[data-module]')].map((node) => node.getAttribute('data-module'));
    await type('adresses');
    expect(shown()).toEqual(['email', 'address']);
    await type('MASQUAGE');
    expect(shown()).toEqual(['phone', 'email']);
    await type('videos');
    expect(shown()).toEqual(['media']);
    await type('zzz');
    expect(document.body.textContent).toContain('Aucun module ne correspond');
    await type('');
    expect(shown()).toEqual(['phone', 'media', 'clipboard', 'email', 'address']);
    expect(storage.stored[StorageKeys.openSections]).toEqual(['phone', 'address']);
    expect(item('address')!.getAttribute('data-state')).toBe('open');
  });
});
