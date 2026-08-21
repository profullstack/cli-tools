#!/usr/bin/env -S npx --yes tsx
/**
 * affiliate — work through a list of programs you mean to sign up for.
 *
 *   affiliate list --file programs.md
 *   affiliate next --open          # open the next one you have not done
 *   affiliate join elevenlabs https://try.elevenlabs.io/abc123
 *   affiliate links --format markdown
 *
 * It opens pages and remembers what came back. It does not fill the forms in:
 * accepting terms and entering payout identity is the applicant's to do, and it
 * is behind an email-verification loop regardless.
 */

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

import { UsageError, parseArgs } from '../src/args.ts';
import {
  type LinkFormat,
  ListError,
  type Profile,
  type Row,
  applyStatus,
  findRow,
  formatLinks,
  formatRows,
  merge,
  nextPending,
  openCommand,
  parseList,
  renderAnswers,
} from '../src/affiliates.ts';
import {
  loadProfile,
  loadState,
  profilePath,
  saveProfile,
  saveState,
  statePath,
} from '../src/affiliates-store.ts';
import { isMain } from '../src/is-main.ts';

const USAGE = `Usage:
  affiliate list [--file LIST]
  affiliate next [--open]
  affiliate open <index|name|--all>
  affiliate join <index|name> [REFERRAL_URL]
  affiliate skip <index|name>
  affiliate links [--format text|markdown|json]
  affiliate answers
  affiliate profile [--email E] [--site S] [--audience A] [--promotion P]

Walks a list of signup pages one at a time, remembers which you have dealt
with, and keeps the referral link each one gives back.

The list is any text with links in it — a bare column of URLs, a markdown
table, a bullet list, a CSV. The first URL on a line is the program and
whatever precedes it is the name.

Options:
      --file LIST   the list to read ("-" for stdin; default: $AFFILIATE_LIST)
      --open        with "next", open it in the browser as well
      --all         with "open", open every entry not yet done
      --format F    with "links": text | markdown | json
      --note TEXT   with "join" or "skip", a line to remember why
  -h, --help        show this help

Progress lives in ~/.config/cli-tools/affiliates.json and the application
answers in affiliate-profile.json, both 0600 ($CLI_TOOLS_AFFILIATES and
$CLI_TOOLS_AFFILIATE_PROFILE override).

The contact address is your --email, then $AFFILIATE_EMAIL, then the profile
file, then whoever \`moshcode whoami\` reports.

It never submits anything. Signing up accepts terms and hands over payout
identity as a named person, which is not something a script should do on
someone's behalf.
`;

function readList(values: Map<string, string>, env: NodeJS.ProcessEnv): string {
  const path = values.get('--file') ?? env.AFFILIATE_LIST;
  if (!path) {
    throw new UsageError('no list — pass --file LIST, or set $AFFILIATE_LIST');
  }

  try {
    return readFileSync(path === '-' ? 0 : path, 'utf8');
  } catch (error) {
    throw new UsageError(`cannot read ${path}: ${(error as Error).message}`);
  }
}

function rowsFor(values: Map<string, string>, env: NodeJS.ProcessEnv): Row[] {
  return merge(parseList(readList(values, env)), loadState(env));
}

/** Open a URL without a shell, so nothing in the list can become shell syntax. */
function openUrl(url: string, env: NodeJS.ProcessEnv): void {
  const [command, ...args] = openCommand(url, env);
  const result = spawnSync(command!, args, { stdio: 'ignore' });
  if (result.error) {
    throw new Error(`could not open a browser (${command}): ${result.error.message}`);
  }
}

if (isMain(import.meta.url)) {
  try {
    const { flags, values, positional } = parseArgs(process.argv.slice(2), {
      boolean: ['-h', '--help', '--open', '--all'],
      string: [
        '--file', '--format', '--note',
        '--email', '--site', '--audience', '--promotion',
      ],
    });

    const command = positional[0];
    if (flags.has('-h') || flags.has('--help') || !command) {
      process.stdout.write(USAGE);
      process.exit(command ? 0 : 1);
    }

    const env = process.env;

    switch (command) {
      case 'list': {
        process.stdout.write(formatRows(rowsFor(values, env)));
        break;
      }

      case 'next': {
        const rows = rowsFor(values, env);
        const row = nextPending(rows);
        if (!row) {
          process.stderr.write('affiliate: nothing left — every entry is joined or skipped\n');
          break;
        }

        process.stdout.write(`${row.index}  ${row.name}\n${row.url}\n`);
        if (flags.has('--open')) {
          openUrl(row.url, env);
          saveState(applyStatus(loadState(env), row, 'opened'), env);
          process.stderr.write('opened · record the link with `affiliate join`\n');
        }
        break;
      }

      case 'open': {
        const rows = rowsFor(values, env);
        const targets = flags.has('--all')
          ? rows.filter((row) => row.status === 'pending' || row.status === 'opened')
          : [findRow(rows, positional[1] ?? '')];

        if (!flags.has('--all') && !positional[1]) {
          throw new UsageError('which one? give an index or a name, or --all');
        }

        let state = loadState(env);
        for (const row of targets) {
          openUrl(row.url, env);
          state = applyStatus(state, row, 'opened');
          process.stdout.write(`${row.name}\t${row.url}\n`);
        }
        saveState(state, env);
        break;
      }

      case 'join':
      case 'skip': {
        const rows = rowsFor(values, env);
        if (!positional[1]) throw new UsageError(`which one? \`affiliate ${command} <index|name>\``);

        const row = findRow(rows, positional[1]);
        const referral = command === 'join' ? positional[2] : undefined;
        if (referral && !/^https?:\/\//i.test(referral)) {
          throw new UsageError(`that does not look like a link: ${referral}`);
        }

        const note = values.get('--note');
        saveState(
          applyStatus(
            loadState(env),
            row,
            command === 'join' ? 'joined' : 'skipped',
            { ...(referral ? { referral } : {}), ...(note ? { note } : {}) },
          ),
          env,
        );

        process.stdout.write(
          `${command === 'join' ? '✓' : '–'} ${row.name}${referral ? ` → ${referral}` : ''}\n`,
        );
        if (command === 'join' && !referral) {
          process.stderr.write(
            'no referral link recorded — add it with ' +
              `\`affiliate join ${row.index} <url>\` when you have it\n`,
          );
        }
        break;
      }

      case 'links': {
        const format = (values.get('--format') ?? 'text') as LinkFormat;
        if (!['text', 'markdown', 'json'].includes(format)) {
          throw new UsageError(`--format must be text, markdown or json, got "${format}"`);
        }

        // The state alone is enough here: a link you have earned should print
        // whether or not the list it came from is still on this machine.
        const rows = merge([], loadState(env));
        const out = formatLinks(rows, format);
        if (!out) {
          process.stderr.write('affiliate: no referral links recorded yet\n');
          break;
        }
        process.stdout.write(out);
        break;
      }

      case 'answers': {
        process.stdout.write(renderAnswers(loadProfile(env)));
        process.stderr.write(`${profilePath(env)}\n`);
        break;
      }

      case 'profile': {
        const updates: Partial<Profile> = {};
        for (const field of ['email', 'site', 'audience', 'promotion'] as const) {
          const value = values.get(`--${field}`);
          if (value !== undefined) updates[field] = value;
        }

        if (Object.keys(updates).length > 0) {
          const path = saveProfile(updates, env);
          process.stderr.write(`affiliate: written to ${path}\n`);
        }

        const profile = loadProfile(env);
        process.stdout.write(
          `email      ${profile.email ?? '(not set)'}\n` +
            `site       ${profile.site ?? '(not set)'}\n` +
            `audience   ${profile.audience ?? '(not set)'}\n` +
            `promotion  ${profile.promotion ?? '(not set)'}\n`,
        );
        break;
      }

      case 'where': {
        process.stdout.write(`${statePath(env)}\n${profilePath(env)}\n`);
        break;
      }

      default:
        throw new UsageError(`unknown command: ${command}`);
    }
  } catch (error) {
    if (error instanceof UsageError || error instanceof ListError) {
      process.stderr.write(`affiliate: ${error.message}\n`);
      process.exit(1);
    }
    process.stderr.write(`affiliate: ${error instanceof Error ? error.message : error}\n`);
    process.exit(2);
  }
}
