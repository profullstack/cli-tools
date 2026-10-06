import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  cleanUsers,
  enrichContacts,
  mynaOptOuts,
  normalizeDomain,
  normalizeLinkedin,
  resendSuppressions,
  splitName,
  toCleanCsv,
  toContacts,
} from '../src/user-clean.ts';
import type { UserRow } from '../src/user-export.ts';

const row = (email: string, last_login = '2026-09-01T00:00:00Z', name = '', site = 'a.com'): UserRow => ({ site, name, email, last_login });

describe('splitName', () => {
  it('splits a person', () => expect(splitName('Ada Lovelace King')).toEqual({ first_name: 'Ada', last_name: 'Lovelace King' }));
  it('drops handles and addresses', () => {
    expect(splitName('cool_dev42')).toEqual({ first_name: '', last_name: '' });
    expect(splitName('a@b.com')).toEqual({ first_name: '', last_name: '' });
  });
  it('keeps a capitalised single name', () => expect(splitName('Preshy')).toEqual({ first_name: 'Preshy', last_name: '' }));
});

describe('cleanUsers', () => {
  it('drops in order and keeps one row per address', async () => {
    const result = await cleanUsers(
      [
        row('Keep@Gmail.com', '', 'Ada Lovelace', 'a.com'),
        row('keep@gmail.com', '2026-09-02T00:00:00Z', '', 'b.com'),
        row('gone@gmail.com'),
        row('bounced@gmail.com'),
        row('never@gmail.com', ''),
        row('claude-diag-1@profullstack.com'),
        row('info@gmail.com'),
      ],
      {
        optedOut: new Set(['gone@gmail.com']),
        suppressed: new Map([['bounced@gmail.com', 'bounced']]),
        exclude: [/^claude-diag-/i],
        cleaner: { dns: false },
      },
    );
    expect(result.kept).toEqual([
      { email: 'keep@gmail.com', first_name: 'Ada', last_name: 'Lovelace', company_domain: '', job_title: '', linkedin_url: '' },
    ]);
    expect(Object.fromEntries(result.dropped.map((d) => [d.email, d.reason]))).toEqual({
      'gone@gmail.com': 'unsubscribed',
      'bounced@gmail.com': 'resend-bounced',
      'never@gmail.com': 'never-logged-in',
      'claude-diag-1@profullstack.com': 'excluded',
      'info@gmail.com': 'role',
    });
    expect(result.unique).toBe(6);
  });

  it('can keep the never-logged-in', async () => {
    const result = await cleanUsers([row('never@gmail.com', '')], { keepNeverLoggedIn: true, cleaner: { dns: false } });
    expect(result.kept.map((k) => k.email)).toEqual(['never@gmail.com']);
  });

  it('writes the three-column CSV', () => {
    expect(toCleanCsv([{ email: 'a@b.com', first_name: 'A, Jr', last_name: '' }])).toBe('email,first_name,last_name\na@b.com,"A, Jr",\n');
  });
});

describe('--full', () => {
  it('normalizes domains, dropping webmail', () => {
    expect(normalizeDomain('https://www.Acme.com/about')).toBe('acme.com');
    expect(normalizeDomain('gmail.com')).toBe('');
    expect(normalizeDomain('substack.com')).toBe('');
    expect(normalizeDomain('not a domain')).toBe('');
  });

  it('normalizes LinkedIn profiles and rejects other URLs', () => {
    expect(normalizeLinkedin('linkedin.com/in/ada-l/')).toBe('https://www.linkedin.com/in/ada-l');
    expect(normalizeLinkedin('https://uk.linkedin.com/in/ada?trk=x')).toBe('https://www.linkedin.com/in/ada');
    expect(normalizeLinkedin('ada-lovelace')).toBe('https://www.linkedin.com/in/ada-lovelace');
    expect(normalizeLinkedin('https://twitter.com/ada')).toBe('');
  });

  it('builds one contact per address from every site', () => {
    const contacts = toContacts([
      row('ada@acme.com', '', 'Ada Lovelace', 'a.com'),
      { ...row('ADA@acme.com', '', '', 'b.com'), job_title: 'CTO', linkedin_url: 'linkedin.com/in/ada' },
      row('bob@gmail.com', '', 'Bob', 'a.com'),
    ]);
    expect(contacts).toEqual([
      { email: 'ada@acme.com', first_name: 'Ada', last_name: 'Lovelace', company_domain: 'acme.com', job_title: 'CTO', linkedin_url: 'https://www.linkedin.com/in/ada' },
      { email: 'bob@gmail.com', first_name: 'Bob', last_name: '', company_domain: '', job_title: '', linkedin_url: '' },
    ]);
  });

  it('enriches only blank fields, matched by email', () => {
    const contacts = toContacts([row('ada@acme.com', '', 'Ada Lovelace'), { ...row('bob@gmail.com'), job_title: 'Founder' }, row('eve@x.io')]);
    const result = enrichContacts(contacts, [
      { ...row('Ada@Acme.com'), first_name: 'Augusta', last_name: 'King', job_title: 'CTO', company_domain: 'https://acme.co' },
      { ...row('bob@gmail.com'), job_title: 'Janitor', company_domain: 'bobco.com', linkedin_url: 'linkedin.com/in/bob' },
    ]);
    expect(result.contacts[0]).toEqual({ email: 'ada@acme.com', first_name: 'Ada', last_name: 'Lovelace', company_domain: 'acme.co', job_title: 'CTO', linkedin_url: '' });
    expect(result.contacts[1]).toEqual({ email: 'bob@gmail.com', first_name: '', last_name: '', company_domain: 'bobco.com', job_title: 'Founder', linkedin_url: 'https://www.linkedin.com/in/bob' });
    expect(result.contacts[2]!.company_domain).toBe('x.io');
    expect(result.matched).toBe(2);
    expect(result.filled).toEqual({ company_domain: 2, job_title: 1, linkedin_url: 1 });
  });

  it('writes the six-column CSV', () => {
    const [contact] = toContacts([{ ...row('ada@acme.com', '', 'Ada Lovelace'), job_title: 'CTO, Eng' }]);
    expect(toCleanCsv([contact!], { full: true })).toBe(
      'email,first_name,last_name,company_domain,job_title,linkedin_url\nada@acme.com,Ada,Lovelace,acme.com,"CTO, Eng",\n',
    );
  });
});

describe('mynaOptOuts', () => {
  it('reads optedOut contacts and tolerates a missing file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'user-clean-'));
    const path = join(dir, 'contacts.json');
    writeFileSync(path, JSON.stringify({ contacts: { a: { email: 'A@x.com', optedOut: '2026-09-24' }, b: { email: 'b@x.com' } } }));
    expect([...mynaOptOuts(path)]).toEqual(['a@x.com']);
    expect(mynaOptOuts(join(dir, 'nope.json')).size).toBe(0);
  });
});

describe('resendSuppressions', () => {
  it('pages until the cutoff and keeps only bad events', async () => {
    const pages: Record<string, unknown> = {
      '': { has_more: true, data: [
        { id: '1', to: ['Ok@x.com'], created_at: '2026-10-05 10:00:00', last_event: 'delivered' },
        { id: '2', to: ['b@x.com'], created_at: '2026-10-04 10:00:00', last_event: 'bounced' },
      ] },
      '2': { has_more: true, data: [
        { id: '3', to: ['s@x.com'], created_at: '2026-09-20 10:00:00', last_event: 'suppressed' },
        { id: '4', to: ['old@x.com'], created_at: '2026-08-01 10:00:00', last_event: 'bounced' },
      ] },
    };
    const seen: string[] = [];
    const fetchImpl = async (url: string) => {
      const after = new URL(url).searchParams.get('after') ?? '';
      seen.push(after);
      return { ok: true, status: 200, json: async () => pages[after] };
    };
    const map = await resendSuppressions('k', { days: 31, fetchImpl, now: Date.parse('2026-10-06T00:00:00Z'), pauseMs: 0 });
    expect(Object.fromEntries(map)).toEqual({ 'b@x.com': 'bounced', 's@x.com': 'suppressed' });
    expect(seen).toEqual(['', '2']);
  });
});
