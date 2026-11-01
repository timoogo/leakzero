// @vitest-environment jsdom
import { strFromU8, unzipSync } from 'fflate';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { exportArchive, noteDocument, noteFileName, noteText, parseArchive } from '../src/notes/archive';
import { registerNotesBackground } from '../src/notes/background';
import { applyImport } from '../src/notes/importing';
import { noteKey } from '../src/notes/keys';
import { filterByName, listedNotes } from '../src/notes/list';
import { displayName, NOTES_ENABLED, readNotes, type Note } from '../src/notes/model';
import { fakeChrome } from './helpers/chrome';

const ALICE = '0b1c2d3e-4f50-4617-8293-a4b5c6d7e8f9';
const PAGE = 'chrome-extension://leakzero-test/notes.html';

let storage: ReturnType<typeof fakeChrome>;

function start(items: Record<string, unknown> = {}) {
  storage = fakeChrome({ [NOTES_ENABLED]: true, ...items });
  registerNotesBackground(storage.api);
}

async function detect(name: string | null, id = ALICE) {
  storage.setSender({ url: `https://www.snapchat.com/web/${id}`, tab: { id: 4 } as chrome.tabs.Tab });
  return storage.api.runtime.sendMessage({ type: 'notes:conversation', conversation: { id, name } });
}

function command(message: unknown) {
  storage.setSender({ url: PAGE });
  return storage.api.runtime.sendMessage(message) as Promise<{ ok: boolean; error?: string }>;
}

const only = () => readNotes(storage.stored)[0];

function note(id: string, extra: Partial<Note> = {}): Note {
  return { id, conversationId: null, name: id, customName: null, html: '<p>texte</p>', createdAt: 1, updatedAt: 2, lastSeenAt: 3, trashedAt: null, ...extra };
}

beforeEach(() => start());
afterEach(() => vi.unstubAllGlobals());

describe('custom title', () => {
  it('is shown instead of the detected name, which keeps following Snapchat underneath', async () => {
    await detect('Alice');
    expect(await command({ type: 'notes:rename', id: only().id, customName: '  Alice (travail)  ' })).toMatchObject({ ok: true });
    expect(only()).toMatchObject({ name: 'Alice', customName: 'Alice (travail)', conversationId: ALICE });
    expect(displayName(only())).toBe('Alice (travail)');
    // Snapchat renames the conversation: the custom title stays, the UUID never changes.
    await detect('Alice B.');
    await detect(null);
    expect(only()).toMatchObject({ name: 'Alice B.', customName: 'Alice (travail)', conversationId: ALICE });
    expect(readNotes(storage.stored)).toHaveLength(1);
  });

  it('goes back to the detected name', async () => {
    await detect('Alice');
    await command({ type: 'notes:rename', id: only().id, customName: 'Perso' });
    await command({ type: 'notes:rename', id: only().id, customName: null });
    expect(only().customName).toBeNull();
    expect(displayName(only())).toBe('Alice');
  });

  it('rejects an empty or too long title, and renaming from a web page', async () => {
    await detect('Alice');
    const id = only().id;
    expect(await command({ type: 'notes:rename', id, customName: '   ' })).toMatchObject({ ok: false });
    expect(await command({ type: 'notes:rename', id, customName: 'x'.repeat(201) })).toMatchObject({ ok: false });
    storage.setSender({ url: `https://www.snapchat.com/web/${ALICE}` });
    expect(await storage.api.runtime.sendMessage({ type: 'notes:rename', id, customName: 'Pirate' })).toMatchObject({ ok: false });
    expect(only().customName).toBeNull();
  });

  it('is kept in storage, so it survives a restart of Chrome', async () => {
    await detect('Alice');
    await command({ type: 'notes:rename', id: only().id, customName: 'Perso' });
    start(structuredClone(storage.stored));
    expect(displayName(only())).toBe('Perso');
  });

  it('reads notes stored before custom titles existed', () => {
    const { customName: _customName, ...old } = note('n1', { conversationId: ALICE, name: 'Alice' });
    expect(readNotes({ [noteKey('n1')]: old })).toEqual([{ ...old, customName: null }]);
  });

  it('is searched as well as the detected name', () => {
    const notes = [note('a', { name: 'Alice', customName: 'Collègue' }), note('b', { name: 'Bob' })];
    expect(filterByName(notes, 'collegue').map((n) => n.id)).toEqual(['a']);
    expect(filterByName(notes, 'alice').map((n) => n.id)).toEqual(['a']);
    expect(listedNotes(notes, null).map(displayName)).toEqual(['Bob', 'Collègue']);
  });

  it('is used by exports and kept by an export/import round trip', () => {
    const renamed = note('n1', { conversationId: ALICE, name: 'Alice', customName: 'Collègue' });
    expect(noteFileName(renamed, 'txt')).toMatch(/^collegue-/);
    expect(noteDocument(renamed)).toContain('<title>Collègue</title>');
    expect(noteText(renamed).split('\n')[0]).toBe('Collègue');
    const zip = exportArchive([renamed], { includeTrash: false });
    expect(JSON.parse(strFromU8(unzipSync(zip)['manifest.json'])).notes[0]).toMatchObject({ name: 'Alice', customName: 'Collègue' });
    expect(parseArchive(zip)).toEqual([renamed]);
  });

  it('marks an imported copy on the title that is shown', () => {
    const existing = note('n1', { conversationId: ALICE, name: 'Alice', customName: 'Collègue' });
    const { patch } = applyImport([existing], [existing], { n1: 'both' }, () => 'n2');
    expect(patch[noteKey('n2')]).toMatchObject({ name: 'Alice (copie importée)', customName: 'Collègue (copie importée)' });
  });
});
