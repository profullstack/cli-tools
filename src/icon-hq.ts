/**
 * The drawn styles of OpenIcon: every icon in full colour, as an alternative
 * to the simple line set (which stays canonical and the default). This file is
 * the engine; icon-styles.ts is what each style actually looks like.
 *
 * Every draw is pinned by the icon's own simple line glyph, rendered at 1024
 * as the FIRST reference, with the prompt saying to keep its silhouette and
 * meaning — that is what keeps 259 drawings coherent and keeps `filter` a
 * funnel rather than whatever the model thinks filters are. The HQ style adds
 * three OpenEmoji masters as style references so it reads as one family with
 * the emoji; the agentic styles deliberately use none, because those masters
 * are where the gloss comes from.
 *
 * Brands are drawn only by a style that says how (`promptForBrand`), and then
 * only as a material re-rendering of the owner's own mark, pinned by that mark
 * as the reference: the geometry is never the model's to invent. A style that
 * says nothing — `hq` — keeps the older behaviour, the same logo recoloured to
 * the owner's published colour (Simple Icons' `hex`, or a cited brand page for
 * the few that came from Font Awesome).
 *
 * Masters live in <style-dir>/master (1024px, kept out of git); everything
 * else is derived: <style-dir>/png/<size>, <style-dir>/webp/<size>, and
 * <style-dir>/svg for brands.
 */

import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { type ImageCaller, RefusedError, pool } from './emoji.ts';
import { BRANDS, SIMPLE_ICONS_VERSION } from './icon-brands.ts';
import { GENERIC, type IconDef } from './icon-set.ts';
import { type Manifest, type StyleFiles, type StyleInfo, cached, strokeSvg } from './icon.ts';
import { HQ, HQ_STYLE, STYLE_REFS, type StyleSpec } from './icon-styles.ts';

export const HQ_MODEL = 'gpt-image-2';
export const HQ_WEBP_SIZES = [64, 128] as const;
export const HQ_CONCURRENCY = 12;
/** Drawn first, to judge the prompt on a contact sheet before the rest. */
export const HQ_ANCHORS = ['mail', 'settings', 'search', 'delete', 'lock', 'calendar', 'cart', 'terminal', 'bell', 'folder'] as const;

export { HQ_STYLE, STYLE_REFS };
export { CATEGORY_COLORS, hqColorFor } from './icon-palette.ts';

/** The HQ style's prompt for one icon. Other styles: `STYLES[id].promptFor`. */
export const hqPromptFor = (icon: IconDef): string => HQ.promptFor(icon);

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

/** A brand's published colour and where it is published, or undefined. */
export interface BrandColor {
  hex: string;
  source: string;
}

/**
 * Every brand's owner colour, from Simple Icons where it carries one and from
 * the cited brand page for the nine that came from Font Awesome. Both the draw
 * pass and the derive pass need this — the draw pass to tell the model what
 * colour the mark is, the derive pass to record it — so it is resolved once.
 */
export async function loadBrandColors(fetchImpl: typeof fetch = fetch): Promise<Map<string, BrandColor>> {
  return brandColorsFrom(await loadSimpleIconsHex(fetchImpl));
}

export function brandColorsFrom(siHex: Map<string, string>): Map<string, BrandColor> {
  const out = new Map<string, BrandColor>();
  for (const brand of BRANDS) {
    if (brand.source === 'simple-icons') {
      const hex = siHex.get(brand.slug);
      if (hex) out.set(brand.key, { hex, source: `simple-icons:${brand.slug}` });
    } else if (FA_BRAND_COLORS[brand.key]) {
      out.set(brand.key, FA_BRAND_COLORS[brand.key]!);
    }
  }
  return out;
}

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
  /** Where the OpenEmoji masters live; unread by a style with no emoji refs. */
  styleDir: string;
  concurrency: number;
  quality: string;
  force: boolean;
  log: (line: string) => void;
  render: (svg: string, size: number) => Promise<Buffer> | Buffer;
  sleep?: (ms: number) => Promise<void>;
  /** Which style to draw; the HQ style when a caller does not say. */
  style?: StyleSpec;
  /**
   * Owner colours, needed only when the style restyles brands. Absent means
   * brand keys are rejected exactly as they were before styles could draw them.
   */
  brandColors?: Map<string, BrandColor>;
}

export interface HqDrawReport {
  drawn: string[];
  skipped: string[];
  failed: Array<{ key: string; error: string }>;
  calls: number;
  stoppedForCredit?: string;
}

/** Draw a style's missing masters; stops cleanly, keeping what landed, if credit runs out. */
export async function drawHq(options: HqDrawOptions): Promise<HqDrawReport> {
  const style = options.style ?? HQ;
  const master = join(options.out, style.dir, 'master');
  await mkdir(master, { recursive: true });
  const styleRefs = await Promise.all(style.emojiRefs.map((f) => readFile(join(options.styleDir, f))));
  const report: HqDrawReport = { drawn: [], skipped: [], failed: [], calls: 0 };
  const byKey = new Map(GENERIC.map((i) => [i.key, i]));
  const sleep = options.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));

  const brandByKey = new Map(BRANDS.map((b) => [b.key, b]));
  const drawsBrands = Boolean(style.promptForBrand);

  const todo = options.keys.filter((key) => {
    if (!byKey.has(key)) {
      if (!brandByKey.has(key)) throw new Error(`${key} is not an icon in the set`);
      // A brand is drawable only for a style that says how to re-render a mark;
      // for every other style its coloured form is still the flat recolour.
      if (!drawsBrands) throw new Error(`${key} is a brand and ${style.id} does not restyle marks (it recolours them)`);
    }
    if (!options.force && existsSync(join(master, `${key}.png`))) {
      report.skipped.push(key);
      return false;
    }
    return true;
  });

  await pool(todo, options.concurrency, async (key) => {
    if (report.stoppedForCredit) return;
    const icon = byKey.get(key);
    const brand = brandByKey.get(key);
    // The pin: the icon's own artwork, dark on white, for the model to keep.
    // A drawn icon has a body in the set; a brand's mark is a file on disk,
    // fetched from its owner's source at build time and never authored here.
    let line: Buffer;
    let prompt: string;
    if (brand) {
      const markFile = join(options.out, 'svg', `${brand.key}.svg`);
      if (!existsSync(markFile)) {
        report.failed.push({ key, error: `no mark at ${markFile}; run \`icon build\` first` });
        options.log(`FAILED ${key}: no mark on disk`);
        return;
      }
      const colour = options.brandColors?.get(brand.key);
      const mark = (await readFile(markFile, 'utf8'))
        .replace('<svg ', '<svg style="background:#fff" ')
        .replace('fill="currentColor"', `fill="${colour?.hex ?? '#111111'}"`);
      line = Buffer.from(await options.render(mark, 1024));
      prompt = style.promptForBrand!({ key: brand.key, title: brand.title, ...(colour ? { hex: colour.hex } : {}) });
    } else {
      line = Buffer.from(
        await options.render(
          strokeSvg(icon!.body).replace('<svg ', '<svg style="background:#fff" ').replaceAll('currentColor', '#111111'),
          1024,
        ),
      );
      prompt = style.promptFor(icon!);
    }
    for (let attempt = 1; ; attempt += 1) {
      if (report.stoppedForCredit) return;
      try {
        report.calls += 1;
        const result = await options.caller({
          model: HQ_MODEL,
          // A brand takes no style reference: the mark is the only thing the
          // model should be looking at, and an emoji master beside it is an
          // invitation to redraw.
          prompt,
          quality: options.quality,
          references: brand ? [line] : [line, ...styleRefs],
        });
        await writeFile(join(master, `${key}.png`), result.png);
        await writeFile(
          join(options.out, style.dir, 'prompts.jsonl'),
          `${JSON.stringify({ key, style: style.id, prompt, brand: Boolean(brand), references: brand ? ['mark'] : ['line', ...style.emojiRefs] })}\n`,
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
  /** Which style to derive; the HQ style when a caller does not say. */
  style?: StyleSpec;
}

export type HqEntry = StyleFiles;

/**
 * Whether an image file is really an image. A run that fills the disk leaves a
 * truncated file behind with a plausible mtime, and a skip that trusts the
 * mtime then carries that file forward for good: one HQ webp shipped that way.
 * Decoding is the only check that catches it, so every skip pays for one.
 */
async function decodes(sharp: Sharp, file: string): Promise<boolean> {
  try {
    const meta = await sharp(await readFile(file)).metadata();
    return Boolean(meta.width && meta.height);
  } catch {
    return false;
  }
}

async function newer(sharp: Sharp, derived: string, source: string): Promise<boolean> {
  if (!existsSync(derived)) return false;
  if ((await stat(derived)).mtimeMs < (await stat(source)).mtimeMs) return false;
  return decodes(sharp, derived);
}

async function loadSimpleIconsHex(fetchImpl: typeof fetch): Promise<Map<string, string>> {
  const body = JSON.parse(await cached(SIMPLE_ICONS_DATA, fetchImpl, process.env)) as Array<{ slug?: string; title: string; hex: string }> | { icons: Array<{ slug?: string; title: string; hex: string }> };
  const list = Array.isArray(body) ? body : body.icons;
  return new Map(list.filter((i) => i.slug).map((i) => [i.slug!, `#${i.hex.toUpperCase()}`]));
}

/** Derive every HQ size from the masters and colour the brands; returns the `hq` field per key. */
export async function buildHq(options: HqBuildOptions): Promise<Map<string, HqEntry>> {
  const sharp = ((await import('sharp')) as unknown as { default: Sharp }).default;
  const style = options.style ?? HQ;
  const hq = join(options.out, style.dir);
  const entries = new Map<string, HqEntry>();
  for (const size of options.sizes) await mkdir(join(hq, 'png', String(size)), { recursive: true });
  for (const size of HQ_WEBP_SIZES) await mkdir(join(hq, 'webp', String(size)), { recursive: true });
  await mkdir(join(hq, 'svg'), { recursive: true });

  const files = (key: string): HqEntry => ({
    png: `${style.dir}/png/{size}/${key}.png`,
    webp: `${style.dir}/webp/{size}/${key}.webp`,
    made_by: 'ai',
  });

  // Owner colours, resolved once: the derive pass records them on every brand
  // whether the mark was drawn into the material or only recoloured.
  const siHex = options.simpleIconsHex ?? (await loadSimpleIconsHex(options.fetchImpl ?? fetch));
  const brandColors = brandColorsFrom(siHex);

  // Drawn artwork: from the masters, trimmed and centred to one optical size.
  // A brand master is here too when the style restyles marks, and takes the
  // same path as a drawn icon — the only difference is what it is called in
  // the manifest, since the mark is the owner's and the material is ours.
  const broken: string[] = [];
  const masterDir = join(hq, 'master');
  const masters = existsSync(masterDir) ? (await readdir(masterDir)).filter((f) => f.endsWith('.png')) : [];
  const generic = new Set(GENERIC.map((i) => i.key));
  const brandKeys = new Set(BRANDS.map((b) => b.key));
  const drawnBrands = new Set<string>();
  await pool(masters, 8, async (file) => {
    const key = file.slice(0, -4);
    if (!generic.has(key) && !brandKeys.has(key)) return;
    const source = join(masterDir, file);
    const outputs = [
      ...options.sizes.map((s) => join(hq, 'png', String(s), `${key}.png`)),
      ...HQ_WEBP_SIZES.map((s) => join(hq, 'webp', String(s), `${key}.webp`)),
    ];
    if (!(await decodes(sharp, source))) {
      // A master that will not decode is a failed or truncated draw: say so
      // rather than deriving eight broken sizes from it. `--force` redraws it.
      broken.push(key);
      options.log(`BROKEN master ${style.id}/${key}: it does not decode; redraw it with --force --only ${key}`);
      return;
    }
    if (!(await Promise.all(outputs.map((o) => newer(sharp, o, source)))).every(Boolean)) {
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
    if (brandKeys.has(key)) {
      // The mark is the owner's, the material is ours: `both`, not `ai`, and
      // no `svg` — the styled form is raster, and a reader that finds an `svg`
      // here would show the flat mark and never the material.
      const colour = brandColors.get(key);
      drawnBrands.add(key);
      entries.set(key, {
        ...files(key),
        made_by: 'both',
        ...(colour ? { hex: colour.hex, hex_source: colour.source } : {}),
      });
      return;
    }
    entries.set(key, files(key));
  });

  // Brands the style did not draw: the simple logo in the owner's colour.
  for (const brand of BRANDS) {
    if (drawnBrands.has(brand.key)) continue;
    const lineSvg = join(options.out, 'svg', `${brand.key}.svg`);
    if (!existsSync(lineSvg)) continue;
    const colour = brandColors.get(brand.key);
    const hex = colour?.hex;
    const hexSource = colour?.source ?? '';
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
    entries.set(brand.key, { ...files(brand.key), svg: `${style.dir}/svg/${brand.key}.svg`, made_by: 'human', hex, hex_source: hexSource });
  }
  options.log(
    `${entries.size} ${style.id} icons (${[...entries.values()].filter((e) => e.made_by === 'ai').length} drawn, ` +
      `${drawnBrands.size} marks in the material, ${[...entries.values()].filter((e) => e.made_by === 'human').length} marks recoloured)`,
  );
  if (broken.length) options.log(`${broken.length} unreadable masters, left out of the manifest: ${broken.join(', ')}`);
  return entries;
}

/**
 * Write one style into an existing openicon.json, leaving every other style
 * alone: a set can carry `hq` and the three agentic styles at once, and each
 * is built by its own run.
 *
 * `simple` leads the style list because it stays canonical; the rest follow in
 * the order they were added. The HQ style also keeps writing the top-level
 * `hq` block and the per-icon `hq` key it shipped with, so a reader written
 * against the first HQ release does not break on a set that has four styles.
 */
export function withStyle(manifest: Manifest, style: StyleSpec, entries: Map<string, HqEntry>, sizes: number[]): Manifest {
  const info: StyleInfo = {
    dir: style.dir,
    label: style.label,
    material: style.material,
    ground: style.ground,
    sizes,
    webp_sizes: [...HQ_WEBP_SIZES],
    made_by: 'both',
    ai_model: HQ_MODEL,
    ai_provider: 'OpenAI',
    ai_prompt_url: `${style.dir}/style.txt`,
    coverage: { total: manifest.icons.length, done: manifest.icons.filter((i) => entries.has(i.key)).length },
  };
  const styles = [...new Set(['simple', ...(manifest.styles ?? []), style.id])];
  return {
    ...manifest,
    styles,
    style_info: { ...manifest.style_info, [style.id]: info },
    ...(style.id === 'hq' ? { hq: info } : {}),
    icons: manifest.icons.map((icon) => {
      const entry = entries.get(icon.key);
      const styled: Record<string, HqEntry> = { ...icon.styles };
      if (entry) styled[style.id] = entry;
      else delete styled[style.id];
      const next: typeof icon = { ...icon };
      if (Object.keys(styled).length) next.styles = styled;
      else delete next.styles;
      if (style.id === 'hq') {
        if (entry) next.hq = entry;
        else delete next.hq;
      }
      return next;
    }),
  };
}

/** The HQ style, written the way the first HQ release wrote it. */
export function withHq(manifest: Manifest, entries: Map<string, HqEntry>, sizes: number[]): Manifest {
  return withStyle(manifest, HQ, entries, sizes);
}
