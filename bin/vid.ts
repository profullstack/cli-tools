#!/usr/bin/env -S npx --yes tsx
/**
 * vid — what is in this file, and get a smaller or shorter one out.
 *
 * A thin front for ffmpeg, which is on the box or it is not; there is no npm
 * fallback for video the way sharp is a fallback for images. So the first thing
 * every command here does is check, and say so plainly rather than surfacing a
 * spawn error from three frames down.
 *
 * Deliberately not a wrapper for all of ffmpeg. It covers the handful of things
 * worth not remembering the flags for -- what is this, give me a thumbnail, cut
 * me a clip, make it smaller, pull the audio out -- and gets out of the way for
 * anything else.
 */

import { UsageError, parseArgs } from '../src/args.ts';
import { isMain } from '../src/is-main.ts';
import { run } from '../src/exec.ts';
import { MissingEngineError, findFfmpeg, findFfprobe, humanBytes, humanDuration } from '../src/media.ts';
import { stat } from 'node:fs/promises';

const USAGE = `Usage:
  vid info <file>...                    duration, streams, size
  vid thumb <file> [--at 00:00:05] [-o OUT]
  vid clip <file> --from 00:01:00 --to 00:02:00 [-o OUT]
  vid shrink <file> [--crf 28] [--height 720] [-o OUT]
  vid audio <file> [-o OUT.m4a]

Options:
      --at TIME      timestamp for the thumbnail (default: 00:00:03)
      --from TIME    clip start
      --to TIME      clip end
      --crf N        quality for shrink, lower is better (default: 28)
      --height N     scale to this height, keeping the ratio
  -o, --out PATH     output file
      --help         show this help

clip copies streams rather than re-encoding, so it is nearly instant and cuts
at the nearest keyframe -- which can be a second or two off what you asked for.
That is the trade; re-encoding to hit an exact frame takes as long as the clip.

Needs ffmpeg on PATH. There is no bundled fallback: nothing on npm decodes
video the way sharp handles images.
`;

async function sizeOf(path: string): Promise<string> {
  try {
    return humanBytes((await stat(path)).size);
  } catch {
    return '?';
  }
}

function outFor(input: string, suffix: string, ext: string): string {
  const dot = input.lastIndexOf('.');
  const stem = dot > 0 ? input.slice(0, dot) : input;
  return `${stem}.${suffix}.${ext}`;
}

if (isMain(import.meta.url)) {
  try {
    const { flags, values, positional } = parseArgs(process.argv.slice(2), {
      boolean: ['--help'],
      string: ['--at', '--from', '--to', '--crf', '--height', '-o', '--out'],
    });

    if (flags.has('--help') || positional.length === 0) {
      process.stdout.write(USAGE);
      process.exit(positional.length === 0 ? 1 : 0);
    }

    const [command, ...files] = positional;
    if (files.length === 0) throw new UsageError(`${command} needs a file`);
    const file = files[0] as string;
    const out = values.get('-o') ?? values.get('--out');

    if (command === 'info') {
      const ffprobe = await findFfprobe();
      if (!ffprobe) {
        throw new MissingEngineError(
          'ffprobe is not on PATH. Install ffmpeg (apt install ffmpeg / brew install ffmpeg).',
        );
      }
      for (const f of files) {
        const res = await run(ffprobe, [
          '-v', 'error',
          '-show_entries', 'format=duration,format_name:stream=codec_type,codec_name,width,height',
          '-of', 'json',
          f,
        ]);
        if (res.code !== 0) {
          process.stderr.write(`${f}: ${res.stderr.trim() || 'unreadable'}\n`);
          continue;
        }
        const d = JSON.parse(res.stdout) as {
          format?: { duration?: string; format_name?: string };
          streams?: { codec_type?: string; codec_name?: string; width?: number; height?: number }[];
        };
        const dur = humanDuration(Number(d.format?.duration ?? 0));
        const v = (d.streams ?? []).find((s) => s.codec_type === 'video');
        const a = (d.streams ?? []).find((s) => s.codec_type === 'audio');
        const parts = [
          f,
          dur,
          v ? `${v.width}x${v.height} ${v.codec_name}` : 'no video',
          a ? a.codec_name : 'no audio',
          await sizeOf(f),
        ];
        process.stdout.write(`${parts.join('  ')}\n`);
      }
      process.exit(0);
    }

    const ffmpeg = await findFfmpeg();
    if (!ffmpeg) {
      throw new MissingEngineError(
        'ffmpeg is not on PATH. Install it (apt install ffmpeg / brew install ffmpeg).',
      );
    }

    let args: string[];
    let target: string;

    if (command === 'thumb') {
      target = out ?? outFor(file, 'thumb', 'jpg');
      // -ss before -i seeks by index rather than decoding up to the point,
      // which is the difference between instant and a minute on a long file.
      args = ['-y', '-ss', values.get('--at') ?? '00:00:03', '-i', file, '-frames:v', '1', target];
    } else if (command === 'clip') {
      const from = values.get('--from');
      const to = values.get('--to');
      if (!from || !to) throw new UsageError('clip needs --from and --to');
      target = out ?? outFor(file, 'clip', file.split('.').pop() ?? 'mp4');
      args = ['-y', '-ss', from, '-to', to, '-i', file, '-c', 'copy', target];
    } else if (command === 'shrink') {
      const crf = values.get('--crf') ?? '28';
      const height = values.get('--height');
      target = out ?? outFor(file, 'small', 'mp4');
      args = [
        '-y', '-i', file,
        ...(height ? ['-vf', `scale=-2:${height}`] : []),
        '-c:v', 'libx264', '-crf', crf, '-preset', 'medium',
        '-c:a', 'aac', '-b:a', '128k',
        target,
      ];
    } else if (command === 'audio') {
      target = out ?? outFor(file, 'audio', 'm4a');
      args = ['-y', '-i', file, '-vn', '-c:a', 'copy', target];
    } else {
      throw new UsageError(`unknown command "${command}"`);
    }

    // Long jobs: an hour, because shrinking a feature film is not a 2-minute task.
    const res = await run(ffmpeg, args, { timeoutMs: 3_600_000 });
    if (res.code !== 0) {
      // ffmpeg writes everything to stderr including progress, so only the tail
      // is worth showing.
      const tail = res.stderr.trim().split('\n').slice(-3).join('\n');
      throw new Error(tail || `ffmpeg exited ${res.code}`);
    }
    process.stdout.write(`${target}  ${await sizeOf(target)}\n`);
  } catch (err) {
    if (err instanceof MissingEngineError) {
      process.stderr.write(`vid: ${err.message}\n`);
      process.exit(2);
    }
    if (err instanceof UsageError) {
      process.stderr.write(`vid: ${err.message}\n\n${USAGE}`);
      process.exit(1);
    }
    process.stderr.write(`vid: ${(err as Error).message}\n`);
    process.exit(1);
  }
}
