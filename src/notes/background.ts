import { z } from 'zod';
import { conversationSchema, MAX_HTML_LENGTH, noteIdSchema, noteSchema, NOTES_ENABLED } from './model';
import type { NotesResponse } from './messages';
import { createNotesStore, NotesStoreError } from './store';
import { closeNotesWindow } from './window';

/** Pages the Snapchat content script runs on (manifest.config.ts). */
const SNAPCHAT_HOSTS = ['www.snapchat.com', 'snapchat.com'];

const id = z.strictObject({ id: noteIdSchema });

/** Sent by the Snapchat content script (src/content/notes.ts). */
const contentCommand = z.strictObject({ type: z.literal('notes:conversation'), conversation: conversationSchema });

/** Sent by the extension's own pages: the popup and the Notes page. */
const pageCommand = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('notes:save'), ...id.shape, html: z.string().max(MAX_HTML_LENGTH) }),
  z.strictObject({ type: z.literal('notes:trash'), ...id.shape }),
  z.strictObject({ type: z.literal('notes:restore'), ...id.shape }),
  z.strictObject({ type: z.literal('notes:purge'), ...id.shape }),
  z.strictObject({ type: z.literal('notes:setOrder'), order: z.array(noteIdSchema).max(10_000).nullable() }),
  z.strictObject({
    type: z.literal('notes:import'),
    // Parsed and sanitized by the Notes page (src/notes/archive.ts); checked again here.
    notes: z.array(noteSchema).max(5000).refine(unique, 'duplicate note or conversation'),
    resolutions: z.record(noteIdSchema, z.enum(['keep', 'replace', 'both'])),
  }),
]);

function unique(notes: z.infer<typeof noteSchema>[]): boolean {
  const conversations = notes.flatMap((note) => (note.conversationId ? [note.conversationId] : []));
  return new Set(notes.map((note) => note.id)).size === notes.length && new Set(conversations).size === conversations.length;
}

function isSnapchat(url: string | undefined): boolean {
  try {
    const parsed = new URL(url ?? '');
    return parsed.protocol === 'https:' && SNAPCHAT_HOSTS.includes(parsed.hostname);
  } catch {
    return false;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Notes side of the service worker. Listeners are registered synchronously at startup so that Chrome
 * can wake the worker for them; all state lives in chrome.storage.local.
 */
export function registerNotesBackground(api: typeof chrome = chrome): void {
  const store = createNotesStore(api);
  const enabled = async () => (await api.storage.local.get(NOTES_ENABLED))[NOTES_ENABLED] === true;
  const requireEnabled = async () => {
    if (!(await enabled())) throw new NotesStoreError('Le module Notes est désactivé.');
  };

  async function handle(message: unknown, sender: chrome.runtime.MessageSender): Promise<unknown> {
    if (sender.id !== api.runtime.id) throw new NotesStoreError('Expéditeur inconnu.');
    const fromExtension = sender.url?.startsWith(api.runtime.getURL('')) === true;
    if (!fromExtension) {
      // Web pages only ever report the open conversation, and only from Snapchat.
      if (!isSnapchat(sender.url)) throw new NotesStoreError('Page non autorisée.');
      const command = contentCommand.safeParse(message);
      if (!command.success) throw new NotesStoreError('Conversation invalide.');
      await requireEnabled();
      await store.detect(command.data.conversation, sender.tab?.id ?? null);
      // Temporary diagnostics (Notes detection in real Snapchat Web).
      console.info(`[LeakZero Notes] conversation ${command.data.conversation.id.slice(0, 8)} enregistrée (onglet ${sender.tab?.id})`);
      return null;
    }
    const parsed = pageCommand.safeParse(message);
    if (!parsed.success) throw new NotesStoreError('Commande invalide.');
    const command = parsed.data;
    // Edits stay allowed while disabled: a save still pending when the module is turned off is kept.
    switch (command.type) {
      case 'notes:save': return store.save(command.id, command.html);
      case 'notes:trash': return store.trash(command.id);
      case 'notes:restore': return store.restore(command.id);
      case 'notes:purge': return store.purge(command.id);
      case 'notes:setOrder': return store.setOrder(command.order);
      case 'notes:import': return store.import(command.notes, command.resolutions);
    }
  }

  api.runtime.onMessage.addListener((message, sender, sendResponse) => {
    const type = (message as { type?: unknown } | null)?.type;
    if (typeof type !== 'string' || !type.startsWith('notes:')) return false;
    handle(message, sender).then(
      (result) => sendResponse({ ok: true, result: result ?? null } satisfies NotesResponse),
      (error: unknown) => {
        // Temporary diagnostics (Notes detection in real Snapchat Web).
        if (type === 'notes:conversation') console.warn(`[LeakZero Notes] conversation refusée : ${errorMessage(error)} (${sender.url ? new URL(sender.url).host : 'sans URL'})`);
        sendResponse({ ok: false, error: errorMessage(error) } satisfies NotesResponse);
      },
    );
    return true;
  });

  // Turning the module off closes the window (content scripts stop by themselves); no data is removed.
  api.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && NOTES_ENABLED in changes && changes[NOTES_ENABLED].newValue !== true) {
      closeNotesWindow(api).catch((error: unknown) => console.warn('LeakZero: Notes window not closed', error));
    }
  });
}
