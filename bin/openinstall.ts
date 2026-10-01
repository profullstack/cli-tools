#!/usr/bin/env node
/**
 * openinstall — give a repo an idempotent bin/install.sh (OpenInstall).
 *
 *   openinstall init [dir] [--port 3100 --start "bun run start" --domains "a.com www.a.com" --postgres]
 *   openinstall check [dir]
 *   openinstall print
 *
 * The script it writes is the one `sh1pt ship --target deploy-ssh` runs on
 * the server; spec at https://logicsrc.com/openinstall.
 */

import { resolve } from 'node:path';

import { UsageError, parseArgs } from '../src/args.ts';
import { isMain } from '../src/is-main.ts';
import { OpenInstallError, check, init, template } from '../src/openinstall.ts';

const USAGE = `Usage:
  openinstall init [dir] [options]   write bin/install.sh and bin/install.conf
  openinstall check [dir]            is bin/install.sh present, runnable and current?
  openinstall print                  print the generic install.sh

bin/install.sh puts the app into service on the box it runs on, and running it
twice changes nothing: runtime (bun/node), postgres and redis, the build, a
systemd unit, an nginx site with TLS, and a health check.

  ./bin/install.sh            # setup + build + activate
  ./bin/install.sh status

init options (written to bin/install.conf, which init never overwrites without --force):
      --app <name>        defaults to the repo directory name
      --runtime <r>       auto | bun | node | static
      --port <n>          the app listens here on loopback (default 3000)
      --start <cmd>       defaults to the package.json start script
      --build <cmd>       defaults to the package.json build script
      --domains <list>    nginx site + Let's Encrypt for these hosts
      --postgres          a local database, DATABASE_URL in db.env
      --redis             a local redis, REDIS_URL in db.env
  -f, --force             replace a bin/install.sh or install.conf that differs
  -h, --help              show this help

Spec: https://logicsrc.com/openinstall
`;

if (isMain(import.meta.url)) {
  try {
    const { flags, values, positional } = parseArgs(process.argv.slice(2), {
      boolean: ['-h', '--help', '-f', '--force', '--postgres', '--redis'],
      string: ['--app', '--runtime', '--port', '--start', '--build', '--domains'],
    });
    const [sub, dirArg] = positional;
    if (flags.has('-h') || flags.has('--help') || !sub) {
      process.stdout.write(USAGE);
      process.exit(sub || flags.has('-h') || flags.has('--help') ? 0 : 1);
    }
    const dir = resolve(dirArg ?? '.');

    if (sub === 'print') {
      process.stdout.write(template());
      process.exit(0);
    }

    if (sub === 'init') {
      const port = values.get('--port');
      if (port !== undefined && !/^\d+$/.test(port)) throw new UsageError('--port must be a number');
      const r = init(dir, {
        app: values.get('--app'),
        runtime: values.get('--runtime'),
        port,
        start: values.get('--start'),
        build: values.get('--build'),
        domains: values.get('--domains'),
        postgres: flags.has('--postgres'),
        redis: flags.has('--redis'),
      }, { force: flags.has('-f') || flags.has('--force') });
      process.stdout.write(`bin/install.sh    ${r.script}\nbin/install.conf  ${r.conf}\n`);
      if (r.script === 'kept') process.stdout.write('openinstall: bin/install.sh differs from the generic copy and was left alone (--force replaces it)\n');
      if (r.conf === 'kept') process.stdout.write('openinstall: bin/install.conf already exists and was left alone (--force replaces it)\n');
      process.stdout.write('next: commit bin/, then ./bin/install.sh on the server, or sh1pt ship --target deploy-ssh\n');
      process.exit(0);
    }

    if (sub === 'check') {
      const r = check(dir);
      for (const p of r.problems) process.stdout.write(`FAIL  ${p}\n`);
      for (const n of r.notes) process.stdout.write(`note  ${n}\n`);
      if (r.ok) process.stdout.write('ok    bin/install.sh is an OpenInstall script\n');
      process.exit(r.ok ? 0 : 1);
    }

    throw new UsageError(`unknown command "${sub}" (init | check | print)`);
  } catch (error) {
    if (error instanceof UsageError || error instanceof OpenInstallError) {
      process.stderr.write(`openinstall: ${error.message}\n`);
      process.exit(1);
    }
    process.stderr.write(`openinstall: ${error instanceof Error ? error.message : error}\n`);
    process.exit(2);
  }
}
