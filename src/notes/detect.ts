import { CONVERSATION_ID, MAX_NAME_LENGTH, NOTES_ENABLED } from './keys';
import type { Conversation } from './model';

// Snapchat Web: `https://www.snapchat.com/web/<conversation uuid>`. The id only ever comes from the URL;
// the name from the header of the open conversation, or the page title. Selectors depend on Snapchat's
// markup: when it changes, the name is reported as missing (never guessed) and the note keeps the
// last name found. Nothing else is read: no messages, no media, no conversation list.

const PATH = /^\/web\/([^/]+)\/?$/;
const HEADER_NAME = ['main header :is(h1, h2, h3)', '[role="main"] header :is(h1, h2, h3)'];
const TITLE_DECORATIONS = /^\(\d+\)\s*|\s*[|·-]\s*Snapchat\s*$/g;
/** Mutations are handled at most this often: Snapchat's DOM changes with every message. */
const DEBOUNCE_MS = 250;
/** Delay before sending again a conversation the service worker did not take. */
const RETRY_MS = 2000;

// Temporary diagnostics, to tell apart a script that is not injected (no "script chargé" in the tab's
// console), a detection that fails and a delivery that fails. Never logs page content.
let lastLog: string | undefined;
function diagnose(level: 'info' | 'warn', message: string) {
  if (message === lastLog) return;
  lastLog = message;
  console[level](`[LeakZero Notes] ${message}`);
}

function asName(text: string | null | undefined): string | null {
  const name = (text ?? '').replace(/\s+/g, ' ').trim();
  return name.length > 0 && name.length <= MAX_NAME_LENGTH && name !== 'Snapchat' ? name : null;
}

/** The conversation open in `doc`, or null outside a conversation. */
export function readConversation(doc: Document): Conversation | null {
  const id = PATH.exec(doc.location.pathname)?.[1];
  if (!id || !CONVERSATION_ID.test(id)) return null;
  for (const selector of HEADER_NAME) {
    const name = asName(doc.querySelector(selector)?.textContent);
    if (name) return { id, name };
  }
  return { id, name: asName(doc.title.replace(TITLE_DECORATIONS, '')) };
}

/**
 * Reports the conversation open in `doc` to the service worker whenever it changes, while the Notes
 * module is enabled, whether or not the Notes window is open. Returns a function that stops.
 */
export function startConversationTracking(doc: Document, api: typeof chrome = chrome): () => void {
  let enabled = false;
  let stopped = false;
  let last: string | undefined;
  let lastConversation: Conversation | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const observer = new MutationObserver(() => schedule());
  lastLog = undefined;
  diagnose('info', `script chargé sur ${doc.location.host}${doc.location.pathname}`);

  const orphaned = () => {
    try {
      return !api.runtime?.id;
    } catch {
      return true;
    }
  };

  function check() {
    timer = undefined;
    if (stopped || !enabled) return;
    // Extension reloaded or updated: the new version's script takes over (see background/index.ts).
    if (orphaned()) return stop();
    const conversation = readConversation(doc);
    // Snapchat may hide the conversation (window left, popup opened…): the last one stays the active
    // one until another valid conversation is open; a name that disappears is not reported either.
    if (!conversation) {
      diagnose('info', `aucune conversation dans l’URL ${doc.location.pathname} (attendu : /web/<uuid>)`);
      return;
    }
    if (conversation.name === null && lastConversation?.id === conversation.id) return;
    const key = JSON.stringify(conversation);
    if (key === last) return;
    last = key;
    lastConversation = conversation;
    const label = `conversation ${conversation.id.slice(0, 8)}`;
    diagnose('info', `${label} détectée, ${conversation.name === null ? `nom introuvable (nom provisoire) : aucun de ${HEADER_NAME.join(' ; ')}, titre de page sans nom` : 'nom trouvé'}`);
    const retry = (reason: string) => {
      diagnose('warn', `envoi de la ${label} au service worker échoué : ${reason}`);
      if (orphaned()) return stop();
      // Sent again even if Snapchat no longer changes the page (window in the background).
      if (last === key) {
        // Not recorded: sent again even without its name (the service worker keeps a known name).
        last = undefined;
        lastConversation = null;
        clearTimeout(timer);
        timer = setTimeout(check, RETRY_MS);
      }
    };
    api.runtime.sendMessage({ type: 'notes:conversation', conversation }).then(
      (response: { ok?: boolean; error?: string } | undefined) => {
        if (response?.ok) diagnose('info', `${label} enregistrée`);
        else retry(response?.error ?? 'pas de réponse');
      },
      (error: unknown) => retry(error instanceof Error ? error.message : String(error)),
    );
  }

  function schedule() {
    timer ??= setTimeout(check, DEBOUNCE_MS);
  }

  function setEnabled(value: boolean) {
    if (stopped || value === enabled) return;
    enabled = value;
    diagnose('info', enabled ? 'module activé, suivi démarré' : 'module désactivé, suivi arrêté');
    if (enabled) {
      last = undefined;
      observer.observe(doc.documentElement, { childList: true, subtree: true, characterData: true });
      schedule();
    } else {
      observer.disconnect();
    }
  }

  // With several Snapchat tabs, the one brought to the front becomes the active conversation.
  const onVisibility = () => {
    if (doc.visibilityState !== 'visible') return;
    last = undefined;
    schedule();
  };

  // The service worker asks for the name shown now (« Actualiser le nom Snapchat »): answered only for
  // the conversation open in this tab, so two conversations with the same name are never mixed up.
  const onMessage = (message: unknown, sender: chrome.runtime.MessageSender, sendResponse: (response: unknown) => void) => {
    const request = message as { type?: unknown; conversationId?: unknown } | null;
    if (request?.type !== 'notes:readName' || sender.id !== api.runtime.id || sender.tab) return false;
    const conversation = readConversation(doc);
    const name = conversation && conversation.id === request.conversationId ? conversation.name : null;
    diagnose('info', `nom demandé : ${name === null ? 'introuvable' : 'trouvé'}`);
    sendResponse({ ok: true, name });
    return false;
  };

  const onChanged = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
    if (area === 'local' && NOTES_ENABLED in changes) setEnabled(changes[NOTES_ENABLED].newValue === true);
  };

  function stop() {
    if (stopped) return;
    stopped = true;
    observer.disconnect();
    clearTimeout(timer);
    doc.removeEventListener('visibilitychange', onVisibility);
    try {
      api.storage.onChanged.removeListener(onChanged);
      api.runtime.onMessage.removeListener(onMessage);
    } catch {
      // Extension context already invalidated.
    }
  }

  doc.addEventListener('visibilitychange', onVisibility);
  api.storage.onChanged.addListener(onChanged);
  api.runtime.onMessage.addListener(onMessage);
  api.storage.local.get(NOTES_ENABLED).then(
    (items) => setEnabled(items[NOTES_ENABLED] === true),
    (error: unknown) => {
      diagnose('warn', `réglages illisibles, suivi arrêté : ${error instanceof Error ? error.message : String(error)}`);
      stop();
    },
  );
  if (!enabled) diagnose('info', 'lecture des réglages…');
  return stop;
}
