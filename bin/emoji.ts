#!/usr/bin/env node
/**
 * emoji — every standard emoji, drawn by an image model as one set, packed as
 * OpenEmoji: PNGs at every size, traced SVGs, colour fonts, CSS, a manifest.
 *
 *   emoji list --group Flags               # what Unicode says exists
 *   emoji generate --only 😀🔥🇺🇸            # draw a few, to judge the style
 *   emoji generate                         # draw the rest (resumable)
 *   emoji build                            # sizes, SVGs, fonts, manifest
 *   emoji status                           # coverage and failures
 *
 * src/emoji.ts has the why: anchors, skin tones as edits, what is derived.
 */

import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { UsageError, csv, integer, parseArgs } from '../src/args.ts';
import { resolveCredentials } from '../src/credentials.ts';
import {
  DEFAULT_CONCURRENCY,
  DEFAULT_MODEL,
  DEFAULT_OUT,
  DEFAULT_QUALITY,
  DEFAULT_SIZES,
  DEFAULT_WEBP_SIZES,
  STYLE,
  build,
  generate,
  loadEmojiTest,
  loadKeywords,
  openaiImages,
  parseEmojiTest,
  select,
  unicodeVersionOf,
} from '../src/emoji.ts';
import { PLATFORMS, exportPlatforms } from '../src/emoji-platforms.ts';
import { isMain } from '../src/is-main.ts';

const USAGE = `Usage:
  emoji list      [--group G] [--only …] [--json]
  emoji generate  [--out DIR] [selection] [--quality Q] [--concurrency N] [--style FILE] [--force] [--dry-run]
  emoji build     [--out DIR] [--sizes 16,32,…] [--webp 64,128] [--no-svg] [--no-font]
  emoji export    [--out DIR] [--platform slack,discord,…]   bundles per network
  emoji all       generate, then build
  emoji status    [--out DIR]

Selection (list, generate, all):
      --only LIST      emoji or keys: --only 😀🔥  or  --only 1f600,1f525
      --group LIST     Unicode group or subgroup names, comma-separated
      --limit N        the first N of what is left
      --components     include the skin-tone and hair swatches

Options:
  -o, --out DIR        the pack directory (default: ${DEFAULT_OUT})
      --model ID       image model (default: $EMOJI_IMAGE_MODEL or ${DEFAULT_MODEL})
      --quality Q      low | medium | high (default: ${DEFAULT_QUALITY})
      --concurrency N  parallel requests (default: ${DEFAULT_CONCURRENCY})
      --style FILE     replace the built-in art direction with your own
      --force          redraw masters that already exist
      --dry-run        say what would be drawn and stop
      --refresh        re-download emoji-test.txt from unicode.org

The list is Unicode's emoji-test.txt, every fully-qualified sequence. A master
that exists is never redrawn, so an interrupted run picks up where it stopped.
Needs OPENAI_API_KEY (or \`cli-tools config set openai\`). \`build\` needs uv for
the SVG trace and the fonts; both are fetched on first use.
`;

if (isMain(import.meta.url)) {
  // `emoji list | head` closes the pipe early; that is not an error.
  process.stdout.on('error', (error: NodeJS.ErrnoException) => {
    if (error.code === 'EPIPE') process.exit(0);
    throw error;
  });
  try {
    const { flags, values, positional } = parseArgs(process.argv.slice(2), {
      boolean: ['--json', '--force', '--dry-run', '--refresh', '--components', '--no-svg', '--no-font', '--help'],
      string: ['-o', '--out', '--only', '--group', '--limit', '--model', '--quality', '--concurrency', '--style', '--sizes', '--webp', '--platform', '--download-base'],
    });
    const verb = positional[0];
    if (flags.has('--help') || !verb) {
      process.stdout.write(USAGE);
      process.exit(verb || flags.has('--help') ? 0 : 1);
    }

    const out = values.get('-o') ?? values.get('--out') ?? DEFAULT_OUT;
    const model = values.get('--model') ?? process.env['EMOJI_IMAGE_MODEL'] ?? DEFAULT_MODEL;
    const log = (line: string) => process.stderr.write(`${line}\n`);
    const text = await loadEmojiTest({ refresh: flags.has('--refresh') });
    const all = parseEmojiTest(text);
    const only = values.has('--only')
      ? [...(values.get('--only') ?? '').split(',').map((s) => s.trim()).filter(Boolean)]
      : undefined;
    const picked = select(all, {
      only,
      groups: csv(values, '--group'),
      limit: values.has('--limit') ? integer(values, '--limit', 0, { min: 1 }) : undefined,
      components: flags.has('--components'),
    });

    const doGenerate = async () => {
      const quality = values.get('--quality') ?? DEFAULT_QUALITY;
      if (!['low', 'medium', 'high'].includes(quality)) throw new UsageError(`--quality must be low, medium or high`);
      const pending = picked.filter((e) => flags.has('--force') || !existsSync(join(out, 'master', `${e.key}.png`)));
      if (flags.has('--dry-run')) {
        process.stdout.write(`${pending.length} of ${picked.length} selected would be drawn with ${model} (${quality}) into ${out}\n`);
        return;
      }
      const key = resolveCredentials()['OPENAI_API_KEY'];
      if (!key) throw new Error('no OpenAI key: export OPENAI_API_KEY or run `cli-tools config set openai`');
      const style = values.has('--style') ? await readFile(values.get('--style')!, 'utf8') : STYLE;
      log(`drawing ${pending.length} of ${picked.length} selected (${all.length} in Unicode ${unicodeVersionOf(text)})`);
      const report = await generate(all, picked, {
        out,
        model,
        quality,
        style,
        concurrency: integer(values, '--concurrency', DEFAULT_CONCURRENCY, { min: 1, max: 32 }),
        force: flags.has('--force'),
        caller: openaiImages(key),
        log,
      });
      process.stdout.write(
        `drew ${report.drawn.length}, kept ${report.skipped.length}, failed ${report.failed.length}; ${report.tokens} image tokens\n`,
      );
      if (report.failed.length) process.exitCode = 2;
    };

    const doBuild = async () => {
      const sizes = values.has('--sizes')
        ? csv(values, '--sizes').map((s) => {
            if (!/^\d+$/.test(s) || Number(s) < 8 || Number(s) > 1024) throw new UsageError(`bad size: ${s}`);
            return Number(s);
          })
        : [...DEFAULT_SIZES];
      const webpSizes = values.has('--webp')
        ? csv(values, '--webp').map((s) => {
            if (!/^\d+$/.test(s) || Number(s) < 8 || Number(s) > 1024) throw new UsageError(`bad webp size: ${s}`);
            return Number(s);
          })
        : [...DEFAULT_WEBP_SIZES];
      const manifest = await build(all, {
        webpSizes,
        keywords: await loadKeywords({ log }),
        out,
        sizes,
        svg: !flags.has('--no-svg'),
        font: !flags.has('--no-font'),
        unicodeVersion: unicodeVersionOf(text),
        model,
        log,
      });
      process.stdout.write(
        `${manifest.coverage.drawn}/${manifest.coverage.total} emoji packed in ${out} (${manifest.formats.join(', ')}); open ${join(out, 'index.html')}\n`,
      );
    };

    switch (verb) {
      case 'list': {
        if (flags.has('--json')) process.stdout.write(`${JSON.stringify(picked, null, 2)}\n`);
        else for (const e of picked) process.stdout.write(`${e.char}\t${e.key}\t${e.group} / ${e.subgroup}\t${e.name}\n`);
        break;
      }
      case 'generate':
        await doGenerate();
        break;
      case 'build':
        await doBuild();
        break;
      case 'all':
        await doGenerate();
        if (!flags.has('--dry-run')) await doBuild();
        break;
      case 'export': {
        const manifestFile = join(out, 'openemoji.json');
        if (!existsSync(manifestFile)) throw new Error(`no ${manifestFile}; run \`emoji build\` first`);
        const wanted = csv(values, '--platform');
        const unknown = wanted.filter((id) => !PLATFORMS.some((p) => p.id === id));
        if (unknown.length) {
          throw new UsageError(`unknown platform: ${unknown.join(', ')} (known: ${PLATFORMS.map((p) => p.id).join(', ')})`);
        }
        const index = await exportPlatforms({
          out,
          manifest: JSON.parse(await readFile(manifestFile, 'utf8')),
          // A network that borrows another's packs brings that one along.
          platforms: wanted.length
            ? PLATFORMS.filter(
                (p) => wanted.includes(p.id) || PLATFORMS.some((q) => wanted.includes(q.id) && q.packsFrom === p.id),
              )
            : PLATFORMS,
          downloadBase:
            values.get('--download-base') ?? 'https://github.com/profullstack/openemoji/releases/latest/download',
          log,
        });
        const packs = index.platforms.reduce((n, p) => n + p.packs.length, 0);
        process.stdout.write(`${index.platforms.length} networks, ${packs} packs in ${join(out, 'platforms')}\n`);
        break;
      }
      case 'status': {
        const standard = all.filter((e) => e.group !== 'Component');
        const have = standard.filter((e) => existsSync(join(out, 'master', `${e.key}.png`))).length;
        const failuresFile = join(out, 'failures.json');
        const failures = existsSync(failuresFile) ? JSON.parse(await readFile(failuresFile, 'utf8')).length : 0;
        process.stdout.write(
          `Unicode ${unicodeVersionOf(text)}: ${have}/${standard.length} drawn in ${out}, ${failures} failed last time\n`,
        );
        break;
      }
      default:
        throw new UsageError(`unknown command: ${verb}`);
    }
  } catch (error) {
    if (error instanceof UsageError) {
      process.stderr.write(`emoji: ${error.message}\n\n${USAGE}`);
      process.exit(1);
    }
    process.stderr.write(`emoji: ${(error as Error).message}\n`);
    process.exit(1);
  }
}
