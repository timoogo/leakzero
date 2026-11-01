// @vitest-environment jsdom
import { strFromU8, unzipSync } from 'fflate';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerNotesBackground } from '../src/notes/background';
import { conversationFolder, exportConversations, type ConversationData, type ExportedVideo } from '../src/notes/documentExport';
import { NOTES_ENABLED, type Message, type Note, type SelectedMessage } from '../src/notes/model';
import { downloadConversations, exportReport } from '../src/notes/page/exportConversations';
import { createSelectionStore, type SelectionStore } from '../src/notes/selections';
import { fakeChrome } from './helpers/chrome';

// Documentary ZIP: one folder per conversation, its messages in HTML and TXT, and their stored media.

const ALICE = '0b1c2d3e-4f50-4617-8293-a4b5c6d7e8f9';
const BOB = '2c1c2d3e-4f50-4617-8293-a4b5c6d7e8f9';
const AT = new Date('2026-11-01T10:15:30.000Z');
const PATH = /^conversations\/[a-z0-9-]+\/(conversation\.(html|txt)|medias\/(photo|video)_\d{3}\.(jpg|png|webp|mp4|mov|webm))$/;

/** A JPEG and a PNG, by their first bytes. */
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2]);
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const dataUrl = (bytes: Uint8Array, type = 'jpeg') => `data:image/${type};base64,${btoa(String.fromCharCode(...bytes))}`;
const preview = (bytes = JPEG, type = 'jpeg') => ({ dataUrl: dataUrl(bytes, type), width: 480, height: 360 });

function mp4(extra: number[] = [1, 2, 3]): Uint8Array<ArrayBuffer> {
  return new Uint8Array([0, 0, 0, 0x18, ...[...'ftypisom'].map((c) => c.charCodeAt(0)), 0, 0, 2, 0, ...[...'isomiso2'].map((c) => c.charCodeAt(0)), ...extra]);
}

function note(id: string, name: string, conversationId: string | null, html = ''): Note {
  return { id, conversationId, name, customName: null, html, createdAt: 1, updatedAt: 2, lastSeenAt: 3, trashedAt: null };
}

function selected(conversationId: string, key: string, extra: Partial<SelectedMessage> = {}): SelectedMessage {
  return { conversationId, key, text: '', author: 'Alice', sentAt: '2026-10-30T14:02:00.000Z', timeLabel: '14:02', type: 'text', media: [], links: [], selectedAt: 10, ...extra };
}

const image = (extra: Partial<SelectedMessage['media'][number]> = {}) => ({ kind: 'image' as const, alt: 'Plage', preview: preview(), spoiler: false, ...extra });
const videoMedia = { kind: 'video' as const, alt: null, preview: null, spoiler: false };
const stored = (bytes: Uint8Array<ArrayBuffer>, sha256 = `sha-${bytes.join('')}`, media = 0): ExportedVideo => ({
  media, duration: 14.86, file: { sha256, bytes: bytes.slice().buffer, mime: 'video/mp4; codecs="hvc1"', size: bytes.length },
});

const alice = note('aaaaaaaa-1111-4111-8111-111111111111', 'Alice', ALICE, '<p>Rappel <strong>important</strong></p>');
const aliceMessages = [
  selected(ALICE, 't:0', { text: 'Salut' }),
  selected(ALICE, 'p:0', { type: 'image', text: 'regarde', media: [image()] }),
  selected(ALICE, 'v:0', { type: 'video', media: [videoMedia] }),
];
const aliceData = (): ConversationData => ({ note: alice, messages: aliceMessages, videos: new Map([['v:0', [stored(mp4([7, 7]))]]]) });

function unzip(zip: Uint8Array) {
  return unzipSync(zip);
}
const html = (files: Record<string, Uint8Array>, folder: string) => strFromU8(files[`conversations/${folder}/conversation.html`]);
const text = (files: Record<string, Uint8Array>, folder: string) => strFromU8(files[`conversations/${folder}/conversation.txt`]);
const parse = (source: string) => new DOMParser().parseFromString(source, 'text/html');

describe('export of one conversation', () => {
  it('holds its page, its text and its media, in its own folder', () => {
    const { zip, summary } = exportConversations([aliceData()], AT);
    const files = unzip(zip);
    const folder = conversationFolder(alice);
    expect(folder).toBe('alice-aaaaaaaa');
    expect(Object.keys(files).sort()).toEqual([
      `conversations/${folder}/conversation.html`,
      `conversations/${folder}/conversation.txt`,
      `conversations/${folder}/medias/photo_001.jpg`,
      `conversations/${folder}/medias/video_001.mp4`,
    ]);
    expect(summary).toEqual({ conversations: 1, files: 2, missing: 0 });
    // The original bytes, unchanged: the MP4 as stored, the image as copied at selection.
    expect(files[`conversations/${folder}/medias/video_001.mp4`]).toEqual(mp4([7, 7]));
    expect(files[`conversations/${folder}/medias/photo_001.jpg`]).toEqual(JPEG);
  });

  it('presents the note and the messages in order, with their metadata and their media', () => {
    const files = unzip(exportConversations([aliceData()], AT).zip);
    const page = parse(html(files, 'alice-aaaaaaaa'));
    expect(page.querySelector('h1')!.textContent).toBe('Alice');
    expect(page.querySelector('#note strong')!.textContent).toBe('important');
    const items = [...page.querySelectorAll('#messages > ol > li')];
    expect(items.map((item) => item.querySelector('.text')?.textContent ?? null)).toEqual(['Salut', 'regarde', null]);
    expect(items[0].querySelector('.meta')!.textContent).toContain('Alice');
    expect(items[0].querySelector('.meta')!.textContent).toContain('Envoyé');
    expect(items[1].querySelector('a')!.getAttribute('href')).toBe('medias/photo_001.jpg');
    expect(items[2].querySelector('a')!.getAttribute('href')).toBe('medias/video_001.mp4');
    expect(items[2].textContent).toContain('video/mp4');
    // A document: nothing to run, nothing embedded, nothing remote.
    expect(page.querySelectorAll('script, img, video, iframe, object, embed')).toHaveLength(0);
    expect(page.querySelector('meta[http-equiv="Content-Security-Policy"]')!.getAttribute('content')).toBe("default-src 'none'; style-src 'unsafe-inline'");
  });

  it('gives the text copy the media paths', () => {
    const txt = text(unzip(exportConversations([aliceData()], AT).zip), 'alice-aaaaaaaa');
    expect(txt).toContain('Rappel important');
    expect(txt).toMatch(/1\. Alice · Envoyé : .*\n {3}Salut/);
    expect(txt).toContain('medias/photo_001.jpg');
    expect(txt).toContain('medias/video_001.mp4');
  });
});

describe('links of the documents', () => {
  it('point to files of the archive, relative to the page', () => {
    const data: ConversationData[] = [aliceData(), { note: note('bbbbbbbb-2222-4222-8222-222222222222', 'Bob', BOB), messages: [selected(BOB, 'p:0', { media: [image({ preview: preview(PNG, 'png') })] })], videos: new Map() }];
    const files = unzip(exportConversations(data, AT).zip);
    for (const path of Object.keys(files).filter((name) => name.endsWith('conversation.html'))) {
      const folder = path.slice(0, -'conversation.html'.length);
      const hrefs = [...parse(strFromU8(files[path])).querySelectorAll('#messages a')].map((link) => link.getAttribute('href')!);
      expect(hrefs.length).toBeGreaterThan(0);
      for (const href of hrefs) expect(files[folder + href]).toBeDefined();
      const txtPaths = strFromU8(files[`${folder}conversation.txt`]).match(/medias\/\S+/g)!;
      expect(txtPaths.sort()).toEqual(hrefs.sort());
    }
    // The extension follows what the bytes are.
    expect(files['conversations/bob-bbbbbbbb/medias/photo_001.png']).toEqual(PNG);
  });
});

describe('missing media', () => {
  it('names an image never copied and a video never stored, without a file or a link', () => {
    const data: ConversationData = {
      note: alice,
      messages: [selected(ALICE, 'm:0', { type: 'media', media: [image({ preview: null }), videoMedia] })],
      videos: new Map(),
    };
    const { zip, summary } = exportConversations([data], AT);
    const files = unzip(zip);
    expect(summary).toEqual({ conversations: 1, files: 0, missing: 2 });
    expect(Object.keys(files).some((name) => name.includes('/medias/'))).toBe(false);
    const page = parse(html(files, 'alice-aaaaaaaa'));
    expect(page.querySelectorAll('a')).toHaveLength(0);
    expect([...page.querySelectorAll('.missing')].map((item) => item.textContent)).toEqual(['Image (Plage) — non capturée', 'Vidéo — non enregistrée']);
    expect(page.querySelector('header')!.textContent).toContain('2 médias absents de l’archive');
    expect(text(files, 'alice-aaaaaaaa')).toContain('[Vidéo — non enregistrée]');
    expect(exportReport(summary)).toMatch(/^Export incomplet : .*2 médias absents/);
  });

  it('exports a conversation without media, or without any saved message', () => {
    const bob = note('bbbbbbbb-2222-4222-8222-222222222222', 'Bob', BOB);
    const detached = note('cccccccc-3333-4333-8333-333333333333', 'Copie', null, '<p>seule</p>');
    const { zip, summary } = exportConversations([
      { note: bob, messages: [selected(BOB, 't:0', { text: 'ok' })], videos: new Map() },
      { note: detached, messages: [], videos: new Map() },
    ], AT);
    const files = unzip(zip);
    expect(summary).toEqual({ conversations: 2, files: 0, missing: 0 });
    expect(Object.keys(files).sort()).toEqual([
      'conversations/bob-bbbbbbbb/conversation.html', 'conversations/bob-bbbbbbbb/conversation.txt',
      'conversations/copie-cccccccc/conversation.html', 'conversations/copie-cccccccc/conversation.txt',
    ]);
    expect(html(files, 'copie-cccccccc')).toContain('Aucun message enregistré.');
    expect(exportReport(summary)).toBe('Export terminé : 2 conversations, 0 fichier média.');
  });
});

describe('folder and file names', () => {
  it('keeps conversations with the same name apart, and every path safe', () => {
    const twins = [note('11111111-0000-4000-8000-000000000000', 'Alice', ALICE), note('22222222-0000-4000-8000-000000000000', 'Alice', BOB)];
    const hostile = note('33333333-0000-4000-8000-000000000000', '../../etc/<passwd> \\ C:\\ ..', null);
    const unnamed = note('44444444-0000-4000-8000-000000000000', '../..', null);
    const files = unzip(exportConversations([...twins, hostile, unnamed].map((n) => ({ note: n, messages: [], videos: new Map() })), AT).zip);
    const folders = [...new Set(Object.keys(files).map((name) => name.split('/')[1]))];
    expect(folders).toEqual(['alice-11111111', 'alice-22222222', 'etc-passwd-c-33333333', 'conversation-44444444']);
    for (const name of Object.keys(files)) expect(name).toMatch(PATH);
  });

  it('never gives two conversations the same folder, even with the same name and id prefix', () => {
    const a = note('55555555-0000-4000-8000-000000000001', 'Alice', ALICE);
    const b = note('55555555-0000-4000-8000-000000000002', 'Alice', BOB);
    const files = unzip(exportConversations([a, b].map((n) => ({ note: n, messages: [], videos: new Map() })), AT).zip);
    expect([...new Set(Object.keys(files).map((name) => name.split('/')[1]))]).toEqual(['alice-55555555', 'alice-55555555-2']);
  });
});

describe('duplicates', () => {
  it('writes a file shared by several messages of a conversation once, and once per conversation', () => {
    const shared = mp4([5, 5]);
    const messages = (conversationId: string) => [
      selected(conversationId, 'a:0', { media: [image(), videoMedia] }),
      selected(conversationId, 'a:1', { media: [image({ alt: 'Encore' }), videoMedia] }),
    ];
    const videos = new Map([['a:0', [stored(shared, 'same', 1)]], ['a:1', [stored(shared, 'same', 1)]]]);
    const bob = note('bbbbbbbb-2222-4222-8222-222222222222', 'Bob', BOB);
    const { zip, summary } = exportConversations([{ note: alice, messages: messages(ALICE), videos }, { note: bob, messages: messages(BOB), videos }], AT);
    const files = unzip(zip);
    expect(Object.keys(files).filter((name) => name.includes('/medias/')).sort()).toEqual([
      'conversations/alice-aaaaaaaa/medias/photo_001.jpg', 'conversations/alice-aaaaaaaa/medias/video_001.mp4',
      'conversations/bob-bbbbbbbb/medias/photo_001.jpg', 'conversations/bob-bbbbbbbb/medias/video_001.mp4',
    ]);
    expect(summary.files).toBe(4);
    // Both messages link the same file.
    expect([...parse(html(files, 'alice-aaaaaaaa')).querySelectorAll('a')].map((link) => link.getAttribute('href'))).toEqual([
      'medias/photo_001.jpg', 'medias/video_001.mp4', 'medias/photo_001.jpg', 'medias/video_001.mp4',
    ]);
  });
});

describe('escaping', () => {
  it('shows what users wrote as text, never as markup', () => {
    const evil = '<script>alert(1)</script><img src=x onerror=alert(2)>"\'&';
    const data: ConversationData = {
      note: { ...alice, name: `<b>${evil}</b>`, html: '<p>ok</p><script>alert(3)</script>' },
      messages: [selected(ALICE, 'x:0', { text: evil, author: evil, links: [`https://example.com/?q="><script>alert(4)</script>`], media: [image({ alt: evil, preview: null })] })],
      videos: new Map(),
    };
    const files = unzip(exportConversations([data], AT).zip);
    const source = html(files, conversationFolder(data.note));
    const page = parse(source);
    expect(page.querySelectorAll('script, img, b')).toHaveLength(0);
    expect(page.querySelector('h1')!.textContent).toBe(`<b>${evil}</b>`);
    expect(page.querySelector('.text')!.textContent).toBe(evil);
    expect(page.querySelector('title')!.textContent).toBe(`<b>${evil}</b>`);
    expect(source).not.toContain('<script>');
  });
});

describe('from the Notes page, with local data only', () => {
  let factory: IDBFactory;
  let selections: SelectionStore;
  let downloaded: Blob[];

  beforeEach(async () => {
    factory = new IDBFactory();
    selections = createSelectionStore(() => factory);
    const storage = fakeChrome({ [NOTES_ENABLED]: true });
    registerNotesBackground(storage.api, selections);
    // The Notes page: no Snapchat tab is open.
    storage.setSender({ url: 'chrome-extension://leakzero-test/notes.html' });
    downloaded = [];
    vi.stubGlobal('URL', Object.assign(Object.create(URL), { createObjectURL: (blob: Blob) => { downloaded.push(blob); return 'blob:x'; }, revokeObjectURL: () => undefined }));
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    const message = (key: string, media: Message['media']): Message => ({ conversationId: ALICE, key, text: 'vidéo', author: null, sentAt: null, timeLabel: null, type: 'video', media, links: [] });
    await selections.select(message('v:0', [{ kind: 'video', alt: null, preview: null }]));
    await selections.select(message('v:1', [{ kind: 'video', alt: null, preview: null }]));
    await selections.storeVideo(ALICE, 'v:0', 0, mp4([9, 9, 9]), { mime: 'video/mp4', width: null, height: null, duration: null });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    await selections.close();
  });

  it('reads the stored videos as bytes, and changes nothing in IndexedDB', async () => {
    const before = { list: await selections.list(ALICE), videos: await selections.videos(ALICE, 'v:0') };
    const page = createSelectionStore(() => factory);
    const summary = await downloadConversations([alice], page);
    await page.close();
    expect(summary).toEqual({ conversations: 1, files: 1, missing: 1 });
    expect(downloaded).toHaveLength(1);
    const files = unzip(new Uint8Array(await downloaded[0].arrayBuffer()));
    expect(files['conversations/alice-aaaaaaaa/medias/video_001.mp4']).toEqual(mp4([9, 9, 9]));
    expect(await selections.list(ALICE)).toEqual(before.list);
    expect(await selections.videos(ALICE, 'v:0')).toEqual(before.videos);
  });

  it('still exports the messages when the videos cannot be read, and says the archive is incomplete', async () => {
    const summary = await downloadConversations([alice], { videos: () => Promise.reject(new Error('IndexedDB fermée')) });
    expect(summary).toEqual({ conversations: 1, files: 0, missing: 2 });
    const files = unzip(new Uint8Array(await downloaded[0].arrayBuffer()));
    expect(parse(html(files, 'alice-aaaaaaaa')).querySelectorAll('#messages > ol > li')).toHaveLength(2);
    expect(exportReport(summary)).toMatch(/^Export incomplet/);
  });
});
