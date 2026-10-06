#!/usr/bin/env node
/**
 * dealsubs — subscribe an inbox to coupon and deal newsletters, throttled.
 *
 *   dealsubs run --email submit@c0upons.com --max 4
 *   dealsubs status
 *   dealsubs list
 *   dealsubs reset <site-id>
 *
 * See src/dealsubs.ts. cron runs it after `fe ensure` has made sure the address
 * actually receives mail, so no confirmation is ever sent into the void.
 */

import { createWriteStream, mkdirSync, type WriteStream } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { UsageError, integer, parseArgs } from '../src/args.ts';
import { isMain } from '../src/is-main.ts';
import {
  DAILY_CAP,
  dataDir,
  loadCatalog,
  loadLedger,
  notDue,
  planRun,
  record,
  saveLedger,
  subscribe,
  withLock,
} from '../src/dealsubs.ts';
import { TronSession } from '../src/jobs-apply.ts';
import { defaultAutomateBin, expandHome, loadJobsConfig } from '../src/jobs-config.ts';

const CATALOG = join(dirname(fileURLToPath(import.meta.url)), '..', 'data', 'deal-newsletters.json');

const USAGE = `Usage:
  dealsubs run --email ADDRESS [--max N] [--dry-run]
  dealsubs status [--json]
  dealsubs list
  dealsubs reset <site-id>
  dealsubs probe <site-id>... | --all

Commands:
  run      try the next due sites (default --max 3, at most ${DAILY_CAP} a day)
  status   every site's last outcome
  list     the catalog (data/deal-newsletters.json)
  reset    forget a site's attempts so it is tried again (after fixing its url)
  probe    open sites and report the form it would use, submitting nothing, recording nothing

A site is tried at most twice, a week apart, and never again once it subscribed
or showed a CAPTCHA. The ledger is ${join(dataDir(), 'ledger.json')}.
Browser: TronBrowser (TRON_AUTOMATE_BIN / TRON_CHROMIUM_BIN, or jobhunt's config).
`;

function openTron(log: WriteStream): TronSession {
  const { config } = loadJobsConfig();
  const chromium = process.env.TRON_CHROMIUM_BIN ?? config.tron.chromiumBin;
  const automate = expandHome(process.env.TRON_AUTOMATE_BIN ?? config.tron.automateBin ?? defaultAutomateBin());
  return new TronSession(automate, chromium ? expandHome(chromium) : null, log);
}

function fail(message: string, code = 2): never {
  process.stderr.write(`dealsubs: ${message}\n`);
  process.exit(code);
}

if (isMain(import.meta.url)) {
  try {
    const parsed = parseArgs(process.argv.slice(2), {
      boolean: ['--json', '--dry-run', '--all', '-h', '--help'],
      string: ['--email', '--max'],
    });
    if (parsed.flags.has('-h') || parsed.flags.has('--help') || parsed.positional.length === 0) {
      process.stdout.write(USAGE);
      process.exit(0);
    }
    const [command, ...rest] = parsed.positional;
    const dir = dataDir();
    mkdirSync(dir, { recursive: true });
    const ledgerPath = join(dir, 'ledger.json');
    const catalog = loadCatalog(CATALOG);
    const now = new Date();

    switch (command) {
      case 'list': {
        for (const s of catalog) process.stdout.write(`${s.id.padEnd(20)} ${s.kind.padEnd(8)} ${s.url}\n`);
        break;
      }

      case 'status': {
        const ledger = loadLedger(ledgerPath);
        if (parsed.flags.has('--json')) {
          process.stdout.write(`${JSON.stringify(ledger, null, 2)}\n`);
          break;
        }
        process.stdout.write(`inbox: ${ledger.email ?? '(none yet)'}\n`);
        for (const s of catalog) {
          const rec = ledger.sites[s.id];
          const last = rec?.attempts.at(-1);
          const why = notDue(rec, now);
          process.stdout.write(
            `${s.id.padEnd(20)} ${(rec?.status ?? 'pending').padEnd(11)} ${last ? last.at.slice(0, 16) : ''.padEnd(16)}  ${why ?? 'due'}${last ? `  ${last.note}` : ''}\n`,
          );
        }
        break;
      }

      case 'reset': {
        const id = rest[0];
        if (!id) throw new UsageError('reset needs a site id');
        const ledger = loadLedger(ledgerPath);
        delete ledger.sites[id];
        saveLedger(ledgerPath, ledger);
        process.stdout.write(`reset ${id}\n`);
        break;
      }

      case 'probe': {
        const wanted = parsed.flags.has('--all') ? catalog : catalog.filter((s) => rest.includes(s.id));
        if (!wanted.length) throw new UsageError('probe needs site ids or --all');
        const log = createWriteStream(join(dir, 'tron.log'), { flags: 'a' });
        for (const site of wanted) {
          const tron = openTron(log);
          try {
            await tron.initialize();
            const r = await subscribe(tron, site, 'probe@example.invalid', { submit: false });
            process.stdout.write(`${site.id.padEnd(20)} ${r.status.padEnd(9)} ${r.note}\n`);
          } catch (err) {
            process.stdout.write(`${site.id.padEnd(20)} error     ${String((err as Error)?.message ?? err)}\n`);
          } finally {
            await tron.close();
          }
        }
        log.end();
        break;
      }

      case 'run': {
        const email = parsed.values.get('--email');
        if (!email || !/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i.test(email)) throw new UsageError('run needs --email ADDRESS');
        const max = integer(parsed.values, '--max', 3, { min: 1, max: DAILY_CAP });
        await withLock(join(dir, 'run.lock'), async () => {
          const ledger = loadLedger(ledgerPath);
          if (ledger.email && ledger.email !== email) {
            throw new UsageError(`the ledger belongs to ${ledger.email}; use a different XDG_DATA_HOME for ${email}`);
          }
          ledger.email = email;
          const plan = planRun(catalog, ledger, now, max);
          if (!plan.length) {
            process.stdout.write('nothing due (daily cap reached, or every site done or waiting)\n');
            return;
          }
          if (parsed.flags.has('--dry-run')) {
            for (const s of plan) process.stdout.write(`would try ${s.id} ${s.url}\n`);
            return;
          }
          const log = createWriteStream(join(dir, 'tron.log'), { flags: 'a' });
          for (const site of plan) {
            // A fresh browser per site: one site's popups and cookies never leak into the next.
            const tron = openTron(log);
            let outcome;
            try {
              await tron.initialize();
              outcome = await subscribe(tron, site, email);
            } catch (err) {
              outcome = { status: 'error' as const, note: String((err as Error)?.message ?? err) };
            } finally {
              await tron.close();
            }
            record(ledger, site, outcome.status, outcome.note, new Date());
            saveLedger(ledgerPath, ledger);
            process.stdout.write(`${new Date().toISOString()} ${site.id} ${outcome.status}: ${outcome.note}\n`);
          }
          log.end();
        });
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
