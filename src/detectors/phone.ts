import { findPhoneNumbersInText, isSupportedCountry, isValidPhoneNumber, type CountryCode } from 'libphonenumber-js/max';
import { countDigits, digitRuns } from './digits';
import { removeOverlaps, type TextRange } from './range';

// Below this many digits a text cannot hold a phone number: cheap pre-filter before libphonenumber.
const MIN_DIGITS = 7;
// "00" international dialing prefix at a token boundary (e.g. "0033 6 …").
const IDD_00 = /(^|[\s(:])00(?=[1-9])/g;
// French mobile numbers, whatever the browser language: 06/07 + 8 digits, with optional
// spaces, no-break spaces, "-" or "." between digit pairs.
const FR_MOBILE = /(?<![\d+])0[67](?:[ .\-\u00a0\u202f]?\d{2}){4}(?!\d)/g;
// "+" or "00" followed by digits separated by spaces, "-", "." or parentheses, e.g. "+33000000000",
// "+1 (202) 555-0123". Validity is not required: fictitious numbers must be masked too.
const INTERNATIONAL = /(?:(?<!\d[ .\-\u00a0\u202f]?)\+|(?<!\d[ .\-\u00a0\u202f]?)00)(?:[ .\-\u00a0\u202f()]{0,3}\d)+/g;
const INTERNATIONAL_DIGITS = { min: 8, max: 15 };
// Country code + subscriber number is at most 15 digits (E.164); 11 is the shortest we accept bare.
const BARE_INTERNATIONAL_DIGITS = { min: 11, max: 15 };
// Plain thousands grouping such as "123 456 789" or "1.234.567".
const THOUSANDS = /^\d{1,3}(?:[ .,  ]\d{3})+$/;
const FORMATTING = /[\s().-]/;
const CURRENCY_BEFORE = /[€$£¥]\s?$/;
const CURRENCY_OR_PERCENT_AFTER = /^\s?[€$£¥%]/;

/** Region codes derived from browser locales, e.g. ["fr-FR", "en-US"] → ["FR", "US"]. */
export function countriesFromLanguages(languages: readonly string[]): CountryCode[] {
  const countries = new Set<CountryCode>();
  for (const language of languages) {
    const region = language.split('-')[1]?.toUpperCase();
    if (region && isSupportedCountry(region)) countries.add(region);
  }
  return [...countries];
}

/**
 * Finds phone numbers in `text`. International numbers ("+…", "00…" or a bare country code such
 * as "33 6 12 34 56 78") and French mobiles (06/07) are always detected; other national numbers
 * are detected for each of `countries`.
 */
export function detectPhoneNumbers(text: string, countries: readonly CountryCode[] = []): TextRange[] {
  if (countDigits(text) < MIN_DIGITS) return [];
  // Same-length rewrite "00" → " +" so offsets stay valid in the original text.
  const normalized = text.replace(IDD_00, (_match, boundary: string) => `${boundary} +`);

  const candidates: TextRange[] = [
    ...findInternational(text).filter((match) => isPlausible(text, match)),
    ...findFrenchMobiles(text),
    ...findBareInternational(text),
  ];
  for (const defaultCountry of [undefined, ...countries]) {
    for (const found of findPhoneNumbersInText(normalized, defaultCountry ? { defaultCountry } : undefined)) {
      let start = found.startsAt;
      if (normalized[start] === '+' && text[start] === '0') start -= 1;
      const match = { start, end: withoutExtension(text, start, found.endsAt, found.number.ext) };
      if (isPlausible(text, match)) candidates.push(match);
    }
  }
  return removeOverlaps(candidates);
}

/** Excludes an extension ("…, 12", "… ext. 1234") from the match: it is handled as a plain digit sequence. */
function withoutExtension(text: string, start: number, end: number, ext: string | undefined): number {
  if (!ext) return end;
  const raw = text.slice(start, end);
  const cut = raw.search(new RegExp(`\\D*${ext}$`));
  return cut > 0 ? start + cut : end;
}

function findInternational(text: string): TextRange[] {
  return [...text.matchAll(INTERNATIONAL)]
    .filter((m) => {
      const digits = countDigits(m[0]) - (m[0].startsWith('00') ? 2 : 0);
      return digits >= INTERNATIONAL_DIGITS.min && digits <= INTERNATIONAL_DIGITS.max;
    })
    .map((m) => ({ start: m.index, end: m.index + m[0].length }));
}

function findFrenchMobiles(text: string): TextRange[] {
  return [...text.matchAll(FR_MOBILE)].map((m) => ({ start: m.index, end: m.index + m[0].length }));
}

/** Digit sequences that form a valid number once "+" is prepended, e.g. "447911123456". */
function findBareInternational(text: string): TextRange[] {
  return digitRuns(text).filter(({ start, end }) => {
    const digits = text.slice(start, end).replace(/\D/g, '');
    if (digits.startsWith('0')) return false;
    if (digits.length < BARE_INTERNATIONAL_DIGITS.min || digits.length > BARE_INTERNATIONAL_DIGITS.max) return false;
    return isValidPhoneNumber(`+${digits}`);
  });
}

function isPlausible(text: string, { start, end }: TextRange): boolean {
  if (CURRENCY_BEFORE.test(text.slice(0, start)) || CURRENCY_OR_PERCENT_AFTER.test(text.slice(end))) return false;
  const raw = text.slice(start, end);
  if (raw.startsWith('+') || raw.startsWith('00')) return true;
  // National numbers: accept a trunk prefix ("06 …", "0612345678") or phone-like formatting
  // ("(415) 555-2671"), but not bare digit runs or thousands-grouped amounts.
  if (raw.startsWith('0')) return true;
  return FORMATTING.test(raw) && !THOUSANDS.test(raw);
}
