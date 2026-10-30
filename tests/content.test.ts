// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { settingKey } from '../src/shared/keys';
import { fakeChrome } from './helpers/chrome';

const PHONE = settingKey('phone', 'enabled');
const REINFORCED = settingKey('phone', 'reinforced');
const MEDIA = settingKey('media', 'enabled');
const ORIGINAL = 'Salut, mon numéro : 06 12 34 56 78';
const PROTECTED = { schemaVersion: 1, [PHONE]: true, [REINFORCED]: true, [MEDIA]: true };

/**
 * Loads a separate copy of the content script, as Chrome does for each injection: its own scanner,
 * text records and overlay layer.
 */
async function contentScript() {
  vi.resetModules();
  const [{ startProtection, TAKEOVER_EVENT }, overlay] = await Promise.all([
    import('../src/content/protection'),
    import('../src/maskers/overlay'),
  ]);
  return { startProtection, TAKEOVER_EVENT, overlay };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const message = () => document.getElementById('m')!.textContent;
const stops: (() => void)[] = [];

afterEach(() => {
  for (const stop of stops.splice(0)) stop();
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});

function addMessage(id: string, text: string) {
  const element = document.createElement('p');
  element.id = id;
  element.textContent = text;
  document.body.append(element);
  return element;
}

describe('content script replaced by an extension reload or update', () => {
  it('regression: the orphaned script never receives "off"; the injected one makes it restore the page', async () => {
    addMessage('m', ORIGINAL);
    const before = fakeChrome(PROTECTED);
    const old = await contentScript();
    stops.push(old.startProtection(document, before.api));
    await settle();
    expect(message()).toBe('Salut, mon numéro : **********');
    expect(old.overlay.overlayState().boxes.some((box) => box.kind === 'box')).toBe(true);

    // The extension is updated (or reloaded) while the tab stays open, then numbers are turned off.
    before.invalidate();
    const after = fakeChrome(before.stored);
    await after.externalSet({ [PHONE]: false });
    await settle();
    // The cause of the bug: the old script still masks, in reinforced mode, and masks new messages too.
    expect(message()).toBe('Salut, mon numéro : **********');
    expect(old.overlay.overlayState().boxes.some((box) => box.kind === 'box')).toBe(true);
    addMessage('n', 'Nouveau : 07 11 22 33 44');
    await settle();
    expect(document.getElementById('n')!.textContent).toBe('Nouveau : **********');

    // The fix: the background script injects the new version, which takes over.
    const current = await contentScript();
    stops.push(current.startProtection(document, after.api));
    await settle();
    expect(message()).toBe(ORIGINAL);
    expect(document.getElementById('n')!.textContent).toBe('Nouveau : 07 11 22 33 44');
    expect(old.overlay.overlayState()).toMatchObject({ phones: [], boxes: [] });
    expect(old.overlay.overlayState().host?.isConnected ?? false).toBe(false);
    expect(current.overlay.overlayState().boxes).toEqual([]);
    // Messages added after the switch-off stay visible; reinforced mode has no effect while off.
    addMessage('o', 'Encore : 06 99 88 77 66');
    await settle();
    expect(document.getElementById('o')!.textContent).toBe('Encore : 06 99 88 77 66');
    // Only the new instance reacts to settings now; media masking stays with it.
    await after.externalSet({ [PHONE]: true });
    await settle();
    expect(message()).toBe('Salut, mon numéro : **********');
    expect(current.overlay.overlayState().boxes.some((box) => box.kind === 'box')).toBe(true);
    expect([...document.querySelectorAll('style[data-leakzero]')].filter((style) => style.textContent!.includes('object-position'))).toHaveLength(1);
    await after.externalSet({ [PHONE]: false });
    await settle();
    expect(message()).toBe(ORIGINAL);
    expect(current.overlay.overlayState().boxes).toEqual([]);
  });

  it('never shows the original number while the injected script takes over a protected page', async () => {
    addMessage('m', ORIGINAL);
    const before = fakeChrome(PROTECTED);
    const old = await contentScript();
    stops.push(old.startProtection(document, before.api));
    await settle();
    before.invalidate();
    const after = fakeChrome(before.stored);
    const text = document.getElementById('m')!.firstChild as Text;
    const current = await contentScript();
    // Synchronous: the old script restores, the new one masks again within the same task.
    stops.push(current.startProtection(document, after.api));
    expect(text.data).toBe('Salut, mon numéro : **********');
    await settle();
    expect(text.data).toBe('Salut, mon numéro : **********');
  });

  it('ignores the takeover event while its extension is alive (a page cannot turn protection off)', async () => {
    addMessage('m', ORIGINAL);
    const storage = fakeChrome(PROTECTED);
    const live = await contentScript();
    stops.push(live.startProtection(document, storage.api));
    await settle();
    document.dispatchEvent(new Event(live.TAKEOVER_EVENT));
    await settle();
    expect(message()).toBe('Salut, mon numéro : **********');
    await storage.externalSet({ [PHONE]: false });
    await settle();
    expect(message()).toBe(ORIGINAL);
  });

  it('leaves preventive masking only until a successful read, and keeps it if storage cannot be read', async () => {
    addMessage('m', ORIGINAL);
    const storage = fakeChrome({ schemaVersion: 1, [PHONE]: false, [REINFORCED]: true, [MEDIA]: false });
    const instance = await contentScript();
    stops.push(instance.startProtection(document, storage.api));
    expect(message()).toBe('Salut, mon numéro : **********');
    await settle();
    expect(message()).toBe(ORIGINAL);
    expect(instance.overlay.overlayState().boxes).toEqual([]);

    document.body.innerHTML = '';
    addMessage('m', ORIGINAL);
    const broken = fakeChrome({ schemaVersion: 1, [PHONE]: false });
    broken.invalidate();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const unknown = await contentScript();
    stops.push(unknown.startProtection(document, broken.api));
    await settle();
    expect(message()).toBe('Salut, mon numéro : **********');
    expect(warn).toHaveBeenCalled();
  });
});

describe('background script', () => {
  async function install(reason: string, storage: ReturnType<typeof fakeChrome>) {
    let onInstalled: ((details: { reason: string }) => void) | undefined;
    (storage.api.runtime as unknown as Record<string, unknown>).onInstalled = { addListener: (listener: typeof onInstalled) => (onInstalled = listener) };
    vi.resetModules();
    await import('../src/background/index');
    onInstalled!({ reason });
    await vi.waitFor(() => expect(storage.stored.schemaVersion).toBe(1));
    await settle();
  }

  it.each(['install', 'update'])('on %s, migrates storage then injects the content script into every open tab', async (reason) => {
    const storage = fakeChrome({ settings: { maskPhones: false } });
    vi.mocked(storage.api.tabs.query).mockResolvedValue([{ id: 1 }, { id: 2 }, {}] as chrome.tabs.Tab[]);
    vi.mocked(storage.api.scripting.executeScript).mockImplementation(async ({ target }) => {
      // Already migrated when the injected script reads its settings.
      expect(storage.stored.schemaVersion).toBe(1);
      if (target.tabId === 2) throw new Error('Cannot access a chrome:// URL');
      return [];
    });
    await install(reason, storage);
    await vi.waitFor(() => expect(storage.api.scripting.executeScript).toHaveBeenCalledTimes(2));
    expect(storage.api.scripting.executeScript).toHaveBeenCalledWith({ target: { tabId: 1, allFrames: true }, files: ['src/content/index.js'], injectImmediately: true });
  });

  it('does not inject when only Chrome was updated (the content scripts are still connected)', async () => {
    const storage = fakeChrome();
    await install('chrome_update', storage);
    expect(storage.api.tabs.query).not.toHaveBeenCalled();
  });
});
