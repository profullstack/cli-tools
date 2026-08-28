#!/usr/bin/env -S npx --yes tsx
/**
 * shorten — mint a short link on the Moshpit registry and print it.
 *
 *   shorten https://example.com/a-very-long-address
 *   → https://pit.moshcode.sh/f/k7mq2xd
 *
 * The redirect is served by the registry at `/f/<code>`, so the link works for
 * anyone, not only for machines that have heard of Moshpit. `moshcode` has the
 * same thing as `/shorten` inside the pit; this is the copy that pipes.
 */

import { UsageError, integer, parseArgs } from '../src/args.ts';
import { resolveCredentials } from '../src/credentials.ts';
import { isMain } from '../src/is-main.ts';
import {
  ShortenError,
  baseUrl,
  formatLink,
  formatList,
  listLinks,
  registryCaller,
  removeLink,
  resolveToken,
  shorten,
} from '../src/shorten.ts';

const USAGE = `Usage:
  shorten <url> [--name <moshpit-name>]
  shorten list
  shorten rm <code>

Mints a short link on pit.moshcode.sh. /f/<code> answers a 302 to your url.

Options:
      --name N     file the link under a Moshpit name you hold
      --bare       print the short url only, nothing else
      --json       the registry's answer as JSON
      --timeout MS API timeout (default: 20000)
  -h, --help       show this help

Needs a moshcode account. On a machine where the pit works there is nothing to
configure — the token \`moshcode login\` wrote is picked up automatically.
Otherwise:

  cli-tools config set moshcode        # prompts, nothing echoed or logged

MOSHCODE_API_KEY still works and takes precedence over a stored key.

Shortening the same url twice returns the same code, so this is safe to retry.
The short url goes to stdout and nothing else does, so it pipes cleanly.
`;

if (isMain(import.meta.url)) {
  try {
    const { flags, values, positional } = parseArgs(process.argv.slice(2), {
      boolean: ['-h', '--help', '--bare', '--json'],
      string: ['--name', '--timeout'],
    });

    if (flags.has('-h') || flags.has('--help') || positional.length === 0) {
      process.stdout.write(USAGE);
      process.exit(positional.length === 0 && !flags.has('-h') && !flags.has('--help') ? 1 : 0);
    }

    const timeout = integer(values, '--timeout', 20_000, { min: 1000, max: 600_000 });

    // Stored keys first, environment on top — see src/credentials.ts — then the
    // token moshcode itself wrote, which is the usual case.
    const token = resolveToken(process.env, resolveCredentials(process.env));
    if (!token) {
      throw new UsageError(
        'no moshcode credentials — run `moshcode login`, ' +
          'or `cli-tools config set moshcode`, or export MOSHCODE_API_KEY',
      );
    }

    const base = baseUrl(process.env);
    const call = registryCaller(token, base, timeout);
    const verb = positional[0]!.toLowerCase();

    if (verb === 'list' || verb === 'ls') {
      const links = await listLinks(call);
      process.stdout.write(
        flags.has('--json') ? `${JSON.stringify(links, null, 2)}\n` : formatList(links),
      );
    } else if (verb === 'rm' || verb === 'delete') {
      const code = positional[1];
      if (!code) throw new UsageError('usage: shorten rm <code>');
      const removed = await removeLink(code, call);
      process.stdout.write(
        flags.has('--json') ? `${JSON.stringify({ code: removed, deleted: true })}\n` : '',
      );
      process.stderr.write(`took down /f/${removed}\n`);
    } else {
      // Anything else is the url. Not validated here: the registry owns the one
      // implementation of what may be shortened, and a looser second copy in a
      // client is how the two drift apart.
      const name = values.get('--name');
      const link = await shorten(positional[0]!, call, { name });
      process.stdout.write(
        flags.has('--json')
          ? `${JSON.stringify(link, null, 2)}\n`
          : formatLink(link, { bare: flags.has('--bare') }),
      );
      // Status on stderr so it never lands in a pipe. Worth saying: a second
      // run returns the first code rather than minting another.
      if (link.created === false) process.stderr.write('already shortened — same code as before\n');
    }
  } catch (error) {
    if (error instanceof UsageError || error instanceof ShortenError) {
      process.stderr.write(`shorten: ${error.message}\n`);
      process.exit(1);
    }
    process.stderr.write(`shorten: ${error instanceof Error ? error.message : error}\n`);
    process.exit(2);
  }
}
