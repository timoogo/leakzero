import { describe, expect, it } from 'vitest';
import { countriesFromLanguages, detectPhoneNumbers } from '../src/detectors/phone';

function found(text: string, countries: Parameters<typeof detectPhoneNumbers>[1] = []) {
  return detectPhoneNumbers(text, countries).map(({ start, end }) => text.slice(start, end));
}

describe('detectPhoneNumbers — international formats', () => {
  it.each([
    '+33 6 12 34 56 78',
    '+33612345678',
    '+1 (415) 555-2671',
    '+44 20 7946 0958',
    '+49 1512 3456789',
    '+81 3-1234-5678',
    '+91 98765 43210',
    '+55 11 91234-5678',
    '+212 6 12 34 56 78',
    '0033 6 12 34 56 78',
    '0044 20 7946 0958',
    '33 6 12 34 56 78',
    '33612345678',
    '447911123456',
    '1 415 555 2671',
  ])('detects %s without a default country', (number) => {
    expect(found(`appelle-moi au ${number} ce soir`)).toEqual([number]);
  });
});

describe('detectPhoneNumbers — national formats', () => {
  it.each([
    ['06 12 34 56 78', 'FR'],
    ['0612345678', 'FR'],
    ['06.12.34.56.78', 'FR'],
    ['(415) 555-2671', 'US'],
    ['415-555-2671', 'US'],
    ['020 7946 0958', 'GB'],
  ] as const)('detects %s for %s', (number, country) => {
    expect(found(`tel: ${number}`, [country])).toEqual([number]);
  });

  it('ignores national numbers when no matching country is configured', () => {
    expect(found('020 7946 0958')).toEqual([]);
  });

  it('finds several numbers in one text', () => {
    expect(found('tel 01 23 45 67 89 ou +44 7911 123456', ['FR'])).toEqual(['01 23 45 67 89', '+44 7911 123456']);
  });
});

describe('detectPhoneNumbers — French mobiles (06/07) without configured country', () => {
  it.each([
    '0612345678',
    '0798765432',
    '06 12 34 56 78',
    '07-98-76-54-32',
    '06.12.34.56.78',
    '06\u00a012\u00a034\u00a056\u00a078',
    '06\u202f12\u202f34\u202f56\u202f78',
    '0612 34 56 78',
  ])('detects %s', (number) => {
    expect(found(`mon num ${number} !`)).toEqual([number]);
  });

  it('does not take a longer digit run for a French mobile', () => {
    expect(found('061234567890')).toEqual([]);
  });
});

describe('detectPhoneNumbers — false positives', () => {
  it.each([
    "J'ai 25 ans",
    'le 12/05/2024',
    'né le 12.05.1990',
    '2024-05-12',
    'il est 12:30:45',
    '1 234 567 €',
    'Total : 1234,56 €',
    '$ 4155552671',
    '12 345 678 vues',
    '123456789',
    'score 1000000',
    'commande n°12345678',
    'version 1.2.3.4',
    'IP 192.168.1.1',
    '2019-2024',
    '45 %',
  ])('does not flag %s', (text) => {
    expect(found(text, ['FR', 'US'])).toEqual([]);
  });
});

describe('countriesFromLanguages', () => {
  it('extracts supported regions', () => {
    expect(countriesFromLanguages(['fr-FR', 'fr', 'en-US', 'en', 'xx-ZZ'])).toEqual(['FR', 'US']);
  });
});

describe('detectPhoneNumbers — international numbers, valid or fictitious', () => {
  it.each([
    '+33000000000',
    '+33612345678',
    '+447911123456',
    '+12025550123',
    '+1 (202) 555-0123',
    '+1.202.555.0123',
    '+44 (0) 7911 123456',
    '+33-0-00-00-00-00',
    '+999 1234 5678',
    '+(33) 6 12 34 56 78',
    '0033000000000',
    '00999 1234 5678',
  ])('detects %s', (number) => {
    expect(found(`num: ${number} !`)).toEqual([number]);
  });

  it('requires enough digits after "+" or "00"', () => {
    expect(found('+33 6 12')).toEqual([]);
    expect(found('score +1234')).toEqual([]);
  });
});

describe('detectPhoneNumbers — extensions', () => {
  it('excludes the extension from the phone match', () => {
    expect(found('+44 7911 123456, 12 chats', ['FR'])).toEqual(['+44 7911 123456']);
    expect(found('+1 415-555-2671 ext. 1234', ['US'])).toEqual(['+1 415-555-2671']);
  });
});
