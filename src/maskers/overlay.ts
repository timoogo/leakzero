// Visual protection drawn above detected phone numbers, outside the page's own DOM tree.
//
// Highlights cannot blur (`filter` is not allowed in ::highlight) and wrapping the number in an
// element would break React/Vue, so boxes are drawn in a fixed, full-viewport layer appended to
// <html> (closed shadow root, isolated from page CSS, click-through). Each frame, the boxes are
// placed on the number's line boxes (Range.getClientRects), clipped by its scrolling ancestors:
// - every phone: `backdrop-filter: blur()`, a real blur of the number underneath;
// - reinforced: above that blur, an opaque black box fitted to the number, with the white label.
export const OVERLAY_TAG = 'leakzero-overlay';
export const PHONE_LABEL = '🛡︎ Numéro masqué';

// Measured in Chromium: backdrop-filter samples mirrored pixels at the box edges, so a blur radius
// that is large compared to the box height leaves the text readable (stronger is not better).
// Sized from the line height, a radius of ~1/4 of it in a box padded by ~1/2 of it on every side
// makes digits illegible from 12 to 24px text.
const BLUR_FACTOR = 0.25;
const BLUR_PAD_FACTOR = 0.5;
// The reinforced box fits the number itself and is drawn above its blur.
const BOX_PAD_X = 2;
const BOX_PAD_Y = 1;
const BLUR_CSS =
  'position:absolute;box-sizing:border-box;margin:0;border-radius:4px;pointer-events:none;' +
  'background:rgba(128,128,128,.25);';
const BOX_CSS =
  'position:absolute;box-sizing:border-box;margin:0;border-radius:3px;pointer-events:none;' +
  'background:#000;color:#fff;display:flex;align-items:center;justify-content:center;' +
  'overflow:hidden;white-space:nowrap;font-family:system-ui,sans-serif;font-weight:600;line-height:1;';

interface Entry {
  boxed: boolean;
  /** Ancestors that clip their content (scroll containers…), computed once when tracked. */
  clips: Element[];
}

export interface Box {
  kind: 'blur' | 'box';
  left: number;
  top: number;
  width: number;
  height: number;
  /** Blur radius (blur) or whether the label goes in this box (box). */
  blur: number;
  label: boolean;
}

const entries = new Map<StaticRange, Entry>();
const pool: HTMLDivElement[] = [];
// Last style written to each pooled box: `style.cssText` is re-serialised by the browser, so it
// cannot be compared with the string we write. Rewriting it every frame would restart the blur.
const written = new WeakMap<HTMLDivElement, string>();
let host: HTMLElement | undefined;
let layer: ShadowRoot | undefined;
let frame = 0;
let drawn: readonly Box[] = [];

export function addOverlays(ranges: readonly StaticRange[], boxed: boolean): void {
  if (ranges.length === 0) return;
  for (const range of ranges) entries.set(range, { boxed, clips: clippingAncestors(range.startContainer) });
  // Drawn right away, not on the next frame: the number must not be painted unprotected once,
  // even if it was inserted from a requestAnimationFrame callback.
  renderOverlays();
  schedule();
}

export function removeOverlays(ranges: readonly StaticRange[]): void {
  let removed = false;
  for (const range of ranges) removed = entries.delete(range) || removed;
  if (removed) renderOverlays();
}

/** Releases ranges of text nodes removed from the page. */
export function pruneDetachedOverlays(): void {
  let removed = false;
  for (const range of entries.keys()) {
    if (!range.startContainer.isConnected) removed = entries.delete(range) || removed;
  }
  if (removed) renderOverlays();
}

/** Re-inserts the layer if the page removed it (e.g. when it rewrites the document). */
export function ensureOverlayAttached(): void {
  if (host && !host.isConnected && entries.size > 0) attachHost();
}

export function clearOverlays(): void {
  entries.clear();
  if (frame) cancelAnimationFrame(frame);
  frame = 0;
  host?.remove();
}

/** Places every box on its number; runs each frame while numbers are tracked, to follow scrolling and layout. */
export function renderOverlays(): void {
  const boxes: Box[] = [];
  const range = document.createRange();
  for (const [staticRange, entry] of entries) {
    const node = staticRange.startContainer;
    if (!node.isConnected || staticRange.endOffset > (node as Text).length) continue;
    range.setStart(node, staticRange.startOffset);
    range.setEnd(node, staticRange.endOffset);
    const clip = clipRect(entry.clips);
    const lines = [...range.getClientRects()].filter((rect) => rect.width > 0 && rect.height > 0);
    const blurs: Box[] = [];
    const covers: Box[] = [];
    for (const rect of lines) {
      const pad = rect.height * BLUR_PAD_FACTOR;
      const blur = clipped(rect, pad, pad, clip, 'blur');
      if (blur) blurs.push({ ...blur, blur: Math.round(rect.height * BLUR_FACTOR * 10) / 10 });
      const cover = entry.boxed ? clipped(rect, BOX_PAD_X, BOX_PAD_Y, clip, 'box') : undefined;
      if (cover) covers.push(cover);
    }
    // The label goes in the widest line box when the number wraps.
    const widest = covers.reduce<Box | undefined>((best, box) => (!best || box.width > best.width ? box : best), undefined);
    if (widest) widest.label = true;
    boxes.push(...blurs, ...covers);
  }
  // All blurs first, so every box is painted above every blur, including a neighbouring line's halo.
  boxes.sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'blur' ? -1 : 1));
  draw(boxes);
}

function clipped(rect: DOMRect, padX: number, padY: number, clip: ReturnType<typeof clipRect>, kind: Box['kind']): Box | undefined {
  const left = Math.max(rect.left - padX, clip.left);
  const top = Math.max(rect.top - padY, clip.top);
  const right = Math.min(rect.right + padX, clip.right);
  const bottom = Math.min(rect.bottom + padY, clip.bottom);
  if (right <= left || bottom <= top) return undefined;
  return { kind, left, top, width: right - left, height: bottom - top, blur: 0, label: false };
}

/** Read-only view of what is protected and drawn, for tests (the layer's shadow root is closed). */
export function overlayState() {
  return {
    phones: [...entries.keys()]
      .filter((range) => range.startContainer.isConnected)
      .map((range) => (range.startContainer as Text).data.slice(range.startOffset, range.endOffset)),
    boxes: drawn,
    host,
  };
}

function schedule() {
  if (!frame) frame = requestAnimationFrame(onFrame);
}

function onFrame() {
  frame = 0;
  renderOverlays();
  if (entries.size > 0) schedule();
}

function attachHost() {
  if (!host) {
    host = document.createElement(OVERLAY_TAG);
    host.setAttribute('aria-hidden', 'true');
    for (const [property, value] of [
      ['all', 'initial'], ['position', 'fixed'], ['inset', '0'], ['display', 'block'],
      ['pointer-events', 'none'], ['z-index', '2147483647'],
    ]) host.style.setProperty(property, value, 'important');
    // No `contain`, filter, opacity… on the host: any of them makes it a backdrop root, and
    // backdrop-filter would then blur the (empty) host instead of the page behind it.
    layer = host.attachShadow({ mode: 'closed' });
  }
  document.documentElement.append(host);
}

function draw(boxes: Box[]) {
  drawn = boxes;
  if (boxes.length === 0 && !host?.isConnected) return;
  if (!host?.isConnected) attachHost();
  for (let i = 0; i < Math.max(boxes.length, pool.length); i++) {
    const box = boxes[i];
    let div = pool[i];
    if (!box) {
      if (written.get(div) !== 'none') {
        div.style.cssText = 'display:none';
        written.set(div, 'none');
      }
      continue;
    }
    if (!div) {
      div = document.createElement('div');
      pool.push(div);
      layer!.append(div);
    }
    const position = `left:${box.left}px;top:${box.top}px;width:${box.width}px;height:${box.height}px;`;
    const css =
      box.kind === 'blur'
        ? BLUR_CSS + position + `backdrop-filter:blur(${box.blur}px);-webkit-backdrop-filter:blur(${box.blur}px);`
        : BOX_CSS + position + `font-size:${labelSize(box)}px;`;
    if (written.get(div) !== css) {
      div.style.cssText = css;
      written.set(div, css);
    }
    const text = box.label ? PHONE_LABEL : '';
    if (div.textContent !== text) div.textContent = text;
  }
}

/** Font size fitting the label in the box, which keeps the number's own width. */
function labelSize(box: Box): number {
  const fit = Math.min(box.height * 0.7, (box.width - 4) / (PHONE_LABEL.length * 0.58));
  return Math.max(6, Math.min(14, Math.floor(fit)));
}

export function clippingAncestors(node: Node): Element[] {
  const clips: Element[] = [];
  let current: Element | null = node.parentElement;
  while (current) {
    const style = getComputedStyle(current);
    if (style.overflowX !== 'visible' || style.overflowY !== 'visible') clips.push(current);
    current = current.parentElement ?? ((current.getRootNode() as ShadowRoot).host ?? null);
  }
  return clips;
}

export function clipRect(clips: readonly Element[]) {
  const clip = { left: 0, top: 0, right: innerWidth, bottom: innerHeight };
  for (const element of clips) {
    const rect = element.getBoundingClientRect();
    clip.left = Math.max(clip.left, rect.left);
    clip.top = Math.max(clip.top, rect.top);
    clip.right = Math.min(clip.right, rect.right);
    clip.bottom = Math.min(clip.bottom, rect.bottom);
  }
  return clip;
}
