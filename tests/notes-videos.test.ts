// @vitest-environment jsdom
// @vitest-environment-options {"url": "https://www.snapchat.com/web"}
import { IDBFactory, IDBObjectStore as FakeObjectStore } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerNotesBackground } from '../src/notes/background';
import { NotesKeys } from '../src/notes/keys';
import { NOTES_ENABLED, type Message } from '../src/notes/model';
import { readMessages, SELECTABLE_ATTRIBUTE, startMessageSelection } from '../src/notes/selection';
import { createSelectionStore, type SelectionStore } from '../src/notes/selections';
import { captureVideo, MAX_VIDEO_BYTES, sniffVideo, toBase64, videoSource, type VideoSource } from '../src/notes/video';
import { fakeChrome } from './helpers/chrome';

// Original files of the videos of selected messages: read from the page's own `blob:` URL by the
// Snapchat content script, sent to the service worker, stored once per content in IndexedDB.

const ALICE = '0b1c2d3e-4f50-4617-8293-a4b5c6d7e8f9';
const BOB = '2c1c2d3e-4f50-4617-8293-a4b5c6d7e8f9';
const BLOB_URL = 'blob:https://www.snapchat.com/097e956e-7f9e-4400-af80-071faf040c63';
const OTHER_BLOB_URL = 'blob:https://www.snapchat.com/1b2c3d4e-0000-4000-8000-000000000000';

/** The start of an MP4 file (`ftyp` box, brand `isom`), then `extra` bytes standing for the rest. */
function mp4(extra: number[] = [1, 2, 3]): Uint8Array<ArrayBuffer> {
  const ftyp = [0, 0, 0, 0x18, ...'ftypisom'].map((c) => (typeof c === 'string' ? c.charCodeAt(0) : c));
  return new Uint8Array([...ftyp, 0, 0, 2, 0, ...[...'isomiso2'].map((c) => c.charCodeAt(0)), ...extra]);
}
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const source = (url = BLOB_URL): VideoSource => ({ url, width: null, height: null, duration: null });
const blob = (bytes: Uint8Array<ArrayBuffer>, type = 'video/mp4') => new Blob([bytes], { type });
const meta = { mime: 'video/mp4', width: null, height: null, duration: null };

function message(conversationId: string, key: string, kinds: ('image' | 'video')[] = ['video']): Message {
  return {
    conversationId, key, text: '', author: null, sentAt: null, timeLabel: null,
    type: kinds.every((kind) => kind === 'video') ? 'video' : 'media',
    media: kinds.map((kind) => ({ kind, alt: null, preview: null })), links: [],
  };
}

let factory: IDBFactory;
let selections: SelectionStore;

beforeEach(() => {
  factory = new IDBFactory();
  selections = createSelectionStore(() => factory);
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  await selections.close();
});

describe('what is a video', () => {
  it('recognises MP4, QuickTime and WebM by their bytes, not by what they claim', () => {
    expect(sniffVideo(mp4())).toBe('video/mp4');
    const qt = mp4();
    qt.set([...'qt  '].map((c) => c.charCodeAt(0)), 8);
    expect(sniffVideo(qt)).toBe('video/quicktime');
    expect(sniffVideo(new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0x9f]))).toBe('video/webm');
  });

  it('refuses images, HEIC/AVIF included (same `ftyp` box), and truncated files', () => {
    expect(sniffVideo(PNG)).toBeNull();
    const heic = mp4();
    heic.set([...'heic'].map((c) => c.charCodeAt(0)), 8);
    expect(sniffVideo(heic)).toBeNull();
    expect(sniffVideo(new Uint8Array([0, 0, 0, 0x18, 0x66]))).toBeNull();
  });
});

describe('video source of a <video>', () => {
  const video = (src: string) => Object.assign(document.createElement('video'), { src });

  it('is the blob: URL of the page that its player holds', () => {
    expect(videoSource(video(BLOB_URL))).toEqual(source());
    const element = document.createElement('video');
    element.append(Object.assign(document.createElement('source'), { src: BLOB_URL }));
    expect(videoSource(element)?.url).toBe(BLOB_URL);
  });

  it('is none for a remote URL, or a blob: URL of another origin', () => {
    expect(videoSource(video('https://cf-st.sc-cdn.net/d/video.mp4'))).toBeNull();
    expect(videoSource(video('blob:https://evil.example/097e956e-7f9e-4400-af80-071faf040c63'))).toBeNull();
    expect(videoSource(document.createElement('video'))).toBeNull();
  });
});

describe('capture of a video, in the content script', () => {
  it('reads a valid MP4 unchanged, with its type and size', async () => {
    const bytes = mp4([9, 8, 7, 6]);
    const read = vi.fn(async () => blob(bytes, 'video/mp4; codecs="hvc1"'));
    const video = await captureVideo({ ...source(), width: 720, height: 1280, duration: 14.86 }, read);
    expect(read).toHaveBeenCalledWith(BLOB_URL);
    expect(video).toEqual({ mime: 'video/mp4; codecs="hvc1"', size: bytes.length, data: toBase64(bytes), width: 720, height: 1280, duration: 14.86 });
  });

  it('takes the type from the bytes when the Blob has none', async () => {
    expect((await captureVideo(source(), async () => blob(mp4(), ''))).mime).toBe('video/mp4');
  });

  it('refuses a Blob that is not a video, whatever its type says', async () => {
    await expect(captureVideo(source(), async () => blob(PNG, 'image/png'))).rejects.toThrow('pas une vidéo');
    await expect(captureVideo(source(), async () => blob(PNG, 'video/mp4'))).rejects.toThrow('pas une vidéo');
    await expect(captureVideo(source(), async () => blob(new Uint8Array(), 'video/mp4'))).rejects.toThrow('vide');
  });

  it('reports an expired or unreadable blob: URL, without its address', async () => {
    const error = await captureVideo(source(), async () => { throw new TypeError('Failed to fetch'); }).then(() => new Error('captured'), (e: unknown) => e as Error);
    expect(error.message).toMatch('expiré');
    expect(error.message).not.toContain(BLOB_URL);
  });

  it('reports a Blob whose bytes cannot be read', async () => {
    const broken = blob(mp4());
    vi.spyOn(broken, 'arrayBuffer').mockRejectedValue(new DOMException('gone', 'NotReadableError'));
    await expect(captureVideo(source(), async () => broken)).rejects.toThrow('lecture de la vidéo impossible');
  });

  it('refuses a video larger than the limit before reading it', async () => {
    const big = blob(mp4());
    Object.defineProperty(big, 'size', { value: MAX_VIDEO_BYTES + 1 });
    const arrayBuffer = vi.spyOn(big, 'arrayBuffer');
    await expect(captureVideo(source(), async () => big)).rejects.toThrow('trop volumineuse');
    expect(arrayBuffer).not.toHaveBeenCalled();
  });

  it('never requests a remote URL', async () => {
    const read = vi.fn(async () => blob(mp4()));
    await expect(captureVideo(source('https://cf-st.sc-cdn.net/d/video.mp4'), read)).rejects.toThrow('distante');
    expect(read).not.toHaveBeenCalled();
  });
});

describe('stored videos, in IndexedDB', () => {
  it('keeps the original bytes as binary, with their type and size, for that message', async () => {
    await selections.select(message(ALICE, 'v:0', ['image', 'video']));
    const bytes = mp4([4, 5, 6]);
    expect(await selections.storeVideo(ALICE, 'v:0', 1, bytes, { ...meta, width: 720, height: 1280, duration: 14.86 })).toMatchObject({ stored: true });
    const [video] = await selections.videos(ALICE, 'v:0');
    expect(video).toMatchObject({ conversationId: ALICE, key: 'v:0', media: 1, width: 720, height: 1280, duration: 14.86 });
    expect(video.file).toMatchObject({ sha256: video.sha256, mime: 'video/mp4', size: bytes.length });
    // Binary, not base64 (jsdom and Node have their own ArrayBuffer: compared by tag).
    expect(Object.prototype.toString.call(video.file.bytes)).toBe('[object ArrayBuffer]');
    expect(new Uint8Array(video.file.bytes)).toEqual(bytes);
    // Another conversation, or another message, has none.
    expect(await selections.videos(BOB, 'v:0')).toEqual([]);
    expect(await selections.videos(ALICE, 'v:1')).toEqual([]);
  });

  it('stores a video captured again, or shared by two messages, only once', async () => {
    await selections.select(message(ALICE, 'v:0'));
    await selections.select(message(BOB, 'w:0'));
    expect(await selections.storeVideo(ALICE, 'v:0', 0, mp4(), meta)).toMatchObject({ stored: true });
    expect(await selections.storeVideo(ALICE, 'v:0', 0, mp4(), meta)).toMatchObject({ stored: false });
    await selections.select(message(ALICE, 'v:0'));
    expect(await selections.storeVideo(ALICE, 'v:0', 0, mp4(), meta)).toMatchObject({ stored: false });
    expect(await selections.storeVideo(BOB, 'w:0', 0, mp4(), meta)).toMatchObject({ stored: false });
    expect(await selections.videos(ALICE, 'v:0')).toHaveLength(1);
    expect(await countFiles()).toBe(1);
  });

  it('deletes a video with its message, but keeps a file another message still uses', async () => {
    await selections.select(message(ALICE, 'v:0'));
    await selections.select(message(ALICE, 'v:1'));
    await selections.storeVideo(ALICE, 'v:0', 0, mp4(), meta);
    await selections.storeVideo(ALICE, 'v:1', 0, mp4(), meta);
    await selections.unselect(ALICE, 'v:0');
    expect(await selections.videos(ALICE, 'v:0')).toEqual([]);
    expect(await selections.videos(ALICE, 'v:1')).toHaveLength(1);
    expect(await countFiles()).toBe(1);
    await selections.unselect(ALICE, 'v:1');
    expect(await countFiles()).toBe(0);
    expect(await selections.list(ALICE)).toEqual([]);
  });

  it('replaces the file of a video captured with other bytes, and deletes the old one', async () => {
    await selections.select(message(ALICE, 'v:0'));
    await selections.storeVideo(ALICE, 'v:0', 0, mp4([1]), meta);
    await selections.storeVideo(ALICE, 'v:0', 0, mp4([2]), meta);
    const [video] = await selections.videos(ALICE, 'v:0');
    expect(new Uint8Array(video.file.bytes)).toEqual(mp4([2]));
    expect(await countFiles()).toBe(1);
  });

  it('refuses a message no longer selected, a media that is not a video, or bytes that are not one', async () => {
    await selections.select(message(ALICE, 'm:0', ['image', 'video']));
    await expect(selections.storeVideo(ALICE, 'x:0', 0, mp4(), meta)).rejects.toThrow('plus sélectionné');
    await expect(selections.storeVideo(ALICE, 'm:0', 0, mp4(), meta)).rejects.toThrow('pas une vidéo');
    await expect(selections.storeVideo(ALICE, 'm:0', 1, PNG, meta)).rejects.toThrow('pas une vidéo');
    expect(await countFiles()).toBe(0);
  });

  it('reports a full disk, and writes nothing', async () => {
    await selections.select(message(ALICE, 'v:0'));
    const put = FakeObjectStore.prototype.put;
    vi.spyOn(FakeObjectStore.prototype, 'put').mockImplementation(function (this: IDBObjectStore, ...args: Parameters<typeof put>) {
      if (this.name === 'videos') throw new DOMException('Quota exceeded', 'QuotaExceededError');
      return put.apply(this, args);
    });
    await expect(selections.storeVideo(ALICE, 'v:0', 0, mp4(), meta)).rejects.toThrow('Espace de stockage insuffisant');
    vi.restoreAllMocks();
    expect(await selections.videos(ALICE, 'v:0')).toEqual([]);
    expect(await countFiles()).toBe(0);
    // The selection itself is intact.
    expect(await selections.list(ALICE)).toHaveLength(1);
  });

  it('reports a database that cannot be opened', async () => {
    const broken = createSelectionStore(() => { throw new DOMException('denied', 'UnknownError'); });
    await expect(broken.storeVideo(ALICE, 'v:0', 0, mp4(), meta)).rejects.toThrow('denied');
  });

  it('upgrades a database of the previous version, keeping its selections', async () => {
    await new Promise<void>((resolve, reject) => {
      const open = factory.open('leakzero-notes', 1);
      open.onupgradeneeded = () => open.result.createObjectStore('selectedMessages', { keyPath: ['conversationId', 'key'] }).createIndex('conversationId', 'conversationId');
      open.onsuccess = () => {
        const tx = open.result.transaction('selectedMessages', 'readwrite');
        tx.objectStore('selectedMessages').put({ ...message(ALICE, 'v:0'), selectedAt: 5 });
        tx.oncomplete = () => { open.result.close(); resolve(); };
        tx.onerror = () => reject(tx.error);
      };
    });
    expect(await selections.list(ALICE)).toEqual([expect.objectContaining({ key: 'v:0', selectedAt: 5 })]);
    await selections.storeVideo(ALICE, 'v:0', 0, mp4(), meta);
    expect(await selections.videos(ALICE, 'v:0')).toHaveLength(1);
  });

  async function countFiles(): Promise<number> {
    await selections.close();
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const open = factory.open('leakzero-notes');
      open.onsuccess = () => resolve(open.result);
      open.onerror = () => reject(open.error);
    });
    const count = await new Promise<number>((resolve, reject) => {
      const req = db.transaction('videos').objectStore('videos').count();
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    db.close();
    return count;
  }
});

describe('from the Snapchat tab to the service worker', () => {
  let storage: ReturnType<typeof fakeChrome>;
  const video = (data = toBase64(mp4()), size = mp4().length) => ({ mime: 'video/mp4', size, data, width: null, height: null, duration: null });
  const store = (conversationId: string, extra: Record<string, unknown> = {}) => storage.api.runtime.sendMessage({
    type: 'notes:storeVideo', conversationId, key: 'v:0', media: 0, video: video(), ...extra,
  }) as Promise<{ ok: boolean; result?: unknown; error?: string }>;
  const fromTab = (id: string) => storage.setSender({ url: `https://www.snapchat.com/web/${id}`, tab: { id: 3 } as chrome.tabs.Tab });

  beforeEach(async () => {
    storage = fakeChrome({ [NOTES_ENABLED]: true });
    registerNotesBackground(storage.api, selections);
    await selections.select(message(ALICE, 'v:0'));
    await selections.select(message(BOB, 'v:0'));
  });

  it('stores the video sent by the tab of its conversation', async () => {
    fromTab(ALICE);
    expect(await store(ALICE)).toMatchObject({ ok: true, result: { stored: true } });
    expect(new Uint8Array((await selections.videos(ALICE, 'v:0'))[0].file.bytes)).toEqual(mp4());
  });

  it('refuses it from another conversation’s tab, another site, or the extension’s pages', async () => {
    fromTab(BOB);
    expect(await store(ALICE)).toMatchObject({ ok: false, error: expect.stringContaining('n’affiche pas') });
    storage.setSender({ url: `https://evil.example/web/${ALICE}`, tab: { id: 4 } as chrome.tabs.Tab });
    expect(await store(ALICE)).toMatchObject({ ok: false });
    storage.setSender({ url: 'chrome-extension://leakzero-test/notes.html' });
    expect(await store(ALICE)).toMatchObject({ ok: false });
    expect(await selections.videos(ALICE, 'v:0')).toEqual([]);
  });

  it('checks the bytes again: size, encoding, content, limit', async () => {
    fromTab(ALICE);
    expect(await store(ALICE, { video: video(toBase64(mp4()), 3) })).toMatchObject({ ok: false, error: 'Vidéo incomplète.' });
    expect(await store(ALICE, { video: video('pas du base64 !', 10) })).toMatchObject({ ok: false });
    expect(await store(ALICE, { video: video(toBase64(PNG), PNG.length) })).toMatchObject({ ok: false, error: expect.stringContaining('pas une vidéo') });
    expect(await store(ALICE, { video: { ...video(), mime: 'image/png' } })).toMatchObject({ ok: false });
    expect(await store(ALICE, { video: video(toBase64(mp4()), MAX_VIDEO_BYTES + 1) })).toMatchObject({ ok: false, error: 'Commande invalide.' });
    expect(await store(ALICE, { media: 50 })).toMatchObject({ ok: false });
    expect(await selections.videos(ALICE, 'v:0')).toEqual([]);
  });

  it('refuses it while the module is disabled', async () => {
    await storage.api.storage.local.set({ [NOTES_ENABLED]: false });
    fromTab(ALICE);
    expect(await store(ALICE)).toMatchObject({ ok: false, error: expect.stringContaining('désactivé') });
  });
});

describe('selecting a video message on Snapchat Web', () => {
  let storage: ReturnType<typeof fakeChrome>;
  let session: ReturnType<typeof startMessageSelection> | undefined;
  let fetch: ReturnType<typeof vi.fn>;
  /** What each blob: URL of the page holds; a missing one was revoked. */
  let blobs: Map<string, Blob>;

  function openConversation(videos: string) {
    history.pushState({}, '', `/web/${ALICE}`);
    document.body.innerHTML = `
      <div>
        <div><span>Alice</span><button type="button" title="Close Chat"><svg></svg></button></div>
        <ul>
          <li>
            <header><span>Alice</span></header>
            <ul>
              <li data-m="hello"><span>Salut</span></li>
              <li data-m="photo"><img src="https://cf-st.sc-cdn.net/d/photo.jpg" alt="Photo"></li>
              ${videos}
            </ul>
          </li>
        </ul>
      </div>`;
  }

  const element = (name: string) => document.querySelector(`[data-m="${name}"]`)!;
  const keyOf = (name: string) => readMessages(document)!.messages.find((read) => read.element === element(name))!.message.key;
  const click = (name: string) => element(name).dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));

  beforeEach(async () => {
    blobs = new Map([[BLOB_URL, blob(mp4([7, 7, 7]))], [OTHER_BLOB_URL, blob(mp4([8, 8, 8]))]]);
    fetch = vi.fn(async (url: string) => {
      const found = blobs.get(url);
      if (!found) throw new TypeError('Failed to fetch');
      return { ok: true, status: 200, blob: async () => found };
    });
    vi.stubGlobal('fetch', fetch);
    vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => undefined });
    storage = fakeChrome({ [NOTES_ENABLED]: true, [NotesKeys.selecting]: ALICE });
    storage.setSender({ url: `https://www.snapchat.com/web/${ALICE}`, tab: { id: 3 } as chrome.tabs.Tab });
    registerNotesBackground(storage.api, selections);
  });

  afterEach(() => {
    session?.stop();
    session = undefined;
  });

  async function start() {
    session = startMessageSelection(document, storage.api);
    await vi.waitFor(() => expect(element('hello').hasAttribute(SELECTABLE_ATTRIBUTE)).toBe(true));
  }

  it('stores the original file of the video of that message, read from its blob: URL only', async () => {
    openConversation(`<li data-m="clip"><video src="${BLOB_URL}"></video></li><li data-m="other"><video src="${OTHER_BLOB_URL}"></video></li>`);
    await start();
    const key = keyOf('clip');
    click('clip');
    await vi.waitFor(async () => expect(await selections.videos(ALICE, key)).toHaveLength(1));
    expect(new Uint8Array((await selections.videos(ALICE, key))[0].file.bytes)).toEqual(mp4([7, 7, 7]));
    // Only the video of the message selected was read, from memory: no other URL, no remote request.
    expect(fetch.mock.calls.map(([url]) => url)).toEqual([BLOB_URL]);
    expect(await selections.videos(ALICE, keyOf('other'))).toEqual([]);
  });

  it('keeps a single file when the message is selected again', async () => {
    openConversation(`<li data-m="clip"><video src="${BLOB_URL}"></video></li>`);
    await start();
    const key = keyOf('clip');
    for (let round = 0; round < 2; round++) {
      click('clip');
      await vi.waitFor(async () => expect(await selections.videos(ALICE, key)).toHaveLength(1));
      click('clip');
      await vi.waitFor(async () => expect(await selections.videos(ALICE, key)).toEqual([]));
    }
    click('clip');
    await vi.waitFor(async () => expect(await selections.videos(ALICE, key)).toHaveLength(1));
    expect(await selections.list(ALICE)).toHaveLength(1);
  });

  it('still selects the message when its video cannot be captured, and says why without its address', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    blobs.delete(BLOB_URL);
    openConversation(`<li data-m="clip"><video src="${BLOB_URL}"></video></li>`);
    await start();
    click('clip');
    await vi.waitFor(() => expect(warn).toHaveBeenCalledWith(expect.stringContaining('vidéo 0 non enregistrée')));
    expect(await selections.list(ALICE)).toEqual([expect.objectContaining({ key: keyOf('clip'), type: 'video' })]);
    expect(await selections.videos(ALICE, keyOf('clip'))).toEqual([]);
    expect(warn.mock.calls.flat().join(' ')).not.toContain(BLOB_URL);
  });

  it('never downloads a video the page holds only by a remote URL', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    openConversation('<li data-m="clip"><video src="https://cf-st.sc-cdn.net/d/video.mp4"></video></li>');
    await start();
    click('clip');
    await vi.waitFor(() => expect(warn).toHaveBeenCalledWith(expect.stringContaining('aucune source blob:')));
    expect(fetch).not.toHaveBeenCalled();
    expect(await selections.list(ALICE)).toHaveLength(1);
  });

  it('captures nothing for a message without video (images keep their preview path)', async () => {
    openConversation(`<li data-m="clip"><video src="${BLOB_URL}"></video></li>`);
    await start();
    click('photo');
    click('hello');
    await vi.waitFor(async () => expect(await selections.list(ALICE)).toHaveLength(2));
    expect((await selections.list(ALICE)).find((record) => record.type === 'image')?.media).toEqual([{ kind: 'image', alt: 'Photo', preview: null, spoiler: false }]);
    expect(fetch).not.toHaveBeenCalled();
  });
});
