// @vitest-environment jsdom
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { ArchiveError, exportArchive, noteDocument, noteFileName, noteText, parseArchive } from '../src/notes/archive';
import { planImport } from '../src/notes/importing';
import type { Note, SelectedMessage } from '../src/notes/model';

const ALICE = '0b1c2d3e-4f50-4617-8293-a4b5c6d7e8f9';
const BOB = '2c1c2d3e-4f50-4617-8293-a4b5c6d7e8f9';

function note(id: string, extra: Partial<Note> = {}): Note {
  return { id, conversationId: null, name: id, html: '', createdAt: 1, updatedAt: 2, lastSeenAt: 3, trashedAt: null, customName: null, ...extra };
}

const alice = note('id-alice', { conversationId: ALICE, name: 'Alice <3', html: '<h2>Sujet</h2><p><strong>gras</strong></p>' });
const bob = note('id-bob', { conversationId: BOB, name: 'Bob', html: '<ul><li><p>un</p></li></ul>' });
const trashed = note('id-old', { name: 'Ancienne', trashedAt: 9 });

const files = (zip: Uint8Array) => Object.fromEntries(Object.entries(unzipSync(zip)).map(([name, data]) => [name, strFromU8(data)]));
const manifestOf = (zip: Uint8Array) => JSON.parse(files(zip)['manifest.json']);

function archive(manifest: unknown, extra: Record<string, string> = {}) {
  return zipSync({ 'manifest.json': strToU8(JSON.stringify(manifest)), ...Object.fromEntries(Object.entries(extra).map(([name, text]) => [name, strToU8(text)])) });
}

function errorOf(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    if (error instanceof ArchiveError) return error.message;
    throw error;
  }
  throw new Error('expected an ArchiveError');
}

describe('single note export', () => {
  it('is a standalone HTML document, readable anywhere, that can run nothing', () => {
    const html = noteDocument({ ...alice, html: '<p onclick="x()">texte</p><script>alert(1)</script>' });
    expect(html).toMatch(/^<!doctype html>/);
    expect(html).toContain('<title>Alice &lt;3</title>');
    expect(html).toContain('<h1>Alice &lt;3</h1>');
    expect(html).toContain("Content-Security-Policy\" content=\"default-src 'none'");
    expect(html).toContain('<main id="note"><p>texte</p></main>');
    expect(html).not.toMatch(/onclick|<script/);
  });

  it('gets a safe, unique file name', () => {
    expect(noteFileName(note('0b1c2d3e-aaaa', { name: 'Élodie / Projet ✨' }), 'html')).toBe('elodie-projet-0b1c2d3e.html');
    expect(noteFileName(note('xyz', { name: '../../..' }), 'txt')).toBe('note-xyz.txt');
  });
});

describe('ZIP export', () => {
  it('contains each note in HTML and TXT, and a manifest of the notes and their ids, without the trash', () => {
    const zip = exportArchive([alice, bob, trashed], { includeTrash: false });
    const content = files(zip);
    const manifest = manifestOf(zip);
    expect(manifest).toMatchObject({ format: 'leakzero-notes', version: 1, includesTrash: false });
    expect(manifest.notes.map((entry: { id: string }) => entry.id)).toEqual(['id-alice', 'id-bob']);
    expect(manifest.notes[0]).toEqual({
      id: 'id-alice', conversationId: ALICE, name: 'Alice <3', customName: null, createdAt: 1, updatedAt: 2, lastSeenAt: 3, trashedAt: null,
      html: 'html/alice-3-id-alice.html', txt: 'txt/alice-3-id-alice.txt',
    });
    expect(content['html/alice-3-id-alice.html']).toContain('<h2>Sujet</h2>');
    expect(content['txt/alice-3-id-alice.txt']).toMatch(/^Alice <3\n========\nNotes LeakZero · exportée le \d\d\/\d\d\/\d{4} \d\d:\d\d:\d\d\n\n## Sujet\n\ngras\n$/);
    expect(Object.keys(content)).toHaveLength(5);
  });

  it('includes the trash only when asked', () => {
    const manifest = manifestOf(exportArchive([alice, trashed], { includeTrash: true }));
    expect(manifest.includesTrash).toBe(true);
    expect(manifest.notes.map((entry: { id: string }) => entry.id)).toEqual(['id-alice', 'id-old']);
  });
});

describe('ZIP import', () => {
  it('reads back an exported archive with its ids and metadata', () => {
    expect(parseArchive(exportArchive([alice, bob, trashed], { includeTrash: true }))).toEqual([alice, bob, trashed]);
  });

  it('sanitizes the notes it reads: nothing from the archive can run', () => {
    const zip = exportArchive([alice], { includeTrash: false });
    const content = unzipSync(zip);
    const path = Object.keys(content).find((name) => name.endsWith('.html'))!;
    content[path] = strToU8('<html><body><main id="note"><p onmouseover="steal()">ok</p><img src=x onerror=alert(1)><a href="javascript:alert(1)">lien</a><script>alert(1)</script></main></body></html>');
    const [imported] = parseArchive(zipSync(content));
    expect(imported.html).toBe('<p>ok</p><p>lien</p>');
  });

  it.each([
    ['not a ZIP file', strToU8('hello'), 'n’est pas une archive ZIP'],
    ['no manifest', zipSync({ 'a.txt': strToU8('x') }), 'manifest.json'],
    ['invalid JSON', zipSync({ 'manifest.json': strToU8('{') }), 'manifest.json'],
    ['another format', archive({ format: 'other', version: 1, notes: [] }), 'LeakZero'],
    ['a newer version', archive({ format: 'leakzero-notes', version: 2, notes: [] }), 'version'],
  ])('rejects an archive that is %s', (_label, zip, message) => {
    expect(errorOf(() => parseArchive(zip))).toContain(message);
  });

  const entry = (extra: Record<string, unknown> = {}) => ({
    id: 'n1', conversationId: ALICE, name: 'Alice', createdAt: 1, updatedAt: 2, lastSeenAt: 3, trashedAt: null, html: 'html/n1.html', txt: 'txt/n1.txt', ...extra,
  });
  const valid = (notes: unknown[]) => ({ format: 'leakzero-notes', version: 1, exportedAt: '2026-01-01T00:00:00.000Z', includesTrash: false, notes });
  const body = '<main id="note"><p>a</p></main>';

  it('rejects an incomplete archive (a note file is missing)', () => {
    expect(errorOf(() => parseArchive(archive(valid([entry()]))))).toContain('html/n1.html');
  });

  it('rejects invalid note data, naming the faulty note', () => {
    expect(errorOf(() => parseArchive(archive(valid([entry({ name: '' })]), { 'html/n1.html': body })))).toContain('fiche 1');
    expect(errorOf(() => parseArchive(archive(valid([entry({ conversationId: 'pas-un-id' })]), { 'html/n1.html': body })))).toContain('fiche 1');
    expect(errorOf(() => parseArchive(archive(valid([entry({ html: '../../etc/passwd' })]), { 'html/n1.html': body })))).toContain('fiche 1');
  });

  it('rejects an HTML file that is not a LeakZero note', () => {
    expect(errorOf(() => parseArchive(archive(valid([entry()]), { 'html/n1.html': '<p>sans main</p>' })))).toContain('html/n1.html');
  });

  it('rejects an archive listing the same note or conversation twice', () => {
    const twice = [entry(), entry({ id: 'n2', html: 'html/n1.html' })];
    expect(errorOf(() => parseArchive(archive(valid(twice), { 'html/n1.html': body })))).toContain('conversation');
    expect(errorOf(() => parseArchive(archive(valid([entry(), entry({ conversationId: null })]), { 'html/n1.html': body })))).toContain('n1');
  });

  it('accepts an empty archive', () => {
    expect(parseArchive(archive(valid([])))).toEqual([]);
  });
});

describe('import plan', () => {
  it('finds conflicts by note id or by conversation, others are new', () => {
    const existing = [alice, note('other', { conversationId: BOB })];
    const imported = [alice, note('id-bob-2', { conversationId: BOB }), note('new')];
    expect(planImport(imported, existing).map((item) => [item.note.id, item.conflict?.id ?? null])).toEqual([
      ['id-alice', 'id-alice'],
      ['id-bob-2', 'other'],
      ['new', null],
    ]);
  });
});

function selected(conversationId: string, key: string, extra: Partial<SelectedMessage> = {}): SelectedMessage {
  return {
    conversationId, key, text: '', author: null, sentAt: null, timeLabel: null, type: 'text', media: [], links: [],
    selectedAt: Date.UTC(2026, 9, 31, 9, 30), ...extra,
  };
}

const aliceMessages = [
  selected(ALICE, 'a:0', { text: 'Salut toi\nà demain', author: 'Alice', sentAt: '2026-10-30T14:02:00.000Z', timeLabel: '14:02' }),
  selected(ALICE, 'b:0', { type: 'image', media: [{ kind: 'image', alt: 'Photo', preview: null, spoiler: false }], timeLabel: 'Hier' }),
  selected(ALICE, 'c:0', { text: 'le lien', author: 'Moi', links: ['https://example.com/a?x=1&y=2'] }),
];
const AT = new Date('2026-11-01T10:15:30.000Z');
const bobMessages = [selected(BOB, 'd:0', { text: 'Message de Bob', author: 'Bob', type: 'unknown' })];
const byConversation = new Map([[ALICE, aliceMessages], [BOB, bobMessages]]);

/** The « Messages sélectionnés » section of an exported page, parsed inertly. */
function section(html: string) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  return { doc, section: doc.querySelector('section#selected-messages') };
}

describe('selected messages in exports', () => {
  it('adds every selected message of the conversation to the HTML page, after the note, with what is known of it', () => {
    const { doc, section: found } = section(noteDocument(alice, { messages: byConversation, exportedAt: AT }));
    expect(found!.querySelector('h2')!.textContent).toBe('Messages sélectionnés (3)');
    const items = [...found!.querySelectorAll('li')].map((item) => [...item.querySelectorAll('p')].map((p) => p.textContent));
    expect(items[0]).toEqual([expect.stringMatching(/^Alice · Envoyé : 30\/10\/2026 \d\d:02 · Texte · Sélectionné le 31\/10\/2026 \d\d:30$/), 'Salut toi\nà demain']);
    // Only what Snapchat showed: no author, the time label when there is no `datetime`.
    expect(items[1]).toEqual([expect.stringMatching(/^Envoyé : Hier · Image · Sélectionné le /), 'Image (Photo)', 'Image indisponible hors ligne']);
    expect(items[2]).toEqual([expect.stringMatching(/^Moi · Texte · Sélectionné le /), 'le lien', 'Liens : https://example.com/a?x=1&y=2']);
    // The note itself is unchanged, and the messages are not part of it.
    expect(doc.querySelector('main#note')!.innerHTML).toBe('<h2>Sujet</h2><p><strong>gras</strong></p>');
    expect(doc.querySelector('main#note section')).toBeNull();
  });

  it('adds them to the TXT copy too', () => {
    const text = noteText(alice, { messages: byConversation, exportedAt: AT });
    expect(text.startsWith(noteText(alice, { exportedAt: AT }))).toBe(true);
    expect(text).toContain('Messages sélectionnés (3)\n-------------------------\n\n1. Alice · Envoyé : 30/10/2026');
    expect(text).toContain('   Salut toi\n   à demain\n\n2. Envoyé : Hier · Image · Sélectionné le ');
    expect(text).toContain('   Image (Photo)');
    expect(text).toContain('3. Moi · Texte · Sélectionné le ');
    expect(text).toContain('   Liens : https://example.com/a?x=1&y=2\n');
    expect(text).not.toContain('Message de Bob');
  });

  it('escapes every field: a message can neither inject markup nor run anything', () => {
    const hostile = selected(ALICE, 'e:0', {
      text: '<script>alert(1)</script><img src=x onerror=alert(2)> & "q" \'s\'',
      author: '<b>Mallory</b>',
      timeLabel: '<i>14:00</i>',
      media: [{ kind: 'video', alt: '"><svg onload=alert(3)>', preview: null, spoiler: false }],
      links: ['javascript:alert(4)"><a href="x'],
      type: 'media',
    });
    const html = noteDocument(alice, { messages: new Map([[ALICE, [hostile]]]), exportedAt: AT });
    const { section: found } = section(html);
    expect(found!.querySelectorAll('script, img, svg, b, i, a')).toHaveLength(0);
    expect(found!.textContent).toContain('<script>alert(1)</script><img src=x onerror=alert(2)> & "q" \'s\'');
    expect(found!.textContent).toContain('<b>Mallory</b> · Envoyé : <i>14:00</i> · Médias');
    expect(found!.textContent).toContain('Vidéo ("><svg onload=alert(3)>)');
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).not.toContain('<script>');
  });

  it('leaves the export of a conversation without selected messages exactly as before', () => {
    const none = new Map([[ALICE, []]]);
    expect(noteDocument(alice, { messages: none, exportedAt: AT })).toBe(noteDocument(alice, { exportedAt: AT }));
    expect(noteText(alice, { messages: none, exportedAt: AT })).toBe(noteText(alice, { exportedAt: AT }));
    expect(noteDocument(alice, { messages: none, exportedAt: AT })).not.toContain('selected-messages');
    expect(noteText(alice, { messages: byConversation, exportedAt: AT })).not.toBe(noteText(alice, { exportedAt: AT }));
    // A note detached from its conversation has none either.
    expect(noteDocument({ ...alice, conversationId: null }, { messages: byConversation, exportedAt: AT })).not.toContain('selected-messages');
  });

  it('gives each note of the ZIP the messages of its own conversation only', () => {
    const carol = note('id-carol', { conversationId: '3d1c2d3e-4f50-4617-8293-a4b5c6d7e8f9', name: 'Carol' });
    const zip = files(exportArchive([alice, bob, carol], { includeTrash: false, messages: byConversation }));
    const page = (name: string) => zip[Object.keys(zip).find((path) => path.startsWith(`html/${name}-`))!];
    const txt = (name: string) => zip[Object.keys(zip).find((path) => path.startsWith(`txt/${name}-`))!];
    expect(section(page('alice-3')).section!.querySelectorAll('li')).toHaveLength(3);
    expect(page('alice-3')).not.toContain('Message de Bob');
    expect(section(page('bob')).section!.textContent).toContain('Messages sélectionnés (1)Bob · Type inconnu');
    expect(page('bob')).not.toContain('Salut toi');
    expect(txt('alice-3')).toContain('Salut toi');
    expect(txt('bob')).toContain('Message de Bob');
    expect(txt('bob')).not.toContain('Salut toi');
    expect(page('carol')).not.toContain('selected-messages');
    // The manifest, and so the import, are unchanged.
    expect(Object.keys(manifestOf(exportArchive([alice], { includeTrash: false, messages: byConversation })).notes[0]).sort())
      .toEqual(Object.keys(manifestOf(exportArchive([alice], { includeTrash: false })).notes[0]).sort());
  });

  it('never imports the selected messages back into the note', () => {
    const [imported] = parseArchive(exportArchive([alice], { includeTrash: false, messages: byConversation }));
    expect(imported.html).toBe(alice.html);
  });
});
