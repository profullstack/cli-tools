import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  type Account,
  type FullMessage,
  type MessageSummary,
  type Outgoing,
  MailError,
  accountsFromVault,
  bareAddress,
  buildReply,
  chooseTransport,
  composeRaw,
  folderFor,
  formatAccounts,
  formatAddresses,
  formatList,
  formatMessage,
  fromHeader,
  guessProvider,
  isTransportFailure,
  loadConfig,
  mailConfigPath,
  mergeVaultAccounts,
  normalizeConfig,
  parseQuery,
  passwordVariable,
  quote,
  replySubject,
  resendPayload,
  resendSender,
  resolveAccount,
  saveConfig,
  selectAccount,
  selectAccounts,
  sendMail,
  senderName,
  splitAddresses,
  stripHtml,
  summaryFrom,
} from '../src/mail.ts';

const env = (extra: Record<string, string> = {}): NodeJS.ProcessEnv => ({ ...extra });

function account(partial: Partial<Account> = {}): Account {
  return {
    name: 'work',
    email: 'me@example.com',
    displayName: 'Me',
    user: 'me@example.com',
    password: 'secret',
    passwordSource: 'file',
    provider: 'forwardemail',
    imap: { host: 'imap.example.com', port: 993 },
    smtp: { host: 'smtp.example.com', port: 465, secure: true },
    ...partial,
  };
}

function summary(partial: Partial<MessageSummary> = {}): MessageSummary {
  return {
    uid: 1,
    seq: 1,
    date: '2026-09-01T10:00:00.000Z',
    from: 'Alice <alice@example.org>',
    to: 'me@example.com',
    subject: 'Hello',
    seen: true,
    flagged: false,
    answered: false,
    size: 1024,
    messageId: '<one@example.org>',
    ...partial,
  };
}

function full(partial: Partial<FullMessage> = {}): FullMessage {
  return {
    ...summary(),
    cc: '',
    replyTo: '',
    inReplyTo: null,
    references: [],
    text: 'first line\n\nsecond line',
    html: null,
    attachments: [],
    ...partial,
  };
}

describe('providers', () => {
  it('infers gmail from the address and nothing else', () => {
    expect(guessProvider('a@gmail.com')).toBe('gmail');
    expect(guessProvider('a@GoogleMail.com')).toBe('gmail');
    expect(guessProvider('a@example.com')).toBeNull();
  });

  it('names the password variable from the account name', () => {
    expect(passwordVariable('work')).toBe('MAIL_WORK_PASSWORD');
    expect(passwordVariable('my-home')).toBe('MAIL_MY_HOME_PASSWORD');
  });
});

describe('resolveAccount', () => {
  it('fills hosts from the provider preset', () => {
    const resolved = resolveAccount('home', { email: 'a@gmail.com', provider: 'gmail', password: 'p' }, env());
    expect(resolved.imap).toEqual({ host: 'imap.gmail.com', port: 993 });
    expect(resolved.smtp).toEqual({ host: 'smtp.gmail.com', port: 465, secure: true });
    expect(resolved.user).toBe('a@gmail.com');
    expect(resolved.passwordSource).toBe('file');
  });

  // The rule shared with credentials.ts: what is exported beats what is stored,
  // because CI and a one-off shell have to be able to override a stale file.
  it('lets the environment override the stored password', () => {
    const resolved = resolveAccount(
      'work',
      { email: 'a@example.com', provider: 'forwardemail', password: 'stored' },
      env({ MAIL_WORK_PASSWORD: 'exported' }),
    );
    expect(resolved.password).toBe('exported');
    expect(resolved.passwordSource).toBe('env');
  });

  it('reports an unset password rather than inventing one', () => {
    const resolved = resolveAccount('work', { email: 'a@example.com', provider: 'forwardemail' }, env());
    expect(resolved.password).toBeNull();
    expect(resolved.passwordSource).toBe('unset');
  });

  it('refuses a custom provider with no hosts', () => {
    expect(() => resolveAccount('x', { email: 'a@b.c', provider: 'custom' }, env())).toThrow(/imapHost and smtpHost/);
  });

  it('treats a non-465 custom port as STARTTLS unless told otherwise', () => {
    const resolved = resolveAccount(
      'x',
      { email: 'a@b.c', provider: 'custom', imapHost: 'i', smtpHost: 's', smtpPort: 587 },
      env(),
    );
    expect(resolved.smtp.secure).toBe(false);
  });
});

describe('selectAccounts', () => {
  const config = {
    accounts: {
      work: { email: 'a@example.com', provider: 'forwardemail' as const },
      home: { email: 'b@gmail.com', provider: 'gmail' as const },
    },
  };

  it('finds an account by name or by address', () => {
    expect(selectAccounts(config, 'home', env())[0]!.name).toBe('home');
    expect(selectAccounts(config, 'a@example.com', env())[0]!.name).toBe('work');
    expect(selectAccounts(config, 'A@EXAMPLE.COM', env())[0]!.name).toBe('work');
  });

  it('returns every account for "all"', () => {
    expect(selectAccounts(config, 'all', env()).map((a) => a.name)).toEqual(['work', 'home']);
  });

  it('uses the default, then MAIL_ACCOUNT, then asks', () => {
    expect(selectAccounts({ ...config, default: 'home' }, undefined, env())[0]!.name).toBe('home');
    expect(selectAccounts(config, undefined, env({ MAIL_ACCOUNT: 'work' }))[0]!.name).toBe('work');
    expect(() => selectAccounts(config, undefined, env())).toThrow(/which account/);
  });

  it('needs no selector when there is exactly one account', () => {
    const one = { accounts: { work: config.accounts.work } };
    expect(selectAccounts(one, undefined, env())[0]!.name).toBe('work');
  });

  it('names the configured accounts in the error for an unknown one', () => {
    expect(() => selectAccounts(config, 'other', env())).toThrow(/work, home/);
  });

  it('explains how to add an account when there are none', () => {
    expect(() => selectAccounts({ accounts: {} }, undefined, env())).toThrow(/mail accounts add/);
  });

  it('selectAccount refuses "all"', () => {
    expect(() => selectAccount(config, 'all', env())).toThrow(/one account at a time/);
  });
});

describe('config file', () => {
  let dir: string;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('round-trips through a 0600 file in the configured directory', () => {
    dir = mkdtempSync(join(tmpdir(), 'mail-config-'));
    const e = env({ XDG_CONFIG_HOME: dir });
    expect(mailConfigPath(e)).toBe(join(dir, 'cli-tools', 'mail.json'));
    const path = saveConfig(
      { default: 'work', accounts: { work: { email: 'a@example.com', provider: 'forwardemail', password: 'p' } } },
      e,
    );
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(loadConfig(e)).toEqual({
      default: 'work',
      accounts: { work: { email: 'a@example.com', provider: 'forwardemail', password: 'p' } },
    });
  });

  it('is empty on first run and loud on corruption', () => {
    dir = mkdtempSync(join(tmpdir(), 'mail-config-'));
    const e = env({ XDG_CONFIG_HOME: dir });
    expect(loadConfig(e)).toEqual({ accounts: {} });
    writeFileSync(join(dir, 'mail.json'), '{nope');
    expect(() => loadConfig(env({ CLI_TOOLS_MAIL_CONFIG: join(dir, 'mail.json') }))).toThrow(/not valid JSON/);
  });

  it('drops entries that are not accounts and infers a missing provider', () => {
    const config = normalizeConfig({
      default: 'home',
      accounts: {
        home: { email: 'B@Gmail.com', name: ' Bee ' },
        junk: { email: 'not-an-address' },
        alsoJunk: 'string',
      },
    });
    expect(config).toEqual({ default: 'home', accounts: { home: { email: 'b@gmail.com', provider: 'gmail', name: 'Bee' } } });
  });
});

describe('accountsFromVault', () => {
  it('builds accounts from MAIL_<NAME>_* keys and the default', () => {
    const config = accountsFromVault({
      MAIL_WORK_EMAIL: 'A@Example.com',
      MAIL_WORK_PROVIDER: 'forwardemail',
      MAIL_WORK_PASSWORD: 'w',
      MAIL_WORK_NAME: 'Anyone',
      MAIL_HOME_EMAIL: 'b@gmail.com',
      MAIL_HOME_PASSWORD: 'h',
      MAIL_DEFAULT: 'work',
      RESEND_API_KEY: 'unrelated',
    });
    expect(config).toEqual({
      default: 'work',
      accounts: {
        work: { email: 'a@example.com', provider: 'forwardemail', password: 'w', name: 'Anyone' },
        home: { email: 'b@gmail.com', provider: 'gmail', password: 'h' },
      },
    });
  });

  it('lets a custom account name its hosts, and reads the port and TLS flag', () => {
    const config = accountsFromVault({
      MAIL_OLD_EMAIL: 'x@corp.example',
      MAIL_OLD_IMAP_HOST: 'imap.corp.example',
      MAIL_OLD_SMTP_HOST: 'smtp.corp.example',
      MAIL_OLD_SMTP_PORT: '587',
      MAIL_OLD_SMTP_SECURE: 'false',
      MAIL_OLD_USER: 'x',
    });
    expect(config.accounts.old).toEqual({
      email: 'x@corp.example',
      provider: 'custom',
      user: 'x',
      imapHost: 'imap.corp.example',
      smtpHost: 'smtp.corp.example',
      smtpPort: 587,
      smtpSecure: false,
    });
  });

  it('ignores a password with no address, and a default that names nothing', () => {
    const config = accountsFromVault({ MAIL_GHOST_PASSWORD: 'p', MAIL_DEFAULT: 'ghost' });
    expect(config).toEqual({ accounts: {} });
  });

  it('merges over the local file, vault first, leaving local-only accounts alone', () => {
    const local = {
      default: 'home',
      accounts: {
        work: { email: 'a@example.com', provider: 'forwardemail' as const },
        lab: { email: 'l@example.com', provider: 'forwardemail' as const, password: 'kept' },
      },
    };
    const fromVault = accountsFromVault({
      MAIL_WORK_EMAIL: 'a@example.com',
      MAIL_WORK_PROVIDER: 'forwardemail',
      MAIL_WORK_PASSWORD: 'now',
      MAIL_HOME_EMAIL: 'b@gmail.com',
      MAIL_HOME_PASSWORD: 'h',
    });
    const { merged, imported, unchanged } = mergeVaultAccounts(local, fromVault);
    expect(imported).toEqual(['home', 'work']);
    expect(unchanged).toEqual([]);
    expect(merged.accounts.lab?.password).toBe('kept');
    expect(merged.accounts.work?.password).toBe('now');
    expect(merged.default).toBe('home');
    // A second pull with nothing new says so.
    expect(mergeVaultAccounts(merged, fromVault).unchanged).toEqual(['home', 'work']);
  });
});

describe('addresses', () => {
  it('formats and splits header lists', () => {
    expect(formatAddresses([{ name: 'A B', address: 'a@b.c' }, { address: 'd@e.f' }, { name: 'Only' }])).toBe(
      'A B <a@b.c>, d@e.f, Only',
    );
    expect(splitAddresses('"Doe, Jane" <jane@x.y>, bob@x.y')).toEqual(['"Doe, Jane" <jane@x.y>', 'bob@x.y']);
    expect(bareAddress('Jane <Jane@X.Y>')).toBe('jane@x.y');
    expect(senderName('"Doe, Jane" <jane@x.y>')).toBe('Doe, Jane');
    expect(senderName('jane@x.y')).toBe('jane@x.y');
  });

  it('puts the display name on the From header only when there is one', () => {
    expect(fromHeader(account())).toBe('Me <me@example.com>');
    expect(fromHeader(account({ displayName: null }))).toBe('me@example.com');
  });
});

describe('summaryFrom', () => {
  it('maps the IMAP fetch object, flags included', () => {
    const mapped = summaryFrom({
      seq: 3,
      uid: 42,
      size: 999,
      flags: new Set(['\\Flagged', '\\Answered']),
      envelope: {
        date: new Date('2026-09-02T12:00:00Z'),
        subject: 'Hi',
        messageId: '<m@x>',
        from: [{ name: 'A', address: 'a@x' }],
        to: [{ address: 'me@x' }],
      },
    });
    expect(mapped).toEqual({
      uid: 42,
      seq: 3,
      date: '2026-09-02T12:00:00.000Z',
      from: 'A <a@x>',
      to: 'me@x',
      subject: 'Hi',
      seen: false,
      flagged: true,
      answered: true,
      size: 999,
      messageId: '<m@x>',
    });
  });

  it('survives a message with no envelope at all', () => {
    expect(summaryFrom({ seq: 1, uid: 1 })).toMatchObject({ uid: 1, from: '', subject: '', date: null, size: null });
  });
});

describe('parseQuery', () => {
  it('turns keys into IMAP search fields and bare words into text', () => {
    expect(parseQuery('from:alice subject:"pottery wheel" since:2026-09-01 unread invoice due')).toEqual({
      from: 'alice',
      subject: 'pottery wheel',
      since: new Date('2026-09-01T00:00:00Z'),
      seen: false,
      text: 'invoice due',
    });
  });

  it('understands is: filters', () => {
    expect(parseQuery('is:flagged is:answered')).toEqual({ flagged: true, answered: true });
    expect(parseQuery('is:read')).toEqual({ seen: true });
    expect(() => parseQuery('is:huge')).toThrow(/is:huge/);
  });

  it('rejects a date that is not a date, and a key it does not know', () => {
    expect(() => parseQuery('since:yesterday')).toThrow(/YYYY-MM-DD/);
    expect(() => parseQuery('label:foo')).toThrow(/unknown search key/);
  });
});

describe('folderFor', () => {
  const folders = [
    { path: 'INBOX', specialUse: null, delimiter: '/' },
    { path: '[Gmail]/Bin', specialUse: '\\Trash', delimiter: '/' },
    { path: '[Gmail]/Sent Mail', specialUse: '\\Sent', delimiter: '/' },
    { path: 'Drafts', specialUse: null, delimiter: '/' },
  ];

  it('prefers the special-use attribute, then a conventional name', () => {
    expect(folderFor(folders, 'Trash')).toBe('[Gmail]/Bin');
    expect(folderFor(folders, 'Sent')).toBe('[Gmail]/Sent Mail');
    expect(folderFor(folders, 'Drafts')).toBe('Drafts');
    expect(folderFor(folders, 'Archive')).toBeNull();
  });
});

describe('replies', () => {
  it('quotes like a mail client', () => {
    expect(quote('a\r\nb\n\nc\n')).toBe('> a\n> b\n>\n> c');
  });

  it('adds Re: once', () => {
    expect(replySubject('Hello')).toBe('Re: Hello');
    expect(replySubject('Re: Hello')).toBe('Re: Hello');
    expect(replySubject('RE: Hello')).toBe('RE: Hello');
    expect(replySubject('Fwd: Hello')).toBe('Fwd: Hello');
  });

  it('answers the Reply-To, threads on the original, and quotes it', () => {
    const original = full({
      replyTo: 'Alice Replies <replies@example.org>',
      references: ['<zero@example.org>'],
    });
    const reply = buildReply(original, account(), { body: 'Thanks!' });
    expect(reply.to).toEqual(['Alice Replies <replies@example.org>']);
    expect(reply.cc).toEqual([]);
    expect(reply.subject).toBe('Re: Hello');
    expect(reply.inReplyTo).toBe('<one@example.org>');
    expect(reply.references).toEqual(['<zero@example.org>', '<one@example.org>']);
    expect(reply.text).toContain('Thanks!\n\nOn Tue, 01 Sep 2026 10:00:00 GMT, Alice <alice@example.org> wrote:\n> first line\n>\n> second line');
    expect(reply.from).toBe('Me <me@example.com>');
  });

  // Reply-all that copies yourself is a message you read twice; and the
  // original sender must not be duplicated into Cc.
  it('reply-all copies everyone else exactly once', () => {
    const original = full({
      to: 'me@example.com, Bob <bob@example.org>',
      cc: 'Carol <carol@example.org>, alice@example.org',
    });
    const reply = buildReply(original, account(), { all: true, body: 'x', quoteOriginal: false });
    expect(reply.to).toEqual(['Alice <alice@example.org>']);
    expect(reply.cc).toEqual(['Bob <bob@example.org>', 'Carol <carol@example.org>']);
    expect(reply.text).toBe('x\n');
  });

  it('refuses when there is nobody to answer', () => {
    expect(() => buildReply(full({ from: 'me@example.com' }), account(), { body: 'x' })).toThrow(/no address/);
  });

  it('composes RFC 822 bytes with the thread headers', async () => {
    const raw = (await composeRaw(buildReply(full(), account(), { body: 'ok', quoteOriginal: false }))).toString();
    expect(raw).toMatch(/^From: Me <me@example.com>/m);
    expect(raw).toMatch(/^In-Reply-To: <one@example.org>/m);
    expect(raw).toMatch(/^References: <one@example.org>/m);
    expect(raw).toMatch(/^Subject: Re: Hello/m);
  });
});

describe('chooseTransport', () => {
  it('prefers SMTP with Resend behind it for a verifiable domain', () => {
    expect(chooseTransport(account(), 'key')).toMatchObject({ transport: 'smtp', fallback: 'resend' });
    expect(chooseTransport(account(), undefined)).toMatchObject({ transport: 'smtp', fallback: null });
  });

  it('goes straight to Resend when there is no password', () => {
    expect(chooseTransport(account({ password: null }), 'key')).toMatchObject({ transport: 'resend', fallback: null });
  });

  // gmail.com cannot be verified at Resend, so a Gmail account without a
  // password has nowhere to go — and the message says which fix applies.
  it('never offers Resend for a webmail address', () => {
    const gmail = account({ email: 'me@gmail.com', provider: 'gmail' });
    expect(chooseTransport(gmail, 'key')).toMatchObject({ transport: 'smtp', fallback: null });
    expect(() => chooseTransport(account({ email: 'me@gmail.com', password: null }), 'key')).toThrow(/cannot send through Resend/);
    expect(() => chooseTransport(gmail, 'key', 'resend')).toThrow(/cannot be verified/);
  });

  it('honours or refuses an explicit --via, never swaps it', () => {
    expect(chooseTransport(account(), 'key', 'resend')).toMatchObject({ transport: 'resend', fallback: null });
    expect(() => chooseTransport(account({ password: null }), 'key', 'smtp')).toThrow(/no password/);
    expect(() => chooseTransport(account(), undefined, 'resend')).toThrow(/RESEND_API_KEY/);
  });

  it('says both fixes when nothing can send', () => {
    expect(() => chooseTransport(account({ password: null }), undefined)).toThrow(/mail accounts password work.*cli-tools config pull/s);
  });
});

describe('sendMail', () => {
  const outgoing: Outgoing = {
    from: 'Me <me@example.com>',
    to: ['a@example.org'],
    cc: [],
    bcc: [],
    subject: 'Hi',
    text: 'body\n',
    attachments: [],
  };

  it('falls back to Resend when SMTP cannot connect', async () => {
    const calls: string[] = [];
    const result = await sendMail(account(), outgoing, {
      resendKey: 'key',
      smtp: async () => {
        calls.push('smtp');
        throw new Error('connect ECONNREFUSED 1.2.3.4:465');
      },
      resend: async () => {
        calls.push('resend');
        return 'r-1';
      },
    });
    expect(calls).toEqual(['smtp', 'resend']);
    expect(result).toEqual({
      transport: 'resend',
      id: 'r-1',
      fellBackFrom: { transport: 'smtp', error: 'connect ECONNREFUSED 1.2.3.4:465' },
    });
  });

  // A refused recipient would be refused the same way on the other path, and
  // retrying a message the first server may have accepted late sends it twice.
  it('does not fall back on a refused message', async () => {
    let resendCalls = 0;
    await expect(
      sendMail(account(), outgoing, {
        resendKey: 'key',
        smtp: async () => {
          throw new Error('550 5.1.1 recipient rejected');
        },
        resend: async () => {
          resendCalls += 1;
          return null;
        },
      }),
    ).rejects.toThrow(/recipient rejected/);
    expect(resendCalls).toBe(0);
  });

  it('does not fall back when --via pinned the transport', async () => {
    await expect(
      sendMail(account(), outgoing, {
        resendKey: 'key',
        via: 'smtp',
        smtp: async () => {
          throw new Error('ETIMEDOUT');
        },
        resend: async () => 'never',
      }),
    ).rejects.toThrow(/ETIMEDOUT/);
  });

  it('classifies pipe failures apart from message refusals', () => {
    expect(isTransportFailure('Invalid login: 535 5.7.8 Authentication failed')).toBe(true);
    expect(isTransportFailure('getaddrinfo ENOTFOUND smtp.example.com')).toBe(true);
    expect(isTransportFailure('Greeting never received')).toBe(true);
    expect(isTransportFailure('550 5.1.1 recipient rejected')).toBe(false);
    expect(isTransportFailure('Resend refused the message: domain is not verified')).toBe(false);
  });
});

describe('Resend', () => {
  it('shapes the payload with Resend header names and base64 attachments', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mail-attach-'));
    const path = join(dir, 'a.txt');
    writeFileSync(path, 'hello');
    try {
      const payload = resendPayload({
        from: 'Me <me@example.com>',
        to: ['a@x'],
        cc: ['c@x'],
        bcc: [],
        subject: 'S',
        text: 'T',
        inReplyTo: '<one@x>',
        references: ['<zero@x>', '<one@x>'],
        attachments: [{ filename: 'a.txt', path }],
      });
      expect(payload).toEqual({
        from: 'Me <me@example.com>',
        to: ['a@x'],
        cc: ['c@x'],
        subject: 'S',
        text: 'T',
        headers: { 'In-Reply-To': '<one@x>', References: '<zero@x> <one@x>' },
        attachments: [{ filename: 'a.txt', content: Buffer.from('hello').toString('base64') }],
      });
      expect(payload).not.toHaveProperty('bcc');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('posts with the bearer key and surfaces the refusal message', async () => {
    const seen: { url: string; init: RequestInit }[] = [];
    const ok = resendSender((async (url: string | URL | Request, init?: RequestInit) => {
      seen.push({ url: String(url), init: init ?? {} });
      return new Response(JSON.stringify({ id: 'abc' }), { status: 200 });
    }) as typeof fetch);
    const outgoing: Outgoing = { from: 'a@x', to: ['b@x'], cc: [], bcc: [], subject: 's', text: 't', attachments: [] };
    await expect(ok('key', outgoing)).resolves.toBe('abc');
    expect(seen[0]!.url).toBe('https://api.resend.com/emails');
    expect((seen[0]!.init.headers as Record<string, string>).Authorization).toBe('Bearer key');

    const refused = resendSender((async () =>
      new Response(JSON.stringify({ message: 'The example.com domain is not verified.' }), { status: 403 })) as typeof fetch);
    await expect(refused('key', outgoing)).rejects.toThrow(MailError);
    await expect(refused('key', outgoing)).rejects.toThrow(/domain is not verified/);
  });
});

describe('output', () => {
  const now = new Date('2026-09-05T12:00:00Z');

  it('lists newest first with uid, state flags, date and a trimmed subject', () => {
    const text = formatList(
      [
        summary({ uid: 12, seen: false, flagged: true, subject: 'A very long subject '.repeat(10), date: '2026-09-05T09:30:00Z' }),
        summary({ uid: 3, answered: true, from: 'bob@example.org' }),
      ],
      { width: 80, now },
    );
    const lines = text.split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/^ 12 N\*       09:30 Alice\s+A very long subject/);
    expect(lines[0]!.length).toBeLessThanOrEqual(80);
    expect(lines[1]).toMatch(/^  3   r 2026-09-01 bob@example.org\s+Hello$/);
  });

  it('labels the account when asked, and says when there is nothing', () => {
    expect(formatList([], { now })).toBe('(no messages)');
    expect(formatList([summary()], { account: 'home', now })).toMatch(/^# home\n/);
  });

  it('prints a message as headers then text', () => {
    const text = formatMessage(
      full({ cc: 'c@x', attachments: [{ filename: 'bowl.jpg', contentType: 'image/jpeg', size: 2048 }] }),
    );
    expect(text).toBe(
      'From:    Alice <alice@example.org>\n' +
        'To:      me@example.com\n' +
        'Cc:      c@x\n' +
        'Date:    2026-09-01T10:00:00.000Z\n' +
        'Subject: Hello\n' +
        'Uid:     1   Message-Id: <one@example.org>\n' +
        'Attachments: bowl.jpg (image/jpeg, 2048 bytes)\n' +
        '\n' +
        'first line\n\nsecond line\n',
    );
  });

  it('never prints a password in the accounts listing', () => {
    const text = formatAccounts([account(), account({ name: 'home', password: null, passwordSource: 'unset' })], 'work');
    expect(text).toContain('* work');
    expect(text).toContain('password from mail.json');
    expect(text).toContain('no password');
    expect(text).not.toContain('secret');
  });

  it('reduces HTML-only mail to readable text', () => {
    expect(stripHtml('<p>Hi&nbsp;there</p><style>x{}</style><div>Bye<br>now</div>')).toBe('Hi there\nBye\nnow');
  });
});
