#!/usr/bin/env node
/**
 * argontv — the line behind the Live TV passes.
 *
 *   argontv                    is the line healthy, and is there room to sell
 *   argontv status             the same, spelled out
 *   argontv slots              free connections right now, for a sale gate
 *   argontv slots --json       the same, for a script or a webhook
 *   argontv catalogue          how many live channels, films and series
 *   argontv templates          the reseller's templates (needs the account key)
 *
 * `slots` is the one that matters when a pass is sold. A single shared line
 * permits a fixed number of simultaneous streams, so how many passes may exist
 * is bounded by that number rather than by demand: sell a seventh pass against
 * six connections and the seventh buyer is told to come back later, having paid.
 *
 * Exit codes are the point of `slots`, so it can gate a sale from a shell:
 *   0  there is room
 *   3  the line is full
 *   4  the line could not be reached or refused the credentials
 */

import {
  catalogue,
  daysLeft,
  lineFromEnv,
  lineStatus,
  reseller,
  resellerKey,
  slots,
} from '../src/argontv.ts';
import { isMain } from '../src/is-main.ts';

const HELP = `argontv — the line behind the Live TV passes

  argontv [status]        line health, expiry and free connections
  argontv slots [--json]  free connections now; exit 3 when full
  argontv catalogue       live / films / series counts
  argontv templates       reseller templates (needs IPTV_ARGON_API_KEY)

Credentials, environment first then ~/.config/cli-tools/credentials.json:
  ARGONTV_LINE_SERVER    e.g. http://panel.example
  ARGONTV_LINE_USERNAME
  ARGONTV_LINE_PASSWORD
  IPTV_ARGON_API_KEY     reseller account key, for templates only
`;

const NO_LINE = `argontv: no line configured.

Set ARGONTV_LINE_SERVER, ARGONTV_LINE_USERNAME and ARGONTV_LINE_PASSWORD, or put
them in ~/.config/cli-tools/credentials.json. These are the line's own Xtream
credentials, the same pair a buyer would use in a player.
`;

const fmtDate = (d: Date | null) => (d ? d.toISOString().replace('T', ' ').slice(0, 16) : 'unknown');

async function main(argv: string[]): Promise<number> {
  const args = argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    process.stdout.write(HELP);
    return 0;
  }

  const json = args.includes('--json');
  const command = args.find((a) => !a.startsWith('-')) ?? 'status';

  if (command === 'templates') {
    const key = resellerKey();
    if (!key) {
      process.stderr.write(
        'argontv: no reseller key. Set IPTV_ARGON_API_KEY.\n' +
          'It is issued by distributors.argontv.nl and cannot be generated locally.\n',
      );
      return 4;
    }
    try {
      const data = (await reseller('/api/v1/templates', { key })) as { templates?: unknown[] };
      const list = data.templates ?? [];
      if (json) {
        process.stdout.write(`${JSON.stringify(list, null, 2)}\n`);
        return 0;
      }
      if (list.length === 0) {
        process.stdout.write('No templates on that account.\n');
        return 0;
      }
      for (const t of list as Array<Record<string, unknown>>) {
        process.stdout.write(`${String(t.id ?? '?').padStart(6)}  ${String(t.name ?? '')}\n`);
      }
      return 0;
    } catch (error) {
      process.stderr.write(`argontv: ${(error as Error).message}\n`);
      return 4;
    }
  }

  const line = lineFromEnv();
  if (!line) {
    process.stderr.write(NO_LINE);
    return 4;
  }

  let status: Awaited<ReturnType<typeof lineStatus>>;
  try {
    status = await lineStatus(line);
  } catch (error) {
    process.stderr.write(`argontv: ${(error as Error).message}\n`);
    return 4;
  }

  const room = slots(status);

  if (command === 'slots') {
    if (json) {
      process.stdout.write(`${JSON.stringify({ ...room, status: status.status })}\n`);
    } else {
      process.stdout.write(
        `${room.free ?? '?'} of ${room.capacity ?? '?'} connections free` +
          `${room.sellable === null ? '' : `, ${room.sellable} passes sellable`}\n`,
      );
    }
    // The gate. A caller selling a pass checks this exit code, not the text.
    return room.free !== null && room.free <= 0 ? 3 : 0;
  }

  if (command === 'catalogue') {
    const c = await catalogue(line);
    if (json) {
      process.stdout.write(`${JSON.stringify(c)}\n`);
      return 0;
    }
    process.stdout.write(
      `live    ${c.live.toLocaleString('en-US').padStart(10)}\n` +
        `films   ${c.movies.toLocaleString('en-US').padStart(10)}\n` +
        `series  ${c.series.toLocaleString('en-US').padStart(10)}  (shows, not episodes)\n`,
    );
    return 0;
  }

  if (command !== 'status') {
    process.stderr.write(`argontv: unknown command "${command}"\n\n${HELP}`);
    return 2;
  }

  const days = daysLeft(status.expiresAt);
  if (json) {
    process.stdout.write(
      `${JSON.stringify({ ...status, ...room, daysLeft: days }, null, 2)}\n`,
    );
    return 0;
  }

  process.stdout.write(
    `status       ${status.status}${status.isTrial ? ' (trial)' : ''}\n` +
      `connections  ${room.free ?? '?'} free of ${room.capacity ?? '?'}\n` +
      `sellable     ${room.sellable ?? '?'} passes` +
      `${room.reserved > 0 ? `  (${room.reserved} connection held back)` : ''}\n` +
      `expires      ${fmtDate(status.expiresAt)}${days === null ? '' : `  (${days} days)`}\n` +
      `formats      ${status.formats.join(', ') || 'unknown'}\n`,
  );

  // Said out loud rather than left to be inferred from the numbers: the whole
  // product is bounded by this, and it is the number people forget.
  if (room.capacity !== null && room.sellable !== null) {
    process.stdout.write(
      `\nAt most ${room.capacity} streams at once across every site, so ${room.sellable} active passes` +
        `${room.reserved > 0 ? ` and ${room.reserved} spare for us` : ''}.\n`,
    );
  }
  if (days !== null && days <= 7) {
    process.stdout.write(`Warning: this line expires in ${days} days.\n`);
  }
  return 0;
}

if (isMain(import.meta.url)) {
  main(process.argv)
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      process.stderr.write(`argontv: ${(error as Error).message}\n`);
      process.exitCode = 1;
    });
}

export { main };
