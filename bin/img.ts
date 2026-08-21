#!/usr/bin/env -S npx --yes tsx
/**
 * img — resize, convert and inspect images, with whichever engine is present.
 *
 * sharp when it is installed, ImageMagick when it is not, and a sentence saying
 * which rather than a silent choice: the same command through two backends does
 * not produce byte-identical output, and being told which one ran is the
 * difference between a puzzling file and an explicable one.
 */

import { UsageError, integer, parseArgs } from '../src/args.ts';
import { isMain } from '../src/is-main.ts';
import {
  MissingEngineError,
  defaultOutput,
  humanBytes,
  loadSharp,
  pickImageEngine,
} from '../src/media.ts';
import { run } from '../src/exec.ts';
import { stat } from 'node:fs/promises';

const USAGE = `Usage:
  img info <file>...                     dimensions, format, size
  img resize <file> [-w N] [-h N] [-o OUT]
  img convert <file> --to webp [-o OUT]
  img icons <file> [--out DIR]           the favicon/PWA set

Options:
  -w, --width N      target width in pixels
  -h, --height N     target height (one of the two is enough; ratio is kept)
      --to FORMAT    png | jpeg | webp | avif
  -o, --out PATH     output file, or directory for \`icons\`
      --engine NAME  sharp | magick  (default: sharp if installed)
      --quality N    1-100, for lossy formats (default: 82)
      --force        allow enlarging past the source resolution
      --help         show this help

Never enlarges by default: scaling a 96px mark up to 512 produces a blurry
512px file that looks like a bug in whatever renders it. --force if you mean it.

Engines
  sharp        arrives with this repo as an optional dependency. Fast.
  ImageMagick  a system binary; handles PDF, PSD and animated GIF, which sharp
               does not.
`;

async function sizeOf(path: string): Promise<string> {
  try {
    return humanBytes((await stat(path)).size);
  } catch {
    return '?';
  }
}

if (isMain(import.meta.url)) {
  try {
    const { flags, values, positional } = parseArgs(process.argv.slice(2), {
      boolean: ['--force', '--help'],
      string: ['-w', '--width', '-h', '--height', '--to', '-o', '--out', '--engine', '--quality'],
    });

    if (flags.has('--help') || positional.length === 0) {
      process.stdout.write(USAGE);
      process.exit(positional.length === 0 ? 1 : 0);
    }

    const [command, ...files] = positional;
    if (files.length === 0) throw new UsageError(`${command} needs a file`);

    const width = values.has('-w') || values.has('--width')
      ? integer(values, values.has('-w') ? '-w' : '--width', 0, { min: 1, max: 20000 })
      : null;
    const height = values.has('-h') || values.has('--height')
      ? integer(values, values.has('-h') ? '-h' : '--height', 0, { min: 1, max: 20000 })
      : null;
    const quality = integer(values, '--quality', 82, { min: 1, max: 100 });
    const out = values.get('-o') ?? values.get('--out');
    const format = values.get('--to');
    const force = flags.has('--force');

    const { engine, magickBin } = await pickImageEngine(values.get('--engine'));

    if (command === 'info') {
      for (const file of files) {
        if (engine === 'sharp') {
          const sharp = await loadSharp();
          const m = await sharp!(file).metadata();
          process.stdout.write(
            `${file}  ${m.width}x${m.height}  ${m.format}  ${await sizeOf(file)}\n`,
          );
        } else {
          const res = await run(magickBin === 'magick' ? 'magick' : 'identify', [
            ...(magickBin === 'magick' ? ['identify'] : []),
            '-format',
            '%wx%h %m',
            file,
          ]);
          process.stdout.write(`${file}  ${res.stdout.trim()}  ${await sizeOf(file)}\n`);
        }
      }
    } else if (command === 'resize' || command === 'convert') {
      if (command === 'resize' && !width && !height) {
        throw new UsageError('resize needs --width or --height');
      }
      if (command === 'convert' && !format) throw new UsageError('convert needs --to FORMAT');

      const file = files[0] as string;
      const target = out ?? (format ? defaultOutput(file, format) : defaultOutput(file, 'png'));

      if (engine === 'sharp') {
        const sharp = await loadSharp();
        let pipe = sharp!(file);
        if (width || height) {
          pipe = pipe.resize({
            width: width ?? undefined,
            height: height ?? undefined,
            fit: 'inside',
            // The default that stops a mark being blown up into a blurry mess.
            withoutEnlargement: !force,
          });
        }
        if (format) pipe = pipe.toFormat(format, { quality });
        const r = await pipe.toFile(target);
        process.stdout.write(
          `${target}  ${r.width}x${r.height}  ${humanBytes(r.size)}  (sharp)\n`,
        );
      } else {
        const geometry = `${width ?? ''}x${height ?? ''}${force ? '' : '>'}`;
        const args = [
          ...(magickBin === 'magick' ? [] : []),
          file,
          ...(width || height ? ['-resize', geometry] : []),
          ...(format ? ['-quality', String(quality)] : []),
          target,
        ];
        const res = await run(magickBin as string, args);
        if (res.code !== 0) throw new Error(res.stderr.trim() || 'ImageMagick failed');
        process.stdout.write(`${target}  ${await sizeOf(target)}  (ImageMagick)\n`);
      }
    } else if (command === 'icons') {
      // The set a web app actually references. Chosen to match what a manifest
      // and an <link rel="icon"> pair normally ask for, rather than every size
      // a generator can emit.
      const sizes = [16, 32, 48, 128, 180, 192, 256, 384, 512];
      const dir = out ?? '.';
      const file = files[0] as string;
      for (const size of sizes) {
        const target = `${dir}/icon-${size}x${size}.png`;
        if (engine === 'sharp') {
          const sharp = await loadSharp();
          await sharp!(file)
            .resize({ width: size, height: size, fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
            .toFormat('png')
            .toFile(target);
        } else {
          await run(magickBin as string, [file, '-resize', `${size}x${size}`, target]);
        }
        process.stdout.write(`${target}  ${await sizeOf(target)}\n`);
      }
    } else {
      throw new UsageError(`unknown command "${command}"`);
    }
  } catch (err) {
    if (err instanceof MissingEngineError) {
      process.stderr.write(`img: ${err.message}\n`);
      process.exit(2);
    }
    if (err instanceof UsageError) {
      process.stderr.write(`img: ${err.message}\n\n${USAGE}`);
      process.exit(1);
    }
    process.stderr.write(`img: ${(err as Error).message}\n`);
    process.exit(1);
  }
}
