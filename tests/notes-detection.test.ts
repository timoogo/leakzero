// @vitest-environment jsdom
// @vitest-environment-options {"url": "https://www.snapchat.com/web"}
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerNotesBackground } from '../src/notes/background';
import { readConversation, startConversationTracking } from '../src/notes/detect';
import { activeConversation, NOTES_ENABLED, readNotes } from '../src/notes/model';
import { fakeChrome } from './helpers/chrome';

const ALICE = '0b1c2d3e-4f50-4617-8293-a4b5c6d7e8f9';
const BOB = '2c1c2d3e-4f50-4617-8293-a4b5c6d7e8f9';
const CAROL = '3d1c2d3e-4f50-4617-8293-a4b5c6d7e8f9';

/** Snapchat Web after opening a conversation: URL first, then the conversation pane. */
function openConversation(id: string, name: string | null) {
  history.pushState({}, '', `/web/${id}`);
  document.body.innerHTML = `
    <nav><div class="list-item">Bob<span>Salut, mon numéro est 06 00 00 00 00</span></div></nav>
    <main>${name === null ? '' : `<header><h2>${name}</h2></header>`}<ul><li>message privé</li></ul></main>`;
}

let storage: ReturnType<typeof fakeChrome>;
let received: unknown[];
let stop: (() => void) | undefined;

beforeEach(() => {
  vi.useFakeTimers();
  storage = fakeChrome({ [NOTES_ENABLED]: true });
  storage.setSender({ url: 'https://www.snapchat.com/web', tab: { id: 3 } as chrome.tabs.Tab });
  received = [];
  storage.api.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    received.push(message);
    sendResponse({ ok: true, result: null });
    return true;
  });
  history.replaceState({}, '', '/web');
  document.body.innerHTML = '';
  document.title = 'Snapchat';
});

afterEach(() => {
  stop?.();
  stop = undefined;
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const settle = async () => {
  await vi.advanceTimersByTimeAsync(1000);
};
const reported = () => received.map((message) => (message as { conversation: unknown }).conversation);

describe('readConversation', () => {
  it('takes the id from the /web/<id> URL and the name from the conversation header', () => {
    openConversation(ALICE, 'Alice');
    expect(readConversation(document)).toEqual({ id: ALICE, name: 'Alice' });
  });

  it('finds no conversation outside a /web/<uuid> URL: never invents an id', () => {
    for (const path of ['/web', '/web/', '/web/settings', '/web/123', `/other/${ALICE}`]) {
      history.replaceState({}, '', path);
      expect(readConversation(document), path).toBeNull();
    }
  });

  it('reports no name rather than guessing one, and never reads messages or the conversation list', () => {
    openConversation(ALICE, null);
    expect(readConversation(document)).toEqual({ id: ALICE, name: null });
  });

  it('falls back to the page title, without the Snapchat suffix', () => {
    openConversation(ALICE, null);
    document.title = '(2) Alice | Snapchat';
    expect(readConversation(document)).toEqual({ id: ALICE, name: 'Alice' });
    document.title = 'Snapchat';
    expect(readConversation(document)).toEqual({ id: ALICE, name: null });
  });

  it('ignores header text that cannot be a name (too long)', () => {
    openConversation(ALICE, 'x'.repeat(300));
    expect(readConversation(document)!.name).toBeNull();
  });
});

describe('conversation tracking', () => {
  it('reports the open conversation, then each change, once', async () => {
    openConversation(ALICE, 'Alice');
    stop = startConversationTracking(document, storage.api);
    await settle();
    openConversation(BOB, 'Bob');
    await settle();
    document.querySelector('main ul')!.append(document.createElement('li'));
    await settle();
    expect(reported()).toEqual([{ id: ALICE, name: 'Alice' }, { id: BOB, name: 'Bob' }]);
  });

  it('reports only the last conversation of a quick succession', async () => {
    stop = startConversationTracking(document, storage.api);
    await settle();
    openConversation(ALICE, 'Alice');
    await vi.advanceTimersByTimeAsync(50);
    openConversation(BOB, 'Bob');
    await vi.advanceTimersByTimeAsync(50);
    openConversation(CAROL, 'Carol');
    await settle();
    expect(reported()).toEqual([{ id: CAROL, name: 'Carol' }]);
  });

  it('reports the name once the header appears', async () => {
    openConversation(ALICE, null);
    stop = startConversationTracking(document, storage.api);
    await settle();
    document.querySelector('main')!.insertAdjacentHTML('afterbegin', '<header><h2>Alice</h2></header>');
    await settle();
    expect(reported()).toEqual([{ id: ALICE, name: null }, { id: ALICE, name: 'Alice' }]);
  });

  it('keeps the last conversation when Snapchat hides it (focus lost, header removed, back to /web)', async () => {
    openConversation(ALICE, 'Alice');
    stop = startConversationTracking(document, storage.api);
    await settle();
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
    window.dispatchEvent(new Event('blur'));
    document.querySelector('main header')!.remove();
    await settle();
    history.pushState({}, '', '/web');
    document.body.innerHTML = '<main></main>';
    await settle();
    delete (document as { visibilityState?: string }).visibilityState;
    expect(reported()).toEqual([{ id: ALICE, name: 'Alice' }]);
  });

  it('reports again when the tab comes back to the front (several Snapchat tabs)', async () => {
    openConversation(ALICE, 'Alice');
    stop = startConversationTracking(document, storage.api);
    await settle();
    document.dispatchEvent(new Event('visibilitychange'));
    await settle();
    expect(reported()).toHaveLength(2);
  });

  it('does nothing while the module is disabled, and resumes when it is enabled', async () => {
    await storage.externalSet({ [NOTES_ENABLED]: false });
    openConversation(ALICE, 'Alice');
    stop = startConversationTracking(document, storage.api);
    await settle();
    openConversation(BOB, 'Bob');
    await settle();
    expect(received).toEqual([]);
    await storage.externalSet({ [NOTES_ENABLED]: true });
    await settle();
    expect(reported()).toEqual([{ id: BOB, name: 'Bob' }]);
    await storage.externalSet({ [NOTES_ENABLED]: false });
    openConversation(CAROL, 'Carol');
    await settle();
    expect(reported()).toHaveLength(1);
  });

  it('stops for good once the extension was reloaded or updated (orphaned script)', async () => {
    openConversation(ALICE, 'Alice');
    stop = startConversationTracking(document, storage.api);
    await settle();
    storage.invalidate();
    openConversation(BOB, 'Bob');
    await settle();
    expect(reported()).toEqual([{ id: ALICE, name: 'Alice' }]);
  });
});

describe('name requested by the service worker', () => {
  function ask(conversationId: string) {
    storage.setSender({});
    return storage.api.runtime.sendMessage({ type: 'notes:readName', conversationId });
  }

  beforeEach(() => {
    // Only the content script listens: no fake service worker answering in its place.
    (storage.api.runtime.onMessage as unknown as { listeners: Set<unknown> }).listeners.clear();
  });

  it('answers with the name shown now, for the conversation open in this tab only', async () => {
    openConversation(ALICE, 'Haehae Timy');
    stop = startConversationTracking(document, storage.api);
    await settle();
    expect(await ask(ALICE)).toEqual({ ok: true, name: 'Haehae Timy' });
    // Same name, another conversation: never mixed up.
    expect(await ask(BOB)).toEqual({ ok: true, name: null });
    openConversation(ALICE, null);
    expect(await ask(ALICE)).toEqual({ ok: true, name: null });
  });

  it('ignores other messages and other senders', async () => {
    openConversation(ALICE, 'Alice');
    stop = startConversationTracking(document, storage.api);
    await settle();
    storage.setSender({ url: 'https://www.snapchat.com/web', tab: { id: 3 } as chrome.tabs.Tab });
    expect(await storage.api.runtime.sendMessage({ type: 'notes:readName', conversationId: ALICE })).toBeUndefined();
    storage.setSender({});
    expect(await storage.api.runtime.sendMessage({ type: 'other' })).toBeUndefined();
  });
});

describe('real-world chain', () => {
  it('follows an SPA navigation into Snapchat Web, from a page that is not a conversation', async () => {
    history.replaceState({}, '', '/');
    document.body.innerHTML = '<main>Accueil</main>';
    stop = startConversationTracking(document, storage.api);
    await settle();
    expect(received).toEqual([]);
    openConversation(ALICE, 'Alice');
    await settle();
    expect(reported()).toEqual([{ id: ALICE, name: 'Alice' }]);
  });

  it('sends again when the service worker did not answer, even if Snapchat no longer changes the page', async () => {
    const send = vi.mocked(storage.api.runtime.sendMessage);
    send.mockRejectedValueOnce(new Error('Could not establish connection. Receiving end does not exist.'));
    openConversation(ALICE, 'Alice');
    stop = startConversationTracking(document, storage.api);
    await settle();
    expect(received).toEqual([]);
    // No DOM change: the window lost focus, Snapchat is idle.
    await vi.advanceTimersByTimeAsync(3000);
    expect(reported()).toEqual([{ id: ALICE, name: 'Alice' }]);
  });

  it('logs each step, so a missing injection, a failed detection and a failed delivery can be told apart', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    history.replaceState({}, '', '/web/pas-un-uuid');
    stop = startConversationTracking(document, storage.api);
    await settle();
    const logs = () => [...info.mock.calls, ...warn.mock.calls].map((call) => call.join(' '));
    expect(logs()).toContainEqual(expect.stringMatching(/\[LeakZero Notes\] script chargé/));
    expect(logs()).toContainEqual(expect.stringMatching(/module activé/));
    expect(logs()).toContainEqual(expect.stringMatching(/aucune conversation dans l’URL.*\/web\/pas-un-uuid/));
    vi.mocked(storage.api.runtime.sendMessage).mockRejectedValueOnce(new Error('Receiving end does not exist.'));
    openConversation(ALICE, null);
    await settle();
    expect(logs()).toContainEqual(expect.stringMatching(/conversation 0b1c2d3e.*nom introuvable/));
    expect(warn.mock.calls.map((call) => call.join(' '))).toContainEqual(expect.stringMatching(/envoi.*échoué.*Receiving end does not exist/));
    await vi.advanceTimersByTimeAsync(3000);
    expect(logs()).toContainEqual(expect.stringMatching(/conversation 0b1c2d3e enregistrée/));
    // Never the content of the page.
    expect(logs().join('\n')).not.toMatch(/message privé|06 00/);
  });
});

describe('content script → service worker', () => {
  it('creates one note per conversation and follows the active one, also with the Notes window closed', async () => {
    storage = fakeChrome({ [NOTES_ENABLED]: true });
    storage.setSender({ url: 'https://www.snapchat.com/web', tab: { id: 3 } as chrome.tabs.Tab });
    registerNotesBackground(storage.api);
    openConversation(ALICE, 'Alice');
    stop = startConversationTracking(document, storage.api);
    await settle();
    openConversation(BOB, 'Bob');
    await settle();
    openConversation(ALICE, 'Alice');
    await settle();
    expect(readNotes(storage.stored).map((note) => note.name).sort()).toEqual(['Alice', 'Bob']);
    expect(activeConversation(storage.stored)).toMatchObject({ conversationId: ALICE });
    expect(storage.windows.size).toBe(0);
  });

  it('accepts Snapchat Web without www', async () => {
    storage = fakeChrome({ [NOTES_ENABLED]: true });
    storage.setSender({ url: `https://snapchat.com/web/${ALICE}`, tab: { id: 3 } as chrome.tabs.Tab });
    registerNotesBackground(storage.api);
    openConversation(ALICE, 'Alice');
    stop = startConversationTracking(document, storage.api);
    await settle();
    expect(readNotes(storage.stored).map((note) => note.name)).toEqual(['Alice']);
  });

  it('names a conversation whose name is not found yet, and keeps a known name when it is missing', async () => {
    storage = fakeChrome({ [NOTES_ENABLED]: true });
    storage.setSender({ url: 'https://www.snapchat.com/web', tab: { id: 3 } as chrome.tabs.Tab });
    registerNotesBackground(storage.api);
    openConversation(ALICE, null);
    stop = startConversationTracking(document, storage.api);
    await settle();
    expect(readNotes(storage.stored)[0].name).toBe('Conversation 0b1c2d3e');
    openConversation(ALICE, 'Alice');
    await settle();
    openConversation(BOB, 'Bob');
    await settle();
    openConversation(ALICE, null);
    await settle();
    expect(readNotes(storage.stored).find((note) => note.conversationId === ALICE)!.name).toBe('Alice');
  });
});
