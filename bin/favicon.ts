#!/usr/bin/env node
/**
 * favicon — every icon a site links, from one SVG.
 *
 *   favicon logo.svg                      # → ./icons
 *   favicon logo.svg --out public/icons
 *   favicon mark.svg --out public --quality 90 --no-favicons
 *
 * The work is done by @profullstack/favicon-generator, fetched by npx rather
 * than installed here; src/favicon.ts says why, and why this file exists at all
 * rather than an alias to `fav`.
 *
 * Not the same tool as `img icons`. That one resamples a raster file into the
 * nine sizes a manifest normally asks for, using whichever engine is on the
 * box. This renders an SVG into the full iOS and PWA set — apple-touch-icon at
 * every size iOS has ever wanted, favicon.ico, and the manifest, meta tags and
 * browserconfig.xml that reference them.
 */

import { UsageError, integer, parseArgs } from '../src/args.ts';
import {
  DEFAULT_COMPRESSION,
  DEFAULT_OUT,
  DEFAULT_QUALITY,
  assertReadable,
  assertSupportedInput,
  describeCommand,
  launch,
  resolveSpec,
} from '../src/favicon.ts';
import { isMain } from '../src/is-main.ts';

const USAGE = `Usage:
  favicon <file.svg> [--out DIR] [options]

Options:
  -o, --out DIR        where the icons go (default: ${DEFAULT_OUT})
  -q, --quality N      PNG quality, 1-100 (default: ${DEFAULT_QUALITY})
  -c, --compression N  PNG compression, 0-9 (default: ${DEFAULT_COMPRESSION})
      --no-favicons    skip the favicon-16 / favicon-32 pair
      --quiet          drop the per-icon chatter (upstream still prints a
                       three-line summary; it is not ours to suppress)
      --dry-run        print the command instead of running it
      --help           show this help

Writes the iOS and PWA set: icon-16 through icon-512, apple-touch-icon at
every size iOS asks for, favicon.png/.svg/.ico, plus manifest.json,
browserconfig.xml and the <link> tags to paste into a <head>.

A PNG source works and an SVG is better: each size is rendered from the
vector rather than resampled from one raster.

  FAVICON_SPEC   what npx runs — pin a version, or point at a checkout
`;

if (isMain(import.meta.url)) {
  try {
    const { flags, values, positional } = parseArgs(process.argv.slice(2), {
      boolean: ['--no-favicons', '--quiet', '--dry-run', '--help'],
      string: ['-o', '--out', '-q', '--quality', '-c', '--compression'],
    });

    if (flags.has('--help') || positional.length === 0) {
      process.stdout.write(USAGE);
      process.exit(positional.length === 0 && !flags.has('--help') ? 1 : 0);
    }

    if (positional.length > 1) {
      // One source, one set. Two files would mean two runs writing over each
      // other in the same directory, which is never what was meant.
      throw new UsageError(`one file at a time, got ${positional.length}`);
    }

    const input = positional[0] as string;
    assertSupportedInput(input);
    await assertReadable(input);

    const request = {
      input,
      outDir: values.get('-o') ?? values.get('--out') ?? DEFAULT_OUT,
      quality: integer(
        values,
        values.has('-q') ? '-q' : '--quality',
        DEFAULT_QUALITY,
        { min: 1, max: 100 },
      ),
      compression: integer(
        values,
        values.has('-c') ? '-c' : '--compression',
        DEFAULT_COMPRESSION,
        { min: 0, max: 9 },
      ),
      favicons: !flags.has('--no-favicons'),
      quiet: flags.has('--quiet'),
    };

    if (flags.has('--dry-run')) {
      process.stdout.write(`${describeCommand(request)}\n`);
      process.exit(0);
    }

    process.exitCode = await launch('favicon', request, resolveSpec());
  } catch (error) {
    if (error instanceof UsageError) {
      process.stderr.write(`favicon: ${error.message}\n\n${USAGE}`);
      process.exit(1);
    }
    process.stderr.write(`favicon: ${(error as Error).message}\n`);
    process.exit(1);
  }
}
