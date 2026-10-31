// Commands sent to the service worker with chrome.runtime.sendMessage. State itself is never sent:
// every context reads chrome.storage.local, which the service worker updates.

export type NotesResponse<T = unknown> = { ok: true; result: T } | { ok: false; error: string };

export class NotesCommandError extends Error {
  override name = 'NotesCommandError';
}

/** Sends a command and returns its result; throws when the service worker reports a failure. */
export async function sendNotesCommand<T = void>(message: { type: `notes:${string}` } & Record<string, unknown>, api: typeof chrome = chrome): Promise<T> {
  const response = (await api.runtime.sendMessage(message)) as NotesResponse<T> | undefined;
  if (!response) throw new NotesCommandError('Le service LeakZero n’a pas répondu.');
  if (!response.ok) throw new NotesCommandError(response.error);
  return response.result;
}
