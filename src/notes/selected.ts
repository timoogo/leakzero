import { sendNotesCommand } from './messages';
import type { SelectedMessage } from './model';

// How a selected message is described, the same in the note (page/SelectedMessages.tsx) and in its
// exports (archive.ts): only what Snapchat showed; a missing author or date is left out, never guessed.

export const MESSAGE_TYPE_LABELS: Record<SelectedMessage['type'], string> = {
  text: 'Texte', image: 'Image', video: 'Vidéo', media: 'Médias', unknown: 'Type inconnu',
};

const dateTime = new Intl.DateTimeFormat('fr-FR', { dateStyle: 'short', timeStyle: 'short' });
export const formatDateTime = (time: number | Date) => dateTime.format(time);

/** When the message was sent, as Snapchat showed it: its `datetime` when readable, else the shown label. */
export function sentLabel(message: SelectedMessage): string | null {
  if (message.sentAt) {
    const date = new Date(message.sentAt);
    if (!Number.isNaN(date.getTime())) return formatDateTime(date);
  }
  return message.timeLabel ?? message.sentAt;
}

/** « Image (Photo), Vidéo », or null without media. */
export function mediaLabel(message: SelectedMessage): string | null {
  if (message.media.length === 0) return null;
  return message.media.map((media) => `${media.kind === 'image' ? 'Image' : 'Vidéo'}${media.alt ? ` (${media.alt})` : ''}`).join(', ');
}

/** Author, send date, type and selection date, in that order; absent ones left out. */
export function messageDetails(message: SelectedMessage): string[] {
  const sent = sentLabel(message);
  return [
    ...(message.author ? [message.author] : []),
    ...(sent ? [`Envoyé : ${sent}`] : []),
    MESSAGE_TYPE_LABELS[message.type],
    `Sélectionné le ${formatDateTime(message.selectedAt)}`,
  ];
}

/**
 * The selected messages of each conversation, read from IndexedDB through the service worker with the
 * command the note's section uses (`notes:selectedMessages`), for the exports. Throws if one cannot be
 * read: an export never leaves messages out silently.
 */
export async function readSelectedMessages(conversationIds: Iterable<string | null>): Promise<Map<string, SelectedMessage[]>> {
  const ids = [...new Set([...conversationIds].filter((id): id is string => id !== null))];
  const lists = await Promise.all(ids.map((conversationId) => sendNotesCommand<SelectedMessage[]>({ type: 'notes:selectedMessages', conversationId })));
  return new Map(ids.map((id, index) => [id, lists[index]]));
}

type SelectedImage = SelectedMessage['media'][number];

/** How an image is listed in a TXT export: `[Image]`, `[Image — spoiler]` or `[Image indisponible]`. */
export function imageTag(image: SelectedImage): string {
  if (!image.preview) return '[Image indisponible]';
  return image.spoiler ? '[Image — spoiler]' : '[Image]';
}
