import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  type DomainInfo,
  type DomainResolver,
  checkSyntax,
  cleanEmails,
  cleanText,
  formatReport,
  isDisposable,
  isRole,
  isUnlikely,
  limitedResolver,
  normalizeForDuplicates,
  parseInput,
  splitAddress,
  suggestDomain,
  vendoredDisposableDomains,
} from '../src/email-cleaner.ts';

const OK: DomainInfo = { exists: true, mx: true, apex: true, www: true };

/** A resolver that answers from a table; anything unlisted is a healthy domain. */
function stub(table: Record<string, DomainInfo> = {}): DomainResolver & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async check(domain) {
      calls.push(domain);
      return table[domain] ?? OK;
    },
  };
}

const DNS = {
  'nxdomain.dev': { exists: false, mx: false, apex: false, www: false },
  'nomail.dev': { exists: true, mx: false, apex: false, www: false },
  'aonly.dev': { exists: true, mx: false, apex: true, www: false },
  'mailonly.dev': { exists: true, mx: true, apex: false, www: false },
  'wwwonly.dev': { exists: true, mx: true, apex: false, www: true },
  'flaky.dev': { exists: null, mx: null, apex: null, www: null, error: 'ETIMEOUT' },
} satisfies Record<string, DomainInfo>;

describe('address parsing', () => {
  it('splits Name <addr>, quoted names and mailto:', () => {
    expect(splitAddress('Jane Doe <jane@x.com>')).toEqual({ email: 'jane@x.com', name: 'Jane Doe' });
    expect(splitAddress('"Doe, Jane" <jane@x.com>')).toEqual({ email: 'jane@x.com', name: 'Doe, Jane' });
    expect(splitAddress('<jane@x.com>')).toEqual({ email: 'jane@x.com' });
    expect(splitAddress('mailto:jane@x.com')).toEqual({ email: 'jane@x.com' });
  });

  it('accepts real addresses and rejects broken ones', () => {
    expect(checkSyntax('Jane.Doe+tag@Example.CO.uk')).toEqual({ local: 'Jane.Doe+tag', domain: 'example.co.uk' });
    expect(checkSyntax('user@bücher.de')?.domain).toBe('xn--bcher-kva.de');
    for (const bad of ['plain', '@x.com', 'a@', 'a@b', 'a..b@x.com', '.a@x.com', 'a@-x.com', 'a b@x.com', 'a@x.c0m', 'a@x..com']) {
      expect(checkSyntax(bad), bad).toBeNull();
    }
  });
});

describe('classifiers', () => {
  it('knows role accounts, with separators ignored', () => {
    for (const r of ['info', 'Support', 'no-reply', 'no_reply', 'admin+x', 'postmaster']) expect(isRole(r), r).toBe(true);
    expect(isRole('jane')).toBe(false);
  });

  it('knows unlikely addresses', () => {
    expect(isUnlikely('nothanks', 'gmail.com')).toBe(true);
    expect(isUnlikely('test', 'test.com')).toBe(true);
    expect(isUnlikely('asdfjkl', 'gmail.com')).toBe(true);
    expect(isUnlikely('jane', 'example.com')).toBe(true);
    expect(isUnlikely('jane', 'corp.invalid')).toBe(true);
    expect(isUnlikely('jane', 'box.localhost')).toBe(true);
    expect(isUnlikely('jane', 'gmail.com')).toBe(false);
  });

  it('matches disposable domains and their subdomains', () => {
    const list = vendoredDisposableDomains();
    expect(list.size).toBeGreaterThan(1000);
    expect(isDisposable('mailinator.com', list)).toBe(true);
    expect(isDisposable('mx.mailinator.com', list)).toBe(true);
    expect(isDisposable('gmail.com', list)).toBe(false);
  });

  it('suggests provider typos but leaves real neighbours alone', () => {
    expect(suggestDomain('gmial.com')).toBe('gmail.com');
    expect(suggestDomain('hotmial.com')).toBe('hotmail.com');
    expect(suggestDomain('yaho.com')).toBe('yahoo.com');
    expect(suggestDomain('outlok.com')).toBe('outlook.com');
    expect(suggestDomain('icloud.co')).toBe('icloud.com');
    expect(suggestDomain('gmail.con')).toBe('gmail.com');
    expect(suggestDomain('gmaik.com')).toBe('gmail.com');
    for (const real of ['gmail.com', 'email.com', 'ymail.com', 'mail.com', 'yahoo.co.uk', 'hotmail.fr', 'acme.com']) {
      expect(suggestDomain(real), real).toBeUndefined();
    }
  });

  it('normalizes duplicates: gmail drops dots and tags, others only tags', () => {
    expect(normalizeForDuplicates('Jane.Doe+news@GMail.com')).toBe('janedoe@gmail.com');
    expect(normalizeForDuplicates('jane.doe@googlemail.com')).toBe('janedoe@gmail.com');
    expect(normalizeForDuplicates('Jane.Doe+news@corp.com')).toBe('jane.doe@corp.com');
  });
});

describe('cleanEmails', () => {
  it('rejects for every reason, and keeps the rest in order', async () => {
    const r = await cleanEmails(
      [
        'ok@good.dev',
        'broken@',
        'jane@gmial.com',
        'a@nxdomain.dev',
        'a@nomail.dev',
        'a@mailonly.dev',
        'info@good.dev',
        'a@mailinator.com',
        'OK@good.dev',
        'nothanks@good.dev',
        'a@aonly.dev',
        'a@wwwonly.dev',
      ],
      { resolver: stub(DNS) },
    );
    expect(r.valid.map((v) => v.email)).toEqual(['ok@good.dev', 'a@aonly.dev', 'a@wwwonly.dev']);
    expect(Object.fromEntries(r.invalid.map((i) => [i.email, i.reasons]))).toEqual({
      'broken@': ['syntax'],
      'jane@gmial.com': expect.arrayContaining(['typo']),
      'a@nxdomain.dev': ['no-domain'],
      'a@nomail.dev': ['no-mx'],
      'a@mailonly.dev': ['no-website'],
      'info@good.dev': ['role'],
      'a@mailinator.com': ['disposable'],
      'OK@good.dev': ['duplicate'],
      'nothanks@good.dev': ['unlikely'],
    });
    expect(r.invalid.find((i) => i.email === 'jane@gmial.com')?.suggestion).toBe('jane@gmail.com');
    expect(r.stats).toMatchObject({ total: 12, valid: 3, invalid: 9 });
    expect(r.stats.byReason['no-mx']).toBe(1);
    expect(r.stats.topDomains[0]).toEqual(['good.dev', 4]);
  });

  it('allow flags keep what they name, and nothing else', async () => {
    const input = ['info@good.dev', 'a@mailinator.com', 'x@good.dev', 'X@good.dev', 'test@test.com', 'a@mailonly.dev', 'a@nomail.dev'];
    const r = await cleanEmails(input, {
      resolver: stub(DNS),
      allowRole: true,
      allowDisposable: true,
      allowDuplicates: true,
      allowUnlikely: true,
      allowNoWebsite: true,
    });
    expect(r.invalid.map((i) => [i.email, i.reasons])).toEqual([['a@nomail.dev', ['no-mx']]]);
    expect(r.special).toMatchObject({ role: 1, disposable: 1, duplicate: 1, unlikely: 1, 'no-website': 1 });
  });

  it('treats gmail dot and +tag variants as the same person, first wins', async () => {
    const r = await cleanEmails(
      ['Jane <jane.doe@gmail.com>', 'janedoe@gmail.com', 'jane.doe+list@googlemail.com', 'j.d+a@corp.dev', 'j.d+b@corp.dev', 'jd@corp.dev'],
      { dns: false },
    );
    expect(r.valid.map((v) => v.input)).toEqual(['Jane <jane.doe@gmail.com>', 'j.d+a@corp.dev', 'jd@corp.dev']);
    expect(r.invalid.every((i) => i.reasons.includes('duplicate'))).toBe(true);
  });

  it('fixes typos when asked, logs it, and checks the corrected address', async () => {
    const resolver = stub();
    const r = await cleanEmails(['Jane <jane@gmial.com>', 'jane@gmail.com'], { resolver, fixTypos: true });
    expect(r.valid).toEqual([{ input: 'Jane <jane@gmail.com>', email: 'jane@gmail.com', name: 'Jane' }]);
    expect(r.invalid[0]?.reasons).toEqual(['duplicate']);
    expect(r.log.some((l) => l.message.includes('typo fixed: jane@gmial.com -> jane@gmail.com'))).toBe(true);
    expect(resolver.calls).toEqual(['gmail.com']);
  });

  it('never rejects on a DNS non-answer, and --no-dns makes no lookups', async () => {
    const r = await cleanEmails(['a@flaky.dev'], { resolver: stub(DNS) });
    expect(r.valid).toHaveLength(1);
    expect(r.log[0]?.message).toContain('ETIMEOUT');

    const resolver = stub(DNS);
    const off = await cleanEmails(['a@nxdomain.dev'], { resolver, dns: false });
    expect(off.valid).toHaveLength(1);
    expect(resolver.calls).toEqual([]);
  });

  it('adds extra disposable domains', async () => {
    const r = await cleanEmails(['a@burner.dev'], { dns: false, disposableDomains: ['burner.dev'] });
    expect(r.invalid[0]?.reasons).toEqual(['disposable']);
  });

  it('looks each domain up once, with bounded concurrency', async () => {
    let active = 0;
    let peak = 0;
    const calls: string[] = [];
    const slow: DomainResolver = {
      async check(domain) {
        calls.push(domain);
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((r) => setTimeout(r, 5));
        active -= 1;
        return OK;
      },
    };
    const resolver = limitedResolver(slow, 3);
    const domains = Array.from({ length: 10 }, (_, i) => `d${i}.dev`);
    await Promise.all([...domains, ...domains].map((d) => resolver.check(d)));
    expect(calls.sort()).toEqual([...domains].sort());
    expect(peak).toBeLessThanOrEqual(3);
  });
});

describe('formats', () => {
  it('keeps the separator and Name <addr> of a list', async () => {
    const text = 'Jane <jane@good.dev>, info@good.dev, "Doe, J" <j@good.dev>';
    const { output, parsed } = await cleanText(text, { resolver: stub() });
    expect(parsed.kind).toBe('list');
    expect(output).toBe('Jane <jane@good.dev>, "Doe, J" <j@good.dev>');
  });

  it('keeps newline and semicolon lists as they were', async () => {
    expect((await cleanText('a@good.dev\ninfo@good.dev\nb@good.dev\n', { dns: false })).output).toBe('a@good.dev\nb@good.dev\n');
    expect((await cleanText('a@good.dev;b@good.dev;sales@good.dev', { dns: false })).output).toBe('a@good.dev;b@good.dev');
    expect((await cleanText('a@good.dev\r\nb@good.dev\r\n', { dns: false })).output).toBe('a@good.dev\r\nb@good.dev\r\n');
  });

  it('passes CSV rows through untouched, with the header', async () => {
    const text = 'id,Name,E-mail,notes\n1,Jane,jane@good.dev,"likes, commas"\n2,Info,info@good.dev,x\n3,"Doe, J",j@good.dev,"multi\nline"\n';
    const { output, rejected, result, parsed } = await cleanText(text, { dns: false });
    expect(parsed.kind).toBe('csv');
    expect(output).toBe('id,Name,E-mail,notes\n1,Jane,jane@good.dev,"likes, commas"\n3,"Doe, J",j@good.dev,"multi\nline"\n');
    expect(rejected).toBe('id,Name,E-mail,notes\n2,Info,info@good.dev,x\n');
    expect(result.valid[0]?.row).toEqual({ id: '1', Name: 'Jane', 'E-mail': 'jane@good.dev', notes: 'likes, commas' });
  });

  it('rewrites only the email cell of a CSV row when fixing a typo', async () => {
    const { output } = await cleanText('email,name\njane@gmial.com,"Jane, D"\n', { dns: false, fixTypos: true });
    expect(output).toBe('email,name\njane@gmail.com,"Jane, D"\n');
  });

  it('detects semicolon CSV and a single email column', async () => {
    const semi = parseInput('name;mail\nJane;jane@good.dev\n');
    expect(semi.kind === 'csv' && semi.delimiter).toBe(';');
    expect((await cleanText('email\na@good.dev\na@good.dev\n', { dns: false })).output).toBe('email\na@good.dev\n');
  });

  it('prints the json shape', async () => {
    const { output } = await cleanText('Jane <jane@good.dev>\ninfo@gmial.com\n', { dns: false, format: 'json' });
    const json = JSON.parse(output);
    expect(json.valid).toEqual([{ input: 'Jane <jane@good.dev>', email: 'jane@good.dev', name: 'Jane' }]);
    expect(json.invalid).toEqual([{ input: 'info@gmial.com', email: 'info@gmial.com', reasons: ['typo', 'role', 'disposable'], suggestion: 'info@gmail.com' }]);
    expect(json.stats).toEqual({
      total: 2, valid: 1, invalid: 1,
      byReason: { typo: 1, role: 1, disposable: 1 },
      topDomains: [['gmial.com', 1], ['good.dev', 1]],
    });
  });

  it('turns a list into CSV on request', async () => {
    const { output } = await cleanText('Jane <jane@good.dev>, b@good.dev', { dns: false, format: 'csv' });
    expect(output).toBe('email,name\njane@good.dev,Jane\nb@good.dev,\n');
  });

  it('reports log, chart, special types and top domains', async () => {
    const r = await cleanEmails(['a@good.dev', 'info@good.dev', 'x@mailinator.com'], { dns: false, allowRole: true });
    const report = formatReport(r, { dns: false });
    expect(report).toContain('3 in, 2 valid-looking, 1 invalid-looking (no DNS checks)');
    expect(report).toMatch(/Analysis log[\s\S]*#2 +info@good\.dev +role \(allowed\)/);
    expect(report).toMatch(/Results[\s\S]*disposable +1 +#+/);
    expect(report).toMatch(/Special email types[\s\S]*role address +1 +\(allowed\)/);
    expect(report).toMatch(/Top 5 input domains\n +good\.dev +2/);
  });
});

describe('the command', () => {
  const bin = fileURLToPath(new URL('../bin/email-cleaner.ts', import.meta.url));
  const run = (args: string[], input = '') =>
    spawnSync(process.execPath, [bin, ...args], { input, encoding: 'utf8' });

  it('reads stdin, writes the invalid file, exits 0', () => {
    const dir = mkdtempSync(join(tmpdir(), 'email-cleaner-'));
    const invalid = join(dir, 'bad.txt');
    const res = run(['-', '--no-dns', '--invalid', invalid], 'a@good.dev\nadmin@good.dev\n');
    expect(res.status).toBe(0);
    expect(res.stdout).toBe('a@good.dev\n');
    expect(readFileSync(invalid, 'utf8')).toBe('admin@good.dev\n');
  });

  it('reads a file argument', () => {
    const dir = mkdtempSync(join(tmpdir(), 'email-cleaner-'));
    const file = join(dir, 'list.txt');
    writeFileSync(file, 'a@good.dev, b@good.dev');
    expect(run([file, '--no-dns']).stdout).toBe('a@good.dev, b@good.dev');
  });

  it('exits 2 on bad usage and unreadable input', () => {
    expect(run(['--format', 'xml', '--no-dns']).status).toBe(2);
    expect(run(['/nonexistent/list.txt', '--no-dns']).status).toBe(2);
    expect(run(['--bogus']).status).toBe(2);
  });
});
