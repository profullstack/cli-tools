#!/usr/bin/env -S npx --yes tsx
/**
 * blog-post — write to the plain-HTML blog without getting a convention wrong.
 *
 * The blog has no build step: writing a file is publishing. Nothing else
 * catches a post with no date (the feed generator skips it in silence) or one
 * dated in the future (it pins above every real post, and readers that filter
 * future items drop it, so the feed looks dead while the files look fine).
 */

import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

import { parseArgs, UsageError } from '../src/args.ts';
import { isMain } from '../src/is-main.ts';
import {
  blogDir,
  createPost,
  DEFAULT_DIR,
  isoSeconds,
  lint,
  readPosts,
} from '../src/blog.ts';

const USAGE = `Usage:
  blog-post new <title> --description <text> [--body file.html] [--date ISO]
  blog-post check
  blog-post list
  blog-post feed

Commands:
  new      Write the next post, list it in index.html, rebuild the feed
  check    Report posts that will break the feed (non-zero exit if any)
  list     Every post with its date
  feed     Regenerate feed.xml

Options:
  --description TEXT  Feed summary. Required by \`new\`.
  --body FILE         HTML fragment for the body (default: a stub)
  --date ISO          Publish date (default: now). Refuses the future.
  --dir PATH          Blog directory (default: $BLOG_DIR, else
                      ${DEFAULT_DIR})
  --allow-future      Permit a future date. You almost never want this.
  -h, --help          show this help
`;

const SPEC = {
  boolean: ['--allow-future', '-h', '--help'],
  string: ['--description', '--body', '--date', '--dir'],
} as const;

/**
 * Regenerate feed.xml by running the blog's own generator.
 *
 * Shelling out rather than reimplementing: build-feed.mjs lives beside the
 * posts and is the single source of truth for the feed's shape.
 */
function rebuildFeed(dir: string): number {
  const script = join(dir, 'build-feed.mjs');
  if (!existsSync(script)) {
    process.stderr.write(`no build-feed.mjs in ${dir} — feed not regenerated\n`);
    return 1;
  }
  return spawnSync(process.execPath, [script], { cwd: dir, stdio: 'inherit' }).status ?? 1;
}

export async function run(argv: readonly string[]): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs(argv, SPEC);
  } catch (error) {
    if (error instanceof UsageError) {
      process.stderr.write(`${error.message}\n\n${USAGE}`);
      return 2;
    }
    throw error;
  }

  const { flags, values, positional } = parsed;

  if (flags.has('-h') || flags.has('--help') || positional.length === 0) {
    process.stdout.write(USAGE);
    return positional.length === 0 && !flags.has('-h') && !flags.has('--help') ? 1 : 0;
  }

  const [command, ...rest] = positional;
  const dir = blogDir(values.get('--dir'));

  if (!existsSync(dir)) {
    process.stderr.write(`blog directory not found: ${dir}\n`);
    return 1;
  }

  switch (command) {
    case 'new': {
      const title = rest.join(' ').trim();
      if (!title) {
        process.stderr.write('new: give a title\n');
        return 1;
      }

      const description = (values.get('--description') ?? '').trim();
      if (!description) {
        process.stderr.write('new: --description is required (it becomes the feed summary)\n');
        return 1;
      }

      const raw = values.get('--date');
      const when = raw ? new Date(raw) : new Date();
      if (Number.isNaN(when.getTime())) {
        process.stderr.write(`new: unparseable --date ${JSON.stringify(raw)}\n`);
        return 1;
      }
      if (when.getTime() > Date.now() && !flags.has('--allow-future')) {
        process.stderr.write(
          `new: ${isoSeconds(when)} is in the future.\n` +
            '     A future-dated post sits above every real post, and readers that hide\n' +
            '     future items drop it, so the feed looks dead. Pass --allow-future only\n' +
            '     if you genuinely mean to schedule it.\n',
        );
        return 1;
      }

      const bodyFile = values.get('--body');
      const body = bodyFile ? await readFile(bodyFile, 'utf8') : '';

      const { file, path } = await createPost(dir, {
        title,
        description,
        date: isoSeconds(when),
        body,
      });

      process.stdout.write(`created ${file}\n        ${path}\n        listed in index.html\n`);
      return rebuildFeed(dir);
    }

    case 'check': {
      const problems = lint(await readPosts(dir));
      if (problems.length === 0) {
        process.stdout.write('all posts look publishable\n');
        return 0;
      }
      for (const problem of problems) {
        process.stderr.write(`${problem.file}: ${problem.problem}\n`);
      }
      return 1;
    }

    case 'list': {
      for (const post of await readPosts(dir)) {
        const title = (post.title ?? '(no h1)').replace(/&mdash;/g, '—').slice(0, 52);
        process.stdout.write(`${post.file}  ${(post.date ?? 'NO-DATE').padEnd(22)} ${title}\n`);
      }
      return 0;
    }

    case 'feed':
      return rebuildFeed(dir);

    default:
      process.stderr.write(`unknown command: ${command}\n\n${USAGE}`);
      return 1;
  }
}

if (isMain(import.meta.url)) {
  process.exitCode = await run(process.argv.slice(2));
}
