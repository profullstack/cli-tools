#!/usr/bin/env node
/**
 * dl -- pull a video, or just its audio, off a URL.
 *
 * A thin front for yt-dlp, in the same shape as `vid` is a thin front for
 * ffmpeg: it covers the handful of things worth not remembering the flags for
 * and gets out of the way for everything else. yt-dlp's own flags are the
 * reference; nothing here renames one of them.
 *
 * The download itself inherits stdio rather than being captured, because
 * yt-dlp's progress line is the entire user interface of a long transfer and a
 * captured one appears all at once, after the wait it was meant to explain.
 */

import { spawn } from 'node:child_process';

import { UsageError, integer, parseArgs } from '../src/args.ts';
import {
  downloadArgs,
  formatsArgs,
  infoArgs,
  looksLikeUrl,
  parseInfoStream,
  splitCommand,
} from '../src/download.ts';
import { isMain } from '../src/is-main.ts';
import { run } from '../src/exec.ts';
import { MissingEngineError, findFfmpeg, findYtDlp, humanDuration } from '../src/media.ts';

const USAGE = `Usage:
  dl <url>...                     download the video
  dl audio <url>...               download the audio only
  dl info <url>...                title, uploader, duration -- nothing downloaded
  dl formats <url>                every format yt-dlp will give you

Options:
      --height N     cap the video height (720, 1080, ...)
      --format EXT   audio container for \`dl audio\` (default: m4a)
      --to DIR       write into this directory (default: here)
  -o, --out TMPL     yt-dlp output template
      --playlist     take the whole list, not just the entry the URL points at
      --json         info as JSON
      --help         show this help

A YouTube link copied while a mix is playing carries \`list=\`, and yt-dlp reads
that as "download all of it". So one entry is the default and \`--playlist\` is
how you ask for the rest.

Needs yt-dlp on PATH (\`moshcode install yt-dlp\`). ffmpeg too for \`dl audio\`,
and for any video good enough that its picture and sound arrive separately --
without it, \`dl\` falls back to the best single stream and says that it did.
`;

/** Run a child with our stdio, and resolve its exit code. */
function passthrough(file: string, args: string[]): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(file, args, { stdio: 'inherit' });
    child.on('error', () => resolve(127));
    child.on('close', (code) => resolve(code ?? 1));
  });
}

if (isMain(import.meta.url)) {
  try {
    const { flags, values, positional } = parseArgs(process.argv.slice(2), {
      boolean: ['--help', '--playlist', '--json'],
      string: ['--height', '--format', '--to', '-o', '--out'],
    });

    if (flags.has('--help') || positional.length === 0) {
      process.stdout.write(USAGE);
      process.exit(positional.length === 0 ? 1 : 0);
    }

    const { verb, urls } = splitCommand(positional);
    if (urls.length === 0) throw new UsageError(`${verb} needs a URL`);
    for (const url of urls) {
      if (!looksLikeUrl(url)) throw new UsageError(`not a URL: ${url}`);
    }

    const ytdlp = await findYtDlp();
    if (!ytdlp) {
      throw new MissingEngineError(
        'yt-dlp is not on PATH. Install it (moshcode install yt-dlp / pipx install yt-dlp / brew install yt-dlp).',
      );
    }

    const playlist = flags.has('--playlist');

    if (verb === 'info') {
      const rows: string[] = [];
      const objects: unknown[] = [];
      for (const url of urls) {
        const res = await run(ytdlp, infoArgs(url, { playlist }), { timeoutMs: 120_000 });
        if (res.code !== 0) {
          process.stderr.write(`${url}: ${res.stderr.trim().split('\n').pop() || 'unreadable'}\n`);
          continue;
        }
        for (const info of parseInfoStream(res.stdout)) {
          objects.push(info);
          rows.push(
            [info.title, info.uploader, humanDuration(info.duration), info.extractor].join('  '),
          );
        }
      }
      process.stdout.write(
        flags.has('--json') ? `${JSON.stringify(objects, null, 2)}\n` : `${rows.join('\n')}\n`,
      );
      process.exit(rows.length === 0 ? 1 : 0);
    }

    if (verb === 'formats') {
      process.exit(await passthrough(ytdlp, formatsArgs(urls[0] as string)));
    }

    const ffmpeg = await findFfmpeg();
    if (verb === 'audio' && !ffmpeg) {
      // Hard, not a fallback: -x is ffmpeg doing the extraction. There is
      // nothing to downgrade to.
      throw new MissingEngineError(
        'dl audio needs ffmpeg to extract the audio track. Install it (moshcode install ffmpeg / apt install ffmpeg / brew install ffmpeg).',
      );
    }
    if (verb === 'video' && !ffmpeg) {
      process.stderr.write(
        'dl: ffmpeg is not on PATH, so only single-stream formats are available -- the result may be lower quality than this URL offers.\n',
      );
    }

    const height = values.has('--height')
      ? integer(values, '--height', 0, { min: 1, max: 10_000 })
      : undefined;

    let worst = 0;
    for (const url of urls) {
      const code = await passthrough(
        ytdlp,
        downloadArgs({
          url,
          kind: verb === 'audio' ? 'audio' : 'video',
          ...(height === undefined ? {} : { height }),
          ...(values.has('--format') ? { audioFormat: values.get('--format') as string } : {}),
          ...(values.has('--to') ? { dir: values.get('--to') as string } : {}),
          ...(values.get('-o') ?? values.get('--out')
            ? { template: (values.get('-o') ?? values.get('--out')) as string }
            : {}),
          playlist,
          canMerge: ffmpeg !== null,
        }),
      );
      // Keep going through the rest of the list: one dead URL in ten is not a
      // reason to abandon the other nine, and the exit code still reports it.
      if (code !== 0) worst = code;
    }
    process.exit(worst);
  } catch (err) {
    if (err instanceof MissingEngineError) {
      process.stderr.write(`dl: ${err.message}\n`);
      process.exit(2);
    }
    if (err instanceof UsageError) {
      process.stderr.write(`dl: ${err.message}\n\n${USAGE}`);
      process.exit(1);
    }
    process.stderr.write(`dl: ${(err as Error).message}\n`);
    process.exit(1);
  }
}
