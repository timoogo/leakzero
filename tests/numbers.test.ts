import { describe, expect, it } from 'vitest';
import { detectDigitSequences, digitRuns } from '../src/detectors/digits';
import { detectSensitiveNumbers } from '../src/detectors/numbers';

function sequences(text: string) {
  return detectDigitSequences(text).map(({ start, end }) => text.slice(start, end));
}

describe('detectDigitSequences — masked sequences', () => {
  it.each([
    ['code 482', ['482']],
    ['PIN 4821 et 9876', ['4821', '9876']],
    ['réf 123-456', ['123-456']],
    ['12 34 56', ['12 34 56']],
    ['0612', ['0612']],
    ['n°12345678', ['12345678']],
    ['3.14159', ['3.14159']],
    ['version 1.2.3', ['1.2.3']],
    ['IP 192.168.1.1', ['192.168.1.1']],
    ['123 likes', ['123']],
    ['score 1000000', ['1000000']],
    ['12 345', ['12 345']],
  ])('masks digits in %j', (text, expected) => {
    expect(sequences(text)).toEqual(expected);
  });
});

describe('detectDigitSequences — kept visible', () => {
  it.each([
    // 1 or 2 digits
    'J’ai 7 chats et 12 poissons',
    'il y a 5 min',
    'salle 42',
    '3.5 étoiles',
    // ages
    "J'ai 25 ans",
    'elle a 101 ans',
    'he is 102 years old',
    '100yo',
    // dates
    'le 12/05/2024',
    'le 12.05.2024',
    'le 12-05-24',
    '2024-05-12',
    '2024/05/12',
    'né le 1.1.1990',
    // times
    'il est 14:30',
    'à 12:30:45',
    'à 14h30',
    'à 08:15:00.250',
    // years
    'en 2024',
    'depuis 1998',
    'de 2019 à 2024',
    // prices and amounts
    '1 234 567 €',
    'Total : 1234,56 €',
    '€1,299.99',
    '$ 4155552671',
    '250 EUR',
    '1.500 euros',
    'USD 3000',
    '12 345 678 dollars',
    '120 k€',
    '150 %',
  ])('keeps %j', (text) => {
    expect(sequences(text)).toEqual([]);
  });

  it('only keeps a sequence when the whole of it is covered by an exception', () => {
    expect(sequences('2024123 ans')).toEqual(['2024123']);
    expect(sequences('99.05.2024')).toEqual(['99.05.2024']);
    expect(sequences('2150')).toEqual(['2150']);
  });
});

describe('detectSensitiveNumbers', () => {
  function kinds(text: string) {
    return detectSensitiveNumbers(text, ['FR']).map(({ start, end, kind }) => [text.slice(start, end), kind]);
  }

  it('reports phones and generic sequences separately, without overlap', () => {
    expect(kinds('Tel 06 12 34 56 78, code 4821, +44 7911 123456, 12 chats')).toEqual([
      ['06 12 34 56 78', 'phone'],
      ['4821', 'digits'],
      ['+44 7911 123456', 'phone'],
    ]);
  });

  it('masks an invalid phone-like number as a generic sequence', () => {
    expect(kinds('mon num 05 99 99')).toEqual([['05 99 99', 'digits']]);
  });

  it('keeps dates, times, ages and prices around masked numbers', () => {
    expect(kinds('Le 12/05/2024 à 14:30, 25 ans, 49,99 €, appelle 0798765432')).toEqual([['0798765432', 'phone']]);
  });
});

describe('detectSensitiveNumbers — no partially masked digit runs', () => {
  function masked(text: string, countries: Parameters<typeof detectSensitiveNumbers>[1] = ['FR']) {
    return detectSensitiveNumbers(text, countries).map(({ start, end }) => text.slice(start, end));
  }

  it.each([
    ['33000000000', ['33000000000']],
    ['mon num 33000000000 merci', ['33000000000']],
    ['+33000000000', ['+33000000000']],
    ['tel 0061.7474 8002 merci', ['0061.7474 8002']],
    ['19 33-1258.', ['19 33-1258']],
    ['26781 3381.9 merci', ['26781 3381.9']],
  ])('masks the whole of %j', (text, expected) => {
    expect(masked(text)).toEqual(expected);
  });

  it('never leaves part of a masked digit run visible (seeded fuzz)', () => {
    const separators = ['', ' ', '-', '.', '\u00a0', ' (', ') '];
    let seed = 42;
    const random = (n: number) => (seed = (seed * 16807) % 2147483647) % n;
    for (let i = 0; i < 3000; i++) {
      let number = ['', '+', '00', '(+'][random(4)] + String(1 + random(99));
      for (let g = 2 + random(5); g > 0; g--) number += separators[random(separators.length)] + String(random(10 ** (1 + random(4))));
      const text = ['', 'tel ', 'Mon num : '][random(3)] + number + ['', ' merci', '.', ', 12 chats'][random(4)];
      const matches = detectSensitiveNumbers(text, [['FR', 'US'], ['FR'], ['GB', 'DE', 'US']][random(3)] as never);
      for (const run of digitRuns(text)) {
        const touching = matches.filter((m) => m.start < run.end && run.start < m.end);
        if (touching.length === 0) continue;
        expect({ text, start: touching[0].start <= run.start, end: touching.at(-1)!.end >= run.end })
          .toEqual({ text, start: true, end: true });
      }
    }
  });
});
