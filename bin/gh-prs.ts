#!/usr/bin/env -S npx --yes tsx
/**
 * gh-prs — list every open pull request across the owners you name.
 *
 *   gh-prs --orgs profullstack,moshcoder,h4kr,infernetprotocol
 *   gh-prs --users octocat,hubot
 *   gh-prs --orgs profullstack --users octocat
 */

import { csv, integer, parseArgs, UsageError } from '../src/args.ts';
import { isMain } from '../src/is-main.ts';
import { list } from '../src/prs-list.ts';

const USAGE = `Usage:
  gh-prs --orgs ORG1,ORG2 [--users USER1,USER2] [--limit NUMBER]
  gh-prs --users USER1,USER2 [--limit NUMBER]

Options:
  --orgs ORG1,ORG2       Search repositories owned by these organizations
  --users USER1,USER2    Search repositories owned by these personal accounts
  --limit NUMBER         Maximum PRs per owner; default 1000
  --no-links             Never emit terminal hyperlinks
  -h, --help             Show this help

Examples:
  gh-prs --orgs profullstack,moshcoder,h4kr,infernetprotocol
  gh-prs --users octocat,hubot
`;

async function main(argv: string[]): Promise<number> {
  const parsed = parseArgs(argv, {
    boolean: ['--no-links', '-h', '--help'],
    string: ['--orgs', '--users', '--limit'],
  });

  if (parsed.flags.has('-h') || parsed.flags.has('--help')) {
    process.stdout.write(USAGE);
    return 0;
  }

  const orgs = csv(parsed.values, '--orgs');
  const users = csv(parsed.values, '--users');

  if (orgs.length === 0 && users.length === 0) {
    process.stderr.write(USAGE);
    throw new UsageError('pass --orgs, --users, or both');
  }

  const options = {
    orgs,
    users,
    limit: integer(parsed.values, '--limit', 1000, { min: 1, max: 1000 }),
    ...(parsed.flags.has('--no-links') ? { hyperlinks: false } : {}),
  };

  process.stdout.write(`${await list(options)}\n`);
  return 0;
}

if (isMain(import.meta.url)) {
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch (error) {
    if (error instanceof UsageError) {
      process.stderr.write(`gh-prs: ${error.message}\n`);
      process.exitCode = 2;
    } else {
      process.stderr.write(
        `gh-prs: ${error instanceof Error ? error.message : String(error)}\n`,
      );
      process.exitCode = 1;
    }
  }
}
