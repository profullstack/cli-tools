import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  type Account,
  type CalEvent,
  type Calendar,
  PROVIDERS,
  PROVIDER_NAMES,
  accountsFromVault,
  buildIcs,
  calConfigPath,
  durationMinutes,
  escapeIcs,
  eventDay,
  eventsFromReport,
  foldIcs,
  formatAccounts,
  formatAgenda,
  formatCalendars,
  formatEvent,
  formatProviders,
  guessProvider,
  icsProperties,
  icsUtc,
  isProviderName,
  loadConfig,
  loginFailure,
  loginHint,
  mergeVaultAccounts,
  normalizeConfig,
  openCalDav,
  parseIcs,
  parseIcsDate,
  parseWhen,
  passwordVariable,
  providerFor,
  resolveAccount,
  saveConfig,
  selectAccount,
  unsupportedProvider,
  windowFrom,
  xmlBlocks,
  xmlHas,
  xmlText,
  zonedToUtc,
} from '../src/cal.ts';

const env = (extra: Record<string, string> = {}): NodeJS.ProcessEnv => ({ ...extra });

function account(partial: Partial<Account> = {}): Account {
  return {
    name: 'work',
    email: 'me@example.com',
    user: 'me@example.com',
    password: 'secret',
    passwordSource: 'file',
    provider: 'forwardemail',
    url: 'https://caldav.example.com',
    ...partial,
  };
}

const calendar: Calendar = { name: 'Work', url: 'https://caldav.example.com/cal/work/', color: null, components: ['VEVENT'] };

function event(partial: Partial<CalEvent> = {}): CalEvent {
  return {
    uid: 'abc',
    summary: 'Standup',
    location: '',
    description: '',
    url: '',
    start: '2026-09-07T09:00:00.000Z',
    end: '2026-09-07T09:30:00.000Z',
    allDay: false,
    status: '',
    recurring: false,
    href: 'https://caldav.example.com/cal/work/abc.ics',
    etag: '"1"',
    calendar: 'Work',
    ...partial,
  };
}

const NOW = new Date(2026, 8, 5, 12, 0, 0); // Saturday 2026-09-05, local

describe('providers', () => {
  it('names every built-in provider with an https URL and a password rule', () => {
    expect(PROVIDER_NAMES).toHaveLength(9);
    for (const name of PROVIDER_NAMES) {
      expect(PROVIDERS[name].url, name).toMatch(/^https:\/\//);
      expect(PROVIDERS[name].passwordHint.length, name).toBeGreaterThan(10);
    }
  });

  it('infers the provider from a known domain', () => {
    expect(guessProvider('a@icloud.com')).toBe('icloud');
    expect(guessProvider('a@ME.com')).toBe('icloud');
    expect(guessProvider('a@fastmail.fm')).toBe('fastmail');
    expect(guessProvider('a@zoho.eu')).toBe('zoho');
    expect(guessProvider('a@yahoo.co.uk')).toBe('yahoo');
    expect(guessProvider('a@posteo.net')).toBe('posteo');
    expect(guessProvider('a@gmail.com')).toBeNull();
    expect(guessProvider('a@example.com')).toBeNull();
  });

  it('knows the calendars a password cannot reach', () => {
    expect(unsupportedProvider('google')?.reason).toContain('OAuth2');
    expect(unsupportedProvider('a@gmail.com')?.name).toBe('google');
    expect(unsupportedProvider('a@hotmail.com')?.name).toBe('outlook');
    expect(unsupportedProvider('a@pm.me')?.reason).toContain('no CalDAV on any plan');
    expect(unsupportedProvider('a@icloud.com')).toBeNull();
    expect(isProviderName('google')).toBe(false);
    expect(isProviderName('icloud')).toBe(true);
    expect(isProviderName('custom')).toBe(true);
    expect(providerFor('custom')).toBeNull();
  });

  it('says which kind of password before asking, and lists everything', () => {
    expect(loginHint(PROVIDERS.icloud)).toContain('app password, not the account password');
    expect(loginHint(PROVIDERS.forwardemail)).toContain('generated per address');
    expect(loginHint(PROVIDERS.posteo)).toContain('takes the account password');
    const text = formatProviders();
    for (const name of PROVIDER_NAMES) expect(text).toContain(`  ${name}`);
    expect(text).toContain('Nextcloud');
    expect(text).toContain('Google Calendar');
    expect(text).toContain('Proton Calendar');
  });

  it('names the fix in a login failure', () => {
    expect(loginFailure(account({ provider: 'icloud' }), 401, 'Unauthorized')).toContain('use an app password (https://account.apple.com');
    expect(loginFailure(account(), 401, '')).toContain('Forward Email: the alias password');
    expect(loginFailure(account({ provider: 'custom' }), 403, 'Forbidden')).toBe(
      'CalDAV login to https://caldav.example.com as me@example.com failed (403: Forbidden)',
    );
  });
});

describe('configuration', () => {
  let dir: string;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('fills the URL from the provider and resolves the password, environment first', () => {
    const resolved = resolveAccount('i', { email: 'a@icloud.com', provider: 'icloud', password: 'p' }, env());
    expect(resolved.url).toBe('https://caldav.icloud.com');
    expect(resolved.passwordSource).toBe('file');
    expect(resolveAccount('i', { email: 'a@icloud.com', provider: 'icloud', password: 'p' }, env({ CAL_I_PASSWORD: 'e' })).password).toBe('e');
    expect(resolveAccount('z', { email: 'a@zoho.eu', provider: 'zoho', url: 'https://calendar.zoho.eu/caldav/' }, env()).url).toBe(
      'https://calendar.zoho.eu/caldav/',
    );
    expect(() => resolveAccount('c', { email: 'a@x.org', provider: 'custom' }, env())).toThrow(/needs a URL/);
    expect(passwordVariable('my-home')).toBe('CAL_MY_HOME_PASSWORD');
  });

  it('selects by name, by address, by default, or by being the only one', () => {
    const config = {
      accounts: {
        work: { email: 'a@example.com', provider: 'forwardemail' as const },
        home: { email: 'b@icloud.com', provider: 'icloud' as const },
      },
    };
    expect(selectAccount(config, 'home', env()).name).toBe('home');
    expect(selectAccount(config, 'A@EXAMPLE.COM', env()).name).toBe('work');
    expect(selectAccount({ ...config, default: 'home' }, undefined, env()).name).toBe('home');
    expect(selectAccount(config, undefined, env({ CAL_ACCOUNT: 'work' })).name).toBe('work');
    expect(() => selectAccount(config, undefined, env())).toThrow(/which account/);
    expect(() => selectAccount(config, 'other', env())).toThrow(/work, home/);
    expect(selectAccount({ accounts: { work: config.accounts.work } }, undefined, env()).name).toBe('work');
    expect(() => selectAccount({ accounts: {} }, undefined, env())).toThrow(/cal login/);
  });

  it('round-trips through a 0600 file and drops what is not an account', () => {
    dir = mkdtempSync(join(tmpdir(), 'cal-config-'));
    const e = env({ XDG_CONFIG_HOME: dir });
    expect(calConfigPath(e)).toBe(join(dir, 'cli-tools', 'cal.json'));
    const path = saveConfig({ default: 'work', accounts: { work: { email: 'a@example.com', provider: 'forwardemail', password: 'p' } } }, e);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(loadConfig(e)).toEqual({ default: 'work', accounts: { work: { email: 'a@example.com', provider: 'forwardemail', password: 'p' } } });
    writeFileSync(path, '{nope');
    expect(() => loadConfig(e)).toThrow(/not valid JSON/);
    expect(normalizeConfig({ accounts: { x: { email: 'nope' }, i: { email: 'a@icloud.com' }, g: { email: 'a@x.org', provider: 'google' } } })).toEqual({
      accounts: { i: { email: 'a@icloud.com', provider: 'icloud' }, g: { email: 'a@x.org', provider: 'custom' } },
    });
  });

  it('reads accounts from the vault and merges them over the file', () => {
    const vault = accountsFromVault({
      CAL_WORK_EMAIL: 'a@example.com',
      CAL_WORK_PROVIDER: 'forwardemail',
      CAL_WORK_PASSWORD: 'p',
      CAL_HOME_EMAIL: 'b@icloud.com',
      CAL_NC_EMAIL: 'c@x.org',
      CAL_NC_URL: 'https://x.org/remote.php/dav',
      CAL_NC_USER: 'c',
      CAL_ORPHAN_PASSWORD: 'nope',
      CAL_DEFAULT: 'home',
    });
    expect(vault.accounts.work).toEqual({ email: 'a@example.com', provider: 'forwardemail', password: 'p' });
    expect(vault.accounts.home?.provider).toBe('icloud');
    expect(vault.accounts.nc).toEqual({ email: 'c@x.org', provider: 'custom', url: 'https://x.org/remote.php/dav', user: 'c' });
    expect(vault.accounts.orphan).toBeUndefined();
    expect(vault.default).toBe('home');
    const { merged, changed, unchanged } = mergeVaultAccounts(
      { accounts: { work: { email: 'a@example.com', provider: 'forwardemail', password: 'p' }, local: { email: 'l@x.org', provider: 'custom', url: 'https://l' } } },
      vault,
    );
    expect(changed.sort()).toEqual(['home', 'nc']);
    expect(unchanged).toEqual(['work']);
    expect(merged.accounts.local).toBeDefined();
    expect(merged.default).toBe('home');
  });

  it('never prints a password in the accounts listing', () => {
    const text = formatAccounts([account(), account({ name: 'home', passwordSource: 'unset', password: null })], 'work');
    expect(text).toContain('* work');
    expect(text).toContain('password from cal.json');
    expect(text).toContain('no password');
    expect(text).not.toContain('secret');
  });
});

describe('xml', () => {
  const multistatus =
    '<?xml version="1.0"?><d:multistatus xmlns:d="DAV:" xmlns:cal="urn:ietf:params:xml:ns:caldav">' +
    '<d:response><d:href>/cal/work/</d:href><d:propstat><d:prop><d:displayname>Work &amp; Play</d:displayname>' +
    '<d:resourcetype><d:collection/><cal:calendar/></d:resourcetype>' +
    '<cal:supported-calendar-component-set><cal:comp name="VEVENT"/><cal:comp name="VTODO"/></cal:supported-calendar-component-set>' +
    '</d:prop></d:propstat></d:response>' +
    '<d:response><d:href>/cal/</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop></d:propstat></d:response>' +
    '</d:multistatus>';

  it('reads elements regardless of prefix and decodes entities', () => {
    const blocks = xmlBlocks(multistatus, 'response');
    expect(blocks).toHaveLength(2);
    expect(xmlText(blocks[0]!, 'href')).toBe('/cal/work/');
    expect(xmlText(blocks[0]!, 'displayname')).toBe('Work & Play');
    expect(xmlHas(xmlText(blocks[0]!, 'resourcetype')!, 'calendar')).toBe(true);
    expect(xmlHas(xmlText(blocks[1]!, 'resourcetype')!, 'calendar')).toBe(false);
    expect(xmlText('<D:x><![CDATA[a < b]]></D:x>', 'x')).toBe('a < b');
    expect(xmlText('<x>&#x41;&#66;</x>', 'x')).toBe('AB');
  });
});

describe('icalendar', () => {
  const sample = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'BEGIN:VEVENT',
    'UID:one@example.com',
    'DTSTAMP:20260901T000000Z',
    'DTSTART;TZID=America/New_York:20260907T090000',
    'DTEND;TZID=America/New_York:20260907T093000',
    'SUMMARY:Standup\\, daily',
    'LOCATION:Zoom',
    'DESCRIPTION:line one\\nline two\\; semi',
    'RRULE:FREQ=DAILY',
    'END:VEVENT',
    'BEGIN:VEVENT',
    'UID:two',
    'DTSTART;VALUE=DATE:20260910',
    'SUMMARY:Holiday that is long enough to need folding across the seventy-five oc',
    ' tet boundary of the line',
    'END:VEVENT',
    'BEGIN:VEVENT',
    'UID:three',
    'DTSTART:20260911T120000Z',
    'DURATION:PT1H30M',
    'SUMMARY:Lunch',
    'END:VEVENT',
    'END:VCALENDAR',
  ].join('\r\n');

  it('unfolds lines and parses parameters, quoted values included', () => {
    const properties = icsProperties('X;A=1;B="c:d":val:ue\r\nY:\r\n z');
    expect(properties[0]).toEqual({ name: 'X', params: { A: '1', B: 'c:d' }, value: 'val:ue' });
    expect(properties[1]).toEqual({ name: 'Y', params: {}, value: 'z' });
  });

  it('parses events with zoned, all-day and duration-based times', () => {
    const events = parseIcs(sample);
    expect(events).toHaveLength(3);
    const [standup, holiday, lunch] = events;
    expect(standup!.summary).toBe('Standup, daily');
    expect(standup!.description).toBe('line one\nline two; semi');
    expect(standup!.location).toBe('Zoom');
    expect(standup!.recurring).toBe(true);
    // 09:00 New York on 2026-09-07 (EDT, UTC-4) is 13:00Z.
    expect(standup!.start).toBe('2026-09-07T13:00:00.000Z');
    expect(standup!.end).toBe('2026-09-07T13:30:00.000Z');
    expect(holiday!.allDay).toBe(true);
    expect(holiday!.start).toBe('2026-09-10');
    expect(holiday!.end).toBe('2026-09-11');
    expect(holiday!.summary).toContain('seventy-five octet boundary');
    expect(lunch!.start).toBe('2026-09-11T12:00:00.000Z');
    expect(lunch!.end).toBe('2026-09-11T13:30:00.000Z');
  });

  it('converts zoned wall-clock times, DST on both sides', () => {
    expect(zonedToUtc(2026, 1, 15, 9, 0, 0, 'America/New_York').toISOString()).toBe('2026-01-15T14:00:00.000Z');
    expect(zonedToUtc(2026, 7, 15, 9, 0, 0, 'America/New_York').toISOString()).toBe('2026-07-15T13:00:00.000Z');
    expect(zonedToUtc(2026, 7, 15, 9, 0, 0, 'Europe/Berlin').toISOString()).toBe('2026-07-15T07:00:00.000Z');
    expect(parseIcsDate('20260907', {})).toEqual({ value: '2026-09-07', allDay: true });
    expect(parseIcsDate('20260907T120000Z', {})).toEqual({ value: '2026-09-07T12:00:00.000Z', allDay: false });
    expect(parseIcsDate('nope', {})).toBeNull();
  });

  it('reads durations both ways', () => {
    expect(durationMinutes('PT1H30M')).toBe(90);
    expect(durationMinutes('P2D')).toBe(2880);
    expect(durationMinutes('1h30m')).toBe(90);
    expect(durationMinutes('45m')).toBe(45);
    expect(durationMinutes('2d')).toBe(2880);
    expect(() => durationMinutes('soon')).toThrow(/not a duration/);
  });

  it('builds a VEVENT that folds, escapes and stamps in UTC', () => {
    const { uid, ics } = buildIcs(
      {
        uid: 'fixed',
        summary: 'Plan; the, thing',
        start: '2026-09-07T13:00:00.000Z',
        end: '2026-09-07T14:00:00.000Z',
        allDay: false,
        location: 'Room 1',
        description: 'a\nb',
        url: 'https://example.com/x',
      },
      new Date('2026-09-01T00:00:00Z'),
    );
    expect(uid).toBe('fixed');
    expect(ics).toContain('DTSTART:20260907T130000Z\r\n');
    expect(ics).toContain('DTSTAMP:20260901T000000Z\r\n');
    expect(ics).toContain('SUMMARY:Plan\\; the\\, thing\r\n');
    expect(ics).toContain('DESCRIPTION:a\\nb\r\n');
    expect(ics.endsWith('END:VCALENDAR\r\n')).toBe(true);
    for (const line of ics.split('\r\n')) expect(Buffer.byteLength(line)).toBeLessThanOrEqual(75);
    const allDay = buildIcs({ summary: 'Off', start: '2026-09-10', end: '2026-09-11', allDay: true });
    expect(allDay.ics).toContain('DTSTART;VALUE=DATE:20260910\r\nDTEND;VALUE=DATE:20260911\r\n');
    expect(allDay.uid).toMatch(/^[0-9a-f-]{36}$/);
    // What was built parses back to the same event.
    const [parsed] = parseIcs(ics);
    expect(parsed?.summary).toBe('Plan; the, thing');
    expect(parsed?.start).toBe('2026-09-07T13:00:00.000Z');
  });

  it('folds at 75 octets without splitting a multibyte character', () => {
    const line = `SUMMARY:${'é'.repeat(60)}`;
    const folded = foldIcs(line);
    for (const part of folded.split('\r\n')) expect(Buffer.byteLength(part)).toBeLessThanOrEqual(75);
    expect(folded.replace(/\r\n /g, '')).toBe(line);
    expect(escapeIcs('a,b;c\\d\ne')).toBe('a\\,b\\;c\\\\d\\ne');
    expect(icsUtc(new Date('2026-09-07T13:00:00.500Z'))).toBe('20260907T130000Z');
  });
});

describe('times as typed', () => {
  it('reads dates, days, weekdays and clock times in the local zone', () => {
    expect(parseWhen('2026-09-06', NOW)).toEqual({ value: '2026-09-06', allDay: true });
    expect(parseWhen('today', NOW)).toEqual({ value: '2026-09-05', allDay: true });
    expect(parseWhen('tomorrow', NOW)).toEqual({ value: '2026-09-06', allDay: true });
    expect(parseWhen('friday', NOW)).toEqual({ value: '2026-09-11', allDay: true });
    expect(parseWhen('sat', NOW)).toEqual({ value: '2026-09-12', allDay: true }); // next Saturday, never today
    const local = (y: number, m: number, d: number, h: number, mi: number) => new Date(y, m - 1, d, h, mi).toISOString();
    expect(parseWhen('2026-09-06 14:00', NOW)).toEqual({ value: local(2026, 9, 6, 14, 0), allDay: false });
    expect(parseWhen('2026-09-06T09:30', NOW)).toEqual({ value: local(2026, 9, 6, 9, 30), allDay: false });
    expect(parseWhen('tomorrow 9:30', NOW)).toEqual({ value: local(2026, 9, 6, 9, 30), allDay: false });
    expect(parseWhen('fri 2pm', NOW)).toEqual({ value: local(2026, 9, 11, 14, 0), allDay: false });
    expect(parseWhen('12am', NOW)).toEqual({ value: local(2026, 9, 5, 0, 0), allDay: false });
    expect(parseWhen('14:00', NOW)).toEqual({ value: local(2026, 9, 5, 14, 0), allDay: false });
    expect(() => parseWhen('whenever', NOW)).toThrow(/not a time/);
    expect(() => parseWhen('2026-09-06 25:00', NOW)).toThrow(/not a time of day/);
  });

  it('turns the listing flags into a window', () => {
    const today = windowFrom({ today: true }, NOW);
    expect(today.from).toEqual(new Date(2026, 8, 5));
    expect(today.to).toEqual(new Date(2026, 8, 6));
    expect(windowFrom({ tomorrow: true }, NOW).label).toBe('tomorrow');
    expect(windowFrom({}, NOW).to).toEqual(new Date(2026, 8, 12));
    expect(windowFrom({ days: 1 }, NOW).label).toBe('the next 1 day');
    const range = windowFrom({ from: '2026-10-01', to: '2026-10-03' }, NOW);
    expect(range.from).toEqual(new Date(2026, 9, 1));
    expect(range.label).toBe('2026-10-01 to 2026-10-03');
    expect(() => windowFrom({ from: '2026-10-03', to: '2026-10-01' }, NOW)).toThrow(/after --from/);
  });
});

describe('CalDAV client', () => {
  type Call = { method: string; url: string; headers: Record<string, string>; body: string | undefined };
  function server(routes: (call: Call) => { status: number; body?: string; headers?: Record<string, string> }) {
    const calls: Call[] = [];
    const fetcher = async (url: string, init: RequestInit) => {
      const call: Call = {
        method: init.method ?? 'GET',
        url,
        headers: init.headers as Record<string, string>,
        body: typeof init.body === 'string' ? init.body : undefined,
      };
      calls.push(call);
      const reply = routes(call);
      // A 204 may not carry a body, not even an empty string.
      return new Response(reply.body ?? null, { status: reply.status, headers: reply.headers ?? {} });
    };
    return { calls, fetcher };
  }

  const principalXml =
    '<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:response><d:href>/</d:href><d:propstat><d:prop>' +
    '<d:current-user-principal><d:href>/principals/me/</d:href></d:current-user-principal></d:prop></d:propstat></d:response></d:multistatus>';
  const homeXml =
    '<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:response><d:href>/principals/me/</d:href><d:propstat><d:prop>' +
    '<c:calendar-home-set><d:href>/calendars/me/</d:href></c:calendar-home-set></d:prop></d:propstat></d:response></d:multistatus>';
  const calendarsXml =
    '<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">' +
    '<d:response><d:href>/calendars/me/</d:href><d:propstat><d:prop><d:resourcetype><d:collection/></d:resourcetype></d:prop></d:propstat></d:response>' +
    '<d:response><d:href>/calendars/me/work/</d:href><d:propstat><d:prop><d:displayname>Work</d:displayname>' +
    '<d:resourcetype><d:collection/><c:calendar/></d:resourcetype><c:supported-calendar-component-set><c:comp name="VEVENT"/></c:supported-calendar-component-set></d:prop></d:propstat></d:response>' +
    '<d:response><d:href>/calendars/me/tasks/</d:href><d:propstat><d:prop><d:displayname>Tasks</d:displayname>' +
    '<d:resourcetype><d:collection/><c:calendar/></d:resourcetype><c:supported-calendar-component-set><c:comp name="VTODO"/></c:supported-calendar-component-set></d:prop></d:propstat></d:response>' +
    '</d:multistatus>';
  const reportXml =
    '<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:response><d:href>/calendars/me/work/one.ics</d:href>' +
    '<d:propstat><d:prop><d:getetag>"e1"</d:getetag><c:calendar-data>BEGIN:VCALENDAR\nBEGIN:VEVENT\nUID:one\nDTSTART:20260907T130000Z\nDTEND:20260907T140000Z\nSUMMARY:Planning &amp; review\nEND:VEVENT\nEND:VCALENDAR</c:calendar-data>' +
    '</d:prop></d:propstat></d:response></d:multistatus>';

  it('discovers principal, home and the VEVENT calendars, with Basic auth on every request', async () => {
    const { calls, fetcher } = server((call) => {
      if (call.method === 'PROPFIND' && call.url === 'https://caldav.example.com/') return { status: 207, body: principalXml };
      if (call.method === 'PROPFIND' && call.url.endsWith('/principals/me/')) return { status: 207, body: homeXml };
      if (call.method === 'PROPFIND' && call.url.endsWith('/calendars/me/')) return { status: 207, body: calendarsXml };
      return { status: 404 };
    });
    const dav = openCalDav(account({ url: 'https://caldav.example.com/' }), fetcher);
    const calendars = await dav.calendars();
    expect(calendars.map((calendar) => calendar.name)).toEqual(['Work']);
    expect(calendars[0]!.url).toBe('https://caldav.example.com/calendars/me/work/');
    expect(calls).toHaveLength(3);
    for (const call of calls) expect(call.headers.Authorization).toBe(`Basic ${Buffer.from('me@example.com:secret').toString('base64')}`);
    expect(calls[0]!.headers.Depth).toBe('0');
    expect(calls[2]!.headers.Depth).toBe('1');
    // The home is remembered; a second listing does not rediscover it.
    await dav.calendars();
    expect(calls).toHaveLength(4);
  });

  it('follows a redirect from the discovery root and takes a home-set answered directly', async () => {
    const direct =
      '<d:multistatus xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:response><d:href>/dav/</d:href><d:propstat><d:prop>' +
      '<c:calendar-home-set><d:href>https://p01.example.com/home/</d:href></c:calendar-home-set></d:prop></d:propstat></d:response></d:multistatus>';
    const { calls, fetcher } = server((call) => {
      if (call.url === 'https://caldav.example.com/') return { status: 301, headers: { location: '/dav/' } };
      if (call.url === 'https://caldav.example.com/dav/') return { status: 207, body: direct };
      if (call.url === 'https://p01.example.com/home/') return { status: 207, body: calendarsXml };
      return { status: 404 };
    });
    const calendars = await openCalDav(account({ url: 'https://caldav.example.com/' }), fetcher).calendars();
    expect(calendars[0]!.url).toBe('https://p01.example.com/calendars/me/work/');
    expect(calls.map((call) => call.url)).toEqual(['https://caldav.example.com/', 'https://caldav.example.com/dav/', 'https://p01.example.com/home/']);
  });

  it('asks the server to expand a window and reads the events back', async () => {
    const { calls, fetcher } = server((call) => (call.method === 'REPORT' ? { status: 207, body: reportXml } : { status: 404 }));
    const dav = openCalDav(account(), fetcher);
    const events = await dav.events(calendar, new Date('2026-09-07T00:00:00Z'), new Date('2026-09-14T00:00:00Z'));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      uid: 'one',
      summary: 'Planning & review',
      etag: '"e1"',
      calendar: 'Work',
      href: 'https://caldav.example.com/calendars/me/work/one.ics',
    });
    expect(calls[0]!.body).toContain('<C:expand start="20260907T000000Z" end="20260914T000000Z"/>');
    expect(calls[0]!.body).toContain('<C:time-range start="20260907T000000Z" end="20260914T000000Z"/>');
    expect(calls[0]!.headers.Depth).toBe('1');
  });

  it('finds one event by uid, puts a new one without overwriting, and deletes with the etag', async () => {
    const { calls, fetcher } = server((call) => {
      if (call.method === 'REPORT') return { status: 207, body: reportXml };
      if (call.method === 'PUT') return { status: 201 };
      if (call.method === 'DELETE') return { status: 204 };
      return { status: 404 };
    });
    const dav = openCalDav(account(), fetcher);
    expect((await dav.find(calendar, 'one'))?.summary).toBe('Planning & review');
    expect(await dav.find(calendar, 'other')).toBeNull();
    expect(calls[0]!.body).toContain('<C:prop-filter name="UID"><C:text-match collation="i;octet">one</C:text-match>');
    const href = await dav.put(calendar, 'BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n', 'new-uid');
    expect(href).toBe('https://caldav.example.com/cal/work/new-uid.ics');
    const put = calls.find((call) => call.method === 'PUT')!;
    expect(put.headers['If-None-Match']).toBe('*');
    expect(put.headers['Content-Type']).toContain('text/calendar');
    await dav.remove(href, '"e1"');
    expect(calls.at(-1)!.headers['If-Match']).toBe('"e1"');
  });

  it('turns a 401 into the provider-specific fix and refuses a clear-text URL', async () => {
    const { fetcher } = server(() => ({ status: 401, body: 'Unauthorized' }));
    await expect(openCalDav(account({ provider: 'icloud', url: 'https://caldav.icloud.com' }), fetcher).calendars()).rejects.toThrow(/use an app password/);
    expect(() => openCalDav(account({ url: 'http://caldav.example.com' }), fetcher)).toThrow(/in clear/);
    expect(() => openCalDav(account({ password: null, passwordSource: 'unset' }), fetcher)).toThrow(/has no password/);
    const bad = server(() => ({ status: 207, body: '<d:multistatus xmlns:d="DAV:"></d:multistatus>' }));
    await expect(openCalDav(account(), bad.fetcher).calendars()).rejects.toThrow(/did not name a principal/);
  });

  it('parses a report body on its own', () => {
    expect(eventsFromReport(reportXml, calendar)[0]?.start).toBe('2026-09-07T13:00:00.000Z');
    expect(eventsFromReport('<d:multistatus xmlns:d="DAV:"/>', calendar)).toEqual([]);
  });
});

describe('output', () => {
  it('groups the agenda by local day, all-day first, and labels calendars when asked', () => {
    const local = (h: number) => new Date(2026, 8, 7, h, 0).toISOString();
    const text = formatAgenda(
      [
        event({ uid: 'b', summary: 'Lunch', start: local(12), end: local(13), location: 'Cafe' }),
        event({ uid: 'a', summary: 'Standup', start: local(9), end: new Date(2026, 8, 7, 9, 30).toISOString(), calendar: 'Work' }),
        event({ uid: 'c', summary: 'Off', start: '2026-09-07', end: '2026-09-08', allDay: true, calendar: 'Home' }),
        event({ uid: 'd', summary: 'Later', start: new Date(2026, 8, 8, 10, 0).toISOString(), end: new Date(2026, 8, 8, 11, 0).toISOString(), status: 'CANCELLED' }),
      ],
      { showCalendar: true },
    );
    const lines = text.split('\n');
    expect(lines[0]).toBe('Mon 2026-09-07');
    expect(lines[1]).toContain('all day');
    expect(lines[1]).toContain('Off  [Home]');
    expect(lines[2]).toContain('09:00–09:30  Standup  [Work]');
    expect(lines[3]).toContain('12:00–13:00  Lunch');
    expect(lines[3]).toContain('@ Cafe');
    expect(lines[4]).toBe('Tue 2026-09-08');
    expect(lines[5]).toContain('(cancelled)');
    expect(formatAgenda([])).toBe('(no events)');
    expect(eventDay(event({ start: '2026-09-07', allDay: true }))).toBe('2026-09-07');
  });

  it('prints one event with what it has, and the calendars with their URLs', () => {
    const text = formatEvent(event({ location: 'Zoom', description: 'Bring notes', recurring: true, url: 'https://x' }));
    expect(text).toContain('Title:    Standup');
    expect(text).toContain('Where:    Zoom');
    expect(text).toContain('Repeats:  yes');
    expect(text).toContain('Link:     https://x');
    expect(text).toContain('Uid:      abc');
    expect(text.endsWith('Bring notes')).toBe(true);
    expect(formatEvent(event({ start: '2026-09-10', end: '2026-09-12', allDay: true }))).toContain('Thu 2026-09-10 to Fri 2026-09-11 (all day)');
    expect(formatCalendars([calendar])).toBe('Work  https://caldav.example.com/cal/work/');
    expect(formatCalendars([])).toBe('(no calendars)');
  });
});
