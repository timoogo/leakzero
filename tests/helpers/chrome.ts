import { vi } from 'vitest';

type Listener = (changes: Record<string, chrome.storage.StorageChange>, area: string) => void;

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
  };
  const runtime: Record<string, unknown> = {
    id: 'leakzero-test',
    OnInstalledReason: { INSTALL: 'install', UPDATE: 'update', CHROME_UPDATE: 'chrome_update' },
    getManifest: () => ({ content_scripts: [{ js: ['src/content/index.js'] }] }),
  };
  const chromeStub = {
    runtime,
    tabs: { query: vi.fn(async () => [] as { id?: number }[]) },
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
    /** A write from another context (another popup, the service worker). */
    async externalSet(items: Record<string, unknown>) {
      await local.set(items);
    },
  };
}
