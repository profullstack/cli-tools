import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { describe, expect, it } from 'vitest';

import {
  ExportError,
  csvField,
  exportUsers,
  isoTime,
  libsqlHttpUrl,
  parseConfig,
  parseCsv,
  parseRows,
  remotePostgresCommand,
  shq,
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

describe('cmd: references', () => {
  it('runs each command once and trims its output', () => {
    const ran: string[] = [];
    const resolve = secretResolver({}, { run: (c) => (ran.push(c), { status: 0, stdout: ' tok\n', stderr: '' }) });
    expect(resolve('cmd:get-token', 'x')).toBe('tok');
    expect(resolve('cmd:get-token', 'x')).toBe('tok');
    expect(ran).toEqual(['get-token']);
  });

  it('refuses a failed or silent command without echoing its stderr', () => {
    const resolve = secretResolver({}, { run: () => ({ status: 1, stdout: '', stderr: 'secret=abc' }) });
    expect(() => resolve('cmd:nope', 'src')).toThrow(/exited 1 with no output/);
    expect(() => resolve('cmd:nope', 'src')).not.toThrow(/abc/);
  });
});

describe('isoTime', () => {
  it('normalizes every shape a database hands back', () => {
    expect(isoTime('2026-09-24T01:02:03.456789+00:00')).toBe('2026-09-24T01:02:03Z');
    expect(isoTime('2026-09-24 01:02:03')).toBe('2026-09-24T01:02:03Z');
    expect(isoTime('2026-09-24 01:02:03.5-07')).toBe('2026-09-24T08:02:03Z');
    expect(isoTime(1700000000)).toBe('2023-11-14T22:13:20Z');
    expect(isoTime('1700000000000')).toBe('2023-11-14T22:13:20Z');
    expect(isoTime(new Date(0))).toBe('1970-01-01T00:00:00Z');
    expect(isoTime(null)).toBe('');
    expect(isoTime('last week')).toBe('last week');
  });
});

describe('parseRows', () => {
  it('reads a JSON array or a CSV with a header', () => {
    expect(parseRows('s', '[{"name":"A","email":"a@x","last_login":null}]')).toEqual([
      { site: 's', name: 'A', email: 'a@x', last_login: '' },
    ]);
    expect(parseRows('s', 'email,name,last_login\r\nb@x,"Doe, ""B""",2026\n')).toEqual([
      { site: 's', name: 'Doe, "B"', email: 'b@x', last_login: '2026' },
    ]);
    expect(parseCsv('a,"x\ny"\n')).toEqual([['a', 'x\ny']]);
    expect(parseRows('s', '  ')).toEqual([]);
  });
});

describe('via', () => {
  it('quotes for a POSIX shell', () => {
    expect(shq("it's")).toBe(`'it'\\''s'`);
  });

  it('reads SQLite through a remote shell, end to end', async () => {
    const dir = mkdtempSync(join(tmpdir(), "user-export-it's-"));
    try {
      const path = join(dir, 'u.db');
      const db = new DatabaseSync(path);
      db.exec("create table users (name text, email text, seen integer); insert into users values ('Dee', 'd@x', 1700000000)");
      db.close();
      // `sh -c` stands in for `ssh host`: same contract, one shell command.
      const rows = await readSqlite(
        { type: 'sqlite', site: 'r', via: 'sh -c', path, query: "select name, email, seen as last_login from users where name != 'x'" },
        literal,
      );
      expect(rows).toEqual([{ site: 'r', name: 'Dee', email: 'd@x', last_login: '2023-11-14T22:13:20Z' }]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('wraps a Postgres query as one read-only JSON value', () => {
    const command = remotePostgresCommand('select 1', 'postgresql:///db');
    expect(command).toContain("default_transaction_read_only=on");
    expect(command).toContain("'postgresql:///db'");
    const encoded = command.match(/echo (\S+) \|/)![1]!;
    expect(Buffer.from(encoded, 'base64').toString()).toBe(
      "select coalesce(json_agg(t), '[]'::json) from (select 1) t",
    );
  });

  it('runs an exec source and reports a failing one', async () => {
    const ok = await exportUsers(
      { sources: [{ type: 'exec', site: 'e', command: "printf 'name,email,last_login\\nE,e@x,\\n'" }, { type: 'exec', site: 'bad', command: 'echo boom >&2; exit 4' }] },
      literal,
    );
    expect(ok[0]!.rows).toEqual([{ site: 'e', name: 'E', email: 'e@x', last_login: '' }]);
    expect(ok[1]!.error).toMatch(/exited 4: boom/);
  });

  it('requires url for postgres only without via', () => {
    expect(() => parseConfig('{"sources":[{"type":"postgres","site":"p","query":"q"}]}')).toThrow(/unless "via"/);
    expect(parseConfig('{"sources":[{"type":"postgres","site":"p","query":"q","via":"ssh h"}]}').sources).toHaveLength(1);
  });
});
