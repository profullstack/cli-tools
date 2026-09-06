#!/usr/bin/env node
/**
 * cal — the calendar from the terminal, over CalDAV.
 *
 * What is on today, this week, or between two dates; one event in full;
 * add one; remove one. Accounts are configuration, imported from the
 * `cli-tools-cal` team vault or signed in with `cal login`, which says which
 * kind of password the provider wants before asking for it — the same shape
 * as `mail`, because it is the same problem.
 */

import { isMain } from '../src/is-main.ts';
import { UsageError, parseArgs } from '../src/args.ts';
import {
  type Account,
  type AccountConfig,
  type CalConfig,
  type Calendar,
  type CalEvent,
  type ProviderName,
  CAL_VAULT_PROJECT,
  CalError,
  PROVIDER_NAMES,
  accountsFromVault,
  buildIcs,
  calConfigPath,
  durationMinutes,
  formatAccounts,
  formatAgenda,
  formatCalendars,
  formatEvent,
  formatProviders,
  guessProvider,
  isProviderName,
  loadConfig,
  loginHint,
  mergeVaultAccounts,
  openCalDav,
  parseWhen,
  passwordVariable,
  providerFor,
  resolveAccount,
  saveConfig,
  selectAccount,
  unsupportedProvider,
  windowFrom,
} from '../src/cal.ts';
import { loadConfig as loadMailConfig, resolveAccount as resolveMailAccount } from '../src/mail.ts';
import { confirm, promptLine, promptSecret } from '../src/prompt.ts';
import { pullVault, vaultTarget } from '../src/vault.ts';

const USAGE = `Usage:
  cal login <provider> [email] [--as NAME]     sign in: says which password the provider wants,
                                              finds the calendars, then stores the account
  cal login <email>                           the same, with the provider read off the address
  cal login … --like <mail-account>           reuse the address and password of a \`mail\` account
  cal providers                               every provider built in, and what each wants

  cal accounts                                the configured accounts
  cal accounts password <name>                store or replace a password
  cal accounts default <name>                 which account a bare command means
  cal accounts rm <name>
  cal accounts pull                           import accounts from the team vault

  cal calendars [-a ACCOUNT]                  the calendars in the account
  cal ls [--today|--tomorrow|--week|--days N|--from W --to W] [-c CALENDAR] [-a ACCOUNT] [--json]
  cal show <uid> [-a ACCOUNT] [--json]
  cal add <title> --at W [--end W | --for D] [--all-day] [-c CALENDAR] [--where P] [--notes T] [--link U]
  cal rm <uid> [-a ACCOUNT] [--yes]

Options:
  -a, --account A     which account: its name or its address (default: \`cal accounts default\`)
  -c, --calendar C    which calendar, by name (ls: all of them; add: the first, or the one named)
  --today, --tomorrow, --week, --days N, --from W, --to W
                      the window for ls; default is the next 7 days
  --at W              add: when it starts — 2026-09-06 14:00, tomorrow 9:30, friday 2pm, or a bare day
  --end W             add: when it ends; --for D a duration instead (30m, 1h30m, 2d); default 1h
  --all-day           add: a whole-day event on the day of --at (a bare day implies it)
  --where P           add: the location
  --notes T           add: the description
  --link U            add: a URL
  --json              machine-readable output
  --yes               rm: skip the confirmation
  -h, --help          show this help

Options for \`login\`:
  --as NAME           the account name to store it under (default: the provider's name)
  --like NAME         take the address and password from the \`mail\` account of that name
  --default           make it the account a bare command means
  --no-verify         store without finding the calendars first
  --user LOGIN        when the login is not the address
  --url U             the CalDAV URL, for custom (Nextcloud: https://host/remote.php/dav) or a regional host

Accounts live in ${calConfigPath()} (0600). A password exported as
CAL_<NAME>_PASSWORD wins over the stored one. \`cal accounts pull\` imports
CAL_<NAME>_EMAIL / _PROVIDER / _PASSWORD (and optional _USER, _URL) plus
CAL_DEFAULT from the \`${CAL_VAULT_PROJECT}\` vault; CLI_TOOLS_CAL_VAULT_PROJECT /
_ENV point it elsewhere. Times print in this machine's zone.
`;

function fail(message: string, code = 2): never {
  process.stderr.write(`cal: ${message}\n`);
  process.exit(code);
}

function out(text: string): void {
  process.stdout.write(text.endsWith('\n') ? text : `${text}\n`);
}

function json(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function integer(values: Map<string, string>, flag: string, fallback: number, range: { min: number; max: number }): number {
  const raw = values.get(flag);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < range.min || value > range.max) {
    throw new UsageError(`${flag} must be a whole number from ${range.min} to ${range.max}, got "${raw}"`);
  }
  return value;
}

function pickCalendars(calendars: Calendar[], wanted: string | undefined): Calendar[] {
  if (!wanted) return calendars;
  const lower = wanted.toLowerCase();
  const found = calendars.filter((calendar) => calendar.name.toLowerCase() === lower);
  if (found.length === 0) {
    const partial = calendars.filter((calendar) => calendar.name.toLowerCase().includes(lower));
    if (partial.length === 1) return partial;
    throw new CalError(`no calendar "${wanted}". Available: ${calendars.map((calendar) => calendar.name).join(', ')}`);
  }
  return found;
}

async function findEvent(account: Account, uid: string, calendarName: string | undefined): Promise<CalEvent> {
  const dav = openCalDav(account);
  const calendars = pickCalendars(await dav.calendars(), calendarName);
  for (const calendar of calendars) {
    const event = await dav.find(calendar, uid);
    if (event) return event;
  }
  throw new CalError(`no event with uid ${uid} in ${calendars.map((calendar) => calendar.name).join(', ')}`);
}

async function loginVerb(config: CalConfig, args: string[], parsed: ReturnType<typeof parseArgs>): Promise<number> {
  const [first, second] = args;
  const like = parsed.values.get('--like');
  let likeAccount: { email: string; password: string | null } | null = null;
  if (like) {
    const mail = loadMailConfig();
    const entry = mail.accounts[like.toLowerCase()];
    if (!entry) fail(`no mail account "${like}" to borrow from — \`mail accounts\` lists them`, 1);
    const resolved = resolveMailAccount(like.toLowerCase(), entry);
    likeAccount = { email: resolved.email, password: resolved.password };
    if (!likeAccount.password) fail(`mail account "${like}" has no password to borrow`, 1);
  }
  if (!first && !likeAccount) throw new UsageError('login needs a provider or an address: `cal login icloud you@icloud.com`');

  let provider: ProviderName;
  let email: string | undefined;
  const nameOrAddress = first ?? likeAccount!.email;
  if (nameOrAddress.includes('@')) {
    email = nameOrAddress;
    const blocked = unsupportedProvider(email);
    if (blocked) fail(`${blocked.label} cannot be reached with a password: ${blocked.reason}`, 1);
    const guessed = guessProvider(email);
    if (guessed) provider = guessed;
    else if (parsed.values.has('--url')) provider = 'custom';
    else {
      fail(
        `"${email}" is not on a domain that names its calendar host. Say which: ` +
          `\`cal login <provider> ${email}\` with one of ${PROVIDER_NAMES.join(', ')}, ` +
          `or \`cal login custom ${email} --url https://…\`. \`cal providers\` lists them.`,
        1,
      );
    }
  } else {
    const requested = nameOrAddress.toLowerCase();
    if (isProviderName(requested)) provider = requested;
    else {
      const blocked = unsupportedProvider(requested);
      if (blocked) fail(`${blocked.label} cannot be reached with a password: ${blocked.reason}`, 1);
      fail(`no provider "${first}". Built in: ${PROVIDER_NAMES.join(', ')}, custom — \`cal providers\` for details.`, 1);
    }
    email = second ?? likeAccount?.email;
  }
  if (!email) {
    if (!process.stdin.isTTY) throw new UsageError(`login needs the address: \`cal login ${provider} you@example.com\``);
    email = await promptLine('address: ');
  }
  if (!email.includes('@')) throw new UsageError(`"${email}" is not an address`);
  email = email.toLowerCase();

  const name = (parsed.values.get('--as') ?? provider).toLowerCase();
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(name)) {
    throw new UsageError('an account name is letters, digits, - and _ — it becomes CAL_<NAME>_PASSWORD');
  }
  const existing = config.accounts[name];
  const account: AccountConfig = { ...(existing ?? {}), email, provider };
  const user = parsed.values.get('--user');
  if (user !== undefined) account.user = user;
  const url = parsed.values.get('--url');
  if (url !== undefined) account.url = url;
  if (provider === 'custom' && !account.url) throw new UsageError('`login custom` needs --url');

  const preset = providerFor(provider);
  if (likeAccount?.password) {
    account.password = likeAccount.password;
    process.stderr.write(`using the password of mail account "${like}"\n`);
  } else {
    if (preset) process.stderr.write(`${loginHint(preset)}\n`);
    const password = await promptSecret(`password for ${email}: `);
    if (!password) fail('empty — nothing stored', 1);
    account.password = password;
  }

  if (!parsed.flags.has('--no-verify')) {
    const resolved = resolveAccount(name, account, {});
    process.stderr.write(`finding calendars at ${resolved.url}…\n`);
    let calendars: Calendar[];
    try {
      calendars = await openCalDav(resolved).calendars();
    } catch (error) {
      fail(`${(error as Error).message}\nNothing stored. --no-verify stores it anyway.`, 1);
    }
    if (calendars.length === 0) process.stderr.write('warning: the login works but the account has no calendars yet\n');
    else process.stderr.write(`${calendars.length} calendar${calendars.length === 1 ? '' : 's'}: ${calendars.map((calendar) => calendar.name).join(', ')}\n`);
  }

  config.accounts[name] = account;
  if (parsed.flags.has('--default') || Object.keys(config.accounts).length === 1) config.default = name;
  const path = saveConfig(config);
  out(`${existing ? 'updated' : 'logged in'}: ${name} (${email}, ${provider}) in ${path}`);
  if (config.default === name) out(`${name} is the default account`);
  else out(`\`cal ls -a ${name}\` reads it; \`cal accounts default ${name}\` makes it the default`);
  return 0;
}

async function accountsVerb(config: CalConfig, args: string[], parsed: ReturnType<typeof parseArgs>): Promise<number> {
  const [verb, ...rest] = args;
  if (!verb || verb === 'ls' || verb === 'list') {
    const accounts = Object.entries(config.accounts).map(([name, entry]) => {
      try {
        return resolveAccount(name, entry);
      } catch {
        return {
          name,
          email: entry.email,
          user: entry.user ?? entry.email,
          password: null,
          passwordSource: 'unset' as const,
          provider: entry.provider,
          url: entry.url ?? '?',
        };
      }
    });
    if (parsed.flags.has('--json')) {
      json({ default: config.default ?? null, accounts: accounts.map(({ password: _password, ...account }) => account) });
    } else out(formatAccounts(accounts, config.default));
    return 0;
  }

  if (verb === 'password') {
    const name = rest[0]?.toLowerCase();
    if (!name) throw new UsageError('accounts password needs the account name');
    const account = config.accounts[name];
    if (!account) fail(`no account "${name}". Configured: ${Object.keys(config.accounts).join(', ') || 'none'}`, 1);
    const preset = providerFor(account.provider);
    if (preset) process.stderr.write(`(${preset.passwordHint})\n`);
    const password = await promptSecret(`password for ${account.email}: `);
    if (!password) fail('empty — nothing stored', 1);
    account.password = password;
    out(`stored the password for ${name} in ${saveConfig(config)}`);
    return 0;
  }

  if (verb === 'default') {
    const name = rest[0]?.toLowerCase();
    if (!name) throw new UsageError('accounts default needs the account name');
    if (!config.accounts[name]) fail(`no account "${name}"`, 1);
    config.default = name;
    saveConfig(config);
    out(`${name} is the default account`);
    return 0;
  }

  if (verb === 'rm') {
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
      project: process.env.CLI_TOOLS_CAL_VAULT_PROJECT || CAL_VAULT_PROJECT,
      env: process.env.CLI_TOOLS_CAL_VAULT_ENV || base.env,
    };
    const label = `${target.team}/${target.project}--${target.env}`;
    process.stderr.write(`accounts: pulling ${label}…\n`);
    const fromVault = accountsFromVault(pullVault(target));
    if (Object.keys(fromVault.accounts).length === 0) {
      fail(
        `${label} holds no CAL_<NAME>_EMAIL keys. Push accounts there as\n` +
          '  CAL_WORK_EMAIL=… CAL_WORK_PROVIDER=forwardemail CAL_WORK_PASSWORD=…  CAL_DEFAULT=work',
        1,
      );
    }
    const { merged, changed, unchanged } = mergeVaultAccounts(config, fromVault);
    if (changed.length > 0) {
      const path = saveConfig(merged);
      for (const name of changed) {
        const account = merged.accounts[name]!;
        out(`accounts: imported ${name} (${account.email}, ${account.provider}${account.password ? '' : ', no password'})`);
      }
      out(`accounts: written to ${path}`);
    }
    for (const name of unchanged) out(`accounts: ${name} already matches the vault`);
    return 0;
  }

  throw new UsageError(`unknown accounts verb "${verb}" (password, default, rm, pull)`);
}

async function main(argv: string[]): Promise<number> {
  const parsed = parseArgs(argv, {
    boolean: ['--json', '--today', '--tomorrow', '--week', '--all-day', '--yes', '--default', '--no-verify', '-h', '--help'],
    string: [
      '-a', '--account', '-c', '--calendar', '--days', '--from', '--to', '--at', '--end', '--for', '--where', '--notes',
      '--link', '--as', '--like', '--user', '--url',
    ],
  });
  if (parsed.flags.has('-h') || parsed.flags.has('--help') || parsed.positional.length === 0) {
    process.stdout.write(USAGE);
    return 0;
  }
  const [command, ...rest] = parsed.positional;
  const isJson = parsed.flags.has('--json');
  const selector = parsed.values.get('-a') ?? parsed.values.get('--account');
  const calendarName = parsed.values.get('-c') ?? parsed.values.get('--calendar');
  const config = loadConfig();

  switch (command) {
    case 'accounts':
    case 'account':
      return accountsVerb(config, rest, parsed);

    case 'login':
      return loginVerb(config, rest, parsed);

    case 'providers':
      out(formatProviders());
      return 0;

    case 'calendars': {
      const account = selectAccount(config, selector);
      const calendars = await openCalDav(account).calendars();
      if (isJson) json(calendars);
      else out(formatCalendars(calendars));
      return 0;
    }

    case 'ls':
    case 'list':
    case 'agenda': {
      const account = selectAccount(config, selector);
      const window = windowFrom({
        today: parsed.flags.has('--today'),
        tomorrow: parsed.flags.has('--tomorrow'),
        week: parsed.flags.has('--week'),
        days: integer(parsed.values, '--days', 7, { min: 1, max: 366 }),
        ...(parsed.values.has('--from') ? { from: parsed.values.get('--from')! } : {}),
        ...(parsed.values.has('--to') ? { to: parsed.values.get('--to')! } : {}),
      });
      const dav = openCalDav(account);
      const calendars = pickCalendars(await dav.calendars(), calendarName);
      const events = (await Promise.all(calendars.map((calendar) => dav.events(calendar, window.from, window.to))))
        .flat()
        .sort((a, b) => a.start.localeCompare(b.start));
      if (isJson) json(events);
      else {
        process.stderr.write(`${account.name}: ${window.label}\n`);
        out(formatAgenda(events, { showCalendar: calendars.length > 1, width: process.stdout.columns || 100 }));
      }
      return 0;
    }

    case 'show': {
      const uid = rest[0];
      if (!uid) throw new UsageError('show needs the event uid — `cal ls --json` shows them');
      const account = selectAccount(config, selector);
      const event = await findEvent(account, uid, calendarName);
      if (isJson) json(event);
      else out(formatEvent(event));
      return 0;
    }

    case 'add': {
      const title = rest.join(' ').trim();
      if (!title) throw new UsageError('add needs a title: `cal add "Dentist" --at "tomorrow 9:30"`');
      const at = parsed.values.get('--at');
      if (!at) throw new UsageError('add needs --at: 2026-09-06 14:00, tomorrow 9:30, friday 2pm, or a bare day for all day');
      const start = parseWhen(at);
      const allDay = parsed.flags.has('--all-day') || start.allDay;
      let end: string;
      if (allDay) {
        const day = start.allDay ? start.value : new Date(start.value).toISOString().slice(0, 10);
        const endFlag = parsed.values.get('--end');
        const days = parsed.values.has('--for') ? Math.max(1, Math.round(durationMinutes(parsed.values.get('--for')!) / 1440)) : 1;
        const [y, m, d] = day.split('-').map(Number);
        const last = endFlag ? parseWhen(endFlag).value.slice(0, 10) : null;
        end = last
          ? new Date(Date.UTC(Number(last.slice(0, 4)), Number(last.slice(5, 7)) - 1, Number(last.slice(8, 10)) + 1)).toISOString().slice(0, 10)
          : new Date(Date.UTC(y!, m! - 1, d! + days)).toISOString().slice(0, 10);
        start.value = day;
        start.allDay = true;
      } else {
        const endFlag = parsed.values.get('--end');
        const minutes = parsed.values.has('--for') ? durationMinutes(parsed.values.get('--for')!) : 60;
        end = endFlag ? parseWhen(endFlag).value : new Date(new Date(start.value).getTime() + minutes * 60_000).toISOString();
        if (new Date(end) <= new Date(start.value)) throw new UsageError('--end must come after --at');
      }
      const account = selectAccount(config, selector);
      const dav = openCalDav(account);
      const calendars = await dav.calendars();
      if (calendars.length === 0) fail(`${account.name} has no calendars to add to`, 1);
      const calendar = calendarName ? pickCalendars(calendars, calendarName)[0]! : calendars[0]!;
      const { uid, ics } = buildIcs({
        summary: title,
        start: start.value,
        end,
        allDay,
        ...(parsed.values.has('--where') ? { location: parsed.values.get('--where')! } : {}),
        ...(parsed.values.has('--notes') ? { description: parsed.values.get('--notes')! } : {}),
        ...(parsed.values.has('--link') ? { url: parsed.values.get('--link')! } : {}),
      });
      const href = await dav.put(calendar, ics, uid);
      if (isJson) json({ uid, href, calendar: calendar.name, start: start.value, end, allDay });
      else out(`added to ${calendar.name}: ${title}\n${formatAgenda([{ uid, summary: title, location: parsed.values.get('--where') ?? '', description: '', url: '', start: start.value, end, allDay, status: '', recurring: false, href, etag: null, calendar: null }])}\nuid ${uid}`);
      return 0;
    }

    case 'rm': {
      const uid = rest[0];
      if (!uid) throw new UsageError('rm needs the event uid — `cal ls --json` shows them');
      const account = selectAccount(config, selector);
      const event = await findEvent(account, uid, calendarName);
      if (event.recurring) process.stderr.write('note: this event repeats; removing it removes every occurrence\n');
      if (!parsed.flags.has('--yes')) {
        const ok = await confirm(`remove "${event.summary}" (${event.allDay ? event.start : event.start.slice(0, 16)})?`);
        if (!ok) fail('not removed (pass --yes to skip the question)', 1);
      }
      await openCalDav(account).remove(event.href!, event.etag);
      out(`removed: ${event.summary}`);
      return 0;
    }

    default:
      throw new UsageError(`unknown command "${command}" — see --help`);
  }
}

if (isMain(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error: unknown) => {
      if (error instanceof UsageError) {
        process.stderr.write(`${USAGE}\ncal: ${error.message}\n`);
        process.exit(2);
      }
      if (error instanceof CalError) fail(error.message, 1);
      fail((error as Error).stack ?? String(error), 1);
    },
  );
}
