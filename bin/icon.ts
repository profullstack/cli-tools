#!/usr/bin/env node
/**
 * icon — the OpenIcon set: UI icons with SVG, PNG and terminal glyphs.
 *
 *   icon build --out ./openicon          # openicon.json, svg/, png/, sprite.svg, index.html
 *   icon list --category communication   # what is in the set
 *   icon show mail                       # one icon: names, glyphs, SVG
 *   icon search money                    # by name, alias or keyword
 *   icon glyph mail                      # the best glyph this terminal can draw
 *
 * src/icon.ts has the why; src/icon-set.ts and src/icon-brands.ts are the set.
 */

import { UsageError, csv, parseArgs } from '../src/args.ts';
import { BRANDS } from '../src/icon-brands.ts';
import { GENERIC } from '../src/icon-set.ts';
import {
  CATEGORY_NAMES,
  DEFAULT_COLOR,
  DEFAULT_OUT,
  DEFAULT_SIZES,
  build,
  humanName,
  loadNerd,
  resolveNerd,
  strokeSvg,
} from '../src/icon.ts';
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { openaiImages } from '../src/emoji.ts';
import { resolveCredentials } from '../src/credentials.ts';
import { HQ_CONCURRENCY, HQ_STYLE, buildHq, drawHq, guardCredits, withHq } from '../src/icon-hq.ts';
import { isMain } from '../src/is-main.ts';

const USAGE = `Usage:
  icon build   [--out DIR] [--sizes 16,24,…] [--color #111] [--only mail,phone]
  icon list    [--category C] [--json]
  icon show    <name>
  icon search  <words…>
  icon glyph   <name> [--mode nerd|unicode|ascii]
  icon hq      [--out DIR] [--only mail,…] [--no-draw] [--force] [--concurrency N]
               [--quality low|medium|high] [--style-dir DIR] [--dry-run]

\`hq\` makes the optional HQ style: every UI icon drawn in full colour by an
image model (needs OPENAI_API_KEY), each pinned to its own simple line glyph
and to OpenEmoji masters for the look (--style-dir, default
~/brand-assets/openemoji/master); brands in their owners' colours. Masters go
to hq/master and are never redrawn; --no-draw only rebuilds sizes and the
manifest. The simple style stays the default and canonical.

A name is a key (mail) or an alias (email). \`glyph\` picks Nerd Font, then
Unicode, then ASCII from $OPENICON_GLYPHS, $NERD_FONT, or the terminal
(a UTF-8 locale means Unicode; a Nerd Font cannot be detected, so say so).
Categories: ${Object.keys(CATEGORY_NAMES).join(', ')}
`;

type AnyIcon = (typeof GENERIC)[number] | (typeof BRANDS)[number];
const ALL: AnyIcon[] = [...GENERIC, ...BRANDS];
const categoryOf = (i: AnyIcon) => ('category' in i ? i.category : 'brand');

export function find(name: string): AnyIcon | undefined {
  const wanted = name.toLowerCase();
  return ALL.find((i) => i.key === wanted || (i.aliases ?? []).includes(wanted));
}

export function search(words: string[]): AnyIcon[] {
  const terms = words.map((w) => w.toLowerCase());
  return ALL.filter((i) => {
    const hay = [i.key, ...(i.aliases ?? []), ...('keywords' in i ? (i.keywords ?? []) : []), 'title' in i ? i.title.toLowerCase() : '']
      .join(' ');
    return terms.every((t) => hay.includes(t));
  });
}

/** Which glyph family this terminal gets, most capable first. */
export function glyphMode(env: NodeJS.ProcessEnv = process.env): 'nerd' | 'unicode' | 'ascii' {
  const forced = env['OPENICON_GLYPHS'];
  if (forced === 'nerd' || forced === 'unicode' || forced === 'ascii') return forced;
  if (env['NERD_FONT'] === '1' || env['NERD_FONTS'] === '1') return 'nerd';
  const locale = env['LC_ALL'] || env['LC_CTYPE'] || env['LANG'] || '';
  return /utf-?8/i.test(locale) || env['TERM_PROGRAM'] ? 'unicode' : 'ascii';
}

/** Derive the HQ sizes and brand colours, and write the `hq` block into openicon.json. */
export async function applyHq(out: string, sizes: number[]): Promise<number> {
  const { Resvg } = await import('@resvg/resvg-js');
  const entries = await buildHq({
    out,
    sizes,
    log: (line) => process.stderr.write(`${line}\n`),
    render: (svg, size) => Buffer.from(new Resvg(svg, { fitTo: { mode: 'width', value: size } }).render().asPng()),
  });
  const file = join(out, 'openicon.json');
  const manifest = withHq(JSON.parse(await readFile(file, 'utf8')), entries, sizes);
  await writeFile(file, `${JSON.stringify(manifest, null, 2)}\n`);
  await writeFile(join(out, 'hq', 'style.txt'), `${HQ_STYLE}\n`);
  return entries.size;
}

if (isMain(import.meta.url)) {
  process.stdout.on('error', (error: NodeJS.ErrnoException) => {
    if (error.code === 'EPIPE') process.exit(0);
    throw error;
  });
  try {
    const { flags, values, positional } = parseArgs(process.argv.slice(2), {
      boolean: ['--json', '--help', '--no-draw', '--force', '--dry-run'],
      string: ['-o', '--out', '--sizes', '--color', '--only', '--category', '--mode', '--concurrency', '--quality', '--style-dir'],
    });
    const [verb, ...rest] = positional;
    if (flags.has('--help') || !verb) {
      process.stdout.write(USAGE);
      process.exit(verb || flags.has('--help') ? 0 : 1);
    }

    switch (verb) {
      case 'build': {
        const sizes = values.has('--sizes')
          ? csv(values, '--sizes').map((s) => {
              if (!/^\d+$/.test(s) || Number(s) < 8 || Number(s) > 1024) throw new UsageError(`bad size: ${s}`);
              return Number(s);
            })
          : [...DEFAULT_SIZES];
        const color = values.get('--color') ?? DEFAULT_COLOR;
        if (!/^#[0-9a-f]{3,8}$/i.test(color)) throw new UsageError(`--color takes a hex colour, got ${color}`);
        const out = values.get('-o') ?? values.get('--out') ?? DEFAULT_OUT;
        const manifest = await build({
          out,
          sizes,
          color,
          only: csv(values, '--only'),
          log: (line) => process.stderr.write(`${line}\n`),
        });
        // An existing HQ style survives a rebuild of the simple one.
        if (existsSync(join(out, 'hq', 'png'))) await applyHq(out, sizes);
        const nerd = manifest.icons.filter((i) => i.tui.nerd).length;
        process.stdout.write(
          `${manifest.icons.length} icons in ${out} (${nerd} with a Nerd Font glyph); open ${out}/index.html\n`,
        );
        break;
      }
      case 'list': {
        const category = values.get('--category');
        if (category && !(category in CATEGORY_NAMES)) throw new UsageError(`unknown category: ${category}`);
        const list = ALL.filter((i) => !category || categoryOf(i) === category);
        if (flags.has('--json')) {
          process.stdout.write(`${JSON.stringify(list.map(({ ...i }) => ({ ...i, category: categoryOf(i) })), null, 2)}\n`);
        } else {
          for (const i of list) process.stdout.write(`${i.unicode}\t${i.ascii}\t${i.key}\t${categoryOf(i)}\n`);
        }
        break;
      }
      case 'show': {
        const icon = find(rest[0] ?? '');
        if (!icon) throw new UsageError(`no icon called ${rest[0] ?? '(nothing)'}; try \`icon search\``);
        const name = 'title' in icon ? icon.title : humanName(icon.key);
        process.stdout.write(
          [
            `${name} (${icon.key}), ${CATEGORY_NAMES[categoryOf(icon)]}`,
            icon.aliases?.length ? `aliases: ${icon.aliases.join(', ')}` : '',
            `unicode: ${icon.unicode}   ascii: ${icon.ascii}   nerd: ${icon.nerd.join(' | ') || 'none'}`,
            'body' in icon ? strokeSvg(icon.body).trim() : `logo: ${icon.source} ${icon.slug} (fetched at build)`,
          ]
            .filter(Boolean)
            .join('\n') + '\n',
        );
        break;
      }
      case 'search': {
        if (!rest.length) throw new UsageError('search needs a word');
        for (const i of search(rest)) process.stdout.write(`${i.unicode}\t${i.key}\t${categoryOf(i)}\n`);
        break;
      }
      case 'glyph': {
        const icon = find(rest[0] ?? '');
        if (!icon) throw new UsageError(`no icon called ${rest[0] ?? '(nothing)'}`);
        const mode = (values.get('--mode') as 'nerd' | 'unicode' | 'ascii' | undefined) ?? glyphMode();
        if (mode === 'nerd') {
          // Nerd Font first; an icon Nerd Fonts has no glyph for degrades to Unicode.
          const hit = resolveNerd(icon.nerd, await loadNerd());
          process.stdout.write(`${hit.nerd ?? icon.unicode}\n`);
        } else {
          process.stdout.write(`${mode === 'ascii' ? icon.ascii : icon.unicode}\n`);
        }
        break;
      }
      case 'hq': {
        const out = values.get('-o') ?? values.get('--out') ?? DEFAULT_OUT;
        const manifestFile = join(out, 'openicon.json');
        if (!existsSync(manifestFile)) throw new UsageError(`no ${manifestFile}; run \`icon build --out ${out}\` first`);
        const keys = csv(values, '--only').length
          ? csv(values, '--only').map((n) => find(n)?.key ?? n)
          : GENERIC.map((i) => i.key);
        const drawable = keys.filter((k) => GENERIC.some((i) => i.key === k));
        const quality = values.get('--quality') ?? 'medium';
        if (!['low', 'medium', 'high'].includes(quality)) throw new UsageError('--quality must be low, medium or high');
        const pending = drawable.filter((k) => flags.has('--force') || !existsSync(join(out, 'hq', 'master', `${k}.png`)));
        if (flags.has('--dry-run')) {
          process.stdout.write(`${flags.has('--no-draw') ? 0 : pending.length} icons to draw, then sizes, brand colours and openicon.json in ${out}\n`);
          break;
        }
        if (!flags.has('--no-draw') && pending.length) {
          const key = resolveCredentials()['OPENAI_API_KEY'];
          if (!key) throw new Error('no OpenAI key: export OPENAI_API_KEY or run `cli-tools config set openai`');
          const { Resvg } = await import('@resvg/resvg-js');
          const report = await drawHq({
            out,
            keys: drawable,
            caller: guardCredits(openaiImages(key)),
            styleDir: values.get('--style-dir') ?? join(process.env['HOME'] ?? '', 'brand-assets', 'openemoji', 'master'),
            concurrency: Number(values.get('--concurrency') ?? HQ_CONCURRENCY),
            quality,
            force: flags.has('--force'),
            log: (line) => process.stderr.write(`${line}\n`),
            render: (svg, size) => Buffer.from(new Resvg(svg, { fitTo: { mode: 'width', value: size } }).render().asPng()),
          });
          process.stderr.write(`drew ${report.drawn.length} in ${report.calls} calls, ${report.failed.length} failed\n`);
          if (report.stoppedForCredit) {
            process.stderr.write(`stopped: the OpenAI account is out of credit (${report.stoppedForCredit})\n`);
            process.exitCode = 2;
          }
        }
        const manifest = JSON.parse(await readFile(manifestFile, 'utf8'));
        const done = await applyHq(out, manifest.sizes);
        process.stdout.write(`${done}/${manifest.icons.length} icons have the HQ style in ${out}\n`);
        break;
      }
      default:
        throw new UsageError(`unknown command: ${verb}`);
    }
  } catch (error) {
    if (error instanceof UsageError) {
      process.stderr.write(`icon: ${error.message}\n\n${USAGE}`);
      process.exit(1);
    }
    process.stderr.write(`icon: ${(error as Error).message}\n`);
    process.exit(1);
  }
}
