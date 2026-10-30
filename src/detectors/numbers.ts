import type { CountryCode } from 'libphonenumber-js/max';
import { detectDigitSequences, digitRuns } from './digits';
import { detectPhoneNumbers } from './phone';
import { overlaps, type TextRange } from './range';

export type NumberKind = 'phone' | 'digits';

export interface NumberMatch extends TextRange {
  kind: NumberKind;
}

/**
 * All numbers to mask in `text`, sorted and never overlapping. Phone numbers and generic
 * sequences of 3+ digits are merged, and every match is widened to the whole digit runs it
 * touches: a run of digits is either fully masked or fully visible, never partially.
 */
export function detectSensitiveNumbers(text: string, countries: readonly CountryCode[] = []): NumberMatch[] {
  const matches: NumberMatch[] = [
    ...detectPhoneNumbers(text, countries).map((range): NumberMatch => ({ ...range, kind: 'phone' })),
    ...detectDigitSequences(text).map((range): NumberMatch => ({ ...range, kind: 'digits' })),
  ];
  if (matches.length === 0) return [];
  for (const run of digitRuns(text)) {
    if (matches.some((match) => overlaps(match, run))) matches.push({ ...run, kind: 'digits' });
  }
  return mergeOverlapping(matches);
}

/** Merges overlapping matches; the result is a phone if any merged part is one. */
function mergeOverlapping(matches: NumberMatch[]): NumberMatch[] {
  matches.sort((a, b) => a.start - b.start);
  const merged: NumberMatch[] = [];
  for (const match of matches) {
    const last = merged.at(-1);
    if (last && overlaps(last, match)) {
      last.end = Math.max(last.end, match.end);
      if (match.kind === 'phone') last.kind = 'phone';
    } else {
      merged.push({ ...match });
    }
  }
  return merged;
}
