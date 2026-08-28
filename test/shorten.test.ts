import { describe, expect, it } from 'vitest';

import {
  DEFAULT_BASE,
  ShortenError,
  baseUrl,
  formatLink,
  formatList,
  listLinks,
  removeLink,
  resolveToken,
  shorten,
} from '../src/shorten.ts';

/** A caller that records the request and answers with what it was given. */
function caller(status: number, body: unknown) {
  const calls: { path: string; method: string; body?: unknown }[] = [];
  const call = async (path: string, init: { method: string; body?: unknown }) => {
    calls.push({ path, method: init.method, ...(init.body === undefined ? {} : { body: init.body }) });
    return { status, body };
  };
  return { call, calls };
}

const LINK = {
  code: 'k7mq2xd',
  url: 'https://example.com/x',
  short: 'https://pit.moshcode.sh/f/k7mq2xd',
  name: null,
  hits: 0,
  created: true,
};

describe('resolveToken', () => {
  it('prefers the environment, then the store, then moshcode login', () => {
    const readFile = () => JSON.stringify({ token: 'from-moshcode' });

    expect(resolveToken({ MOSHCODE_API_KEY: 'from-env' }, { MOSHCODE_API_KEY: 'stored' }, readFile))
      .toBe('from-env');
    expect(resolveToken({}, { MOSHCODE_API_KEY: 'stored' }, readFile)).toBe('stored');
    expect(resolveToken({}, {}, readFile)).toBe('from-moshcode');
  });

  // Not logged in is the ordinary first run, not an error worth throwing over —
  // the caller turns a null into the one message that says how to fix it.
  it('is null when there is nothing to find, and never throws', () => {
    const missing = () => {
      throw new Error('ENOENT');
    };
    expect(resolveToken({}, {}, missing)).toBeNull();
    expect(resolveToken({}, {}, () => 'not json at all')).toBeNull();
    expect(resolveToken({}, {}, () => JSON.stringify({ token: '   ' }))).toBeNull();
    expect(resolveToken({ MOSHCODE_API_KEY: '  ' }, {}, missing)).toBeNull();
  });
});

describe('baseUrl', () => {
  it('is the pit unless pointed somewhere else, and never keeps a trailing slash', () => {
    expect(baseUrl({})).toBe(DEFAULT_BASE);
    expect(baseUrl({ MOSHPIT_REGISTRY: 'http://localhost:3000/' })).toBe('http://localhost:3000');
  });
});

describe('shorten', () => {
  it('posts the url and returns the minted link', async () => {
    const { call, calls } = caller(201, LINK);
    const link = await shorten('https://example.com/x', call);

    expect(calls).toEqual([
      { path: '/api/moshpit/links', method: 'POST', body: { url: 'https://example.com/x' } },
    ]);
    expect(link.short).toBe('https://pit.moshcode.sh/f/k7mq2xd');
  });

  it('sends a name only when one was asked for', async () => {
    const withName = caller(201, LINK);
    await shorten('https://example.com/x', withName.call, { name: 'blue.eggs' });
    expect(withName.calls[0]!.body).toEqual({ url: 'https://example.com/x', name: 'blue.eggs' });

    const without = caller(201, LINK);
    await shorten('https://example.com/x', without.call, { name: undefined });
    expect(without.calls[0]!.body).toEqual({ url: 'https://example.com/x' });
  });

  // The registry's refusals are written for a person; inventing our own from a
  // status code would lose the only useful part.
  it('passes the registry’s own refusal through', async () => {
    const { call } = caller(400, { error: 'javascript links cannot be shortened — http(s) only' });
    await expect(shorten('javascript:alert(1)', call)).rejects.toThrow(
      /http\(s\) only/,
    );
    await expect(shorten('javascript:alert(1)', call)).rejects.toBeInstanceOf(ShortenError);
  });

  it('turns a 401 into the command that fixes it', async () => {
    const { call } = caller(401, { error: 'sign in first' });
    await expect(shorten('https://example.com/x', call)).rejects.toThrow(/moshcode login/);
  });

  it('has a message even when the body is not JSON', async () => {
    const { call } = caller(502, null);
    await expect(shorten('https://example.com/x', call)).rejects.toThrow(/502/);
  });
});

describe('listLinks', () => {
  it('reads the links out, and copes with a body that has none', async () => {
    expect(await listLinks(caller(200, { links: [LINK] }).call)).toHaveLength(1);
    expect(await listLinks(caller(200, {}).call)).toEqual([]);
    expect(await listLinks(caller(200, { links: 'nope' }).call)).toEqual([]);
  });
});

describe('removeLink', () => {
  it('deletes by code and returns the code the registry confirmed', async () => {
    const { call, calls } = caller(200, { code: 'k7mq2xd', deleted: true });
    expect(await removeLink('k7mq2xd', call)).toBe('k7mq2xd');
    expect(calls[0]).toEqual({ path: '/api/moshpit/links/k7mq2xd', method: 'DELETE' });
  });

  it('escapes the code rather than pasting it into the path', async () => {
    const { call, calls } = caller(200, {});
    await removeLink('../../admin', call);
    expect(calls[0]!.path).toBe('/api/moshpit/links/..%2F..%2Fadmin');
  });
});

describe('formatting', () => {
  it('leads with the short url, because that is what gets copied', () => {
    expect(formatLink(LINK)).toBe('https://pit.moshcode.sh/f/k7mq2xd → https://example.com/x\n');
    expect(formatLink(LINK, { bare: true })).toBe('https://pit.moshcode.sh/f/k7mq2xd\n');
  });

  it('says what an empty list means instead of printing nothing', () => {
    expect(formatList([])).toMatch(/no short links yet/);
  });

  it('counts hits in English and names where a link is filed', () => {
    const listed = formatList([
      { ...LINK, hits: 1 },
      { ...LINK, code: 'aaa', hits: 4, name: 'blue.eggs' },
    ]);
    expect(listed).toMatch(/1 hit\n/);
    expect(listed).toMatch(/4 hits · blue\.eggs/);
  });
});
