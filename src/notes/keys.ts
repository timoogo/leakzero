// chrome.storage.local layout of the Notes module, under its own `notes:` prefix. One key per note, so
// saving a note never rewrites the others. Notes are written by the service worker only (see
// notes/store.ts); the Notes page owns `notes:window`.

export const NotesKeys = {
  /** Prefix of each note, followed by its internal id. */
  notePrefix: 'notes:note:',
  /** Manual order of the list (note ids); absent while sorted by recent activity. */
  order: 'notes:order',
  /** Last Snapchat conversation detected: `{ conversationId, name, detectedAt }`. */
  active: 'notes:active',
  /** Position and size of the Notes window: `{ left, top, width, height }`. */
  window: 'notes:window',
} as const;

export function noteKey(id: string): string {
  return `${NotesKeys.notePrefix}${id}`;
}
