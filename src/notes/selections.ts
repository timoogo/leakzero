import { selectedMessageSchema, type Message, type SelectedMessage } from './model';

// Messages selected on Snapchat Web, in the IndexedDB of the extension (service worker), not in
// chrome.storage.local (10 MB in all, shared with the notes) nor in Snapchat's own IndexedDB, which the
// page could read. Not encrypted. One record per message, keyed by [conversationId, key]: selections of
// two conversations never mix, and selecting the same message twice keeps a single record.

const DB_NAME = 'leakzero-notes';
const DB_VERSION = 1;
const STORE = 'selectedMessages';
const BY_CONVERSATION = 'conversationId';

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB transaction aborted'));
  });
}

/** `factory` is read when first used: the service worker opens the database on the first selection. */
export function createSelectionStore(factory: () => IDBFactory = () => indexedDB) {
  let db: Promise<IDBDatabase> | undefined;

  function open(): Promise<IDBDatabase> {
    db ??= new Promise<IDBDatabase>((resolve, reject) => {
      const req = factory().open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const store = req.result.createObjectStore(STORE, { keyPath: ['conversationId', 'key'] });
        store.createIndex(BY_CONVERSATION, 'conversationId');
      };
      req.onsuccess = () => {
        const opened = req.result;
        // A newer version of the extension upgrades the database: let it, and reopen next time.
        opened.onversionchange = () => {
          opened.close();
          db = undefined;
        };
        resolve(opened);
      };
      req.onerror = () => reject(req.error);
      req.onblocked = () => reject(new Error('IndexedDB bloquée par une autre version de LeakZero'));
    }).catch((error: unknown) => {
      db = undefined;
      throw error;
    });
    return db;
  }

  async function run<T>(mode: IDBTransactionMode, work: (store: IDBObjectStore) => Promise<T>): Promise<T> {
    const tx = (await open()).transaction(STORE, mode);
    const [result] = await Promise.all([work(tx.objectStore(STORE)), done(tx)]);
    return result;
  }

  return {
    /** Records `message`; an already selected message keeps its first record and selection date. */
    select: (message: Message): Promise<SelectedMessage> =>
      run('readwrite', async (store) => {
        const existing = selectedMessageSchema.safeParse(await request(store.get([message.conversationId, message.key])));
        if (existing.success) return existing.data;
        const record: SelectedMessage = { ...message, media: message.media.map((item) => ({ ...item, spoiler: false })), selectedAt: Date.now() };
        await request(store.put(record));
        return record;
      }),

    /**
     * Hides (or shows again) image `index` of a selected message by default. The record is otherwise
     * kept as it is. Rejects for a message that is not selected or a media that is not an image.
     */
    setSpoiler: (conversationId: string, key: string, index: number, spoiler: boolean): Promise<SelectedMessage> =>
      run('readwrite', async (store) => {
        const existing = selectedMessageSchema.safeParse(await request(store.get([conversationId, key])));
        if (!existing.success) throw new Error('Ce message n’est plus sélectionné.');
        if (existing.data.media[index]?.kind !== 'image') throw new Error('Ce média n’est pas une image.');
        const record: SelectedMessage = {
          ...existing.data,
          media: existing.data.media.map((item, position) => (position === index ? { ...item, spoiler } : item)),
        };
        await request(store.put(record));
        return record;
      }),

    unselect: (conversationId: string, key: string): Promise<void> =>
      run('readwrite', async (store) => {
        await request(store.delete([conversationId, key]));
      }),

    /** Selected messages of one conversation, oldest selection first; corrupt records are skipped. */
    list: (conversationId: string): Promise<SelectedMessage[]> =>
      run('readonly', async (store) => {
        const records = await request(store.index(BY_CONVERSATION).getAll(conversationId));
        return records
          .flatMap((record) => {
            const parsed = selectedMessageSchema.safeParse(record);
            return parsed.success ? [parsed.data] : [];
          })
          .sort((a, b) => a.selectedAt - b.selectedAt);
      }),

    /** Closes the connection (tests: what a browser restart does). */
    async close(): Promise<void> {
      const opened = await db?.catch(() => undefined);
      opened?.close();
      db = undefined;
    },
  };
}

export type SelectionStore = ReturnType<typeof createSelectionStore>;
