import type { NumberMatch } from '../detectors/numbers';
import { addHighlights, removeHighlights } from './highlight';
import { addOverlays, removeOverlays } from './overlay';

/** `classic`: phone masks are blurred. `reinforced`: blurred and covered by an opaque labelled box. */
export type PhoneStyle = 'classic' | 'reinforced';

// Both are written in the text, so no digit is left in the page even if a visual layer lags or is
// removed. Phone masks are then blurred, or covered, by overlay.ts (and highlight.ts in reinforced
// mode). The phone mask is the same in both modes (switching never rewrites the text) and has a
// fixed length, which does not reveal the number's.
export const DIGITS_MASK = '•••';
export const PHONE_MASK = '**********';

interface MaskRecord {
  original: string;
  style: PhoneStyle;
  masked: string;
  /** Ranges over the phone masks, protected visually (see addLayers). */
  ranges: StaticRange[];
}

// The Text node itself is kept and only its data changes: frameworks (React, Vue…) keep
// references to their text nodes, so splitting or replacing them would break the page.
const records = new WeakMap<Text, MaskRecord>();

/** True when the node currently shows text written (or checked) by this module. */
export function isMaskedByUs(node: Text): boolean {
  return records.get(node)?.masked === node.data;
}

/** Replaces numbers in the text, and protects phone masks visually. */
export function maskText(node: Text, matches: readonly NumberMatch[], style: PhoneStyle): void {
  const original = node.data;
  const phones: [number, number][] = [];
  let masked = '';
  let cursor = 0;
  for (const { start, end, kind } of matches) {
    masked += original.slice(cursor, start);
    if (kind === 'phone') {
      phones.push([masked.length, masked.length + PHONE_MASK.length]);
      masked += PHONE_MASK;
    } else {
      masked += DIGITS_MASK;
    }
    cursor = end;
  }
  masked += original.slice(cursor);
  node.data = masked;

  // Static, not live, ranges: a live Range would be moved to the parent when the node is detached.
  // Static offsets stay valid because any change to the node's text drops and rebuilds them.
  const ranges = phones.map(
    ([startOffset, endOffset]) => new StaticRange({ startContainer: node, startOffset, endContainer: node, endOffset }),
  );
  records.set(node, { original, style, masked, ranges });
  addLayers(ranges, style);
}

/**
 * Brings a protected node to `style` without touching its text, or re-applies its layers after
 * it was detached and re-inserted. Layers of the new style are added before the old ones are
 * removed, so the number is never left uncovered in between.
 */
export function applyStyle(node: Text, style: PhoneStyle): void {
  const record = records.get(node);
  if (!record || record.masked !== node.data) return;
  const previous = record.style;
  record.style = style;
  addLayers(record.ranges, style);
  if (previous === 'reinforced' && style === 'classic') removeHighlights(record.ranges);
}

function addLayers(ranges: StaticRange[], style: PhoneStyle) {
  if (style === 'reinforced') addHighlights(ranges);
  addOverlays(ranges, style === 'reinforced');
}

/** Puts the original text back, unless the page has rewritten the node since it was masked. */
export function restoreText(node: Text): void {
  const record = records.get(node);
  if (!record) return;
  forgetText(node);
  if (node.data === record.masked) node.data = record.original;
}

/** Drops the record (and visual layers) of a node, e.g. when the page replaced its content. */
export function forgetText(node: Text): void {
  const record = records.get(node);
  if (!record) return;
  records.delete(node);
  removeHighlights(record.ranges);
  removeOverlays(record.ranges);
}
