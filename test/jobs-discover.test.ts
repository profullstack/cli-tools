import { describe, expect, it } from 'vitest';

import { defaultFilters, setFilter, parseAssignment } from '../src/jobs-config.ts';
import {
  type Posting,
  discover,
  evaluate,
  formatPay,
  fromAshby,
  fromGreenhouse,
  fromLever,
  fromWorkable,
  parseCompanies,
  parsePayText,
  placeAllowed,
  slugsFor,
  workplaceOf,
} from '../src/jobs-discover.ts';

const posting = (over: Partial<Posting> = {}): Posting => ({
  ats: 'greenhouse',
  company: 'Acme',
  title: 'Senior Software Engineer',
  location: 'Remote',
  workplace: null,
  countries: [],
  url: 'https://job-boards.greenhouse.io/acme/jobs/1',
  applyUrl: 'https://job-boards.greenhouse.io/embed/job_app?for=acme&token=1',
  description: '',
  pay: null,
  ...over,
});
const never = () => false;

describe('parseCompanies', () => {
  const md = [
    '| # | Company | Category | Funding |',
    '|---|---|---|---|',
    '| 1 | [Simplismart](https://simplismart.ai) | infra | $9M · [source](https://news.example/a) |',
    '| 2 | AIsa | agents | $5M · [source](https://news.example/b) |',
    '| 3 | [Simplismart](https://simplismart.ai) | dupe | — |',
    '',
    '## Other boards',
    '- [Trueup.io](https://www.trueup.io)',
  ].join('\n');

  it('reads the company cell, linked or not, and never a link from another column', () => {
    expect(parseCompanies(md)).toEqual([
      { name: 'Simplismart', url: 'https://simplismart.ai' },
      { name: 'AIsa', url: '' },
    ]);
  });

  it('reads bullets only from a page with no table', () => {
    expect(parseCompanies('- [Acme](https://acme.dev)\n* [Beta](https://beta.io)')).toEqual([
      { name: 'Acme', url: 'https://acme.dev' },
      { name: 'Beta', url: 'https://beta.io' },
    ]);
  });
});

describe('slugsFor', () => {
  it('guesses from the name and the domain', () => {
    const slugs = slugsFor({ name: 'Initech AI', url: 'https://www.initech.com' });
    expect(slugs).toContain('initechai');
    expect(slugs).toContain('initech-ai');
    expect(slugs).toContain('initech');
  });
});

describe('parsePayText', () => {
  it.each([
    ['The estimated annual salary is between $125,000 - $225,000, plus equity.', { min: 125_000, max: 225_000, currency: 'USD', interval: 'year' }],
    ['Range: $150K – $180K', { min: 150_000, max: 180_000, currency: 'USD', interval: 'year' }],
    ['$150-180k base', { min: 150_000, max: 180_000, currency: 'USD', interval: 'year' }],
    ['£70,000 to £90,000', { min: 70_000, max: 90_000, currency: 'GBP', interval: 'year' }],
    ['USD 140,000 - 160,000', { min: 140_000, max: 160_000, currency: 'USD', interval: 'year' }],
    ['$80 - $110 per hour', { min: 80, max: 110, currency: 'USD', interval: 'hour' }],
  ])('%s', (text, expected) => {
    expect(parsePayText(text)).toMatchObject({ ...expected, source: 'text' });
  });

  it('ignores money that is not pay', () => {
    expect(parsePayText('We raised $100M from great investors.')).toBeNull();
    expect(parsePayText('A $50 monthly wellness stipend.')).toBeNull();
    expect(parsePayText('No numbers here.')).toBeNull();
  });

  it('prefers a range over an earlier single figure', () => {
    expect(parsePayText('Signing bonus $20,000. Base $150,000 - $190,000.')).toMatchObject({ min: 150_000, max: 190_000 });
  });

  it('formats for the shortlist', () => {
    expect(formatPay({ min: 150_000, max: 180_000, currency: 'USD', interval: 'year', source: 'ats' })).toBe('$150K–$180K USD/yr');
    expect(formatPay(null)).toBe('');
  });
});

describe('board parsers', () => {
  it('Ashby: workplaceType (not isRemote), countries and structured compensation', () => {
    const [job] = fromAshby('Acme', {
      jobs: [{
        title: 'AI Engineer', location: 'Remote (US)', isRemote: true, workplaceType: 'Hybrid',
        jobUrl: 'https://jobs.ashbyhq.com/acme/11111111-2222-3333-4444-555555555555', descriptionPlain: 'agents',
        address: { postalAddress: { addressCountry: 'United States' } },
        secondaryLocations: [{ address: { postalAddress: { addressCountry: 'Canada' } } }],
        compensation: { summaryComponents: [{ compensationType: 'Salary', interval: '1 YEAR', currencyCode: 'USD', minValue: 150000, maxValue: 180000 }] },
      }],
    });
    expect(job!.workplace).toBe('hybrid');
    expect(job!.countries).toEqual(['United States', 'Canada']);
    expect(job!.applyUrl).toMatch(/\/application$/);
    expect(job!.pay).toMatchObject({ min: 150_000, max: 180_000, currency: 'USD', source: 'ats' });
  });

  it('Greenhouse: the embed apply URL, and pay ranges in cents before description text', () => {
    const [job] = fromGreenhouse('Acme', 'acme', {
      jobs: [{ id: 42, title: 'Engineer', location: { name: 'Remote' }, absolute_url: 'https://job-boards.greenhouse.io/acme/jobs/42',
        content: '&lt;p&gt;Salary $1 - $2&lt;/p&gt;', pay_input_ranges: [{ min_cents: 13920000, max_cents: 23520000, currency_type: 'USD' }] }],
    });
    expect(job!.applyUrl).toBe('https://job-boards.greenhouse.io/embed/job_app?for=acme&token=42');
    expect(job!.pay).toMatchObject({ min: 139_200, max: 235_200, source: 'ats' });
    expect(job!.workplace).toBeNull();
  });

  it('Greenhouse: falls back to pay stated in the description', () => {
    const [job] = fromGreenhouse('Acme', 'acme', {
      jobs: [{ id: 1, title: 'Engineer', location: { name: 'Remote' }, absolute_url: 'u',
        content: '&lt;p&gt;The base range is $140,000 - $170,000.&lt;/p&gt;', pay_input_ranges: [] }],
    });
    expect(job!.pay).toMatchObject({ min: 140_000, max: 170_000, source: 'text' });
  });

  it('Lever: salaryRange, workplaceType and country', () => {
    const [job] = fromLever('Acme', [{
      text: 'Engineer', hostedUrl: 'h', applyUrl: 'a', workplaceType: 'on-site', country: 'GB',
      categories: { location: 'London' }, salaryRange: { min: 60000, max: 80000, currency: 'GBP', interval: 'per-year-salary' },
    }]);
    expect(job!.workplace).toBe('onsite');
    expect(job!.countries).toEqual(['GB']);
    expect(job!.pay).toMatchObject({ min: 60_000, max: 80_000, currency: 'GBP' });
  });

  it('Workable: telecommuting is remote; anything else is left to the text', () => {
    const [remote, office] = fromWorkable('Acme', { jobs: [
      { title: 'Engineer', telecommuting: true, country: 'United States', url: 'u' },
      { title: 'Engineer', telecommuting: false, country: 'France', city: 'Paris', url: 'v' },
    ] });
    expect(remote!.workplace).toBe('remote');
    expect(office!.workplace).toBeNull();
    expect(office!.pay).toBeNull();
  });
});

describe('places and workplace', () => {
  // The original filter: drop a location naming a non-US place unless it also names the US.
  it.each([
    ['Remote', true],
    ['Remote (US)', true],
    ['San Francisco, CA', true],
    ['Remote - US or Canada', true],
    ['Remote, Americas', true],
    ['London', false],
    ['Bengaluru, India', false],
    ['Remote - EMEA', false],
    ['Toronto', false],
  ])('US-only: %s → %s', (location, expected) => {
    expect(placeAllowed({ location, countries: [] }, ['US'])).toBe(expected);
  });

  it('counts structured countries as well as the text', () => {
    expect(placeAllowed({ location: 'London', countries: ['United Kingdom', 'United States'] }, ['US'])).toBe(true);
    expect(placeAllowed({ location: 'Remote', countries: ['FR'] }, ['US'])).toBe(false);
    expect(placeAllowed({ location: 'London', countries: [] }, [])).toBe(true);
    expect(placeAllowed({ location: 'Remote - EMEA', countries: [] }, ['EMEA'])).toBe(true);
  });

  it('trusts a structured workplace over the text, and reads the text otherwise', () => {
    expect(workplaceOf({ workplace: 'hybrid', location: 'Remote', title: 'x' })).toBe('hybrid');
    expect(workplaceOf({ workplace: null, location: 'Anywhere', title: 'x' })).toBe('remote');
    expect(workplaceOf({ workplace: null, location: 'NYC', title: 'Engineer (Remote)' })).toBe('remote');
    expect(workplaceOf({ workplace: null, location: 'NYC (Hybrid)', title: 'x' })).toBe('hybrid');
    expect(workplaceOf({ workplace: null, location: 'NYC', title: 'x' })).toBe('onsite');
  });
});

describe('evaluate', () => {
  const filters = defaultFilters();

  it('drops non-engineering and excluded titles', () => {
    expect(evaluate(posting({ title: 'Account Executive' }), filters, never)).toEqual({ keep: false, reason: 'title' });
    expect(evaluate(posting({ title: 'Engineering Manager' }), filters, never)).toEqual({ keep: false, reason: 'title' });
    expect(evaluate(posting({ title: 'iOS Engineer' }), filters, never)).toEqual({ keep: false, reason: 'title' });
    expect(evaluate(posting({ title: 'Member of Technical Staff' }), filters, never).keep).toBe(true);
  });

  it('drops onsite, foreign and already-applied postings', () => {
    expect(evaluate(posting({ location: 'New York, NY' }), filters, never)).toEqual({ keep: false, reason: 'workplace' });
    expect(evaluate(posting({ location: 'Remote - Berlin' }), filters, never)).toEqual({ keep: false, reason: 'country' });
    const seen = (url: string) => url.includes('token=1');
    expect(evaluate(posting(), filters, seen)).toEqual({ keep: false, reason: 'applied' });
  });

  it('scores exactly as the original did', () => {
    const verdict = evaluate(posting({
      title: 'Founding AI Agent Engineer',
      description: 'We use Claude Code and Cursor daily; TypeScript and React; agentic coding is how we work.',
    }), filters, never);
    if (!verdict.keep) throw new Error('dropped');
    // ai-tools 4 + ai-coding-culture 5 + agents 3 + js-stack 2 + role 2 + title-ai 3
    expect(verdict.candidate.score).toBe(19);
    expect(verdict.candidate.why).toBe('ai-tools,ai-coding-culture,agents,js-stack,role,title-ai');
  });

  it('flags blockers, and excludes the ones asked for', () => {
    const risky = posting({ description: 'Requires an active security clearance. Primary language Go.' });
    const kept = evaluate(risky, filters, never);
    expect(kept.keep && kept.candidate.flags).toEqual(['CLEARANCE', 'NON-JS', 'pay:unknown']);
    const strict = setFilter(filters, parseAssignment('exclude=CLEARANCE'));
    expect(evaluate(risky, strict, never)).toEqual({ keep: false, reason: 'flag' });
  });

  it('passes unstated pay by default, flagged, and drops it when pay is required', () => {
    const kept = evaluate(posting(), filters, never);
    expect(kept.keep && kept.candidate.flags).toContain('pay:unknown');
    const required = setFilter(filters, parseAssignment('pay.require=true'));
    expect(evaluate(posting(), required, never)).toEqual({ keep: false, reason: 'pay' });
  });

  it('compares the top of the range with the minimum, annualising hourly pay', () => {
    const min = setFilter(filters, parseAssignment('pay.min=200k'));
    const pay = (low: number, high: number, interval: 'year' | 'hour' = 'year') =>
      posting({ pay: { min: low, max: high, currency: 'USD', interval, source: 'ats' } });
    expect(evaluate(pay(150_000, 180_000), min, never)).toEqual({ keep: false, reason: 'pay' });
    expect(evaluate(pay(150_000, 210_000), min, never).keep).toBe(true);
    expect(evaluate(pay(90, 110, 'hour'), min, never).keep).toBe(true);
    const kept = evaluate(pay(150_000, 210_000), min, never);
    expect(kept.keep && kept.candidate.comp).toBe('$150K–$210K USD/yr');
  });

  it('does not compare pay across currencies, and says so', () => {
    const min = setFilter(filters, parseAssignment('pay.min=200k'));
    const verdict = evaluate(posting({ pay: { min: 100_000, max: 120_000, currency: 'CAD', interval: 'year', source: 'ats' } }), min, never);
    expect(verdict.keep && verdict.candidate.flags).toContain('pay:CAD');
  });
});

describe('discover', () => {
  it('reads the list, probes the boards, and cuts to the floor and the limit', async () => {
    const list = '| # | Company |\n|---|---|\n| 1 | [Acme](https://acme.dev) |\n| 2 | [Quiet](https://quiet.dev) |';
    const fetchJson = async (url: string) => {
      if (url === 'https://api.ashbyhq.com/posting-api/job-board/acme?includeCompensation=true') {
        return { jobs: [
          { title: 'AI Agent Engineer', location: 'Remote', workplaceType: 'Remote', jobUrl: 'https://jobs.ashbyhq.com/acme/1', descriptionPlain: 'Claude Code, TypeScript' },
          { title: 'Backend Engineer', location: 'Remote', workplaceType: 'Remote', jobUrl: 'https://jobs.ashbyhq.com/acme/2', descriptionPlain: 'Java' },
        ] };
      }
      return null;
    };
    const result = await discover(defaultFilters(), never, { fetchJson, fetchText: async () => list });
    expect(result.companies).toBe(2);
    expect(result.withBoards).toBe(1);
    expect(result.matched).toBe(2);
    expect(result.shortlist.map((candidate) => candidate.title)).toEqual(['AI Agent Engineer']);
  });
});
