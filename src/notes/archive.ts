import { strFromU8, strToU8, unzipSync, zipSync, type UnzipFileInfo } from 'fflate';
import { z } from 'zod';
import { noteToText, sanitizeNoteHtml } from './content';
import { displayName, MAX_HTML_LENGTH, noteSchema, type Note, type SelectedMessage } from './model';
import { imageTag, mediaLabel, messageDetails } from './selected';

// Archive exported by LeakZero, readable without it:
//   manifest.json   format, version, and each note's ids and dates, with the paths of its files
//   html/<name>.html   standalone page (the note in <main id="note">), the source of truth on import,
//                      then the messages selected in its conversation (<section id="selected-messages">)
//   txt/<name>.txt     plain text copy, the selected messages included
//   media/<name>-<m>-<i>.<ext>   previews of the selected images, linked from the HTML page
// Selected messages are exported, not imported: they stay where they are read from (IndexedDB).

const FORMAT = 'leakzero-notes';
const VERSION = 1;
const MAX_ARCHIVE_BYTES = 50 * 1024 * 1024;
const MAX_FILE_BYTES = 5 * 1024 * 1024;
const MAX_NOTES = 5000;

export class ArchiveError extends Error {
  override name = 'ArchiveError';
}

const ENTITIES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const escapeHtml = (text: string) => text.replace(/[&<>"']/g, (char) => ENTITIES[char]);

export function slug(text: string): string {
  return text.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
}

export function noteFileName(note: Note, extension: 'html' | 'txt'): string {
  return `${slug(displayName(note)) || 'note'}-${note.id.slice(0, 8)}.${extension}`;
}

const formatDate = (time: number) => new Date(time).toLocaleString('fr-FR');

/** Messages selected in each conversation, by conversation id (read from IndexedDB by the caller). */
export type SelectedMessagesByConversation = ReadonlyMap<string, readonly SelectedMessage[]>;

export interface ExportOptions {
  messages?: SelectedMessagesByConversation;
  /** When the export was made: one instant for every file of one export. */
  exportedAt?: Date;
}

type Preview = NonNullable<SelectedMessage['media'][number]['preview']>;
/** Where an exported page finds an image preview: inline (data URL) or a file of the archive. */
type ImageSource = (preview: Preview, message: number, image: number) => string;
const inline: ImageSource = (preview) => preview.dataUrl;

/**
 * The selected messages of `note`'s conversation; null when there are none (or no conversation): the
 * export is then exactly what it was before messages could be selected.
 */
function messagesOf(note: Note, messages: SelectedMessagesByConversation): readonly SelectedMessage[] | null {
  const selected = note.conversationId === null ? undefined : messages.get(note.conversationId);
  return selected && selected.length > 0 ? selected : null;
}

const SELECTED_MESSAGES_CSS = '#selected-messages{border-top:1px solid #ddd;margin-top:2rem}#selected-messages li{margin-bottom:1rem;display:flex;gap:1rem}'
  + '.meta,.text{margin:0}.meta{color:#666;font-size:.875rem}.text{white-space:pre-wrap;overflow-wrap:anywhere}.message{flex:1;min-width:0}'
  + '.images{display:flex;flex-direction:column;gap:.5rem;width:10rem;flex-shrink:0}.images figure{margin:0}.images img{max-width:100%;height:auto}'
  + '.images summary{cursor:pointer;background:#eee;border-radius:.25rem;padding:.5rem;font-size:.875rem}';

/**
 * The images of a message, on its right. A spoiler is hidden in a closed <details>: revealed (and hidden
 * again) from its <summary>, without script. A preview that was not copied is only named.
 */
function imagesHtml(message: SelectedMessage, position: number, source: ImageSource): string {
  const figures = message.media.flatMap((image, index) => {
    if (image.kind !== 'image') return [];
    if (!image.preview) return ['<figure class="unavailable"><p class="meta">Image indisponible hors ligne</p></figure>'];
    const img = `<img src="${escapeHtml(source(image.preview, position, index))}" width="${image.preview.width}" height="${image.preview.height}" alt="${escapeHtml(image.alt ?? 'Image du message')}">`;
    return [image.spoiler
      ? `<figure class="spoiler"><details><summary>Image masquée — spoiler · Afficher l’image</summary>${img}</details></figure>`
      : `<figure>${img}</figure>`];
  });
  return figures.length > 0 ? `<div class="images">${figures.join('')}</div>` : '';
}

/** « Messages sélectionnés », as in the note: every field escaped, links as text (never followed). */
function selectedMessagesHtml(messages: readonly SelectedMessage[], source: ImageSource): string {
  const items = messages.map((message, position) => {
    const media = mediaLabel(message);
    return '<li><div class="message">'
      + `<p class="meta">${messageDetails(message).map(escapeHtml).join(' · ')}</p>`
      + (message.text ? `<p class="text">${escapeHtml(message.text)}</p>` : '')
      + (media ? `<p class="meta">${escapeHtml(media)}</p>` : '')
      + (message.links.length > 0 ? `<p class="meta">Liens : ${message.links.map(escapeHtml).join(' ')}</p>` : '')
      + `</div>${imagesHtml(message, position, source)}</li>`;
  });
  return `<section id="selected-messages"><h2>Messages sélectionnés (${messages.length})</h2><ol>${items.join('')}</ol></section>`;
}

function selectedMessagesText(messages: readonly SelectedMessage[]): string {
  const title = `Messages sélectionnés (${messages.length})`;
  const items = messages.map((message, index) => {
    const media = mediaLabel(message);
    const images = message.media.flatMap((image) => (image.kind === 'image' ? [imageTag(image)] : []));
    const lines = [
      ...(message.text ? message.text.split('\n') : []),
      ...(media ? [media] : []),
      ...(images.length > 0 ? [images.join(' ')] : []),
      ...(message.links.length > 0 ? [`Liens : ${message.links.join(' ')}`] : []),
    ];
    const marker = `${index + 1}. `;
    return [marker + messageDetails(message).join(' · '), ...lines.map((line) => ' '.repeat(marker.length) + line)].join('\n');
  });
  return `${title}\n${'-'.repeat(title.length)}\n\n${items.join('\n\n')}\n`;
}

/**
 * A note as a standalone page: no script, no remote resource (its CSP forbids them anyway). The messages
 * selected in its conversation follow the note, outside <main id="note"> (never imported as note text),
 * with their image previews inline.
 */
export function noteDocument(note: Note, options: ExportOptions = {}): string {
  return renderDocument(note, options, inline);
}

function renderDocument(note: Note, { messages = new Map(), exportedAt = new Date() }: ExportOptions, source: ImageSource): string {
  const name = escapeHtml(displayName(note));
  const selected = messagesOf(note, messages);
  // Images only from the export itself: data URLs inline, files of the archive next to the page. Never a URL elsewhere.
  const images = selected?.some((message) => message.media.some((image) => image.preview)) ?? false;
  const imageSources = source === inline ? 'data:' : "'self' file:";
  return `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'${images ? `; img-src ${imageSources}` : ''}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${name}</title>
<style>body{font-family:system-ui,sans-serif;max-width:48rem;margin:2rem auto;padding:0 1rem;line-height:1.6}header p{color:#666;font-size:.875rem}${selected ? SELECTED_MESSAGES_CSS : ''}</style>
</head>
<body>
<header><h1>${name}</h1><p>Notes LeakZero · créée le ${formatDate(note.createdAt)} · modifiée le ${formatDate(note.updatedAt)} · exportée le <time datetime="${exportedAt.toISOString()}">${formatDate(exportedAt.getTime())}</time></p></header>
<main id="note">${sanitizeNoteHtml(note.html)}</main>
${selected ? `${selectedMessagesHtml(selected, source)}\n` : ''}</body>
</html>
`;
}

export function noteText(note: Note, { messages = new Map(), exportedAt = new Date() }: ExportOptions = {}): string {
  const name = displayName(note);
  const selected = messagesOf(note, messages);
  const text = `${name}\n${'='.repeat(Math.min(name.length, 80))}\nNotes LeakZero · exportée le ${formatDate(exportedAt.getTime())}\n\n${noteToText(note.html)}`;
  return selected ? `${text}\n${selectedMessagesText(selected)}` : text;
}

const filePath = (folder: 'html' | 'txt') => z.string().regex(new RegExp(`^${folder}/[a-z0-9-]+\\.${folder}$`));
const manifestEntry = noteSchema.omit({ html: true }).extend({ html: filePath('html'), txt: filePath('txt') });
const formatSchema = z.object({ format: z.literal(FORMAT), version: z.number().int() });
const manifestSchema = z.object({
  exportedAt: z.string(),
  includesTrash: z.boolean(),
  notes: z.array(z.unknown()).max(MAX_NOTES),
});

/** Every exported note with the messages selected in its own conversation (`messages`), and only those. */
export function exportArchive(notes: readonly Note[], { includeTrash, messages = new Map(), exportedAt = new Date() }: ExportOptions & { includeTrash: boolean }): Uint8Array {
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
    // Each image preview is a file of the archive, linked from the page by its relative path.
    const base = htmlPath.slice('html/'.length, -'.html'.length);
    const toFile: ImageSource = (preview, message, image) => {
      const [, type, data] = /^data:image\/(\w+);base64,(.*)$/.exec(preview.dataUrl)!;
      const path = `media/${base}-${message + 1}-${image + 1}.${type === 'jpeg' ? 'jpg' : type}`;
      files[path] = Uint8Array.from(atob(data), (char) => char.charCodeAt(0));
      return `../${path}`;
    };
    files[htmlPath] = strToU8(renderDocument(note, { messages, exportedAt }, toFile));
    files[txtPath] = strToU8(noteText(note, { messages, exportedAt }));
    return { ...metadata, html: htmlPath, txt: txtPath } satisfies z.infer<typeof manifestEntry>;
  });
  const manifest = { format: FORMAT, version: VERSION, exportedAt: exportedAt.toISOString(), includesTrash: includeTrash, notes: entries };
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
