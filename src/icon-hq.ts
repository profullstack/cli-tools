/**
 * The HQ style of OpenIcon: every icon in full colour, as an alternative to
 * the simple line set (which stays canonical and the default).
 *
 * UI icons are drawn by an image model at the OpenEmoji bar, and each draw is
 * pinned two ways, which is what keeps 259 drawings coherent:
 *
 *   - the icon's own simple line glyph, rendered at 1024, is the FIRST
 *     reference, and the prompt says to keep its silhouette and meaning, so
 *     `filter` stays a funnel and not whatever the model thinks filters are;
 *   - three OpenEmoji masters follow as style references, so the icons read
 *     as the same family as the emoji.
 *
 * Brands are never drawn: their HQ form is the same logo in the owner's
 * published colour (Simple Icons' `hex`, or a cited brand page for the few
 * that came from Font Awesome).
 *
 * Masters live in hq/master (1024px, kept out of git); everything else is
 * derived: hq/png/<size>, hq/webp/<size>, and hq/svg for brands.
 */

import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { type ImageCaller, RefusedError, pool } from './emoji.ts';
import { BRANDS, SIMPLE_ICONS_VERSION } from './icon-brands.ts';
import { GENERIC, type IconDef } from './icon-set.ts';
import { type Manifest, cached, humanName, strokeSvg } from './icon.ts';

export const HQ_MODEL = 'gpt-image-2';
export const HQ_WEBP_SIZES = [64, 128] as const;
export const HQ_CONCURRENCY = 12;
/**
 * OpenEmoji masters the icons take their look from: laptop, gem, light bulb.
 * Chosen for range: fire and rocket as references tinted every icon orange.
 */
export const STYLE_REFS = ['1f4bb.png', '1f48e.png', '1f4a1.png'] as const;
/** Drawn first, to judge the prompt on a contact sheet before the rest. */
export const HQ_ANCHORS = ['mail', 'settings', 'search', 'delete', 'lock', 'calendar', 'cart', 'terminal', 'bell', 'folder'] as const;

export const HQ_STYLE = `Design one icon for a premium, original colour icon set that sits beside a glossy 3D emoji set as one family.
The FIRST reference image is this icon's line drawing: keep its exact silhouette, parts and meaning, and turn it into a solid, full-colour object. Do not add or remove parts, do not change what it depicts, do not add text.
The OTHER reference images are the style to match exactly: soft-volume 3D with vector clarity, smooth rich gradients that model the form, one warm key light from the upper left with a crisp specular highlight, gentle ambient occlusion, a subtle darker rim on the lower-right edge, saturated harmonious colour. Do not copy their subjects.
Colour follows meaning, the way a well-designed app icon set does, not the reference images: blue for information, links, search and communication; green for success, money and go; red only for delete, danger, errors and alerts; amber for warnings and notifications; purple for creative and AI; teal for time and navigation; real materials where the object has them (steel for tools and locks, paper white, wood, glass). The set as a whole must use the full spectrum, never mostly red and orange.
Composition: the single object, centred, filling about 84% of the square, front or slight three-quarter view, nothing cropped. Fully transparent background, no ground shadow, no badge, no frame, no backdrop.
It must stay instantly readable at 20 pixels. Every design is original: never resemble a logo, mascot or product from any brand, film or game.`;

export function hqPromptFor(icon: IconDef): string {
  const words = [humanName(icon.key).toLowerCase(), ...(icon.aliases ?? []), ...(icon.keywords ?? [])].slice(0, 6);
  return `${HQ_STYLE}\n\nThe icon: "${icon.key}" (${words.join(', ')}), category ${icon.category}.`;
}

/**
 * Brand colours for the logos that came from Font Awesome, which carries no
 * colour. Each is the owner's published colour, with where it is published.
 */
export const FA_BRAND_COLORS: Record<string, { hex: string; source: string }> = {
  slack: { hex: '#4A154B', source: 'https://slack.com/media-kit (Aubergine, primary brand colour)' },
  linkedin: { hex: '#0A66C2', source: 'https://brand.linkedin.com/visual-identity/color-palettes (LinkedIn Blue)' },
  windows: { hex: '#0078D4', source: 'https://learn.microsoft.com/en-us/windows/apps/design/signature-experiences/color (Windows accent blue)' },
  microsoft: { hex: '#737373', source: 'https://www.microsoft.com/en-us/legal/intellectualproperty/trademarks (wordmark grey)' },
  'hacker-news': { hex: '#FF6600', source: 'https://news.ycombinator.com (the site header orange)' },
  openai: { hex: '#000000', source: 'https://openai.com/brand (black logomark)' },
  skype: { hex: '#00AFF0', source: 'https://www.skype.com (Skype blue)' },
  codepen: { hex: '#000000', source: 'https://blog.codepen.io/documentation/brand-assets/logos/ (black)' },
  amazon: { hex: '#FF9900', source: 'https://www.aboutamazon.com (Amazon smile orange)' },
};

export const SIMPLE_ICONS_DATA = `https://cdn.jsdelivr.net/npm/simple-icons@${SIMPLE_ICONS_VERSION}/data/simple-icons.json`;

// ------------------------------------------------------------------ draw

export class CreditError extends Error {}

/** A caller that turns "no credits" into a stop, never a retry. */
export function guardCredits(caller: ImageCaller): ImageCaller {
  return async (request) => {
    try {
      return await caller(request);
    } catch (error) {
      if (/credit|insufficient_quota|billing/i.test((error as Error).message)) {
        throw new CreditError((error as Error).message);
      }
      throw error;
    }
  };
}

export interface HqDrawOptions {
  out: string;
  keys: string[];
  caller: ImageCaller;
  styleDir: string;
  concurrency: number;
  quality: string;
  force: boolean;
  log: (line: string) => void;
  render: (svg: string, size: number) => Promise<Buffer> | Buffer;
  sleep?: (ms: number) => Promise<void>;
}

export interface HqDrawReport {
  drawn: string[];
  skipped: string[];
  failed: Array<{ key: string; error: string }>;
  calls: number;
  stoppedForCredit?: string;
}

/** Draw the missing HQ masters; stops cleanly, keeping what landed, if credit runs out. */
export async function drawHq(options: HqDrawOptions): Promise<HqDrawReport> {
  const master = join(options.out, 'hq', 'master');
  await mkdir(master, { recursive: true });
  const styleRefs = await Promise.all(STYLE_REFS.map((f) => readFile(join(options.styleDir, f))));
  const report: HqDrawReport = { drawn: [], skipped: [], failed: [], calls: 0 };
  const byKey = new Map(GENERIC.map((i) => [i.key, i]));
  const sleep = options.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));

  const todo = options.keys.filter((key) => {
    if (!byKey.has(key)) throw new Error(`${key} is not a drawn icon (brands take their colour, they are not drawn)`);
    if (!options.force && existsSync(join(master, `${key}.png`))) {
      report.skipped.push(key);
      return false;
    }
    return true;
  });

  await pool(todo, options.concurrency, async (key) => {
    if (report.stoppedForCredit) return;
    const icon = byKey.get(key)!;
    // The line glyph, dark on white: a clear silhouette for the model to keep.
    const line = await options.render(
      strokeSvg(icon.body).replace('<svg ', '<svg style="background:#fff" ').replaceAll('currentColor', '#111111'),
      1024,
    );
    for (let attempt = 1; ; attempt += 1) {
      if (report.stoppedForCredit) return;
      try {
        report.calls += 1;
        const result = await options.caller({
          model: HQ_MODEL,
          prompt: hqPromptFor(icon),
          quality: options.quality,
          references: [line, ...styleRefs],
        });
        await writeFile(join(master, `${key}.png`), result.png);
        await writeFile(
          join(options.out, 'hq', 'prompts.jsonl'),
          `${JSON.stringify({ key, prompt: hqPromptFor(icon), references: ['line', ...STYLE_REFS] })}\n`,
          { flag: 'a' },
        );
        report.drawn.push(key);
        options.log(`drew ${key}`);
        return;
      } catch (error) {
        if (error instanceof CreditError) {
          report.stoppedForCredit = error.message;
          options.log(`STOP: ${error.message}`);
          return;
        }
        const status = (error as { status?: number }).status;
        const retry = !(error instanceof RefusedError) && (status === undefined || status === 429 || status >= 500);
        if (!retry || attempt >= 6) {
          report.failed.push({ key, error: (error as Error).message });
          options.log(`FAILED ${key}: ${(error as Error).message}`);
          return;
        }
        // 429 is normal here: another job shares the key.
        await sleep(5000 * 2 ** (attempt - 1));
      }
    }
  });
  return report;
}

// ----------------------------------------------------------------- derive

type Sharp = typeof import('sharp').default;

export interface HqBuildOptions {
  out: string;
  sizes: number[];
  fetchImpl?: typeof fetch;
  log: (line: string) => void;
  render: (svg: string, size: number) => Promise<Buffer> | Buffer;
  /** Simple Icons slug -> hex, injectable for tests. */
  simpleIconsHex?: Map<string, string>;
}

export interface HqEntry {
  png: string;
  webp: string;
  svg?: string;
  made_by: 'ai' | 'human';
  hex?: string;
  hex_source?: string;
}

async function newer(derived: string, source: string): Promise<boolean> {
  if (!existsSync(derived)) return false;
  return (await stat(derived)).mtimeMs >= (await stat(source)).mtimeMs;
}

async function loadSimpleIconsHex(fetchImpl: typeof fetch): Promise<Map<string, string>> {
  const body = JSON.parse(await cached(SIMPLE_ICONS_DATA, fetchImpl, process.env)) as Array<{ slug?: string; title: string; hex: string }> | { icons: Array<{ slug?: string; title: string; hex: string }> };
  const list = Array.isArray(body) ? body : body.icons;
  return new Map(list.filter((i) => i.slug).map((i) => [i.slug!, `#${i.hex.toUpperCase()}`]));
}

/** Derive every HQ size from the masters and colour the brands; returns the `hq` field per key. */
export async function buildHq(options: HqBuildOptions): Promise<Map<string, HqEntry>> {
  const sharp = ((await import('sharp')) as unknown as { default: Sharp }).default;
  const hq = join(options.out, 'hq');
  const entries = new Map<string, HqEntry>();
  for (const size of options.sizes) await mkdir(join(hq, 'png', String(size)), { recursive: true });
  for (const size of HQ_WEBP_SIZES) await mkdir(join(hq, 'webp', String(size)), { recursive: true });
  await mkdir(join(hq, 'svg'), { recursive: true });

  const files = (key: string): HqEntry => ({
    png: `hq/png/{size}/${key}.png`,
    webp: `hq/webp/{size}/${key}.webp`,
    made_by: 'ai',
  });

  // UI icons: from the masters, trimmed and centred to one optical size.
  const masterDir = join(hq, 'master');
  const masters = existsSync(masterDir) ? (await readdir(masterDir)).filter((f) => f.endsWith('.png')) : [];
  const generic = new Set(GENERIC.map((i) => i.key));
  await pool(masters, 8, async (file) => {
    const key = file.slice(0, -4);
    if (!generic.has(key)) return;
    const source = join(masterDir, file);
    const outputs = [
      ...options.sizes.map((s) => join(hq, 'png', String(s), `${key}.png`)),
      ...HQ_WEBP_SIZES.map((s) => join(hq, 'webp', String(s), `${key}.webp`)),
    ];
    if (!(await Promise.all(outputs.map((o) => newer(o, source)))).every(Boolean)) {
      const trimmed = await sharp(await readFile(source)).trim({ threshold: 1 }).toBuffer();
      const meta = await sharp(trimmed).metadata();
      const w = meta.width ?? 1024;
      const h = meta.height ?? 1024;
      const side = Math.ceil(Math.max(w, h) / 0.9);
      const square = await sharp(trimmed)
        .extend({
          top: Math.floor((side - h) / 2),
          bottom: Math.ceil((side - h) / 2),
          left: Math.floor((side - w) / 2),
          right: Math.ceil((side - w) / 2),
          background: { r: 0, g: 0, b: 0, alpha: 0 },
        })
        .png()
        .toBuffer();
      for (const size of options.sizes) {
        await sharp(square).resize(size, size, { kernel: 'lanczos3' }).png({ compressionLevel: 9 }).toFile(outputs[options.sizes.indexOf(size)]!);
      }
      for (const [i, size] of HQ_WEBP_SIZES.entries()) {
        await sharp(square)
          .resize(size, size, { kernel: 'lanczos3' })
          .webp({ quality: 86, alphaQuality: 90, effort: 5 })
          .toFile(outputs[options.sizes.length + i]!);
      }
    }
    entries.set(key, files(key));
  });

  // Brands: the simple logo in the owner's colour.
  const siHex = options.simpleIconsHex ?? (await loadSimpleIconsHex(options.fetchImpl ?? fetch));
  for (const brand of BRANDS) {
    const lineSvg = join(options.out, 'svg', `${brand.key}.svg`);
    if (!existsSync(lineSvg)) continue;
    let hex: string | undefined;
    let hexSource: string;
    if (brand.source === 'simple-icons') {
      hex = siHex.get(brand.slug);
      hexSource = `simple-icons:${brand.slug}`;
    } else {
      hex = FA_BRAND_COLORS[brand.key]?.hex;
      hexSource = FA_BRAND_COLORS[brand.key]?.source ?? '';
    }
    if (!hex) {
      options.log(`no brand colour for ${brand.key}; skipped`);
      continue;
    }
    const svg = (await readFile(lineSvg, 'utf8')).replace('fill="currentColor"', `fill="${hex}"`);
    await writeFile(join(hq, 'svg', `${brand.key}.svg`), svg);
    for (const size of options.sizes) {
      await writeFile(join(hq, 'png', String(size), `${brand.key}.png`), await options.render(svg, size));
    }
    for (const size of HQ_WEBP_SIZES) {
      const png = await options.render(svg, size);
      await sharp(png).webp({ quality: 90, alphaQuality: 95 }).toFile(join(hq, 'webp', String(size), `${brand.key}.webp`));
    }
    entries.set(brand.key, { ...files(brand.key), svg: `hq/svg/${brand.key}.svg`, made_by: 'human', hex, hex_source: hexSource });
  }
  options.log(`${entries.size} HQ icons (${[...entries.values()].filter((e) => e.made_by === 'ai').length} drawn, ${[...entries.values()].filter((e) => e.hex).length} brand-coloured)`);
  return entries;
}

/** Add the `hq` block to an existing openicon.json, in place. */
export function withHq(manifest: Manifest, entries: Map<string, HqEntry>, sizes: number[]): Manifest {
  return {
    ...manifest,
    styles: ['simple', 'hq'],
    hq: {
      sizes,
      webp_sizes: [...HQ_WEBP_SIZES],
      made_by: 'both',
      ai_model: HQ_MODEL,
      ai_provider: 'OpenAI',
      ai_prompt_url: 'hq/style.txt',
      coverage: { total: manifest.icons.length, done: manifest.icons.filter((i) => entries.has(i.key)).length },
    },
    icons: manifest.icons.map((i) => {
      const hq = entries.get(i.key);
      const { hq: _old, ...rest } = i as typeof i & { hq?: HqEntry };
      return hq ? { ...rest, hq } : rest;
    }),
  };
}
