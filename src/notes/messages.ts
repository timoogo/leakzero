// Commands sent to the service worker with chrome.runtime.sendMessage. State itself is never sent:
// every context reads chrome.storage.local, which the service worker updates.

export type NotesResponse<T = unknown> = { ok: true; result: T } | { ok: false; error: string };

export class NotesCommandError extends Error {
  override name = 'NotesCommandError';
}

/** Chrome's error when no context listens: the service worker failed to start or runs another version. */
const NO_RECEIVER = /Receiving end does not exist|Could not establish connection/;
const RETRY_DELAY_MS = 200;

async function deliver(message: unknown, api: typeof chrome): Promise<unknown> {
  try {
    return await api.runtime.sendMessage(message);
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error);
    if (/Extension context invalidated/.test(text)) {
      throw new NotesCommandError('LeakZero a été rechargé ou mis à jour. Rechargez cette page.');
    }
    if (!NO_RECEIVER.test(text)) throw error;
    // A worker that is being stopped can miss a message; the next one starts it again.
    await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
    try {
      return await api.runtime.sendMessage(message);
    } catch {
      throw new NotesCommandError(
        'Le service d’arrière-plan de LeakZero ne répond pas. Ouvrez chrome://extensions, rechargez LeakZero et consultez ses erreurs éventuelles.',
      );
    }
  }
}

/** Sends a command and returns its result; throws when the service worker reports a failure. */
export async function sendNotesCommand<T = void>(message: { type: `notes:${string}` } & Record<string, unknown>, api: typeof chrome = chrome): Promise<T> {
  const response = (await deliver(message, api)) as NotesResponse<T> | undefined;
  if (!response) throw new NotesCommandError('Le service LeakZero n’a pas répondu.');
  if (!response.ok) throw new NotesCommandError(response.error);
  return response.result;
}
