// @vitest-environment jsdom
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { ArchiveError, exportArchive, noteDocument, noteFileName, parseArchive } from '../src/notes/archive';
import { planImport } from '../src/notes/importing';
import type { Note } from '../src/notes/model';

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
    expect(content['txt/alice-3-id-alice.txt']).toBe('Alice <3\n========\n\n## Sujet\n\ngras\n');
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
