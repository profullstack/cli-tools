/**
 * Mail from the command line: read, search, reply, send, file, delete.
 *
 * Two mailboxes live here, a business one and a personal one, and the point
 * of the command is to reach either without a browser tab — the inbox is read
 * over IMAP, and a message goes out over the account's SMTP or, for a domain
 * the team has verified there, through Resend.
 *
 * Three facts shape the code below.
 *
 * **Accounts are configuration, not code.** This repository is public. The
 * addresses, the providers and the passwords live in `~/.config/cli-tools/
 * mail.json` (0600) and can be imported from a logicsrc vault; nothing here
 * names a person. A password exported as `MAIL_<NAME>_PASSWORD` wins over the
 * file, the same rule as {@link ../credentials.ts}.
 *
 * **Resend can only send from a verified domain.** It is the fallback when an
 * account has no SMTP password, or SMTP refuses — but a public webmail address
 * (gmail.com and friends) can never be verified there, so for those accounts
 * SMTP with an app password is the only way out. `chooseTransport` says which
 * applies and why, rather than trying Resend and reporting its 403.
 *
 * **IMAP is the one place the inbox exists.** A message sent through Resend
 * never reaches the Sent folder by itself, so `sendMail` appends a copy over
 * IMAP afterwards, and everything that reads or changes state goes through the
 * {@link Mailbox} interface so tests never open a socket.
 */

import { resolveMx } from 'node:dns/promises';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import { ImapFlow, type FetchMessageObject, type ListResponse, type SearchObject } from 'imapflow';
import { simpleParser, type AddressObject, type ParsedMail } from 'mailparser';
import nodemailer from 'nodemailer';
import MailComposer from 'nodemailer/lib/mail-composer/index.js';

export class MailError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MailError';
  }
}

// ---------------------------------------------------------------------------
// Providers
// ---------------------------------------------------------------------------

/**
 * What a provider accepts as the password over IMAP and SMTP.
 *
 * `account`: the same password as the website. `app`: a separate, generated
 * app password, because the account password is refused on purpose. `alias`:
 * a password generated per address in the provider's dashboard. `bridge`: a
 * local bridge process speaks IMAP/SMTP on localhost and mints its own.
 */
export type PasswordKind = 'account' | 'app' | 'alias' | 'bridge';

export interface Provider {
  /** The name people use for it. */
  label: string;
  imapHost: string;
  imapPort: number;
  /** Implicit TLS on connect (993), as opposed to STARTTLS (143). */
  imapSecure: boolean;
  smtpHost: string;
  smtpPort: number;
  /** Implicit TLS on connect (465), as opposed to STARTTLS (587). */
  smtpSecure: boolean;
  /**
   * Where the host keeps its own certificate, for a bridge on localhost that
   * signs for itself. The first path that exists is trusted in place of the
   * system roots; verification is never switched off. `~` is the home.
   */
  caPaths?: string[];
  passwordKind: PasswordKind;
  /** Where the password comes from, for the setup message. */
  passwordHint: string;
  /** Where to generate it, when there is a page for that. */
  passwordUrl?: string;
  /** Address domains that imply this provider. */
  domains: string[];
  /** Something to know before the first login. */
  note?: string;
}

export type BuiltInProvider =
  | 'forwardemail'
  | 'gmail'
  | 'yahoo'
  | 'aol'
  | 'icloud'
  | 'fastmail'
  | 'zoho'
  | 'proton'
  | 'gmx'
  | 'yandex'
  | 'mailcom'
  | 'posteo'
  | 'mailbox'
  | 'migadu'
  | 'purelymail';

export type ProviderName = BuiltInProvider | 'custom';

/**
 * Every host that still takes a password over IMAP and SMTP, with the ports
 * and the kind of password it wants. A provider whose only way in is OAuth or
 * its own app is in UNSUPPORTED_PROVIDERS instead, with the reason, so
 * `mail login outlook` explains itself rather than failing a login.
 *
 * `custom` exists so any other host is a matter of naming its hosts rather
 * than editing this file.
 */
export const PROVIDERS: Record<BuiltInProvider, Provider> = {
  forwardemail: {
    label: 'Forward Email',
    imapHost: 'imap.forwardemail.net',
    imapPort: 993,
    imapSecure: true,
    smtpHost: 'smtp.forwardemail.net',
    smtpPort: 465,
    smtpSecure: true,
    passwordKind: 'alias',
    passwordHint:
      'the alias password generated in the Forward Email dashboard (Aliases → the address → ' +
      'Generate Password); it is shown once',
    passwordUrl: 'https://forwardemail.net/my-account/domains',
    domains: ['forwardemail.net'],
    note: 'The address must have IMAP/SMTP storage enabled on its alias; forwarding-only aliases have no mailbox.',
  },
  gmail: {
    label: 'Gmail / Google Workspace',
    imapHost: 'imap.gmail.com',
    imapPort: 993,
    imapSecure: true,
    smtpHost: 'smtp.gmail.com',
    smtpPort: 465,
    smtpSecure: true,
    passwordKind: 'app',
    passwordHint:
      'an App Password from https://myaccount.google.com/apppasswords (needs 2-step ' +
      'verification on the account); the normal account password is refused',
    passwordUrl: 'https://myaccount.google.com/apppasswords',
    domains: ['gmail.com', 'googlemail.com'],
    note: 'A Workspace domain works the same way once its admin has left IMAP on.',
  },
  yahoo: {
    label: 'Yahoo Mail',
    imapHost: 'imap.mail.yahoo.com',
    imapPort: 993,
    imapSecure: true,
    smtpHost: 'smtp.mail.yahoo.com',
    smtpPort: 465,
    smtpSecure: true,
    passwordKind: 'app',
    passwordHint:
      'an app password from Account Security → Generate app password; the account password is refused',
    passwordUrl: 'https://login.yahoo.com/account/security',
    domains: ['yahoo.com', 'yahoo.co.uk', 'yahoo.ca', 'yahoo.com.au', 'yahoo.fr', 'yahoo.de', 'ymail.com', 'rocketmail.com'],
  },
  aol: {
    label: 'AOL Mail',
    imapHost: 'imap.aol.com',
    imapPort: 993,
    imapSecure: true,
    smtpHost: 'smtp.aol.com',
    smtpPort: 465,
    smtpSecure: true,
    passwordKind: 'app',
    passwordHint: 'an app password from Account Security → Generate app password',
    passwordUrl: 'https://login.aol.com/account/security',
    domains: ['aol.com', 'aim.com'],
  },
  icloud: {
    label: 'iCloud Mail',
    imapHost: 'imap.mail.me.com',
    imapPort: 993,
    imapSecure: true,
    smtpHost: 'smtp.mail.me.com',
    smtpPort: 587,
    smtpSecure: false,
    passwordKind: 'app',
    passwordHint:
      'an app-specific password from the Apple Account page (Sign-In and Security → App-Specific ' +
      'Passwords); needs two-factor authentication on the Apple Account',
    passwordUrl: 'https://account.apple.com/account/manage',
    domains: ['icloud.com', 'me.com', 'mac.com'],
    note: 'Log in with the full address, including a custom iCloud domain.',
  },
  fastmail: {
    label: 'Fastmail',
    imapHost: 'imap.fastmail.com',
    imapPort: 993,
    imapSecure: true,
    smtpHost: 'smtp.fastmail.com',
    smtpPort: 465,
    smtpSecure: true,
    passwordKind: 'app',
    passwordHint:
      'an app password from Settings → Privacy & Security → Integrations → New app password; ' +
      'the account password is refused by third-party clients',
    passwordUrl: 'https://app.fastmail.com/settings/security/devices',
    domains: ['fastmail.com', 'fastmail.fm', 'fastmail.us', 'sent.com'],
  },
  zoho: {
    label: 'Zoho Mail',
    imapHost: 'imap.zoho.com',
    imapPort: 993,
    imapSecure: true,
    smtpHost: 'smtp.zoho.com',
    smtpPort: 465,
    smtpSecure: true,
    passwordKind: 'app',
    passwordHint:
      'the account password, or an application-specific password when two-factor authentication ' +
      'is on (Zoho Accounts → Security → App Passwords)',
    passwordUrl: 'https://accounts.zoho.com/home#security/security_password',
    domains: ['zoho.com', 'zohomail.com', 'zoho.eu', 'zoho.in'],
    note:
      'IMAP has to be switched on first (Zoho Mail → Settings → Mail Accounts → IMAP Access). ' +
      'An EU or IN data centre uses imap.zoho.eu / smtp.zoho.eu or .in — pass --imap-host and --smtp-host.',
  },
  proton: {
    label: 'Proton Mail (through Proton Mail Bridge)',
    imapHost: '127.0.0.1',
    imapPort: 1143,
    imapSecure: false,
    smtpHost: '127.0.0.1',
    smtpPort: 1025,
    smtpSecure: false,
    caPaths: [
      '~/.config/protonmail/bridge-v3/cert.pem',
      '~/Library/Application Support/protonmail/bridge-v3/cert.pem',
      '~/AppData/Roaming/protonmail/bridge-v3/cert.pem',
    ],
    passwordKind: 'bridge',
    passwordHint:
      'the password Proton Mail Bridge shows for the account (Bridge → the account → Mailbox ' +
      'configuration), not the Proton password',
    passwordUrl: 'https://proton.me/mail/bridge',
    domains: ['proton.me', 'protonmail.com', 'protonmail.ch', 'pm.me'],
    note:
      'Proton has no IMAP of its own: the Bridge app must be installed, signed in and running on this ' +
      'machine, and it needs a paid Proton plan. It serves STARTTLS on localhost with a certificate of its ' +
      'own; the copy Bridge keeps at its usual path is trusted automatically, or pass --tls-ca with the file ' +
      'from Bridge → Settings → Advanced settings → Export TLS certificates.',
  },
  gmx: {
    label: 'GMX',
    imapHost: 'imap.gmx.com',
    imapPort: 993,
    imapSecure: true,
    smtpHost: 'mail.gmx.com',
    smtpPort: 465,
    smtpSecure: true,
    passwordKind: 'account',
    passwordHint: 'the account password, once IMAP is enabled (Settings → POP3/IMAP)',
    domains: ['gmx.com', 'gmx.us', 'gmx.net', 'gmx.de', 'gmx.at', 'gmx.ch'],
    note: 'A gmx.net / .de / .at / .ch address may prefer imap.gmx.net and mail.gmx.net — pass --imap-host and --smtp-host.',
  },
  yandex: {
    label: 'Yandex Mail',
    imapHost: 'imap.yandex.com',
    imapPort: 993,
    imapSecure: true,
    smtpHost: 'smtp.yandex.com',
    smtpPort: 465,
    smtpSecure: true,
    passwordKind: 'app',
    passwordHint: 'an app password from Yandex ID → Security → App passwords',
    passwordUrl: 'https://id.yandex.com/security/app-passwords',
    domains: ['yandex.com', 'yandex.ru', 'ya.ru'],
  },
  mailcom: {
    label: 'mail.com',
    imapHost: 'imap.mail.com',
    imapPort: 993,
    imapSecure: true,
    smtpHost: 'smtp.mail.com',
    smtpPort: 465,
    smtpSecure: true,
    passwordKind: 'account',
    passwordHint: 'the account password, once IMAP is enabled (Settings → POP3/IMAP)',
    domains: ['mail.com', 'email.com', 'usa.com', 'consultant.com', 'engineer.com', 'post.com'],
  },
  posteo: {
    label: 'Posteo',
    imapHost: 'posteo.de',
    imapPort: 993,
    imapSecure: true,
    smtpHost: 'posteo.de',
    smtpPort: 465,
    smtpSecure: true,
    passwordKind: 'account',
    passwordHint: 'the account password',
    domains: ['posteo.de', 'posteo.net', 'posteo.eu', 'posteo.org'],
  },
  mailbox: {
    label: 'mailbox.org',
    imapHost: 'imap.mailbox.org',
    imapPort: 993,
    imapSecure: true,
    smtpHost: 'smtp.mailbox.org',
    smtpPort: 465,
    smtpSecure: true,
    passwordKind: 'account',
    passwordHint: 'the account password, or an app password when two-factor authentication is on',
    domains: ['mailbox.org'],
  },
  migadu: {
    label: 'Migadu',
    imapHost: 'imap.migadu.com',
    imapPort: 993,
    imapSecure: true,
    smtpHost: 'smtp.migadu.com',
    smtpPort: 465,
    smtpSecure: true,
    passwordKind: 'account',
    passwordHint: 'the mailbox password set in the Migadu admin',
    domains: [],
  },
  purelymail: {
    label: 'Purelymail',
    imapHost: 'mailserver.purelymail.com',
    imapPort: 993,
    imapSecure: true,
    smtpHost: 'mailserver.purelymail.com',
    smtpPort: 465,
    smtpSecure: true,
    passwordKind: 'account',
    passwordHint: 'the account password',
    domains: ['purelymail.com'],
  },
};

export const PROVIDER_NAMES = Object.keys(PROVIDERS) as BuiltInProvider[];

export function isProviderName(value: unknown): value is ProviderName {
  return value === 'custom' || (typeof value === 'string' && Object.hasOwn(PROVIDERS, value));
}

/** The preset for a provider, or null for `custom`. */
export function providerFor(name: ProviderName): Provider | null {
  return name === 'custom' ? null : PROVIDERS[name];
}

export interface UnsupportedProvider {
  label: string;
  domains: string[];
  reason: string;
}

/**
 * Hosts a password cannot reach. Named so `mail login <name>` and an address
 * on one of their domains get the reason instead of a login failure.
 */
export const UNSUPPORTED_PROVIDERS: Record<string, UnsupportedProvider> = {
  outlook: {
    label: 'Outlook.com / Hotmail / Live',
    domains: ['outlook.com', 'hotmail.com', 'live.com', 'msn.com'],
    reason:
      'Microsoft removed password (basic) authentication — for Microsoft 365 IMAP in October 2022 and for ' +
      'personal accounts on 2024-09-16: IMAP and SMTP now take only OAuth2 tokens, and app passwords no ' +
      'longer count. Use Outlook or a client with Microsoft sign-in.',
  },
  tuta: {
    label: 'Tuta (Tutanota)',
    domains: ['tuta.com', 'tuta.io', 'tutanota.com', 'tutanota.de', 'tutamail.com', 'keemail.me'],
    reason: "no IMAP or SMTP at all; the mailbox is only reachable through Tuta's own apps",
  },
  hey: {
    label: 'HEY',
    domains: ['hey.com'],
    reason: 'no IMAP or SMTP; HEY only offers its own apps',
  },
};

/** Domains no one can verify at a sending service: the mail belongs to the webmail host. */
const WEBMAIL_DOMAINS = new Set([
  ...Object.values(PROVIDERS).flatMap((provider) => provider.domains),
  ...Object.values(UNSUPPORTED_PROVIDERS).flatMap((provider) => provider.domains),
]);
WEBMAIL_DOMAINS.delete('forwardemail.net');

export function domainOf(email: string): string {
  const at = email.lastIndexOf('@');
  return at === -1 ? '' : email.slice(at + 1).toLowerCase();
}

/** The provider an address implies, when it implies one. */
export function guessProvider(email: string): BuiltInProvider | null {
  const domain = domainOf(email);
  for (const name of PROVIDER_NAMES) {
    if (PROVIDERS[name].domains.includes(domain)) return name;
  }
  return null;
}

/** The unsupported host an address or a name points at, when it does. */
export function unsupportedProvider(nameOrEmail: string): (UnsupportedProvider & { name: string }) | null {
  const key = nameOrEmail.toLowerCase();
  const domain = domainOf(key);
  for (const [name, provider] of Object.entries(UNSUPPORTED_PROVIDERS)) {
    if (name === key || (domain && provider.domains.includes(domain))) return { name, ...provider };
  }
  return null;
}

/** MX host suffixes that give away the provider behind a custom domain. */
const MX_SIGNATURES: [suffix: string, provider: BuiltInProvider][] = [
  ['forwardemail.net', 'forwardemail'],
  ['google.com', 'gmail'],
  ['googlemail.com', 'gmail'],
  ['zoho.com', 'zoho'],
  ['zoho.eu', 'zoho'],
  ['zoho.in', 'zoho'],
  ['messagingengine.com', 'fastmail'],
  ['protonmail.ch', 'proton'],
  ['icloud.com', 'icloud'],
  ['migadu.com', 'migadu'],
  ['purelymail.com', 'purelymail'],
  ['mailbox.org', 'mailbox'],
  ['posteo.de', 'posteo'],
  ['yandex.net', 'yandex'],
];

/** MX suffixes of hosts a password cannot reach; the value names UNSUPPORTED_PROVIDERS. */
const MX_UNSUPPORTED: [suffix: string, name: string][] = [['protection.outlook.com', 'outlook'], ['outlook.com', 'outlook']];

export type MxResolver = (domain: string) => Promise<{ exchange: string; priority: number }[]>;

export type MxGuess = { provider: BuiltInProvider } | { unsupported: UnsupportedProvider & { name: string } };

/**
 * The provider a custom domain's MX records point at, when they point at one
 * we know. A domain hosted at Google, Zoho, Fastmail, Proton, iCloud,
 * Forward Email and the like has its own name on the address and the host's
 * name in DNS; this reads the second so `mail login you@yourdomain.com`
 * needs no provider spelled out. A lookup that fails is simply no answer.
 */
export async function providerFromMx(email: string, resolve: MxResolver = resolveMx): Promise<MxGuess | null> {
  const domain = domainOf(email);
  if (!domain) return null;
  let records: { exchange: string; priority: number }[];
  try {
    records = await resolve(domain);
  } catch {
    return null;
  }
  const hosts = [...records]
    .sort((a, b) => a.priority - b.priority)
    .map((record) => record.exchange.toLowerCase().replace(/\.$/, ''));
  const matches = (host: string, suffix: string) => host === suffix || host.endsWith(`.${suffix}`);
  for (const host of hosts) {
    for (const [suffix, provider] of MX_SIGNATURES) if (matches(host, suffix)) return { provider };
    for (const [suffix, name] of MX_UNSUPPORTED) {
      if (matches(host, suffix)) return { unsupported: { name, ...UNSUPPORTED_PROVIDERS[name]! } };
    }
  }
  return null;
}

/** The lines to show before asking for a provider's password. */
export function loginHint(provider: Provider): string {
  const kind: Record<PasswordKind, string> = {
    account: `${provider.label} takes the account password.`,
    app: `${provider.label} takes an app password, not the account password.`,
    alias: `${provider.label} takes a password generated per address.`,
    bridge: `${provider.label} takes the password its local bridge generates.`,
  };
  const lines = [kind[provider.passwordKind], `  ${provider.passwordHint}`];
  if (provider.passwordUrl) lines.push(`  ${provider.passwordUrl}`);
  if (provider.note) lines.push(`  ${provider.note}`);
  return lines.join('\n');
}

/** The providers table for `mail providers`. */
export function formatProviders(): string {
  const kinds: Record<PasswordKind, string> = {
    account: 'account password',
    app: 'app password',
    alias: 'per-address password',
    bridge: 'bridge password',
  };
  const width = Math.max(...PROVIDER_NAMES.map((name) => name.length), 'custom'.length);
  const rows = PROVIDER_NAMES.map((name) => {
    const provider = PROVIDERS[name];
    const imap = `${provider.imapHost}:${provider.imapPort}${provider.imapSecure ? '' : ' (STARTTLS)'}`;
    const smtp = `${provider.smtpHost}:${provider.smtpPort}${provider.smtpSecure ? '' : ' (STARTTLS)'}`;
    return (
      `  ${name.padEnd(width)}  ${provider.label}\n` +
      `${' '.repeat(width + 4)}${kinds[provider.passwordKind]}; imap ${imap}; smtp ${smtp}`
    );
  });
  rows.push(
    `  ${'custom'.padEnd(width)}  any other host: --imap-host H --smtp-host H [--imap-port N --smtp-port N --starttls --imap-starttls]`,
  );
  const unsupported = Object.entries(UNSUPPORTED_PROVIDERS).map(
    ([name, provider]) => `  ${name.padEnd(width)}  ${provider.label}: ${provider.reason}`,
  );
  return ['Providers (`mail login <name> <address>`):', ...rows, '', 'Not reachable with a password:', ...unsupported].join(
    '\n',
  );
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface AccountConfig {
  email: string;
  provider: ProviderName;
  /** Display name for the From header. */
  name?: string;
  /** Login, when it is not the address itself. */
  user?: string;
  password?: string;
  imapHost?: string;
  imapPort?: number;
  imapSecure?: boolean;
  smtpHost?: string;
  smtpPort?: number;
  smtpSecure?: boolean;
  /** A PEM file to trust in place of the system roots — a local bridge's own certificate. */
  tlsCa?: string;
}

export interface MailConfig {
  default?: string;
  accounts: Record<string, AccountConfig>;
}

export type PasswordSource = 'env' | 'file' | 'unset';

/** An account with every host filled in and the password resolved. */
export interface Account {
  name: string;
  email: string;
  displayName: string | null;
  user: string;
  password: string | null;
  passwordSource: PasswordSource;
  provider: ProviderName;
  imap: { host: string; port: number; secure: boolean };
  smtp: { host: string; port: number; secure: boolean };
  /** Path of the certificate to trust instead of the system roots, when there is one. */
  tlsCa: string | null;
}

function xdgConfigHome(env: NodeJS.ProcessEnv): string {
  return env.XDG_CONFIG_HOME || join(homedir(), '.config');
}

export function mailConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  return env.CLI_TOOLS_MAIL_CONFIG || join(xdgConfigHome(env), 'cli-tools', 'mail.json');
}

/** The environment variable that overrides a stored password. */
export function passwordVariable(name: string): string {
  return `MAIL_${name.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_PASSWORD`;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): MailConfig {
  const path = mailConfigPath(env);
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return { accounts: {} };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new MailError(`${path}: not valid JSON — ${(error as Error).message}`);
  }
  return normalizeConfig(parsed);
}

/** Accept only the shape we write, so a hand edit cannot smuggle in nonsense. */
export function normalizeConfig(parsed: unknown): MailConfig {
  const config: MailConfig = { accounts: {} };
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return config;
  const record = parsed as Record<string, unknown>;
  if (typeof record.default === 'string' && record.default.trim()) config.default = record.default.trim();

  const accounts = record.accounts;
  if (!accounts || typeof accounts !== 'object' || Array.isArray(accounts)) return config;
  for (const [name, raw] of Object.entries(accounts as Record<string, unknown>)) {
    if (!raw || typeof raw !== 'object') continue;
    const entry = raw as Record<string, unknown>;
    if (typeof entry.email !== 'string' || !entry.email.includes('@')) continue;
    const provider = entry.provider;
    const account: AccountConfig = {
      email: entry.email.trim().toLowerCase(),
      provider: isProviderName(provider) ? provider : (guessProvider(entry.email) ?? 'custom'),
    };
    for (const key of ['name', 'user', 'password', 'imapHost', 'smtpHost', 'tlsCa'] as const) {
      const value = entry[key];
      if (typeof value === 'string' && value.trim()) account[key] = value.trim();
    }
    for (const key of ['imapPort', 'smtpPort'] as const) {
      const value = entry[key];
      if (typeof value === 'number' && Number.isInteger(value) && value > 0) account[key] = value;
    }
    for (const key of ['imapSecure', 'smtpSecure'] as const) {
      const value = entry[key];
      if (typeof value === 'boolean') account[key] = value;
    }
    config.accounts[name] = account;
  }
  return config;
}

export function saveConfig(config: MailConfig, env: NodeJS.ProcessEnv = process.env): string {
  const path = mailConfigPath(env);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  // The mode only applies on create; an existing file keeps a hand-set one.
  chmodSync(path, 0o600);
  return path;
}

function expandHome(path: string): string {
  return path.startsWith('~/') ? join(homedir(), path.slice(2)) : path;
}

/**
 * The certificate an account pins, read for the TLS options.
 *
 * Trusting one file in place of the system roots keeps verification on:
 * the bridge's certificate must still match, and a stranger's will not. A
 * path that cannot be read is an error at connect time, not a silent
 * downgrade.
 */
export function trustedCa(account: Account): { ca: Buffer } | null {
  if (!account.tlsCa) return null;
  try {
    return { ca: readFileSync(account.tlsCa) };
  } catch (error) {
    throw new MailError(
      `account "${account.name}" pins the certificate at ${account.tlsCa}, which cannot be read: ` +
        `${(error as Error).message}`,
    );
  }
}

/** Fill hosts from the provider and resolve the password, environment first. */
export function resolveAccount(
  name: string,
  config: AccountConfig,
  env: NodeJS.ProcessEnv = process.env,
): Account {
  const preset = providerFor(config.provider);
  const imapHost = config.imapHost ?? preset?.imapHost;
  const smtpHost = config.smtpHost ?? preset?.smtpHost;
  if (!imapHost || !smtpHost) {
    throw new MailError(
      `account "${name}" is provider "custom" and needs imapHost and smtpHost — ` +
        `set them with \`mail login custom ${config.email} --imap-host … --smtp-host …\``,
    );
  }

  const fromEnv = env[passwordVariable(name)];
  const password = fromEnv || config.password || null;
  const passwordSource: PasswordSource = fromEnv ? 'env' : config.password ? 'file' : 'unset';

  const imapPort = config.imapPort ?? preset?.imapPort ?? 993;
  const smtpPort = config.smtpPort ?? preset?.smtpPort ?? 465;
  return {
    name,
    email: config.email,
    displayName: config.name ?? null,
    user: config.user ?? config.email,
    password,
    passwordSource,
    provider: config.provider,
    imap: {
      host: imapHost,
      port: imapPort,
      // 993 is implicit TLS everywhere; anything else is STARTTLS unless told.
      secure: config.imapSecure ?? (preset ? preset.imapSecure : imapPort === 993),
    },
    smtp: {
      host: smtpHost,
      port: smtpPort,
      // 465 is implicit TLS everywhere; anything else is STARTTLS unless told.
      secure: config.smtpSecure ?? (preset ? preset.smtpSecure : smtpPort === 465),
    },
    tlsCa: config.tlsCa ?? preset?.caPaths?.map(expandHome).find((path) => existsSync(path)) ?? null,
  };
}

/**
 * Which account a selector means.
 *
 * A name, an address, `all`, or nothing — nothing is the configured default,
 * or the only account when there is exactly one. With two accounts and no
 * default, "nothing" is a question, not a guess.
 */
export function selectAccounts(
  config: MailConfig,
  selector: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): Account[] {
  const names = Object.keys(config.accounts);
  if (names.length === 0) {
    throw new MailError(
      'no mail accounts configured. Add one with `mail accounts add work you@example.com`, ' +
        'or `mail accounts pull` to import them from the team vault.',
    );
  }

  const wanted = (selector ?? env.MAIL_ACCOUNT ?? '').trim();
  if (wanted.toLowerCase() === 'all') {
    return names.map((name) => resolveAccount(name, config.accounts[name]!, env));
  }

  let name: string | undefined;
  if (wanted) {
    name =
      names.find((candidate) => candidate === wanted) ??
      names.find((candidate) => config.accounts[candidate]!.email === wanted.toLowerCase());
    if (!name) {
      throw new MailError(`no account "${wanted}". Configured: ${names.join(', ')}`);
    }
  } else if (config.default && config.accounts[config.default]) {
    name = config.default;
  } else if (names.length === 1) {
    name = names[0]!;
  } else {
    throw new MailError(
      `which account? Pass --account (${names.join(', ')}), export MAIL_ACCOUNT, ` +
        'or set one as the default with `mail accounts default <name>`.',
    );
  }
  return [resolveAccount(name, config.accounts[name]!, env)];
}

export function selectAccount(
  config: MailConfig,
  selector: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): Account {
  const accounts = selectAccounts(config, selector, env);
  if (accounts.length !== 1) {
    throw new MailError('this command works on one account at a time — name it with --account');
  }
  return accounts[0]!;
}

// ---------------------------------------------------------------------------
// Vault import
// ---------------------------------------------------------------------------

/** The vault that holds the mailboxes, separate from the shared API keys. */
export const MAIL_VAULT_PROJECT = 'cli-tools-mail';

/**
 * Accounts as a vault spells them: one prefix per account.
 *
 *   MAIL_WORK_EMAIL=you@example.com
 *   MAIL_WORK_PROVIDER=forwardemail
 *   MAIL_WORK_PASSWORD=…
 *   MAIL_WORK_NAME="Your Name"          optional
 *   MAIL_WORK_USER=…                    optional, when the login is not the address
 *   MAIL_WORK_IMAP_HOST / _IMAP_PORT / _SMTP_HOST / _SMTP_PORT / _SMTP_SECURE
 *   MAIL_DEFAULT=work                   optional
 *
 * A dotenv vault cannot hold structure, so the account name is the middle of
 * the key and is lower-cased on the way in. `MAIL_DEFAULT` and the password
 * variables are the same names the environment override reads, so what is in
 * the vault and what is exported never disagree about spelling.
 */
export function accountsFromVault(vault: Record<string, string>): MailConfig {
  const config: MailConfig = { accounts: {} };
  const pattern =
    /^MAIL_([A-Z0-9_]+?)_(EMAIL|PROVIDER|PASSWORD|NAME|USER|IMAP_HOST|IMAP_PORT|IMAP_SECURE|SMTP_HOST|SMTP_PORT|SMTP_SECURE|TLS_CA)$/;
  const partial: Record<string, Record<string, string>> = {};

  for (const [key, value] of Object.entries(vault)) {
    if (key === 'MAIL_DEFAULT') {
      config.default = value.trim().toLowerCase();
      continue;
    }
    const match = pattern.exec(key);
    if (!match) continue;
    const name = match[1]!.toLowerCase();
    (partial[name] ??= {})[match[2]!] = value.trim();
  }

  for (const [name, fields] of Object.entries(partial)) {
    const email = fields.EMAIL;
    if (!email || !email.includes('@')) continue;
    const provider = fields.PROVIDER?.toLowerCase();
    const account: AccountConfig = {
      email: email.toLowerCase(),
      provider: isProviderName(provider)
        ? provider
        : (guessProvider(email) ?? (fields.IMAP_HOST ? 'custom' : 'forwardemail')),
    };
    if (fields.PASSWORD) account.password = fields.PASSWORD;
    if (fields.NAME) account.name = fields.NAME;
    if (fields.USER) account.user = fields.USER;
    if (fields.IMAP_HOST) account.imapHost = fields.IMAP_HOST;
    if (fields.SMTP_HOST) account.smtpHost = fields.SMTP_HOST;
    if (fields.IMAP_PORT && /^\d+$/.test(fields.IMAP_PORT)) account.imapPort = Number(fields.IMAP_PORT);
    if (fields.SMTP_PORT && /^\d+$/.test(fields.SMTP_PORT)) account.smtpPort = Number(fields.SMTP_PORT);
    if (fields.IMAP_SECURE) account.imapSecure = /^(true|1|yes)$/i.test(fields.IMAP_SECURE);
    if (fields.SMTP_SECURE) account.smtpSecure = /^(true|1|yes)$/i.test(fields.SMTP_SECURE);
    if (fields.TLS_CA) account.tlsCa = fields.TLS_CA;
    config.accounts[name] = account;
  }

  if (config.default && !config.accounts[config.default]) delete config.default;
  return config;
}

/**
 * Bring vault accounts into the local config.
 *
 * The vault wins for every field it names, and a local account the vault does
 * not mention is left alone — an account added by hand on this machine is not
 * an error in the vault.
 */
export function mergeVaultAccounts(
  local: MailConfig,
  fromVault: MailConfig,
): { merged: MailConfig; imported: string[]; unchanged: string[] } {
  const merged: MailConfig = { ...local, accounts: { ...local.accounts } };
  const imported: string[] = [];
  const unchanged: string[] = [];
  for (const [name, account] of Object.entries(fromVault.accounts)) {
    const existing = local.accounts[name];
    if (existing && JSON.stringify(existing) === JSON.stringify(account)) {
      unchanged.push(name);
      continue;
    }
    merged.accounts[name] = account;
    imported.push(name);
  }
  if (fromVault.default) merged.default = fromVault.default;
  else if (!merged.default && Object.keys(merged.accounts).length === 1) {
    merged.default = Object.keys(merged.accounts)[0]!;
  }
  return { merged, imported: imported.sort(), unchanged: unchanged.sort() };
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

export interface MessageSummary {
  uid: number;
  seq: number;
  date: string | null;
  from: string;
  to: string;
  subject: string;
  seen: boolean;
  flagged: boolean;
  answered: boolean;
  size: number | null;
  messageId: string | null;
}

export interface Attachment {
  filename: string;
  contentType: string;
  size: number;
}

export interface FullMessage extends MessageSummary {
  cc: string;
  replyTo: string;
  inReplyTo: string | null;
  references: string[];
  text: string;
  html: string | null;
  attachments: Attachment[];
}

export interface Folder {
  path: string;
  specialUse: string | null;
  delimiter: string;
}

export interface ListOptions {
  limit: number;
  unreadOnly?: boolean;
}

/**
 * Everything the command does to a mailbox, so the network is one
 * implementation of it and a test can be another.
 */
export interface Mailbox {
  folders(): Promise<Folder[]>;
  list(folder: string, options: ListOptions): Promise<MessageSummary[]>;
  search(folder: string, query: SearchObject, limit: number): Promise<MessageSummary[]>;
  read(folder: string, uid: number): Promise<FullMessage>;
  raw(folder: string, uid: number): Promise<Buffer>;
  flag(folder: string, uids: number[], add: string[], remove: string[]): Promise<void>;
  move(folder: string, uids: number[], destination: string): Promise<void>;
  expunge(folder: string, uids: number[]): Promise<void>;
  append(folder: string, raw: Buffer, flags: string[]): Promise<void>;
  close(): Promise<void>;
}

/** Format an address list as a header would: `Name <addr>, addr`. */
export function formatAddresses(list: { name?: string; address?: string }[] | undefined): string {
  if (!list) return '';
  return list
    .map((entry) => {
      const address = entry.address ?? '';
      const name = (entry.name ?? '').trim();
      if (!name) return address;
      return address ? `${name} <${address}>` : name;
    })
    .filter(Boolean)
    .join(', ');
}

/** The bare address out of `Name <addr>`, lower-cased. */
export function bareAddress(formatted: string): string {
  const match = /<([^>]+)>/.exec(formatted);
  return (match ? match[1]! : formatted).trim().toLowerCase();
}

/** Split a header-style list on commas that are outside quotes and brackets. */
export function splitAddresses(value: string): string[] {
  const out: string[] = [];
  let current = '';
  let depth = 0;
  let quoted = false;
  for (const char of value) {
    if (char === '"') quoted = !quoted;
    else if (!quoted && char === '<') depth += 1;
    else if (!quoted && char === '>') depth = Math.max(0, depth - 1);
    if (char === ',' && !quoted && depth === 0) {
      if (current.trim()) out.push(current.trim());
      current = '';
      continue;
    }
    current += char;
  }
  if (current.trim()) out.push(current.trim());
  return out;
}

/** What `fetch` returns, as the command wants to see it. */
export function summaryFrom(message: FetchMessageObject): MessageSummary {
  const envelope = message.envelope ?? {};
  const flags = message.flags ?? new Set<string>();
  const date = envelope.date ?? (message.internalDate ? new Date(message.internalDate) : null);
  return {
    uid: message.uid,
    seq: message.seq,
    date: date && !Number.isNaN(date.getTime()) ? date.toISOString() : null,
    from: formatAddresses(envelope.from),
    to: formatAddresses(envelope.to),
    subject: envelope.subject ?? '',
    seen: flags.has('\\Seen'),
    flagged: flags.has('\\Flagged'),
    answered: flags.has('\\Answered'),
    size: typeof message.size === 'number' ? message.size : null,
    messageId: envelope.messageId ?? null,
  };
}

function addressText(value: AddressObject | AddressObject[] | undefined): string {
  if (!value) return '';
  const list = Array.isArray(value) ? value : [value];
  return list.map((entry) => entry.text).filter(Boolean).join(', ');
}

/** A parsed message joined to the flags and uid IMAP knows about it. */
export function fullFrom(summary: MessageSummary, parsed: ParsedMail): FullMessage {
  const references = parsed.references
    ? Array.isArray(parsed.references)
      ? parsed.references
      : [parsed.references]
    : [];
  return {
    ...summary,
    // The envelope is what the server indexed; the parsed headers are the
    // message itself. Prefer the message when it has the field.
    from: addressText(parsed.from) || summary.from,
    to: addressText(parsed.to) || summary.to,
    subject: parsed.subject ?? summary.subject,
    date: parsed.date ? parsed.date.toISOString() : summary.date,
    messageId: parsed.messageId ?? summary.messageId,
    cc: addressText(parsed.cc),
    replyTo: addressText(parsed.replyTo),
    inReplyTo: parsed.inReplyTo ?? null,
    references,
    text: parsed.text ?? (parsed.html ? stripHtml(parsed.html) : ''),
    html: typeof parsed.html === 'string' ? parsed.html : null,
    attachments: (parsed.attachments ?? []).map((attachment) => ({
      filename: attachment.filename ?? '(unnamed)',
      contentType: attachment.contentType,
      size: attachment.size,
    })),
  };
}

/** Enough of an HTML-only message to read it; not a renderer. */
export function stripHtml(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6]|tr)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

/**
 * `from:alice subject:"pottery wheel" since:2026-09-01 unread invoice`
 *
 * Bare words search the text; `key:value` narrows a header. Dates are
 * `YYYY-MM-DD`. Quotes group a value with spaces. Gmail's own search language
 * is far richer; `--gmail` hands the whole string to it instead.
 */
export function parseQuery(input: string): SearchObject {
  const query: SearchObject = {};
  const text: string[] = [];
  const tokens = input.match(/(?:[^\s"]+|"[^"]*")+/g) ?? [];

  for (const token of tokens) {
    const at = token.indexOf(':');
    const key = at === -1 ? '' : token.slice(0, at).toLowerCase();
    const rawValue = at === -1 ? token : token.slice(at + 1);
    const value = rawValue.replace(/^"|"$/g, '');

    switch (key) {
      case 'from':
      case 'to':
      case 'cc':
      case 'subject':
      case 'body':
        query[key] = value;
        break;
      case 'since':
      case 'before':
      case 'on':
        if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
          throw new MailError(`${key}: must be YYYY-MM-DD, got ${JSON.stringify(rawValue)}`);
        }
        query[key] = new Date(`${value}T00:00:00Z`);
        break;
      case 'is':
        if (value === 'unread') query.seen = false;
        else if (value === 'read') query.seen = true;
        else if (value === 'flagged' || value === 'starred') query.flagged = true;
        else if (value === 'answered') query.answered = true;
        else throw new MailError(`is:${value} — expected unread, read, flagged or answered`);
        break;
      case '':
        if (value === 'unread') query.seen = false;
        else if (value === 'flagged' || value === 'starred') query.flagged = true;
        else if (value) text.push(value);
        break;
      default:
        throw new MailError(
          `unknown search key "${key}:" — use from:, to:, cc:, subject:, body:, since:, before:, on:, is:`,
        );
    }
  }

  if (text.length > 0) query.text = text.join(' ');
  return query;
}

// ---------------------------------------------------------------------------
// IMAP
// ---------------------------------------------------------------------------

const SUMMARY_FIELDS = { uid: true, flags: true, envelope: true, size: true, internalDate: true } as const;

/** Open the account's mailbox over IMAP. */
/** An IMAP client for an account, not yet connected. */
export function imapClient(account: Account, options: { logger?: boolean } = {}): ImapFlow {
  return new ImapFlow({
    host: account.imap.host,
    port: account.imap.port,
    secure: account.imap.secure,
    auth: { user: account.user, pass: account.password ?? '' },
    ...(account.tlsCa ? { tls: trustedCa(account) ?? {} } : {}),
    // imapflow logs every command at info by default; only on request.
    ...(options.logger ? {} : { logger: false as const }),
    // Fail on a black-holed port rather than hanging the shell.
    connectionTimeout: 20_000,
    greetingTimeout: 20_000,
    socketTimeout: 120_000,
  });
}

/**
 * A login failure, with the one thing the provider is known to refuse.
 *
 * Every app-password provider rejects the account password with a message
 * that reads like a typo; naming the real fix saves the second attempt.
 */
export function loginFailure(account: Account, protocol: 'IMAP' | 'SMTP', reason: string): string {
  const host = protocol === 'IMAP' ? account.imap.host : account.smtp.host;
  const preset = providerFor(account.provider);
  let advice = '';
  if (preset?.passwordKind === 'app') {
    advice = `\n${preset.label} refuses the account password over ${protocol}; use an app password` +
      (preset.passwordUrl ? ` (${preset.passwordUrl})` : '') + '.';
  } else if (preset?.passwordKind === 'bridge') {
    advice = `\n${preset.label}: is the bridge running on this machine, and is this the password it generated?`;
  } else if (preset?.passwordKind === 'alias') {
    advice = `\n${preset.label}: ${preset.passwordHint}.`;
  }
  return `${protocol} login to ${host} as ${account.user} failed: ${reason}${advice}`;
}

export interface VerifyResult {
  /** null when the login worked, otherwise why it did not. */
  imap: string | null;
  smtp: string | null;
}

export interface LoginProbes {
  imap: (account: Account) => Promise<void>;
  smtp: (account: Account) => Promise<void>;
}

export const defaultProbes: LoginProbes = {
  async imap(account) {
    const client = imapClient(account);
    await client.connect();
    await client.logout();
  },
  async smtp(account) {
    await smtpTransport(account).verify();
  },
};

/** Try both logins and say which worked. Never throws for a refusal. */
export async function verifyAccount(account: Account, probes: LoginProbes = defaultProbes): Promise<VerifyResult> {
  const attempt = async (protocol: 'IMAP' | 'SMTP', probe: (account: Account) => Promise<void>) => {
    try {
      await probe(account);
      return null;
    } catch (error) {
      return loginFailure(account, protocol, (error as Error).message);
    }
  };
  const [imap, smtp] = await Promise.all([attempt('IMAP', probes.imap), attempt('SMTP', probes.smtp)]);
  return { imap, smtp };
}

export async function openMailbox(
  account: Account,
  options: { logger?: boolean } = {},
): Promise<Mailbox> {
  if (!account.password) {
    const preset = providerFor(account.provider);
    const hint = preset ? ` — ${preset.passwordHint}` : '';
    throw new MailError(
      `account "${account.name}" has no password${hint}.\n` +
        `Store it with \`mail accounts password ${account.name}\`, export ${passwordVariable(account.name)}, ` +
        'or put it in the vault and run `mail accounts pull`.',
    );
  }

  const client = imapClient(account, options);

  try {
    await client.connect();
  } catch (error) {
    throw new MailError(loginFailure(account, 'IMAP', (error as Error).message));
  }

  async function withFolder<T>(folder: string, work: () => Promise<T>): Promise<T> {
    const lock = await client.getMailboxLock(folder);
    try {
      return await work();
    } finally {
      lock.release();
    }
  }

  async function fetchSummaries(range: number[] | SearchObject | string, uid: boolean): Promise<MessageSummary[]> {
    const out: MessageSummary[] = [];
    for await (const message of client.fetch(range, SUMMARY_FIELDS, { uid })) {
      out.push(summaryFrom(message));
    }
    return out;
  }

  return {
    async folders() {
      const list: ListResponse[] = await client.list();
      return list.map((entry) => ({
        path: entry.path,
        specialUse: entry.specialUse ?? null,
        delimiter: entry.delimiter,
      }));
    },

    async list(folder, { limit, unreadOnly }) {
      return withFolder(folder, async () => {
        const uids = await client.search(unreadOnly ? { seen: false } : { all: true }, { uid: true });
        if (!uids || uids.length === 0) return [];
        // Newest last in UID order; take the tail and show it newest first.
        const wanted = uids.sort((a, b) => a - b).slice(-limit);
        const summaries = await fetchSummaries(wanted, true);
        return summaries.sort((a, b) => b.uid - a.uid);
      });
    },

    async search(folder, query, limit) {
      return withFolder(folder, async () => {
        const uids = await client.search(query, { uid: true });
        if (!uids || uids.length === 0) return [];
        const wanted = uids.sort((a, b) => a - b).slice(-limit);
        const summaries = await fetchSummaries(wanted, true);
        return summaries.sort((a, b) => b.uid - a.uid);
      });
    },

    async raw(folder, uid) {
      return withFolder(folder, async () => {
        const message = await client.fetchOne(String(uid), { source: true }, { uid: true });
        if (!message || !message.source) throw new MailError(`no message with uid ${uid} in ${folder}`);
        return message.source;
      });
    },

    async read(folder, uid) {
      return withFolder(folder, async () => {
        const message = await client.fetchOne(
          String(uid),
          { ...SUMMARY_FIELDS, source: true },
          { uid: true },
        );
        if (!message || !message.source) throw new MailError(`no message with uid ${uid} in ${folder}`);
        const parsed = await simpleParser(message.source);
        return fullFrom(summaryFrom(message), parsed);
      });
    },

    async flag(folder, uids, add, remove) {
      await withFolder(folder, async () => {
        if (add.length > 0) await client.messageFlagsAdd(uids, add, { uid: true });
        if (remove.length > 0) await client.messageFlagsRemove(uids, remove, { uid: true });
      });
    },

    async move(folder, uids, destination) {
      await withFolder(folder, async () => {
        const result = await client.messageMove(uids, destination, { uid: true });
        if (!result) throw new MailError(`could not move ${uids.join(',')} from ${folder} to ${destination}`);
      });
    },

    async expunge(folder, uids) {
      await withFolder(folder, async () => {
        const ok = await client.messageDelete(uids, { uid: true });
        if (!ok) throw new MailError(`could not delete ${uids.join(',')} from ${folder}`);
      });
    },

    async append(folder, raw, flags) {
      const result = await client.append(folder, raw, flags);
      if (!result) throw new MailError(`could not append to ${folder}`);
    },

    async close() {
      await client.logout();
    },
  };
}

/** The folder a special-use role maps to, falling back to the usual names. */
export function folderFor(folders: Folder[], role: 'Trash' | 'Sent' | 'Drafts' | 'Archive' | 'Junk'): string | null {
  const byUse = folders.find((folder) => folder.specialUse === `\\${role}`);
  if (byUse) return byUse.path;
  const candidates: Record<typeof role, string[]> = {
    Trash: ['Trash', 'Deleted Items', 'Deleted Messages', '[Gmail]/Trash', '[Gmail]/Bin'],
    Sent: ['Sent', 'Sent Items', 'Sent Messages', '[Gmail]/Sent Mail'],
    Drafts: ['Drafts', '[Gmail]/Drafts'],
    Archive: ['Archive', '[Gmail]/All Mail'],
    Junk: ['Junk', 'Spam', '[Gmail]/Spam'],
  };
  for (const name of candidates[role]) {
    const hit = folders.find((folder) => folder.path.toLowerCase() === name.toLowerCase());
    if (hit) return hit.path;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Composing
// ---------------------------------------------------------------------------

export interface Outgoing {
  from: string;
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  text: string;
  html?: string;
  inReplyTo?: string;
  references?: string[];
  attachments: { filename: string; path: string }[];
}

/** `Name <address>`, or just the address when there is no name. */
export function fromHeader(account: Account): string {
  return account.displayName ? `${account.displayName} <${account.email}>` : account.email;
}

/** Quote a message body the way every mail client does. */
export function quote(text: string): string {
  return text
    .replace(/\r\n/g, '\n')
    .trimEnd()
    .split('\n')
    .map((line) => (line ? `> ${line}` : '>'))
    .join('\n');
}

/** `Re: subject`, without stacking a second `Re:` on a reply to a reply. */
export function replySubject(subject: string): string {
  const trimmed = subject.trim();
  return /^(re|aw|sv|fwd?)\s*:/i.test(trimmed) ? trimmed : `Re: ${trimmed}`;
}

/**
 * A reply, addressed the way the original asked to be answered.
 *
 * Reply-To beats From. `all` adds the original's To and Cc, minus ourselves —
 * a reply that copies your own address is a message you will read twice — and
 * the thread headers carry on from the original so the other side's client
 * files it under the same conversation.
 */
export function buildReply(
  original: FullMessage,
  account: Account,
  options: { all?: boolean; body: string; quoteOriginal?: boolean },
): Outgoing {
  const self = account.email.toLowerCase();
  const primary = original.replyTo || original.from;
  const to = splitAddresses(primary).filter((entry) => bareAddress(entry) !== self);
  const cc: string[] = [];

  if (options.all) {
    const seen = new Set(to.map(bareAddress));
    seen.add(self);
    for (const entry of [...splitAddresses(original.to), ...splitAddresses(original.cc)]) {
      const bare = bareAddress(entry);
      if (seen.has(bare)) continue;
      seen.add(bare);
      cc.push(entry);
    }
  }
  if (to.length === 0 && cc.length > 0) to.push(cc.shift()!);
  if (to.length === 0) throw new MailError('the original has no address to reply to');

  const references = [...original.references];
  if (original.messageId && !references.includes(original.messageId)) references.push(original.messageId);

  let text = options.body.trimEnd();
  if (options.quoteOriginal !== false && original.text.trim()) {
    const stamp = original.date ? new Date(original.date).toUTCString() : 'an earlier message';
    const who = original.from || 'they';
    text += `\n\nOn ${stamp}, ${who} wrote:\n${quote(original.text)}`;
  }

  return {
    from: fromHeader(account),
    to,
    cc,
    bcc: [],
    subject: replySubject(original.subject),
    text: `${text}\n`,
    ...(original.messageId ? { inReplyTo: original.messageId } : {}),
    references,
    attachments: [],
  };
}

/** The message as RFC 822 bytes, for a Drafts or Sent append. */
export async function composeRaw(outgoing: Outgoing): Promise<Buffer> {
  const composer = new MailComposer({
    from: outgoing.from,
    to: outgoing.to,
    cc: outgoing.cc,
    bcc: outgoing.bcc,
    subject: outgoing.subject,
    text: outgoing.text,
    ...(outgoing.html ? { html: outgoing.html } : {}),
    ...(outgoing.inReplyTo ? { inReplyTo: outgoing.inReplyTo } : {}),
    ...(outgoing.references && outgoing.references.length > 0
      ? { references: outgoing.references.join(' ') }
      : {}),
    attachments: outgoing.attachments,
  });
  return composer.compile().build();
}

// ---------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------

export type Transport = 'smtp' | 'resend';

export interface TransportChoice {
  transport: Transport;
  /** The order to try: the choice, then the fallback when one applies. */
  fallback: Transport | null;
  reason: string;
}

/**
 * Which way a message leaves.
 *
 * SMTP when the account has a password; Resend when it does not and the key
 * is here; and never Resend for a webmail address, because the domain cannot
 * be verified there and the failure would only surface as a 403 after the
 * message was ready to go. An explicit `--via` is honoured or refused, not
 * quietly swapped.
 */
export function chooseTransport(
  account: Account,
  resendKey: string | undefined,
  requested?: Transport,
): TransportChoice {
  const webmail = WEBMAIL_DOMAINS.has(domainOf(account.email));
  const canSmtp = Boolean(account.password);
  const canResend = Boolean(resendKey) && !webmail;

  if (requested === 'smtp') {
    if (!canSmtp) {
      throw new MailError(`--via smtp: account "${account.name}" has no password to log in with`);
    }
    return { transport: 'smtp', fallback: null, reason: 'requested' };
  }
  if (requested === 'resend') {
    if (!resendKey) {
      throw new MailError('--via resend: no RESEND_API_KEY — `cli-tools config pull` imports it');
    }
    if (webmail) {
      throw new MailError(
        `--via resend: ${domainOf(account.email)} cannot be verified at Resend, so it cannot send as ${account.email}`,
      );
    }
    return { transport: 'resend', fallback: null, reason: 'requested' };
  }

  if (canSmtp) {
    return {
      transport: 'smtp',
      fallback: canResend ? 'resend' : null,
      reason: `${account.smtp.host} as ${account.user}`,
    };
  }
  if (canResend) {
    return { transport: 'resend', fallback: null, reason: 'no SMTP password for this account' };
  }
  throw new MailError(
    webmail
      ? `account "${account.name}" has no password, and ${domainOf(account.email)} cannot send through Resend — ` +
          `store one with \`mail accounts password ${account.name}\``
      : `account "${account.name}" has no password and there is no RESEND_API_KEY — ` +
          `store one with \`mail accounts password ${account.name}\` or run \`cli-tools config pull\``,
  );
}

export interface SendResult {
  transport: Transport;
  id: string | null;
  /** Set when the first transport failed and the second carried it. */
  fellBackFrom?: { transport: Transport; error: string };
}

export type SmtpSender = (account: Account, outgoing: Outgoing) => Promise<string | null>;
export type ResendSender = (key: string, outgoing: Outgoing) => Promise<string | null>;

/** The SMTP transport for an account, TLS settings included. */
export function smtpTransport(account: Account) {
  return nodemailer.createTransport({
    host: account.smtp.host,
    port: account.smtp.port,
    secure: account.smtp.secure,
    auth: { user: account.user, pass: account.password ?? '' },
    ...(account.tlsCa ? { tls: trustedCa(account) ?? {} } : {}),
    connectionTimeout: 20_000,
    greetingTimeout: 20_000,
  });
}

export const sendViaSmtp: SmtpSender = async (account, outgoing) => {
  const transporter = smtpTransport(account);
  const info = await transporter.sendMail({
    from: outgoing.from,
    to: outgoing.to,
    cc: outgoing.cc,
    bcc: outgoing.bcc,
    subject: outgoing.subject,
    text: outgoing.text,
    ...(outgoing.html ? { html: outgoing.html } : {}),
    ...(outgoing.inReplyTo ? { inReplyTo: outgoing.inReplyTo } : {}),
    ...(outgoing.references && outgoing.references.length > 0
      ? { references: outgoing.references.join(' ') }
      : {}),
    attachments: outgoing.attachments,
  });
  return info.messageId ?? null;
};

export const RESEND_API = 'https://api.resend.com/emails';

/** Resend's JSON body. Header names are Resend's, not SMTP's. */
export function resendPayload(outgoing: Outgoing): Record<string, unknown> {
  const headers: Record<string, string> = {};
  if (outgoing.inReplyTo) headers['In-Reply-To'] = outgoing.inReplyTo;
  if (outgoing.references && outgoing.references.length > 0) {
    headers.References = outgoing.references.join(' ');
  }
  return {
    from: outgoing.from,
    to: outgoing.to,
    ...(outgoing.cc.length > 0 ? { cc: outgoing.cc } : {}),
    ...(outgoing.bcc.length > 0 ? { bcc: outgoing.bcc } : {}),
    subject: outgoing.subject,
    text: outgoing.text,
    ...(outgoing.html ? { html: outgoing.html } : {}),
    ...(Object.keys(headers).length > 0 ? { headers } : {}),
    ...(outgoing.attachments.length > 0
      ? {
          attachments: outgoing.attachments.map((attachment) => ({
            filename: attachment.filename,
            content: readFileSync(attachment.path).toString('base64'),
          })),
        }
      : {}),
  };
}

export function resendSender(fetchImpl: typeof fetch = fetch): ResendSender {
  return async (key, outgoing) => {
    const response = await fetchImpl(RESEND_API, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(resendPayload(outgoing)),
    });
    const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    if (!response.ok) {
      const message = typeof body.message === 'string' ? body.message : `HTTP ${response.status}`;
      throw new MailError(`Resend refused the message: ${message}`);
    }
    return typeof body.id === 'string' ? body.id : null;
  };
}

/**
 * Send, and fall back once.
 *
 * A fallback is only taken on a transport failure — a refused login, a dead
 * host — never on a refused *message*. Resend's "domain not verified" and
 * SMTP's "recipient rejected" mean the same message would fail the same way
 * on the other path, and trying anyway risks two copies when the first one
 * was actually accepted late.
 */
export async function sendMail(
  account: Account,
  outgoing: Outgoing,
  options: {
    resendKey?: string;
    via?: Transport;
    smtp?: SmtpSender;
    resend?: ResendSender;
  } = {},
): Promise<SendResult> {
  const choice = chooseTransport(account, options.resendKey, options.via);
  const smtp = options.smtp ?? sendViaSmtp;
  const resend = options.resend ?? resendSender();

  const attempt = async (transport: Transport): Promise<string | null> =>
    transport === 'smtp' ? smtp(account, outgoing) : resend(options.resendKey!, outgoing);

  try {
    return { transport: choice.transport, id: await attempt(choice.transport) };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!choice.fallback || !isTransportFailure(message)) {
      throw error instanceof MailError ? error : new MailError(`${choice.transport}: ${message}`);
    }
    const id = await attempt(choice.fallback);
    return {
      transport: choice.fallback,
      id,
      fellBackFrom: { transport: choice.transport, error: message },
    };
  }
}

/** A failure of the pipe, as opposed to a refusal of the message. */
export function isTransportFailure(message: string): boolean {
  return /ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|timed? ?out|greeting|Invalid login|authentication|auth(?:orization)? failed|535|454|421|connection closed/i.test(
    message,
  );
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

function truncate(text: string, width: number): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (clean.length <= width) return clean.padEnd(width);
  return `${clean.slice(0, Math.max(0, width - 1))}…`;
}

function shortDate(iso: string | null, now: Date = new Date()): string {
  if (!iso) return '          ';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '          ';
  const sameDay = date.toISOString().slice(0, 10) === now.toISOString().slice(0, 10);
  return sameDay ? `     ${date.toISOString().slice(11, 16)}` : date.toISOString().slice(0, 10);
}

/**
 * One line per message, newest first.
 *
 *   uid  flags  date        from                     subject
 *
 * Flags are `N` unread, `*` flagged, `r` answered — the three that change what
 * you do next. The uid is first because it is what every other verb takes.
 */
export function formatList(
  messages: MessageSummary[],
  options: { width?: number; account?: string; now?: Date } = {},
): string {
  if (messages.length === 0) return '(no messages)';
  const width = Math.max(60, options.width ?? 100);
  const uidWidth = Math.max(3, ...messages.map((message) => String(message.uid).length));
  const fromWidth = Math.min(28, Math.max(8, ...messages.map((message) => senderName(message.from).length)));
  const prefixWidth = uidWidth + 1 + 3 + 1 + 10 + 1 + fromWidth + 2;
  const subjectWidth = Math.max(12, width - prefixWidth);

  const lines = messages.map((message) => {
    const flags = `${message.seen ? ' ' : 'N'}${message.flagged ? '*' : ' '}${message.answered ? 'r' : ' '}`;
    return (
      `${String(message.uid).padStart(uidWidth)} ${flags} ${shortDate(message.date, options.now)} ` +
      `${truncate(senderName(message.from), fromWidth)}  ${truncate(message.subject || '(no subject)', subjectWidth).trimEnd()}`
    );
  });
  return (options.account ? [`# ${options.account}`, ...lines] : lines).join('\n');
}

/** The human part of `Name <addr>`, or the address when there is none. */
export function senderName(from: string): string {
  const first = splitAddresses(from)[0] ?? '';
  const match = /^"?([^"<]*?)"?\s*<[^>]+>$/.exec(first.trim());
  const name = match ? match[1]!.trim() : '';
  return name || bareAddress(first) || '';
}

/** Headers, then the text, the way `less` wants to see it. */
export function formatMessage(message: FullMessage): string {
  const lines = [
    `From:    ${message.from}`,
    `To:      ${message.to}`,
    ...(message.cc ? [`Cc:      ${message.cc}`] : []),
    ...(message.replyTo ? [`Reply-To: ${message.replyTo}`] : []),
    `Date:    ${message.date ?? '(none)'}`,
    `Subject: ${message.subject || '(no subject)'}`,
    `Uid:     ${message.uid}${message.messageId ? `   Message-Id: ${message.messageId}` : ''}`,
  ];
  if (message.attachments.length > 0) {
    lines.push(
      `Attachments: ${message.attachments
        .map((attachment) => `${attachment.filename} (${attachment.contentType}, ${attachment.size} bytes)`)
        .join('; ')}`,
    );
  }
  return `${lines.join('\n')}\n\n${message.text.replace(/\r\n/g, '\n').trimEnd()}\n`;
}

/** Folder listing with the role next to the ones that have one. */
export function formatFolders(folders: Folder[]): string {
  if (folders.length === 0) return '(no folders)';
  const width = Math.max(...folders.map((folder) => folder.path.length));
  return folders
    .map((folder) => `${folder.path.padEnd(width)}${folder.specialUse ? `  ${folder.specialUse}` : ''}`)
    .join('\n');
}

/** `mail accounts` output; never a password. */
export function formatAccounts(accounts: Account[], defaultName: string | undefined): string {
  if (accounts.length === 0) return '(no accounts — `mail accounts add <name> <email>`)';
  const width = Math.max(...accounts.map((account) => account.name.length));
  return accounts
    .map((account) => {
      const marker = account.name === defaultName ? '*' : ' ';
      const password =
        account.passwordSource === 'unset'
          ? 'no password'
          : `password from ${account.passwordSource === 'env' ? passwordVariable(account.name) : 'mail.json'}`;
      return `${marker} ${account.name.padEnd(width)}  ${account.email}  ${account.provider}  ${password}`;
    })
    .join('\n');
}
