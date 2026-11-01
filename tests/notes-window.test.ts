import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { settingKey } from '../src/shared/keys';
import { NotesKeys } from '../src/notes/keys';
import { closeNotesWindow, openNotesWindow, trackWindowBounds } from '../src/notes/window';
import { fakeChrome } from './helpers/chrome';

const ENABLED = settingKey('notes', 'enabled');
const PAGE = 'chrome-extension://leakzero-test/notes.html';

let storage: ReturnType<typeof fakeChrome>;
beforeEach(() => {
  storage = fakeChrome({ [ENABLED]: true });
});
afterEach(() => vi.unstubAllGlobals());

describe('Notes window', () => {
  it('opens a separate popup window showing the Notes page', async () => {
    await openNotesWindow(storage.api);
    expect(storage.api.windows.create).toHaveBeenCalledTimes(1);
    const [win] = storage.windows.values();
    expect(win).toMatchObject({ url: PAGE, type: 'popup', focused: true });
  });

  it('reuses the open window: focuses it instead of opening another', async () => {
    await openNotesWindow(storage.api);
    const [win] = storage.windows.values();
    win.focused = false;
    await openNotesWindow(storage.api);
    expect(storage.windows.size).toBe(1);
    expect(win.focused).toBe(true);
  });

  it('restores a minimized window, but keeps a maximized one maximized', async () => {
    await openNotesWindow(storage.api);
    const [win] = storage.windows.values();
    win.state = 'minimized';
    await openNotesWindow(storage.api);
    expect(win.state).toBe('normal');
    win.state = 'maximized';
    await openNotesWindow(storage.api);
    expect(win.state).toBe('maximized');
  });

  it('opens a single window when asked several times at once', async () => {
    await Promise.all([openNotesWindow(storage.api), openNotesWindow(storage.api), openNotesWindow(storage.api)]);
    expect(storage.windows.size).toBe(1);
  });

  it('finds the window again after a service worker restart (no state kept in memory)', async () => {
    await openNotesWindow(storage.api);
    vi.resetModules();
    const fresh = await import('../src/notes/window');
    await fresh.openNotesWindow(storage.api);
    expect(storage.windows.size).toBe(1);
  });

  it('opens a new window once the previous one was closed', async () => {
    await openNotesWindow(storage.api);
    storage.closeWindow([...storage.windows.keys()][0]);
    await openNotesWindow(storage.api);
    expect(storage.windows.size).toBe(1);
    expect(storage.api.windows.create).toHaveBeenCalledTimes(2);
  });

  it('reopens at the saved position and size, on any screen', async () => {
    storage.stored[NotesKeys.window] = { left: 2100, top: 40, width: 700, height: 500 };
    await openNotesWindow(storage.api);
    const [win] = storage.windows.values();
    expect(win).toMatchObject({ left: 2100, top: 40, width: 700, height: 500 });
  });

  it('falls back to the default size when the saved bounds are rejected (screen unplugged)', async () => {
    storage.stored[NotesKeys.window] = { left: 99999, top: 99999, width: 700, height: 500 };
    vi.mocked(storage.api.windows.create).mockRejectedValueOnce(new Error('Invalid value for bounds.'));
    await openNotesWindow(storage.api);
    expect(storage.windows.size).toBe(1);
    expect(storage.api.windows.create).toHaveBeenLastCalledWith(expect.not.objectContaining({ left: 99999 }));
  });

  it('ignores invalid saved bounds', async () => {
    storage.stored[NotesKeys.window] = { left: 'x', width: -3 };
    await openNotesWindow(storage.api);
    expect(storage.api.windows.create).toHaveBeenCalledWith(expect.not.objectContaining({ left: 'x' }));
  });

  it('opens the floating window even when Notes is open in a tab, and reuses the window, not the tab', async () => {
    const tab = await storage.api.windows.create({ url: PAGE, type: 'normal' });
    await openNotesWindow(storage.api);
    expect(storage.windows.size).toBe(2);
    const popup = [...storage.windows.values()].find((win) => win.type === 'popup')!;
    popup.focused = false;
    storage.windows.get(tab.id!)!.focused = false;
    await openNotesWindow(storage.api);
    expect(storage.windows.size).toBe(2);
    expect(popup.focused).toBe(true);
    expect(storage.windows.get(tab.id!)!.focused).toBe(false);
  });

  it('closes the window', async () => {
    await openNotesWindow(storage.api);
    await closeNotesWindow(storage.api);
    expect(storage.windows.size).toBe(0);
    await closeNotesWindow(storage.api);
  });
});

describe('window bounds', () => {
  it('saves the position and size when the Notes window is moved or resized, not other windows', async () => {
    const notes = await storage.api.windows.create({ url: PAGE, type: 'popup' });
    const other = await storage.api.windows.create({ url: 'https://example.com' });
    const stop = trackWindowBounds(storage.api, notes.id!);
    storage.moveWindow(other.id!, { left: 1, top: 1, width: 300, height: 300 });
    storage.moveWindow(notes.id!, { left: 1920, top: 10, width: 640, height: 480 });
    await vi.waitFor(() => expect(storage.stored[NotesKeys.window]).toEqual({ left: 1920, top: 10, width: 640, height: 480 }));
    stop();
    storage.moveWindow(notes.id!, { left: 0 });
    await Promise.resolve();
    expect(storage.stored[NotesKeys.window]).toMatchObject({ left: 1920 });
  });

  it('does not save the bounds of a minimized or maximized window', async () => {
    const notes = await storage.api.windows.create({ url: PAGE, type: 'popup' });
    trackWindowBounds(storage.api, notes.id!);
    storage.moveWindow(notes.id!, { state: 'maximized', left: 0, top: 0, width: 3000, height: 2000 });
    storage.moveWindow(notes.id!, { state: 'minimized', left: -32000, top: -32000 });
    await Promise.resolve();
    expect(storage.stored[NotesKeys.window]).toBeUndefined();
  });
});
