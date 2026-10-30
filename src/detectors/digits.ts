import type { TextRange } from './range';

// Separators allowed between the digits of one sequence: space, tab, no-break spaces, "-" and ".".
// "/", ":", "," and letters end a sequence, so "12/05", "14:30" or "14h30" are short sequences.
const SEP = '[ \\t.\\-\\u00a0\\u202f]';
const DIGIT_RUN = new RegExp(`(?<!\\d)\\d(?:${SEP}?\\d)*(?!\\d)`, 'g');

/** Minimum number of digits for a generic sequence to be masked: 1 or 2 digits stay visible. */
export const MIN_SEQUENCE_DIGITS = 3;

const AMOUNT = String.raw`\d{1,3}(?:[ .,  ]\d{3})+(?:[.,]\d{1,2})?|\d+(?:[.,]\d+)?`;
const CURRENCY = String.raw`[€$£¥]|EUR|USD|GBP|CHF|CAD|euros?|dollars?|livres?|francs?`;

// Contexts in which a sequence of 3+ digits is kept visible to limit false positives.
const EXCEPTIONS: { pattern: RegExp; accept?: (match: RegExpExecArray) => boolean }[] = [
  // Dates: 12/05/2024, 12.05.2024, 12-05-24, 2024-05-12.
  {
    pattern: /(?<!\d)(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{4}|\d{2})(?![\d.\-]\d)/g,
    accept: (m) => isDayMonth(+m[1], +m[2]),
  },
  {
    pattern: /(?<!\d)(?:19|20)\d{2}[/.\-](\d{1,2})[/.\-](\d{1,2})(?![\d.\-]\d)/g,
    accept: (m) => isDayMonth(+m[2], +m[1]),
  },
  // Times with seconds or milliseconds: 14:30:45, 14:30:45.123.
  { pattern: /(?<!\d)\d{1,2}:\d{2}(?::\d{2})?(?:[.,]\d{1,3})?(?!\d)/g },
  // Ages: 103 ans, 101 years old, 100yo.
  { pattern: /(?<![\d.,])\d{1,3}\s?(?:ans?|years?(?:\s+old)?|yo|y\/o)(?!\p{L})/gu },
  // Prices and amounts: 1 234,56 €, $1,299.99, 250 EUR, 45 %.
  { pattern: new RegExp(`(?:${CURRENCY})\\s?(?:${AMOUNT})`, 'gu') },
  { pattern: new RegExp(`(?<![\\d.,])(?:${AMOUNT})\\s?(?:k|K|M|Md)?\\s?(?:${CURRENCY}|%)(?!\\p{L})`, 'gu') },
];

// Standalone years such as "en 2024" stay visible.
const YEAR = /^(?:19|20)\d{2}$/;

function isDayMonth(day: number, month: number): boolean {
  return day >= 1 && day <= 31 && month >= 1 && month <= 12;
}

export function countDigits(text: string): number {
  let count = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code >= 48 && code <= 57) count++;
  }
  return count;
}

/** Sequences of digits joined by at most one separator between digits, e.g. "06 12-34.56". */
export function digitRuns(text: string): TextRange[] {
  return [...text.matchAll(DIGIT_RUN)].map((m) => ({ start: m.index, end: m.index + m[0].length }));
}

function protectedRanges(text: string): TextRange[] {
  const ranges: TextRange[] = [];
  for (const { pattern, accept } of EXCEPTIONS) {
    for (const m of text.matchAll(pattern)) {
      if (!accept || accept(m)) ranges.push({ start: m.index, end: m.index + m[0].length });
    }
  }
  return ranges;
}

/**
 * Sequences of 3 or more digits, whatever they represent, except dates, times, years, ages,
 * prices and amounts. A sequence is only kept visible when it lies entirely inside an exception.
 */
export function detectDigitSequences(text: string): TextRange[] {
  if (countDigits(text) < MIN_SEQUENCE_DIGITS) return [];
  const runs = digitRuns(text).filter((run) => countDigits(text.slice(run.start, run.end)) >= MIN_SEQUENCE_DIGITS);
  if (runs.length === 0) return [];
  const exceptions = protectedRanges(text);
  return runs.filter((run) => {
    if (YEAR.test(text.slice(run.start, run.end))) return false;
    return !exceptions.some((e) => e.start <= run.start && run.end <= e.end);
  });
}
