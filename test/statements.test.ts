import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { type Server, createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { parseImported } from '../bin/statements.ts';
import {
  type Account,
  type Institution,
  type ManifestEntry,
  candidateKey,
  claimSetupToken,
  coinpayAccountFor,
  coinpayImportArgs,
  decodeSetupToken,
  fileStatement,
  findDates,
  groupInstitutions,
  institutionKey,
  isSignInUrl,
  lastFour,
  loadManifest,
  matchAccount,
  parseCoinpayAccounts,
  parseSimplefinAccounts,
  periodOf,
  splitAccessUrl,
  startUrls,
} from '../src/statements.ts';
import { fetchInstitution, openBrowser } from '../src/statements-run.ts';
import { findChrome } from '../src/wcag.ts';

const PDF = (marker: string): Buffer => Buffer.from(`%PDF-1.4\n% ${marker}\n1 0 obj << >> endobj\ntrailer << >>\n%%EOF\n`, 'latin1');

function acct(id: string, name: string, institution = 'chase'): Account {
  return { id, name, last4: lastFour(name), institution, institutionName: 'Chase', url: 'https://www.chase.com', externalId: id, coinpayId: null };
}

describe('accounts', () => {
  it('reads the last four digits however the bank writes them', () => {
    expect(lastFour('SAPPHIRE PREFERRED (6496)')).toBe('6496');
    expect(lastFour('TOTAL CHECKING ...1234')).toBe('1234');
    expect(lastFour('Visa x9876 Rewards')).toBe('9876');
    expect(lastFour('Apple Card')).toBeNull();
    expect(lastFour('Savings 12345678')).toBe('5678');
    expect(lastFour('Rewards 12 Plus')).toBeNull();
  });

  it('keys an institution by the name its site goes by', () => {
    expect(institutionKey('secure.chase.com', 'Chase')).toBe('chase');
    expect(institutionKey('https://card.apple.com/x', null)).toBe('apple');
    expect(institutionKey('www.barclays.co.uk', null)).toBe('barclays');
    expect(institutionKey(null, 'Bay Federal Credit Union')).toBe('bay-federal-credit-union');
  });

  it('parses SimpleFIN protocol 1 (org per account) and the 2.0 draft (connections)', () => {
    const v1 = parseSimplefinAccounts({
      errors: ['Connection to Citi may need attention'],
      accounts: [
        { id: 'A1', name: 'SAPPHIRE (6496)', org: { domain: 'chase.com', name: 'Chase', 'sfin-url': 'https://x' } },
        { id: 'A2', name: 'Checking 1234', org: { domain: 'chase.com', name: 'Chase' } },
      ],
    });
    expect(v1.errors).toEqual(['Connection to Citi may need attention']);
    expect(groupInstitutions(v1.accounts).map((entry) => [entry.key, entry.accounts.length])).toEqual([['chase', 2]]);

    const v2 = parseSimplefinAccounts({
      connections: [{ conn_id: 'C1', name: 'Citi', org_url: 'https://www.citi.com' }],
      accounts: [{ id: 'B1', name: 'Double Cash 4321', conn_id: 'C1' }],
      errlist: [{ code: 'auth', msg: 'Citi needs re-auth', conn_id: 'C1' }],
    });
    expect(v2.accounts[0]).toMatchObject({ institution: 'citi', institutionName: 'Citi', last4: '4321', url: 'https://www.citi.com' });
    expect(v2.errors).toEqual(['Citi needs re-auth']);
  });

  it('parses coinpay finances accounts --json', () => {
    const [first] = parseCoinpayAccounts({ accounts: [{ id: 'cp-1', name: 'CREDIT CARD (6496)', org_name: 'Chase', org_domain: 'chase.com', external_id: 'A1' }] });
    expect(first).toMatchObject({ id: 'cp-1', coinpayId: 'cp-1', externalId: 'A1', institution: 'chase', last4: '6496' });
    expect(() => parseCoinpayAccounts({ error: 'Not authenticated' })).toThrow(/accounts list/);
  });
});

describe('simplefin', () => {
  it('decodes a setup token to its https claim URL', () => {
    const token = Buffer.from('https://bridge.simplefin.org/simplefin/claim/abc').toString('base64');
    expect(decodeSetupToken(token)).toBe('https://bridge.simplefin.org/simplefin/claim/abc');
    expect(() => decodeSetupToken(Buffer.from('http://evil/claim').toString('base64'))).toThrow(/https/);
    expect(() => decodeSetupToken('not base64 at all!')).toThrow(/setup token/);
  });

  it('moves the access URL credentials into a Basic header', () => {
    const { base, authorization } = splitAccessUrl('https://user:p%40ss@bridge.simplefin.org/simplefin/');
    expect(base).toBe('https://bridge.simplefin.org/simplefin');
    expect(Buffer.from(authorization.replace('Basic ', ''), 'base64').toString()).toBe('user:p@ss');
    expect(() => splitAccessUrl('https://bridge.simplefin.org/simplefin')).toThrow(/credentials/);
  });

  it('claims once with an empty POST and refuses a used token', async () => {
    const token = Buffer.from('https://bridge.example/claim/1').toString('base64');
    const calls: RequestInit[] = [];
    const ok = (async (_url: string, init: RequestInit) => {
      calls.push(init);
      return new Response('https://u:p@bridge.example/simplefin');
    }) as unknown as typeof fetch;
    expect(await claimSetupToken(token, ok)).toBe('https://u:p@bridge.example/simplefin');
    expect(calls[0]).toMatchObject({ method: 'POST' });
    const used = (async () => new Response('', { status: 403 })) as unknown as typeof fetch;
    await expect(claimSetupToken(token, used)).rejects.toThrow(/works once/);
  });
});

describe('dates and periods', () => {
  it('finds dates in every form banks print them', () => {
    expect(findDates('20260815-statements-6496-.pdf')).toEqual([{ date: '2026-08-15', precise: true }]);
    expect(findDates('Statement_Aug_2026_1234.pdf')).toEqual([{ date: '2026-08-01', precise: false }]);
    expect(findDates('Closing Date: Aug 15, 2026')).toEqual([{ date: '2026-08-15', precise: true }]);
    expect(findDates('07/16/26 - 08/15/26').map((entry) => entry.date)).toEqual(['2026-07-16', '2026-08-15']);
    expect(findDates('Statement 2026-08')).toEqual([{ date: '2026-08-01', precise: false }]);
    expect(findDates('13/45/2026')).toEqual([]);
  });

  it('takes the closing month, and the range when one is printed', () => {
    expect(periodOf('Statement period 07/16/2026 - 08/15/2026')).toEqual({ month: '2026-08', from: '2026-07-16', to: '2026-08-15' });
    expect(periodOf('Apple Card Statement - August 2026.pdf')).toEqual({ month: '2026-08', from: null, to: null });
    expect(periodOf(null, '', 'Download 09/14/2026')).toEqual({ month: '2026-09', from: null, to: '2026-09-14' });
    expect(periodOf('no dates here')).toBeNull();
  });
});

describe('filing', () => {
  const accounts = [acct('A1', 'SAPPHIRE (6496)'), acct('A2', 'TOTAL CHECKING (1234)')];
  const chase: Institution = { key: 'chase', name: 'Chase', url: null, accounts };

  it('matches the account by the digits on the row, else leaves it unmatched', () => {
    expect(matchAccount(accounts, 'Account ending in 1234 — August 2026')?.id).toBe('A2');
    expect(matchAccount(accounts, 'August 2026')).toBeNull();
    expect(matchAccount([accounts[0]!], 'anything')?.id).toBe('A1');
  });

  it('files under bank/account/YYYY-MM.pdf, skips the same bytes twice and refuses non-PDFs', () => {
    const out = mkdtempSync(join(tmpdir(), 'statements-test-'));
    try {
      const manifest = loadManifest(out);
      const first = fileStatement(out, manifest, chase, { bytes: PDF('aug'), suggestedName: '20260815-statements-6496-.pdf', label: 'Download', context: '', key: 'k1' }, 'fetch');
      expect(first).toMatchObject({ status: 'filed', entry: { path: 'chase/sapphire-6496/2026-08.pdf', accountId: 'A1', month: '2026-08' } });
      expect(statSync(join(out, 'chase/sapphire-6496/2026-08.pdf')).mode & 0o777).toBe(0o600);

      expect(fileStatement(out, manifest, chase, { bytes: PDF('aug'), suggestedName: 'copy.pdf', label: '', context: '', key: null }, 'assist').status).toBe('duplicate');
      const corrected = fileStatement(out, manifest, chase, { bytes: PDF('aug-corrected'), suggestedName: '20260815-statements-6496-.pdf', label: '', context: '', key: null }, 'assist');
      expect(corrected).toMatchObject({ status: 'filed', entry: { path: 'chase/sapphire-6496/2026-08-2.pdf' } });

      const unknown = fileStatement(out, manifest, chase, { bytes: PDF('who'), suggestedName: 'Statement.pdf', label: '', context: 'August 2026', key: null }, 'assist');
      expect(unknown).toMatchObject({ status: 'filed', entry: { path: 'chase/_unfiled/statement.pdf', accountId: null } });

      expect(fileStatement(out, manifest, chase, { bytes: Buffer.from('<html>session expired</html>'), suggestedName: 'x.pdf', label: '', context: '', key: null }, 'fetch').status).toBe('not-pdf');
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  });

  it('keys a candidate by its link, or by label and period when the link is a session token', () => {
    expect(candidateKey({ label: 'Download', context: 'x', href: 'https://bank/doc/123.pdf' })).toBe('https://bank/doc/123.pdf');
    expect(candidateKey({ label: 'Download', context: 'Aug 15, 2026', href: 'https://bank/doc?token=abc' })).toBe('Download|2026-08|2026-08-15');
    expect(candidateKey({ label: 'View', context: 'Statement 07/16/2026 - 08/15/2026', href: null })).toBe('View|2026-08|2026-08-15');
  });

  it('starts at the learnt page, then the known statements page, then the sign-in page', () => {
    expect(startUrls({ key: 'chase', url: null }, 'https://secure.chase.com/x').fetch).toBe('https://secure.chase.com/x');
    expect(startUrls({ key: 'chase', url: null }, undefined).fetch).toContain('documents');
    expect(startUrls({ key: 'tiny-cu', url: 'https://tinycu.org' }, undefined)).toEqual({ login: 'https://tinycu.org', fetch: 'https://tinycu.org' });
    expect(isSignInUrl('https://secure.chase.com/web/auth/#/logon/logon/chaseOnline')).toBe(true);
    expect(isSignInUrl('https://secure.chase.com/web/auth/dashboard#/dashboard/documents')).toBe(false);
  });
});

describe('coinpay import', () => {
  const entry = (patch: Partial<ManifestEntry>): ManifestEntry => ({
    sha256: 'x', path: 'chase/sapphire-6496/2026-08.pdf', institution: 'chase', accountId: 'A1', accountName: null, month: '2026-08', from: null, to: null,
    bytes: 1, how: 'fetch', label: '', suggestedName: '', downloadedAt: '', key: null, ...patch,
  });

  it('finds the CoinPay account by SimpleFIN id, then by institution and last four', () => {
    const local = [acct('A1', 'SAPPHIRE (6496)')];
    const byExternal = [{ ...acct('cp-9', 'Whatever'), coinpayId: 'cp-9', externalId: 'A1' }];
    expect(coinpayAccountFor(entry({}), local, byExternal)?.coinpayId).toBe('cp-9');
    const byDigits = [{ ...acct('cp-7', 'CREDIT CARD (6496)'), coinpayId: 'cp-7', externalId: 'other' }];
    expect(coinpayAccountFor(entry({}), local, byDigits)?.coinpayId).toBe('cp-7');
    expect(coinpayAccountFor(entry({ accountId: 'nope' }), local, byDigits)).toBeNull();
  });

  it('passes the cycle with an exclusive end, else the month', () => {
    expect(coinpayImportArgs('/s/a.pdf', 'cp-7', entry({ from: '2026-07-16', to: '2026-08-15' }), 'Chase')).toEqual([
      'finances', 'statements', 'import', '/s/a.pdf', '--account', 'cp-7', '--from', '2026-07-16', '--to', '2026-08-16', '--cycle', 'custom', '--institution', 'Chase', '--json',
    ]);
    expect(coinpayImportArgs('/s/a.pdf', 'cp-7', entry({}), 'Chase')).toContain('--period');
    expect(() => coinpayImportArgs('/s/a.pdf', 'cp-7', entry({ month: null }), 'Chase')).toThrow(/no period/);
  });

  it('reads the statement id from coinpay --json', () => {
    expect(parseImported(JSON.stringify({ statement: { id: 'stmt_1' }, note: 'x' }))).toBe('stmt_1');
    expect(parseImported('Error: Not authenticated')).toBeNull();
  });
});

// A bank on localhost: a password page until the session cookie is set, then a
// statements list with the three shapes real banks use.
const chrome = findChrome();
describe.skipIf(!chrome)('fetch against a fake bank in headless Chrome', () => {
  let server: Server;
  let base = '';
  const work = mkdtempSync(join(tmpdir(), 'statements-e2e-'));

  beforeAll(async () => {
    server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://x');
      const signedIn = /(^|;\s*)s=1/.test(req.headers.cookie ?? '');
      if (url.pathname === '/set') {
        res.writeHead(302, { 'Set-Cookie': 's=1; Path=/; Max-Age=3600', Location: '/statements' });
        res.end();
      } else if (url.pathname === '/statements' && !signedIn) {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end('<form><input name=u><input type=password name=p><button>Sign in</button></form>');
      } else if (url.pathname === '/statements') {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(`<!doctype html><body><table>
          <tr><td>Account ending 6496</td><td>Statement 07/16/2026 - 08/15/2026</td><td><a href="/pdf/aug?a=6496">Download</a></td></tr>
          <tr><td>Account ending 1234</td><td>July 2026</td><td><button onclick="document.getElementById('d').hidden=false">View statement</button></td></tr>
          <tr><td>Account ending 1234</td><td>June 2026</td><td><a href="/inline/jun">PDF</a></td></tr>
          <tr><td>Updated 08/01/2026</td><td><a href="/prefs">Statement preferences</a></td></tr>
        </table>
        <div role=dialog id=d hidden><button onclick="location.href='/pdf/jul?a=1234'">Download</button></div></body>`);
      } else if (url.pathname.startsWith('/pdf/')) {
        res.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Disposition': `attachment; filename="statement-${url.pathname.slice(5)}.pdf"` });
        res.end(PDF(url.pathname));
      } else if (url.pathname === '/inline/jun') {
        res.writeHead(200, { 'Content-Type': 'application/pdf' });
        res.end(PDF('inline-jun'));
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
  });

  afterAll(() => {
    server?.close();
    rmSync(work, { recursive: true, force: true });
  });

  it('reports a lost session, then files every statement once a session exists', { timeout: 120_000 }, async () => {
    const institution: Institution = { key: 'fakebank', name: 'Fake Bank', url: base, accounts: [acct('A1', 'SAPPHIRE (6496)', 'fakebank'), acct('A2', 'CHECKING (1234)', 'fakebank')] };
    const profile = join(work, 'profile');
    const outDir = join(work, 'out');
    const manifest = loadManifest(outDir);
    const options = { start: `${base}/statements`, outDir, manifest, since: null, max: 10, renderMs: 4000, log: () => undefined };
    const { mkdirSync } = await import('node:fs');
    mkdirSync(outDir, { recursive: true });

    let browser = await openBrowser({ chrome: chrome!, profile, headless: true });
    try {
      expect((await fetchInstitution(browser, institution, options)).status).toBe('login-needed');
      // What `statements login` leaves behind: a profile holding the bank's cookie.
      const { cdp } = browser;
      const { targetId } = (await cdp.send('Target.createTarget', { url: `${base}/set` })) as { targetId: string };
      await new Promise((resolve) => setTimeout(resolve, 1500));
      await cdp.send('Target.closeTarget', { targetId });
    } finally {
      await browser.close();
    }

    browser = await openBrowser({ chrome: chrome!, profile, headless: true });
    try {
      const result = await fetchInstitution(browser, institution, options);
      expect(result.status).toBe('ok');
      expect(result.candidates).toBe(3);
      const paths = manifest.entries.map((entry) => entry.path).sort();
      expect(paths).toEqual(['fakebank/checking-1234/2026-06.pdf', 'fakebank/checking-1234/2026-07.pdf', 'fakebank/sapphire-6496/2026-08.pdf']);
      expect(manifest.entries.find((entry) => entry.month === '2026-08')).toMatchObject({ from: '2026-07-16', to: '2026-08-15' });
      expect(readFileSync(join(outDir, 'fakebank/checking-1234/2026-06.pdf'), 'latin1')).toContain('inline-jun');

      const again = await fetchInstitution(browser, institution, options);
      expect(again.results).toEqual([]);
    } finally {
      await browser.close();
    }
  });
});
