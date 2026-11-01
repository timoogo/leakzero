import { z } from 'zod';
import { CONVERSATION_ID, conversationSchema, customNameSchema, MAX_HTML_LENGTH, messageKeySchema, messageSchema, noteIdSchema, noteSchema, NOTES_ENABLED } from './model';
import { NotesKeys } from './keys';
import type { NotesResponse } from './messages';
import { createSelectionStore, type SelectionStore } from './selections';
import { createNotesStore, NotesStoreError } from './store';
import { fromBase64, MAX_VIDEO_BASE64, MAX_VIDEO_BYTES, VIDEO_MIME } from './video';
import { closeNotesWindow } from './window';

/** Pages the Snapchat content script runs on (manifest.config.ts). */
const SNAPCHAT_HOSTS = ['www.snapchat.com', 'snapchat.com'];

const id = z.strictObject({ id: noteIdSchema });

const conversationId = z.string().regex(CONVERSATION_ID);

/** A video captured by the Snapchat content script (video.ts): checked again here, bytes included. */
const capturedVideo = z.strictObject({
  mime: z.string().regex(VIDEO_MIME),
  size: z.number().int().min(1).max(MAX_VIDEO_BYTES),
  data: z.string().max(MAX_VIDEO_BASE64).regex(/^[A-Za-z0-9+/]*={0,2}$/),
  width: z.number().int().min(1).max(16_384).nullable(),
  height: z.number().int().min(1).max(16_384).nullable(),
  duration: z.number().positive().max(86_400).nullable(),
});

/** Sent by the Snapchat content script (src/content/notes.ts). */
const contentCommand = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('notes:conversation'), conversation: conversationSchema }),
  // Message selection (src/notes/selection.ts).
  z.strictObject({ type: z.literal('notes:select'), message: messageSchema }),
  z.strictObject({ type: z.literal('notes:unselect'), conversationId, key: messageKeySchema }),
  z.strictObject({ type: z.literal('notes:selectedKeys'), conversationId }),
  // Original file of a video of a selected message (video.ts).
  z.strictObject({ type: z.literal('notes:storeVideo'), conversationId, key: messageKeySchema, media: z.number().int().min(0).max(49), video: capturedVideo }),
]);

/** Sent by the extension's own pages: the popup and the Notes page. */
const pageCommand = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('notes:save'), ...id.shape, html: z.string().max(MAX_HTML_LENGTH) }),
  z.strictObject({ type: z.literal('notes:rename'), ...id.shape, customName: customNameSchema.nullable() }),
  z.strictObject({ type: z.literal('notes:refreshName'), ...id.shape }),
  z.strictObject({ type: z.literal('notes:trash'), ...id.shape }),
  z.strictObject({ type: z.literal('notes:restore'), ...id.shape }),
  z.strictObject({ type: z.literal('notes:purge'), ...id.shape }),
  // Messages selected on Snapchat Web (selections.ts), shown in the note of their conversation.
  z.strictObject({ type: z.literal('notes:selectedMessages'), conversationId }),
  z.strictObject({
    type: z.literal('notes:setSpoiler'), conversationId, key: messageKeySchema, media: z.number().int().min(0).max(49), spoiler: z.boolean(),
  }),
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

/** Snapchat Web tabs whose URL shows the conversation: `/web/<uuid>`, with or without www. */
const conversationTabs = (id: string) => SNAPCHAT_HOSTS.map((host) => `https://${host}/web/${id}*`);

/** Whether the tab that sent a message shows the conversation `id` (`/web/<id>`). */
function showsConversation(url: string | undefined, id: string): boolean {
  try {
    return new URL(url ?? '').pathname.replace(/\/$/, '') === `/web/${id}`;
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
export function registerNotesBackground(api: typeof chrome = chrome, selections: SelectionStore = createSelectionStore()): void {
  const store = createNotesStore(api);
  const enabled = async () => (await api.storage.local.get(NOTES_ENABLED))[NOTES_ENABLED] === true;
  const requireEnabled = async () => {
    if (!(await enabled())) throw new NotesStoreError('Le module Notes est désactivé.');
  };

  /**
   * « Actualiser le nom Snapchat »: asks the Notes script of each Snapchat tab showing the conversation
   * for the name it shows now. A tab answers only for the conversation it shows (detect.ts), so a tab
   * that moved to another conversation, even one with the same name, gives nothing.
   */
  async function refreshName(id: string): Promise<{ name: string }> {
    const note = await store.get(id);
    const conversationId = note.conversationId;
    if (!conversationId) throw new NotesStoreError('Cette fiche n’est liée à aucune conversation Snapchat.');
    const tabs = await api.tabs.query({ url: conversationTabs(conversationId) });
    if (tabs.length === 0) {
      throw new NotesStoreError('Aucun onglet Snapchat Web n’affiche cette conversation. Ouvrez-la sur Snapchat Web, puis réessayez ; le nom actuel est conservé.');
    }
    let reached = false;
    for (const tab of tabs) {
      if (tab.id === undefined) continue;
      const response = await api.tabs.sendMessage(tab.id, { type: 'notes:readName', conversationId }).catch(() => undefined) as { ok?: boolean; name?: unknown } | undefined;
      if (!response?.ok) continue;
      reached = true;
      const name = conversationSchema.shape.name.safeParse(response.name);
      if (name.success && name.data !== null) {
        await store.syncName(id, conversationId, name.data);
        return { name: name.data };
      }
    }
    throw new NotesStoreError(reached
      ? 'Snapchat n’affiche pas le nom de cette conversation pour l’instant ; le nom actuel est conservé.'
      : 'LeakZero ne répond pas dans l’onglet Snapchat. Rechargez l’onglet Snapchat, puis réessayez ; le nom actuel est conservé.');
  }

  async function handle(message: unknown, sender: chrome.runtime.MessageSender): Promise<unknown> {
    if (sender.id !== api.runtime.id) throw new NotesStoreError('Expéditeur inconnu.');
    const fromExtension = sender.url?.startsWith(api.runtime.getURL('')) === true;
    if (!fromExtension) {
      // Web pages only ever report the open conversation and select its messages, and only from Snapchat.
      if (!isSnapchat(sender.url)) throw new NotesStoreError('Page non autorisée.');
      const parsed = contentCommand.safeParse(message);
      if (!parsed.success) throw new NotesStoreError('Commande invalide.');
      const command = parsed.data;
      await requireEnabled();
      if (command.type === 'notes:conversation') {
        await store.detect(command.conversation, sender.tab?.id ?? null);
        // Temporary diagnostics (Notes detection in real Snapchat Web).
        console.info(`[LeakZero Notes] conversation ${command.conversation.id.slice(0, 8)} enregistrée (onglet ${sender.tab?.id})`);
        return null;
      }
      // A tab only reads and changes the selection of the conversation it shows.
      const target = command.type === 'notes:select' ? command.message.conversationId : command.conversationId;
      if (!showsConversation(sender.url, target)) throw new NotesStoreError('Cet onglet n’affiche pas cette conversation.');
      // Tells the Notes page to reload this conversation's messages.
      const changed = () => api.storage.local.set({ [NotesKeys.selectionChanged]: { conversationId: target, at: Date.now() } });
      switch (command.type) {
        case 'notes:select': return selections.select(command.message).then(changed).then(() => null);
        case 'notes:unselect': return selections.unselect(command.conversationId, command.key).then(changed).then(() => null);
        case 'notes:selectedKeys': return (await selections.list(command.conversationId)).map((record) => record.key);
        case 'notes:storeVideo': {
          const { data, size, ...video } = command.video;
          let bytes: Uint8Array<ArrayBuffer>;
          try {
            bytes = fromBase64(data);
          } catch {
            throw new NotesStoreError('Vidéo illisible.');
          }
          if (bytes.length !== size) throw new NotesStoreError('Vidéo incomplète.');
          // Not shown by the Notes page yet: no `selectionChanged`.
          return selections.storeVideo(command.conversationId, command.key, command.media, bytes, video);
        }
      }
    }
    const parsed = pageCommand.safeParse(message);
    if (!parsed.success) throw new NotesStoreError('Commande invalide.');
    const command = parsed.data;
    // Edits stay allowed while disabled: a save still pending when the module is turned off is kept.
    switch (command.type) {
      case 'notes:save': return store.save(command.id, command.html);
      case 'notes:rename': return store.rename(command.id, command.customName);
      case 'notes:refreshName': return refreshName(command.id);
      case 'notes:trash': return store.trash(command.id);
      case 'notes:restore': return store.restore(command.id);
      case 'notes:purge': return store.purge(command.id);
      case 'notes:selectedMessages': return selections.list(command.conversationId);
      case 'notes:setSpoiler':
        await selections.setSpoiler(command.conversationId, command.key, command.media, command.spoiler);
        // Other open Notes pages show the new status too.
        await api.storage.local.set({ [NotesKeys.selectionChanged]: { conversationId: command.conversationId, at: Date.now() } });
        return null;
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
