import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  OutOfCredits,
  companyToken,
  loadCache,
  lookupLinkedin,
  pickCompany,
  pickPerson,
  personQuery,
  saveCache,
  valueSerp,
  type SerpResult,
} from '../src/linkedin-lookup.ts';
import type { ContactRow } from '../src/user-clean.ts';

const contact = (over: Partial<ContactRow>): ContactRow => ({
  email: 'x@y.z', first_name: '', last_name: '', company_domain: '', job_title: '', linkedin_url: '', ...over,
});

const ada = contact({ email: 'ada@acme.com', first_name: 'Ada', last_name: 'Lovelace', company_domain: 'acme.com' });

describe('matching', () => {
  it('names the company by its first label', () => {
    expect(companyToken('acme.com')).toBe('acme');
    expect(companyToken('shop.acme.co.uk')).toBe('acme');
    expect(companyToken('ai.nookplot.com')).toBe('nookplot');
  });

  it('searches profiles by quoted name and company', () => {
    expect(personQuery(ada)).toBe('site:linkedin.com/in "Ada Lovelace" acme');
  });

  it('takes a profile that carries the name and the company', () => {
    const results: SerpResult[] = [
      { title: 'Ada Lovelace - Engineer - Initech | LinkedIn', link: 'https://www.linkedin.com/in/ada-other', snippet: 'Initech' },
      { title: 'Adá LOVELACE - CTO - Acme | LinkedIn', link: 'https://uk.linkedin.com/in/ada-l?trk=x', snippet: '' },
    ];
    expect(pickPerson(results, ada)).toBe('https://www.linkedin.com/in/ada-l');
  });

  it('without a company, takes only a single matching profile', () => {
    const bob = contact({ first_name: 'Bob', last_name: 'Ng' });
    const one = [{ title: 'Bob Ng | LinkedIn', link: 'https://www.linkedin.com/in/bob-ng' }, { title: 'Posts', link: 'https://www.linkedin.com/posts/x' }];
    expect(pickPerson(one, bob)).toBe('https://www.linkedin.com/in/bob-ng');
    expect(pickPerson([...one, { title: 'Bob Ng - Chef', link: 'https://www.linkedin.com/in/bob-ng-2' }], bob)).toBe('');
    // the title alone is not enough without a company: the slug must be the name too
    expect(pickPerson([{ title: 'Bob Ng | LinkedIn', link: 'https://www.linkedin.com/in/b8812' }], bob)).toBe('');
  });

  it('rejects other people and non-profile pages', () => {
    expect(pickPerson([{ title: 'Ada Byron - Acme', link: 'https://www.linkedin.com/in/ab' }], ada)).toBe('');
    expect(pickPerson([{ title: 'Ada Lovelace - Acme', link: 'https://www.linkedin.com/company/acme' }], ada)).toBe('');
  });

  it('takes a company page that mentions the domain or the name', () => {
    expect(pickCompany([{ title: 'Acme Corp | LinkedIn', link: 'https://www.linkedin.com/company/acme-corp/' }], 'acme.com')).toBe(
      'https://www.linkedin.com/company/acme-corp',
    );
    expect(pickCompany([{ title: 'Other | LinkedIn', link: 'https://www.linkedin.com/company/other' }], 'acme.com')).toBe('');
    // a snippet that mentions the name is not the company
    expect(pickCompany([{ title: 'National City Adult School', link: 'https://www.linkedin.com/company/ncas', snippet: 'part of Sweetwater schools' }], 'sweetwaterschools.net')).toBe('');
    expect(pickCompany([{ title: 'Adult School', link: 'https://www.linkedin.com/company/ncas', snippet: 'sweetwaterschools.net' }], 'sweetwaterschools.net')).toBe('https://www.linkedin.com/company/ncas');
  });
});

describe('lookupLinkedin', () => {
  it('falls back to the company page, caches every answer, and searches each query once', async () => {
    const asked: string[] = [];
    const search = async (q: string): Promise<SerpResult[]> => {
      asked.push(q);
      return q.includes('/company') ? [{ title: 'Acme | LinkedIn', link: 'https://www.linkedin.com/company/acme' }] : [];
    };
    const cache = new Map<string, SerpResult[]>();
    const contacts = [ada, contact({ email: 'bo@acme.com', company_domain: 'acme.com' }), contact({ email: 'has@x.io', linkedin_url: 'https://www.linkedin.com/in/has' })];
    const r = await lookupLinkedin(contacts, search, { cache, concurrency: 1 });
    expect(r.contacts.map((c) => c.linkedin_url)).toEqual([
      'https://www.linkedin.com/company/acme',
      'https://www.linkedin.com/company/acme',
      'https://www.linkedin.com/in/has',
    ]);
    expect(r).toMatchObject({ people: 0, companies: 2, searches: 2, cached: 1 });
    expect(cache.get(personQuery(ada))).toEqual([]);

    const again = await lookupLinkedin(contacts, async () => { throw new Error('should not search'); }, { cache });
    expect(again).toMatchObject({ searches: 0, companies: 2 });
  });

  it('stops at the cap and on a 402, keeping what it found', async () => {
    const many = Array.from({ length: 5 }, (_, i) => contact({ email: `p${i}@x.io`, first_name: `Pat${i}`, last_name: 'Doe' }));
    const capped = await lookupLinkedin(many, async () => [], { maxSearches: 2, concurrency: 1 });
    expect(capped.searches).toBe(2);
    expect(capped.stopped).toMatch(/linkedin-max 2/);

    const broke = await lookupLinkedin(many, async () => { throw new OutOfCredits(); }, { concurrency: 1 });
    expect(broke.searches).toBe(1);
    expect(broke.stopped).toMatch(/402/);
    expect(broke.contacts).toHaveLength(5);
  });

  it('reports progress every N searches', async () => {
    const many = Array.from({ length: 5 }, (_, i) => contact({ email: `p${i}@x.io`, first_name: `Pat${i}`, last_name: 'Doe' }));
    const seen: number[] = [];
    await lookupLinkedin(many, async () => [], { concurrency: 1, every: 2, onProgress: (r) => seen.push(r.searches) });
    expect(seen).toEqual([2, 4]);
  });

  it('valueSerp gives every request a timeout signal', async () => {
    let signal: AbortSignal | undefined;
    const search = valueSerp('k', { timeoutMs: 5, fetchImpl: async (_u, init) => {
      signal = init?.signal;
      return { ok: true, status: 200, json: async () => ({}) };
    } });
    await search('q');
    expect(signal).toBeInstanceOf(AbortSignal);
  });

  it('valueSerp turns a 402 into OutOfCredits and retries a 429', async () => {
    const statuses = [429, 200];
    const ok = valueSerp('k', { pauseMs: 0, fetchImpl: async () => {
      const status = statuses.shift()!;
      return { ok: status === 200, status, json: async () => ({ organic_results: [{ title: 't' }] }) };
    } });
    expect(await ok('q')).toEqual([{ title: 't' }]);
    const broke = valueSerp('k', { fetchImpl: async () => ({ ok: false, status: 402, json: async () => ({}) }) });
    await expect(broke('q')).rejects.toBeInstanceOf(OutOfCredits);
  });

  it('round-trips the cache file', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'li-')), 'sub', 'c.json');
    saveCache(path, new Map([['q', [{ title: 't', link: 'l' }]], ['m', []]]));
    expect(loadCache(path)).toEqual(new Map([['q', [{ title: 't', link: 'l' }]], ['m', []]]));
    expect(loadCache(`${path}.missing`).size).toBe(0);
  });
});
