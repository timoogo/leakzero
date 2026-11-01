// @vitest-environment jsdom
// @vitest-environment-options {"url": "https://www.snapchat.com/web"}
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { registerNotesBackground } from '../src/notes/background';
import { NotesKeys } from '../src/notes/keys';
import { NOTES_ENABLED } from '../src/notes/model';
import { chatContainer, DEBUG_FLAG, LAYER_TAG, messageLayout, selectionColumn, readMessages, SELECTABLE_ATTRIBUTE, SELECTED_ATTRIBUTE, startMessageSelection } from '../src/notes/selection';
import { createSelectionStore, type SelectionStore } from '../src/notes/selections';
import { fakeChrome } from './helpers/chrome';

const ALICE = '0b1c2d3e-4f50-4617-8293-a4b5c6d7e8f9';
const BOB = '2c1c2d3e-4f50-4617-8293-a4b5c6d7e8f9';

/** Snapchat's generated class names: different at every render, never usable. */
const cls = () => `${Math.random().toString(36).slice(2, 8)} ${Math.random().toString(36).slice(2, 8)}`;

/**
 * Snapchat Web with a conversation open: sidebar (nav), header with « Close Chat » and its conversation
 * menu (Downshift, whose `<ul role="listbox">` is rendered even closed), and messages grouped by sender
 * under a `<header>`. `data-m` only lets the tests find messages.
 */
function openConversation(id: string, name: string) {
  history.pushState({}, '', `/web/${id}`);
  document.body.innerHTML = `
    <div class="${cls()}">
      <nav class="${cls()}"><ul role="list"><li data-m="sidebar"><span>Bob</span><span>ok</span></li></ul></nav>
      <div class="${cls()}" data-chat>
        <div class="${cls()}">
          <div class="${cls()}" role="combobox" aria-haspopup="listbox" aria-expanded="false" id="downshift-7-toggle-button"><span>${name}</span></div>
          <ul class="${cls()}" role="listbox" id="downshift-7-menu" aria-labelledby="downshift-7-label"></ul>
          <button type="button" title="Close Chat"><svg></svg></button>
        </div>
        <ul class="${cls()}">
          <li class="${cls()}">
            <header class="${cls()}"><span>${name}</span></header>
            <ul class="${cls()}">
              <li data-m="hello"><span>Salut <b>toi</b></span> <span aria-hidden="true">✓</span><time datetime="2026-10-30T14:02:00.000Z">14:02</time></li>
              <li data-m="ok1"><span>ok</span></li>
              <li data-m="ok2"><span>ok</span></li>
              <li data-m="photo"><img src="https://cf-st.sc-cdn.net/d/photo.jpg" alt="Photo"><img src="https://sdk.bitmoji.com/render/panel/1.png"></li>
            </ul>
          </li>
          <li class="${cls()}">
            <header class="${cls()}"><span>Moi</span></header>
            <ul class="${cls()}">
              <li data-m="phone"><span>Mon numéro : 06 12 34 56 78</span> <a href="https://example.com/a">lien</a></li>
            </ul>
          </li>
        </ul>
      </div>
    </div>`;
}

const message = (name: string) => document.querySelector(`[data-m="${name}"]`)!;
const click = (element: Element) => element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
const selectedNames = () => [...document.querySelectorAll(`[${SELECTED_ATTRIBUTE}]`)].map((element) => element.getAttribute('data-m'));

let storage: ReturnType<typeof fakeChrome>;
let factory: IDBFactory;
let selections: SelectionStore;
let session: ReturnType<typeof startMessageSelection> | undefined;
/** Snapchat's own click handler on the chat. */
let snapchatClick: ReturnType<typeof vi.fn>;

function showTab(id: string) {
  storage.setSender({ url: `https://www.snapchat.com/web/${id}`, tab: { id: 3 } as chrome.tabs.Tab });
}

function start() {
  session = startMessageSelection(document, storage.api);
}

beforeEach(() => {
  // The page's localStorage (Node's own global hides jsdom's here).
  const items = new Map<string, string>();
  vi.stubGlobal('localStorage', { getItem: (key: string) => items.get(key) ?? null, setItem: (key: string, value: string) => items.set(key, value) });
  factory = new IDBFactory();
  storage = fakeChrome({ [NOTES_ENABLED]: true, [NotesKeys.selecting]: ALICE });
  selections = createSelectionStore(() => factory);
  registerNotesBackground(storage.api, selections);
  showTab(ALICE);
  openConversation(ALICE, 'Alice');
  snapchatClick = vi.fn();
  document.addEventListener('click', snapchatClick);
});

afterEach(async () => {
  vi.restoreAllMocks();
  session?.stop();
  session = undefined;
  document.removeEventListener('click', snapchatClick);
  await selections.close();
  vi.unstubAllGlobals();
});

/** Checkboxes of the layer, and the one whose label contains `text`. */
const checkboxes = () => [...(document.querySelector(LAYER_TAG)?.shadowRoot?.querySelectorAll('input') ?? [])];
const checkboxOf = (text: string) => checkboxes().find((input) => input.getAttribute('aria-label')!.includes(text))!;
const checked = () => checkboxes().filter((input) => input.checked).map((input) => input.getAttribute('aria-label'));

/** Selection of the conversation loaded: its messages are marked selectable. */
const ready = () => vi.waitFor(() => expect(message('hello').hasAttribute(SELECTABLE_ATTRIBUTE)).toBe(true));

describe('reading messages', () => {
  it('keeps what Snapchat shows, and only that', () => {
    const read = readMessages(document)!;
    expect(read.conversationId).toBe(ALICE);
    const byName = Object.fromEntries(read.messages.map(({ element, message: m }) => [element.getAttribute('data-m'), m]));
    expect(Object.keys(byName)).toEqual(['hello', 'ok1', 'ok2', 'photo', 'phone']);
    expect(byName.hello).toMatchObject({
      conversationId: ALICE, text: 'Salut toi', author: 'Alice', sentAt: '2026-10-30T14:02:00.000Z', timeLabel: '14:02',
      type: 'text', media: [], links: [],
    });
    // No time shown: none invented. The Bitmoji avatar is not a media of the message.
    expect(byName.ok1).toMatchObject({ text: 'ok', author: 'Alice', sentAt: null, timeLabel: null });
    expect(byName.photo).toMatchObject({ text: '', type: 'image', media: [{ kind: 'image', alt: 'Photo' }] });
    expect(byName.phone).toMatchObject({ author: 'Moi', links: ['https://example.com/a'] });
  });

  it('gives identical messages distinct keys, and the same keys on every read', () => {
    const keys = readMessages(document)!.messages.map(({ message: m }) => m.key);
    expect(new Set(keys).size).toBe(keys.length);
    openConversation(ALICE, 'Alice');
    expect(readMessages(document)!.messages.map(({ message: m }) => m.key)).toEqual(keys);
  });

  it('keeps the key of a message whose digits the phone protection masks', () => {
    const before = readMessages(document)!.messages.at(-1)!.message.key;
    message('phone').querySelector('span')!.firstChild!.textContent = 'Mon numéro : **********';
    expect(readMessages(document)!.messages.at(-1)!.message.key).toBe(before);
  });

  it('reads nothing outside a conversation', () => {
    history.pushState({}, '', '/web');
    expect(readMessages(document)).toBeNull();
  });
});

describe('selection mode', () => {
  it('selects a message on click, and unselects it on a second click', async () => {
    start();
    await ready();
    click(message('hello'));
    expect(selectedNames()).toEqual(['hello']);
    // The click is LeakZero's, not Snapchat's.
    expect(snapchatClick).not.toHaveBeenCalled();
    await vi.waitFor(async () => expect(await selections.list(ALICE)).toHaveLength(1));
    const [record] = await selections.list(ALICE);
    expect(record).toMatchObject({ conversationId: ALICE, text: 'Salut toi', author: 'Alice', sentAt: '2026-10-30T14:02:00.000Z', type: 'text' });
    expect(record.selectedAt).toBeTypeOf('number');

    click(message('hello'));
    expect(selectedNames()).toEqual([]);
    await vi.waitFor(async () => expect(await selections.list(ALICE)).toEqual([]));
  });

  it('tells identical messages apart', async () => {
    start();
    await ready();
    click(message('ok2'));
    expect(selectedNames()).toEqual(['ok2']);
  });

  it('leaves Snapchat alone while the mode is off: no interception, no mark, nothing sent', async () => {
    storage = fakeChrome({ [NOTES_ENABLED]: true });
    registerNotesBackground(storage.api, selections);
    start();
    await new Promise((resolve) => setTimeout(resolve, 300));
    click(message('hello'));
    expect(snapchatClick).toHaveBeenCalledTimes(1);
    expect(document.querySelector(`[${SELECTABLE_ATTRIBUTE}], [${SELECTED_ATTRIBUTE}], ${LAYER_TAG}`)).toBeNull();
    expect(storage.api.runtime.sendMessage).not.toHaveBeenCalled();
  });

  it('lets clicks outside messages through (sidebar, sender header)', async () => {
    start();
    await ready();
    click(message('sidebar'));
    click(document.querySelector('header')!);
    expect(snapchatClick).toHaveBeenCalledTimes(2);
    expect(selectedNames()).toEqual([]);
  });

  it('stops when the mode is turned off from the badge, and removes every mark', async () => {
    start();
    await ready();
    click(message('hello'));
    expect(document.querySelector(LAYER_TAG)).not.toBeNull();
    (document.querySelector(LAYER_TAG)!.shadowRoot!.querySelector('button') as HTMLButtonElement).click();
    await vi.waitFor(() => expect(storage.stored[NotesKeys.selecting]).toBeNull());
    expect(document.querySelector(`[${SELECTABLE_ATTRIBUTE}], [${SELECTED_ATTRIBUTE}], ${LAYER_TAG}`)).toBeNull();
    expect(document.querySelector('style[data-leakzero="selection"]')).toBeNull();
    click(message('ok1'));
    expect(snapchatClick).toHaveBeenCalledTimes(1);
    // Turning the mode off keeps the selection.
    await vi.waitFor(async () => expect(await selections.list(ALICE)).toHaveLength(1));
  });
});

describe('checkboxes', () => {
  it('gives every message, and only messages, an unchecked checkbox with an accessible label', async () => {
    start();
    await ready();
    expect(checkboxes().map((input) => [input.type, input.checked, input.getAttribute('aria-label')])).toEqual([
      ['checkbox', false, 'Sélectionner le message de Alice « Salut toi »'],
      ['checkbox', false, 'Sélectionner le message de Alice « ok »'],
      ['checkbox', false, 'Sélectionner le message de Alice « ok »'],
      ['checkbox', false, 'Sélectionner le message de Alice (image)'],
      ['checkbox', false, 'Sélectionner le message de Moi « Mon numéro : 06 12 34 56 78 lien »'],
    ]);
    // Snapchat's markup is untouched: nothing inserted in the messages, no text changed.
    expect(message('hello').outerHTML).not.toContain('input');
    expect(document.body.querySelector('input')).toBeNull();
    expect(message('hello').textContent).toBe('Salut toi ✓14:02');
  });

  it('selects and unselects a message from its checkbox, out of Snapchat\'s reach', async () => {
    start();
    await ready();
    const box = checkboxOf('Salut toi');
    box.click();
    expect(box.checked).toBe(true);
    expect(selectedNames()).toEqual(['hello']);
    expect(snapchatClick).not.toHaveBeenCalled();
    await vi.waitFor(async () => expect((await selections.list(ALICE)).map((record) => record.text)).toEqual(['Salut toi']));
    box.click();
    expect(box.checked).toBe(false);
    expect(selectedNames()).toEqual([]);
    await vi.waitFor(async () => expect(await selections.list(ALICE)).toEqual([]));
    expect(snapchatClick).not.toHaveBeenCalled();
  });

  it('checks the checkbox of a message clicked directly', async () => {
    start();
    await ready();
    click(message('photo'));
    expect(checked()).toEqual(['Sélectionner le message de Alice (image)']);
    click(message('photo'));
    expect(checked()).toEqual([]);
  });

  it('adds a checkbox to a message Snapchat inserts later, and drops those of removed messages', async () => {
    start();
    await ready();
    const list = message('hello').parentElement!;
    list.insertAdjacentHTML('beforeend', '<li data-m="new"><span>Nouveau</span></li>');
    await vi.waitFor(() => expect(checkboxOf('Nouveau')).toBeDefined());
    message('ok1').remove();
    await vi.waitFor(() => expect(checkboxes()).toHaveLength(5));
    click(message('new'));
    expect(checkboxOf('Nouveau').checked).toBe(true);
  });
});

/**
 * A chat laid out like Snapchat Web: full-width message rows (`li`) in a scrolling list (x 100 → 1000),
 * the bubble inside each row hugging its content. Geometry comes from `data-rect` (elements) and
 * `data-lines` (line boxes of the text of an element); jsdom has no layout.
 */
function openLaidOutConversation() {
  history.pushState({}, '', `/web/${ALICE}`);
  document.body.innerHTML = `
    <div data-chat data-rect="50,0,1050,900">
      <div><div role="combobox" aria-haspopup="listbox"><span>Alice</span></div><ul role="listbox"></ul><button type="button" title="Close Chat"></button></div>
      <ul data-scroll data-rect="100,60,1000,800">
        <li data-m="received" data-rect="100,100,1000,140"><div data-rect="144,100,600,140"><span data-lines="156,110,580,130">Salut toi</span></div></li>
        <li data-m="sent" data-rect="100,150,1000,190"><div data-rect="700,150,960,190"><span data-lines="712,160,950,180">Coucou</span></div></li>
        <li data-m="long" data-rect="100,230,1000,310"><div data-rect="110,230,990,310"><span data-lines="120,240,980,260;120,270,700,290">Un message qui prend toute la largeur de la conversation</span></div></li>
        <li data-m="photo" data-rect="100,330,1000,530"><div data-rect="150,330,350,530"><img src="https://cf-st.sc-cdn.net/d/photo.jpg" alt="Photo" data-rect="154,334,346,526"></div></li>
      </ul>
    </div>`;
}

function stubGeometry() {
  const rects = (value: string) => value.split(';').map((rect) => {
    const [left, top, right, bottom] = rect.split(',').map(Number);
    return new DOMRect(left, top, right - left, bottom - top);
  });
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    // A checkbox where the layer put it.
    if (this instanceof HTMLInputElement && this.style.left) return new DOMRect(parseFloat(this.style.left), parseFloat(this.style.top), 18, 18);
    const value = this.getAttribute('data-rect');
    return value ? rects(value)[0] : new DOMRect(0, 0, 0, 0);
  });
  vi.spyOn(Range.prototype, 'getClientRects').mockImplementation(function (this: Range) {
    const value = this.startContainer.parentElement?.getAttribute('data-lines');
    return (value ? rects(value) : []) as unknown as DOMRectList;
  });
  vi.spyOn(window, 'getComputedStyle').mockImplementation((element) => {
    const overflow = element.hasAttribute('data-scroll') ? 'auto' : 'visible';
    return { overflowX: overflow, overflowY: overflow } as CSSStyleDeclaration;
  });
}

type Box = { left: number; top: number; right: number; bottom: number };
const rectOf = (element: Element): Box => {
  const { left, top, right, bottom } = element.getBoundingClientRect();
  return { left, top, right, bottom };
};
const overlaps = (a: Box, b: Box) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;

describe('selection column', () => {
  beforeEach(() => {
    openLaidOutConversation();
    stubGeometry();
  });

  const all = (...rects: Box[]) => rects;
  const LIST: Box = { left: 100, top: 60, right: 1000, bottom: 800 };
  const ZONE: Box = { left: 50, top: 0, right: 1050, bottom: 900 };

  it('uses the left margin of the list when no message paints there, whatever the width of the bubbles', () => {
    const short = { left: 156, top: 110, right: 580, bottom: 130 };
    const wide = { left: 140, top: 240, right: 990, bottom: 260 };
    expect(selectionColumn(LIST, ZONE, all(short))).toEqual({ column: 'list-left', left: 108 });
    expect(selectionColumn(LIST, ZONE, all(short, wide))).toEqual({ column: 'list-left', left: 108 });
  });

  it('falls back on the right margin, then outside the list, never over a message', () => {
    const atLeft = { left: 110, top: 110, right: 580, bottom: 130 };
    const atRight = { left: 700, top: 160, right: 990, bottom: 180 };
    expect(selectionColumn(LIST, ZONE, all(atLeft))).toEqual({ column: 'list-right', left: 974 });
    expect(selectionColumn(LIST, ZONE, all(atLeft, atRight))).toEqual({ column: 'outside-left', left: 74 });
    // The conversation leaves no room around the list: no column (reported by the caller).
    expect(selectionColumn(LIST, LIST, all(atLeft, atRight))).toBeNull();
  });

  it('keeps the column in use while it stays free, so it does not jump', () => {
    expect(selectionColumn(LIST, ZONE, [], 'list-right')).toEqual({ column: 'list-right', left: 974 });
  });

  it('aligns on the first line of the message, or the top of its media, not on its sender or time', () => {
    expect(messageLayout(message('received'))!.anchor).toEqual({ top: 110, height: 20 });
    expect(messageLayout(message('photo'))!.anchor).toEqual({ top: 334, height: 18 });
  });

  it('puts every checkbox in one column, level with its message, over none of them (received, sent, long, media)', async () => {
    start();
    await vi.waitFor(() => expect(checkboxes()).toHaveLength(4));
    await vi.waitFor(() => expect(session!.state()).toMatchObject({ placed: 4 }));
    // The long message reaches both margins of the list: the column goes just outside it.
    expect(session!.state()).toMatchObject({ column: 'outside-left', noColumn: false });
    expect(['Salut toi', 'Coucou', 'Un message', '(image)'].map((label) => checkboxOf(label).style.cssText)).toEqual([
      'left: 74px; top: 111px;', 'left: 74px; top: 161px;', 'left: 74px; top: 241px;', 'left: 74px; top: 334px;',
    ]);
    const painted = ['received', 'sent', 'long', 'photo'].flatMap((name) => messageLayout(message(name))!.obstacles);
    for (const input of checkboxes()) for (const rect of painted) expect(overlaps(rectOf(input), rect)).toBe(false);
    // Native layout untouched.
    expect(document.querySelector('[data-scroll] [style]')).toBeNull();
  });

  it('follows the messages while scrolling, and hides the checkboxes of messages out of view', async () => {
    start();
    await vi.waitFor(() => expect(session!.state()).toMatchObject({ placed: 4 }));
    /** Moves a one-line message up by `by` px, as scrolling does. */
    const scroll = (name: string, by: number) => {
      for (const element of [message(name), ...message(name).querySelectorAll('*')]) {
        for (const attribute of ['data-rect', 'data-lines']) {
          const value = element.getAttribute(attribute);
          // One rect each: these messages fit on one line.
          if (value) element.setAttribute(attribute, value.split(',').map((n, i) => (i % 2 ? Number(n) - by : Number(n))).join(','));
        }
      }
    };
    // No DOM change Snapchat would report: the next frame follows anyway.
    scroll('sent', 40);
    await vi.waitFor(() => expect(checkboxOf('Coucou').style.cssText).toBe('left: 74px; top: 121px;'));
    // Above the top of the list (y 60): hidden.
    scroll('received', 80);
    await vi.waitFor(() => expect(checkboxOf('Salut toi').style.cssText).toBe('display: none;'));
    expect(session!.state().placed).toBe(3);
  });

  it('reports, rather than hides silently, a conversation with no free column', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    // The conversation is exactly as wide as the list: no room outside it.
    document.querySelector('[data-chat]')!.setAttribute('data-rect', '100,0,1000,900');
    start();
    await vi.waitFor(() => expect(session!.state()).toMatchObject({ checkboxes: 4, column: null, noColumn: true, placed: 0 }));
    expect(checkboxes().every((input) => input.style.cssText === 'display: none;')).toBe(true);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('aucune colonne libre'));
    // Messages stay selectable by a click.
    click(message('sent'));
    expect(checkboxOf('Coucou').checked).toBe(true);
  });

  it('reports the checkboxes really visible: placed, on screen, and not covered', async () => {
    start();
    await vi.waitFor(() => expect(session!.state()).toMatchObject({ checkboxes: 4, placed: 4 }));
    const host = document.querySelector(LAYER_TAG)!;
    document.elementFromPoint = () => host;
    expect(session!.state().visible).toBe(4);
    // Something of the page painted above the layer.
    document.elementFromPoint = () => message('received');
    expect(session!.state().visible).toBe(0);
    delete (document as { elementFromPoint?: unknown }).elementFromPoint;
  });
});

describe('real Snapchat Web structure', () => {
  it('finds the messages despite the conversation menu list Downshift keeps in the header', () => {
    expect(chatContainer(document)).toBe(document.querySelector('[data-chat]'));
    expect(readMessages(document)!.messages).toHaveLength(5);
  });

  it('shows the checkboxes when the mode is started from Notes after Snapchat is loaded, popup closed', async () => {
    storage = fakeChrome({ [NOTES_ENABLED]: true });
    registerNotesBackground(storage.api, selections);
    showTab(ALICE);
    start();
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(checkboxes()).toEqual([]);
    // « Sélectionner des messages » in the note: written by the Notes page, nothing else open.
    await storage.externalSet({ [NotesKeys.selecting]: ALICE });
    await vi.waitFor(() => expect(checkboxes()).toHaveLength(5));
    expect(document.querySelector(LAYER_TAG)!.isConnected).toBe(true);
  });

  it('tries loading the selection again after a failure instead of staying without checkboxes', async () => {
    storage = fakeChrome({ [NOTES_ENABLED]: true, [NotesKeys.selecting]: ALICE });
    showTab(ALICE);
    // No service worker yet: the first load fails.
    start();
    await vi.waitFor(() => expect(session!.state().selection).toBe('error'));
    expect(checkboxes()).toEqual([]);
    registerNotesBackground(storage.api, selections);
    message('hello').append(' ');
    await vi.waitFor(() => expect(checkboxes()).toHaveLength(5));
  });

  it('logs counts and states only, and only when the diagnostics are on', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    start();
    await ready();
    expect(info).not.toHaveBeenCalled();
    localStorage.setItem(DEBUG_FLAG, '1');
    message('hello').append(' ');
    await vi.waitFor(() => expect(info).toHaveBeenCalled());
    const line = String(info.mock.calls.at(-1)![0]);
    expect(line).toMatch(/^\[LeakZero Sélection\] /);
    expect(JSON.parse(line.replace('[LeakZero Sélection] ', ''))).toEqual({
      enabled: true, target: ALICE.slice(0, 8), shown: ALICE.slice(0, 8), closeChatButtons: 1, chatFound: true,
      listItems: 7, messages: 5, selection: 'loaded', layerMounted: true, checkboxes: 5, column: null, noColumn: false, placed: 0, visible: 0,
    });
    for (const text of ['Salut', 'Alice', 'ok', '06 12', 'Photo', 'example.com']) expect(line).not.toContain(text);
  });
});

describe('per conversation', () => {
  it('keeps the selections of two conversations apart, even for identical messages', async () => {
    start();
    await ready();
    click(message('ok1'));
    await vi.waitFor(async () => expect(await selections.list(ALICE)).toHaveLength(1));

    // Another conversation is open: the mode, started for Alice, shows nothing there.
    showTab(BOB);
    openConversation(BOB, 'Alice');
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(document.querySelector(LAYER_TAG)).toBeNull();
    click(message('hello'));
    expect(snapchatClick).toHaveBeenCalledTimes(1);

    // Started for Bob: same messages, but nothing selected there.
    await storage.externalSet({ [NotesKeys.selecting]: BOB });
    await ready();
    expect(selectedNames()).toEqual([]);
    click(message('hello'));
    await vi.waitFor(async () => expect(await selections.list(BOB)).toHaveLength(1));

    expect((await selections.list(ALICE)).map((record) => record.text)).toEqual(['ok']);
    expect((await selections.list(BOB)).map((record) => record.text)).toEqual(['Salut toi']);

    // Back to Alice: her selection comes back.
    await storage.externalSet({ [NotesKeys.selecting]: ALICE });
    showTab(ALICE);
    openConversation(ALICE, 'Alice');
    await vi.waitFor(() => expect(selectedNames()).toEqual(['ok1']));
  });

  it('refuses a selection for a conversation the tab does not show, or while the module is disabled', async () => {
    const [read] = readMessages(document)!.messages;
    showTab(BOB);
    expect(await storage.api.runtime.sendMessage({ type: 'notes:select', message: read.message })).toMatchObject({ ok: false });
    showTab(ALICE);
    await storage.externalSet({ [NOTES_ENABLED]: false });
    expect(await storage.api.runtime.sendMessage({ type: 'notes:select', message: read.message })).toMatchObject({ ok: false, error: 'Le module Notes est désactivé.' });
    expect(await selections.list(ALICE)).toEqual([]);
  });
});

describe('persistence', () => {
  it('restores the selection after Snapchat is reloaded and the browser restarted', async () => {
    start();
    await ready();
    click(message('ok2'));
    click(message('photo'));
    await vi.waitFor(async () => expect(await selections.list(ALICE)).toHaveLength(2));

    // Browser restart: content script and database connection gone, same IndexedDB on disk.
    session!.stop();
    await selections.close();
    storage = fakeChrome({ [NOTES_ENABLED]: true, [NotesKeys.selecting]: ALICE });
    selections = createSelectionStore(() => factory);
    registerNotesBackground(storage.api, selections);
    showTab(ALICE);
    openConversation(ALICE, 'Alice');
    start();
    await vi.waitFor(() => expect(selectedNames()).toEqual(['ok2', 'photo']));
    expect(checked()).toEqual(['Sélectionner le message de Alice « ok »', 'Sélectionner le message de Alice (image)']);
    expect(checkboxes().filter((input) => input.checked)).toHaveLength(2);
  });

  it('keeps one record, and its first selection date, for a message selected twice', async () => {
    const [read] = readMessages(document)!.messages;
    const first = await selections.select(read.message);
    const again = await selections.select({ ...read.message, text: 'autre' });
    expect(again).toEqual(first);
    expect(await selections.list(ALICE)).toEqual([first]);
  });
});
