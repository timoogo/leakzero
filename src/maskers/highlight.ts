// In-flow underlay for reinforced mode, using the CSS Custom Highlight API: the number's glyphs are
// made transparent on an opaque black background, exactly where the text is laid out. It needs no
// element and cannot lag behind scrolling, so the number stays hidden under the reinforced box of
// overlay.ts even during the frame where that box catches up with a scroll.
export const PHONE_BOX = 'leakzero-phone-box';

export const PHONE_HIGHLIGHT_CSS = `
::highlight(${PHONE_BOX}) {
  background-color: #000;
  color: transparent;
  text-shadow: none;
  text-decoration: none;
}
`;

function phoneBox(): Highlight | undefined {
  // Missing in old browsers (Chrome < 105): the overlay alone covers the number.
  if (typeof CSS === 'undefined' || !CSS.highlights || typeof Highlight === 'undefined') return undefined;
  let highlight = CSS.highlights.get(PHONE_BOX);
  if (!highlight) {
    highlight = new Highlight();
    CSS.highlights.set(PHONE_BOX, highlight);
  }
  return highlight;
}

export function addHighlights(ranges: readonly AbstractRange[]): void {
  const highlight = phoneBox();
  if (highlight) for (const range of ranges) highlight.add(range);
}

export function removeHighlights(ranges: readonly AbstractRange[]): void {
  const highlight = phoneBox();
  if (highlight) for (const range of ranges) highlight.delete(range);
}

/** Releases ranges of text nodes removed from the page, so they can be garbage collected. */
export function pruneDetachedHighlights(): void {
  const highlight = phoneBox();
  if (!highlight) return;
  for (const range of highlight) {
    if (!range.startContainer.isConnected) highlight.delete(range);
  }
}
