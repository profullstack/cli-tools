/**
 * OpenIcon: the icons a UI keeps reaching for, packed as a folder any app,
 * site or terminal can read.
 *
 * The set is defined in icon-set.ts (drawn here, on a 24x24 stroke grid) and
 * icon-brands.ts (logos fetched from Simple Icons and Font Awesome Free).
 * `build` turns it into the OpenIcon layout:
 *
 *   openicon.json         the descriptor: every icon, its files and its terminal glyphs
 *   svg/<key>.svg         24x24, currentColor
 *   png/<size>/<key>.png  rendered from the SVG
 *   sprite.svg            every icon as a <symbol id="oi-<key>">
 *   index.html            the whole set on one page
 *
 * The terminal glyphs are the part no other icon set carries: a Nerd Font
 * codepoint, a Unicode symbol and an ASCII spelling per icon, so a TUI can
 * draw `mail` as 󰇮 in a patched font, ✉ in a plain one and @ over a serial
 * line. The Nerd Font codepoints are resolved by glyph name from a pinned
 * Nerd Fonts release, never typed by hand.
 */

import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { BRANDS, type BrandDef, FONT_AWESOME_VERSION, SIMPLE_ICONS_VERSION } from './icon-brands.ts';
import { GENERIC, type IconDef } from './icon-set.ts';

export const SPEC_VERSION = '0.1';
export const NERD_FONTS_VERSION = '3.4.0';
export const DEFAULT_OUT = './openicon';
export const DEFAULT_SIZES = [16, 20, 24, 32, 48, 64, 128, 256] as const;
export const DEFAULT_COLOR = '#111111';
export const MODEL = 'claude-opus-5-5';

export const SOURCES = {
  nerd: `https://cdn.jsdelivr.net/gh/ryanoasis/nerd-fonts@v${NERD_FONTS_VERSION}/glyphnames.json`,
  simpleIcons: (slug: string) => `https://cdn.jsdelivr.net/npm/simple-icons@${SIMPLE_ICONS_VERSION}/icons/${slug}.svg`,
  fontAwesome: (name: string) =>
    `https://cdn.jsdelivr.net/npm/@fortawesome/fontawesome-free@${FONT_AWESOME_VERSION}/svgs/brands/${name}.svg`,
};

export const CATEGORY_NAMES: Record<string, string> = {
  action: 'Actions',
  navigation: 'Navigation',
  communication: 'Communication',
  media: 'Media',
  file: 'Files and storage',
  status: 'Status',
  time: 'Time',
  commerce: 'Commerce',
  dev: 'Developer',
  device: 'Devices',
  editor: 'Editor',
  misc: 'Everything else',
  brand: 'Brands',
};

export interface Glyphs {
  /** The Nerd Font character, when the pinned release has one for this icon. */
  nerd?: string;
  /** Its codepoint, hex, and its Nerd Fonts name (without nf-). */
  nerd_code?: string;
  nerd_name?: string;
  unicode: string;
  ascii: string;
}

export interface IconEntry {
  key: string;
  name: string;
  category: string;
  aliases?: string[];
  keywords?: string[];
  brand?: true;
  trademark?: string;
  source?: string;
  license?: string;
  made_by?: 'human' | 'ai' | 'both';
  svg: string;
  png: string;
  tui: Glyphs;
  /** The HQ style, when the set has one: see icon-hq.ts. */
  hq?: StyleFiles;
  /**
   * Every drawn style this icon has, keyed by style id (`hq`, `agentic-matte`,
   * …). `hq` above is the same entry under its old name, kept so readers
   * written against the first HQ release keep working.
   */
  styles?: Record<string, StyleFiles>;
}

/**
 * Where one icon's files live in one style. `{size}` is the caller's to fill.
 *
 * `made_by` is rule 8's vocabulary: `ai` for a drawn icon, `human` for a mark
 * taken from its owner unchanged, and `both` for a mark re-rendered in a
 * style's material — the geometry is the owner's, the surface is ours.
 */
export interface StyleFiles {
  png: string;
  webp: string;
  svg?: string;
  made_by: 'ai' | 'human' | 'both';
  hex?: string;
  hex_source?: string;
}

export interface Manifest {
  openicon: string;
  name: string;
  version: string;
  license: string;
  homepage: string;
  made_by: 'ai';
  disclosure: 'ai-generated';
  ai_model: string;
  ai_provider: string;
  grid: { size: number; stroke: number; padding: number };
  sizes: number[];
  formats: string[];
  sprite: string;
  sources: Record<string, string>;
  categories: Record<string, string>;
  /** Present when the set ships more than the simple style. */
  styles?: string[];
  /** One block per drawn style in `styles`, keyed by style id. */
  style_info?: Record<string, StyleInfo>;
  /** The first HQ release's block, kept under its old name beside style_info.hq. */
  hq?: StyleInfo;
  icons: IconEntry[];
}

/** What a reader needs to know about one drawn style before using it. */
export interface StyleInfo {
  /** Where the style's files sit in the set; absent on the first HQ block. */
  dir?: string;
  label?: string;
  /** One line on the material, so a reader can choose without looking. */
  material?: string;
  sizes: number[];
  webp_sizes: number[];
  made_by: 'ai' | 'human' | 'both';
  ai_model: string;
  ai_provider: string;
  ai_prompt_url: string;
  coverage: { total: number; done: number };
}

// ------------------------------------------------------------------ names

/** "git-pull-request" -> "Git pull request". */
export const humanName = (key: string) => {
  const words = key.split('-');
  return [words[0]!.charAt(0).toUpperCase() + words[0]!.slice(1), ...words.slice(1)].join(' ');
};

export const KEY_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** Every key and alias, checked once: kebab case, unique across the set. */
export function checkNames(icons: Array<{ key: string; aliases?: string[] }>): string[] {
  const problems: string[] = [];
  const seen = new Map<string, string>();
  for (const icon of icons) {
    for (const name of [icon.key, ...(icon.aliases ?? [])]) {
      if (!KEY_PATTERN.test(name)) problems.push(`${icon.key}: "${name}" is not kebab-case`);
      const owner = seen.get(name);
      if (owner && owner !== icon.key) problems.push(`"${name}" is used by both ${owner} and ${icon.key}`);
      seen.set(name, icon.key);
    }
  }
  return problems;
}

// ------------------------------------------------------------------ sources

export function cacheDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(env['XDG_CACHE_HOME'] || join(homedir(), '.cache'), 'cli-tools', 'icon');
}

/** Fetch a pinned file once; the cache is keyed by URL, so a version bump refetches. */
export async function cached(url: string, fetchImpl: typeof fetch, env: NodeJS.ProcessEnv): Promise<string> {
  const file = join(cacheDir(env), url.replace(/^https:\/\//, '').replace(/[^a-zA-Z0-9._-]+/g, '_'));
  if (existsSync(file)) return readFile(file, 'utf8');
  const response = await fetchImpl(url);
  if (!response.ok) throw new Error(`HTTP ${response.status} from ${url}`);
  const text = await response.text();
  await mkdir(cacheDir(env), { recursive: true });
  await writeFile(file, text);
  return text;
}

export type NerdTable = Record<string, { char: string; code: string }>;

/** The pinned Nerd Fonts glyph table, fetched once and cached. */
export async function loadNerd(fetchImpl: typeof fetch = fetch, env: NodeJS.ProcessEnv = process.env): Promise<NerdTable> {
  return JSON.parse(await cached(SOURCES.nerd, fetchImpl, env)) as NerdTable;
}

export function resolveNerd(candidates: readonly string[], table: NerdTable): Pick<Glyphs, 'nerd' | 'nerd_code' | 'nerd_name'> {
  for (const name of candidates) {
    const hit = table[name];
    if (hit) return { nerd: hit.char, nerd_code: hit.code, nerd_name: name };
  }
  return {};
}

// ----------------------------------------------------------------- drawing

export const strokeSvg = (body: string, title?: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${title ? `<title>${escapeXml(title)}</title>` : ''}${body}</svg>\n`;

const escapeXml = (s: string) => s.replace(/[&<>"]/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[ch]!);

/**
 * A brand logo, moved onto the set's grid: scaled into the 20x20 live area
 * (the stroke icons keep 2 units of padding, so a full-bleed logo would look
 * a size larger beside them), centred, filled with currentColor.
 */
export function brandSvg(source: string, title: string): string {
  const viewBox = /viewBox="([\d.\s-]+)"/.exec(source)?.[1]?.trim().split(/\s+/).map(Number);
  const paths = [...source.matchAll(/<path[^>]*\sd="([^"]+)"/g)].map((m) => m[1]!);
  if (!viewBox || viewBox.length !== 4 || paths.length === 0) throw new Error(`cannot read the SVG for ${title}`);
  const [, , w, h] = viewBox as [number, number, number, number];
  const scale = 20 / Math.max(w, h);
  const tx = 2 + (20 - w * scale) / 2;
  const ty = 2 + (20 - h * scale) / 2;
  const transform = `translate(${round(tx)} ${round(ty)}) scale(${round(scale, 5)})`;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor"><title>${escapeXml(title)}</title><g transform="${transform}">${paths.map((d) => `<path d="${d}"/>`).join('')}</g></svg>\n`;
}

const round = (n: number, digits = 3) => Number(n.toFixed(digits)).toString();

/** The inner markup of an icon SVG, for the sprite. */
const inner = (svg: string) => svg.replace(/^<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '').replace(/<title>.*?<\/title>/, '');

// ------------------------------------------------------------------- build

export interface BuildOptions {
  out: string;
  sizes: number[];
  color: string;
  only?: string[];
  fetchImpl?: typeof fetch;
  env?: NodeJS.ProcessEnv;
  log: (line: string) => void;
  /** Rasteriser, injectable for tests. Defaults to @resvg/resvg-js. */
  render?: (svg: string, size: number) => Promise<Buffer> | Buffer;
}

export async function build(options: BuildOptions): Promise<Manifest> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const env = options.env ?? process.env;
  const problems = checkNames([...GENERIC, ...BRANDS]);
  if (problems.length) throw new Error(`the set has naming problems:\n${problems.join('\n')}`);

  const wanted = (key: string) => !options.only?.length || options.only.includes(key);
  const generic = GENERIC.filter((i) => wanted(i.key));
  const brands = BRANDS.filter((b) => wanted(b.key));

  const nerd = await loadNerd(fetchImpl, env);
  const render = options.render ?? (await resvgRenderer());

  await rm(join(options.out, 'svg'), { recursive: true, force: true });
  await rm(join(options.out, 'png'), { recursive: true, force: true });
  await mkdir(join(options.out, 'svg'), { recursive: true });
  for (const size of options.sizes) await mkdir(join(options.out, 'png', String(size)), { recursive: true });

  const entries: IconEntry[] = [];
  const svgs = new Map<string, string>();

  for (const icon of generic) {
    svgs.set(icon.key, strokeSvg(icon.body, humanName(icon.key)));
    entries.push(entryFor(icon, 'generic', nerd));
  }
  options.log(`${generic.length} drawn icons`);

  for (const brand of brands) {
    const url = brand.source === 'simple-icons' ? SOURCES.simpleIcons(brand.slug) : SOURCES.fontAwesome(brand.slug);
    svgs.set(brand.key, brandSvg(await cached(url, fetchImpl, env), brand.title));
    entries.push(entryFor(brand, 'brand', nerd));
  }
  options.log(`${brands.length} brand logos`);

  for (const [key, svg] of svgs) {
    await writeFile(join(options.out, 'svg', `${key}.svg`), svg);
    const colored = svg.replaceAll('currentColor', options.color);
    for (const size of options.sizes) {
      await writeFile(join(options.out, 'png', String(size), `${key}.png`), await render(colored, size));
    }
  }

  const sprite = `<svg xmlns="http://www.w3.org/2000/svg" style="display:none">\n${[...svgs]
    .map(([key, svg]) => {
      const attrs = svg.includes('stroke="currentColor"')
        ? 'fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"'
        : 'fill="currentColor"';
      return `<symbol id="oi-${key}" viewBox="0 0 24 24" ${attrs}>${inner(svg)}</symbol>`;
    })
    .join('\n')}\n</svg>\n`;
  await writeFile(join(options.out, 'sprite.svg'), sprite);

  const manifest: Manifest = {
    openicon: SPEC_VERSION,
    name: 'OpenIcon',
    version: new Date().toISOString().slice(0, 10),
    license: 'MIT',
    homepage: 'https://logicsrc.com/openicon',
    made_by: 'ai',
    disclosure: 'ai-generated',
    ai_model: MODEL,
    ai_provider: 'Anthropic',
    grid: { size: 24, stroke: 2, padding: 2 },
    sizes: options.sizes,
    formats: ['svg', 'png', 'sprite'],
    sprite: 'sprite.svg',
    sources: {
      'nerd-fonts': `Nerd Fonts ${NERD_FONTS_VERSION} glyph names (MIT)`,
      'simple-icons': `Simple Icons ${SIMPLE_ICONS_VERSION} (CC0-1.0)`,
      'font-awesome': `Font Awesome Free ${FONT_AWESOME_VERSION} brands (CC-BY-4.0)`,
    },
    categories: CATEGORY_NAMES,
    icons: entries,
  };
  await writeFile(join(options.out, 'openicon.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  await writeFile(join(options.out, 'index.html'), previewFor(manifest, svgs));
  return manifest;
}

function entryFor(icon: IconDef | BrandDef, kind: 'generic' | 'brand', nerd: NerdTable): IconEntry {
  const tui: Glyphs = { ...resolveNerd(icon.nerd, nerd), unicode: icon.unicode, ascii: icon.ascii };
  const base = {
    svg: `svg/${icon.key}.svg`,
    png: `png/{size}/${icon.key}.png`,
    tui,
  };
  if (kind === 'generic') {
    const g = icon as IconDef;
    return {
      key: g.key,
      name: humanName(g.key),
      category: g.category,
      ...(g.aliases?.length ? { aliases: g.aliases } : {}),
      ...(g.keywords?.length ? { keywords: g.keywords } : {}),
      ...base,
    };
  }
  const b = icon as BrandDef;
  return {
    key: b.key,
    name: b.title,
    category: 'brand',
    ...(b.aliases?.length ? { aliases: b.aliases } : {}),
    brand: true,
    trademark: `${b.title} and its logo are trademarks of their owner. Use them to refer to ${b.title}, not to imply endorsement.`,
    source: b.source === 'simple-icons' ? `simple-icons:${b.slug}` : `font-awesome:${b.slug}`,
    license: b.source === 'simple-icons' ? 'CC0-1.0' : 'CC-BY-4.0',
    made_by: 'human',
    ...base,
  };
}

async function resvgRenderer(): Promise<(svg: string, size: number) => Buffer> {
  const { Resvg } = await import('@resvg/resvg-js');
  return (svg, size) => Buffer.from(new Resvg(svg, { fitTo: { mode: 'width', value: size } }).render().asPng());
}

/** An icon's colour styles, with `hq` under both its names counted once. */
export function stylesOf(icon: IconEntry): Record<string, StyleFiles> {
  return { ...(icon.hq ? { hq: icon.hq } : {}), ...icon.styles };
}

/**
 * Rewrite index.html from a manifest and the SVGs already on disk.
 *
 * `build` writes the page too, but it writes it before any colour style has
 * been applied, so the page it makes shows the line set alone. A build that
 * then derives styles calls this again with the finished manifest, which is
 * the only version that has artwork to switch to.
 */
export async function writePreview(out: string, manifest: Manifest): Promise<void> {
  const svgs = new Map<string, string>();
  for (const icon of manifest.icons) svgs.set(icon.key, await readFile(join(out, icon.svg), 'utf8'));
  await writeFile(join(out, 'index.html'), previewFor(manifest, svgs));
}

export function previewFor(manifest: Manifest, svgs: Map<string, string>): string {
  // The colour styles the set has actually derived files for, in its own order.
  const colour = (manifest.styles ?? []).filter((id) => id !== 'simple' && manifest.icons.some((i) => stylesOf(i)[id]));
  const artFor = (icon: IconEntry, id: string): string => {
    const files = stylesOf(icon)[id];
    if (!files) return '';
    const src = files.svg ?? files.webp?.replace('{size}', '64') ?? files.png?.replace('{size}', '64') ?? '';
    return src ? `<img class="art" data-style="${escapeXml(id)}" src="${escapeXml(src)}" alt="" width="28" height="28" loading="lazy" decoding="async">` : '';
  };

  const byCategory = new Map<string, IconEntry[]>();
  for (const icon of manifest.icons) byCategory.set(icon.category, [...(byCategory.get(icon.category) ?? []), icon]);
  const sections = [...byCategory]
    .map(
      ([category, icons]) => `<h2>${escapeXml(manifest.categories[category] ?? category)} <small>${icons.length}</small></h2>
<div class="grid">${icons
        .map(
          (i) =>
            `<figure title="${escapeXml(i.key)}">${svgs.get(i.key)!.replace('<svg ', '<svg class="art" data-style="simple" width="28" height="28" ')}${colour.map((id) => artFor(i, id)).join('')}<figcaption>${escapeXml(i.key)}<span>${escapeXml(i.tui.unicode)} ${escapeXml(i.tui.ascii)}</span></figcaption></figure>`,
        )
        .join('')}</div>`,
    )
    .join('\n');

  // One button per style, and a hidden image per style that the CSS reveals:
  // no script, and a browser never fetches the artwork of a style nobody picks.
  const all = ['simple', ...colour];
  const styleBar = colour.length
    ? `${all
        .map((id) => `<input type="radio" name="style" id="style-${escapeXml(id)}"${id === 'simple' ? ' checked' : ''}>`)
        .join('')}
<div class="styles">${all
        .map((id) => {
          const info = manifest.style_info?.[id];
          const label = id === 'simple' ? 'Simple' : (info?.label ?? id);
          const title = id === 'simple' ? 'The line icon, in the text colour' : (info?.material ?? '');
          return `<label for="style-${escapeXml(id)}" title="${escapeXml(title)}">${escapeXml(label)}</label>`;
        })
        .join('')}</div>`
    : '';
  const styleCss = colour.length
    ? `input[name=style]{position:absolute;opacity:0;pointer-events:none}
.styles{display:flex;flex-wrap:wrap;gap:6px;margin:0 0 20px}
.styles label{padding:6px 11px;border:1px solid var(--line);border-radius:999px;font-size:12px;color:var(--muted);cursor:pointer}
.art{display:none}
${all.map((id) => `#style-${id}:checked~.styles label[for="style-${id}"]`).join(',')}{background:var(--ink);border-color:var(--ink);color:var(--bg)}
${all.map((id) => `#style-${id}:checked~.sheet .art[data-style="${id}"]`).join(',')}{display:block;margin:0 auto}`
    : '.art{display:block;margin:0 auto}';
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>OpenIcon preview</title>
<style>
:root{--bg:#f7f7f4;--ink:#16181a;--muted:#6a6f75;--card:#fff;--line:#dcdcd7}
@media (prefers-color-scheme:dark){:root{--bg:#121314;--ink:#ecebe7;--muted:#9a9ea3;--card:#1b1c1e;--line:#2e3033}}
body{margin:0;padding:24px 16px;background:var(--bg);color:var(--ink);font:14px/1.4 system-ui,sans-serif}
h1{margin:0 0 4px;font-size:26px}p{color:var(--muted);margin:0 0 20px}h2{font-size:16px;margin:28px 0 10px}small{color:var(--muted);font-weight:400}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(104px,1fr));gap:6px}
figure{margin:0;padding:12px 4px 8px;background:var(--card);border-radius:10px;text-align:center;color:var(--ink)}
figcaption{font-size:11px;color:var(--muted);margin-top:6px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}figcaption span{display:block;font-family:ui-monospace,monospace}
${styleCss}
</style></head><body>
<h1>OpenIcon</h1>
<p>${manifest.icons.length} icons on a 24px grid, each with a Nerd Font, Unicode and ASCII glyph for terminals. OpenIcon ${manifest.openicon}.</p>
${styleBar}
<div class="sheet">
${sections}
</div>
</body></html>
`;
}

export async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}
