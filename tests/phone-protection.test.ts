// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createScanner, type Scanner } from '../src/core/scanner';
import { DIGITS_MASK, PHONE_MASK } from '../src/maskers/text';
import { PHONE_BOX, PHONE_HIGHLIGHT_CSS } from '../src/maskers/highlight';
import { MEDIA_MASK_CSS } from '../src/maskers/media';
import { OVERLAY_TAG, overlayState, PHONE_LABEL, renderOverlays } from '../src/maskers/overlay';
import type { ProtectionSettings } from '../src/shared/types';

// jsdom has no CSS Custom Highlight API: minimal stand-in with the same shape.
class FakeHighlight extends Set<AbstractRange> {}
const registry = new Map<string, FakeHighlight>();
Object.assign(globalThis, { Highlight: FakeHighlight });
Object.assign(globalThis.CSS, { highlights: registry });

const OFF: ProtectionSettings = { maskPhones: false, reinforcedPhones: false, maskMedia: true };
const CLASSIC: ProtectionSettings = { maskPhones: true, reinforcedPhones: false, maskMedia: true };
const REINFORCED: ProtectionSettings = { ...CLASSIC, reinforcedPhones: true };
const OFF_REINFORCED: ProtectionSettings = { ...REINFORCED, maskPhones: false };
const STATES = { off: OFF, classic: CLASSIC, reinforced: REINFORCED } as const;
type State = keyof typeof STATES;

const ORIGINAL = 'Tel 06 12 34 56 78 / +44 7911 123456, code 4821, 12 chats';
const MASKED = `Tel ${PHONE_MASK} / ${PHONE_MASK}, code ${DIGITS_MASK}, 12 chats`;
const PHONES = [PHONE_MASK, PHONE_MASK];
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const nextFrame = () => new Promise((resolve) => requestAnimationFrame(() => resolve(undefined)));
let scanner: Scanner | undefined;

function start(settings: ProtectionSettings, html = `<p id="m">${ORIGINAL}</p>`) {
  document.body.innerHTML = html;
  scanner = createScanner(document, ['FR']);
  scanner.apply(settings);
  return scanner;
}

const text = () => document.getElementById('m')!.textContent;
const boxes = () => overlayState().boxes;
const blurs = () => boxes().filter((box) => box.kind === 'blur');
const covers = () => boxes().filter((box) => box.kind === 'box');
const underlay = () => [...(registry.get(PHONE_BOX) ?? [])];

/** Asserts what is protected and drawn for one of the three expected states. */
function expectState(state: State) {
  if (state === 'off') {
    expect(text()).toBe(ORIGINAL);
    expect(overlayState().phones).toEqual([]);
    expect(boxes()).toEqual([]);
    expect(underlay()).toEqual([]);
    return;
  }
  // Same text in both modes: no digit of the numbers is left in the page, whatever the layers do.
  expect(text()).toBe(MASKED);
  expect(text()).not.toMatch(/0612|7911|123456|4821/);
  expect(overlayState().phones).toEqual(PHONES);
  // The blur is there in both modes.
  expect(blurs()).toHaveLength(2);
  if (state === 'classic') {
    expect(covers()).toEqual([]);
    expect(underlay()).toEqual([]);
  } else {
    expect(covers()).toHaveLength(2);
    expect(covers().every((box) => box.label)).toBe(true);
    expect(underlay()).toHaveLength(2);
  }
}

beforeEach(() => registry.clear());
afterEach(() => {
  scanner?.stop();
  scanner = undefined;
  vi.restoreAllMocks();
  document.querySelectorAll('style[data-leakzero]').forEach((s) => s.remove());
});

describe('the three states', () => {
  it('numbers off: nothing is protected, whatever the reinforced mode', () => {
    start(OFF);
    expectState('off');
    scanner!.apply(OFF_REINFORCED);
    expectState('off');
  });

  it('numbers on, reinforced off: the number is replaced by asterisks, which are blurred', () => {
    start(CLASSIC);
    expectState('classic');
    expect(PHONE_MASK).toBe('**********');
    expect(text()).not.toContain('Numéro masqué');
  });

  it('gives every phone the same mask, which does not reveal its length', () => {
    start(CLASSIC, '<p id="m">+44 20 7946 0958 et 0612345678</p>');
    expect(text()).toBe(`${PHONE_MASK} et ${PHONE_MASK}`);
  });

  it('keeps every digit hidden even if the visual layer is removed', () => {
    start(REINFORCED);
    overlayState().host!.remove();
    registry.clear();
    expect(document.body.textContent).not.toMatch(/\d{3}/);
  });

  it('numbers on, reinforced on: the blur stays and an opaque labelled box covers the asterisks', () => {
    start(REINFORCED);
    expectState('reinforced');
    expect(PHONE_LABEL).toBe('🛡︎ Numéro masqué');
  });
});

describe('rendering', () => {
  it('sizes the blur from the line height: radius 1/4, padding 1/2', () => {
    start(CLASSIC, '<p id="m">06 12 34 56 78</p>');
    // Default test geometry: one line box at (10, 20), 100×18.
    expect(blurs()).toEqual([{ kind: 'blur', left: 1, top: 11, width: 118, height: 36, blur: 4.5, label: false }]);
  });

  it('draws the reinforced box over the number, above every blur', () => {
    start(REINFORCED);
    const kinds = boxes().map((box) => box.kind);
    expect(kinds).toEqual(['blur', 'blur', 'box', 'box']);
    expect(covers()[0]).toMatchObject({ left: 8, top: 19, width: 104, height: 20 });
  });

  it('follows a number that wraps, with the label in the widest line box', () => {
    vi.spyOn(Range.prototype, 'getClientRects').mockReturnValue([
      { left: 200, top: 20, right: 230, bottom: 38, width: 30, height: 18 },
      { left: 0, top: 40, right: 90, bottom: 58, width: 90, height: 18 },
    ] as unknown as DOMRectList);
    start(REINFORCED, '<p id="m">au +44 7911 123456 merci</p>');
    expect(blurs()).toHaveLength(2);
    expect(covers().map((box) => [box.top, box.label])).toEqual([[19, false], [39, true]]);
  });

  it('follows layout changes on the next frame', async () => {
    start(CLASSIC, '<p id="m">06 12 34 56 78</p>');
    expect(blurs()[0].top).toBe(11);
    vi.spyOn(Range.prototype, 'getClientRects').mockReturnValue([
      { left: 10, top: 120, right: 110, bottom: 138, width: 100, height: 18 },
    ] as unknown as DOMRectList);
    await nextFrame();
    await nextFrame();
    expect(blurs()[0].top).toBe(111);
  });

  it('clips the layers to scrolling ancestors and hides numbers scrolled out of view', () => {
    document.body.innerHTML = '<div id="scroller" style="overflow-x: auto; overflow-y: auto"><p id="m">06 12 34 56 78</p></div>';
    const scroller = document.getElementById('scroller')!;
    const viewport = { left: 0, top: 0, right: 300, bottom: 30 };
    vi.spyOn(scroller, 'getBoundingClientRect').mockImplementation(() => ({ ...viewport, width: 300, height: 30 }) as DOMRect);
    scanner = createScanner(document, ['FR']);
    scanner.apply(REINFORCED);
    expect(blurs()[0]).toMatchObject({ top: 11, height: 19 });
    expect(covers()[0]).toMatchObject({ top: 19, height: 11 });
    viewport.top = 100;
    viewport.bottom = 200;
    renderOverlays();
    expect(boxes()).toEqual([]);
  });

  it('draws in an isolated, click-through layer outside the page tree, without touching it', () => {
    start(REINFORCED);
    const { host } = overlayState();
    expect(host!.tagName.toLowerCase()).toBe(OVERLAY_TAG);
    expect(host!.parentNode).toBe(document.documentElement);
    expect(host!.shadowRoot).toBeNull(); // closed
    expect(host!.getAttribute('aria-hidden')).toBe('true');
    expect(host!.style.getPropertyValue('pointer-events')).toBe('none');
    expect(host!.style.getPropertyPriority('position')).toBe('important');
    // No contain/filter/opacity on the host: it would become a backdrop root and blur nothing.
    expect(host!.style.getPropertyValue('contain')).toBe('');
    expect(document.body.innerHTML).toBe(`<p id="m">${MASKED}</p>`);
  });
});

describe('transitions', () => {
  const names = Object.keys(STATES) as State[];
  const pairs = names.flatMap((from) => names.filter((to) => to !== from).map((to) => [from, to] as const));

  it.each(pairs)('%s → %s', (from, to) => {
    const s = start(STATES[from]);
    const node = document.getElementById('m')!.firstChild;
    s.apply(STATES[to]);
    // Synchronously: the layers are in place before the next paint, without waiting for a frame.
    expectState(to);
    expect(document.getElementById('m')!.firstChild).toBe(node);
  });

  it('goes through every state and back to the exact original text', () => {
    const s = start(CLASSIC);
    for (const state of ['reinforced', 'classic', 'reinforced', 'off', 'reinforced', 'off', 'classic', 'off'] as const) {
      s.apply(STATES[state]);
      expectState(state);
    }
  });

  it('never rewrites the text when switching modes', () => {
    const s = start(CLASSIC);
    const node = document.getElementById('m')!.firstChild as Text;
    const set = vi.spyOn(CharacterData.prototype, 'data', 'set');
    for (const settings of [REINFORCED, CLASSIC, REINFORCED, CLASSIC]) s.apply(settings);
    expect(set).not.toHaveBeenCalled();
    expect(node.data).toBe(MASKED);
  });

  it('adds the classic blur before removing the reinforced box', () => {
    const s = start(REINFORCED);
    const remove = vi.spyOn(FakeHighlight.prototype, 'delete');
    s.apply(CLASSIC);
    // When the reinforced box goes away, the blur of the classic mode is already drawn.
    expect(remove).toHaveBeenCalled();
    expect(blurs()).toHaveLength(2);
  });

  it('keeps the reinforced choice while numbers are off and applies it when they come back', () => {
    const s = start(CLASSIC);
    s.apply(OFF);
    s.apply(OFF_REINFORCED);
    expectState('off');
    s.apply(REINFORCED);
    expectState('reinforced');
  });
});

describe('dynamic messages', () => {
  it('protects messages added before and after a mode switch with the current mode', async () => {
    const s = start(CLASSIC, '<div id="chat"></div>');
    const chat = document.getElementById('chat')!;
    chat.innerHTML = '<p>a: 06 12 34 56 78</p>';
    await flush();
    s.apply(REINFORCED);
    chat.insertAdjacentHTML('beforeend', '<p>b: 07 98 76 54 32</p>');
    await flush();
    expect(overlayState().phones).toHaveLength(2);
    expect(covers()).toHaveLength(2);
    s.apply(CLASSIC);
    chat.insertAdjacentHTML('beforeend', '<p>c: 06 11 22 33 44</p>');
    await flush();
    expect(blurs()).toHaveLength(3);
    expect(covers()).toHaveLength(0);
    expect(chat.textContent).toBe(`a: ${PHONE_MASK}b: ${PHONE_MASK}c: ${PHONE_MASK}`);
  });

  it('draws the layers as soon as the message is added, without waiting for a frame', async () => {
    start(REINFORCED, '<div id="chat"></div>');
    document.getElementById('chat')!.innerHTML = '<p>06 12 34 56 78</p>';
    await Promise.resolve();
    await Promise.resolve();
    expect(covers()).toHaveLength(1);
  });

  it('follows in-place text updates (React/Vue) and releases removed messages', async () => {
    start(REINFORCED, '<div id="chat"><p id="m">06 12 34 56 78</p></div>');
    const node = document.getElementById('m')!.firstChild as Text;
    node.data = 'encore 07 98 76 54 32';
    await flush();
    expect(node.data).toBe(`encore ${PHONE_MASK}`);
    expect(overlayState().phones).toHaveLength(1);
    node.data = 'plus rien';
    await flush();
    expect(boxes()).toEqual([]);
    node.data = '06 11 22 33 44';
    await flush();
    document.getElementById('m')!.remove();
    document.getElementById('chat')!.append(document.createElement('hr'));
    await flush();
    expect(overlayState().phones).toEqual([]);
    expect(boxes()).toEqual([]);
    expect(underlay()).toEqual([]);
  });

  it('brings a message detached during a mode switch to the current mode when re-inserted', async () => {
    const s = start(CLASSIC, '<div id="chat"><p id="m">06 12 34 56 78</p></div>');
    const p = document.getElementById('m')!;
    p.remove();
    s.apply(REINFORCED);
    document.getElementById('chat')!.append(p);
    await flush();
    expect(covers()).toHaveLength(1);
    expect(underlay()).toHaveLength(1);
  });

  it('re-inserts the layer if the page removes it', async () => {
    start(CLASSIC);
    overlayState().host!.remove();
    document.body.append(document.createElement('hr'));
    await flush();
    expect(overlayState().host!.isConnected).toBe(true);
  });
});

describe('restoration and media', () => {
  it('restores the exact original text and removes every layer on stop', () => {
    const s = start(REINFORCED);
    s.stop();
    scanner = undefined;
    expect(text()).toBe(ORIGINAL);
    expect(overlayState().phones).toEqual([]);
    expect(overlayState().host!.isConnected).toBe(false);
    expect(underlay()).toEqual([]);
  });

  it('does not change media masking', () => {
    const s = start(CLASSIC);
    const css = () => document.querySelector('style[data-leakzero]')!.textContent;
    for (const settings of [CLASSIC, REINFORCED, OFF_REINFORCED]) {
      s.apply(settings);
      expect(css()).toBe(PHONE_HIGHLIGHT_CSS + MEDIA_MASK_CSS);
    }
    s.apply({ ...REINFORCED, maskMedia: false });
    expect(css()).toBe(PHONE_HIGHLIGHT_CSS);
  });

  it('hides the number glyphs in the reinforced underlay', () => {
    expect(PHONE_HIGHLIGHT_CSS).toMatch(new RegExp(`::highlight\\(${PHONE_BOX}\\) \\{[^}]*background-color: #000;[^}]*color: transparent;`));
  });
});
