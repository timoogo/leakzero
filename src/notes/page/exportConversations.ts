import { exportConversations, type ExportedVideo, type ExportSummary } from '../documentExport';
import type { Note } from '../model';
import { readSelectedMessages } from '../selected';
import { createSelectionStore, type SelectionStore } from '../selections';
import { downloadFile } from './download';

/**
 * The extension's IndexedDB, opened by the Notes page to read the stored videos: same origin as the
 * service worker, so the files are read as bytes, without going through messaging (JSON only). The page
 * only reads; the service worker remains the only writer.
 */
let pageStore: Pick<SelectionStore, 'videos'> | undefined;

/**
 * Builds and downloads the documentary ZIP of `notes` (documentExport.ts), from local data only. Rejects when the
 * saved messages cannot be read (an export never leaves messages out silently); a video that cannot be
 * read is counted as missing, and named so in the documents.
 */
export async function downloadConversations(notes: readonly Note[], store: Pick<SelectionStore, 'videos'> = (pageStore ??= createSelectionStore())): Promise<ExportSummary> {
  const messages = await readSelectedMessages(notes.map((note) => note.conversationId));
  const conversations = await Promise.all(notes.map(async (note) => {
    const saved = (note.conversationId && messages.get(note.conversationId)) || [];
    const videos = new Map<string, readonly ExportedVideo[]>();
    for (const message of saved) {
      if (!message.media.some((media) => media.kind === 'video')) continue;
      videos.set(message.key, await store.videos(message.conversationId, message.key).catch(() => []));
    }
    return { note, messages: saved, videos };
  }));
  const { zip, summary } = exportConversations(conversations);
  downloadFile(`LeakZero-export-${new Date().toISOString().slice(0, 10)}.zip`, new Blob([zip as Uint8Array<ArrayBuffer>], { type: 'application/zip' }));
  return summary;
}

const plural = (count: number, word: string) => `${count} ${word}${count > 1 ? 's' : ''}`;

/** What to tell the user: never « terminé » while media are missing from the archive. */
export function exportReport({ conversations, files, missing }: ExportSummary): string {
  const done = `${plural(conversations, 'conversation')}, ${plural(files, 'fichier')} média`;
  return missing === 0
    ? `Export terminé : ${done}.`
    : `Export incomplet : ${done} ; ${plural(missing, 'média')} absent${missing > 1 ? 's' : ''} de l’archive (jamais capturé${missing > 1 ? 's' : ''} ou illisible${missing > 1 ? 's' : ''}), signalé${missing > 1 ? 's' : ''} dans conversation.html et conversation.txt.`;
}
