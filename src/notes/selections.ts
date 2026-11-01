import { selectedMessageSchema, type Message, type SelectedMessage } from './model';
import { sniffVideo, type CapturedVideo } from './video';

// Messages selected on Snapchat Web, in the IndexedDB of the extension (service worker), not in
// chrome.storage.local (10 MB in all, shared with the notes) nor in Snapchat's own IndexedDB, which the
// page could read. Not encrypted. One record per message, keyed by [conversationId, key]: selections of
// two conversations never mix, and selecting the same message twice keeps a single record.
//
// Videos of selected messages (video.ts), since version 2: the original file once per content (`videos`,
// keyed by its SHA-256, bytes kept as an ArrayBuffer, never re-encoded), and which video of which message
// it is (`videoRefs`, keyed by [conversationId, key, media index]). A file is deleted with its last reference.

const DB_NAME = 'leakzero-notes';
const DB_VERSION = 2;
const STORE = 'selectedMessages';
const BY_CONVERSATION = 'conversationId';
const VIDEOS = 'videos';
const VIDEO_REFS = 'videoRefs';
const BY_HASH = 'sha256';
const BY_MESSAGE = 'message';

/** One stored video file. */
export interface StoredVideo {
  sha256: string;
  bytes: ArrayBuffer;
  mime: string;
  size: number;
  storedAt: number;
}

/** Video `media` of the selected message `key`, and what the player knew of it when captured. */
export interface VideoRef {
  conversationId: string;
  key: string;
  media: number;
  sha256: string;
  width: number | null;
  height: number | null;
  duration: number | null;
  capturedAt: number;
}

export class VideoStoreError extends Error {
  override name = 'VideoStoreError';
}

const isQuota = (error: unknown) => error instanceof DOMException && error.name === 'QuotaExceededError'
  || (error as { name?: unknown } | null)?.name === 'QuotaExceededError';

async function sha256(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return [...digest].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

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
      req.onupgradeneeded = (event) => {
        // Each version adds its stores; the records of the previous ones are kept as they are.
        if (event.oldVersion < 1) {
          const store = req.result.createObjectStore(STORE, { keyPath: ['conversationId', 'key'] });
          store.createIndex(BY_CONVERSATION, 'conversationId');
        }
        if (event.oldVersion < 2) {
          req.result.createObjectStore(VIDEOS, { keyPath: 'sha256' });
          const refs = req.result.createObjectStore(VIDEO_REFS, { keyPath: ['conversationId', 'key', 'media'] });
          refs.createIndex(BY_HASH, 'sha256');
          refs.createIndex(BY_MESSAGE, ['conversationId', 'key']);
        }
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

  /** Runs `work` in one transaction over `stores`: all its writes are kept, or none if it fails. */
  async function transaction<T>(stores: string[], mode: IDBTransactionMode, work: (tx: IDBTransaction) => Promise<T>): Promise<T> {
    const tx = (await open()).transaction(stores, mode);
    const [result] = await Promise.all([
      work(tx).catch((error: unknown) => {
        try {
          tx.abort();
        } catch {
          // Already finished or aborted.
        }
        throw error;
      }),
      done(tx),
    ]);
    return result;
  }

  const run = <T>(mode: IDBTransactionMode, work: (store: IDBObjectStore) => Promise<T>) =>
    transaction([STORE], mode, (tx) => work(tx.objectStore(STORE)));

  /** References of every video of message `key`, by media index. */
  const refsOf = async (tx: IDBTransaction, conversationId: string, key: string) =>
    ((await request(tx.objectStore(VIDEO_REFS).index(BY_MESSAGE).getAll([conversationId, key]))) as VideoRef[]).sort((a, b) => a.media - b.media);

  /** Deletes the file `hash` if no reference is left to it. */
  async function collect(tx: IDBTransaction, hash: string): Promise<void> {
    if ((await request(tx.objectStore(VIDEO_REFS).index(BY_HASH).count(hash))) === 0) await request(tx.objectStore(VIDEOS).delete(hash));
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

    /** Unselects a message, with its videos: a file still used by another message is kept. */
    unselect: (conversationId: string, key: string): Promise<void> =>
      transaction([STORE, VIDEOS, VIDEO_REFS], 'readwrite', async (tx) => {
        await request(tx.objectStore(STORE).delete([conversationId, key]));
        const refs = await refsOf(tx, conversationId, key);
        for (const ref of refs) await request(tx.objectStore(VIDEO_REFS).delete([conversationId, key, ref.media]));
        for (const hash of new Set(refs.map((ref) => ref.sha256))) await collect(tx, hash);
      }),

    /**
     * Stores the original file of video `media` of the selected message `key`. The same file is stored
     * once, whatever the number of messages or selections it comes from; the reference of a video
     * captured again is kept as it is. Rejects, writing nothing, for a message no longer selected, a
     * media that is not a video, bytes that are not one, or a full disk.
     */
    async storeVideo(conversationId: string, key: string, media: number, bytes: Uint8Array<ArrayBuffer>, video: Omit<CapturedVideo, 'data' | 'size'>): Promise<{ sha256: string; stored: boolean }> {
      if (!sniffVideo(bytes)) throw new VideoStoreError('Ce fichier n’est pas une vidéo.');
      // Hashed before the transaction: an IndexedDB transaction does not outlive an unrelated await.
      const hash = await sha256(bytes);
      try {
        return await transaction([STORE, VIDEOS, VIDEO_REFS], 'readwrite', async (tx) => {
          const message = selectedMessageSchema.safeParse(await request(tx.objectStore(STORE).get([conversationId, key])));
          if (!message.success) throw new VideoStoreError('Ce message n’est plus sélectionné.');
          if (message.data.media[media]?.kind !== 'video') throw new VideoStoreError('Ce média n’est pas une vidéo.');
          const refs = tx.objectStore(VIDEO_REFS);
          const previous = (await request(refs.get([conversationId, key, media]))) as VideoRef | undefined;
          const files = tx.objectStore(VIDEOS);
          const stored = (await request(files.count(hash))) === 0;
          if (stored) {
            // A copy of exactly the bytes read, detached from the caller's buffer.
            const file: StoredVideo = { sha256: hash, bytes: bytes.slice().buffer, mime: video.mime, size: bytes.length, storedAt: Date.now() };
            await request(files.put(file));
          }
          if (previous?.sha256 !== hash) {
            const ref: VideoRef = {
              conversationId, key, media, sha256: hash, width: video.width, height: video.height, duration: video.duration, capturedAt: Date.now(),
            };
            await request(refs.put(ref));
            if (previous) await collect(tx, previous.sha256);
          }
          return { sha256: hash, stored };
        });
      } catch (error) {
        if (isQuota(error)) throw new VideoStoreError('Espace de stockage insuffisant pour enregistrer cette vidéo.');
        throw error;
      }
    },

    /** The stored videos of message `key`, by media index, with their files. */
    videos: (conversationId: string, key: string): Promise<(VideoRef & { file: StoredVideo })[]> =>
      transaction([VIDEOS, VIDEO_REFS], 'readonly', async (tx) => {
        const refs = await refsOf(tx, conversationId, key);
        const files = await Promise.all(refs.map((ref) => request(tx.objectStore(VIDEOS).get(ref.sha256)) as Promise<StoredVideo | undefined>));
        return refs.flatMap((ref, index) => (files[index] ? [{ ...ref, file: files[index] }] : []));
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
