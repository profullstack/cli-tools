#!/usr/bin/env node
/**
 * fe — Forward Email aliases without the dashboard.
 *
 *   fe ls c0upons.com
 *   fe ensure submit@c0upons.com https://c0upons.com/api/webhooks/email \
 *       --key-from-vault c0upons--prod:INBOUND_EMAIL_SECRET
 *   fe rm old@c0upons.com --yes
 *
 * `ensure` is idempotent and only ever adds recipients, so cron can run it.
 * See src/forwardemail.ts for why this exists.
 */

import { UsageError, parseArgs } from '../src/args.ts';
import { resolveCredentials } from '../src/credentials.ts';
import { isMain } from '../src/is-main.ts';
import {
  ForwardEmailError,
  client,
  ensureAlias,
  formatAliases,
  listAliases,
  maskRecipient,
  removeAlias,
} from '../src/forwardemail.ts';
import { pullVault, vaultTarget } from '../src/vault.ts';

const USAGE = `Usage:
  fe ls <domain> [--json]
  fe ensure <address> <recipient>... [--key-from-vault <project>--<env>:<KEY>] [--description TEXT]
  fe rm <address> --yes

Commands:
  ls       every alias on a domain and where it forwards (webhook keys masked)
  ensure   create the alias, or add the recipients it lacks; never removes one
  rm       delete an alias

A recipient is an address, a domain, or a webhook URL. --key-from-vault reads
<KEY> from the logicsrc team vault <project>--<env> and appends it to every
webhook recipient as ?key=<value>, so the secret is never typed or logged.

The token is FORWARDEMAIL_API_TOKEN: the environment, then \`cli-tools config\`,
then the shared vault (${vaultTarget().project}--${vaultTarget().env}). It is an
account API token from forwardemail.net My Account > Security; the account
password does not work.
`;

function fail(message: string, code = 2): never {
  process.stderr.write(`fe: ${message}\n`);
  process.exit(code);
}

function token(): string {
  const known = resolveCredentials(process.env).FORWARDEMAIL_API_TOKEN;
  if (known) return known;
  const fromVault = pullVault().FORWARDEMAIL_API_TOKEN;
  if (fromVault) return fromVault;
  throw new ForwardEmailError(
    `no FORWARDEMAIL_API_TOKEN in the environment, cli-tools config, or vault ${vaultTarget().project}--${vaultTarget().env}`,
  );
}

function vaultValue(spec: string): string {
  const m = /^(.+)--([^:]+):([A-Z0-9_]+)$/.exec(spec);
  if (!m) throw new UsageError(`--key-from-vault wants <project>--<env>:<KEY>, got ${JSON.stringify(spec)}`);
  const value = pullVault({ team: vaultTarget().team, project: m[1]!, env: m[2]! })[m[3]!];
  if (!value) throw new ForwardEmailError(`${m[3]} is not set in vault ${m[1]}--${m[2]}`);
  return value;
}

if (isMain(import.meta.url)) {
  try {
    const parsed = parseArgs(process.argv.slice(2), {
      boolean: ['--json', '--yes', '-h', '--help'],
      string: ['--key-from-vault', '--description'],
    });
    if (parsed.flags.has('-h') || parsed.flags.has('--help') || parsed.positional.length === 0) {
      process.stdout.write(USAGE);
      process.exit(0);
    }
    const [command, ...rest] = parsed.positional;
    const api = client(token());

    switch (command) {
      case 'ls':
      case 'list': {
        const domain = rest[0]?.toLowerCase();
        if (!domain) throw new UsageError('ls needs a domain');
        const aliases = await listAliases(api, domain);
        process.stdout.write(
          parsed.flags.has('--json')
            ? `${JSON.stringify(aliases.map((a) => ({ ...a, recipients: a.recipients.map(maskRecipient) })), null, 2)}\n`
            : `${formatAliases(aliases, domain)}\n`,
        );
        break;
      }

      case 'ensure': {
        const [address, ...recipients] = rest;
        if (!address || !recipients.length) throw new UsageError('ensure needs <address> <recipient>...');
        const spec = parsed.values.get('--key-from-vault');
        const key = spec ? vaultValue(spec) : null;
        const resolved = recipients.map((r) => {
          if (!key || !/^https?:\/\//i.test(r)) return r;
          const url = new URL(r);
          url.searchParams.set('key', key);
          return url.toString();
        });
        const { outcome, alias } = await ensureAlias(api, address, resolved, parsed.values.get('--description'));
        process.stdout.write(`${outcome} ${address} -> ${alias.recipients.map(maskRecipient).join(', ')}\n`);
        break;
      }

      case 'rm':
      case 'delete': {
        const address = rest[0];
        if (!address) throw new UsageError('rm needs an address');
        if (!parsed.flags.has('--yes')) throw new UsageError('rm deletes mail routing; pass --yes');
        process.stdout.write((await removeAlias(api, address)) ? `deleted ${address}\n` : `${address} did not exist\n`);
        break;
      }

      default:
        throw new UsageError(`unknown command: ${command}`);
    }
  } catch (error) {
    if (error instanceof UsageError) {
      process.stderr.write(`${USAGE}\n`);
      fail(error.message);
    }
    fail(error instanceof Error ? error.message : String(error), 1);
  }
}
