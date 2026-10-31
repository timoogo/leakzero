// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { Editor } from '@tiptap/core';
import { strFromU8, unzipSync } from 'fflate';
import { exportArchive } from '../src/notes/archive';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerNotesBackground } from '../src/notes/background';
import { NotesKeys } from '../src/notes/keys';
import { NOTES_ENABLED, readNotes, readOrder } from '../src/notes/model';
import NotesApp from '../src/notes/page/NotesApp';
import { fakeChrome } from './helpers/chrome';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const PAGE = 'chrome-extension://leakzero-test/notes.html';
const ALICE = '0b1c2d3e-4f50-4617-8293-a4b5c6d7e8f9';
const BOB = '2c1c2d3e-4f50-4617-8293-a4b5c6d7e8f9';
const CAROL = '3d1c2d3e-4f50-4617-8293-a4b5c6d7e8f9';

let storage: ReturnType<typeof fakeChrome>;
let root: Root | undefined;

const flush = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
const wait = (ms: number) => act(async () => { await new Promise((resolve) => setTimeout(resolve, ms)); });

async function render() {
  if (root) act(() => root!.unmount());
  document.body.innerHTML = '';
  root = createRoot(document.body.appendChild(document.createElement('div')));
  await act(async () => root!.render(<NotesApp />));
  await flush();
  await flush();
}

/** The Snapchat content script reports a conversation, a second after the previous one. */
async function detect(id: string, name: string) {
  vi.setSystemTime(Date.now() + 1000);
  storage.setSender({ url: `https://www.snapchat.com/web/${id}`, tab: { id: 9 } as chrome.tabs.Tab });
  const response = storage.api.runtime.sendMessage({ type: 'notes:conversation', conversation: { id, name } });
  storage.setSender({ url: PAGE });
  await act(async () => { await response; });
  await flush();
}

const items = () => [...document.querySelectorAll<HTMLElement>('[data-note]')];
const names = () => items().map((item) => item.querySelector('[data-note-name]')!.textContent);
const selected = () => document.querySelector('[data-note][aria-current="true"] [data-note-name]')?.textContent;
const title = () => document.querySelector('h1[data-note-title]')?.textContent;
const editor = () => (document.querySelector('.ProseMirror') as HTMLElement & { editor: Editor }).editor;
const status = () => document.querySelector('[data-save-status]')!.textContent;
/** Buttons the user can reach: those of the open dialog, if any (it is modal). */
const buttons = (text: string) => [...(document.querySelector('[role="alertdialog"]') ?? document).querySelectorAll<HTMLButtonElement>('button')].filter((b) => b.textContent!.includes(text) || b.getAttribute('aria-label') === text);
const button = (text: string) => {
  const found = buttons(text);
  expect(found, `button "${text}"`).toHaveLength(1);
  return found[0];
};
const click = (element: HTMLElement) => act(async () => element.click());
const noteButton = (name: string) => items().find((item) => item.textContent!.includes(name))!.querySelector<HTMLButtonElement>('button[data-select]')!;
const stored = (name: string) => readNotes(storage.stored).find((note) => note.name === name)!;
const type = async (text: string) => {
  await act(async () => { editor().commands.insertContent(text); });
};
const focusEditor = () => act(async () => { editor().view.dom.dispatchEvent(new FocusEvent('focusin', { bubbles: true })); });
const blurEditor = () => act(async () => { editor().view.dom.dispatchEvent(new FocusEvent('focusout', { bubbles: true })); });

beforeEach(() => {
  // Only the clock: activity dates must differ even within the same millisecond.
  vi.useFakeTimers({ toFake: ['Date'], now: 1_700_000_000_000 });
  storage = fakeChrome({ [NOTES_ENABLED]: true });
  storage.setSender({ url: PAGE });
  registerNotesBackground(storage.api);
});

afterEach(() => {
  if (root) act(() => root!.unmount());
  root = undefined;
  document.body.innerHTML = '';
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('Notes page', () => {
  it('lists the detected conversations, most recent first, and shows the active one', async () => {
    await detect(ALICE, 'Alice');
    await detect(BOB, 'Bob');
    await render();
    expect(names()).toEqual(['Bob', 'Alice']);
    expect(selected()).toBe('Bob');
    expect(title()).toBe('Bob');
  });

  it('follows the conversation open on Snapchat, creating its note', async () => {
    await render();
    expect(document.body.textContent).toContain('Ouvrez une conversation sur Snapchat');
    await detect(ALICE, 'Alice');
    expect(title()).toBe('Alice');
    await detect(BOB, 'Bob');
    expect(title()).toBe('Bob');
    expect(names()).toEqual(['Bob', 'Alice']);
  });

  it('does not switch notes while the editor has the focus, then applies the last conversation', async () => {
    await detect(ALICE, 'Alice');
    await render();
    await focusEditor();
    await detect(BOB, 'Bob');
    await detect(CAROL, 'Carol');
    expect(title()).toBe('Alice');
    await blurEditor();
    expect(title()).toBe('Carol');
  });

  it('suspends following when a note is picked by hand, until "Reprendre le suivi"', async () => {
    await detect(ALICE, 'Alice');
    await detect(BOB, 'Bob');
    await render();
    expect(buttons('Reprendre le suivi')).toHaveLength(0);
    await click(noteButton('Alice'));
    expect(title()).toBe('Alice');
    await detect(CAROL, 'Carol');
    expect(title()).toBe('Alice');
    await click(button('Reprendre le suivi'));
    expect(title()).toBe('Carol');
    expect(buttons('Reprendre le suivi')).toHaveLength(0);
  });

  it('saves 300 ms after typing stops, showing the save state, and keeps the note after reopening', async () => {
    await detect(ALICE, 'Alice');
    await render();
    expect(status()).toBe('Sauvegardé');
    await type('Rappel important');
    expect(status()).toBe('Modification en cours…');
    expect(stored('Alice').html).toBe('');
    await wait(400);
    expect(stored('Alice').html).toBe('<p>Rappel important</p>');
    expect(status()).toBe('Sauvegardé');
    await render();
    expect(editor().getHTML()).toBe('<p>Rappel important</p>');
  });

  it('saves immediately when switching notes before the delay, so nothing is lost', async () => {
    await detect(ALICE, 'Alice');
    await detect(BOB, 'Bob');
    await render();
    await type('pour Bob');
    await click(noteButton('Alice'));
    await flush();
    expect(stored('Bob').html).toBe('<p>pour Bob</p>');
    expect(title()).toBe('Alice');
    expect(editor().getHTML()).toBe('<p></p>');
  });

  it('saves immediately when the window is closed', async () => {
    await detect(ALICE, 'Alice');
    await render();
    await type('avant fermeture');
    await act(async () => { window.dispatchEvent(new Event('pagehide')); });
    await flush();
    expect(stored('Alice').html).toBe('<p>avant fermeture</p>');
  });

  it('shows a save error and lets the user retry', async () => {
    await detect(ALICE, 'Alice');
    await render();
    storage.failNextSet();
    await type('texte');
    await wait(400);
    expect(status()).toContain('Erreur de sauvegarde');
    await click(button('Réessayer'));
    await flush();
    expect(stored('Alice').html).toBe('<p>texte</p>');
    expect(status()).toBe('Sauvegardé');
  });

  it('explains a save that fails because no service worker answers, and keeps the text', async () => {
    await detect(ALICE, 'Alice');
    (storage.api.runtime.onMessage as unknown as { listeners: Set<unknown> }).listeners.clear();
    await render();
    await type('texte');
    await wait(900);
    expect(status()).toContain('Erreur de sauvegarde');
    expect(status()).toContain('rechargez LeakZero');
    expect(editor().getHTML()).toBe('<p>texte</p>');
    registerNotesBackground(storage.api);
    await click(button('Réessayer'));
    await flush();
    expect(stored('Alice').html).toBe('<p>texte</p>');
    expect(status()).toBe('Sauvegardé');
  });

  it('formats text: headings, bold, italic, underline, lists, links', async () => {
    await detect(ALICE, 'Alice');
    await render();
    await type('mot');
    await act(async () => { editor().commands.selectAll(); });
    for (const label of ['Gras', 'Italique', 'Souligné']) await click(button(label));
    expect(editor().getHTML()).toBe('<p><strong><em><u>mot</u></em></strong></p>');
    await click(button('Liste à puces'));
    expect(editor().getHTML()).toContain('<ul>');
    await click(button('Liste à puces'));
    await click(button('Titre'));
    expect(editor().getHTML()).toContain('<h2>');
    await click(button('Lien'));
    const input = document.querySelector<HTMLInputElement>('input[aria-label="Adresse du lien"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'example.com');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await click(button('Appliquer'));
    expect(editor().getHTML()).toContain('href="https://example.com"');
  });

  it('searches by name, never in the content', async () => {
    await detect(ALICE, 'Alice');
    await detect(BOB, 'Bob');
    await render();
    const search = document.querySelector<HTMLInputElement>('input[type="search"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(search, 'ali');
      search.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(names()).toEqual(['Alice']);
  });

  it('renames a note in place, keeps the title when Snapchat syncs, and goes back to the detected name', async () => {
    await detect(ALICE, 'Alice');
    await render();
    await click(button('Renommer la fiche'));
    const input = document.querySelector<HTMLInputElement>('input[name="customName"]')!;
    expect(input.value).toBe('Alice');
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'Alice (travail)');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => input.form!.requestSubmit());
    await flush();
    expect(title()).toBe('Alice (travail)');
    expect(names()).toEqual(['Alice (travail)']);
    expect(document.querySelector('[data-detected-name]')!.textContent).toContain('Alice');
    expect(stored('Alice')).toMatchObject({ customName: 'Alice (travail)', conversationId: ALICE });
    // A Snapchat sync never overwrites it.
    await detect(ALICE, 'Alice B.');
    expect(title()).toBe('Alice (travail)');
    await click(button('Revenir au nom Snapchat'));
    await flush();
    expect(title()).toBe('Alice B.');
    expect(document.querySelector('[data-detected-name]')).toBeNull();
  });

  it('cancels renaming with Échap, and an empty title goes back to the detected name', async () => {
    await detect(ALICE, 'Alice');
    await render();
    await click(button('Renommer la fiche'));
    let input = document.querySelector<HTMLInputElement>('input[name="customName"]')!;
    await act(async () => { input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
    expect(document.querySelector('input[name="customName"]')).toBeNull();
    await click(button('Renommer la fiche'));
    input = document.querySelector<HTMLInputElement>('input[name="customName"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, '   ');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => input.form!.requestSubmit());
    await flush();
    expect(title()).toBe('Alice');
    expect(stored('Alice').customName).toBeNull();
  });

  it('searches custom titles too', async () => {
    await detect(ALICE, 'Alice');
    await detect(BOB, 'Bob');
    await storage.externalSet({ [`notes:note:${stored('Bob').id}`]: { ...stored('Bob'), customName: 'Collègue' } });
    await render();
    const search = document.querySelector<HTMLInputElement>('input[type="search"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(search, 'collegue');
      search.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(names()).toEqual(['Collègue']);
  });

  it('reorders by drag and drop or keyboard, keeps the order, and goes back to recent activity', async () => {
    await detect(ALICE, 'Alice');
    await detect(BOB, 'Bob');
    await detect(CAROL, 'Carol');
    await render();
    expect(names()).toEqual(['Carol', 'Bob', 'Alice']);
    const [carol, , alice] = items();
    await act(async () => {
      alice.dispatchEvent(new Event('dragstart', { bubbles: true }));
      carol.dispatchEvent(new Event('dragover', { bubbles: true, cancelable: true }));
      carol.dispatchEvent(new Event('drop', { bubbles: true, cancelable: true }));
    });
    await flush();
    expect(names()).toEqual(['Alice', 'Carol', 'Bob']);
    await act(async () => { noteButton('Bob').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', altKey: true, bubbles: true })); });
    await flush();
    expect(names()).toEqual(['Alice', 'Bob', 'Carol']);
    await render();
    expect(names()).toEqual(['Alice', 'Bob', 'Carol']);
    await click(button('Trier par activité récente'));
    await flush();
    expect(names()).toEqual(['Carol', 'Bob', 'Alice']);
    expect(readOrder(storage.stored)).toBeNull();
  });

  it('moves a note to the trash, restores it, and deletes it for good after confirmation', async () => {
    await detect(ALICE, 'Alice');
    await detect(BOB, 'Bob');
    await render();
    await click(button('Supprimer'));
    await flush();
    expect(names()).toEqual(['Alice']);
    await click(button('Corbeille (1)'));
    expect(names()).toEqual(['Bob']);
    await click(button('Restaurer'));
    await flush();
    expect(names()).toEqual([]);
    await click(button('Retour aux fiches'));
    expect(names()).toEqual(['Bob', 'Alice']);
    await click(noteButton('Alice'));
    await click(button('Supprimer'));
    await flush();
    await click(button('Corbeille (1)'));
    await click(button('Supprimer définitivement'));
    expect(stored('Alice')).toBeDefined();
    await click(button('Supprimer pour toujours'));
    await flush();
    expect(stored('Alice')).toBeUndefined();
  });

  it('offers to restore the note of a trashed conversation opened again on Snapchat', async () => {
    await detect(ALICE, 'Alice');
    await render();
    await click(button('Supprimer'));
    await flush();
    await detect(ALICE, 'Alice');
    expect(readNotes(storage.stored)).toHaveLength(1);
    expect(document.body.textContent).toContain('La fiche de « Alice » est dans la corbeille.');
    await click(button('Restaurer la fiche'));
    await flush();
    expect(title()).toBe('Alice');
    expect(stored('Alice').trashedAt).toBeNull();
  });

  it('opens on the note of the last conversation, even after leaving Snapchat', async () => {
    await detect(ALICE, 'Alice');
    await detect(BOB, 'Bob');
    // Snapchat tab closed, service worker restarted: only storage is left.
    registerNotesBackground(storage.api);
    await render();
    expect(title()).toBe('Bob');
    expect(editor().isEditable).toBe(true);
  });

  it('says so when no conversation was detected yet', async () => {
    await render();
    expect(document.body.textContent).toContain('Aucune conversation Snapchat détectée pour l’instant');
  });

  it('opened in a tab and in the window, shows the same data without overwriting it', async () => {
    await detect(ALICE, 'Alice');
    await render();
    const other = document.createElement('div');
    const tabRoot = createRoot(document.body.appendChild(other));
    await act(async () => tabRoot.render(<NotesApp />));
    await flush();
    const [windowEditor, tabEditor] = [...document.querySelectorAll('.ProseMirror')].map((node) => (node as HTMLElement & { editor: Editor }).editor);
    await act(async () => { tabEditor.commands.insertContent('depuis l’onglet'); });
    await wait(400);
    expect(stored('Alice').html).toBe('<p>depuis l’onglet</p>');
    expect(windowEditor.getHTML()).toBe('<p>depuis l’onglet</p>');
    act(() => tabRoot.unmount());
    expect(stored('Alice').html).toBe('<p>depuis l’onglet</p>');
  });

  it('remembers its position and size in the floating window, not in a tab', async () => {
    const tab = await storage.api.windows.create({ url: PAGE, type: 'normal' });
    await render();
    storage.moveWindow(tab.id!, { left: 5, top: 5, width: 1500, height: 900 });
    await flush();
    expect(storage.stored[NotesKeys.window]).toBeUndefined();
    act(() => root!.unmount());
    root = undefined;
    await storage.api.windows.create({ url: PAGE, type: 'popup' });
    await render();
    storage.moveWindow(2, { left: 30, top: 40, width: 700, height: 500 });
    await flush();
    expect(storage.stored[NotesKeys.window]).toEqual({ left: 30, top: 40, width: 700, height: 500 });
  });
});

describe('export and import', () => {
  let downloads: { name: string; blob: Blob }[];
  beforeEach(() => {
    downloads = [];
    const urls = new Map<string, Blob>();
    vi.stubGlobal('URL', Object.assign(URL, {
      createObjectURL: (blob: Blob) => {
        const url = `blob:test/${urls.size}`;
        urls.set(url, blob);
        return url;
      },
      revokeObjectURL: () => undefined,
    }));
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      downloads.push({ name: this.download, blob: urls.get(this.href)! });
    });
  });
  afterEach(() => vi.restoreAllMocks());

  const zipEntries = async (blob: Blob) =>
    Object.fromEntries(Object.entries(unzipSync(new Uint8Array(await blob.arrayBuffer()))).map(([name, data]) => [name, strFromU8(data)]));

  async function chooseFile(bytes: Uint8Array, name = 'notes.zip') {
    const input = document.querySelector<HTMLInputElement>('input[type="file"]')!;
    Object.defineProperty(input, 'files', { configurable: true, value: [new File([bytes as Uint8Array<ArrayBuffer>], name, { type: 'application/zip' })] });
    await act(async () => { input.dispatchEvent(new Event('change', { bubbles: true })); });
    await flush();
    await flush();
  }

  it('exports the open note as HTML or TXT', async () => {
    await detect(ALICE, 'Alice');
    await render();
    await type('Rappel');
    await click(button('Exporter en HTML'));
    await click(button('Exporter en TXT'));
    expect(downloads.map((download) => download.name)).toEqual([expect.stringMatching(/^alice-.+\.html$/), expect.stringMatching(/^alice-.+\.txt$/)]);
    expect(await downloads[0].blob.text()).toContain('<main id="note"><p>Rappel</p></main>');
    expect(await downloads[1].blob.text()).toContain('Rappel');
  });

  it('exports every note as a ZIP, the trash only when asked', async () => {
    await detect(ALICE, 'Alice');
    await detect(BOB, 'Bob');
    await render();
    await click(button('Supprimer'));
    await flush();
    await click(button('Exporter tout (ZIP)'));
    await click(button('Exporter'));
    expect(downloads[0].name).toMatch(/^leakzero-notes-\d{4}-\d{2}-\d{2}\.zip$/);
    expect(JSON.parse((await zipEntries(downloads[0].blob))['manifest.json']).notes.map((note: { name: string }) => note.name)).toEqual(['Alice']);
    await click(button('Exporter tout (ZIP)'));
    await click(document.querySelector<HTMLButtonElement>('[role="switch"][aria-label="Inclure la corbeille"]')!);
    await click(button('Exporter'));
    expect(JSON.parse((await zipEntries(downloads[1].blob))['manifest.json']).notes).toHaveLength(2);
  });

  it('imports an archive after showing what it contains', async () => {
    await render();
    const archive = exportArchive([
      { id: 'n1', conversationId: ALICE, name: 'Alice', html: '<p>importée</p>', createdAt: 1, updatedAt: 2, lastSeenAt: 3, trashedAt: null, customName: null },
    ], { includeTrash: false });
    await chooseFile(archive);
    expect(document.body.textContent).toContain('1 fiche à importer');
    expect(readNotes(storage.stored)).toEqual([]);
    await click(button('Importer'));
    await flush();
    expect(stored('Alice')).toMatchObject({ id: 'n1', html: '<p>importée</p>' });
    expect(document.body.textContent).toContain('1 ajoutée');
  });

  it('resolves conflicts with a global choice, overridable per note', async () => {
    await detect(ALICE, 'Alice');
    await detect(BOB, 'Bob');
    await render();
    const alice = stored('Alice');
    const bob = stored('Bob');
    const archive = exportArchive([
      { ...alice, html: '<p>archive Alice</p>' },
      { ...bob, html: '<p>archive Bob</p>' },
    ], { includeTrash: false });
    await chooseFile(archive);
    expect(document.body.textContent).toContain('2 en conflit');
    const choice = (scope: string, label: string) =>
      document.querySelector<HTMLButtonElement>(`[role="radiogroup"][aria-label="${scope}"] [role="radio"][aria-label="${label}"]`)!;
    expect(choice('Pour toutes les fiches en conflit', 'Conserver l’existante').getAttribute('aria-checked')).toBe('true');
    await click(choice('Pour toutes les fiches en conflit', 'Remplacer'));
    await click(choice('Bob', 'Conserver les deux'));
    await click(button('Importer'));
    await flush();
    expect(readNotes(storage.stored)).toHaveLength(3);
    expect(stored('Alice')).toMatchObject({ id: alice.id, html: '<p>archive Alice</p>' });
    expect(stored('Bob')).toMatchObject({ id: bob.id, html: '' });
    expect(stored('Bob (copie importée)')).toMatchObject({ conversationId: null, html: '<p>archive Bob</p>' });
  });

  it('rejects an invalid archive without writing anything', async () => {
    await render();
    await chooseFile(new TextEncoder().encode('pas un zip'));
    expect(document.querySelector('[role="alert"]')!.textContent).toContain('n’est pas une archive ZIP');
    expect(document.querySelector('[role="alertdialog"]')).toBeNull();
    expect(readNotes(storage.stored)).toEqual([]);
  });

  it('can cancel an import', async () => {
    await render();
    await chooseFile(exportArchive([{ id: 'n1', conversationId: null, name: 'X', html: '', createdAt: 1, updatedAt: 1, lastSeenAt: 1, trashedAt: null, customName: null }], { includeTrash: false }));
    await click(button('Annuler'));
    expect(readNotes(storage.stored)).toEqual([]);
  });
});
