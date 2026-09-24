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
  writePreview,
} from '../src/icon.ts';
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { openaiImages } from '../src/emoji.ts';
import { resolveCredentials } from '../src/credentials.ts';
import { HQ_CONCURRENCY, buildHq, drawHq, guardCredits, loadBrandColors, withStyle } from '../src/icon-hq.ts';
import { AGENTIC_STYLES, STYLES, type StyleSpec, resolveStyle } from '../src/icon-styles.ts';
import { isMain } from '../src/is-main.ts';

const USAGE = `Usage:
  icon build   [--out DIR] [--sizes 16,24,…] [--color #111] [--only mail,phone]
  icon list    [--category C] [--json]
  icon show    <name>
  icon search  <words…>
  icon glyph   <name> [--mode nerd|unicode|ascii]
  icon hq      [DRAW OPTIONS]
  icon agentic [matte|machined|emissive|all] [DRAW OPTIONS]
  icon style   <${Object.keys(STYLES).join('|')}|agentic|all> [DRAW OPTIONS]

  DRAW OPTIONS: [--out DIR] [--only mail,…] [--no-draw] [--draw-only] [--force]
                [--concurrency N] [--quality low|medium|high]
                [--style-dir DIR] [--dry-run]

A colour style draws every UI icon with an image model (needs OPENAI_API_KEY),
each pinned to its own simple line glyph so the silhouette and meaning hold.

  hq       glass and enamel under a warm key light, drawn beside the OpenEmoji
           masters (--style-dir, default ~/brand-assets/openemoji/master).
           Brands are not drawn: they stay the owner's flat mark in the
           owner's published colour.
  agentic  the three flat-material styles, which take no emoji reference:
           matte (the default, and the one that holds at 20px on any ground),
           machined, emissive. These also re-render the brand marks in the
           material, pinned to the owner's own mark: same geometry, same
           colour, new surface.

Masters go to <style-dir>/master and are never redrawn; --no-draw only
rebuilds sizes and the manifest, and --draw-only only draws. Drawing a whole
style takes hours, so the pair is how several styles are drawn at once: one
--draw-only run per style, then a single --no-draw pass to derive them, which
keeps one writer on openicon.json. The simple style stays the default and
canonical.

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

/** Derive one style's sizes and brand colours, and write its block into openicon.json. */
export async function applyHq(out: string, sizes: number[], style: StyleSpec = STYLES.hq!): Promise<number> {
  const { Resvg } = await import('@resvg/resvg-js');
  const entries = await buildHq({
    out,
    sizes,
    style,
    log: (line) => process.stderr.write(`${line}\n`),
    render: (svg, size) => Buffer.from(new Resvg(svg, { fitTo: { mode: 'width', value: size } }).render().asPng()),
  });
  const file = join(out, 'openicon.json');
  const manifest = withStyle(JSON.parse(await readFile(file, 'utf8')), style, entries, sizes);
  await writeFile(file, `${JSON.stringify(manifest, null, 2)}\n`);
  await writeFile(join(out, style.dir, 'style.txt'), `${style.styleText}\n`);
  return entries.size;
}

/** The styles a set already carries on disk, so a rebuild keeps every one of them. */
export function stylesPresent(out: string): StyleSpec[] {
  return Object.values(STYLES).filter((style) => existsSync(join(out, style.dir, 'png')));
}

if (isMain(import.meta.url)) {
  process.stdout.on('error', (error: NodeJS.ErrnoException) => {
    if (error.code === 'EPIPE') process.exit(0);
    throw error;
  });
  try {
    const { flags, values, positional } = parseArgs(process.argv.slice(2), {
      boolean: ['--json', '--help', '--no-draw', '--draw-only', '--force', '--dry-run'],
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
        // Existing colour styles survive a rebuild of the simple one. The
        // preview is written again afterwards: the one `build` wrote was made
        // before the styles went into the manifest, so it had nothing to show.
        const present = stylesPresent(out);
        for (const style of present) await applyHq(out, sizes, style);
        if (present.length) await writePreview(out, JSON.parse(await readFile(join(out, 'openicon.json'), 'utf8')));
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
      case 'hq':
      case 'agentic':
      case 'style': {
        // `icon hq` is `icon style hq`; `icon agentic X` is `icon style agentic-X`.
        const asked =
          verb === 'hq' ? 'hq'
          : verb === 'agentic' ? (rest[0] ? (rest[0] === 'all' ? 'all' : `agentic-${rest[0]}`) : 'agentic')
          : (rest[0] ?? '');
        if (!asked) throw new UsageError(`style needs a name (${Object.keys(STYLES).join(', ')}, agentic, all)`);
        const chosen: StyleSpec[] =
          asked === 'all' ? (verb === 'agentic' ? [...AGENTIC_STYLES] : Object.keys(STYLES)).map((id) => resolveStyle(id))
          : [resolveStyle(asked)];

        const out = values.get('-o') ?? values.get('--out') ?? DEFAULT_OUT;
        const manifestFile = join(out, 'openicon.json');
        if (!existsSync(manifestFile)) throw new UsageError(`no ${manifestFile}; run \`icon build --out ${out}\` first`);
        const keys = csv(values, '--only').length
          ? csv(values, '--only').map((n) => find(n)?.key ?? n)
          : [...GENERIC.map((i) => i.key), ...BRANDS.map((b) => b.key)];
        // What is drawable depends on the style: every style draws the generic
        // icons, and one that knows how to re-render a mark also draws the
        // brands. For any other style a brand is still a recolour, so asking
        // for one is a no-op rather than an error.
        const drawableFor = (style: StyleSpec) =>
          keys.filter((k) => GENERIC.some((i) => i.key === k) || (style.promptForBrand && BRANDS.some((b) => b.key === k)));
        const quality = values.get('--quality') ?? 'medium';
        if (!['low', 'medium', 'high'].includes(quality)) throw new UsageError('--quality must be low, medium or high');

        if (flags.has('--dry-run')) {
          for (const style of chosen) {
            const drawable = drawableFor(style);
            const pending = drawable.filter((k) => flags.has('--force') || !existsSync(join(out, style.dir, 'master', `${k}.png`)));
            process.stdout.write(`${style.id}: ${flags.has('--no-draw') ? 0 : pending.length} icons to draw, then sizes, brand colours and openicon.json in ${out}\n`);
          }
          break;
        }

        for (const style of chosen) {
          const drawable = drawableFor(style);
          const pending = drawable.filter((k) => flags.has('--force') || !existsSync(join(out, style.dir, 'master', `${k}.png`)));
          if (!flags.has('--no-draw') && pending.length) {
            const key = resolveCredentials()['OPENAI_API_KEY'];
            if (!key) throw new Error('no OpenAI key: export OPENAI_API_KEY or run `cli-tools config set openai`');
            const { Resvg } = await import('@resvg/resvg-js');
            // A style that restyles marks needs the owner colours at draw
            // time, not only at derive time: without them every mark is drawn
            // as "monochrome" and comes back graphite.
            const brandColors = style.promptForBrand && drawable.some((k) => BRANDS.some((b) => b.key === k))
              ? await loadBrandColors()
              : undefined;
            const report = await drawHq({
              out,
              style,
              keys: drawable,
              ...(brandColors ? { brandColors } : {}),
              caller: guardCredits(openaiImages(key)),
              styleDir: values.get('--style-dir') ?? join(process.env['HOME'] ?? '', 'brand-assets', 'openemoji', 'master'),
              concurrency: Number(values.get('--concurrency') ?? HQ_CONCURRENCY),
              quality,
              force: flags.has('--force'),
              log: (line) => process.stderr.write(`${line}\n`),
              render: (svg, size) => Buffer.from(new Resvg(svg, { fitTo: { mode: 'width', value: size } }).render().asPng()),
            });
            process.stderr.write(`${style.id}: drew ${report.drawn.length} in ${report.calls} calls, ${report.failed.length} failed\n`);
            if (report.stoppedForCredit) {
              process.stderr.write(`stopped: the OpenAI account is out of credit (${report.stoppedForCredit})\n`);
              process.exitCode = 2;
              break;
            }
          }
          if (flags.has('--draw-only')) continue;
          const manifest = JSON.parse(await readFile(manifestFile, 'utf8'));
          const done = await applyHq(out, manifest.sizes, style);
          process.stdout.write(`${done}/${manifest.icons.length} icons have the ${style.id} style in ${out}\n`);
        }
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
