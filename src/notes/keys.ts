import { settingKey } from '../shared/keys';

// chrome.storage.local layout of the Notes module, under its own `notes:` prefix. One key per note, so
// saving a note never rewrites the others. Notes are written by the service worker only (see
// notes/store.ts); the Notes page owns `notes:window`.

export const NotesKeys = {
  /** Prefix of each note, followed by its internal id. */
  notePrefix: 'notes:note:',
  /** Manual order of the list (note ids); absent while sorted by recent activity. */
  order: 'notes:order',
  /**
   * Last Snapchat conversation detected, kept until another one is: `{ conversationId, name, tabId,
   * detectedAt }`. chrome.storage.local is per profile, so profiles never share it.
   */
  active: 'notes:active',
  /** Position and size of the Notes window: `{ left, top, width, height }`. */
  window: 'notes:window',
  /**
   * Message selection mode on Snapchat Web: the UUID of the conversation it is on for, else absent or
   * null. Written by the Notes page (« Sélectionner des messages » of a note) and by the « Terminer »
   * badge of the Snapchat content script; the selected messages themselves are in IndexedDB (selections.ts).
   */
  selecting: 'notes:selecting',
  /**
   * Last change of the selected messages: `{ conversationId, at }`, written by the service worker after
   * each selection or unselection, so that the Notes page reloads that conversation's messages from
   * IndexedDB (which has no change event). Holds no message.
   */
  selectionChanged: 'notes:selectionChanged',
} as const;

export function noteKey(id: string): string {
  return `${NotesKeys.notePrefix}${id}`;
}

// Kept free of dependencies: the Snapchat content script imports them (src/notes/detect.ts).

/** Primary switch of the module (src/modules/notes/module.yaml). */
export const NOTES_ENABLED = settingKey('notes', 'enabled');

/** Snapchat Web names conversations by a UUID, the last segment of `/web/<id>`. */
export const CONVERSATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const MAX_NAME_LENGTH = 200;
/** Of the text kept for a selected message. */
export const MAX_MESSAGE_TEXT = 100_000;

/** `notes:selecting`: the conversation the mode is on for, or null. Anything else (older `true`) is off. */
export function selectionTarget(value: unknown): string | null {
  return typeof value === 'string' && CONVERSATION_ID.test(value) ? value : null;
}
