import { describe, expect, it } from 'vitest';

import {
  type Extracted,
  type Field,
  type Plan,
  addressNumbers,
  businessSecrets,
  decide,
  eligibleYear,
  formatAmount,
  generatePassword,
  generateUsername,
  handoffCard,
  latestIdentity,
  maskSsn,
  outcomeOf,
  parseExtracted,
  personalSecrets,
  rulesFor,
  toEnvFile,
  vaultKeys,
} from '../src/ftb.ts';

const NOW = new Date('2026-10-04T12:00:00Z');

const ROWS: Extracted[] = [
  { kind: 'business', form: '100S', year: 2023, file: 'a.pdf', page: 26, netIncomeForState: -12345, netIncomeForTax: -12345, corpId: '1234567' },
  { kind: 'business', form: '100S', year: 2024, file: 'b.pdf', page: 38, netIncomeForState: 2468, netIncomeForTax: 0, corpId: '1234567' },
  { kind: 'business', form: '100S', year: 2019, file: 'old.pdf', page: 2, netIncomeForState: 5, netIncomeForTax: 5, corpId: '1234567' },
  { kind: 'personal', form: '540', year: 2024, file: 'p24.pdf', page: 45, caAgi: 98765 },
  { kind: 'personal', form: '540', year: 2025, file: 'p25.pdf', page: 40, caAgi: 87654 },
  { kind: 'identity', year: 2024, file: 'p24.pdf', page: 44, ssn: '123-45-6789', firstName: 'JANE', lastName: 'DOE', street: '1234 MAPLE ST', zip: '94000', filingStatus: 'single' },
  { kind: 'identity', year: 2025, file: 'p25.pdf', page: 39, ssn: '123-45-6789', firstName: 'JANE', lastName: 'DOE', street: '1234 MAPLE ST', zip: '94000', filingStatus: 'single' },
];

function plan(overrides: Partial<Plan> = {}): Plan {
  return {
    role: 'business', firstName: 'JANE', lastName: 'DOE', username: 'jdoeb1234', password: 'Pw!x'.repeat(6), email: 'a@example.com',
    addressNumbers: '1234', zip: '94000', year: 2023, amount: -12345, corpId: '1234567', security: {}, declare: false, ...overrides,
  };
}

function field(overrides: Partial<Field>): Field {
  return { selector: '#x', id: '', name: '', type: 'text', label: '', required: true, ...overrides };
}

describe('secrets from the returns', () => {
  it('keeps only the last five closed years', () => {
    expect(eligibleYear(2025, NOW)).toBe(true);
    expect(eligibleYear(2021, NOW)).toBe(true);
    expect(eligibleYear(2020, NOW)).toBe(false);
    expect(eligibleYear(2026, NOW)).toBe(false);
  });

  it('orders business secrets newest first, line 20 before 15, without duplicates', () => {
    expect(businessSecrets(ROWS, NOW).map((s) => [s.year, s.line, s.amount])).toEqual([
      [2024, 20, 0],
      [2024, 15, 2468],
      [2023, 20, -12345],
      [2023, 15, -12345],
    ]);
  });

  it('pairs each 540 with the filing status from the same return', () => {
    expect(personalSecrets(ROWS, NOW).map((s) => [s.year, s.amount, s.filingStatus])).toEqual([
      [2025, 87654, 'single'],
      [2024, 98765, 'single'],
    ]);
  });

  it('takes the newest complete identity', () => {
    expect(latestIdentity(ROWS)?.year).toBe(2025);
  });

  it('drops records ftb-extract.py would never print', () => {
    expect(parseExtracted('[{"kind":"business","year":2024},{"kind":"nope","year":1},{"year":2}]')).toHaveLength(1);
    expect(() => parseExtracted('not json')).toThrow(/not JSON/);
  });
});

describe('formats FTB insists on', () => {
  it('keeps only the numbers of the street address', () => {
    expect(addressNumbers('1234 MAPLE ST')).toBe('1234');
  });

  it('writes whole dollars with a dash for a loss and no comma', () => {
    expect(formatAmount(-12345)).toBe('-12345');
    expect(formatAmount(2468.4)).toBe('2468');
  });

  it('masks all but the last four of an SSN', () => {
    expect(maskSsn('123-45-6789')).toBe('***-**-6789');
  });
});

describe('credentials', () => {
  it('makes a 24-character password with every class FTB requires', () => {
    for (let i = 0; i < 50; i += 1) {
      const password = generatePassword();
      expect(password).toHaveLength(24);
      expect(password).toMatch(/[a-z]/);
      expect(password).toMatch(/[A-Z]/);
      expect(password).toMatch(/\d/);
      expect(password).toMatch(/[!#$*@]/);
    }
  });

  it('makes a letters-and-digits user name of 4 to 17 characters, marked by role', () => {
    const business = generateUsername('business', 'J Doe-Hyphenated-Long');
    expect(business).toMatch(/^[a-z0-9]{4,17}$/);
    expect(business.startsWith('jdoehyphenb')).toBe(true);
    expect(generateUsername('personal', 'jdoe')).toMatch(/^jdoep[a-z0-9]{4}$/);
  });
});

describe('rules', () => {
  it('fills the Name page by id, re-entry boxes included', () => {
    const p = plan();
    const rules = rulesFor(p);
    expect(decide(rules, field({ id: 'ReUserName', label: 'Re-enter User Name' }))?.action).toEqual({ kind: 'text', value: 'jdoeb1234', secret: false });
    expect(decide(rules, field({ id: 'Password', type: 'password', label: 'Password' }))?.action).toMatchObject({ kind: 'text', secret: true });
    expect(decide(rules, field({ id: 'MInitial', required: false }))).toBeNull();
  });

  it('fills the business page from labels: address, company, account, year, form, amount', () => {
    const rules = rulesFor(plan());
    expect(decide(rules, field({ id: 'AddrNum', label: 'Numbers in Mailing Address' }))?.action).toMatchObject({ value: '1234' });
    expect(decide(rules, field({ id: 'Zip', label: 'US Zip Code' }))?.action).toMatchObject({ value: '94000' });
    const company = field({ type: 'select-one', label: 'Type of company', options: [{ value: '', text: '' }, { value: 'L', text: 'Limited Liability Company' }, { value: 'C', text: 'Corporation' }] });
    expect(decide(rules, company)?.action).toEqual({ kind: 'select', value: 'C' });
    expect(decide(rules, field({ label: 'Account number' }))?.action).toMatchObject({ value: '1234567' });
    const year = field({ type: 'select-one', label: 'Year of the tax return', options: [{ value: '2024', text: '2024' }, { value: '2023', text: '2023' }] });
    expect(decide(rules, year)?.action).toEqual({ kind: 'select', value: '2023' });
    const form = field({ type: 'select-one', label: 'Tax form type', options: [{ value: '100', text: '100' }, { value: '100S', text: '100S' }] });
    expect(decide(rules, form)?.action).toEqual({ kind: 'select', value: '100S' });
    expect(decide(rules, field({ label: 'Net Income (Loss) shown on that form' }))?.action).toMatchObject({ value: '-12345' });
  });

  it('fills the personal page: SSN whole or split, filing status, AGI', () => {
    const rules = rulesFor(plan({ role: 'personal', corpId: undefined, ssn: '123-45-6789', filingStatus: 'single', amount: 98765, year: 2024 }));
    expect(decide(rules, field({ id: 'SSN', label: 'Social Security Number' }))?.action).toMatchObject({ value: '123456789', secret: true });
    expect(decide(rules, field({ id: 'Ssn2', label: 'Social Security Number' }))?.action).toMatchObject({ value: '45' });
    const status = field({ type: 'select-one', label: 'Filing status', options: [{ value: '1', text: 'Single' }, { value: '2', text: 'Married/RDP filing jointly' }] });
    expect(decide(rules, status)?.action).toEqual({ kind: 'select', value: '1' });
    expect(decide(rules, field({ label: 'California adjusted gross income' }))?.action).toMatchObject({ value: '98765' });
  });

  it('picks three different security questions and answers each with its own', () => {
    const p = plan();
    const rules = rulesFor(p);
    const options = [{ value: '', text: 'Select' }, { value: 'a', text: 'Favorite color?' }, { value: 'b', text: 'First pet?' }, { value: 'c', text: 'Birth city?' }];
    const chosen = [1, 2, 3].map((n) => decide(rules, field({ id: `Question${n}`, type: 'select-one', label: `Question ${n}`, options }))?.action);
    expect(chosen).toEqual([{ kind: 'select', value: 'a' }, { kind: 'select', value: 'b' }, { kind: 'select', value: 'c' }]);
    const answer = decide(rules, field({ id: 'Answer2', label: 'Answer 2', question: 'First pet?' }))?.action;
    expect(answer).toEqual({ kind: 'text', value: p.security['First pet?'], secret: true });
  });

  it('answers a login-time question from the stored answers', () => {
    const rules = rulesFor(plan({ security: { 'First pet?': 'rex12345ab' } }));
    expect(decide(rules, field({ id: 'Answer', label: 'Answer', question: 'First pet?' }))?.action).toMatchObject({ value: 'rex12345ab' });
  });

  it('turns the perjury box into a declare action the run only takes with --declare', () => {
    const rules = rulesFor(plan());
    expect(decide(rules, field({ type: 'checkbox', label: 'Under penalty of perjury, I declare that the information is true' }))?.action).toEqual({ kind: 'declare' });
  });

  it('fills the PIN only when activating', () => {
    const pin = field({ label: 'Personal Identification Number (PIN)' });
    expect(decide(rulesFor(plan()), pin)).toBeNull();
    expect(decide(rulesFor(plan({ pin: '4821' })), pin)?.action).toMatchObject({ value: '4821' });
  });
});

describe('what a page says', () => {
  it('reads a rejection, a registration and an activation', () => {
    expect(outcomeOf('There is a problem. Check below. The information you entered does not match our records.')).toBe('rejected');
    expect(outcomeOf('Registration Confirmation. We will mail you a letter with your PIN.')).toBe('registered');
    expect(outcomeOf('Your account has been activated.')).toBe('activated');
    expect(outcomeOf('Business Representative Registration. Enter the numbers in your mailing address.')).toBe('continue');
  });
});

describe('storage and the hand-off card', () => {
  const account = { role: 'business' as const, username: 'u', password: 'p#$ "x', email: 'e@x.y', security: { 'Q?': 'a' }, secret: { year: 2024, form: '100S', amount: 0 }, registeredAt: NOW.toISOString() };

  it('quotes every .env value so # and $ survive', () => {
    expect(toEnvFile(vaultKeys(account))).toContain('FTB_BUSINESS_PASSWORD="p#$ \\"x"');
  });

  it('puts steps and a deadline on the card, and never a secret', () => {
    const card = handoffCard('business', NOW);
    const all = [card.title, ...card.steps, card.text].join('\n');
    expect(all).toContain('2026-10-25');
    expect(all).toContain('ftb activate business --pin');
    expect(all).not.toMatch(/p#\$|password|\d{3}-\d{2}-\d{4}/i);
  });
});
