import { strFromU8, strToU8, unzipSync, zipSync, type UnzipFileInfo } from 'fflate';
import { z } from 'zod';
import { noteToText, sanitizeNoteHtml } from './content';
import { MAX_HTML_LENGTH, noteSchema, type Note } from './model';

// Archive exported by LeakZero, readable without it:
//   manifest.json   format, version, and each note's ids and dates, with the paths of its files
//   html/<name>.html   standalone page (the note in <main id="note">), the source of truth on import
//   txt/<name>.txt     plain text copy

const FORMAT = 'leakzero-notes';
const VERSION = 1;
const MAX_ARCHIVE_BYTES = 50 * 1024 * 1024;
const MAX_FILE_BYTES = 5 * 1024 * 1024;
const MAX_NOTES = 5000;

export class ArchiveError extends Error {
  override name = 'ArchiveError';
}

const ENTITIES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const escapeHtml = (text: string) => text.replace(/[&<>"']/g, (char) => ENTITIES[char]);

function slug(text: string): string {
  return text.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
}

export function noteFileName(note: Note, extension: 'html' | 'txt'): string {
  return `${slug(note.name) || 'note'}-${note.id.slice(0, 8)}.${extension}`;
}

const formatDate = (time: number) => new Date(time).toLocaleString('fr-FR');

/** A note as a standalone page: no script, no remote resource (its CSP forbids them anyway). */
export function noteDocument(note: Note): string {
  const name = escapeHtml(note.name);
  return `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${name}</title>
<style>body{font-family:system-ui,sans-serif;max-width:48rem;margin:2rem auto;padding:0 1rem;line-height:1.6}header p{color:#666;font-size:.875rem}</style>
</head>
<body>
<header><h1>${name}</h1><p>Notes LeakZero · créée le ${formatDate(note.createdAt)} · modifiée le ${formatDate(note.updatedAt)}</p></header>
<main id="note">${sanitizeNoteHtml(note.html)}</main>
</body>
</html>
`;
}

export function noteText(note: Note): string {
  return `${note.name}\n${'='.repeat(Math.min(note.name.length, 80))}\n\n${noteToText(note.html)}`;
}

const filePath = (folder: 'html' | 'txt') => z.string().regex(new RegExp(`^${folder}/[a-z0-9-]+\\.${folder}$`));
const manifestEntry = noteSchema.omit({ html: true }).extend({ html: filePath('html'), txt: filePath('txt') });
const formatSchema = z.object({ format: z.literal(FORMAT), version: z.number().int() });
const manifestSchema = z.object({
  exportedAt: z.string(),
  includesTrash: z.boolean(),
  notes: z.array(z.unknown()).max(MAX_NOTES),
});

export function exportArchive(notes: readonly Note[], { includeTrash }: { includeTrash: boolean }): Uint8Array {
  const files: Record<string, Uint8Array> = {};
  const used = new Set<string>();
  const unique = (name: string) => {
    let candidate = name;
    for (let index = 2; used.has(candidate); index++) candidate = name.replace(/\.(html|txt)$/, `-${index}.$1`);
    used.add(candidate);
    return candidate;
  };
  const entries = notes.filter((note) => includeTrash || note.trashedAt === null).map((note) => {
    const { html, ...metadata } = note;
    const htmlPath = unique(`html/${noteFileName(note, 'html')}`);
    const txtPath = unique(`txt/${noteFileName(note, 'txt')}`);
    files[htmlPath] = strToU8(noteDocument(note));
    files[txtPath] = strToU8(noteText(note));
    return { ...metadata, html: htmlPath, txt: txtPath } satisfies z.infer<typeof manifestEntry>;
  });
  const manifest = { format: FORMAT, version: VERSION, exportedAt: new Date().toISOString(), includesTrash: includeTrash, notes: entries };
  return zipSync({ 'manifest.json': strToU8(JSON.stringify(manifest, null, 2)), ...files });
}

function unzip(bytes: Uint8Array, wanted: (name: string) => boolean): Record<string, Uint8Array> {
  try {
    return unzipSync(bytes, {
      filter: (file: UnzipFileInfo) => {
        if (!wanted(file.name)) return false;
        if (file.originalSize > MAX_FILE_BYTES) throw new ArchiveError(`${file.name} est trop volumineux.`);
        return true;
      },
    });
  } catch (error) {
    if (error instanceof ArchiveError) throw error;
    throw new ArchiveError('Ce fichier n’est pas une archive ZIP lisible.');
  }
}

/** The note inside an exported page, reduced to the note schema. */
function readNoteDocument(path: string, text: string): string {
  const main = new DOMParser().parseFromString(text, 'text/html').querySelector('main#note');
  if (!main) throw new ArchiveError(`${path} n’est pas une fiche exportée par LeakZero.`);
  const html = sanitizeNoteHtml(main.innerHTML);
  if (html.length > MAX_HTML_LENGTH) throw new ArchiveError(`${path} est trop volumineux.`);
  return html;
}

/**
 * Reads and checks a whole archive before anything is written: any problem rejects it with a message
 * naming what is wrong. HTML is parsed inertly (DOMParser runs no script) and sanitized.
 */
export function parseArchive(bytes: Uint8Array): Note[] {
  if (bytes.length > MAX_ARCHIVE_BYTES) throw new ArchiveError('Cette archive est trop volumineuse.');
  const manifestFile = unzip(bytes, (name) => name === 'manifest.json')['manifest.json'];
  if (!manifestFile) throw new ArchiveError('Archive incomplète : manifest.json est absent.');
  let raw: unknown;
  try {
    raw = JSON.parse(strFromU8(manifestFile));
  } catch {
    throw new ArchiveError('manifest.json est illisible (JSON invalide).');
  }
  const format = formatSchema.safeParse(raw);
  if (!format.success) throw new ArchiveError('Ce n’est pas une archive de notes LeakZero (manifest.json non reconnu).');
  if (format.data.version !== VERSION) throw new ArchiveError(`Version d’archive ${format.data.version} non prise en charge par cette version de LeakZero.`);
  const manifest = manifestSchema.safeParse(raw);
  if (!manifest.success) throw new ArchiveError('manifest.json est incomplet ou invalide.');

  const entries = manifest.data.notes.map((entry, index) => {
    const parsed = manifestEntry.safeParse(entry);
    if (!parsed.success) throw new ArchiveError(`Données invalides pour la fiche ${index + 1} : ${parsed.error.issues.map((issue) => issue.path.join('.') || issue.message).join(', ')}.`);
    return parsed.data;
  });
  const ids = new Set<string>();
  const conversations = new Set<string>();
  for (const entry of entries) {
    if (ids.has(entry.id)) throw new ArchiveError(`La fiche ${entry.id} apparaît deux fois.`);
    ids.add(entry.id);
    if (entry.conversationId === null) continue;
    if (conversations.has(entry.conversationId)) throw new ArchiveError(`Deux fiches de l’archive suivent la même conversation (${entry.name}).`);
    conversations.add(entry.conversationId);
  }

  const paths = new Set(entries.map((entry) => entry.html));
  const content = unzip(bytes, (name) => paths.has(name));
  return entries.map(({ html: path, txt: _txt, ...metadata }) => {
    const file = content[path];
    if (!file) throw new ArchiveError(`Archive incomplète : ${path} est absent.`);
    return { ...metadata, html: readNoteDocument(path, strFromU8(file)) };
  });
}
