#!/usr/bin/env node
/**
 * mail — the inbox from the terminal: read, search, reply, send, file, delete.
 *
 *   mail ls                              the newest messages in the default account
 *   mail ls -a all --unread              unread across every account
 *   mail read 4213                       one message, headers then text
 *   mail reply 4213 --body "Thanks."     answer it, quoted, in the same thread
 *   mail send --to a@b.c --subject Hi    a new message; body from --body, --file or stdin
 *   mail rm 4213                         to Trash; --purge to actually expunge
 *
 * Two accounts, a business one and a personal one, and neither should need a
 * browser tab to answer. Reading is IMAP; sending is the account's SMTP, with
 * Resend as the fallback for a domain the team has verified there — never for
 * a webmail address, which Resend cannot send as at all.
 *
 * Accounts are configuration: `mail accounts add`, or `mail accounts pull`
 * from the `cli-tools-mail` team vault. Nothing here names a person.
 */

import { readFileSync } from 'node:fs';
import { basename } from 'node:path';

import { UsageError, csv, integer, parseArgs } from '../src/args.ts';
import { resolveCredentials } from '../src/credentials.ts';
import { isMain } from '../src/is-main.ts';
import {
  type Account,
  type Folder,
  type MailConfig,
  type Mailbox,
  type Outgoing,
  type ProviderName,
  type Transport,
  MAIL_VAULT_PROJECT,
  MailError,
  PROVIDERS,
  accountsFromVault,
  buildReply,
  chooseTransport,
  composeRaw,
  folderFor,
  formatAccounts,
  formatFolders,
  formatList,
  formatMessage,
  fromHeader,
  guessProvider,
  loadConfig,
  mailConfigPath,
  mergeVaultAccounts,
  openMailbox,
  parseQuery,
  passwordVariable,
  resolveAccount,
  saveConfig,
  selectAccount,
  selectAccounts,
  sendMail,
} from '../src/mail.ts';
import { confirm, promptSecret } from '../src/prompt.ts';
import { pullVault, vaultTarget } from '../src/vault.ts';

const USAGE = `Usage:
  mail accounts                                   the configured accounts
  mail accounts add <name> <email> [options]       add or update one (prompts for the password)
  mail accounts password <name>                   store or replace a password
  mail accounts default <name>                    which account a bare command means
  mail accounts rm <name>
  mail accounts pull                              import accounts from the team vault

  mail folders [-a ACCOUNT]
  mail ls [-a ACCOUNT|all] [--folder F] [--unread] [--limit N] [--json]
  mail search <query…> [-a ACCOUNT|all] [--folder F] [--limit N] [--gmail] [--json]
  mail read <uid> [-a ACCOUNT] [--folder F] [--keep-unread] [--raw] [--json]

  mail send --to A[,B] --subject S [--cc …] [--bcc …] [--body T | --file P] [--attach P]… [--via smtp|resend] [--draft]
  mail reply <uid> [--all] [--body T | --file P] [--no-quote] [--via smtp|resend] [--draft]
  mail mark <uid>… (--read | --unread | --flag | --unflag) [--folder F]
  mail mv <uid>… <folder> [--folder F]
  mail archive <uid>… [--folder F]
  mail rm <uid>… [--purge] [--yes] [--folder F]

Options:
  -a, --account A   which account: its name, its address, or "all" for ls/search
  --folder F        the folder to work in (default INBOX)
  --unread          ls: only unread
  --limit N         how many, newest first (default 25)
  --gmail           search: hand the query to Gmail's own search language
  --keep-unread     read: leave the message unread afterwards
  --raw             read: the message as received, headers and all
  --json            machine-readable output
  --to, --cc, --bcc comma-separated addresses; --to may repeat
  --subject S
  --body T          the text; --file P reads it from a file; otherwise stdin
  --attach P        a file to attach; may repeat
  --all             reply: everyone on the original, not just the sender
  --no-quote        reply: do not quote the original under the answer
  --via smtp|resend which way to send; default is SMTP, falling back to Resend
  --draft           put the message in Drafts instead of sending it
  --purge           rm: expunge for good instead of moving to Trash
  --yes             rm --purge: skip the confirmation
  -h, --help        show this help

Account options for \`accounts add\`:
  --provider forwardemail|gmail|custom   (gmail is inferred from the address)
  --name "Display Name"   --user LOGIN
  --imap-host H --imap-port N --smtp-host H --smtp-port N --starttls
  --password              prompt for it now (the default when on a terminal)
  --no-password           do not prompt; export ${'MAIL_<NAME>_PASSWORD'} or pull it later
  --default               make this the default account

Search: bare words match the text; from: to: cc: subject: body: narrow a header,
since: before: on: take YYYY-MM-DD, and is:unread / is:flagged / is:answered
filter by state. Quote a value with spaces: subject:"pottery wheel".

Accounts live in ${mailConfigPath()} (0600). A password exported as
MAIL_<NAME>_PASSWORD wins over the stored one. \`mail accounts pull\` imports
MAIL_<NAME>_EMAIL / _PROVIDER / _PASSWORD (and optional _NAME, _USER, _IMAP_HOST,
_SMTP_HOST, …) plus MAIL_DEFAULT from the \`${MAIL_VAULT_PROJECT}\` vault;
CLI_TOOLS_MAIL_VAULT_PROJECT / _ENV point it elsewhere.

Sending needs either the account's password (SMTP) or a RESEND_API_KEY for a
domain verified at Resend (\`cli-tools config pull\` imports it). A Gmail
account can only send over SMTP — gmail.com cannot be verified at Resend.
`;

function fail(message: string, code = 2): never {
  process.stderr.write(`mail: ${message}\n`);
  process.exit(code);
}

function out(text: string): void {
  process.stdout.write(text.endsWith('\n') ? text : `${text}\n`);
}

function json(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

/** Every positional that is a uid; the rest are what the verb wants otherwise. */
function splitUids(items: string[]): { uids: number[]; rest: string[] } {
  const uids: number[] = [];
  const rest: string[] = [];
  for (const item of items) {
    if (/^\d+$/.test(item)) uids.push(Number(item));
    else rest.push(item);
  }
  return { uids, rest };
}

function needUids(items: string[], verb: string): number[] {
  const { uids } = splitUids(items);
  if (uids.length === 0) throw new UsageError(`${verb} needs at least one uid — \`mail ls\` shows them`);
  return uids;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

/** The body from --body, --file, or stdin — in that order, and never empty. */
async function bodyFrom(values: Map<string, string>): Promise<string> {
  const inline = values.get('--body');
  if (inline !== undefined) return inline;
  const file = values.get('--file');
  if (file !== undefined) return readFileSync(file, 'utf8');
  if (process.stdin.isTTY) {
    throw new UsageError('no body — pass --body, --file, or pipe the text on stdin');
  }
  const text = await readStdin();
  if (!text.trim()) throw new UsageError('stdin was empty — nothing to send');
  return text;
}

function addressesFrom(values: Map<string, string>, repeated: Map<string, string[]>, flag: string): string[] {
  const all = [...(repeated.get(flag) ?? []), ...(values.has(flag) ? [values.get(flag)!] : [])];
  return all
    .flatMap((item) => item.split(','))
    .map((item) => item.trim())
    .filter(Boolean);
}

async function withMailbox<T>(account: Account, work: (box: Mailbox) => Promise<T>): Promise<T> {
  const box = await openMailbox(account);
  try {
    return await work(box);
  } finally {
    await box.close().catch(() => undefined);
  }
}

/** File a copy where the account's client will see it: Sent, or Drafts. */
async function fileCopy(
  account: Account,
  outgoing: Outgoing,
  role: 'Sent' | 'Drafts',
): Promise<string | null> {
  if (!account.password) return null;
  return withMailbox(account, async (box) => {
    const folder = folderFor(await box.folders(), role);
    if (!folder) return null;
    const raw = await composeRaw(outgoing);
    await box.append(folder, raw, role === 'Drafts' ? ['\\Draft'] : ['\\Seen']);
    return folder;
  });
}

async function accountsVerb(config: MailConfig, args: string[], parsed: ReturnType<typeof parseArgs>): Promise<number> {
  const [verb, ...rest] = args;
  const isJson = parsed.flags.has('--json');

  if (!verb || verb === 'ls' || verb === 'list') {
    const accounts = Object.entries(config.accounts).map(([name, entry]) => {
      try {
        return resolveAccount(name, entry);
      } catch {
        // A custom account missing its hosts still deserves a row.
        return {
          name,
          email: entry.email,
          displayName: entry.name ?? null,
          user: entry.user ?? entry.email,
          password: null,
          passwordSource: 'unset' as const,
          provider: entry.provider,
          imap: { host: entry.imapHost ?? '?', port: entry.imapPort ?? 993 },
          smtp: { host: entry.smtpHost ?? '?', port: entry.smtpPort ?? 465, secure: true },
        };
      }
    });
    if (isJson) {
      json({
        default: config.default ?? null,
        accounts: accounts.map(({ password: _password, ...account }) => account),
      });
    } else {
      out(formatAccounts(accounts, config.default));
    }
    return 0;
  }

  if (verb === 'add') {
    const [name, email] = rest;
    if (!name || !email) throw new UsageError('accounts add needs <name> <email>');
    if (!/^[a-z0-9][a-z0-9_-]*$/i.test(name)) {
      throw new UsageError('an account name is letters, digits, - and _ — it becomes MAIL_<NAME>_PASSWORD');
    }
    if (!email.includes('@')) throw new UsageError(`"${email}" is not an address`);

    const requested = parsed.values.get('--provider')?.toLowerCase();
    let provider: ProviderName;
    if (requested === undefined) {
      provider = guessProvider(email) ?? (parsed.values.has('--imap-host') ? 'custom' : 'forwardemail');
    } else if (requested === 'forwardemail' || requested === 'gmail' || requested === 'custom') {
      provider = requested;
    } else {
      throw new UsageError(`--provider must be forwardemail, gmail or custom, got "${requested}"`);
    }

    const existing = config.accounts[name.toLowerCase()];
    const account = { ...(existing ?? {}), email: email.toLowerCase(), provider };
    const setString = (flag: string, key: 'name' | 'user' | 'imapHost' | 'smtpHost') => {
      const value = parsed.values.get(flag);
      if (value !== undefined) account[key] = value;
    };
    setString('--name', 'name');
    setString('--user', 'user');
    setString('--imap-host', 'imapHost');
    setString('--smtp-host', 'smtpHost');
    if (parsed.values.has('--imap-port')) account.imapPort = integer(parsed.values, '--imap-port', 993, { min: 1, max: 65_535 });
    if (parsed.values.has('--smtp-port')) account.smtpPort = integer(parsed.values, '--smtp-port', 465, { min: 1, max: 65_535 });
    if (parsed.flags.has('--starttls')) account.smtpSecure = false;

    if (provider === 'custom' && (!account.imapHost || !account.smtpHost)) {
      throw new UsageError('a custom provider needs --imap-host and --smtp-host');
    }

    const wantsPrompt =
      parsed.flags.has('--password') || (!parsed.flags.has('--no-password') && process.stdin.isTTY);
    if (wantsPrompt) {
      const hint = provider === 'custom' ? '' : `\n  (${PROVIDERS[provider].passwordHint})`;
      process.stderr.write(`Password for ${email}${hint}\n`);
      const password = await promptSecret('password: ');
      if (password) account.password = password;
    }

    config.accounts[name.toLowerCase()] = account;
    if (parsed.flags.has('--default') || Object.keys(config.accounts).length === 1) {
      config.default = name.toLowerCase();
    }
    const path = saveConfig(config);
    out(
      `${existing ? 'updated' : 'added'} ${name.toLowerCase()} (${email}, ${provider}` +
        `${account.password ? ', password stored' : ', no password'}) in ${path}`,
    );
    if (!account.password) {
      out(`store one later with \`mail accounts password ${name.toLowerCase()}\` or export ${passwordVariable(name)}`);
    }
    return 0;
  }

  if (verb === 'password') {
    const name = rest[0]?.toLowerCase();
    if (!name) throw new UsageError('accounts password needs the account name');
    const account = config.accounts[name];
    if (!account) fail(`no account "${name}". Configured: ${Object.keys(config.accounts).join(', ') || 'none'}`, 1);
    if (account.provider !== 'custom') {
      process.stderr.write(`(${PROVIDERS[account.provider].passwordHint})\n`);
    }
    const password = await promptSecret(`password for ${account.email}: `);
    if (!password) fail('empty — nothing stored', 1);
    account.password = password;
    out(`stored the password for ${name} in ${saveConfig(config)}`);
    if (process.env[passwordVariable(name)]) {
      out(`note: ${passwordVariable(name)} is exported and wins over the stored one`);
    }
    return 0;
  }

  if (verb === 'default') {
    const name = rest[0]?.toLowerCase();
    if (!name) throw new UsageError('accounts default needs the account name');
    if (!config.accounts[name]) fail(`no account "${name}"`, 1);
    config.default = name;
    saveConfig(config);
    out(`default account is now ${name}`);
    return 0;
  }

  if (verb === 'rm' || verb === 'remove') {
    const name = rest[0]?.toLowerCase();
    if (!name) throw new UsageError('accounts rm needs the account name');
    if (!config.accounts[name]) fail(`no account "${name}"`, 1);
    delete config.accounts[name];
    if (config.default === name) delete config.default;
    saveConfig(config);
    out(`removed ${name}`);
    return 0;
  }

  if (verb === 'pull') {
    const base = vaultTarget();
    const target = {
      team: base.team,
      project: process.env.CLI_TOOLS_MAIL_VAULT_PROJECT || MAIL_VAULT_PROJECT,
      env: process.env.CLI_TOOLS_MAIL_VAULT_ENV || base.env,
    };
    const label = `${target.team}/${target.project}--${target.env}`;
    process.stderr.write(`accounts: pulling ${label}…\n`);
    const fromVault = accountsFromVault(pullVault(target));
    if (Object.keys(fromVault.accounts).length === 0) {
      fail(
        `${label} holds no MAIL_<NAME>_EMAIL keys. Push accounts there as\n` +
          '  MAIL_WORK_EMAIL=… MAIL_WORK_PROVIDER=forwardemail MAIL_WORK_PASSWORD=…\n' +
          '  MAIL_HOME_EMAIL=… MAIL_HOME_PROVIDER=gmail MAIL_HOME_PASSWORD=…  MAIL_DEFAULT=work',
        1,
      );
    }
    const { merged, imported, unchanged } = mergeVaultAccounts(config, fromVault);
    if (imported.length > 0) {
      const path = saveConfig(merged);
      for (const name of imported) {
        const account = merged.accounts[name]!;
        out(`accounts: imported ${name} (${account.email}, ${account.provider}${account.password ? '' : ', no password'})`);
      }
      out(`accounts: written to ${path}`);
    }
    for (const name of unchanged) out(`accounts: ${name} already matches the vault`);
    const missing = Object.keys(merged.accounts).filter((name) => !merged.accounts[name]!.password);
    if (missing.length > 0) {
      out(
        `\n${missing.join(', ')} ${missing.length === 1 ? 'has' : 'have'} no password yet — ` +
          'add MAIL_<NAME>_PASSWORD to the vault and pull again, or `mail accounts password <name>`.',
      );
    }
    return 0;
  }

  throw new UsageError(`unknown accounts verb "${verb}" (add, password, default, rm, pull)`);
}

async function main(argv: string[]): Promise<number> {
  const parsed = parseArgs(argv, {
    boolean: [
      '--json', '--unread', '--gmail', '--keep-unread', '--raw', '--all', '--no-quote', '--draft',
      '--purge', '--yes', '--read', '--flag', '--unflag', '--password', '--no-password', '--default',
      '--starttls', '-h', '--help',
    ],
    string: [
      '-a', '--account', '--folder', '--limit', '--to', '--cc', '--bcc', '--subject', '--body',
      '--file', '--attach', '--via', '--provider', '--name', '--user', '--imap-host', '--imap-port',
      '--smtp-host', '--smtp-port',
    ],
  });

  if (parsed.flags.has('-h') || parsed.flags.has('--help') || parsed.positional.length === 0) {
    process.stdout.write(USAGE);
    return 0;
  }

  // parseArgs keeps the last value of a repeated flag; --to and --attach are
  // the two that legitimately repeat, so collect them from argv directly.
  const repeated = new Map<string, string[]>();
  for (const flag of ['--to', '--attach', '--cc', '--bcc']) {
    const found: string[] = [];
    for (let index = 0; index < argv.length; index += 1) {
      const item = argv[index]!;
      if (item === flag && argv[index + 1] !== undefined) found.push(argv[index + 1]!);
      else if (item.startsWith(`${flag}=`)) found.push(item.slice(flag.length + 1));
    }
    if (found.length > 1) repeated.set(flag, found.slice(0, -1));
  }

  const [command, ...rest] = parsed.positional;
  const isJson = parsed.flags.has('--json');
  const selector = parsed.values.get('-a') ?? parsed.values.get('--account');
  const folder = parsed.values.get('--folder') ?? 'INBOX';
  const limit = integer(parsed.values, '--limit', 25, { min: 1, max: 5000 });
  const config = loadConfig();

  switch (command) {
    case 'accounts':
    case 'account':
      return accountsVerb(config, rest, parsed);

    case 'folders': {
      const account = selectAccount(config, selector);
      const folders = await withMailbox(account, (box) => box.folders());
      if (isJson) json(folders);
      else out(formatFolders(folders));
      return 0;
    }

    case 'ls':
    case 'list':
    case 'inbox': {
      const accounts = selectAccounts(config, selector);
      const results: { account: string; messages: Awaited<ReturnType<Mailbox['list']>> }[] = [];
      for (const account of accounts) {
        const messages = await withMailbox(account, (box) =>
          box.list(folder, { limit, unreadOnly: parsed.flags.has('--unread') }),
        );
        results.push({ account: account.name, messages });
      }
      if (isJson) {
        json(accounts.length === 1 ? results[0]!.messages : results);
        return 0;
      }
      const width = process.stdout.columns ?? 100;
      out(
        results
          .map(({ account, messages }) =>
            formatList(messages, { width, ...(accounts.length > 1 ? { account } : {}) }),
          )
          .join('\n\n'),
      );
      return 0;
    }

    case 'search': {
      const text = rest.join(' ').trim();
      if (!text) throw new UsageError('search needs a query');
      const accounts = selectAccounts(config, selector);
      const results: { account: string; messages: Awaited<ReturnType<Mailbox['search']>> }[] = [];
      for (const account of accounts) {
        const query = parsed.flags.has('--gmail') ? { gmailraw: text } : parseQuery(text);
        if (parsed.flags.has('--gmail') && account.provider !== 'gmail') {
          process.stderr.write(`mail: --gmail ignored for ${account.name}, which is not a Gmail account\n`);
        }
        const messages = await withMailbox(account, (box) =>
          box.search(folder, account.provider === 'gmail' || !parsed.flags.has('--gmail') ? query : parseQuery(text), limit),
        );
        results.push({ account: account.name, messages });
      }
      if (isJson) {
        json(accounts.length === 1 ? results[0]!.messages : results);
        return 0;
      }
      const width = process.stdout.columns ?? 100;
      out(
        results
          .map(({ account, messages }) =>
            formatList(messages, { width, ...(accounts.length > 1 ? { account } : {}) }),
          )
          .join('\n\n'),
      );
      return 0;
    }

    case 'read':
    case 'show':
    case 'cat': {
      const uid = needUids(rest, 'read')[0]!;
      const account = selectAccount(config, selector);
      await withMailbox(account, async (box) => {
        if (parsed.flags.has('--raw')) {
          process.stdout.write(await box.raw(folder, uid));
        } else {
          const message = await box.read(folder, uid);
          if (isJson) json(message);
          else out(formatMessage(message));
        }
        // PEEK on the way in, so nothing was marked; a client would mark it now.
        if (!parsed.flags.has('--keep-unread')) await box.flag(folder, [uid], ['\\Seen'], []);
      });
      return 0;
    }

    case 'send':
    case 'draft':
    case 'reply': {
      const account = selectAccount(config, selector);
      const via = parsed.values.get('--via') as Transport | undefined;
      if (via !== undefined && via !== 'smtp' && via !== 'resend') {
        throw new UsageError(`--via must be smtp or resend, got "${via}"`);
      }
      const asDraft = command === 'draft' || parsed.flags.has('--draft');
      const attachments = addressesFrom(parsed.values, repeated, '--attach').map((path) => ({
        filename: basename(path),
        path,
      }));

      let outgoing: Outgoing;
      if (command === 'reply') {
        const uid = needUids(rest, 'reply')[0]!;
        const body = await bodyFrom(parsed.values);
        const original = await withMailbox(account, (box) => box.read(folder, uid));
        outgoing = buildReply(original, account, {
          all: parsed.flags.has('--all'),
          body,
          quoteOriginal: !parsed.flags.has('--no-quote'),
        });
        outgoing.cc.push(...addressesFrom(parsed.values, repeated, '--cc'));
        outgoing.bcc.push(...addressesFrom(parsed.values, repeated, '--bcc'));
        outgoing.attachments = attachments;
      } else {
        const to = addressesFrom(parsed.values, repeated, '--to');
        if (to.length === 0) throw new UsageError(`${command} needs --to`);
        const subject = parsed.values.get('--subject');
        if (!subject) throw new UsageError(`${command} needs --subject`);
        outgoing = {
          from: fromHeader(account),
          to,
          cc: addressesFrom(parsed.values, repeated, '--cc'),
          bcc: addressesFrom(parsed.values, repeated, '--bcc'),
          subject,
          text: await bodyFrom(parsed.values),
          attachments,
        };
      }

      if (asDraft) {
        const where = await fileCopy(account, outgoing, 'Drafts');
        if (!where) fail(`no Drafts folder found for ${account.name}, and a draft needs IMAP to be filed`, 1);
        if (isJson) json({ draft: true, folder: where, to: outgoing.to, subject: outgoing.subject });
        else out(`draft saved to ${where} for ${outgoing.to.join(', ')}: ${outgoing.subject}`);
        return 0;
      }

      const resendKey = resolveCredentials(process.env).RESEND_API_KEY;
      const choice = chooseTransport(account, resendKey, via);
      process.stderr.write(`mail: sending via ${choice.transport} (${choice.reason})\n`);
      const result = await sendMail(account, outgoing, {
        ...(resendKey ? { resendKey } : {}),
        ...(via ? { via } : {}),
      });
      if (result.fellBackFrom) {
        process.stderr.write(
          `mail: ${result.fellBackFrom.transport} failed (${result.fellBackFrom.error}); sent via ${result.transport}\n`,
        );
      }
      // SMTP servers file their own Sent copy; Resend never does.
      let filed: string | null = null;
      if (result.transport === 'resend') {
        filed = await fileCopy(account, outgoing, 'Sent').catch((error: Error) => {
          process.stderr.write(`mail: sent, but could not file a Sent copy: ${error.message}\n`);
          return null;
        });
      }
      if (command === 'reply' && account.password) {
        const uid = needUids(rest, 'reply')[0]!;
        await withMailbox(account, (box) => box.flag(folder, [uid], ['\\Answered'], [])).catch(() => undefined);
      }
      if (isJson) json({ transport: result.transport, id: result.id, to: outgoing.to, subject: outgoing.subject, filed });
      else {
        out(`sent via ${result.transport} to ${outgoing.to.join(', ')}: ${outgoing.subject}${result.id ? ` (${result.id})` : ''}`);
        if (filed) out(`copy filed in ${filed}`);
      }
      return 0;
    }

    case 'mark': {
      const uids = needUids(rest, 'mark');
      const add: string[] = [];
      const remove: string[] = [];
      if (parsed.flags.has('--read')) add.push('\\Seen');
      if (parsed.flags.has('--unread')) remove.push('\\Seen');
      if (parsed.flags.has('--flag')) add.push('\\Flagged');
      if (parsed.flags.has('--unflag')) remove.push('\\Flagged');
      if (add.length === 0 && remove.length === 0) {
        throw new UsageError('mark needs one of --read, --unread, --flag, --unflag');
      }
      const account = selectAccount(config, selector);
      await withMailbox(account, (box) => box.flag(folder, uids, add, remove));
      out(`marked ${uids.length} message(s)${add.length ? ` +${add.join(' ')}` : ''}${remove.length ? ` -${remove.join(' ')}` : ''}`);
      return 0;
    }

    case 'mv':
    case 'move': {
      const { uids, rest: named } = splitUids(rest);
      const destination = named[0];
      if (uids.length === 0 || !destination) throw new UsageError('mv needs <uid>… <folder>');
      const account = selectAccount(config, selector);
      await withMailbox(account, (box) => box.move(folder, uids, destination));
      out(`moved ${uids.length} message(s) from ${folder} to ${destination}`);
      return 0;
    }

    case 'archive': {
      const uids = needUids(rest, 'archive');
      const account = selectAccount(config, selector);
      await withMailbox(account, async (box) => {
        const folders: Folder[] = await box.folders();
        const archive = folderFor(folders, 'Archive');
        if (!archive) throw new MailError(`no Archive folder for ${account.name} — use \`mail mv … <folder>\``);
        // Gmail's "archive" is removing the Inbox label; a move to All Mail is
        // how that looks over IMAP.
        await box.move(folder, uids, archive);
        out(`archived ${uids.length} message(s) to ${archive}`);
      });
      return 0;
    }

    case 'rm':
    case 'delete':
    case 'trash': {
      const uids = needUids(rest, 'rm');
      const account = selectAccount(config, selector);
      const purge = parsed.flags.has('--purge');
      if (purge && !parsed.flags.has('--yes')) {
        if (!(await confirm(`expunge ${uids.length} message(s) from ${folder} for good?`))) {
          fail(process.stdin.isTTY ? 'cancelled' : 'not a terminal — pass --yes to purge non-interactively', 1);
        }
      }
      await withMailbox(account, async (box) => {
        if (purge) {
          await box.expunge(folder, uids);
          out(`expunged ${uids.length} message(s) from ${folder}`);
          return;
        }
        const trash = folderFor(await box.folders(), 'Trash');
        if (!trash) throw new MailError(`no Trash folder for ${account.name} — use --purge to expunge instead`);
        if (trash === folder) {
          await box.expunge(folder, uids);
          out(`expunged ${uids.length} message(s) already in ${folder}`);
          return;
        }
        await box.move(folder, uids, trash);
        out(`moved ${uids.length} message(s) to ${trash}`);
      });
      return 0;
    }

    default:
      throw new UsageError(`unknown command: ${command}`);
  }
}

if (isMain(import.meta.url)) {
  main(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((error: unknown) => {
      if (error instanceof UsageError) {
        process.stderr.write(`${USAGE}\n`);
        fail(error.message);
      }
      if (error instanceof MailError) fail(error.message, 1);
      fail(error instanceof Error ? error.message : String(error), 1);
    });
}
