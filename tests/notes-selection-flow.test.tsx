// @vitest-environment jsdom
// @vitest-environment-options {"url": "https://www.snapchat.com/web"}
import { IDBFactory } from 'fake-indexeddb';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerNotesBackground } from '../src/notes/background';
import { NotesKeys } from '../src/notes/keys';
import { NOTES_ENABLED, readNotes } from '../src/notes/model';
import NotesApp from '../src/notes/page/NotesApp';
import { LAYER_TAG, startMessageSelection } from '../src/notes/selection';
import { createSelectionStore, type SelectionStore } from '../src/notes/selections';
import { fakeChrome } from './helpers/chrome';

// State updates come from the service worker and the Snapchat script, outside React's act().
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: false });

// Sélection Snapchat → IndexedDB → fiche Notes → désélection → fiche mise à jour, with the real content
// script, service worker, IndexedDB store (fake-indexeddb) and Notes page in one document.

const PAGE = 'chrome-extension://leakzero-test/notes.html';
const ALICE = '0b1c2d3e-4f50-4617-8293-a4b5c6d7e8f9';
const BOB = '2c1c2d3e-4f50-4617-8293-a4b5c6d7e8f9';
/** Commands the Snapchat content script sends; everything else comes from the Notes page. */
const FROM_SNAPCHAT = ['notes:conversation', 'notes:select', 'notes:unselect', 'notes:selectedKeys'];

let storage: ReturnType<typeof fakeChrome>;
let factory: IDBFactory;
let selections: SelectionStore;
let session: ReturnType<typeof startMessageSelection> | undefined;
let root: Root | undefined;
let snapchat: HTMLElement;

/** One browser profile: chrome.storage and IndexedDB survive a restart (`items`, `factory`). */
function startBrowser(items: Record<string, unknown>) {
  storage = fakeChrome(items);
  selections = createSelectionStore(() => factory);
  registerNotesBackground(storage.api, selections);
  storage.setSenderFor((message) => FROM_SNAPCHAT.includes((message as { type: string }).type)
    ? { url: `https://www.snapchat.com${location.pathname}`, tab: { id: 3 } as chrome.tabs.Tab }
    : { url: PAGE });
}

/** Snapchat Web showing a conversation (header, Downshift menu, messages grouped by sender). */
function openSnapchat(id: string, name: string) {
  history.pushState({}, '', `/web/${id}`);
  snapchat.innerHTML = `
    <div data-chat>
      <div><div role="combobox" aria-haspopup="listbox"><span>${name}</span></div><ul role="listbox"></ul><button type="button" title="Close Chat"></button></div>
      <ul>
        <li>
          <header><span>${name}</span></header>
          <ul>
            <li data-m="hello"><span>Salut toi</span><time datetime="2026-10-30T14:02:00.000Z">14:02</time></li>
            <li data-m="photo"><img src="https://cf-st.sc-cdn.net/d/photo.jpg" alt="Photo"></li>
          </ul>
        </li>
      </ul>
    </div>`;
}

async function detect(id: string, name: string) {
  await storage.api.runtime.sendMessage({ type: 'notes:conversation', conversation: { id, name } });
}

async function renderNotes() {
  if (root) root.unmount();
  const container = document.body.appendChild(document.createElement('div'));
  root = createRoot(container);
  await act(async () => root!.render(<NotesApp />));
}

const message = (name: string) => snapchat.querySelector(`[data-m="${name}"]`)!;
const checkbox = (text: string) => [...document.querySelector(LAYER_TAG)!.shadowRoot!.querySelectorAll('input')]
  .find((input) => input.getAttribute('aria-label')!.includes(text))!;
const section = () => document.querySelector('section[aria-labelledby="selected-messages-title"]')!;
const count = () => section().querySelector('[data-selected-count]')!.textContent;
const listed = () => [...section().querySelectorAll('[data-selected-message]')];
const title = () => document.querySelector('h1[data-note-title]')?.textContent;

beforeEach(() => {
  factory = new IDBFactory();
  document.body.innerHTML = '';
  snapchat = document.body.appendChild(document.createElement('div'));
  startBrowser({ [NOTES_ENABLED]: true });
});

afterEach(async () => {
  session?.stop();
  session = undefined;
  root?.unmount();
  root = undefined;
  await selections.close();
  vi.unstubAllGlobals();
});

describe('selected messages, from Snapchat Web to the note', () => {
  it('shows each selection in the note of its conversation, and removes it when unselected, across a restart', async () => {
    openSnapchat(ALICE, 'Alice');
    await detect(ALICE, 'Alice');
    await renderNotes();
    await vi.waitFor(() => expect(title()).toBe('Alice'));
    await vi.waitFor(() => expect(count()).toBe('(0)'));

    // « Sélectionner des messages » in the note, then back to Snapchat.
    [...document.querySelectorAll('button')].find((button) => button.textContent!.includes('Sélectionner des messages'))!.click();
    await vi.waitFor(() => expect(storage.stored[NotesKeys.selecting]).toBe(ALICE));
    session = startMessageSelection(document, storage.api);
    await vi.waitFor(() => expect(checkbox('Salut toi')).toBeDefined());

    // Selected from its checkbox: stored in IndexedDB under the conversation, shown in its note.
    checkbox('Salut toi').click();
    await vi.waitFor(async () => expect(await selections.list(ALICE)).toHaveLength(1));
    await vi.waitFor(() => expect(count()).toBe('(1)'));
    const [first] = listed();
    expect(first.querySelector('[data-author]')!.textContent).toBe('Alice');
    expect(first.querySelector('[data-text]')!.textContent).toBe('Salut toi');
    expect(first.querySelector('[data-type]')!.textContent).toBe('Texte');
    expect(first.querySelector('[data-sent]')!.textContent).toMatch(/^Envoyé : /);

    // Selected by clicking the message itself: a media, without author header of its own, nor time.
    message('photo').dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    await vi.waitFor(() => expect(count()).toBe('(2)'));
    const photo = listed()[1];
    expect(photo.querySelector('[data-type]')!.textContent).toBe('Image');
    expect(photo.querySelector('[data-sent]')).toBeNull();
    expect(photo.textContent).toContain('Image (Photo)');
    // Never written into the free text of the note.
    expect(readNotes(storage.stored)[0].html).toBe('');

    // Unselected on Snapchat: gone from IndexedDB and from the note.
    checkbox('Salut toi').click();
    await vi.waitFor(() => expect(count()).toBe('(1)'));
    expect(listed().map((item) => item.querySelector('[data-type]')!.textContent)).toEqual(['Image']);
    expect((await selections.list(ALICE)).map((record) => record.type)).toEqual(['image']);

    // Browser restarted: same chrome.storage and IndexedDB, new service worker, script and page.
    session.stop();
    root!.unmount();
    root = undefined;
    await selections.close();
    startBrowser(structuredClone(storage.stored));
    await renderNotes();
    await vi.waitFor(() => expect(count()).toBe('(1)'));
    expect(listed()[0].textContent).toContain('Image (Photo)');
  });

  it('exports, in HTML and TXT, every message the note shows in « Messages sélectionnés »', async () => {
    const downloads: Blob[] = [];
    vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: (blob: Blob) => { downloads.push(blob); return 'blob:test'; }, revokeObjectURL: () => undefined }));
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    openSnapchat(ALICE, 'Alice');
    await detect(ALICE, 'Alice');
    await storage.externalSet({ [NotesKeys.selecting]: ALICE });
    await renderNotes();
    session = startMessageSelection(document, storage.api);
    await vi.waitFor(() => expect(checkbox('Salut toi')).toBeDefined());
    checkbox('Salut toi').click();
    checkbox('(image)').click();
    await vi.waitFor(() => expect(count()).toBe('(2)'));

    const shown = listed().map((item) => [...item.querySelectorAll('p')].map((p) => [...p.children].length > 0
      ? [...p.children].map((child) => child.textContent!) : [p.textContent!]).flat());
    const exportAs = async (label: string) => {
      [...document.querySelectorAll('button')].find((button) => button.getAttribute('aria-label') === label)!.click();
      await vi.waitFor(() => expect(downloads.length).toBeGreaterThan(0));
      return downloads.pop()!.text();
    };
    const html = await exportAs('Exporter en HTML');
    const text = await exportAs('Exporter en TXT');
    const page = new DOMParser().parseFromString(html, 'text/html').querySelector('#selected-messages')!;
    expect(page.querySelector('h2')!.textContent).toBe('Messages sélectionnés (2)');
    // Every piece of information the note shows, in both files.
    for (const piece of shown.flat()) {
      expect(page.textContent).toContain(piece);
      expect(text).toContain(piece);
    }
    expect(shown.flat()).toEqual(expect.arrayContaining(['Alice', 'Salut toi', 'Texte', 'Image', 'Image (Photo)']));
    vi.restoreAllMocks();
  });

  it('shows the image of a selected message as a thumbnail in the note, copied from the page', async () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ drawImage: vi.fn() } as unknown as CanvasRenderingContext2D);
    vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue('data:image/jpeg;base64,AAE=');
    openSnapchat(ALICE, 'Alice');
    // Loaded and decoded by Snapchat.
    Object.defineProperties(message('photo').querySelector('img')!, { complete: { value: true }, naturalWidth: { value: 960 }, naturalHeight: { value: 720 } });
    await detect(ALICE, 'Alice');
    await storage.externalSet({ [NotesKeys.selecting]: ALICE });
    await renderNotes();
    session = startMessageSelection(document, storage.api);
    await vi.waitFor(() => expect(checkbox('(image)')).toBeDefined());
    checkbox('(image)').click();
    await vi.waitFor(() => expect(count()).toBe('(1)'));
    const thumbnail = listed()[0].querySelector('figure img')!;
    expect(thumbnail.getAttribute('src')).toBe('data:image/jpeg;base64,AAE=');
    expect(thumbnail.getAttribute('alt')).toBe('Photo');
    expect((await selections.list(ALICE))[0].media[0]).toEqual({
      kind: 'image', alt: 'Photo', preview: { dataUrl: 'data:image/jpeg;base64,AAE=', width: 480, height: 360 }, spoiler: false,
    });
    vi.restoreAllMocks();
  });

  it('keeps each conversation’s selected messages in its own note', async () => {
    openSnapchat(ALICE, 'Alice');
    await detect(ALICE, 'Alice');
    await storage.externalSet({ [NotesKeys.selecting]: ALICE });
    session = startMessageSelection(document, storage.api);
    await vi.waitFor(() => expect(checkbox('Salut toi')).toBeDefined());
    checkbox('Salut toi').click();
    await vi.waitFor(async () => expect(await selections.list(ALICE)).toHaveLength(1));

    // Bob's conversation, detected last: his note is shown, without Alice's message.
    openSnapchat(BOB, 'Bob');
    await detect(BOB, 'Bob');
    await renderNotes();
    await vi.waitFor(() => expect(title()).toBe('Bob'));
    await vi.waitFor(() => expect(count()).toBe('(0)'));
    expect(listed()).toEqual([]);
  });

  it('only gives the selected messages to the extension’s pages', async () => {
    storage.setSenderFor(() => ({ url: `https://www.snapchat.com/web/${ALICE}`, tab: { id: 3 } as chrome.tabs.Tab }));
    expect(await storage.api.runtime.sendMessage({ type: 'notes:selectedMessages', conversationId: ALICE })).toMatchObject({ ok: false });
  });
});
