// @vitest-environment jsdom
import { strFromU8, unzipSync } from 'fflate';
import { IDBFactory } from 'fake-indexeddb';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { exportArchive, noteDocument, noteText, parseArchive } from '../src/notes/archive';
import { registerNotesBackground } from '../src/notes/background';
import { NOTES_ENABLED, type Message, type Note, type SelectedMessage } from '../src/notes/model';
import { SelectedMessages } from '../src/notes/page/SelectedMessages';
import { imagePreview, withPreviews } from '../src/notes/selection';
import { createSelectionStore, type SelectionStore } from '../src/notes/selections';
import { fakeChrome } from './helpers/chrome';

// Images of the selected messages: preview copied at selection, « Spoiler » saved in IndexedDB, shown in
// the note, and exported (HTML, TXT, ZIP).

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: false });

const PAGE = 'chrome-extension://leakzero-test/notes.html';
const ALICE = '0b1c2d3e-4f50-4617-8293-a4b5c6d7e8f9';
const BOB = '2c1c2d3e-4f50-4617-8293-a4b5c6d7e8f9';
const AT = new Date('2026-11-01T10:15:30.000Z');
/** Two bytes of a "JPEG", enough to follow them into the archive. */
const BYTES = 'AAE=';
const preview = (data = BYTES) => ({ dataUrl: `data:image/jpeg;base64,${data}`, width: 480, height: 360 });

function message(conversationId: string, key: string, extra: Partial<Message> = {}): Message {
  return { conversationId, key, text: '', author: null, sentAt: null, timeLabel: null, type: 'text', media: [], links: [], ...extra };
}

/** Alice's message with three images: copied, copied, and one the page did not let be copied. */
const photos = message(ALICE, 'p:0', {
  author: 'Alice', type: 'image', text: 'regarde',
  media: [
    { kind: 'image', alt: 'Plage', preview: preview() },
    { kind: 'image', alt: 'Fin du film', preview: preview('AAI=') },
    { kind: 'image', alt: null, preview: null },
  ],
});
const plain = message(ALICE, 't:0', { author: 'Moi', text: 'sans image' });

let factory: IDBFactory;
let selections: SelectionStore;

beforeEach(() => {
  factory = new IDBFactory();
  selections = createSelectionStore(() => factory);
});

afterEach(async () => {
  await selections.close();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('image preview, at selection', () => {
  function image(width: number, height: number) {
    const img = document.createElement('img');
    Object.defineProperties(img, { complete: { value: true }, naturalWidth: { value: width }, naturalHeight: { value: height } });
    return img;
  }

  it('copies the image the page already shows, scaled down, without requesting anything', () => {
    const drawImage = vi.fn();
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ drawImage } as unknown as CanvasRenderingContext2D);
    vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue(preview().dataUrl);
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const img = image(1600, 1200);
    expect(imagePreview(img)).toEqual(preview());
    expect(drawImage).toHaveBeenCalledWith(img, 0, 0, 480, 360);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('gives none for an image not loaded yet, or that the browser forbids reading (other origin)', () => {
    expect(imagePreview(document.createElement('img'))).toBeNull();
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ drawImage: vi.fn() } as unknown as CanvasRenderingContext2D);
    vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockImplementation(() => { throw new DOMException('Tainted canvas', 'SecurityError'); });
    expect(imagePreview(image(10, 10))).toBeNull();
  });

  it('adds previews to images only, leaving the rest of the message and its key as read', () => {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ drawImage: vi.fn() } as unknown as CanvasRenderingContext2D);
    vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue(preview().dataUrl);
    const element = document.createElement('li');
    element.append(image(480, 360), document.createElement('video'));
    const read = message(ALICE, 'm:0', {
      type: 'media', media: [{ kind: 'image', alt: null, preview: null }, { kind: 'video', alt: null, preview: null }],
    });
    expect(withPreviews(element, read)).toEqual({ ...read, media: [{ kind: 'image', alt: null, preview: preview() }, { kind: 'video', alt: null, preview: null }] });
  });
});

describe('spoiler status, in IndexedDB', () => {
  it('starts off, is kept per image, and survives a restart', async () => {
    await selections.select(photos);
    await selections.setSpoiler(ALICE, 'p:0', 1, true);
    await selections.close();
    const [record] = await createSelectionStore(() => factory).list(ALICE);
    expect(record.media.map((image) => image.spoiler)).toEqual([false, true, false]);
    // Nothing else of the message changed.
    expect({ ...record, media: record.media.map(({ spoiler: _, ...image }) => image), selectedAt: 0 }).toEqual({ ...photos, selectedAt: 0 });
  });

  it('reads records saved before images had previews or spoilers', async () => {
    const legacy = { ...plain, key: 'o:0', type: 'image', media: [{ kind: 'image', alt: 'Photo' }], selectedAt: 5 };
    await new Promise<void>((resolve, reject) => {
      const open = factory.open('leakzero-notes', 1);
      open.onupgradeneeded = () => open.result.createObjectStore('selectedMessages', { keyPath: ['conversationId', 'key'] }).createIndex('conversationId', 'conversationId');
      open.onsuccess = () => {
        const tx = open.result.transaction('selectedMessages', 'readwrite');
        tx.objectStore('selectedMessages').put(legacy);
        tx.oncomplete = () => { open.result.close(); resolve(); };
        tx.onerror = () => reject(tx.error);
      };
    });
    const [record] = await selections.list(ALICE);
    expect(record).toEqual({ ...legacy, media: [{ kind: 'image', alt: 'Photo', preview: null, spoiler: false }] });
    // And can be marked as a spoiler without losing anything.
    await selections.setSpoiler(ALICE, 'o:0', 0, true);
    expect((await selections.list(ALICE))[0]).toEqual({ ...record, media: [{ ...record.media[0], spoiler: true }] });
  });

  it('refuses a media that is not an image, or a message that is no longer selected', async () => {
    await selections.select(message(ALICE, 'v:0', { type: 'video', media: [{ kind: 'video', alt: null, preview: null }] }));
    await expect(selections.setSpoiler(ALICE, 'v:0', 0, true)).rejects.toThrow('pas une image');
    await expect(selections.setSpoiler(ALICE, 'x:0', 0, true)).rejects.toThrow('plus sélectionné');
  });

  it('is only changed from the extension’s pages, through the service worker', async () => {
    const storage = fakeChrome({ [NOTES_ENABLED]: true });
    registerNotesBackground(storage.api, selections);
    await selections.select(photos);
    storage.setSender({ url: `https://www.snapchat.com/web/${ALICE}`, tab: { id: 3 } as chrome.tabs.Tab });
    expect(await storage.api.runtime.sendMessage({ type: 'notes:setSpoiler', conversationId: ALICE, key: 'p:0', media: 0, spoiler: true })).toMatchObject({ ok: false });
    storage.setSender({ url: PAGE });
    expect(await storage.api.runtime.sendMessage({ type: 'notes:setSpoiler', conversationId: ALICE, key: 'p:0', media: 0, spoiler: true })).toMatchObject({ ok: true });
    expect((await selections.list(ALICE))[0].media[0].spoiler).toBe(true);
  });
});

describe('images in « Messages sélectionnés »', () => {
  let root: Root | undefined;

  beforeEach(() => {
    const storage = fakeChrome({ [NOTES_ENABLED]: true });
    storage.setSender({ url: PAGE });
    registerNotesBackground(storage.api, selections);
  });
  afterEach(() => {
    root?.unmount();
    root = undefined;
    document.body.innerHTML = '';
  });

  async function show() {
    root?.unmount();
    document.body.innerHTML = '';
    root = createRoot(document.body.appendChild(document.createElement('div')));
    await act(async () => root!.render(<SelectedMessages conversationId={ALICE} version={0} />));
    await vi.waitFor(() => expect(document.querySelectorAll('[data-selected-message]')).toHaveLength(2));
  }

  const figure = (index: number) => document.querySelector<HTMLElement>(`[data-image="${index}"]`)!;
  const shown = (index: number) => figure(index).querySelector('img');
  const cover = (index: number) => figure(index).querySelector('[data-spoiler-cover]');
  const spoiler = (index: number) => figure(index).querySelector<HTMLButtonElement>('[role="switch"]')!;
  const reveal = (index: number) => [...figure(index).querySelectorAll('button')].find((button) => /^(Afficher|Masquer) l’image$/.test(button.textContent!));
  const press = async (button: HTMLElement) => act(async () => button.click());

  it('shows each image next to its message, and names the one that could not be copied', async () => {
    await selections.select(photos);
    await selections.select(plain);
    await show();
    const [withImages, without] = document.querySelectorAll('[data-selected-message]');
    expect(withImages.querySelectorAll('figure')).toHaveLength(3);
    expect(shown(0)!.getAttribute('src')).toBe(preview().dataUrl);
    expect(shown(0)!.alt).toBe('Plage');
    expect(cover(0)).toBeNull();
    expect(figure(2).textContent).toBe('Image indisponible');
    expect(figure(2).querySelector('[role="switch"]')).toBeNull();
    // A message without image is shown as before.
    expect(without.querySelector('figure')).toBeNull();
    expect(without.textContent).toContain('sans image');
  });

  it('hides a spoiler behind a block, reveals it for a while and hides it again, the status staying saved', async () => {
    await selections.select(photos);
    await selections.select(plain);
    await show();
    const status = spoiler(1);
    expect(status.getAttribute('aria-checked')).toBe('false');
    expect(status.getAttribute('aria-label')).toBe('Spoiler, image 2');
    expect(document.querySelector(`label[for="${status.id}"]`)!.textContent).toBe('Spoiler');
    await press(status);
    await vi.waitFor(async () => expect((await selections.list(ALICE))[0].media[1].spoiler).toBe(true));
    expect(shown(1)).toBeNull();
    expect(cover(1)!.textContent).toBe('Image masquée — spoiler');
    expect(cover(1)!.getAttribute('aria-label')).toBe('Image 2 masquée — spoiler');
    // The other images keep their own status.
    expect(shown(0)).not.toBeNull();

    // Revealed: on this screen only.
    expect(reveal(1)!.textContent).toBe('Afficher l’image');
    expect(reveal(1)!.getAttribute('aria-expanded')).toBe('false');
    await press(reveal(1)!);
    expect(shown(1)!.getAttribute('src')).toBe(preview('AAI=').dataUrl);
    expect(reveal(1)!.textContent).toBe('Masquer l’image');
    expect(reveal(1)!.getAttribute('aria-expanded')).toBe('true');
    expect((await selections.list(ALICE))[0].media[1].spoiler).toBe(true);
    await press(reveal(1)!);
    expect(shown(1)).toBeNull();

    // Revealed, then the page reopened: hidden again, still a spoiler.
    await press(reveal(1)!);
    await show();
    expect(spoiler(1).getAttribute('aria-checked')).toBe('true');
    expect(cover(1)).not.toBeNull();

    // Spoiler turned off: shown normally, without « Afficher l’image ».
    await press(spoiler(1));
    await vi.waitFor(async () => expect((await selections.list(ALICE))[0].media[1].spoiler).toBe(false));
    expect(shown(1)).not.toBeNull();
    expect(reveal(1)).toBeUndefined();
  });

  it('is operable from the keyboard: the controls are buttons in the tab order', async () => {
    await selections.select(photos);
    await selections.select(plain);
    await show();
    expect(spoiler(0).tagName).toBe('BUTTON');
    expect(spoiler(0).tabIndex).toBe(0);
    await press(spoiler(0));
    expect(reveal(0)!.tagName).toBe('BUTTON');
    expect(reveal(0)!.getAttribute('aria-controls')).toBe(figure(0).querySelector('div')!.id);
  });
});

describe('images in exports', () => {
  const note: Note = { id: 'id-alice', conversationId: ALICE, name: 'Alice', html: '<p>fiche</p>', createdAt: 1, updatedAt: 2, lastSeenAt: 3, trashedAt: null, customName: null };
  const bobNote: Note = { ...note, id: 'id-bob', conversationId: BOB, name: 'Bob' };
  const selectedPhotos: SelectedMessage = {
    ...photos, selectedAt: 7,
    media: photos.media.map((image, index) => ({ ...image, spoiler: index === 1 })),
  };
  const selectedPlain: SelectedMessage = { ...plain, media: [], selectedAt: 8 };
  const messages = new Map([[ALICE, [selectedPhotos, selectedPlain]], [BOB, [{ ...selectedPlain, conversationId: BOB, text: 'de Bob' }]]]);
  const parse = (html: string) => new DOMParser().parseFromString(html, 'text/html');
  const csp = (doc: Document) => doc.querySelector('meta[http-equiv="Content-Security-Policy"]')!.getAttribute('content');

  it('HTML: images inline, a spoiler closed in <details> (no script), the missing one only named', () => {
    const html = noteDocument(note, { messages, exportedAt: AT });
    const doc = parse(html);
    const [first, second] = doc.querySelectorAll('#selected-messages li');
    const figures = first.querySelectorAll('.images figure');
    expect(figures).toHaveLength(3);
    expect(figures[0].querySelector('details')).toBeNull();
    expect(figures[0].querySelector('img')!.getAttribute('src')).toBe(preview().dataUrl);
    const details = figures[1].querySelector('details')!;
    expect(details.hasAttribute('open')).toBe(false);
    expect(details.querySelector('summary')!.textContent).toBe('Image masquée — spoiler · Afficher l’image');
    expect(details.querySelector('img')!.getAttribute('src')).toBe(preview('AAI=').dataUrl);
    expect(figures[2].querySelector('img')).toBeNull();
    expect(figures[2].textContent).toBe('Image indisponible hors ligne');
    expect(second.querySelector('.images')).toBeNull();
    // Images from the page itself only, never from a URL, and no script.
    expect(csp(doc)).toBe("default-src 'none'; style-src 'unsafe-inline'; img-src data:");
    expect(doc.querySelectorAll('script')).toHaveLength(0);
    expect([...doc.querySelectorAll('img')].every((img) => img.getAttribute('src')!.startsWith('data:image/'))).toBe(true);
  });

  it('HTML: no image directive at all without an image that could be copied', () => {
    const doc = parse(noteDocument(note, { messages: new Map([[ALICE, [selectedPlain]]]), exportedAt: AT }));
    expect(csp(doc)).toBe("default-src 'none'; style-src 'unsafe-inline'");
    expect(doc.querySelector('.images')).toBeNull();
  });

  it('TXT: every textual detail, and [Image], [Image — spoiler] or [Image indisponible] for each image', () => {
    const text = noteText(note, { messages, exportedAt: AT });
    expect(text).toContain('1. Alice · Image · Sélectionné le ');
    expect(text).toContain('   regarde\n   Image (Plage), Image (Fin du film), Image\n   [Image] [Image — spoiler] [Image indisponible]\n\n2. Moi · Texte');
    expect(text).not.toContain('base64');
  });

  it('ZIP: each copied image is a file of the archive, linked by its relative path, for its own note only', () => {
    const zip = unzipSync(exportArchive([note, bobNote], { includeTrash: false, messages, exportedAt: AT }));
    const media = Object.keys(zip).filter((path) => path.startsWith('media/')).sort();
    expect(media).toEqual(['media/alice-id-alice-1-1.jpg', 'media/alice-id-alice-1-2.jpg']);
    expect([...zip['media/alice-id-alice-1-1.jpg']]).toEqual([0, 1]);
    expect([...zip['media/alice-id-alice-1-2.jpg']]).toEqual([0, 2]);
    const doc = parse(strFromU8(zip['html/alice-id-alice.html']));
    expect([...doc.querySelectorAll('img')].map((img) => img.getAttribute('src'))).toEqual(['../media/alice-id-alice-1-1.jpg', '../media/alice-id-alice-1-2.jpg']);
    expect(doc.querySelector('details img')!.getAttribute('src')).toBe('../media/alice-id-alice-1-2.jpg');
    expect(strFromU8(zip['html/alice-id-alice.html'])).not.toContain('base64');
    expect(csp(doc)).toBe("default-src 'none'; style-src 'unsafe-inline'; img-src 'self' file:");
    expect(doc.querySelector('.unavailable')!.textContent).toBe('Image indisponible hors ligne');
    expect(strFromU8(zip['html/bob-id-bob.html'])).not.toContain('<img');
    // The archive still imports, images left aside.
    expect(parseArchive(exportArchive([note, bobNote], { includeTrash: false, messages, exportedAt: AT })).map((imported) => imported.html)).toEqual(['<p>fiche</p>', '<p>fiche</p>']);
  });

  it('dates every file of one export with the same instant', () => {
    const zip = unzipSync(exportArchive([note, bobNote], { includeTrash: false, messages, exportedAt: AT }));
    expect(JSON.parse(strFromU8(zip['manifest.json'])).exportedAt).toBe('2026-11-01T10:15:30.000Z');
    const shown = new Date(AT).toLocaleString('fr-FR');
    for (const name of ['alice-id-alice', 'bob-id-bob']) {
      const time = parse(strFromU8(zip[`html/${name}.html`])).querySelector('header time')!;
      expect(time.getAttribute('datetime')).toBe('2026-11-01T10:15:30.000Z');
      expect(time.textContent).toBe(shown);
      expect(strFromU8(zip[`txt/${name}.txt`]).split('\n')[2]).toBe(`Notes LeakZero · exportée le ${shown}`);
    }
    // Single note exports too.
    expect(parse(noteDocument(note, { exportedAt: AT })).querySelector('header time')!.getAttribute('datetime')).toBe(AT.toISOString());
    expect(noteText(note, { exportedAt: AT })).toContain(`exportée le ${shown}`);
  });
});
