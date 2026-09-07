import { describe, expect, it } from 'vitest';
import { catalogue, daysLeft, lineFromEnv, lineStatus, slots } from '../src/argontv.ts';
import type { LineStatus } from '../src/argontv.ts';

/**
 * The line behind the Live TV passes.
 *
 * The arithmetic here is the product: one shared line permits a fixed number of
 * simultaneous streams, so how many passes may be sold is bounded by hardware
 * rather than by demand. Getting it wrong sells somebody a month they cannot
 * watch.
 */

const status = (over: Partial<LineStatus> = {}): LineStatus => ({
  status: 'Active',
  maxConnections: 6,
  activeConnections: 0,
  expiresAt: new Date('2026-10-07T00:04:10Z'),
  createdAt: new Date('2026-09-06T14:04:10Z'),
  isTrial: false,
  formats: ['ts', 'm3u8', 'rtmp'],
  ...over,
});

describe('how many passes may exist', () => {
  /*
   * The reserve is the point. Sold to the full six, the first person to open a
   * stream to check a complaint takes the slot a paying customer wanted -- and
   * the customer is the one who sees it fail.
   */
  it('holds one connection back from the sellable count', () => {
    const room = slots(status(), {});
    expect(room.capacity).toBe(6);
    expect(room.sellable).toBe(5);
    expect(room.reserved).toBe(1);
  });

  it('free counts what is unused right now, not what is sellable', () => {
    const room = slots(status({ activeConnections: 4 }), {});
    expect(room.free).toBe(2);
    // Still five: how many passes may exist does not change because four people
    // happen to be watching this second.
    expect(room.sellable).toBe(5);
  });

  it('never reports negative headroom when the panel over-counts', () => {
    // Panels do report more active connections than the line permits, briefly,
    // while a stream is being torn down.
    expect(slots(status({ activeConnections: 9 }), {}).free).toBe(0);
  });

  it('an explicit cap overrides the reserve', () => {
    const room = slots(status(), { ARGONTV_MAX_PASSES: '3' });
    expect(room.sellable).toBe(3);
    expect(room.reserved).toBe(3);
  });

  it('a one-connection line is still sellable once', () => {
    const room = slots(status({ maxConnections: 1 }), {});
    expect(room.sellable).toBe(1);
    expect(room.reserved).toBe(0);
  });

  it('says nothing rather than guessing when the panel omits the limit', () => {
    const room = slots(status({ maxConnections: null }), {});
    expect(room.capacity).toBeNull();
    expect(room.free).toBeNull();
    expect(room.sellable).toBeNull();
  });
});

describe('reading the panel', () => {
  const answer = (body: unknown) =>
    (async () => new Response(JSON.stringify(body), { status: 200 })) as unknown as typeof fetch;

  const line = { server: 'http://panel.test', username: 'u', password: 'p' };

  it('reads the account, converting the panel’s epoch strings', async () => {
    const s = await lineStatus(
      line,
      answer({
        user_info: {
          auth: 1,
          status: 'Active',
          max_connections: '6',
          active_cons: '2',
          exp_date: '1791331450',
          is_trial: '0',
          allowed_output_formats: ['ts'],
        },
      }),
    );
    expect(s.maxConnections).toBe(6);
    expect(s.activeConnections).toBe(2);
    expect(s.expiresAt?.toISOString()).toBe('2026-10-07T00:04:10.000Z');
    expect(s.isTrial).toBe(false);
  });

  /*
   * A panel answers 200 with `auth: 0` for a wrong password rather than 401, so
   * a status check that only looked at the HTTP code would report a dead line as
   * healthy with every field null.
   */
  it('treats auth: 0 as a refusal, not as an empty account', async () => {
    await expect(lineStatus(line, answer({ user_info: { auth: 0 } }))).rejects.toThrow(
      /rejected that username and password/,
    );
  });

  /*
   * `series` from the panel counts SHOWS. The M3U expands every episode, about
   * twenty-six per show, which is why one line reports 44,790 and its playlist
   * has 1,152,848 entries for the same catalogue.
   */
  it('counts each kind separately', async () => {
    const c = await catalogue(line, (async (url: string | URL) => {
      const action = String(url).match(/action=(\w+)/)?.[1];
      const n = { get_live_streams: 3, get_vod_streams: 2, get_series: 1 }[action ?? ''] ?? 0;
      return new Response(JSON.stringify(Array.from({ length: n }, (_, i) => i)), { status: 200 });
    }) as unknown as typeof fetch);
    expect(c).toEqual({ live: 3, movies: 2, series: 1 });
  });
});

describe('configuration', () => {
  it('prefers the environment over the stored file', () => {
    const found = lineFromEnv({
      ARGONTV_LINE_SERVER: 'http://a.test/',
      ARGONTV_LINE_USERNAME: 'u',
      ARGONTV_LINE_PASSWORD: 'p',
    } as NodeJS.ProcessEnv);
    expect(found).toEqual({ server: 'http://a.test', username: 'u', password: 'p' });
  });

  it('is null when half-configured, so the caller can print usage', () => {
    expect(
      lineFromEnv({ ARGONTV_LINE_SERVER: 'http://a.test' } as NodeJS.ProcessEnv),
    ).toBeNull();
  });
});

describe('expiry', () => {
  it('counts whole days remaining', () => {
    expect(daysLeft(new Date('2026-10-07T00:00:00Z'), new Date('2026-09-07T00:00:00Z'))).toBe(30);
  });

  it('goes negative once it has lapsed, rather than clamping to zero', () => {
    // A lapsed line should read as lapsed. Zero would be indistinguishable from
    // "expires today", which is a different thing to do about.
    expect(daysLeft(new Date('2026-09-01T00:00:00Z'), new Date('2026-09-06T00:00:00Z'))).toBe(-5);
  });
});
