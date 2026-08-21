import { describe, expect, it } from 'vitest';

import {
  type Row,
  type State,
  applyStatus,
  extractEmail,
  findRow,
  formatLinks,
  formatRows,
  hostOf,
  merge,
  nextPending,
  normalizeKey,
  openCommand,
  parseList,
  renderAnswers,
  resolveEmail,
} from '../src/affiliates.ts';

describe('parseList', () => {
  // These lists arrive in whatever shape someone had to hand. Rather than
  // asking which format it is, take the first URL on the line.
  it('reads a bare column of URLs', () => {
    expect(parseList('https://elevenlabs.io/affiliates\nhttps://descript.com/affiliate')).toEqual([
      { name: 'elevenlabs.io', url: 'https://elevenlabs.io/affiliates' },
      { name: 'descript.com', url: 'https://descript.com/affiliate' },
    ]);
  });

  it('reads a markdown bullet list', () => {
    expect(parseList('- ElevenLabs — https://elevenlabs.io/affiliates')).toEqual([
      { name: 'ElevenLabs', url: 'https://elevenlabs.io/affiliates' },
    ]);
  });

  it('reads a markdown link', () => {
    expect(parseList('* [Descript](https://www.descript.com/affiliate) — 15%')).toEqual([
      { name: 'Descript', url: 'https://www.descript.com/affiliate' },
    ]);
  });

  it('reads a markdown table row', () => {
    expect(
      parseList('| **Gamma** | 30% recurring | https://gammaapp.partnerstack.com/ | 90d |'),
    ).toEqual([{ name: 'Gamma', url: 'https://gammaapp.partnerstack.com/' }]);
  });

  it('skips headings, blanks and comments', () => {
    expect(parseList('# Tier 1\n\n## nope\n# https://commented.example\n')).toEqual([]);
  });

  // A URL at the end of a sentence collects the punctuation after it.
  it('trims trailing punctuation without eating a legitimate bracket', () => {
    expect(parseList('see https://a.example/x.').map((e) => e.url)).toEqual([
      'https://a.example/x',
    ]);
    expect(parseList('[x](https://a.example/wiki_(y))').map((e) => e.url)).toEqual([
      'https://a.example/wiki_(y)',
    ]);
  });

  it('drops a duplicate that differs only by tracking parameters', () => {
    const entries = parseList(
      'https://a.example/join?utm_source=x\nhttps://a.example/join?utm_source=y',
    );
    expect(entries).toHaveLength(1);
  });
});

describe('normalizeKey', () => {
  // The same page shared from a newsletter and from a tweet differs only by
  // utm_*; two rows would ask you to sign up twice.
  it('ignores tracking parameters, www and a trailing slash', () => {
    expect(normalizeKey('https://www.A.example/Join/?utm_campaign=x&_bhlid=y')).toBe(
      'a.example/join',
    );
  });

  it('keeps a meaningful query', () => {
    expect(normalizeKey('https://gammaapp.partnerstack.com/?group=affiliates')).toBe(
      'gammaapp.partnerstack.com?group=affiliates',
    );
  });
});

describe('merge', () => {
  const entries = [
    { name: 'ElevenLabs', url: 'https://elevenlabs.io/affiliates' },
    { name: 'Descript', url: 'https://www.descript.com/affiliate' },
  ];

  it('lays remembered status over the list order', () => {
    const state: State = {
      'elevenlabs.io/affiliates': {
        name: 'ElevenLabs',
        url: 'https://elevenlabs.io/affiliates',
        status: 'joined',
        referral: 'https://try.elevenlabs.io/abc',
      },
    };
    const rows = merge(entries, state);
    expect(rows.map((row) => row.status)).toEqual(['joined', 'pending']);
    expect(rows[0]!.referral).toBe('https://try.elevenlabs.io/abc');
  });

  // Losing a referral link because someone tidied the source list would be the
  // worst failure this can have.
  it('keeps a remembered entry that has dropped off the list', () => {
    const state: State = {
      'gone.example/join': {
        name: 'Gone',
        url: 'https://gone.example/join',
        status: 'joined',
        referral: 'https://gone.example/r/1',
      },
    };
    const rows = merge(entries, state);
    expect(rows).toHaveLength(3);
    expect(rows[2]).toMatchObject({ name: 'Gone', index: 3 });
  });
});

describe('nextPending', () => {
  const row = (index: number, status: Row['status']): Row => ({
    index,
    key: `k${index}`,
    name: `n${index}`,
    url: `https://e${index}.example`,
    status,
  });

  it('returns the first that is neither joined nor skipped', () => {
    expect(nextPending([row(1, 'joined'), row(2, 'skipped'), row(3, 'opened')])?.index).toBe(3);
  });

  it('is null when everything is dealt with', () => {
    expect(nextPending([row(1, 'joined'), row(2, 'skipped')])).toBeNull();
  });
});

describe('findRow', () => {
  const rows = merge(
    [
      { name: 'ElevenLabs', url: 'https://elevenlabs.io/affiliates' },
      { name: 'Descript', url: 'https://www.descript.com/affiliate' },
    ],
    {},
  );

  it('takes the printed index', () => {
    expect(findRow(rows, '2').name).toBe('Descript');
  });

  it('takes a host or a name, ignoring case', () => {
    expect(findRow(rows, 'elevenlabs.io').name).toBe('ElevenLabs');
    expect(findRow(rows, 'descript').name).toBe('Descript');
  });

  it('says so when nothing matches', () => {
    expect(() => findRow(rows, 'nope')).toThrow(/nothing matching/);
  });

  it('refuses an index past the end', () => {
    expect(() => findRow(rows, '9')).toThrow(/no entry at index 9/);
  });
});

describe('applyStatus', () => {
  const rows = merge([{ name: 'A', url: 'https://a.example/join' }], {});

  it('records the referral link and when', () => {
    const state = applyStatus({}, rows[0]!, 'joined', { referral: 'https://a.example/r/1' }, 'T');
    expect(state['a.example/join']).toMatchObject({
      status: 'joined',
      referral: 'https://a.example/r/1',
      updated: 'T',
    });
  });

  // `skip` typed at the wrong index would otherwise be unrecoverable.
  it('keeps an existing referral link through a later status change', () => {
    const joined = applyStatus({}, rows[0]!, 'joined', { referral: 'https://a.example/r/1' }, 'T');
    const skipped = applyStatus(joined, rows[0]!, 'skipped', {}, 'U');
    expect(skipped['a.example/join']!.referral).toBe('https://a.example/r/1');
  });
});

describe('formatRows', () => {
  it('marks status and counts the tail', () => {
    const rows = merge([{ name: 'A', url: 'https://a.example/join' }], {});
    const out = formatRows(rows);
    expect(out).toContain('1   A  https://a.example/join');
    expect(out).toContain('0 joined · 0 opened · 1 pending · 0 skipped');
  });

  it('says so when there is nothing', () => {
    expect(formatRows([])).toBe('nothing in the list\n');
  });
});

describe('formatLinks', () => {
  const rows = merge([], {
    'a.example/join': {
      name: 'A',
      url: 'https://a.example/join',
      status: 'joined',
      referral: 'https://a.example/r/1',
    },
    'b.example/join': { name: 'B', url: 'https://b.example/join', status: 'pending' },
  });

  it('emits only the ones with a link', () => {
    expect(formatLinks(rows, 'markdown')).toBe('- [A](https://a.example/r/1)\n');
    expect(formatLinks(rows, 'text')).toBe('A\thttps://a.example/r/1\n');
    expect(JSON.parse(formatLinks(rows, 'json'))).toHaveLength(1);
  });

  it('is empty when nothing has been joined', () => {
    expect(formatLinks(merge([], {}))).toBe('');
  });
});

describe('openCommand', () => {
  // $BROWSER is the setting a person deliberately made.
  it('prefers $BROWSER, then the platform opener', () => {
    expect(openCommand('https://a.example', { BROWSER: 'firefox' }, 'linux')).toEqual([
      'firefox',
      'https://a.example',
    ]);
    expect(openCommand('https://a.example', {}, 'linux')).toEqual([
      'xdg-open',
      'https://a.example',
    ]);
    expect(openCommand('https://a.example', {}, 'darwin')).toEqual(['open', 'https://a.example']);
  });
});

describe('resolveEmail', () => {
  // The account is last because it is the one you cannot override in the
  // moment, and signing up as the wrong identity does not undo.
  it('prefers the flag, then env, then profile, then the account', () => {
    expect(resolveEmail({ flag: 'a@x', env: 'b@x', profile: 'c@x', account: 'd@x' })).toBe('a@x');
    expect(resolveEmail({ env: 'b@x', profile: 'c@x', account: 'd@x' })).toBe('b@x');
    expect(resolveEmail({ profile: 'c@x', account: 'd@x' })).toBe('c@x');
    expect(resolveEmail({ account: 'd@x' })).toBe('d@x');
    expect(resolveEmail({})).toBeNull();
  });
});

describe('extractEmail', () => {
  it('finds the address in moshcode whoami output', () => {
    expect(extractEmail('anthony@profullstack.com 🤘  (87 credits)  @ https://app.moshcode.sh')).toBe(
      'anthony@profullstack.com',
    );
  });

  it('is null when there is none', () => {
    expect(extractEmail('not logged in')).toBeNull();
  });
});

describe('renderAnswers', () => {
  // A form that asks for audience size and gets a number nobody checked is the
  // fastest way to lose an account.
  it('names the gaps rather than guessing', () => {
    const out = renderAnswers({ email: 'a@x', site: null, audience: null, promotion: null });
    expect(out).toContain('a@x');
    expect(out).toContain('(not set');
  });
});

describe('hostOf', () => {
  it('drops www', () => {
    expect(hostOf('https://www.descript.com/affiliate')).toBe('descript.com');
  });
});
