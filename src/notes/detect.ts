import { CONVERSATION_ID, MAX_NAME_LENGTH, NOTES_ENABLED, type Conversation } from './model';

// Snapchat Web: `https://www.snapchat.com/web/<conversation uuid>`. The id only ever comes from the URL;
// the name from the header of the open conversation, or the page title. Selectors depend on Snapchat's
// markup: when it changes, the name is reported as missing (never guessed) and the note keeps the
// last name found. Nothing else is read: no messages, no media, no conversation list.

const PATH = /^\/web\/([^/]+)\/?$/;
const HEADER_NAME = ['main header :is(h1, h2, h3)', '[role="main"] header :is(h1, h2, h3)'];
const TITLE_DECORATIONS = /^\(\d+\)\s*|\s*[|·-]\s*Snapchat\s*$/g;
/** Mutations are handled at most this often: Snapchat's DOM changes with every message. */
const DEBOUNCE_MS = 250;

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
  let timer: ReturnType<typeof setTimeout> | undefined;
  const observer = new MutationObserver(() => schedule());

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
    const key = JSON.stringify(conversation);
    if (!conversation || key === last) return;
    last = key;
    api.runtime.sendMessage({ type: 'notes:conversation', conversation }).catch(() => {
      if (orphaned()) stop();
      else last = undefined;
    });
  }

  function schedule() {
    timer ??= setTimeout(check, DEBOUNCE_MS);
  }

  function setEnabled(value: boolean) {
    if (stopped || value === enabled) return;
    enabled = value;
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
    } catch {
      // Extension context already invalidated.
    }
  }

  doc.addEventListener('visibilitychange', onVisibility);
  api.storage.onChanged.addListener(onChanged);
  api.storage.local.get(NOTES_ENABLED).then(
    (items) => setEnabled(items[NOTES_ENABLED] === true),
    () => stop(),
  );
  return stop;
}
