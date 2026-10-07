#!/usr/bin/env node
/**
 * proxy — call the web through our paid proxies (Proxiware, Webshare, HProxy).
 *
 *   proxy https://example.com          body to stdout, US residential exit
 *   proxy -i -c gb https://example.com
 *   proxy ip | url | status | providers
 *   proxy serve [--port 8888]          local forward proxy + JSON API
 *   proxy mcp                          MCP server on stdio
 *   proxy tui                          accounts and a live exit test
 *
 * Everything past the keys is @profullstack/proxy, run in-process: `proxy
 * --help` is its help. The keys come from the shell, then the credential store,
 * then (once, cached) the team vault — the same keys `cli-tools config pull`
 * imports. See src/proxy.ts.
 */

import { run } from '@profullstack/proxy/cli';
import { isMain } from '../src/is-main.ts';
import { proxyEnv } from '../src/proxy.ts';

for (const stream of [process.stdout, process.stderr]) {
  stream.on('error', (error: NodeJS.ErrnoException) => {
    if (error.code === 'EPIPE') process.exit(0);
    throw error;
  });
}

if (isMain(import.meta.url)) {
  const argv = process.argv.slice(2);
  const quiet = argv.length === 0 || argv.includes('-h') || argv.includes('--help') || argv.includes('-v') || argv.includes('--version');
  const { env, source } = quiet
    ? { env: process.env as Record<string, string | undefined>, source: 'env' as const }
    : proxyEnv({ log: (line) => process.stderr.write(`${line}\n`) });

  if (source === 'none') {
    process.stderr.write(
      'proxy: no proxy credentials. Pull them with `cli-tools config pull`, or set one:\n' +
        '  cli-tools config set proxiware_proxy_user\n' +
        '  cli-tools config set proxiware_proxy_password\n' +
        '  cli-tools config set webshare        # Webshare API key (login is read from it)\n' +
        '  cli-tools config set hproxy          # HProxy API key (lines are generated from it)\n',
    );
  }

  run(argv, { env })
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: Error) => {
      process.stderr.write(`proxy: ${error.message}\n`);
      process.exitCode = 1;
    });
}
