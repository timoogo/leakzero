import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { settingKey } from '../src/shared/keys';
import { registerNotesBackground } from '../src/notes/background';
import { NotesKeys } from '../src/notes/keys';
import { openNotesWindow } from '../src/notes/window';
import { activeConversation, readNotes, readOrder } from '../src/notes/model';
import { fakeChrome } from './helpers/chrome';

const ENABLED = settingKey('notes', 'enabled');
const PAGE = 'chrome-extension://leakzero-test/notes.html';
const SNAP = 'https://www.snapchat.com/web';
const ALICE = '0b1c2d3e-4f50-4617-8293-a4b5c6d7e8f9';
const ALICE_2 = '1b1c2d3e-4f50-4617-8293-a4b5c6d7e8f9';

let storage: ReturnType<typeof fakeChrome>;

function start(initial: Record<string, unknown> = { [ENABLED]: true }) {
  storage = fakeChrome(initial);
  registerNotesBackground(storage.api);
}

/** A command from the Notes page or the popup. */
async function command(message: Record<string, unknown>) {
  storage.setSender({ url: PAGE });
  return storage.api.runtime.sendMessage(message) as Promise<{ ok: boolean; result?: unknown; error?: string }>;
}

/** What the Snapchat content script reports. */
async function detect(id: string, name: string, url = `${SNAP}/${id}`, tabId = 7) {
  storage.setSender({ url, tab: { id: tabId } as chrome.tabs.Tab });
  return storage.api.runtime.sendMessage({ type: 'notes:conversation', conversation: { id, name } }) as Promise<{ ok: boolean; error?: string }>;
}

const notes = () => readNotes(storage.stored);

beforeEach(() => start());
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('conversation detection', () => {
  it('creates an empty note for a newly detected conversation and marks it active', async () => {
    expect(await detect(ALICE, 'Alice')).toMatchObject({ ok: true });
    expect(notes()).toEqual([expect.objectContaining({ conversationId: ALICE, name: 'Alice', html: '', trashedAt: null })]);
    expect(notes()[0].id).not.toBe(ALICE);
    expect(activeConversation(storage.stored)).toMatchObject({ conversationId: ALICE, name: 'Alice' });
  });

  it('does not duplicate a known conversation: keeps its content, follows its new name', async () => {
    await detect(ALICE, 'Alice');
    const [note] = notes();
    await command({ type: 'notes:save', id: note.id, html: '<p>rappel</p>' });
    await detect(ALICE, 'Alice B.');
    expect(notes()).toEqual([expect.objectContaining({ id: note.id, name: 'Alice B.', html: '<p>rappel</p>' })]);
  });

  it('keeps two conversations with the same name apart', async () => {
    await detect(ALICE, 'Alice');
    await detect(ALICE_2, 'Alice');
    expect(notes().map((note) => note.conversationId).sort()).toEqual([ALICE, ALICE_2]);
  });

  it('creates a single note when the same new conversation is reported several times at once', async () => {
    await Promise.all([detect(ALICE, 'Alice'), detect(ALICE, 'Alice'), detect(ALICE, 'Alice')]);
    expect(notes()).toHaveLength(1);
  });

  it('keeps working after a service worker restart, without duplicating', async () => {
    await detect(ALICE, 'Alice');
    const stored = structuredClone(storage.stored);
    start(stored);
    await detect(ALICE, 'Alice');
    expect(notes()).toHaveLength(1);
  });

  it('remembers the last conversation and the tab it came from, durably', async () => {
    await detect(ALICE, 'Alice', `${SNAP}/${ALICE}`, 12);
    expect(storage.stored[NotesKeys.active]).toEqual({ conversationId: ALICE, name: 'Alice', tabId: 12, detectedAt: expect.any(Number) });
    // Service worker restarted: the record is in storage, not in memory.
    start(structuredClone(storage.stored));
    expect(activeConversation(storage.stored)).toMatchObject({ conversationId: ALICE, tabId: 12 });
  });

  it('replaces it only with another valid conversation, from any tab, never by name', async () => {
    await detect(ALICE, 'Alice', `${SNAP}/${ALICE}`, 1);
    await detect(ALICE_2, 'Alice', `${SNAP}/${ALICE_2}`, 2);
    expect(activeConversation(storage.stored)).toMatchObject({ conversationId: ALICE_2, tabId: 2 });
    expect(await detect('pas-un-uuid', 'Bob')).toMatchObject({ ok: false });
    expect(activeConversation(storage.stored)).toMatchObject({ conversationId: ALICE_2 });
    expect(notes().map((note) => note.conversationId).sort()).toEqual([ALICE, ALICE_2]);
  });

  it('ignores detections while the module is disabled', async () => {
    start({ [ENABLED]: false });
    expect(await detect(ALICE, 'Alice')).toMatchObject({ ok: false });
    expect(notes()).toEqual([]);
    expect(storage.stored[NotesKeys.active]).toBeUndefined();
  });

  it('only accepts detections from Snapchat pages, with a Snapchat conversation id', async () => {
    expect(await detect(ALICE, 'Alice', `https://evil.example/web/${ALICE}`)).toMatchObject({ ok: false });
    expect(await detect('alice', 'Alice')).toMatchObject({ ok: false });
    expect(await detect(ALICE, '')).toMatchObject({ ok: false });
    expect(await detect(ALICE, 'x'.repeat(500))).toMatchObject({ ok: false });
    expect(notes()).toEqual([]);
  });

  it('neither restores nor duplicates a trashed conversation detected again', async () => {
    await detect(ALICE, 'Alice');
    const [note] = notes();
    await command({ type: 'notes:trash', id: note.id });
    await detect(ALICE, 'Alice');
    expect(notes()).toEqual([expect.objectContaining({ id: note.id, trashedAt: expect.any(Number) })]);
    expect(activeConversation(storage.stored)).toMatchObject({ conversationId: ALICE });
  });
});

describe('commands', () => {
  it('rejects commands sent by web pages (content scripts)', async () => {
    await detect(ALICE, 'Alice');
    const [note] = notes();
    storage.setSender({ url: `${SNAP}/${ALICE}`, tab: { id: 7 } as chrome.tabs.Tab });
    const response = await storage.api.runtime.sendMessage({ type: 'notes:trash', id: note.id });
    expect(response).toMatchObject({ ok: false });
    expect(notes()[0].trashedAt).toBeNull();
  });

  it('ignores messages that are not Notes commands', async () => {
    storage.setSender({ url: PAGE });
    expect(await storage.api.runtime.sendMessage({ type: 'other' })).toBeUndefined();
  });

  it('rejects malformed commands', async () => {
    expect(await command({ type: 'notes:save', id: 3, html: null })).toMatchObject({ ok: false });
    expect(await command({ type: 'notes:unknown' })).toMatchObject({ ok: false });
  });

  it('saves a note content and its modification date', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(1000);
    await detect(ALICE, 'Alice');
    const [note] = notes();
    vi.setSystemTime(5000);
    expect(await command({ type: 'notes:save', id: note.id, html: '<h2>Sujet</h2>' })).toMatchObject({ ok: true });
    expect(notes()[0]).toMatchObject({ html: '<h2>Sujet</h2>', createdAt: 1000, updatedAt: 5000 });
  });

  it('reports a storage failure instead of pretending the note was saved', async () => {
    await detect(ALICE, 'Alice');
    const [note] = notes();
    storage.failNextSet();
    expect(await command({ type: 'notes:save', id: note.id, html: '<p>a</p>' })).toEqual({ ok: false, error: expect.stringContaining('QUOTA') });
    expect(notes()[0].html).toBe('');
  });

  it('refuses to save a note that does not exist', async () => {
    expect(await command({ type: 'notes:save', id: 'nope', html: '<p>a</p>' })).toMatchObject({ ok: false });
  });

  it('moves notes to the trash, restores them, and deletes them for good only on request', async () => {
    await detect(ALICE, 'Alice');
    const [note] = notes();
    await command({ type: 'notes:trash', id: note.id });
    expect(notes()[0].trashedAt).toEqual(expect.any(Number));
    await command({ type: 'notes:restore', id: note.id });
    expect(notes()[0].trashedAt).toBeNull();
    await command({ type: 'notes:trash', id: note.id });
    await command({ type: 'notes:setOrder', order: [note.id] });
    await command({ type: 'notes:purge', id: note.id });
    expect(notes()).toEqual([]);
    expect(readOrder(storage.stored)).toEqual([]);
  });

  it('only deletes for good a note that is in the trash', async () => {
    await detect(ALICE, 'Alice');
    expect(await command({ type: 'notes:purge', id: notes()[0].id })).toMatchObject({ ok: false });
    expect(notes()).toHaveLength(1);
  });

  it('saves a manual order and goes back to the recent-activity sort', async () => {
    await detect(ALICE, 'Alice');
    await detect(ALICE_2, 'Bob');
    const ids = notes().map((note) => note.id);
    await command({ type: 'notes:setOrder', order: ids });
    expect(readOrder(storage.stored)).toEqual(ids);
    await command({ type: 'notes:setOrder', order: null });
    expect(readOrder(storage.stored)).toBeNull();
  });
});

describe('module lifecycle', () => {
  it('closes the window when the module is disabled, without deleting anything', async () => {
    await detect(ALICE, 'Alice');
    await openNotesWindow(storage.api);
    const before = notes();
    await storage.externalSet({ [ENABLED]: false });
    await vi.waitFor(() => expect(storage.windows.size).toBe(0));
    expect(notes()).toEqual(before);
  });

  it('keeps the module enabled when the window is closed', async () => {
    await openNotesWindow(storage.api);
    storage.closeWindow([...storage.windows.keys()][0]);
    expect(storage.stored[ENABLED]).toBe(true);
    expect(await detect(ALICE, 'Alice')).toMatchObject({ ok: true });
  });
});

describe('import', () => {
  const imported = (id: string, extra: Record<string, unknown> = {}) => ({
    id, conversationId: null, name: id, html: `<p>${id}</p>`, createdAt: 1, updatedAt: 2, lastSeenAt: 3, trashedAt: null, ...extra,
  });

  async function existingAlice() {
    await detect(ALICE, 'Alice');
    await command({ type: 'notes:save', id: notes()[0].id, html: '<p>local</p>' });
    return notes()[0];
  }

  it('adds new notes with their ids and metadata', async () => {
    const note = imported('n1', { conversationId: ALICE, trashedAt: 4 });
    expect(await command({ type: 'notes:import', notes: [note], resolutions: {} })).toEqual({ ok: true, result: { added: 1, replaced: 0, skipped: 0 } });
    expect(notes()).toEqual([note]);
  });

  it('keeps the existing note unless asked otherwise: nothing is overwritten silently', async () => {
    const local = await existingAlice();
    await command({ type: 'notes:import', notes: [imported('n1', { conversationId: ALICE })], resolutions: {} });
    expect(notes()).toEqual([local]);
  });

  it('replaces the existing note, keeping its id and its conversation', async () => {
    const local = await existingAlice();
    const result = await command({ type: 'notes:import', notes: [imported('n1', { conversationId: ALICE, name: 'Alice (archive)' })], resolutions: { n1: 'replace' } });
    expect(result).toMatchObject({ result: { replaced: 1 } });
    expect(notes()).toEqual([expect.objectContaining({ id: local.id, conversationId: ALICE, name: 'Alice (archive)', html: '<p>n1</p>' })]);
  });

  it('keeps both: the copy gets a new id and is not tied to the conversation already followed', async () => {
    const local = await existingAlice();
    await command({ type: 'notes:import', notes: [imported(local.id, { conversationId: ALICE })], resolutions: { [local.id]: 'both' } });
    const [copy] = notes().filter((note) => note.id !== local.id);
    expect(notes()).toHaveLength(2);
    expect(notes().find((note) => note.id === local.id)).toEqual(local);
    expect(copy).toMatchObject({ conversationId: null, html: `<p>${local.id}</p>` });
    await detect(ALICE, 'Alice');
    expect(notes()).toHaveLength(2);
  });

  it('keeps the conversation of a copy whose id only conflicted', async () => {
    const local = await existingAlice();
    await command({ type: 'notes:import', notes: [imported(local.id, { conversationId: ALICE_2 })], resolutions: { [local.id]: 'both' } });
    expect(notes().find((note) => note.id !== local.id)).toMatchObject({ conversationId: ALICE_2 });
  });

  it('writes all or nothing', async () => {
    const local = await existingAlice();
    storage.failNextSet();
    const result = await command({ type: 'notes:import', notes: [imported('n1'), imported('n2', { conversationId: ALICE })], resolutions: { n2: 'replace' } });
    expect(result).toMatchObject({ ok: false });
    expect(notes()).toEqual([local]);
  });

  it('rejects invalid notes before writing anything', async () => {
    expect(await command({ type: 'notes:import', notes: [imported('n1'), { ...imported('n2'), name: '' }], resolutions: {} })).toMatchObject({ ok: false });
    expect(await command({ type: 'notes:import', notes: [imported('n1'), imported('n1')], resolutions: {} })).toMatchObject({ ok: false });
    expect(notes()).toEqual([]);
  });
});
