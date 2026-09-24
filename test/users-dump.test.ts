import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { afterEach, describe, expect, it } from 'vitest';

import {
  type UserRow,
  dedupe,
  discoverSources,
  isPublicHost,
  mergeSources,
  normalizeTime,
  planUserQueries,
  readDb,
  shellQuote,
  siteFromProject,
  sqliteDb,
  supabaseRef,
  supabaseUsersSql,
  toCsv,
} from '../src/users-dump.ts';

const row = (over: Partial<UserRow>): UserRow => ({
  name: '',
  email: 'a@x.com',
  site: 's',
  last_login: '',
  created_at: '',
  source: 't',
  ...over,
});

describe('siteFromProject', () => {
  it('turns a trailing tld segment into a dot', () => {
    expect(siteFromProject('outreachgraph-com')).toBe('outreachgraph.com');
    expect(siteFromProject('tronbrowsers-dev')).toBe('tronbrowsers.dev');
    expect(siteFromProject('ugig-net')).toBe('ugig.net');
  });
  it('drops -web and leaves plain slugs alone', () => {
    expect(siteFromProject('bufferoverride-web')).toBe('bufferoverride');
    expect(siteFromProject('saasrow-web')).toBe('saasrow');
    expect(siteFromProject('moshcode-apps-pwa')).toBe('moshcode-apps-pwa');
  });
});

describe('normalizeTime', () => {
  it('reads a zoneless SQLite stamp as UTC', () => {
    expect(normalizeTime('2026-09-01 12:00:00')).toBe('2026-09-01T12:00:00.000Z');
  });
  it('tells epoch seconds from milliseconds', () => {
    expect(normalizeTime(1_788_264_000)).toBe('2026-09-01T12:00:00.000Z');
    expect(normalizeTime('1788264000000')).toBe('2026-09-01T12:00:00.000Z');
  });
  it('keeps an explicit offset', () => {
    expect(normalizeTime('2026-09-01T05:00:00-07:00')).toBe('2026-09-01T12:00:00.000Z');
  });
  it('is empty for nothing or nonsense', () => {
    expect(normalizeTime(null)).toBe('');
    expect(normalizeTime('')).toBe('');
    expect(normalizeTime('never')).toBe('');
    expect(normalizeTime(0)).toBe('');
  });
});

describe('toCsv', () => {
  it('quotes commas, quotes and newlines only', () => {
    const csv = toCsv([row({ name: 'Ettinger, "Tony"', email: 'a@x.com', site: 'x.com' })]);
    expect(csv).toBe('name,email,site,last_login,created_at,source\n"Ettinger, ""Tony""",a@x.com,x.com,,,t\n');
  });
});

describe('dedupe', () => {
  it('merges one address per site, keeping the newest login and a name', () => {
    const out = dedupe([
      row({ email: 'A@x.com', last_login: '2026-01-01T00:00:00.000Z', created_at: '2025-05-01T00:00:00.000Z' }),
      row({ email: 'a@x.com', name: 'Ann', last_login: '2026-03-01T00:00:00.000Z', created_at: '2025-01-01T00:00:00.000Z' }),
      row({ email: 'a@x.com', site: 'other' }),
    ]);
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ name: 'Ann', last_login: '2026-03-01T00:00:00.000Z', created_at: '2025-01-01T00:00:00.000Z' });
  });
});

describe('discoverSources', () => {
  it('pairs each libsql URL with its token, whatever the prefix', () => {
    expect(
      discoverSources('tsbb', {
        TSBB_DATABASE_URL: 'libsql://tsbb.turso.io',
        TSBB_DATABASE_AUTH_TOKEN: 't',
        OTHER_AUTH_TOKEN: 'no:t',
      }),
    ).toEqual([{ site: 'tsbb', kind: 'libsql', vault: 'tsbb', url: 'TSBB_DATABASE_URL', token: 'TSBB_DATABASE_AUTH_TOKEN' }]);

    const [entry] = discoverSources('ringhuman-com', {
      TURSO_DATABASE_URL: 'libsql://r.turso.io',
      TURSO_AUTH_TOKEN: 't',
      AAA_AUTH_TOKEN: 'wrong',
    });
    expect(entry?.token).toBe('TURSO_AUTH_TOKEN');
  });

  it('skips hosted Supabase the management token already reads', () => {
    const env = {
      NEXT_PUBLIC_SUPABASE_URL: 'https://ojgvudxovrbdikzyoeex.supabase.co',
      SUPABASE_SERVICE_ROLE_KEY: 'k',
      DATABASE_URL: 'postgresql://postgres:p@db.ojgvudxovrbdikzyoeex.supabase.co:5432/postgres',
    };
    expect(discoverSources('ugig-net', env, new Set(['ojgvudxovrbdikzyoeex']))).toEqual([]);
    expect(discoverSources('ugig-net', env)).toEqual([
      { site: 'ugig.net', kind: 'gotrue', vault: 'ugig-net', url: 'NEXT_PUBLIC_SUPABASE_URL', token: 'SUPABASE_SERVICE_ROLE_KEY' },
    ]);
  });

  it('prefers a public Postgres URL over the private one', () => {
    expect(
      discoverSources('nixamp', {
        DATABASE_URL: 'postgresql://u:p@postgres.railway.internal:5432/railway',
        DATABASE_PUBLIC_URL: 'postgresql://u:p@x.proxy.rlwy.net:1234/railway',
      }),
    ).toEqual([{ site: 'nixamp', kind: 'postgres', vault: 'nixamp', url: 'DATABASE_PUBLIC_URL' }]);
  });

  it('finds SQLite Cloud and self-hosted Supabase', () => {
    expect(
      discoverSources('uyunlist', {
        SQLITE_CLOUD_URL: 'sqlitecloud://h.sqlite.cloud:8860/x.db?apikey=k',
        SUPABASE_URL: 'https://api.uyunlist.com',
        SERVICE_ROLE_KEY: 'k',
      }).map((e) => e.kind),
    ).toEqual(['sqlitecloud', 'gotrue']);
  });
});

describe('helpers', () => {
  it('supabaseRef only matches hosted projects', () => {
    expect(supabaseRef('https://ojgvudxovrbdikzyoeex.supabase.co')).toBe('ojgvudxovrbdikzyoeex');
    expect(supabaseRef('https://api.smshub.dev')).toBeNull();
  });
  it('isPublicHost rejects docker and railway-internal names', () => {
    expect(isPublicHost('postgresql://u@postgres.railway.internal/db')).toBe(false);
    expect(isPublicHost('postgresql://u@db:5432/db')).toBe(false);
    expect(isPublicHost('postgresql://u@x.proxy.rlwy.net:1/db')).toBe(true);
  });
  it('shellQuote survives a single quote', () => {
    expect(shellQuote("it's")).toBe(`'it'\\''s'`);
  });
});

describe('mergeSources', () => {
  it('keeps hand edits and hand-added entries across a re-discover', () => {
    const existing = [
      { site: 'Tipoff', kind: 'libsql' as const, vault: 'tsbb', url: 'TSBB_DATABASE_URL', skip: true },
      { site: 'box', kind: 'sqlite' as const, path: '/srv/x.db', ssh: 'vienna' },
      { site: 'gone', kind: 'libsql' as const, vault: 'gone', url: 'TURSO_DATABASE_URL' },
    ];
    const merged = mergeSources(existing, [
      { site: 'tsbb', kind: 'libsql', vault: 'tsbb', url: 'TSBB_DATABASE_URL', token: 'T' },
    ]);
    expect(merged).toEqual([
      { site: 'box', kind: 'sqlite', path: '/srv/x.db', ssh: 'vienna' },
      { site: 'Tipoff', kind: 'libsql', vault: 'tsbb', url: 'TSBB_DATABASE_URL', token: 'T', skip: true },
    ]);
  });
});

describe('planUserQueries', () => {
  it('finds nothing when no table has an email', () => {
    expect(planUserQueries([{ name: 'blog_posts', columns: ['id', 'title'] }])).toEqual([]);
  });

  it('uses a session table for the last login when the users table has none', () => {
    const [plan] = planUserQueries([
      { name: 'users', columns: ['id', 'email', 'created_at'] },
      { name: 'sessions', columns: ['id', 'user_id', 'created_at', 'last_seen_at'] },
    ]);
    expect(plan?.sql).toContain('(SELECT MAX(COALESCE(s."last_seen_at", s."created_at")) FROM "sessions" s WHERE s."user_id" = u."id")');
  });

  it('links actors to sessions by actor_id', () => {
    const [plan] = planUserQueries([
      { name: 'actors', columns: ['id', 'username', 'display_name', 'email', 'created_at'] },
      { name: 'sessions', columns: ['id', 'actor_id', 'created_at', 'last_seen_at'] },
    ]);
    expect(plan?.sql).toContain('u."display_name" AS name');
    expect(plan?.sql).toContain('s."actor_id" = u."id"');
  });
});

describe('supabaseUsersSql', () => {
  it('falls back to the profile table name and a typed last_active_at', () => {
    const sql = supabaseUsersSql([
      { t: 'profiles', c: 'id', type: 'uuid' },
      { t: 'profiles', c: 'full_name', type: 'text' },
      { t: 'profiles', c: 'last_active_at', type: 'timestamp with time zone' },
      { t: 'users', c: 'id', type: 'uuid' },
      { t: 'users', c: 'last_seen', type: 'text' },
    ]);
    expect(sql).toContain(`(SELECT NULLIF(p."full_name"::text, '') FROM public."profiles" p WHERE p."id"::text = u.id::text LIMIT 1)`);
    expect(sql).toContain('GREATEST((SELECT MAX(p."last_active_at")');
    // A text column never reaches GREATEST, where it would break the whole query.
    expect(sql).not.toContain('"last_seen"');
  });

  it('is metadata-only when the app has no profile table', () => {
    const sql = supabaseUsersSql([]);
    expect(sql).toContain('NULL AS last_session');
    expect(sql).not.toContain('public.');
  });

  it('balances its parentheses either way', () => {
    // An unclosed COALESCE once sent a syntax error to every project at once.
    for (const sql of [supabaseUsersSql([]), supabaseUsersSql([{ t: 'profiles', c: 'id' }, { t: 'profiles', c: 'name' }])]) {
      expect(sql.split('(').length).toBe(sql.split(')').length);
    }
  });
});

describe('readDb on a real SQLite file', () => {
  let dir = '';
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('reads users and accounts, with session-derived logins', async () => {
    dir = mkdtempSync(join(tmpdir(), 'users-dump-test-'));
    const path = join(dir, 'app.db');
    const setup = new DatabaseSync(path);
    setup.exec(`
      CREATE TABLE users (id TEXT, email TEXT, name TEXT, created_at TEXT);
      CREATE TABLE sessions (token TEXT, user_id TEXT, created_at INTEGER);
      CREATE TABLE accounts (id TEXT, email TEXT, created_at TEXT);
      CREATE TABLE signups (id TEXT, email TEXT);
      INSERT INTO users VALUES ('u1', 'ann@x.com', 'Ann', '2026-01-01 00:00:00'), ('u2', 'bob@x.com', NULL, NULL);
      INSERT INTO sessions VALUES ('t1', 'u1', 1788264000), ('t2', 'u1', 1780000000);
      INSERT INTO accounts VALUES ('a1', 'cy@x.com', '2026-02-02T00:00:00Z');
      INSERT INTO signups VALUES ('s1', 'waitlist@x.com');
    `);
    setup.close();

    const db = await sqliteDb(path);
    const rows = await readDb(db, 'app.com', 'sqlite');
    await db.close();

    expect(rows.map((r) => r.email).sort()).toEqual(['ann@x.com', 'bob@x.com', 'cy@x.com']);
    expect(rows.find((r) => r.email === 'ann@x.com')).toMatchObject({
      name: 'Ann',
      last_login: '2026-09-01T12:00:00.000Z',
      created_at: '2026-01-01T00:00:00.000Z',
      source: 'sqlite:users',
    });
  });
});
