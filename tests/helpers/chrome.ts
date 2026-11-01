import { vi } from 'vitest';

type Listener = (changes: Record<string, chrome.storage.StorageChange>, area: string) => void;
type MessageListener = (message: unknown, sender: chrome.runtime.MessageSender, sendResponse: (response?: unknown) => void) => boolean | void;
type FakeWindow = chrome.windows.Window & { id: number; url: string };

function fakeEvent<L extends (...args: never[]) => unknown>() {
  const listeners = new Set<L>();
  return {
    listeners,
    addListener: (listener: L) => listeners.add(listener),
    removeListener: (listener: L) => listeners.delete(listener),
    emit: (...args: Parameters<L>) => { for (const listener of listeners) listener(...args); },
  };
}

/**
 * In-memory chrome.storage.local with onChanged events, installed as the `chrome` global.
 * `set` notifies listeners before resolving, like Chrome; `failNextSet` makes the next `set` reject
 * without writing anything. Each call creates a separate extension context (`api`).
 */
export function fakeChrome(initial: Record<string, unknown> = {}) {
  const stored: Record<string, unknown> = structuredClone(initial);
  const listeners = new Set<Listener>();
  let failure: Error | undefined;
  let invalidated = false;
  const assertValid = () => {
    if (invalidated) throw new Error('Extension context invalidated.');
  };
  const pick = (keys: string | string[] | null | undefined) => {
    if (keys === null || keys === undefined) return structuredClone(stored);
    const list = typeof keys === 'string' ? [keys] : keys;
    return Object.fromEntries(list.filter((key) => key in stored).map((key) => [key, structuredClone(stored[key])]));
  };
  const local = {
    get: vi.fn(async (keys?: string | string[] | null) => {
      assertValid();
      return pick(keys);
    }),
    set: vi.fn(async (items: Record<string, unknown>) => {
      assertValid();
      if (failure) {
        const error = failure;
        failure = undefined;
        throw error;
      }
      const changes: Record<string, chrome.storage.StorageChange> = {};
      for (const [key, value] of Object.entries(items)) {
        changes[key] = { oldValue: stored[key], newValue: structuredClone(value) };
        stored[key] = structuredClone(value);
      }
      for (const listener of listeners) listener(structuredClone(changes), 'local');
    }),
    remove: vi.fn(async (keys: string | string[]) => {
      assertValid();
      const changes: Record<string, chrome.storage.StorageChange> = {};
      for (const key of typeof keys === 'string' ? [keys] : keys) {
        if (!(key in stored)) continue;
        changes[key] = { oldValue: stored[key] };
        delete stored[key];
      }
      if (Object.keys(changes).length > 0) for (const listener of listeners) listener(structuredClone(changes), 'local');
    }),
  };
  // runtime messaging: every listener of every context, as in Chrome. Rejects without a receiver.
  const onMessage = fakeEvent<MessageListener>();
  const self: { sender: chrome.runtime.MessageSender; senderFor?: (message: unknown) => chrome.runtime.MessageSender | undefined } = {
    sender: { id: 'leakzero-test' },
  };
  const sendMessage = vi.fn((message: unknown) => {
    try {
      assertValid();
    } catch (error) {
      return Promise.reject(error);
    }
    return new Promise((resolve, reject) => {
      const sender = structuredClone({ ...(self.senderFor?.(message) ?? self.sender), id: 'leakzero-test' });
      let async = false;
      let answered = false;
      const sendResponse = (response?: unknown) => {
        if (answered) return;
        answered = true;
        resolve(structuredClone(response));
      };
      for (const listener of onMessage.listeners) if (listener(structuredClone(message), sender, sendResponse) === true) async = true;
      if (onMessage.listeners.size === 0) reject(new Error('Could not establish connection. Receiving end does not exist.'));
      else if (!async && !answered) resolve(undefined);
    });
  });
  const runtime: Record<string, unknown> = {
    id: 'leakzero-test',
    OnInstalledReason: { INSTALL: 'install', UPDATE: 'update', CHROME_UPDATE: 'chrome_update' },
    getManifest: () => ({ content_scripts: [{ js: ['src/content/index.js'] }] }),
    getURL: (path: string) => `chrome-extension://leakzero-test/${path.replace(/^\//, '')}`,
    getContexts: vi.fn(async ({ documentUrls }: chrome.runtime.ContextFilter) =>
      [...windows.values()]
        .filter((win) => !documentUrls || documentUrls.includes(win.url))
        .map((win) => ({ contextType: 'TAB', documentUrl: win.url, windowId: win.id, tabId: win.id * 10 }))),
    sendMessage,
    onMessage,
  };

  // chrome.windows: windows opened by the extension, each showing one page.
  const windows = new Map<number, FakeWindow>();
  let nextWindowId = 1;
  const onBoundsChanged = fakeEvent<(window: chrome.windows.Window) => void>();
  const onRemoved = fakeEvent<(windowId: number) => void>();
  const findWindow = (id: number) => {
    const win = windows.get(id);
    if (!win) throw new Error(`No window with id: ${id}.`);
    return win;
  };
  const windowsApi = {
    WINDOW_ID_NONE: -1,
    create: vi.fn(async (data: chrome.windows.CreateData = {}) => {
      const win: FakeWindow = {
        id: nextWindowId++,
        url: String(data.url),
        type: data.type ?? 'normal',
        state: 'normal',
        focused: data.focused ?? true,
        left: data.left ?? 0,
        top: data.top ?? 0,
        width: data.width ?? 800,
        height: data.height ?? 600,
        alwaysOnTop: false,
        incognito: false,
      };
      windows.set(win.id, win);
      return structuredClone(win);
    }),
    update: vi.fn(async (id: number, info: chrome.windows.UpdateInfo) => {
      const win = findWindow(id);
      Object.assign(win, info);
      return structuredClone(win);
    }),
    get: vi.fn(async (id: number) => structuredClone(findWindow(id))),
    /** The window of the calling page: the last one opened, in these tests. */
    getCurrent: vi.fn(async () => structuredClone(findWindow(Math.max(...windows.keys())))),
    remove: vi.fn(async (id: number) => {
      findWindow(id);
      windows.delete(id);
      onRemoved.emit(id);
    }),
    onBoundsChanged,
    onRemoved,
  };

  const chromeStub = {
    runtime,
    windows: windowsApi,
    tabs: {
      query: vi.fn(async (_query?: chrome.tabs.QueryInfo) => [] as { id?: number; url?: string }[]),
      sendMessage: vi.fn(async (_tabId: number, _message: unknown): Promise<unknown> => { throw new Error('Could not establish connection. Receiving end does not exist.'); }),
    },
    scripting: { executeScript: vi.fn(async () => []) },
    storage: {
      local,
      onChanged: {
        addListener: (listener: Listener) => listeners.add(listener),
        removeListener: (listener: Listener) => listeners.delete(listener),
      },
    },
  };
  vi.stubGlobal('chrome', chromeStub);
  return {
    stored,
    local,
    api: chromeStub as unknown as typeof chrome,
    /**
     * What Chrome does to the scripts of an extension that was reloaded, updated or removed: they keep
     * running, but `runtime.id` disappears, storage calls throw and no change event arrives anymore.
     */
    invalidate() {
      invalidated = true;
      listeners.clear();
      delete runtime.id;
    },
    failNextSet(error = new Error('QUOTA_BYTES quota exceeded')) {
      failure = error;
    },
    /** Who `runtime.sendMessage` reports as the sender (an extension page by default). */
    setSender(sender: chrome.runtime.MessageSender) {
      self.sender = { id: 'leakzero-test', ...sender };
    },
    /** Who sent each message, when several contexts talk at once (the Notes page and a Snapchat tab). */
    setSenderFor(senderFor: (message: unknown) => chrome.runtime.MessageSender | undefined) {
      self.senderFor = senderFor;
    },
    windows,
    /** The user moves or resizes a window. */
    moveWindow(id: number, bounds: Partial<chrome.windows.Window>) {
      const win = findWindow(id);
      Object.assign(win, bounds);
      onBoundsChanged.emit(structuredClone(win));
    },
    /** The user closes a window. */
    closeWindow(id: number) {
      windows.delete(id);
      onRemoved.emit(id);
    },
    /** A write from another context (another popup, the service worker). */
    async externalSet(items: Record<string, unknown>) {
      await local.set(items);
    },
  };
}
