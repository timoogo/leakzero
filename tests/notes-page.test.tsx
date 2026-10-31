// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { Editor } from '@tiptap/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerNotesBackground } from '../src/notes/background';
import { NotesKeys } from '../src/notes/keys';
import { NOTES_ENABLED, readNotes, readOrder } from '../src/notes/model';
import NotesApp from '../src/notes/page/NotesApp';
import { fakeChrome } from './helpers/chrome';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const PAGE = 'chrome-extension://leakzero-test/src/notes/index.html';
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

/** The Snapchat content script reports a conversation. */
async function detect(id: string, name: string) {
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
const buttons = (text: string) => [...document.querySelectorAll<HTMLButtonElement>('button')].filter((b) => b.textContent!.includes(text) || b.getAttribute('aria-label') === text);
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
  storage = fakeChrome({ [NOTES_ENABLED]: true });
  storage.setSender({ url: PAGE });
  registerNotesBackground(storage.api);
});

afterEach(() => {
  if (root) act(() => root!.unmount());
  root = undefined;
  document.body.innerHTML = '';
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

  it('searches by conversation name only', async () => {
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

  it('remembers its position and size', async () => {
    await storage.api.windows.create({ url: PAGE, type: 'popup' });
    await render();
    storage.moveWindow(1, { left: 30, top: 40, width: 700, height: 500 });
    await flush();
    expect(storage.stored[NotesKeys.window]).toEqual({ left: 30, top: 40, width: 700, height: 500 });
  });
});
