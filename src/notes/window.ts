import { NotesKeys } from './keys';

/** The Notes page, shown in the floating window or opened directly in a tab. */
export const NOTES_PAGE = 'notes.html';

export interface WindowBounds {
  left: number;
  top: number;
  width: number;
  height: number;
}

const DEFAULT_SIZE = { width: 900, height: 640 };

function storedBounds(value: unknown): WindowBounds | undefined {
  if (typeof value !== 'object' || !value) return undefined;
  const { left, top, width, height } = value as Record<string, unknown>;
  const valid = [left, top, width, height].every(Number.isInteger) && (width as number) > 0 && (height as number) > 0;
  return valid ? { left, top, width, height } as WindowBounds : undefined;
}

/**
 * The floating window showing the Notes page, looked up from Chrome rather than remembered (whoever
 * opened it may be gone). A Notes page opened in a tab of a normal window is not it.
 */
export async function findNotesWindow(api: typeof chrome): Promise<number | undefined> {
  const contexts = await api.runtime.getContexts({ contextTypes: ['TAB' as chrome.runtime.ContextType], documentUrls: [api.runtime.getURL(NOTES_PAGE)] });
  for (const { windowId } of contexts) {
    if (windowId === api.windows.WINDOW_ID_NONE) continue;
    const win = await api.windows.get(windowId).catch(() => undefined);
    if (win?.type === 'popup') return windowId;
  }
  return undefined;
}

async function focusOrCreate(api: typeof chrome): Promise<void> {
  const existing = await findNotesWindow(api);
  if (existing !== undefined) {
    const win = await api.windows.get(existing);
    await api.windows.update(existing, { focused: true, ...(win.state === 'minimized' && { state: 'normal' }) });
    return;
  }
  const url = api.runtime.getURL(NOTES_PAGE);
  const bounds = storedBounds((await api.storage.local.get(NotesKeys.window))[NotesKeys.window]);
  try {
    await api.windows.create({ url, type: 'popup', focused: true, ...(bounds ?? DEFAULT_SIZE) });
  } catch (error) {
    // Saved bounds on a screen that is no longer connected.
    if (!bounds) throw error;
    await api.windows.create({ url, type: 'popup', focused: true, ...DEFAULT_SIZE });
  }
}

let opening: Promise<void> | undefined;

/**
 * Brings the single Notes window to the front (restoring it if minimized), or opens it. Called by the
 * popup itself: opening needs no service worker.
 */
export function openNotesWindow(api: typeof chrome = chrome): Promise<void> {
  // Two clicks in a row must not open two windows: the second waits for the first.
  opening ??= focusOrCreate(api).finally(() => (opening = undefined));
  return opening;
}

export async function closeNotesWindow(api: typeof chrome = chrome): Promise<void> {
  const id = await findNotesWindow(api);
  if (id !== undefined) await api.windows.remove(id).catch(() => undefined);
}

/** Saves the position and size of window `windowId` whenever the user moves or resizes it. */
export function trackWindowBounds(api: typeof chrome, windowId: number): () => void {
  const onBoundsChanged = (win: chrome.windows.Window) => {
    if (win.id !== windowId || win.state !== 'normal') return;
    const bounds = storedBounds({ left: win.left, top: win.top, width: win.width, height: win.height });
    if (bounds) api.storage.local.set({ [NotesKeys.window]: bounds }).catch((error: unknown) => console.warn('LeakZero: window bounds not saved', error));
  };
  api.windows.onBoundsChanged.addListener(onBoundsChanged);
  return () => api.windows.onBoundsChanged.removeListener(onBoundsChanged);
}
