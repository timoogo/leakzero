import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerNotesBackground } from '../src/notes/background';
import { displayName, NOTES_ENABLED, readNotes } from '../src/notes/model';
import { fakeChrome } from './helpers/chrome';

const TIMY = 'fea2d736-4f50-4617-8293-a4b5c6d7e8f9';
const OTHER = '0b1c2d3e-4f50-4617-8293-a4b5c6d7e8f9';
const PAGE = 'chrome-extension://leakzero-test/notes.html';

let storage: ReturnType<typeof fakeChrome>;
/** Snapchat tabs: id → conversation shown and the name its header shows (null: not shown). */
let tabs: Map<number, { conversationId: string; name: string | null }>;

beforeEach(() => {
  storage = fakeChrome({ [NOTES_ENABLED]: true });
  registerNotesBackground(storage.api);
  tabs = new Map();
  vi.mocked(storage.api.tabs.query).mockImplementation(async (query) => {
    const patterns = ([] as string[]).concat(query?.url ?? []);
    return [...tabs].filter(([, tab]) => patterns.some((pattern) => pattern.includes(tab.conversationId)))
      .map(([id, tab]) => ({ id, url: `https://www.snapchat.com/web/${tab.conversationId}` }) as chrome.tabs.Tab);
  });
  // The Notes content script of each tab answers for the conversation it shows, and only that one.
  vi.mocked(storage.api.tabs.sendMessage).mockImplementation(async (tabId, message) => {
    const tab = tabs.get(tabId);
    if (!tab) throw new Error('Could not establish connection. Receiving end does not exist.');
    const { conversationId } = message as { conversationId: string };
    return { ok: true, name: tab.conversationId === conversationId ? tab.name : null };
  });
});

afterEach(() => vi.unstubAllGlobals());

async function detect(id: string, name: string | null, tabId = 5) {
  storage.setSender({ url: `https://www.snapchat.com/web/${id}`, tab: { id: tabId } as chrome.tabs.Tab });
  await storage.api.runtime.sendMessage({ type: 'notes:conversation', conversation: { id, name } });
}

function refresh(id: string) {
  storage.setSender({ url: PAGE });
  return storage.api.runtime.sendMessage({ type: 'notes:refreshName', id }) as Promise<{ ok: boolean; result?: unknown; error?: string }>;
}

const noteOf = (conversationId: string) => readNotes(storage.stored).find((note) => note.conversationId === conversationId)!;

async function provisionalWithCustomTitle() {
  await detect(TIMY, null);
  storage.setSender({ url: PAGE });
  await storage.api.runtime.sendMessage({ type: 'notes:rename', id: noteOf(TIMY).id, customName: 'Timothée 27 ans' });
  expect(noteOf(TIMY)).toMatchObject({ name: 'Conversation fea2d736', customName: 'Timothée 27 ans' });
}

describe('refreshing the Snapchat name', () => {
  it('reads the name in the Snapchat tab of that conversation, and keeps the custom title', async () => {
    await provisionalWithCustomTitle();
    tabs.set(5, { conversationId: TIMY, name: 'Haehae Timy' });
    expect(await refresh(noteOf(TIMY).id)).toEqual({ ok: true, result: { name: 'Haehae Timy' } });
    expect(noteOf(TIMY)).toMatchObject({ name: 'Haehae Timy', customName: 'Timothée 27 ans', conversationId: TIMY });
    expect(displayName(noteOf(TIMY))).toBe('Timothée 27 ans');
    expect(storage.api.tabs.query).toHaveBeenCalledWith({ url: [`https://www.snapchat.com/web/${TIMY}*`, `https://snapchat.com/web/${TIMY}*`] });
  });

  it('never takes the name of another conversation, even one with the same name', async () => {
    await detect(OTHER, 'Haehae Timy', 6);
    await detect(TIMY, null, 5);
    // A tab whose URL still says TIMY but now shows OTHER (SPA navigation in between).
    tabs.set(5, { conversationId: OTHER, name: 'Haehae Timy' });
    vi.mocked(storage.api.tabs.query).mockResolvedValue([{ id: 5, url: `https://www.snapchat.com/web/${TIMY}` } as chrome.tabs.Tab]);
    expect(await refresh(noteOf(TIMY).id)).toMatchObject({ ok: false });
    expect(noteOf(TIMY).name).toBe('Conversation fea2d736');
    expect(readNotes(storage.stored)).toHaveLength(2);
  });

  it('says so when no Snapchat tab shows the conversation, without changing anything', async () => {
    await provisionalWithCustomTitle();
    const before = structuredClone(storage.stored);
    const response = await refresh(noteOf(TIMY).id);
    expect(response.ok).toBe(false);
    expect(response.error).toContain('Aucun onglet Snapchat Web n’affiche cette conversation');
    expect(storage.stored).toEqual(before);
  });

  it('keeps the last valid name when Snapchat does not show it', async () => {
    await detect(TIMY, 'Haehae Timy');
    tabs.set(5, { conversationId: TIMY, name: null });
    const response = await refresh(noteOf(TIMY).id);
    expect(response).toMatchObject({ ok: false });
    expect(response.error).toContain('le nom actuel est conservé');
    expect(noteOf(TIMY).name).toBe('Haehae Timy');
  });

  it('says so when LeakZero is not running in the Snapchat tab (tab to reload)', async () => {
    await detect(TIMY, null);
    vi.mocked(storage.api.tabs.query).mockResolvedValue([{ id: 99, url: `https://www.snapchat.com/web/${TIMY}` } as chrome.tabs.Tab]);
    const response = await refresh(noteOf(TIMY).id);
    expect(response.error).toContain('Rechargez l’onglet Snapchat');
    expect(noteOf(TIMY).name).toBe('Conversation fea2d736');
  });

  it('is not possible for a note without a conversation, nor from a web page', async () => {
    await detect(TIMY, 'Haehae Timy');
    storage.setSender({ url: `https://www.snapchat.com/web/${TIMY}`, tab: { id: 5 } as chrome.tabs.Tab });
    expect(await storage.api.runtime.sendMessage({ type: 'notes:refreshName', id: noteOf(TIMY).id })).toMatchObject({ ok: false });
    expect(storage.api.tabs.sendMessage).not.toHaveBeenCalled();
  });
});

describe('automatic sync of the Snapchat name', () => {
  it('follows a rename on Snapchat, never goes back to a provisional name, and leaves the custom title alone', async () => {
    await provisionalWithCustomTitle();
    await detect(TIMY, 'Haehae Timy');
    await detect(TIMY, null);
    expect(noteOf(TIMY).name).toBe('Haehae Timy');
    await detect(TIMY, 'Timy');
    expect(noteOf(TIMY)).toMatchObject({ name: 'Timy', customName: 'Timothée 27 ans' });
  });

  it('ignores a name that is only the provisional name', async () => {
    await detect(TIMY, 'Haehae Timy');
    await detect(TIMY, 'Conversation fea2d736');
    expect(noteOf(TIMY).name).toBe('Haehae Timy');
  });
});
