#!/usr/bin/env node
/**
 * porkbun — read and change DNS at Porkbun without the dashboard.
 *
 *   porkbun ls example.com
 *   porkbun set example.com www CNAME app.up.railway.app
 *   porkbun unpark example.com
 *
 * `unpark` is the reason this exists. A domain bought and left alone answers
 * with an ALIAS and a wildcard CNAME pointing at Porkbun's parking host, and
 * those records belong to a **URL forwarding rule** rather than standing on
 * their own. Adding your own ALIAS next to them does nothing at all — the
 * forward keeps winning, the new host never sees a request, and the failure
 * looks exactly like a broken deploy. Deleting the forward removes all of it in
 * one call. That cost an afternoon once; it is one command now.
 */

import { UsageError, integer, parseArgs } from '../src/args.ts';
import { resolveCredentials } from '../src/credentials.ts';
import { isMain } from '../src/is-main.ts';
import {
  MIN_TTL,
  PorkbunError,
  type RecordInput,
  checkAvailability,
  createRecord,
  credentialsFrom,
  deleteForward,
  deleteRecord,
  formatForwards,
  formatPrice,
  formatRecords,
  fqdn,
  hostLabel,
  listDomains,
  listForwards,
  listRecords,
  matchRecords,
  ping,
  planRegistration,
  planUnpark,
  porkbunCaller,
  previewRegistration,
  priceCents,
  registerDomain,
  setRecord,
  sortRecords,
} from '../src/porkbun.ts';

const USAGE = `Usage:
  porkbun ping
  porkbun domains
  porkbun ls <domain> [--type TYPE] [--name HOST] [--json]
  porkbun set <domain> <host> <type> <content> [--ttl N] [--prio N]
  porkbun add <domain> <host> <type> <content> [--ttl N] [--prio N]
  porkbun rm <domain> (<id> | <host> --type TYPE) [--yes]
  porkbun forwards <domain> [--json]
  porkbun unpark <domain> [--dry-run] [--yes]
  porkbun check <domain> [--json]
  porkbun register <domain> [--max-price N] [--no-whois-privacy] [--dry-run] [--yes]

Commands:
  ping        check the credentials and show the IP Porkbun sees
  domains     every domain on the account
  ls          list DNS records
  set         create the record, or edit it in place if it already exists
  add         always create, even if one of that name and type is there
  rm          delete by record id, or by host + --type
  forwards    list URL forwarding rules
  unpark      remove URL forwarding and the parking records it owns
  check       is a domain available, and what would it cost
  register    buy a domain — spends real money, so it confirms first

The host is written as you would say it: \`@\` or the bare domain for the apex,
\`www\` or \`www.example.com\` for a subdomain. Both forms mean the same record.

Options:
  --type TYPE   record type (A, AAAA, ALIAS, CNAME, MX, TXT, ...)
  --name HOST   filter \`ls\` to one host
  --ttl N       TTL in seconds, minimum ${MIN_TTL} (default ${MIN_TTL})
  --prio N      priority, for MX and SRV
  --json        raw JSON instead of a table
  --dry-run     for unpark: print what would be deleted, delete nothing
                for register: price it and stop, buy nothing
  --max-price N for register: refuse to spend more than N dollars
  --no-whois-privacy
                for register: publish your contact details (privacy is on by default)
  --yes         skip the confirmation prompt
  -h, --help    show this help

Credentials come from PORKBUN_API_KEY and PORKBUN_SECRET_API_KEY, via
\`cli-tools config pull\` or the environment. Porkbun also requires API access
to be switched on per domain, in the domain's settings — a key that pings fine
still gets "Invalid domain" until that is on.

\`register\` spends **prepaid account credit** — it does not charge a card. An
account with a zero balance cannot register anything, however valid the request;
add credit at porkbun.com first. Porkbun also requires the account's email and
phone to be verified, and at least one registration placed previously, before it
will sell through the API at all. It registers for the TLD's minimum term with
auto-renew on and WHOIS privacy on, using the account's default contacts.
Premium names cannot be bought through the API at any price.
`;

function fail(message: string, code = 2): never {
  process.stderr.write(`porkbun: ${message}\n`);
  process.exit(code);
}

/** A yes/no on stdin. Non-interactive callers must pass --yes rather than hang. */
async function confirm(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) {
    throw new UsageError('not a terminal — pass --yes to confirm non-interactively');
  }
  process.stderr.write(`${question} [y/N] `);
  const answer = await new Promise<string>((resolve) => {
    process.stdin.setEncoding('utf8');
    process.stdin.once('data', (chunk) => resolve(String(chunk)));
  });
  return /^y(es)?$/i.test(answer.trim());
}

if (isMain(import.meta.url)) {
  try {
    const parsed = parseArgs(process.argv.slice(2), {
      boolean: ['--json', '--dry-run', '--yes', '--no-whois-privacy', '-h', '--help'],
      string: ['--type', '--name', '--ttl', '--prio', '--max-price'],
    });

    if (parsed.flags.has('-h') || parsed.flags.has('--help') || parsed.positional.length === 0) {
      process.stdout.write(USAGE);
      process.exit(0);
    }

    const [command, ...rest] = parsed.positional;
    const json = parsed.flags.has('--json');
    const assumeYes = parsed.flags.has('--yes');

    const call = porkbunCaller(credentialsFrom(resolveCredentials(process.env)));

    const needDomain = (): string => {
      const domain = rest[0];
      if (!domain) throw new UsageError(`${command} needs a domain`);
      return domain.trim().toLowerCase().replace(/\.$/, '');
    };

    const recordInput = (host: string, type: string, content: string): RecordInput => {
      // Checked here rather than through `integer`'s own range, whose message
      // ("must be between 600 and 9007199254740991") names a bound nobody set
      // and does not say the floor is Porkbun's rather than ours.
      const ttl = integer(parsed.values, '--ttl', MIN_TTL);
      if (ttl < MIN_TTL) {
        throw new UsageError(`--ttl must be at least ${MIN_TTL}; Porkbun rejects anything lower`);
      }
      return {
        host,
        type,
        content,
        ttl,
        ...(parsed.values.has('--prio')
          ? { prio: integer(parsed.values, '--prio', 0, { max: 65_535 }) }
          : {}),
      };
    };

    switch (command) {
      case 'ping': {
        process.stdout.write(`ok, Porkbun sees you at ${await ping(call)}\n`);
        break;
      }

      case 'domains': {
        const domains = await listDomains(call);
        process.stdout.write(json ? `${JSON.stringify(domains, null, 2)}\n` : `${domains.join('\n')}\n`);
        break;
      }

      case 'ls':
      case 'list': {
        const domain = needDomain();
        let records = await listRecords(call, domain);

        const host = parsed.values.get('--name');
        const type = parsed.values.get('--type');
        if (host !== undefined) records = matchRecords(records, domain, host, type);
        else if (type) records = records.filter((r) => r.type === type.toUpperCase());

        process.stdout.write(
          json
            ? `${JSON.stringify(sortRecords(records, domain), null, 2)}\n`
            : `${formatRecords(records, domain)}\n`,
        );
        break;
      }

      case 'set': {
        const domain = needDomain();
        const [, host, type, content] = rest;
        if (!host || !type || !content) throw new UsageError('set needs <host> <type> <content>');

        const outcome = await setRecord(call, domain, recordInput(host, type, content));
        process.stdout.write(
          `${outcome.action} ${type.toUpperCase()} ${fqdn(domain, hostLabel(domain, host))}` +
            ` -> ${content} (id ${outcome.id})\n`,
        );
        break;
      }

      case 'add': {
        const domain = needDomain();
        const [, host, type, content] = rest;
        if (!host || !type || !content) throw new UsageError('add needs <host> <type> <content>');

        const id = await createRecord(call, domain, recordInput(host, type, content));
        process.stdout.write(
          `created ${type.toUpperCase()} ${fqdn(domain, hostLabel(domain, host))} -> ${content} (id ${id})\n`,
        );
        break;
      }

      case 'rm':
      case 'delete': {
        const domain = needDomain();
        const target = rest[1];
        if (!target) throw new UsageError('rm needs a record id, or a host with --type');

        // A bare number is an id; anything else is a host, and a host without a
        // type could match several records of different types at once.
        let doomed: { id: string; label: string }[];
        if (/^\d+$/.test(target)) {
          doomed = [{ id: target, label: `record ${target}` }];
        } else {
          const type = parsed.values.get('--type');
          if (!type) throw new UsageError('deleting by host needs --type, to say which record');
          const matches = matchRecords(await listRecords(call, domain), domain, target, type);
          if (matches.length === 0) {
            fail(`no ${type.toUpperCase()} record for ${fqdn(domain, hostLabel(domain, target))}`, 1);
          }
          doomed = matches.map((record) => ({
            id: record.id,
            label: `${record.type} ${record.name} -> ${record.content}`,
          }));
        }

        if (!assumeYes) {
          for (const item of doomed) process.stderr.write(`  ${item.label}\n`);
          if (!(await confirm(`delete ${doomed.length} record(s)?`))) {
            process.stderr.write('cancelled\n');
            process.exit(1);
          }
        }

        for (const item of doomed) {
          await deleteRecord(call, domain, item.id);
          process.stdout.write(`deleted ${item.label}\n`);
        }
        break;
      }

      case 'forwards': {
        const domain = needDomain();
        const forwards = await listForwards(call, domain);
        process.stdout.write(
          json ? `${JSON.stringify(forwards, null, 2)}\n` : `${formatForwards(forwards, domain)}\n`,
        );
        break;
      }

      case 'unpark': {
        const domain = needDomain();
        const plan = planUnpark(await listRecords(call, domain), await listForwards(call, domain));

        if (plan.empty) {
          process.stdout.write(`${domain} is not parked — nothing to remove\n`);
          break;
        }

        for (const forward of plan.forwards) {
          process.stderr.write(`  forward ${forward.id}: ${fqdn(domain, forward.subdomain)} -> ${forward.location}\n`);
        }
        for (const record of plan.records) {
          process.stderr.write(`  record  ${record.id}: ${record.type} ${record.name} -> ${record.content}\n`);
        }

        if (parsed.flags.has('--dry-run')) {
          process.stdout.write('--dry-run: nothing deleted\n');
          break;
        }
        if (!assumeYes && !(await confirm(`remove parking from ${domain}?`))) {
          process.stderr.write('cancelled\n');
          process.exit(1);
        }

        for (const forward of plan.forwards) {
          await deleteForward(call, domain, forward.id);
          process.stdout.write(`deleted forward ${forward.id}\n`);
        }

        // Deleting a forward takes its ALIAS and wildcard CNAME with it, so the
        // plan's record ids are usually already gone by now and deleting them
        // by id would report "Invalid record ID" for something that worked.
        // Re-read and remove only what actually survived.
        const survivors = (await listRecords(call, domain)).filter((record) =>
          plan.records.some((planned) => planned.id === record.id),
        );
        for (const record of survivors) {
          await deleteRecord(call, domain, record.id);
          process.stdout.write(`deleted record ${record.id} (${record.type} ${record.content})\n`);
        }

        const removed = plan.records.length - survivors.length;
        if (removed > 0) {
          process.stdout.write(`${removed} parking record(s) went with the forward\n`);
        }
        process.stdout.write(`${domain} un-parked\n`);
        break;
      }

      case 'check': {
        const domain = needDomain();
        const availability = await checkAvailability(call, domain);

        if (json) {
          process.stdout.write(`${JSON.stringify(availability, null, 2)}\n`);
          break;
        }
        if (!availability.available) {
          process.stdout.write(`${domain} is taken\n`);
          process.exit(1);
        }
        process.stdout.write(
          `${domain} is available — ${availability.price}` +
            `${availability.minDuration > 1 ? ` for ${availability.minDuration} years` : '/yr'}` +
            `${availability.premium ? ' (premium)' : ''}\n` +
            (availability.renewal && availability.renewal !== availability.price
              ? `renews at ${availability.renewal}/yr\n`
              : ''),
        );
        break;
      }

      case 'register': {
        const domain = needDomain();

        // Priced in dollars because that is how the prompt reads it back;
        // `integer` would reject the cents, so the shared money parser does it.
        let maxCents: number | undefined;
        const maxPrice = parsed.values.get('--max-price');
        if (maxPrice !== undefined) {
          try {
            maxCents = priceCents(maxPrice.replace(/^\$/, ''));
          } catch {
            throw new UsageError(`--max-price must be an amount in dollars, got ${JSON.stringify(maxPrice)}`);
          }
        }

        const plan = await planRegistration(call, domain, {
          whoisPrivacy: !parsed.flags.has('--no-whois-privacy'),
          ...(maxCents === undefined ? {} : { maxCents }),
        });

        const term = plan.years && plan.years > 1 ? `${plan.years} years` : '1 year';
        process.stderr.write(
          `  ${plan.domain}  ${plan.price} for ${term}${plan.premium ? '  (premium)' : ''}\n` +
            `  whois privacy: ${plan.whoisPrivacy ? 'on' : 'OFF — your contacts will be public'}\n` +
            `  auto-renew: on${plan.renewal ? `, at ${plan.renewal}/yr` : ''}\n`,
        );
        // A first year that renews dearer is the one surprise worth shouting
        // about: the price agreed to here is not the price paid next year.
        if (plan.firstYearPromo) {
          process.stderr.write('  note: promotional first year — the renewal price is higher\n');
        }

        // Porkbun's own pre-flight, not a local one: funds, the monthly spend
        // cap and account verification are account-level gates that no read
        // endpoint reports, so this is the only way to see them before paying.
        const preview = await previewRegistration(call, plan);
        process.stderr.write(`  credit: ${preview.balance ?? 'unknown'}\n`);

        if (preview.withinMonthlySpendLimit === false) {
          throw new PorkbunError(`${plan.domain} would exceed the account's monthly API spend cap`);
        }
        // Registration spends prepaid credit; there is no card to fall back on,
        // so short funds is a stop rather than a note. Say the shortfall, since
        // "insufficient funds" without a number means another round trip.
        if (preview.sufficientFunds === false) {
          const short =
            preview.balanceCents === null
              ? ''
              : ` — ${formatPrice((plan.costCents - preview.balanceCents) / 100)} short`;
          throw new PorkbunError(
            `not enough Porkbun credit to register ${plan.domain}${short}.\n` +
              '  Registration spends prepaid credit, not a card. Add credit at ' +
              'https://porkbun.com/account/billing',
          );
        }
        if (!preview.wouldSucceed) {
          throw new PorkbunError(
            `Porkbun refused the pre-flight for ${plan.domain}` +
              `${preview.message ? `: ${preview.message}` : ''}`,
          );
        }

        if (parsed.flags.has('--dry-run')) {
          process.stdout.write('--dry-run: pre-flight passed, nothing registered\n');
          break;
        }
        if (!assumeYes && !(await confirm(`register ${plan.domain} for ${plan.price}?`))) {
          process.stderr.write('cancelled\n');
          process.exit(1);
        }

        await registerDomain(call, plan);
        process.stdout.write(`registered ${plan.domain} for ${plan.price}\n`);
        // API access is per-domain and off by default, so the very next thing
        // anyone tries — pointing the new name somewhere — fails with "Invalid
        // domain" until it is switched on. Say so before that happens.
        process.stdout.write(
          `turn on API access for it at https://porkbun.com/account/domainsSpeedy ` +
            `before \`porkbun set ${plan.domain} ...\` will work\n`,
        );
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
    if (error instanceof PorkbunError) fail(error.message, 1);
    fail(error instanceof Error ? error.message : String(error), 1);
  }
}
