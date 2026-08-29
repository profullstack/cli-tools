import { describe, expect, it } from 'vitest';

import {
  MIN_TTL,
  PorkbunError,
  type Caller,
  type DnsRecord,
  type UrlForward,
  checkAvailability,
  createRecord,
  credentialsFrom,
  formatForwards,
  formatRecords,
  fqdn,
  hostLabel,
  isParkingRecord,
  listDomains,
  listRecords,
  matchRecords,
  normalizeDomain,
  planRegistration,
  planUnpark,
  porkbunCaller,
  priceCents,
  registerDomain,
  setRecord,
  sortRecords,
  tldOf,
  unwrap,
} from '../src/porkbun.ts';

function record(partial: Partial<DnsRecord> & { name: string; type: string; content: string }): DnsRecord {
  return { id: '1', ttl: '600', prio: null, ...partial };
}

/** A caller that records what it was asked and replays canned bodies. */
function scripted(responses: Record<string, Record<string, unknown>>): {
  call: Caller;
  seen: { path: string; body: Record<string, unknown> }[];
} {
  const seen: { path: string; body: Record<string, unknown> }[] = [];
  const call: Caller = async (path, body = {}) => {
    seen.push({ path, body });
    const response = responses[path];
    if (!response) throw new Error(`unscripted call: ${path}`);
    return response;
  };
  return { call, seen };
}

describe('unwrap', () => {
  it('returns the body on SUCCESS', () => {
    expect(unwrap({ status: 'SUCCESS', id: 7 }, '/x')).toEqual({ status: 'SUCCESS', id: 7 });
  });

  // The whole point: Porkbun says "no" with HTTP 200, so the body is the verdict.
  it('throws on a 200 that carries an ERROR status', () => {
    expect(() => unwrap({ status: 'ERROR', message: 'Invalid API key.' }, '/dns/retrieve/x')).toThrow(
      /Invalid API key/,
    );
  });

  it('names the endpoint in the error', () => {
    expect(() => unwrap({ status: 'ERROR', message: 'nope' }, '/dns/create/e.com')).toThrow(
      /\/dns\/create\/e\.com/,
    );
  });

  it('rejects a non-object body rather than reading fields off it', () => {
    expect(() => unwrap('<html>502</html>', '/ping')).toThrow(PorkbunError);
  });
});

describe('credentialsFrom', () => {
  it('takes both keys from the environment', () => {
    expect(credentialsFrom({ PORKBUN_API_KEY: 'k', PORKBUN_SECRET_API_KEY: 's' })).toEqual({
      apikey: 'k',
      secretapikey: 's',
    });
  });

  // Half-set is the common mistake, so the message has to name the missing half.
  it('names the secret when only the key is set', () => {
    expect(() => credentialsFrom({ PORKBUN_API_KEY: 'k' })).toThrow(/PORKBUN_SECRET_API_KEY/);
  });

  it('names both when neither is set', () => {
    expect(() => credentialsFrom({})).toThrow(/PORKBUN_API_KEY and PORKBUN_SECRET_API_KEY/);
  });
});

describe('hostLabel', () => {
  it('treats @, empty and the bare domain as the apex', () => {
    expect(hostLabel('example.com', '@')).toBe('');
    expect(hostLabel('example.com', '')).toBe('');
    expect(hostLabel('example.com', 'example.com')).toBe('');
  });

  it('accepts a bare label or the full name', () => {
    expect(hostLabel('example.com', 'www')).toBe('www');
    expect(hostLabel('example.com', 'www.example.com')).toBe('www');
  });

  it('keeps deeper labels intact', () => {
    expect(hostLabel('example.com', '_railway-verify.www.example.com')).toBe('_railway-verify.www');
    expect(hostLabel('example.com', '_railway-verify.www')).toBe('_railway-verify.www');
  });

  it('is case- and trailing-dot-insensitive', () => {
    expect(hostLabel('Example.com', 'WWW.Example.com.')).toBe('www');
  });

  // The bug this prevents: www.example.com.example.com
  it('does not double the zone when given a full name', () => {
    expect(fqdn('example.com', hostLabel('example.com', 'www.example.com'))).toBe('www.example.com');
  });
});

describe('isParkingRecord', () => {
  it('spots the apex ALIAS and the wildcard CNAME', () => {
    expect(isParkingRecord(record({ name: 'e.com', type: 'ALIAS', content: 'uixie.porkbun.com' }))).toBe(true);
    expect(isParkingRecord(record({ name: '*.e.com', type: 'CNAME', content: 'uixie.porkbun.com' }))).toBe(true);
  });

  // Deleting these would break mail or delegation, so they must never match.
  it('leaves MX email forwarding and NS delegation alone', () => {
    expect(isParkingRecord(record({ name: 'e.com', type: 'MX', content: 'fwd1.porkbun.com' }))).toBe(false);
    expect(isParkingRecord(record({ name: 'e.com', type: 'NS', content: 'salvador.porkbun.com' }))).toBe(false);
  });

  it('leaves a CNAME to somewhere else alone', () => {
    expect(isParkingRecord(record({ name: 'www.e.com', type: 'CNAME', content: 'app.up.railway.app' }))).toBe(
      false,
    );
  });

  it('is not fooled by a lookalike suffix', () => {
    expect(isParkingRecord(record({ name: 'e.com', type: 'CNAME', content: 'notporkbun.com' }))).toBe(false);
  });
});

describe('planUnpark', () => {
  const parked: DnsRecord[] = [
    record({ id: '1', name: 'e.com', type: 'ALIAS', content: 'uixie.porkbun.com' }),
    record({ id: '2', name: '*.e.com', type: 'CNAME', content: 'uixie.porkbun.com' }),
    record({ id: '3', name: 'e.com', type: 'MX', content: 'fwd1.porkbun.com' }),
  ];
  const forwards: UrlForward[] = [
    { id: '9', subdomain: '', location: 'http://e.l.ink', type: 'temporary', includePath: 'yes', wildcard: 'yes' },
  ];

  it('collects the forward and only the parking records', () => {
    const plan = planUnpark(parked, forwards);
    expect(plan.forwards).toHaveLength(1);
    expect(plan.records.map((r) => r.id)).toEqual(['1', '2']);
    expect(plan.empty).toBe(false);
  });

  it('is empty for a domain that is already in use', () => {
    const live = [record({ id: '1', name: 'www.e.com', type: 'CNAME', content: 'app.up.railway.app' })];
    expect(planUnpark(live, []).empty).toBe(true);
  });
});

describe('matchRecords', () => {
  const records = [
    record({ id: '1', name: 'e.com', type: 'ALIAS', content: 'a' }),
    record({ id: '2', name: 'www.e.com', type: 'CNAME', content: 'b' }),
    record({ id: '3', name: 'www.e.com', type: 'TXT', content: 'c' }),
  ];

  it('matches the apex by @', () => {
    expect(matchRecords(records, 'e.com', '@').map((r) => r.id)).toEqual(['1']);
  });

  it('matches a host across types, then narrows by type', () => {
    expect(matchRecords(records, 'e.com', 'www').map((r) => r.id)).toEqual(['2', '3']);
    expect(matchRecords(records, 'e.com', 'www', 'txt').map((r) => r.id)).toEqual(['3']);
  });
});

describe('formatting', () => {
  it('puts the apex first and renders names fully qualified', () => {
    const table = formatRecords(
      [
        record({ id: '2', name: 'www.e.com', type: 'CNAME', content: 'b' }),
        record({ id: '1', name: 'e.com', type: 'ALIAS', content: 'a' }),
      ],
      'e.com',
    );
    const [, first, second] = table.split('\n');
    expect(first).toMatch(/e\.com/);
    expect(first).toMatch(/ALIAS/);
    expect(second).toMatch(/www\.e\.com/);
  });

  it('truncates a long value instead of wrapping the table', () => {
    const table = formatRecords(
      [record({ name: 'e.com', type: 'TXT', content: 'x'.repeat(500) })],
      'e.com',
      20,
    );
    expect(table).toContain('…');
    expect(table.split('\n').every((line) => line.length < 120)).toBe(true);
  });

  it('says so when there is nothing', () => {
    expect(formatRecords([], 'e.com')).toBe('no records');
    expect(formatForwards([], 'e.com')).toBe('no URL forwarding');
  });

  it('flags a wildcard forward, which is the one that swallows everything', () => {
    const text = formatForwards(
      [{ id: '9', subdomain: '', location: 'http://x', type: 'temporary', includePath: 'yes', wildcard: 'yes' }],
      'e.com',
    );
    expect(text).toMatch(/wildcard/);
  });

  it('sorts stably by name then type', () => {
    const sorted = sortRecords(
      [
        record({ id: '3', name: 'b.e.com', type: 'A', content: 'x' }),
        record({ id: '2', name: 'a.e.com', type: 'TXT', content: 'x' }),
        record({ id: '1', name: 'a.e.com', type: 'A', content: 'x' }),
      ],
      'e.com',
    );
    expect(sorted.map((r) => r.id)).toEqual(['1', '2', '3']);
  });
});

describe('operations', () => {
  it('reads the record list', async () => {
    const { call } = scripted({
      '/dns/retrieve/e.com': { status: 'SUCCESS', records: [record({ name: 'e.com', type: 'A', content: '1.2.3.4' })] },
    });
    expect(await listRecords(call, 'e.com')).toHaveLength(1);
  });

  it('returns an empty list rather than throwing when the field is absent', async () => {
    const { call } = scripted({ '/dns/retrieve/e.com': { status: 'SUCCESS' } });
    expect(await listRecords(call, 'e.com')).toEqual([]);
  });

  it('sorts the domain list', async () => {
    const { call } = scripted({
      '/domain/listAll': { status: 'SUCCESS', domains: [{ domain: 'b.com' }, { domain: 'a.com' }] },
    });
    expect(await listDomains(call)).toEqual(['a.com', 'b.com']);
  });

  it('sends the apex as an empty name and floors the TTL', async () => {
    const { call, seen } = scripted({ '/dns/create/e.com': { status: 'SUCCESS', id: 42 } });
    await createRecord(call, 'e.com', { host: '@', type: 'alias', content: 'x.up.railway.app', ttl: 30 });

    expect(seen[0]?.body).toMatchObject({ name: '', type: 'ALIAS', ttl: String(MIN_TTL) });
  });
});

describe('setRecord', () => {
  const existing = record({ id: '5', name: 'www.e.com', type: 'CNAME', content: 'old.example', ttl: '600' });

  it('creates when nothing is there', async () => {
    const { call, seen } = scripted({
      '/dns/retrieve/e.com': { status: 'SUCCESS', records: [] },
      '/dns/create/e.com': { status: 'SUCCESS', id: 11 },
    });
    expect(await setRecord(call, 'e.com', { host: 'www', type: 'CNAME', content: 'new.example' })).toEqual({
      action: 'created',
      id: '11',
    });
    expect(seen.map((s) => s.path)).toContain('/dns/create/e.com');
  });

  // Editing in place keeps the id, and avoids the delete-then-create window
  // where the name does not resolve at all.
  it('edits in place when one already exists', async () => {
    const { call, seen } = scripted({
      '/dns/retrieve/e.com': { status: 'SUCCESS', records: [existing] },
      '/dns/edit/e.com/5': { status: 'SUCCESS' },
    });
    expect(await setRecord(call, 'e.com', { host: 'www', type: 'CNAME', content: 'new.example' })).toEqual({
      action: 'updated',
      id: '5',
    });
    expect(seen.map((s) => s.path)).not.toContain('/dns/create/e.com');
  });

  it('does nothing when the value already matches', async () => {
    const { call, seen } = scripted({
      '/dns/retrieve/e.com': { status: 'SUCCESS', records: [existing] },
    });
    expect(await setRecord(call, 'e.com', { host: 'www', type: 'CNAME', content: 'old.example' })).toEqual({
      action: 'unchanged',
      id: '5',
    });
    expect(seen).toHaveLength(1);
  });

  // Two TXT values on one name is legitimate; silently replacing one is not.
  it('refuses to guess which of several to replace', async () => {
    const { call } = scripted({
      '/dns/retrieve/e.com': {
        status: 'SUCCESS',
        records: [
          record({ id: '1', name: 'e.com', type: 'TXT', content: 'one' }),
          record({ id: '2', name: 'e.com', type: 'TXT', content: 'two' }),
        ],
      },
    });
    await expect(setRecord(call, 'e.com', { host: '@', type: 'TXT', content: 'three' })).rejects.toThrow(
      /Refusing to guess/,
    );
  });
});

describe('porkbunCaller', () => {
  it('posts credentials in the body, not a header', async () => {
    let captured: { url: string; init: RequestInit } | null = null;
    const fetcher = (async (url: string, init: RequestInit) => {
      captured = { url, init };
      return { status: 200, text: async () => JSON.stringify({ status: 'SUCCESS', yourIp: '1.1.1.1' }) };
    }) as unknown as typeof fetch;

    const call = porkbunCaller({ apikey: 'k', secretapikey: 's' }, 1000, fetcher);
    await call('/ping');

    expect(captured!.url).toBe('https://api.porkbun.com/api/json/v3/ping');
    expect(captured!.init.method).toBe('POST');
    expect(JSON.parse(String(captured!.init.body))).toMatchObject({ apikey: 'k', secretapikey: 's' });
  });

  it('reports a non-JSON body as the edge failing, not as bad JSON', async () => {
    const fetcher = (async () => ({ status: 502, text: async () => '<html>bad gateway</html>' })) as unknown as typeof fetch;
    const call = porkbunCaller({ apikey: 'k', secretapikey: 's' }, 1000, fetcher);
    await expect(call('/ping')).rejects.toThrow(/HTTP 502.*not JSON/s);
  });
});

describe('priceCents', () => {
  // The reason this function exists rather than `parseFloat(p) * 100`: that
  // expression is 1107.9999999999998 here, and a truncated 1107 buys nothing.
  it('converts a dollar string without going through a float', () => {
    expect(priceCents('11.08')).toBe(1108);
    expect(priceCents('0.99')).toBe(99);
    expect(priceCents('1234.56')).toBe(123_456);
  });

  it('handles whole dollars and a single decimal', () => {
    expect(priceCents('22')).toBe(2200);
    expect(priceCents('22.5')).toBe(2250);
    expect(priceCents(35)).toBe(3500);
  });

  it('rounds a third decimal like money', () => {
    expect(priceCents('1.005')).toBe(101);
    expect(priceCents('1.004')).toBe(100);
  });

  it('refuses anything that is not a price', () => {
    expect(() => priceCents('free')).toThrow(PorkbunError);
    expect(() => priceCents('-5.00')).toThrow(/unreadable price/);
    expect(() => priceCents('')).toThrow(/unreadable price/);
  });
});

describe('normalizeDomain and tldOf', () => {
  it('lowercases and drops a trailing dot', () => {
    expect(normalizeDomain(' DiskPush.COM. ')).toBe('diskpush.com');
  });

  it('rejects a bare label, a URL and a path', () => {
    expect(() => normalizeDomain('diskpush')).toThrow(/not a valid domain/);
    expect(() => normalizeDomain('https://diskpush.com')).toThrow(/not a valid domain/);
    expect(() => normalizeDomain('diskpush.com/a')).toThrow(/not a valid domain/);
  });

  // The requirements endpoint keys on the whole suffix, not the last label.
  it('takes everything after the first label as the TLD', () => {
    expect(tldOf('diskpush.com')).toBe('com');
    expect(tldOf('example.co.uk')).toBe('co.uk');
  });
});

describe('checkAvailability', () => {
  const body = (overrides: Record<string, unknown> = {}) => ({
    status: 'SUCCESS',
    response: {
      avail: 'yes',
      type: 'registration',
      price: '11.08',
      firstYearPromo: 'no',
      regularPrice: '11.08',
      premium: 'no',
      additional: { renewal: { type: 'renewal', price: '11.08' } },
      minDuration: 1,
      ...overrides,
    },
  });

  it('reads the quote out of the nested response', async () => {
    const { call, seen } = scripted({ '/domain/checkDomain/diskpush.com': body() });
    const availability = await checkAvailability(call, 'DiskPush.com');

    expect(availability).toMatchObject({
      domain: 'diskpush.com',
      available: true,
      premium: false,
      costCents: 1108,
      price: '$11.08',
      renewal: '$11.08',
    });
    expect(seen[0]?.path).toBe('/domain/checkDomain/diskpush.com');
  });

  it('reports a taken name rather than throwing', async () => {
    const { call } = scripted({
      '/domain/checkDomain/taken.com': body({ avail: 'no' }),
    });
    expect((await checkAvailability(call, 'taken.com')).available).toBe(false);
  });

  it('throws when there is no price to send back', async () => {
    const { call } = scripted({
      '/domain/checkDomain/x.com': { status: 'SUCCESS', response: { avail: 'yes' } },
    });
    await expect(checkAvailability(call, 'x.com')).rejects.toThrow(/no price/);
  });
});

describe('planRegistration', () => {
  const requirements = (overrides: Record<string, unknown> = {}) => ({
    status: 'SUCCESS',
    tld: 'com',
    apiRegisterable: true,
    registrationDurationYears: 1,
    whoisPrivacySupported: true,
    registryRequirements: null,
    ...overrides,
  });

  const available = (overrides: Record<string, unknown> = {}) => ({
    status: 'SUCCESS',
    response: {
      avail: 'yes',
      price: '11.08',
      premium: 'no',
      firstYearPromo: 'no',
      additional: { renewal: { price: '11.08' } },
      minDuration: 1,
      ...overrides,
    },
  });

  const scriptFor = (
    domain: string,
    reqs: Record<string, unknown> = requirements(),
    avail: Record<string, unknown> = available(),
  ) =>
    scripted({
      '/domain/getRegistrationRequirements/com': reqs,
      [`/domain/checkDomain/${domain}`]: avail,
    });

  it('carries the quote through as the cost to send', async () => {
    const { call } = scriptFor('diskpush.com');
    const plan = await planRegistration(call, 'diskpush.com');

    expect(plan).toEqual({
      domain: 'diskpush.com',
      costCents: 1108,
      price: '$11.08',
      renewal: '$11.08',
      premium: false,
      firstYearPromo: false,
      years: 1,
      whoisPrivacy: true,
    });
  });

  // One check per ten seconds, so a second one is an error and not an answer.
  it('checks availability exactly once', async () => {
    const { call, seen } = scriptFor('diskpush.com');
    await planRegistration(call, 'diskpush.com');
    expect(seen.filter((entry) => entry.path.startsWith('/domain/checkDomain'))).toHaveLength(1);
  });

  it('refuses a name that is already registered', async () => {
    const { call } = scriptFor('diskpush.com', requirements(), available({ avail: 'no' }));
    await expect(planRegistration(call, 'diskpush.com')).rejects.toThrow(/already registered/);
  });

  it('refuses a TLD the API cannot sell', async () => {
    const { call } = scriptFor('diskpush.com', requirements({ apiRegisterable: false }));
    await expect(planRegistration(call, 'diskpush.com')).rejects.toThrow(/cannot be registered/);
  });

  // .us nexus, .ca legal type: fields this command has no way to collect.
  it('refuses a TLD with registry eligibility fields', async () => {
    const { call } = scriptFor('diskpush.com', requirements({ registryRequirements: { nexus: {} } }));
    await expect(planRegistration(call, 'diskpush.com')).rejects.toThrow(/eligibility/);
  });

  it('refuses to silently publish contacts when privacy is unsupported', async () => {
    const { call } = scriptFor('diskpush.com', requirements({ whoisPrivacySupported: false }));
    await expect(planRegistration(call, 'diskpush.com')).rejects.toThrow(/--no-whois-privacy/);
  });

  it('allows public contacts when asked for explicitly', async () => {
    const { call } = scriptFor('diskpush.com', requirements({ whoisPrivacySupported: false }));
    const plan = await planRegistration(call, 'diskpush.com', { whoisPrivacy: false });
    expect(plan.whoisPrivacy).toBe(false);
  });

  it('stops a premium name from quietly costing hundreds', async () => {
    const { call } = scriptFor(
      'diskpush.com',
      requirements(),
      available({ price: '2999.00', premium: 'yes' }),
    );
    await expect(planRegistration(call, 'diskpush.com', { maxCents: 5000 })).rejects.toThrow(
      /premium/,
    );
  });

  it('allows a price at the limit', async () => {
    const { call } = scriptFor('diskpush.com');
    await expect(planRegistration(call, 'diskpush.com', { maxCents: 1108 })).resolves.toMatchObject({
      costCents: 1108,
    });
  });
});

describe('registerDomain', () => {
  it('sends the plan cost in cents, with the terms agreed', async () => {
    const { call, seen } = scripted({ '/domain/create/diskpush.com': { status: 'SUCCESS' } });
    await registerDomain(call, {
      domain: 'diskpush.com',
      costCents: 1108,
      price: '$11.08',
      renewal: '$11.08',
      premium: false,
      firstYearPromo: false,
      years: 1,
      whoisPrivacy: true,
    });

    expect(seen).toHaveLength(1);
    expect(seen[0]).toEqual({
      path: '/domain/create/diskpush.com',
      body: { cost: 1108, agreeToTerms: 'yes', whoisPrivacy: 'yes' },
    });
  });

  it('passes privacy off through as "no"', async () => {
    const { call, seen } = scripted({ '/domain/create/x.com': { status: 'SUCCESS' } });
    await registerDomain(call, {
      domain: 'x.com',
      costCents: 900,
      price: '$9.00',
      renewal: null,
      premium: false,
      firstYearPromo: false,
      years: null,
      whoisPrivacy: false,
    });
    expect(seen[0]?.body.whoisPrivacy).toBe('no');
  });

  // The 200-with-ERROR shape again, on the one call that spends money.
  it('surfaces a refusal rather than reporting success', async () => {
    const call: Caller = async () => {
      throw new PorkbunError('/domain/create/x.com: Insufficient funds.');
    };
    await expect(
      registerDomain(call, {
        domain: 'x.com',
        costCents: 900,
        price: '$9.00',
        renewal: null,
        premium: false,
        firstYearPromo: false,
        years: null,
        whoisPrivacy: true,
      }),
    ).rejects.toThrow(/Insufficient funds/);
  });
});
