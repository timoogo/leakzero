import { isBitmojiAvatar } from '../maskers/media';
import { clippingAncestors, clipRect } from '../maskers/overlay';
import { asName, CLOSE_CHAT, readConversation } from './detect';
import { MAX_MESSAGE_TEXT, NOTES_ENABLED, NotesKeys, selectionTarget } from './keys';
import { sendNotesCommand } from './messages';
import { imagePreviewSchema, type ImagePreview, type Message } from './model';

// Message selection on Snapchat Web. Like detect.ts, only structural and semantic anchors are used, never
// Snapchat's generated classes or ids:
// - the chat: the smallest container around the single « Close Chat » button that holds a list;
// - a message: an innermost list item (`li`, `[role="listitem"]`) of that chat, outside navigation;
// - its sender: the last `<header>` before it in its group; its time: its own `<time>`.
// Snapchat shows no message id, so a message is known by a fingerprint of what it shows and its rank
// among identical ones (`messageKey`). Nothing is read or listened to while the mode is off.

const LIST = 'ul, ol, [role="list"]';
const ITEM = 'li, [role="listitem"]';
/**
 * Never messages: navigation, and the menus and option lists of controls. Downshift (the conversation
 * menu of the header) always renders its `<ul role="listbox">`, even closed: counted as a list, it made
 * the header itself pass for the chat, with no message in it.
 */
const NOT_MESSAGES = 'nav, [role="navigation"], [role="listbox"], [role="menu"], [role="menubar"], [role="tree"], [role="tablist"], [role="option"], [role="menuitem"]';
/** Never part of the text of a message: sender header, time, icons, code. */
const NOT_TEXT = 'header, time, [aria-hidden="true"], script, style, noscript, template';
const SAFE_LINK = /^(https?:|mailto:)/i;
const MAX_MEDIA = 50;
const MAX_LINKS = 50;
/** Mutations are handled at most this often: Snapchat's DOM changes with every message. */
const DEBOUNCE_MS = 250;

export const SELECTED_ATTRIBUTE = 'data-leakzero-selected';
export const SELECTABLE_ATTRIBUTE = 'data-leakzero-selectable';
/** Fixed layer above the page, outside Snapchat's tree: checkboxes and badge. */
export const LAYER_TAG = 'leakzero-selection';
/** Side of a checkbox, and its distance to the message. */
const BOX_SIZE = 18;
const BOX_GAP = 8;
const SELECTION_CSS = `
[${SELECTABLE_ATTRIBUTE}] { cursor: pointer !important; }
[${SELECTED_ATTRIBUTE}] { outline: 2px solid rgba(59, 130, 246, .85) !important; outline-offset: -2px !important; }
`;

export interface ReadMessage {
  element: Element;
  message: Message;
}

function isCandidate(element: Element): boolean {
  return element.closest(LIST) !== null && !element.closest(NOT_MESSAGES) && !element.querySelector(ITEM);
}

/**
 * The open conversation's chat: the smallest container around the single « Close Chat » that holds a
 * candidate message. Null when there is no single « Close Chat » (no conversation, ambiguous page).
 */
export function chatContainer(doc: Document): Element | null {
  const close = doc.querySelectorAll(CLOSE_CHAT);
  if (close.length !== 1) return null;
  for (let element = close[0].parentElement; element && element !== doc.body; element = element.parentElement) {
    if ([...element.querySelectorAll(ITEM)].some((item) => !item.contains(close[0]) && isCandidate(item))) return element;
  }
  return null;
}

function isMessage(element: Element, chat: Element): boolean {
  return chat.contains(element) && isCandidate(element);
}

/** The message `target` belongs to, or null (sender header, date separator holding messages, outside the chat). */
export function messageAt(target: EventTarget | null, chat: Element): Element | null {
  const item = target instanceof Element ? target.closest(ITEM) : null;
  return item && isMessage(item, chat) ? item : null;
}

/** Whether `node` is inside an element matching `selector`, below `root`. */
function within(node: Node, root: Element, selector: string): boolean {
  for (let element = node.parentElement; element && element !== root; element = element.parentElement) {
    if (element.matches(selector)) return true;
  }
  return false;
}

function textOf(root: Element): string {
  let text = '';
  const walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (!within(node, root, NOT_TEXT)) text += node.textContent ?? '';
  }
  return text.replace(/\s+/g, ' ').trim();
}

/** Sender of `message`: the last `<header>` before it, in the message or one of its groups. */
function authorOf(message: Element, chat: Element): string | null {
  for (let element: Element | null = message; element && element !== chat; element = element.parentElement) {
    const headers = [...element.children].filter((child) => child.tagName === 'HEADER' && !child.querySelector(CLOSE_CHAT)
      && (element === message || (child.compareDocumentPosition(message) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0));
    const header = headers.at(-1);
    if (header) return asName(textOf(header));
  }
  return null;
}

function typeOf(text: string, media: Message['media']): Message['type'] {
  if (media.length === 0) return text ? 'text' : 'unknown';
  if (media.every((item) => item.kind === 'image')) return 'image';
  if (media.every((item) => item.kind === 'video')) return 'video';
  return 'media';
}

const attribute = (element: Element, name: string, max: number) => {
  const value = element.getAttribute(name)?.trim();
  return value && value.length <= max ? value : null;
};

/** Images (avatars excluded) and videos of a message, in document order: `Message['media']` follows it. */
function mediaNodes(element: Element): Element[] {
  return [...element.querySelectorAll('img, video')]
    .filter((node) => node.tagName === 'VIDEO' || !isBitmojiAvatar(node as HTMLImageElement))
    .slice(0, MAX_MEDIA);
}

/** Longest side of an image preview, in px. */
const PREVIEW_SIZE = 480;

/**
 * A scaled-down JPEG copy of `image` as the page already decoded it: nothing is requested. Null when it
 * is not loaded yet, or when the browser forbids reading it (image of another origin: tainted canvas).
 */
export function imagePreview(image: HTMLImageElement): ImagePreview | null {
  if (!image.complete || image.naturalWidth === 0 || image.naturalHeight === 0) return null;
  const scale = Math.min(1, PREVIEW_SIZE / Math.max(image.naturalWidth, image.naturalHeight));
  const width = Math.max(1, Math.round(image.naturalWidth * scale));
  const height = Math.max(1, Math.round(image.naturalHeight * scale));
  try {
    const canvas = image.ownerDocument.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    if (!context) return null;
    context.drawImage(image, 0, 0, width, height);
    const preview = imagePreviewSchema.safeParse({ dataUrl: canvas.toDataURL('image/jpeg', 0.8), width, height });
    return preview.success ? preview.data : null;
  } catch {
    return null;
  }
}

/** `message` with a preview of each of its images that can be copied, for the record of its selection. */
export function withPreviews(element: Element, message: Message): Message {
  const nodes = mediaNodes(element);
  return {
    ...message,
    media: message.media.map((item, index) => item.kind === 'image' && nodes[index]?.tagName === 'IMG'
      ? { ...item, preview: imagePreview(nodes[index] as HTMLImageElement) }
      : item),
  };
}

/** What `element` shows, without its key. A field Snapchat does not show is null or empty. */
export function readMessage(element: Element, chat: Element, conversationId: string): Omit<Message, 'key'> {
  const text = textOf(element).slice(0, MAX_MESSAGE_TEXT);
  const time = element.querySelector('time');
  // Previews are only made for a message being selected (withPreviews), never while reading the page.
  const media: Message['media'] = mediaNodes(element).map((node) => node.tagName === 'VIDEO'
    ? { kind: 'video', alt: attribute(node, 'aria-label', 1000), preview: null }
    : { kind: 'image', alt: attribute(node, 'alt', 1000), preview: null });
  const links = [...element.querySelectorAll('a[href]')]
    .map((link) => (link as HTMLAnchorElement).href)
    .filter((href) => SAFE_LINK.test(href) && href.length <= 2048)
    .slice(0, MAX_LINKS);
  return {
    conversationId,
    text,
    author: authorOf(element, chat),
    sentAt: time ? attribute(time, 'datetime', 64) : null,
    timeLabel: time ? asName(time.textContent) : null,
    type: typeOf(text, media),
    media,
    links,
  };
}

/** 53-bit string hash (cyrb53), in base 36. Not cryptographic: only tells messages apart. */
function hash(input: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < input.length; i++) {
    const char = input.charCodeAt(i);
    h1 = Math.imul(h1 ^ char, 2654435761);
    h2 = Math.imul(h2 ^ char, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
}

/**
 * What identifies a message across reloads. Only letters and emoji of the text count: the phone
 * protection rewrites digits in the page (`**********`), and turning it on or off must not change the
 * key. Messages that differ only by digits are told apart by their rank.
 */
function fingerprint(message: Omit<Message, 'key'>): string {
  const letters = message.text.replace(/[^\p{L}\p{Extended_Pictographic}]/gu, '');
  return hash(JSON.stringify([message.author, message.sentAt, letters, message.media.map((item) => [item.kind, item.alt]), message.links]));
}

/** Every message of the open conversation, with its key: `<fingerprint>:<rank among identical messages>`. */
export function readMessages(doc: Document): { conversationId: string; chat: Element; messages: ReadMessage[] } | null {
  const conversationId = readConversation(doc)?.id;
  const chat = chatContainer(doc);
  if (!conversationId || !chat) return null;
  const ranks = new Map<string, number>();
  const messages = [...chat.querySelectorAll(ITEM)].filter((element) => isCandidate(element)).map((element) => {
    const read = readMessage(element, chat, conversationId);
    const print = fingerprint(read);
    const rank = ranks.get(print) ?? 0;
    ranks.set(print, rank + 1);
    return { element, message: { ...read, key: `${print}:${rank}` } };
  });
  return { conversationId, chat, messages };
}

function setAttribute(element: Element, name: string, on: boolean) {
  if (element.hasAttribute(name) !== on) element.toggleAttribute(name, on);
}

const KIND_LABELS: Record<Message['type'], string> = { text: '', unknown: '', image: ' (image)', video: ' (vidéo)', media: ' (médias)' };

/** Accessible name of a message's checkbox: its sender and the start of its text, or its kind. */
export function checkboxLabel(message: Message): string {
  const excerpt = message.text.length > 60 ? `${message.text.slice(0, 60)}…` : message.text;
  return `Sélectionner le message${message.author ? ` de ${message.author}` : ''}${excerpt ? ` « ${excerpt} »` : KIND_LABELS[message.type]}`;
}

export interface Rect { left: number; top: number; right: number; bottom: number }

/** Geometry of a message on screen, read from its content (never from Snapchat's classes). */
export interface MessageLayout {
  /** The checkbox is centred on it: the first line of text, or the top of the first media. */
  anchor: { top: number; height: number };
  /** Everything painted in the message (text, time, sender, avatar, media): never covered. */
  obstacles: Rect[];
}

/** Not where the checkbox is aligned: sender header, time, and what they hold. */
const ANCHOR_EXCLUDED = 'header, time';
const MEDIA = 'img, video, canvas, svg, picture';

const nonEmpty = (rect: Rect) => rect.right - rect.left > 0 && rect.bottom - rect.top > 0;
const toRect = ({ left, top, right, bottom }: Rect): Rect => ({ left, top, right, bottom });
const intersects = (a: Rect, b: Rect) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
function intersection(a: Rect, b: Rect): Rect {
  return { left: Math.max(a.left, b.left), top: Math.max(a.top, b.top), right: Math.min(a.right, b.right), bottom: Math.min(a.bottom, b.bottom) };
}

/**
 * Measures `element`: the boxes of its text lines (Range.getClientRects) and of its media are what it
 * paints; the first line of its own content (not the sender header nor the time) is its anchor.
 * Null when nothing of the message is laid out.
 */
export function messageLayout(element: Element): MessageLayout | null {
  const doc = element.ownerDocument;
  const range = doc.createRange();
  const obstacles: Rect[] = [];
  let anchor: Rect | null = null;
  const consider = (rect: Rect, anchoring: boolean) => {
    obstacles.push(rect);
    if (anchoring && (!anchor || rect.top < anchor.top)) anchor = rect;
  };
  const walker = doc.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (!(node.textContent ?? '').trim()) continue;
    range.selectNodeContents(node);
    const anchoring = !within(node, element, ANCHOR_EXCLUDED);
    for (const rect of range.getClientRects()) if (nonEmpty(rect)) consider(toRect(rect), anchoring);
  }
  for (const media of element.querySelectorAll(MEDIA)) {
    if (media.parentElement?.closest('svg')) continue;
    const rect = toRect(media.getBoundingClientRect());
    if (!nonEmpty(rect)) continue;
    // Avatars and icons are around the message, not its first line.
    const decoration = media.tagName.toLowerCase() === 'svg' || (media.tagName === 'IMG' && isBitmojiAvatar(media as HTMLImageElement));
    obstacles.push(rect);
    // A media is aligned on its top, as if it were a line of the checkbox's height.
    if (!decoration && !within(media, element, ANCHOR_EXCLUDED) && (!anchor || rect.top < anchor.top)) anchor = { ...rect, bottom: rect.top + BOX_SIZE };
  }
  if (obstacles.length === 0) return null;
  const first: Rect = anchor ?? obstacles.reduce((top, rect) => (rect.top < top.top ? rect : top));
  return { anchor: { top: first.top, height: first.bottom - first.top }, obstacles };
}

/** Where the selection column goes, from the most to the least natural. */
export type Column = 'list-left' | 'list-right' | 'outside-left' | 'outside-right';

/**
 * The selection column: a vertical strip, one checkbox wide, at a fixed position whatever the width of
 * the bubbles, where none of the messages on screen paints anything. In the left margin of the visible
 * message list, else its right margin, else just outside it on either side if the conversation (`zone`)
 * leaves room. The column used until now (`previous`) is kept while it stays free, so it does not jump.
 * Null when every candidate overlaps a message: the caller reports it.
 */
export function selectionColumn(list: Rect, zone: Rect, obstacles: readonly Rect[], previous: Column | null = null): { column: Column; left: number } | null {
  const candidates: [Column, number][] = [
    ['list-left', list.left + BOX_GAP],
    ['list-right', list.right - BOX_GAP - BOX_SIZE],
    ['outside-left', list.left - BOX_GAP - BOX_SIZE],
    ['outside-right', list.right + BOX_GAP],
  ];
  if (previous) candidates.sort(([a], [b]) => Number(b === previous) - Number(a === previous));
  for (const [column, x] of candidates) {
    const left = Math.round(x);
    if (left < zone.left || left + BOX_SIZE > zone.right) continue;
    // A little wider than a checkbox: it never touches a line of text.
    const strip = { left: left - 2, right: left + BOX_SIZE + 2, top: list.top, bottom: list.bottom };
    if (!obstacles.some((rect) => intersects(strip, rect))) return { column, left };
  }
  return null;
}

const LAYER_CSS = `
:host { all: initial !important; position: fixed !important; inset: 0 !important; display: block !important;
  pointer-events: none !important; z-index: 2147483647 !important; }
input { position: fixed; box-sizing: border-box; width: ${BOX_SIZE}px; height: ${BOX_SIZE}px; margin: 0; padding: 0;
  pointer-events: auto; cursor: pointer; accent-color: #3b82f6; }
input:focus-visible { outline: 2px solid #3b82f6; outline-offset: 2px; }
.badge { position: fixed; left: 16px; bottom: 16px; pointer-events: auto; display: flex; gap: 8px; align-items: center;
  padding: 6px 8px 6px 12px; border-radius: 8px; background: #1e293b; color: #fff; font: 13px system-ui, sans-serif;
  box-shadow: 0 2px 8px rgba(0, 0, 0, .3); }
.badge button { font: inherit; padding: 2px 8px; border-radius: 6px; border: 0; background: #3b82f6; color: #fff; cursor: pointer; }
`;

/** Events of the layer that Snapchat must not see (shortcuts, outside-click handlers…). */
const LAYER_EVENTS = ['click', 'dblclick', 'auxclick', 'contextmenu', 'mousedown', 'mouseup', 'pointerdown', 'pointerup', 'touchstart', 'touchend', 'keydown', 'keyup', 'keypress', 'input', 'change', 'focusin', 'focusout'];

/**
 * Diagnostics of the selection mode in the Snapchat tab's console, off by default: on in development
 * (`pnpm dev`), or after `localStorage.setItem('leakzero:debug', '1')` in that console. Only counts and
 * states, never the content of a message.
 */
export const DEBUG_FLAG = 'leakzero:debug';
function debugging(doc: Document): boolean {
  if (import.meta.env.MODE === 'development') return true;
  try {
    return doc.defaultView?.localStorage.getItem(DEBUG_FLAG) === '1';
  } catch {
    return false;
  }
}

/** What the selection mode sees: logged by the diagnostics, read by the tests. */
export interface SelectionState {
  enabled: boolean;
  /** Conversation the mode was started for (first 8 characters), or null when it is off. */
  target: string | null;
  /** Conversation in the URL (first 8 characters). */
  shown: string | null;
  closeChatButtons: number;
  chatFound: boolean;
  /** List items of the chat, before filtering. */
  listItems: number;
  messages: number;
  selection: 'off' | 'loading' | 'loaded' | 'error';
  layerMounted: boolean;
  checkboxes: number;
  /** Selection column in use; null with messages on screen means none is free of them (`noColumn`). */
  column: Column | null;
  /** Messages are on screen but every candidate column overlaps one: checkboxes hidden, reported. */
  noColumn: boolean;
  /** Checkboxes placed in the column (their message is in the visible part of the list). */
  placed: number;
  /** Checkboxes really on screen: laid out, in the viewport, and the topmost element at their centre. */
  visible: number;
}

interface Checkbox {
  input: HTMLInputElement;
  /** Ancestors of the message that clip it (scroll container…), computed once. */
  clips: Element[];
  /** Last position written. */
  css: string;
}

/** What the last placement gave, for the diagnostics. */
interface PlacementStats {
  column: Column | null;
  noColumn: boolean;
  placed: number;
}

/**
 * Selection mode, while the Notes module is enabled and `notes:selecting` is on: every message of the
 * open conversation gets a checkbox, and a click on the checkbox or on the message selects it or unselects
 * it; selected messages are outlined too. Selections are kept per conversation by the service worker
 * (selections.ts). Checkboxes live in a fixed layer above the page (open shadow root, outside Snapchat's
 * tree), placed over the messages' boxes every frame: Snapchat's markup and layout are never changed,
 * except two attributes on message elements. Mode off: no listener, no observer, nothing injected.
 * Returns a function that stops.
 */
export function startMessageSelection(doc: Document, api: typeof chrome = chrome): { stop: () => void; state: () => SelectionState } {
  let enabled = false;
  /** Conversation the mode is on for (`notes:selecting`); the mode shows only while it is open. */
  let target: string | null = null;
  let running = false;
  let stopped = false;
  /** Conversation whose selection is loaded in `selected`; `ready` once it is. */
  let conversationId: string | null = null;
  let ready = false;
  let loading = false;
  let loadError = false;
  let selected = new Set<string>();
  let lastLog: string | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let frame = 0;
  const observer = new MutationObserver(() => schedule());
  let style: HTMLStyleElement | undefined;
  let layer: { host: HTMLElement; root: ShadowRoot } | undefined;
  const checkboxes = new Map<Element, Checkbox>();
  /** Messages with a checkbox, in page order (placement looks at the previous one). */
  let order: Element[] = [];
  /** Chat of the messages with a checkbox: the zone the selection column stays in. */
  let chat: Element | null = null;
  let stats: PlacementStats = { column: null, noColumn: false, placed: 0 };
  let lastDiagnosis = 0;

  const orphaned = () => {
    try {
      return !api.runtime?.id;
    } catch {
      return true;
    }
  };

  function createLayer() {
    const host = doc.createElement(LAYER_TAG);
    const root = host.attachShadow({ mode: 'open' });
    const css = doc.createElement('style');
    css.textContent = LAYER_CSS;
    const badge = doc.createElement('div');
    badge.className = 'badge';
    badge.setAttribute('role', 'status');
    badge.append('LeakZero : cochez les messages à sélectionner');
    const end = doc.createElement('button');
    end.type = 'button';
    end.textContent = 'Terminer';
    end.addEventListener('click', () => {
      api.storage.local.set({ [NotesKeys.selecting]: null }).catch((error: unknown) => console.warn('[LeakZero Notes] sélection non terminée', error));
    });
    badge.append(end);
    root.append(css, badge);
    // Outside <body>, so React (rooted in the page) never receives them; stopped here for page-wide listeners.
    for (const type of LAYER_EVENTS) host.addEventListener(type, (event) => event.stopPropagation());
    return { host, root };
  }

  function attach() {
    style ??= Object.assign(doc.createElement('style'), { textContent: SELECTION_CSS });
    style.dataset.leakzero = 'selection';
    if (!style.isConnected) doc.documentElement.append(style);
    layer ??= createLayer();
    if (!layer.host.isConnected) doc.documentElement.append(layer.host);
  }

  function detach() {
    for (const element of doc.querySelectorAll(`[${SELECTED_ATTRIBUTE}], [${SELECTABLE_ATTRIBUTE}]`)) {
      element.removeAttribute(SELECTED_ATTRIBUTE);
      element.removeAttribute(SELECTABLE_ATTRIBUTE);
    }
    checkboxes.clear();
    order = [];
    chat = null;
    stats = { column: null, noColumn: false, placed: 0 };
    layer?.host.remove();
    layer = undefined;
    style?.remove();
  }

  function checkbox(element: Element): Checkbox {
    let box = checkboxes.get(element);
    if (!box) {
      const input = doc.createElement('input');
      input.type = 'checkbox';
      input.style.display = 'none';
      input.addEventListener('change', () => toggle(element));
      box = { input, clips: clippingAncestors(element), css: 'display: none;' };
      checkboxes.set(element, box);
      layer!.root.append(input);
    }
    return box;
  }

  function paint(read = readMessages(doc)) {
    // Selectable once the selection of the conversation shown is loaded.
    const loaded = ready && read?.conversationId === conversationId;
    const current = new Set<Element>();
    for (const { element, message } of loaded ? read!.messages : []) {
      current.add(element);
      const on = selected.has(message.key);
      setAttribute(element, SELECTABLE_ATTRIBUTE, true);
      setAttribute(element, SELECTED_ATTRIBUTE, on);
      const { input } = checkbox(element);
      input.checked = on;
      const label = checkboxLabel(message);
      if (input.getAttribute('aria-label') !== label) input.setAttribute('aria-label', label);
    }
    // Messages gone from the page, or no longer of the open conversation.
    for (const element of doc.querySelectorAll(`[${SELECTED_ATTRIBUTE}], [${SELECTABLE_ATTRIBUTE}]`)) {
      if (!current.has(element)) {
        element.removeAttribute(SELECTED_ATTRIBUTE);
        element.removeAttribute(SELECTABLE_ATTRIBUTE);
      }
    }
    for (const [element, { input }] of checkboxes) {
      if (current.has(element)) continue;
      input.remove();
      checkboxes.delete(element);
    }
    order = [...current];
    chat = loaded ? read!.chat : null;
    place();
  }

  /**
   * Puts the checkboxes in the selection column, each level with the first line of its message; runs
   * every frame, to follow scrolling and layout. Only messages in the visible part of the list are
   * measured; the others' checkboxes are hidden.
   */
  function place() {
    const shown: { box: Checkbox; layout: MessageLayout; clip: Rect }[] = [];
    for (const element of order) {
      const box = checkboxes.get(element);
      if (!box) continue;
      const clip = clipRect(box.clips);
      const row = element.getBoundingClientRect();
      const layout = nonEmpty(row) && intersects(row, clip) ? messageLayout(element) : null;
      if (layout) shown.push({ box, layout, clip });
    }
    // The visible part of the message list, and the conversation around it.
    const list = shown.length > 0 ? shown.map(({ clip }) => clip).reduce(intersection) : null;
    const zone = chat && list ? intersection(toRect(chat.getBoundingClientRect()), clipRect([])) : null;
    const found = list && zone ? selectionColumn(list, zone, shown.flatMap(({ layout }) => layout.obstacles), stats.column) : null;
    const next: PlacementStats = { column: found?.column ?? null, noColumn: list !== null && found === null, placed: 0 };
    const positions = new Map<Checkbox, string>();
    for (const { box, layout } of shown) {
      if (!found || !list) continue;
      const top = Math.round(layout.anchor.top + (layout.anchor.height - BOX_SIZE) / 2);
      if (top < list.top || top + BOX_SIZE > list.bottom) continue;
      positions.set(box, `left: ${found.left}px; top: ${top}px;`);
      next.placed++;
    }
    for (const box of checkboxes.values()) {
      const css = positions.get(box) ?? 'display: none;';
      if (css === box.css) continue;
      box.css = css;
      box.input.style.cssText = css;
    }
    // Never hidden silently: always reported in the console, not only with the diagnostics on.
    if (next.noColumn && !stats.noColumn) {
      console.warn('[LeakZero Sélection] aucune colonne libre à côté des messages affichés : cases masquées pour ne pas les recouvrir. Le clic sur un message reste disponible.');
    }
    stats = next;
  }

  function onFrame() {
    frame = 0;
    if (!running) return;
    place();
    // Positions change while scrolling without any mutation: logged here too, at most twice a second.
    const now = performance.now();
    if (now - lastDiagnosis > 500) {
      lastDiagnosis = now;
      diagnose();
    }
    frame = requestAnimationFrame(onFrame);
  }

  /** Checkboxes really visible: laid out, in the viewport, and not covered by anything else. */
  function visibleCheckboxes(): number {
    const view = doc.defaultView;
    let visible = 0;
    for (const { input } of checkboxes.values()) {
      const rect = input.getBoundingClientRect();
      if (!nonEmpty(rect) || !view || rect.right <= 0 || rect.bottom <= 0 || rect.left >= view.innerWidth || rect.top >= view.innerHeight) continue;
      // From the document, an element of the layer's shadow root is reported as its host.
      if (typeof doc.elementFromPoint === 'function') {
        const top = doc.elementFromPoint((rect.left + rect.right) / 2, (rect.top + rect.bottom) / 2);
        if (top !== layer?.host) continue;
      }
      visible++;
    }
    return visible;
  }

  function load(id: string) {
    loading = true;
    sendNotesCommand<string[]>({ type: 'notes:selectedKeys', conversationId: id }, api).then(
      (keys) => {
        if (!running || conversationId !== id) return;
        loading = false;
        loadError = false;
        selected = new Set(keys);
        ready = true;
        paint();
        diagnose();
      },
      (error: unknown) => {
        if (conversationId !== id) return;
        // Tried again at the next refresh (next change of the page), never left stuck.
        loading = false;
        loadError = true;
        console.warn('[LeakZero Notes] sélection illisible', error instanceof Error ? error.message : String(error));
        diagnose();
      },
    );
  }

  function state(): SelectionState {
    const close = doc.querySelectorAll(CLOSE_CHAT).length;
    const chat = chatContainer(doc);
    const read = readMessages(doc);
    const shown = readConversation(doc)?.id ?? null;
    return {
      enabled,
      target: target?.slice(0, 8) ?? null,
      shown: shown?.slice(0, 8) ?? null,
      closeChatButtons: close,
      chatFound: chat !== null,
      listItems: chat?.querySelectorAll(ITEM).length ?? 0,
      messages: read?.messages.length ?? 0,
      selection: !running || conversationId === null ? 'off' : ready ? 'loaded' : loadError ? 'error' : 'loading',
      layerMounted: layer?.host.isConnected === true,
      checkboxes: checkboxes.size,
      column: stats.column,
      noColumn: stats.noColumn,
      placed: stats.placed,
      visible: visibleCheckboxes(),
    };
  }

  function diagnose() {
    if (!debugging(doc)) return;
    const line = JSON.stringify(state());
    if (line === lastLog) return;
    lastLog = line;
    console.info(`[LeakZero Sélection] ${line}`);
  }

  function refresh() {
    timer = undefined;
    if (!running) return;
    if (orphaned()) return stop();
    const url = readConversation(doc)?.id ?? null;
    // Only the conversation the mode was started for: elsewhere, nothing is shown nor intercepted.
    const id = url === target ? url : null;
    if (id !== conversationId) {
      conversationId = id;
      ready = false;
      loadError = false;
      selected = new Set();
    }
    if (id === null) {
      detach();
    } else {
      attach();
      if (!ready && !loading) load(id);
      paint();
    }
    diagnose();
  }

  function schedule() {
    timer ??= setTimeout(refresh, DEBOUNCE_MS);
  }

  /** Selects `element` if it is not, unselects it otherwise. */
  function toggle(element: Element, read = readMessages(doc)) {
    const item = read?.messages.find((candidate) => candidate.element === element);
    if (!read || !item || !ready || read.conversationId !== conversationId) return paint(read);
    if (orphaned()) return stop();
    const { message } = item;
    const wasSelected = selected.has(message.key);
    if (wasSelected) selected.delete(message.key);
    else selected.add(message.key);
    paint(read);
    const id = conversationId;
    const command = wasSelected
      ? { type: 'notes:unselect' as const, conversationId: message.conversationId, key: message.key }
      : { type: 'notes:select' as const, message: withPreviews(element, message) };
    sendNotesCommand(command, api).catch((error: unknown) => {
      console.warn(`[LeakZero Notes] ${wasSelected ? 'désélection' : 'sélection'} non enregistrée`, error);
      if (conversationId !== id) return;
      if (wasSelected) selected.add(message.key);
      else selected.delete(message.key);
      paint();
    });
  }

  function onClick(event: MouseEvent) {
    if (!running) return;
    const read = readMessages(doc);
    const element = read && messageAt(event.target, read.chat);
    // Until the selection of this conversation is loaded, messages are not selectable yet.
    if (!read || !element || !ready || conversationId === null || read.conversationId !== conversationId) return;
    // The click is LeakZero's: Snapchat neither opens the media nor reacts to it.
    event.preventDefault();
    event.stopImmediatePropagation();
    if (event.type === 'click') toggle(element, read);
  }

  function update() {
    const next = enabled && target !== null && !stopped;
    if (next === running) return;
    running = next;
    if (running) {
      doc.addEventListener('click', onClick, true);
      doc.addEventListener('dblclick', onClick, true);
      observer.observe(doc.documentElement, { childList: true, subtree: true, characterData: true });
      conversationId = null;
      loading = false;
      refresh();
      frame = requestAnimationFrame(onFrame);
    } else {
      doc.removeEventListener('click', onClick, true);
      doc.removeEventListener('dblclick', onClick, true);
      observer.disconnect();
      clearTimeout(timer);
      timer = undefined;
      cancelAnimationFrame(frame);
      frame = 0;
      conversationId = null;
      ready = false;
      detach();
    }
    diagnose();
  }

  const onChanged = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
    if (area !== 'local') return;
    if (NOTES_ENABLED in changes) enabled = changes[NOTES_ENABLED].newValue === true;
    if (NotesKeys.selecting in changes) {
      const next = selectionTarget(changes[NotesKeys.selecting].newValue);
      // Started for another conversation: begins again from scratch.
      if (running && next !== target) {
        target = null;
        update();
      }
      target = next;
    }
    update();
  };

  function stop() {
    if (stopped) return;
    stopped = true;
    update();
    try {
      api.storage.onChanged.removeListener(onChanged);
    } catch {
      // Extension context already invalidated.
    }
  }

  api.storage.onChanged.addListener(onChanged);
  api.storage.local.get([NOTES_ENABLED, NotesKeys.selecting]).then(
    (items) => {
      enabled = items[NOTES_ENABLED] === true;
      target = selectionTarget(items[NotesKeys.selecting]);
      update();
    },
    () => stop(),
  );
  return { stop, state };
}
