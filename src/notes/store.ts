import { noteKey, NotesKeys } from './keys';
import { readNotes, readOrder, unnamedConversation, type Conversation, type Note } from './model';

export class NotesStoreError extends Error {
  override name = 'NotesStoreError';
}

/**
 * Every write to the notes, run by the service worker one at a time: a write reads the notes, then
 * writes in a single (atomic) chrome.storage.local.set, so two writes can never interleave and
 * overwrite each other (two Snapchat tabs, the Notes page saving while a conversation is detected…).
 * Nothing is kept in memory: the service worker can stop between two writes.
 */
export function createNotesStore(api: typeof chrome = chrome) {
  const local = api.storage.local;
  let queue: Promise<unknown> = Promise.resolve();
  const exclusive = <T>(write: () => Promise<T>): Promise<T> => {
    const run = queue.then(write);
    queue = run.catch(() => undefined);
    return run;
  };

  async function existing(id: string): Promise<Note> {
    const note = readNotes(await local.get(noteKey(id)))[0];
    if (!note) throw new NotesStoreError('Cette fiche n’existe plus.');
    return note;
  }

  const update = (id: string, change: (note: Note) => Partial<Note>) =>
    exclusive(async () => {
      const note = await existing(id);
      await local.set({ [noteKey(id)]: { ...note, ...change(note) } });
    });

  return {
    /**
     * Records the conversation open on Snapchat and creates its (empty) note the first time. A note in
     * the trash is left there: the Notes page offers to restore it.
     */
    detect: (conversation: Conversation) =>
      exclusive(async () => {
        const now = Date.now();
        const note = readNotes(await local.get(null)).find((candidate) => candidate.conversationId === conversation.id);
        // A name missing from the page never replaces a known one.
        const name = conversation.name ?? note?.name ?? unnamedConversation(conversation.id);
        const patch: Record<string, unknown> = { [NotesKeys.active]: { conversationId: conversation.id, name, detectedAt: now } };
        if (!note) {
          const id = crypto.randomUUID();
          patch[noteKey(id)] = {
            id, conversationId: conversation.id, name, html: '', createdAt: now, updatedAt: now, lastSeenAt: now, trashedAt: null,
          } satisfies Note;
        } else if (note.trashedAt === null) {
          patch[noteKey(note.id)] = { ...note, name, lastSeenAt: now } satisfies Note;
        }
        await local.set(patch);
      }),

    save: (id: string, html: string) => update(id, () => ({ html, updatedAt: Date.now() })),
    trash: (id: string) => update(id, () => ({ trashedAt: Date.now() })),
    restore: (id: string) => update(id, () => ({ trashedAt: null })),

    purge: (id: string) =>
      exclusive(async () => {
        const note = await existing(id);
        if (note.trashedAt === null) throw new NotesStoreError('Seule une fiche de la corbeille peut être supprimée définitivement.');
        const order = readOrder(await local.get(NotesKeys.order));
        if (order?.includes(id)) await local.set({ [NotesKeys.order]: order.filter((other) => other !== id) });
        await local.remove(noteKey(id));
      }),

    /** `null` goes back to the recent-activity sort. */
    setOrder: (order: string[] | null) => exclusive(() => (order ? local.set({ [NotesKeys.order]: order }) : local.remove(NotesKeys.order))),
  };
}

export type NotesStore = ReturnType<typeof createNotesStore>;
