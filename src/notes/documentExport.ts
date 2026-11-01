import { strToU8, zipSync, type Zippable } from 'fflate';
import { escapeHtml, slug } from './archive';
import { noteToText, sanitizeNoteHtml } from './content';
import { displayName, type Note, type SelectedMessage } from './model';
import { formatDateTime, messageDetails } from './selected';
import type { StoredVideo, VideoRef } from './selections';
import { sniffVideo } from './video';

// Documentary export: a ZIP readable offline, without LeakZero, one folder per conversation:
//   conversations/<name>-<id>/conversation.html   the note, then the saved messages, linking their media
//   conversations/<name>-<id>/conversation.txt    the same as plain text, with the media paths
//   conversations/<name>-<id>/medias/photo_001.jpg, video_001.mp4…   the stored files, byte for byte
// Not re-importable (the « Exporter tout » archive is). Images are the previews copied at selection
// (the only image LeakZero holds), videos the original files stored by video.ts. Nothing is requested.

/** A video stored for a message (selections.ts `videos`). */
export type ExportedVideo = Pick<VideoRef, 'media' | 'duration'> & { file: Pick<StoredVideo, 'sha256' | 'bytes' | 'mime' | 'size'> };

export interface ConversationData {
  note: Note;
  /** Saved messages of its conversation, in the order the note shows them. */
  messages: readonly SelectedMessage[];
  /** Stored videos, by message key. */
  videos: ReadonlyMap<string, readonly ExportedVideo[]>;
}

export interface ExportSummary {
  conversations: number;
  /** Media files written (each file once per conversation). */
  files: number;
  /** Media of the messages with no file in the archive (never captured, or unreadable). */
  missing: number;
}

/** A media of a message, as the documents show it: its path in the folder, or null when it is absent. */
interface MediaEntry {
  label: string;
  path: string | null;
}

const IMAGE_TYPES: [string, (bytes: Uint8Array) => boolean][] = [
  ['jpg', (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff],
  ['png', (b) => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47],
  ['webp', (b) => String.fromCharCode(...b.subarray(0, 4)) === 'RIFF' && String.fromCharCode(...b.subarray(8, 12)) === 'WEBP'],
];
const VIDEO_EXTENSIONS = { 'video/mp4': 'mp4', 'video/quicktime': 'mov', 'video/webm': 'webm' } as const;

/** The extension of the format the bytes really are, else the one their type claims. */
function imageExtension(bytes: Uint8Array, type: string): string {
  return IMAGE_TYPES.find(([, test]) => test(bytes))?.[0] ?? (type === 'jpeg' ? 'jpg' : type);
}
function videoExtension(bytes: Uint8Array, mime: string): string {
  const sniffed = sniffVideo(bytes) ?? mime.split(';')[0].trim().toLowerCase();
  return VIDEO_EXTENSIONS[sniffed as keyof typeof VIDEO_EXTENSIONS] ?? 'bin';
}

const counter = (n: number) => String(n).padStart(3, '0');

/**
 * The media files of one conversation and, for each message, what each media points to. A file is
 * written once per conversation, however many messages hold it: images by their bytes, videos by hash.
 */
function planMedia({ messages, videos }: ConversationData) {
  const files: Zippable = {};
  const paths = new Map<string, string>();
  let photos = 0;
  let clips = 0;
  let missing = 0;
  const entries = messages.map((message) => message.media.map((media, index): MediaEntry => {
    const alt = media.alt ? ` (${media.alt})` : '';
    if (media.kind === 'image') {
      const label = `Image${alt}${media.spoiler ? ' — spoiler' : ''}`;
      const parsed = media.preview && /^data:image\/(\w+);base64,(.*)$/.exec(media.preview.dataUrl);
      if (!parsed) {
        missing++;
        return { label: `${label} — non capturée`, path: null };
      }
      let path = paths.get(`image:${parsed[2]}`);
      if (!path) {
        const bytes = Uint8Array.from(atob(parsed[2]), (char) => char.charCodeAt(0));
        path = `medias/photo_${counter(++photos)}.${imageExtension(bytes, parsed[1])}`;
        files[path] = bytes;
        paths.set(`image:${parsed[2]}`, path);
      }
      return { label: `${label} — aperçu enregistré à la sélection`, path };
    }
    const video = videos.get(message.key)?.find((candidate) => candidate.media === index);
    if (!video) {
      missing++;
      return { label: `Vidéo${alt} — non enregistrée`, path: null };
    }
    let path = paths.get(`video:${video.file.sha256}`);
    if (!path) {
      const bytes = new Uint8Array(video.file.bytes);
      path = `medias/video_${counter(++clips)}.${videoExtension(bytes, video.file.mime)}`;
      // Stored, not deflated: the bytes are already compressed, and are kept exactly as they are.
      files[path] = [bytes, { level: 0 }];
      paths.set(`video:${video.file.sha256}`, path);
    }
    const duration = video.duration === null ? '' : `, ${video.duration.toLocaleString('fr-FR')} s`;
    return { label: `Vidéo${alt} — ${video.file.mime.split(';')[0]}, ${video.file.size} octets${duration}`, path };
  }));
  return { files, entries, written: photos + clips, missing };
}

const CSS = 'body{font-family:system-ui,sans-serif;max-width:48rem;margin:2rem auto;padding:0 1rem;line-height:1.6}'
  + 'header p,.meta{color:#666;font-size:.875rem}.meta,.text{margin:0}.text{white-space:pre-wrap;overflow-wrap:anywhere}'
  + '#messages>ol>li{margin-bottom:1rem}.missing{color:#a00}';

function summaryLine(messages: number, entries: MediaEntry[][]): string {
  const all = entries.flat();
  const absent = all.filter((entry) => entry.path === null).length;
  return `${messages} message${messages > 1 ? 's' : ''} enregistré${messages > 1 ? 's' : ''} · ${all.length - absent} média${all.length - absent > 1 ? 's' : ''} inclus`
    + (absent > 0 ? ` · ${absent} média${absent > 1 ? 's' : ''} absent${absent > 1 ? 's' : ''} de l’archive` : '');
}

/** The conversation as a static page: no script, no remote resource, every field escaped, media as relative links. */
function conversationHtml(data: ConversationData, entries: MediaEntry[][], exportedAt: Date): string {
  const { note, messages } = data;
  const name = escapeHtml(displayName(note));
  const noteHtml = sanitizeNoteHtml(note.html);
  const items = messages.map((message, position) => {
    const medias = entries[position].map((entry) => (entry.path
      ? `<li><a href="${escapeHtml(entry.path)}">${escapeHtml(entry.label)}</a> <span class="meta">${escapeHtml(entry.path)}</span></li>`
      : `<li class="missing">${escapeHtml(entry.label)}</li>`));
    return '<li>'
      + `<p class="meta">${messageDetails(message).map(escapeHtml).join(' · ')}</p>`
      + (message.text ? `<p class="text">${escapeHtml(message.text)}</p>` : '')
      + (medias.length > 0 ? `<ul class="medias">${medias.join('')}</ul>` : '')
      + (message.links.length > 0 ? `<p class="meta">Liens : ${message.links.map(escapeHtml).join(' ')}</p>` : '')
      + '</li>';
  });
  return `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${name}</title>
<style>${CSS}</style>
</head>
<body>
<header><h1>${name}</h1><p>Conversation Snapchat · export LeakZero du <time datetime="${exportedAt.toISOString()}">${formatDateTime(exportedAt)}</time> · ${escapeHtml(summaryLine(messages.length, entries))}</p></header>
${noteHtml ? `<section id="note"><h2>Note</h2>${noteHtml}</section>\n` : ''}<section id="messages"><h2>Messages enregistrés (${messages.length})</h2>${messages.length > 0 ? `<ol>${items.join('')}</ol>` : '<p>Aucun message enregistré.</p>'}</section>
</body>
</html>
`;
}

function conversationText(data: ConversationData, entries: MediaEntry[][], exportedAt: Date): string {
  const { note, messages } = data;
  const name = displayName(note);
  const noteText = noteToText(note.html);
  const title = `Messages enregistrés (${messages.length})`;
  const items = messages.map((message, position) => {
    const marker = `${position + 1}. `;
    const lines = [
      ...(message.text ? message.text.split('\n') : []),
      ...entries[position].map((entry) => (entry.path ? `[${entry.label}] ${entry.path}` : `[${entry.label}]`)),
      ...(message.links.length > 0 ? [`Liens : ${message.links.join(' ')}`] : []),
    ];
    return [marker + messageDetails(message).join(' · '), ...lines.map((line) => ' '.repeat(marker.length) + line)].join('\n');
  });
  return `${name}\n${'='.repeat(Math.min(name.length, 80))}\nConversation Snapchat · export LeakZero du ${formatDateTime(exportedAt)}\n${summaryLine(messages.length, entries)}\n\n`
    + (noteText ? `Note\n----\n\n${noteText}\n` : '')
    + `${title}\n${'-'.repeat(title.length)}\n\n${items.length > 0 ? `${items.join('\n\n')}\n` : 'Aucun message enregistré.\n'}`;
}

/**
 * The folder of a note's conversation: its name reduced to `[a-z0-9-]` (never a `/`, `..` or a reserved
 * character) and the start of the note's id, so that two conversations with the same name stay apart.
 */
export function conversationFolder(note: Note): string {
  return `${slug(displayName(note)) || 'conversation'}-${note.id.slice(0, 8)}`;
}

/** The documentary ZIP of `conversations`, and what it holds. Reads nothing, changes nothing. */
export function exportConversations(conversations: readonly ConversationData[], exportedAt = new Date()): { zip: Uint8Array; summary: ExportSummary } {
  const files: Zippable = {};
  const used = new Set<string>();
  const summary: ExportSummary = { conversations: conversations.length, files: 0, missing: 0 };
  for (const data of conversations) {
    const base = conversationFolder(data.note);
    let folder = base;
    for (let index = 2; used.has(folder); index++) folder = `${base}-${index}`;
    used.add(folder);
    const media = planMedia(data);
    summary.files += media.written;
    summary.missing += media.missing;
    for (const [path, file] of Object.entries(media.files)) files[`conversations/${folder}/${path}`] = file;
    files[`conversations/${folder}/conversation.html`] = strToU8(conversationHtml(data, media.entries, exportedAt));
    files[`conversations/${folder}/conversation.txt`] = strToU8(conversationText(data, media.entries, exportedAt));
  }
  return { zip: zipSync(files), summary };
}
