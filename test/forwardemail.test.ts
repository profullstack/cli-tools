import { describe, expect, it } from 'vitest';

import { ForwardEmailError, client, ensureAlias, maskRecipient, splitAddress } from '../src/forwardemail.ts';

/** A fake Forward Email API over one domain's alias list, recording every call. */
function fakeApi(initial: Array<Record<string, unknown>>) {
  const aliases = initial.map((a) => ({ ...a }));
  const calls: Array<{ method: string; url: string; body: unknown; auth: string | null }> = [];
  const doFetch = (async (url: string | URL, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    const method = init?.method ?? 'GET';
    calls.push({ method, url: String(url), body, auth: new Headers(init?.headers).get('authorization') });
    const u = new URL(String(url));
    if (method === 'GET') {
      const name = u.searchParams.get('name');
      return Response.json(aliases.filter((a) => !name || a.name === name));
    }
    if (method === 'POST') {
      const row = { id: `id-${aliases.length + 1}`, ...body };
      aliases.push(row);
      return Response.json(row);
    }
    if (method === 'PUT') {
      const id = u.pathname.split('/').pop();
      const row = aliases.find((a) => a.id === id)!;
      Object.assign(row, body);
      return Response.json(row);
    }
    return new Response('nope', { status: 405 });
  }) as typeof fetch;
  return { api: client('tok', doFetch), calls, aliases };
}

describe('forwardemail', () => {
  it('splits an address and refuses a non-address', () => {
    expect(splitAddress('Submit@C0upons.com')).toEqual({ name: 'submit', domain: 'c0upons.com' });
    expect(() => splitAddress('submit')).toThrow(ForwardEmailError);
  });

  it('sends the token as the Basic-auth username with an empty password', async () => {
    const { api, calls } = fakeApi([]);
    await ensureAlias(api, 'submit@c0upons.com', ['https://c0upons.com/api/webhooks/email?key=s3cret']);
    expect(calls[0]!.auth).toBe(`Basic ${Buffer.from('tok:').toString('base64')}`);
  });

  it('creates a missing alias, then leaves it alone', async () => {
    const { api, calls } = fakeApi([]);
    const hook = 'https://c0upons.com/api/webhooks/email?key=s3cret';
    expect((await ensureAlias(api, 'submit@c0upons.com', [hook])).outcome).toBe('created');
    expect((await ensureAlias(api, 'submit@c0upons.com', [hook])).outcome).toBe('unchanged');
    expect(calls.filter((c) => c.method !== 'GET')).toHaveLength(1);
  });

  it('adds a recipient without removing the ones already there', async () => {
    const { api, aliases } = fakeApi([{ id: 'a1', name: 'submit', recipients: ['anthony@profullstack.com'], is_enabled: true }]);
    const r = await ensureAlias(api, 'submit@c0upons.com', ['https://c0upons.com/api/webhooks/email?key=k']);
    expect(r.outcome).toBe('updated');
    expect(aliases[0]!.recipients).toEqual(['anthony@profullstack.com', 'https://c0upons.com/api/webhooks/email?key=k']);
  });

  it('re-enables a disabled alias', async () => {
    const { api } = fakeApi([{ id: 'a1', name: 'submit', recipients: ['x@y.com'], is_enabled: false }]);
    expect((await ensureAlias(api, 'submit@c0upons.com', ['X@Y.com'])).outcome).toBe('updated');
  });

  it('surfaces the API message on failure', async () => {
    const api = client('bad', (async () => Response.json({ message: 'Invalid API token.' }, { status: 401 })) as typeof fetch);
    await expect(ensureAlias(api, 'a@b.com', ['c@d.com'])).rejects.toThrow(/401 Invalid API token/);
  });

  it('masks webhook keys when printing', () => {
    expect(maskRecipient('https://c0upons.com/api/webhooks/email?key=s3cret&x=1')).toBe('https://c0upons.com/api/webhooks/email?key=…&x=1');
  });
});
