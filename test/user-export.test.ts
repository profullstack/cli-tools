import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { describe, expect, it } from 'vitest';

import {
  ExportError,
  csvField,
  exportUsers,
  libsqlHttpUrl,
  parseConfig,
  readLibsql,
  readSqlite,
  readSupabaseAuth,
  readSupabaseManagement,
  secretResolver,
  toCsv,
  type Fetch,
} from '../src/user-export.ts';

const literal = secretResolver({});

/** A fetch that answers by URL substring and records what it was asked. */
function fakeFetch(routes: [string, (init?: RequestInit) => unknown, number?][]) {
  const calls: { url: string; body?: unknown }[] = [];
  const fetcher = (async (url: string, init?: RequestInit) => {
    calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const route = routes.find(([match]) => url.includes(match));
    if (!route) return new Response('not found', { status: 404 });
    return new Response(JSON.stringify(route[1](init)), { status: route[2] ?? 200 });
  }) as unknown as Fetch;
  return { fetcher, calls };
}

describe('parseConfig', () => {
  it('names the source and the missing field', () => {
    expect(() => parseConfig('{"sources":[{"type":"libsql","site":"a","url":"x"}]}')).toThrow(
      /sources\[0\] \(libsql\): "query" is required/,
    );
    expect(() => parseConfig('{"sources":[{"type":"mysql"}]}')).toThrow(/type must be one of/);
    expect(() => parseConfig('{"sources":[]}')).toThrow(ExportError);
  });
});

describe('secretResolver', () => {
  it('reads env: and pulls each vault once', () => {
    const pulled: string[] = [];
    const resolve = secretResolver(
      { TOKEN: 't' },
      { team: 'acme', pull: (t) => (pulled.push(`${t.team}/${t.project}/${t.env}`), { A: '1', B: '2' }) },
    );
    expect(resolve('env:TOKEN', 'x')).toBe('t');
    expect(resolve('vault:app/prod/A', 'x')).toBe('1');
    expect(resolve('vault:app/prod/B', 'x')).toBe('2');
    expect(resolve('vault:other/app/prod/A', 'x')).toBe('1');
    expect(resolve('plain', 'x')).toBe('plain');
    expect(pulled).toEqual(['acme/app/prod', 'other/app/prod']);
  });

  it('fails loudly on a missing variable or key', () => {
    const resolve = secretResolver({}, { pull: () => ({}) });
    expect(() => resolve('env:NOPE', 'src')).toThrow(/NOPE is not set/);
    expect(() => resolve('vault:app/prod/NOPE', 'src')).toThrow(/NOPE is not in vault/);
  });
});

describe('csv', () => {
  it('quotes only what needs it', () => {
    expect(csvField('plain')).toBe('plain');
    expect(csvField('Doe, Jane')).toBe('"Doe, Jane"');
    expect(csvField('say "hi"')).toBe('"say ""hi"""');
    expect(csvField('a\nb')).toBe('"a\nb"');
    expect(toCsv([{ site: 's', name: 'n', email: 'e', last_login: '' }], { withSource: true, sources: ['x'] })).toBe(
      'site,name,email,last_login,source\ns,n,e,,x\n',
    );
  });
});

describe('readSupabaseManagement', () => {
  it('queries each wanted project read-only and maps names to sites', async () => {
    const { fetcher, calls } = fakeFetch([
      ['/database/query', () => [{ name: 'Ann', email: 'a@x', last_login: '2026-01-01T00:00:00Z' }]],
      [
        '/v1/projects',
        () => [
          { id: 'r1', name: 'app', status: 'ACTIVE_HEALTHY' },
          { id: 'r2', name: 'skip', status: 'ACTIVE_HEALTHY' },
          { id: 'r3', name: 'paused', status: 'INACTIVE' },
        ],
      ],
    ]);
    const results = await readSupabaseManagement(
      { type: 'supabase-management', token: 't', exclude: ['skip'], sites: { app: 'app.com' } },
      literal,
      fetcher,
    );
    expect(results.map((r) => [r.site, r.rows.length, r.error])).toEqual([
      ['app.com', 1, undefined],
      ['paused', 0, 'project is INACTIVE'],
    ]);
    const query = calls.find((c) => c.url.includes('/r1/'))!;
    expect(query.body).toMatchObject({ read_only: true });
  });

  it('filters by --only on the site label', async () => {
    const { fetcher, calls } = fakeFetch([
      ['/database/query', () => []],
      ['/v1/projects', () => [{ id: 'r1', name: 'a' }, { id: 'r2', name: 'b' }]],
    ]);
    await readSupabaseManagement({ type: 'supabase-management', token: 't' }, literal, fetcher, { only: ['b'] });
    expect(calls.filter((c) => c.url.includes('/database/query')).map((c) => c.url)).toEqual([
      'https://api.supabase.com/v1/projects/r2/database/query',
    ]);
  });
});

describe('readSupabaseAuth', () => {
  it('pages until a short page', async () => {
    const page = (n: number) => Array.from({ length: n }, (_, i) => ({ email: `u${i}@x`, user_metadata: { name: `U${i}` } }));
    const { fetcher, calls } = fakeFetch([
      ['page=1&', () => ({ users: page(2) })],
      ['page=2&', () => ({ users: page(1) })],
    ]);
    const rows = await readSupabaseAuth({ type: 'supabase-auth', site: 's', url: 'https://h/', serviceKey: 'k' }, literal, fetcher, 2);
    expect(rows).toHaveLength(3);
    expect(rows[0]).toEqual({ site: 's', name: 'U0', email: 'u0@x', last_login: '' });
    expect(calls[0]!.url).toBe('https://h/auth/v1/admin/users?page=1&per_page=2');
  });
});

describe('readLibsql', () => {
  it('turns a Hrana result into rows', async () => {
    const { fetcher, calls } = fakeFetch([
      [
        '/v2/pipeline',
        () => ({
          results: [
            {
              type: 'ok',
              response: {
                result: {
                  cols: [{ name: 'name' }, { name: 'email' }, { name: 'last_login' }],
                  rows: [[{ type: 'text', value: 'Bo' }, { type: 'text', value: 'b@x' }, { type: 'null' }]],
                },
              },
            },
            { type: 'ok' },
          ],
        }),
      ],
    ]);
    const rows = await readLibsql({ type: 'libsql', site: 't', url: 'libsql://db.turso.io', token: 'k', query: 'select 1' }, literal, fetcher);
    expect(rows).toEqual([{ site: 't', name: 'Bo', email: 'b@x', last_login: '' }]);
    expect(calls[0]!.url).toBe('https://db.turso.io/v2/pipeline');
  });

  it('surfaces the SQL error', async () => {
    const { fetcher } = fakeFetch([['/v2/pipeline', () => ({ results: [{ type: 'error', error: { message: 'no such table: users' } }] })]]);
    await expect(readLibsql({ type: 'libsql', site: 't', url: 'https://x', query: 'q' }, literal, fetcher)).rejects.toThrow(/no such table/);
  });

  it('maps url schemes', () => {
    expect(libsqlHttpUrl('libsql://a.turso.io/')).toBe('https://a.turso.io');
    expect(libsqlHttpUrl('ws://localhost:8080')).toBe('http://localhost:8080');
  });
});

describe('readSqlite', () => {
  it('reads a file read-only', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'user-export-'));
    try {
      const path = join(dir, 'u.db');
      const db = new DatabaseSync(path);
      db.exec("create table users (username text, email text, seen text); insert into users values ('cy', 'c@x', '2026-02-02')");
      db.close();
      const rows = await readSqlite(
        { type: 'sqlite', site: 'f', path, query: 'select username as name, email, seen as last_login from users' },
        literal,
      );
      expect(rows).toEqual([{ site: 'f', name: 'cy', email: 'c@x', last_login: '2026-02-02' }]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('exportUsers', () => {
  it('keeps going when one source fails', async () => {
    const { fetcher } = fakeFetch([['/auth/v1/admin/users', () => ({ users: [{ email: 'ok@x' }] })]]);
    const results = await exportUsers(
      {
        sources: [
          { type: 'libsql', site: 'dead', url: 'env:MISSING', query: 'q' },
          { type: 'supabase-auth', site: 'live', url: 'https://h', serviceKey: 'k' },
        ],
      },
      literal,
      { fetcher },
    );
    expect(results.map((r) => [r.site, r.rows.length, Boolean(r.error)])).toEqual([
      ['dead', 0, true],
      ['live', 1, false],
    ]);
  });
});
