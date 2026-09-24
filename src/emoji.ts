/**
 * A whole emoji set, designed by an image model, packed the OpenEmoji way.
 *
 * The list is Unicode's own: emoji-test.txt, every fully-qualified sequence,
 * so "all the standard emojis" means exactly what a keyboard offers and not a
 * hand-kept subset that goes stale with the next Emoji version.
 *
 * The artwork is generated, and the part that makes it a set rather than
 * 3,800 unrelated pictures is how each call is made:
 *
 *   - One art direction (STYLE, or --style FILE) goes into every prompt.
 *   - A handful of anchors are drawn first. Every later glyph is an *edit*
 *     that is handed those anchors as references, so the lighting, gloss and
 *     proportions carry across the set instead of drifting call by call.
 *   - Skin-tone variants are never drawn from scratch. They are edits of the
 *     already-drawn base glyph that change the skin and nothing else, which is
 *     the only way 👍🏽 ends up the same thumb as 👍.
 *
 * Everything after the master PNGs is derived and can be rebuilt offline:
 * PNGs at each size (sharp), SVGs traced from the master (vtracer), colour
 * fonts (nanoemoji: CBDT for Chrome/Android/Linux, sbix for Apple), a
 * stylesheet, a preview page and openemoji.json. The Python tools run through
 * `uv`, fetched on first use, so there is nothing to install by hand.
 *
 * Generation is resumable: a master that exists is never paid for twice.
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, join } from 'node:path';

import { shortcodeOf } from './emoji-platforms.ts';

export const EMOJI_TEST_URL = 'https://unicode.org/Public/emoji/latest/emoji-test.txt';
export const DEFAULT_OUT = './openemoji';
export const DEFAULT_MODEL = 'gpt-image-2';
export const DEFAULT_QUALITY = 'medium';
export const DEFAULT_CONCURRENCY = 6;
export const DEFAULT_SIZES = [16, 20, 32, 48, 64, 72, 96, 128, 160, 256, 512] as const;
/** WebP copies for the web: small enough to put a whole catalog on one page. */
export const DEFAULT_WEBP_SIZES = [64, 128] as const;
export const CLDR_ANNOTATIONS_URLS = [
  'https://cdn.jsdelivr.net/npm/cldr-annotations-full/annotations/en/annotations.json',
  'https://cdn.jsdelivr.net/npm/cldr-annotations-derived-full/annotationsDerived/en/annotations.json',
] as const;
/** The PNG size fonts embed. 136 is what Noto Color Emoji ships. */
export const FONT_BITMAP = 136;
export const SPEC_VERSION = '0.1';
export const FAMILY = 'OpenEmoji';

/** Drawn first; every other glyph is drawn with these as its style references. */
export const ANCHORS = ['1f600', '1f525', '2764-fe0f', '1f44d', '1f680', '1f431'] as const;

export const STYLE = `Design one glyph for a premium, original emoji typeface that has to hold its own next to Apple and Microsoft Fluent.
Art direction: soft-volume 3D with vector clarity. Bold, instantly readable silhouette built from clean geometric forms. Smooth, rich gradients that model the form; one warm key light from the upper left with a crisp specular highlight; gentle ambient occlusion where shapes meet; a subtle darker rim on the lower-right edge. Saturated, harmonious colour; materials read as what they are (glass, metal, fur, fabric, skin) without photographic noise. No outlines, no heavy strokes, no text or letters unless the emoji itself is a letter, number or written symbol.
Composition: one subject, centred, filling about 86% of the square, facing the viewer, nothing cropped. Fully transparent background. No ground shadow, no frame, no badge, no backdrop, no watermark.
Every design is original: never resemble a character, costume, logo or mascot from any film, game, brand or franchise (no Disney genie, fairy, mermaid or superhero looks); draw the generic idea in this set's own style.
It must stay legible at 20 pixels and sit beside the rest of the set as one family.`;

const TONES: Record<string, string> = {
  '1f3fb': 'light skin tone (Fitzpatrick type 1-2)',
  '1f3fc': 'medium-light skin tone (Fitzpatrick type 3)',
  '1f3fd': 'medium skin tone (Fitzpatrick type 4)',
  '1f3fe': 'medium-dark skin tone (Fitzpatrick type 5)',
  '1f3ff': 'dark skin tone (Fitzpatrick type 6)',
};

export interface Entry {
  /** Fully-qualified codepoints, lowercase hex, hyphen-joined: the file name. */
  key: string;
  codepoints: string[];
  char: string;
  name: string;
  group: string;
  subgroup: string;
  /** Emoji version the sequence arrived in, e.g. "15.1". */
  version: string;
}

// ---------------------------------------------------------------- the list

export const toKey = (codepoints: readonly string[]): string =>
  codepoints.map((cp) => cp.toLowerCase()).join('-');

/** Every fully-qualified line of emoji-test.txt, in Unicode's order. */
export function parseEmojiTest(text: string): Entry[] {
  const entries: Entry[] = [];
  let group = '';
  let subgroup = '';
  for (const line of text.split(/\r?\n/)) {
    const g = /^# group: (.+)$/.exec(line);
    if (g) {
      group = g[1]!.trim();
      continue;
    }
    const s = /^# subgroup: (.+)$/.exec(line);
    if (s) {
      subgroup = s[1]!.trim();
      continue;
    }
    // 1F600 ; fully-qualified # 😀 E1.0 grinning face
    const m = /^([0-9A-F ]+?)\s*;\s*fully-qualified\s*#\s*(\S+)\s+E(\d+\.\d+)\s+(.+)$/.exec(line);
    if (!m) continue;
    const codepoints = m[1]!.trim().split(/\s+/).map((cp) => cp.toLowerCase());
    entries.push({
      key: toKey(codepoints),
      codepoints,
      char: m[2]!,
      version: m[3]!,
      name: m[4]!.trim(),
      group,
      subgroup,
    });
  }
  return entries;
}

/** The skin-tone modifiers in a sequence, in order. */
export const tonesOf = (entry: Pick<Entry, 'codepoints'>): string[] =>
  entry.codepoints.filter((cp) => cp in TONES);

/**
 * The toneless glyph a skin-tone variant is edited from, or null.
 *
 * Stripping the modifier from 👍🏽 gives 1f44d, which is itself a valid key.
 * Some bases need FE0F back (☝🏽 → 261d-fe0f), so the caller passes the set
 * of keys that exist and both spellings are tried.
 */
export function baseKeyOf(entry: Pick<Entry, 'codepoints'>, known: ReadonlySet<string>): string | null {
  if (tonesOf(entry).length === 0) return null;
  const stripped = entry.codepoints.filter((cp) => !(cp in TONES));
  const plain = toKey(stripped);
  if (known.has(plain)) return plain;
  const qualified = toKey([stripped[0]!, 'fe0f', ...stripped.slice(1)]);
  if (known.has(qualified)) return qualified;
  return null;
}

export interface Selection {
  only?: string[] | undefined;
  groups?: string[] | undefined;
  limit?: number | undefined;
  components?: boolean | undefined;
}

/** Compare emoji without the FE0F presentation selector, which people omit. */
const loose = (text: string) => text.replace(/\uFE0F/g, '');

/**
 * Narrow the list. `only` takes emoji characters or keys, so both
 * `--only 😀🔥` and `--only 1f600,1f525` work.
 */
export function select(entries: readonly Entry[], selection: Selection): Entry[] {
  let picked = entries.filter((e) => selection.components || e.group !== 'Component');
  if (selection.groups?.length) {
    const wanted = selection.groups.map((g) => g.toLowerCase());
    picked = picked.filter(
      (e) => wanted.includes(e.group.toLowerCase()) || wanted.includes(e.subgroup.toLowerCase()),
    );
  }
  if (selection.only?.length) {
    const keys = new Set<string>();
    for (const item of selection.only) {
      if (/^[0-9a-f]+(-[0-9a-f]+)*$/i.test(item)) keys.add(item.toLowerCase());
      else {
        // Whole graphemes, not substrings: 👍🏽 must not also pick 👍.
        const wanted = new Set(
          [...new Intl.Segmenter('en', { granularity: 'grapheme' }).segment(item)].map((g) => loose(g.segment)),
        );
        for (const e of entries) if (wanted.has(loose(e.char))) keys.add(e.key);
      }
    }
    picked = picked.filter((e) => keys.has(e.key));
  }
  if (selection.limit !== undefined) picked = picked.slice(0, selection.limit);
  return picked;
}

// ------------------------------------------------------------- the prompts

const GROUP_HINTS: Record<string, string> = {
  'Smileys & Emotion': 'A face emoji: a round glossy face; the expression carries everything, exaggerated just enough to read at small size.',
  'People & Body': 'A person or body-part emoji. People are friendly, stylised and gender-readable only when the name says so; hands are simple and clearly posed. Default (toneless) skin is the classic warm emoji yellow.',
  'Animals & Nature': 'An animal or nature emoji: charming, recognisable species, not a cartoon mascot.',
  'Food & Drink': 'A food or drink emoji: appetising, clean, a single serving.',
  'Travel & Places': 'A travel or place emoji: a small, iconic vignette or object, like a miniature model.',
  Activities: 'An activity emoji: the object or moment that names the activity.',
  Objects: 'An object emoji: the object itself, idealised, three-quarter view when that reads better.',
  Symbols: 'A symbol emoji: flat-front, badge-like, perfectly symmetrical where the symbol is, crisp geometry, correct glyphs and characters.',
  Flags: 'A flag emoji: the flag waving on a short gold pole, drawn with the correct colours, proportions and emblem for that flag. Accuracy matters more than style here.',
  Component: 'A component swatch: a simple rounded square showing only the named skin tone or hair style.',
};

/**
 * Subjects the model keeps drawing as a famous film design, whatever the
 * general originality rule says. A concrete brief that moves every signature
 * feature is what actually works. Keyed by the base codepoint, so every
 * gender and skin-tone variant inherits it.
 */
export const DESIGN_NOTES: Record<string, string> = {
  '1f9dc':
    'Design brief (merperson): dark teal or silver-white hair, a top made of coral branches and pearls, a sunset-orange-to-gold tail with small scales, a pearl circlet. Never red hair, never a purple seashell top, never a green tail, never a trident.',
  '1f9da':
    'Design brief (fairy): short dark curly hair, a violet-and-orange petal dress like a pansy, monarch-butterfly patterned wings in orange and black, holding a glowing dandelion seed instead of a wand. Never a blonde bun, never a green leaf dress, never a star wand.',
  '1f9de':
    'Design brief (genie): a tall indigo turban with a single emerald, a crimson sash, a smoky violet-to-teal wisp tail rising from a squat copper teapot-style lamp, bare arms with gold bands. Never a black topknot ponytail, never a blue vest, never a blue body.',
};

const designNoteFor = (entry: Pick<Entry, 'codepoints'>): string => DESIGN_NOTES[entry.codepoints[0]!] ?? '';

export function promptFor(entry: Entry, style: string): string {
  const hint = GROUP_HINTS[entry.group] ?? '';
  return [
    style,
    hint,
    `Match the art style of the reference images exactly when references are given: same lighting, gloss, palette handling and proportions. Do not copy their subjects.`,
    `The emoji to draw: "${entry.name}" (${entry.char}, Unicode ${entry.codepoints.join(' ').toUpperCase()}, ${entry.group} / ${entry.subgroup}).`,
    designNoteFor(entry),
  ]
    .filter(Boolean)
    .join('\n\n');
}

export function tonePromptFor(entry: Entry): string {
  const tones = tonesOf(entry).map((cp) => TONES[cp]!);
  const who =
    tones.length === 1
      ? `Change the skin of every person or hand in the image to ${tones[0]}.`
      : `There are ${tones.length} people; from left to right their skin is: ${tones.join('; ')}.`;
  return `This is one glyph of an emoji typeface: "${entry.name}", a wholesome, non-sexual, fully clothed cartoon like the emoji on every phone keyboard. ${who} Change skin only. Keep everything else identical: pose, outline, hair colour, clothing, lighting, composition, size and the fully transparent background.`;
}

// ---------------------------------------------------------------- the API

export interface ImageRequest {
  model: string;
  prompt: string;
  quality: string;
  /** Style or base images, sent as references through /v1/images/edits. */
  references: Buffer[];
}

export interface ImageResult {
  png: Buffer;
  tokens: number;
}

export type ImageCaller = (request: ImageRequest) => Promise<ImageResult>;

export class RefusedError extends Error {}

export function openaiImages(apiKey: string, fetchImpl: typeof fetch = fetch): ImageCaller {
  return async ({ model, prompt, quality, references }) => {
    let response: Response;
    if (references.length === 0) {
      response = await fetchImpl('https://api.openai.com/v1/images/generations', {
        method: 'POST',
        headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          model,
          prompt,
          quality,
          size: '1024x1024',
          background: 'transparent',
          output_format: 'png',
          n: 1,
        }),
      });
    } else {
      const form = new FormData();
      form.set('model', model);
      form.set('prompt', prompt);
      form.set('quality', quality);
      form.set('size', '1024x1024');
      form.set('background', 'transparent');
      form.set('output_format', 'png');
      references.forEach((png, index) =>
        form.append('image[]', new Blob([new Uint8Array(png)], { type: 'image/png' }), `ref-${index}.png`),
      );
      response = await fetchImpl('https://api.openai.com/v1/images/edits', {
        method: 'POST',
        headers: { authorization: `Bearer ${apiKey}` },
        body: form,
      });
    }
    const body = (await response.json().catch(() => ({}))) as {
      data?: Array<{ b64_json?: string }>;
      usage?: { total_tokens?: number };
      error?: { message?: string; code?: string };
    };
    if (!response.ok) {
      const message = body.error?.message ?? `HTTP ${response.status}`;
      if (response.status === 400 && /safety|moderation|rejected/i.test(message + (body.error?.code ?? ''))) {
        throw new RefusedError(message);
      }
      const error = new Error(message) as Error & { status?: number };
      error.status = response.status;
      throw error;
    }
    const b64 = body.data?.[0]?.b64_json;
    if (!b64) throw new Error('no image in the response');
    return { png: Buffer.from(b64, 'base64'), tokens: body.usage?.total_tokens ?? 0 };
  };
}

/** Retry rate limits and server errors with backoff; everything else is final. */
export async function withRetry<T>(
  run: () => Promise<T>,
  { attempts = 5, baseMs = 4000, sleep = (ms: number) => new Promise((r) => setTimeout(r, ms)) } = {},
): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await run();
    } catch (error) {
      const status = (error as { status?: number }).status;
      const retryable = status === undefined ? !(error instanceof RefusedError) : status === 429 || status >= 500;
      if (!retryable || attempt >= attempts) throw error;
      await sleep(baseMs * 2 ** (attempt - 1));
    }
  }
}

// --------------------------------------------------------------- the files

export interface Layout {
  root: string;
  master: string;
  png: string;
  svg: string;
  font: string;
}

export const layout = (root: string): Layout => ({
  root,
  master: join(root, 'master'),
  png: join(root, 'png'),
  svg: join(root, 'svg'),
  font: join(root, 'font'),
});

export function cacheDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(env['XDG_CACHE_HOME'] || join(homedir(), '.cache'), 'cli-tools', 'emoji');
}

/** emoji-test.txt, from the cache when it is under a week old. */
export async function loadEmojiTest(
  { refresh = false, env = process.env, fetchImpl = fetch }: { refresh?: boolean; env?: NodeJS.ProcessEnv; fetchImpl?: typeof fetch } = {},
): Promise<string> {
  const file = env['EMOJI_TEST_FILE'] || join(cacheDir(env), 'emoji-test.txt');
  if (!refresh && existsSync(file)) {
    const age = Date.now() - (await stat(file)).mtimeMs;
    if (env['EMOJI_TEST_FILE'] || age < 7 * 24 * 3600 * 1000) return readFile(file, 'utf8');
  }
  const response = await fetchImpl(EMOJI_TEST_URL);
  if (!response.ok) throw new Error(`could not fetch ${EMOJI_TEST_URL}: HTTP ${response.status}`);
  const text = await response.text();
  await mkdir(cacheDir(env), { recursive: true });
  await writeFile(join(cacheDir(env), 'emoji-test.txt'), text);
  return text;
}

/**
 * CLDR's English keywords per emoji ("lol" finds 😂), base and derived
 * annotations merged. Keyed without FE0F, the way CLDR spells most of them.
 * A failure to fetch is not fatal: the set just ships without keywords.
 */
export async function loadKeywords(
  { env = process.env, fetchImpl = fetch, log = (_: string) => {} }: { env?: NodeJS.ProcessEnv; fetchImpl?: typeof fetch; log?: (line: string) => void } = {},
): Promise<Map<string, string[]>> {
  const file = join(cacheDir(env), 'cldr-annotations-en.json');
  let merged: Record<string, string[]> | null = null;
  if (existsSync(file) && Date.now() - (await stat(file)).mtimeMs < 30 * 24 * 3600 * 1000) {
    merged = JSON.parse(await readFile(file, 'utf8'));
  } else {
    try {
      merged = {};
      for (const url of CLDR_ANNOTATIONS_URLS) {
        const response = await fetchImpl(url);
        if (!response.ok) throw new Error(`HTTP ${response.status} from ${url}`);
        const body = (await response.json()) as Record<string, { annotations?: Record<string, { default?: string[] }> }>;
        const table = Object.values(body)[0]?.annotations ?? {};
        for (const [char, value] of Object.entries(table)) {
          if (value.default?.length) merged[loose(char)] = value.default;
        }
      }
      await mkdir(cacheDir(env), { recursive: true });
      await writeFile(file, JSON.stringify(merged));
    } catch (error) {
      log(`no CLDR keywords: ${(error as Error).message}`);
      return new Map();
    }
  }
  return new Map(Object.entries(merged ?? {}));
}

/** "# Version: 17.0" from the file header. */
export const unicodeVersionOf = (text: string): string => /^# Version: (\S+)/m.exec(text)?.[1] ?? 'unknown';

// ---------------------------------------------------------- generation

export interface GenerateOptions {
  out: string;
  model: string;
  quality: string;
  style: string;
  concurrency: number;
  force: boolean;
  caller: ImageCaller;
  log: (line: string) => void;
}

export interface GenerateReport {
  drawn: string[];
  skipped: string[];
  failed: Array<{ key: string; name: string; error: string }>;
  tokens: number;
}

/**
 * Draw every master PNG that is missing.
 *
 * Order matters and is enforced: anchors first (they become everyone's
 * references), then untoned glyphs, then skin-tone variants, whose base has to
 * exist before they can be edited from it. A variant whose base failed is
 * reported, not drawn from scratch.
 */
export async function generate(
  all: readonly Entry[],
  picked: readonly Entry[],
  options: GenerateOptions,
): Promise<GenerateReport> {
  const dirs = layout(options.out);
  await mkdir(dirs.master, { recursive: true });
  const known = new Set(all.map((e) => e.key));
  const byKey = new Map(all.map((e) => [e.key, e]));
  const masterPath = (key: string) => join(dirs.master, `${key}.png`);
  const report: GenerateReport = { drawn: [], skipped: [], failed: [], tokens: 0 };

  const needs = (e: Entry) => options.force || !existsSync(masterPath(e.key));
  const todo = picked.filter((e) => {
    if (needs(e)) return true;
    report.skipped.push(e.key);
    return false;
  });

  // Anchors are drawn even when not selected: a run of just the flags still
  // needs them to be flags in this set's style.
  const anchorEntries = ANCHORS.map((k) => byKey.get(k)).filter((e): e is Entry => Boolean(e));
  const missingAnchors = anchorEntries.filter((e) => !existsSync(masterPath(e.key)) || (options.force && todo.includes(e)));
  const toned = todo.filter((e) => baseKeyOf(e, known));
  // A variant asked for without its base (`--only 👩🏾‍💻`) pulls the base in:
  // there is nothing to edit the tone of otherwise.
  const bases = [...new Set(toned.map((e) => baseKeyOf(e, known)!))]
    .filter((k) => !existsSync(masterPath(k)) && !todo.some((e) => e.key === k))
    .map((k) => byKey.get(k)!);
  const untoned = [...todo, ...bases].filter((e) => !baseKeyOf(e, known) && !ANCHORS.includes(e.key as never));

  const draw = async (entry: Entry, prompt: string, references: Buffer[]) => {
    try {
      const result = await withRetry(() =>
        options.caller({ model: options.model, prompt, quality: options.quality, references }),
      );
      await writeFile(masterPath(entry.key), result.png);
      report.drawn.push(entry.key);
      report.tokens += result.tokens;
      // Appended as each glyph lands, so a killed run still records what it paid for.
      await writeFile(
        join(options.out, 'prompts.jsonl'),
        `${JSON.stringify({ key: entry.key, name: entry.name, references: references.length, prompt })}\n`,
        { flag: 'a' },
      );
      options.log(`drew ${entry.char}  ${entry.key}  ${entry.name}`);
    } catch (error) {
      const message = (error as Error).message;
      report.failed.push({ key: entry.key, name: entry.name, error: message });
      options.log(`FAILED ${entry.key} ${entry.name}: ${message}`);
    }
  };

  // 1. Anchors: the first draws blind, the rest see the ones already drawn.
  for (const entry of missingAnchors) {
    const refs = await anchorImages(dirs.master);
    await draw(entry, promptFor(entry, options.style), refs.slice(0, 3));
  }
  const anchors = await anchorImages(dirs.master);

  // 2. Everything without a skin tone, against the anchors.
  await pool(untoned, options.concurrency, (entry) =>
    draw(entry, promptFor(entry, options.style), pickReferences(anchors, entry)),
  );

  // 3. Skin tones, each an edit of its own base.
  await pool(toned, options.concurrency, async (entry) => {
    const base = baseKeyOf(entry, known)!;
    if (!existsSync(masterPath(base))) {
      report.failed.push({ key: entry.key, name: entry.name, error: `base ${base} has no master yet` });
      return;
    }
    await draw(entry, tonePromptFor(entry), [await readFile(masterPath(base))]);
  });

  await writeFile(join(options.out, 'style.txt'), `${options.style}\n`);
  await mergeFailures(options.out, report);
  return report;
}

async function anchorImages(masterDir: string): Promise<Buffer[]> {
  const out: Buffer[] = [];
  for (const key of ANCHORS) {
    const file = join(masterDir, `${key}.png`);
    if (existsSync(file)) out.push(await readFile(file));
  }
  return out;
}

/** Three references: enough to fix a style, few enough to keep the edit cheap. */
function pickReferences(anchors: Buffer[], entry: Entry): Buffer[] {
  if (anchors.length <= 3) return anchors;
  // Faces lean on the face anchor, everything else on the object anchors.
  const order = entry.group === 'Smileys & Emotion' ? [0, 1, 2] : [0, 4, 1];
  return order.map((i) => anchors[i]!).filter(Boolean);
}

async function mergeFailures(out: string, report: GenerateReport): Promise<void> {
  const file = join(out, 'failures.json');
  const previous: GenerateReport['failed'] = existsSync(file) ? JSON.parse(await readFile(file, 'utf8')) : [];
  const drawn = new Set(report.drawn);
  const merged = new Map(previous.filter((f) => !drawn.has(f.key)).map((f) => [f.key, f]));
  for (const f of report.failed) merged.set(f.key, f);
  await writeFile(file, `${JSON.stringify([...merged.values()], null, 2)}\n`);
}

export async function pool<T>(items: readonly T[], size: number, work: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const workers = Array.from({ length: Math.min(size, items.length) }, async () => {
    while (next < items.length) {
      const item = items[next++]!;
      await work(item);
    }
  });
  await Promise.all(workers);
}

// --------------------------------------------------------------- building

export interface BuildOptions {
  out: string;
  sizes: number[];
  svg: boolean;
  font: boolean;
  unicodeVersion: string;
  model: string;
  log: (line: string) => void;
  webpSizes?: number[];
  keywords?: Map<string, string[]>;
  run?: (command: string, args: string[], cwd?: string) => Promise<void>;
}

/** True when `derived` exists and is at least as new as `source`. */
async function fresh(derived: string, source: string): Promise<boolean> {
  if (!existsSync(derived)) return false;
  return (await stat(derived)).mtimeMs >= (await stat(source)).mtimeMs;
}

/** Everything derived from the masters: sizes, SVGs, fonts, CSS, manifest, preview. */
export async function build(all: readonly Entry[], options: BuildOptions): Promise<Manifest> {
  const dirs = layout(options.out);
  const run = options.run ?? runCommand;
  const byKey = new Map(all.map((e) => [e.key, e]));
  const masters = existsSync(dirs.master)
    ? (await readdir(dirs.master)).filter((f) => f.endsWith('.png')).map((f) => basename(f, '.png'))
    : [];
  const drawn = masters.filter((k) => byKey.has(k));
  if (drawn.length === 0) throw new Error(`no masters in ${dirs.master}; run \`emoji generate\` first`);

  const sharp = await loadSharp();
  // 512 is what the SVG trace reads, so it is always made.
  const sizes = [...new Set([...options.sizes, FONT_BITMAP, 512])].sort((a, b) => a - b);
  const webpSizes = options.webpSizes ?? [...DEFAULT_WEBP_SIZES];
  options.log(`resizing ${drawn.length} glyphs to ${sizes.join(', ')}px (webp ${webpSizes.join(', ') || 'none'})`);
  for (const size of sizes) await mkdir(join(dirs.png, String(size)), { recursive: true });
  for (const size of webpSizes) await mkdir(join(dirs.root, 'webp', String(size)), { recursive: true });
  await pool(drawn, 8, async (key) => {
    const masterFile = join(dirs.master, `${key}.png`);
    // A rebuild while generation is still running only does the new glyphs.
    const outputs = [
      ...sizes.map((size) => join(dirs.png, String(size), `${key}.png`)),
      ...webpSizes.map((size) => join(dirs.root, 'webp', String(size), `${key}.webp`)),
    ];
    if ((await Promise.all(outputs.map((file) => fresh(file, masterFile)))).every(Boolean)) return;
    const master = await readFile(masterFile);
    // Trim the transparent margin the model leaves, then centre on a square
    // canvas so every glyph shares one optical size across the set.
    const trimmed = await sharp(master).trim({ threshold: 1 }).toBuffer();
    const meta = await sharp(trimmed).metadata();
    const side = Math.ceil(Math.max(meta.width ?? 1024, meta.height ?? 1024) / 0.92);
    const square = await sharp(trimmed)
      .extend({
        top: Math.floor((side - (meta.height ?? 0)) / 2),
        bottom: Math.ceil((side - (meta.height ?? 0)) / 2),
        left: Math.floor((side - (meta.width ?? 0)) / 2),
        right: Math.ceil((side - (meta.width ?? 0)) / 2),
        background: { r: 0, g: 0, b: 0, alpha: 0 },
      })
      .png()
      .toBuffer();
    for (const size of sizes) {
      await sharp(square)
        .resize(size, size, { kernel: 'lanczos3' })
        .png({ compressionLevel: 9, palette: size <= 64 ? false : true, quality: 92 })
        .toFile(join(dirs.png, String(size), `${key}.png`));
    }
    for (const size of webpSizes) {
      await sharp(square)
        .resize(size, size, { kernel: 'lanczos3' })
        .webp({ quality: 86, alphaQuality: 90, effort: 5 })
        .toFile(join(dirs.root, 'webp', String(size), `${key}.webp`));
    }
  });

  if (options.svg) {
    options.log(`tracing ${drawn.length} SVGs`);
    await mkdir(dirs.svg, { recursive: true });
    const script = join(options.out, '.trace.py');
    await writeFile(script, TRACE_PY);
    await run('uv', ['run', '-q', '--with', 'vtracer', '--with', 'pillow', 'python', script, join(dirs.png, '512'), dirs.svg]);
    await rm(script, { force: true });
  }

  const fonts: Manifest['fonts'] = [];
  if (options.font) {
    await mkdir(dirs.font, { recursive: true });
    for (const [format, file] of [
      ['cbdt', `${FAMILY}-CBDT.ttf`],
      ['sbix', `${FAMILY}-sbix.ttf`],
    ] as const) {
      options.log(`building ${file}`);
      await buildFont(dirs, drawn, format, file, run);
      fonts.push({ format, path: `font/${file}` });
    }
  }

  const manifest = manifestFor(all, drawn, {
    ...options,
    sizes,
    webpSizes,
    fonts,
    keywords: options.keywords ?? new Map(),
  });
  await writeFile(join(options.out, 'openemoji.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  await writeFile(join(options.out, 'openemoji.css'), cssFor(manifest));
  await writeFile(join(options.out, 'index.html'), previewFor(manifest));
  return manifest;
}

async function buildFont(
  dirs: Layout,
  keys: string[],
  format: 'cbdt' | 'sbix',
  file: string,
  run: NonNullable<BuildOptions['run']>,
): Promise<void> {
  // nanoemoji reads SVGs named emoji_u<cp>_<cp>.svg and turns the name into
  // the cmap entry or ligature. Each SVG only wraps the 136px PNG, so the
  // bitmap in the font is the model's own pixels, not a re-trace.
  const work = join(dirs.font, `.${format}`);
  await rm(work, { recursive: true, force: true });
  await mkdir(work, { recursive: true });
  const files: string[] = [];
  for (const key of keys) {
    const png = await readFile(join(dirs.png, String(FONT_BITMAP), `${key}.png`));
    const name = `emoji_u${key.replace(/-/g, '_')}.svg`;
    await writeFile(
      join(work, name),
      `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 ${FONT_BITMAP} ${FONT_BITMAP}"><image width="${FONT_BITMAP}" height="${FONT_BITMAP}" xlink:href="data:image/png;base64,${png.toString('base64')}"/></svg>`,
    );
    files.push(name);
  }
  await writeFile(join(work, 'files.txt'), files.join('\n'));
  await run(
    'uv',
    [
      'tool', 'run', '-q', 'nanoemoji',
      '--color_format', format,
      '--family', FAMILY,
      '--bitmap_resolution', String(FONT_BITMAP),
      '--output_file', file,
      ...files,
    ],
    work,
  );
  const built = join(work, 'build', file);
  await writeFile(join(dirs.font, file), await readFile(built));
  await rm(work, { recursive: true, force: true });
}

/**
 * Trace each 512px PNG into a posterised vector: flat colour steps where the
 * master has gradients. Tuned on the octopus and the mountain, the two worst
 * cases in the sample set: at 320px, 5-bit colour and a 20-level layer step
 * a glyph is 35-120 KB and reads the same as at 384px/6-bit, which is twice
 * the size. The PNGs and the fonts carry the real artwork. Semi-transparent edge pixels are the enemy of a
 * colour trace (they come out as dark rims), so alpha is thresholded first and
 * the edge colours are flattened onto the opaque pixels.
 */
const TRACE_PY = `import sys, os, vtracer
from PIL import Image
src, dst = sys.argv[1], sys.argv[2]
for name in sorted(os.listdir(src)):
    if not name.endswith('.png'): continue
    out = os.path.join(dst, name[:-4] + '.svg')
    if os.path.exists(out) and os.path.getmtime(out) >= os.path.getmtime(os.path.join(src, name)): continue
    im = Image.open(os.path.join(src, name)).convert('RGBA').resize((320, 320), Image.LANCZOS)
    a = im.getchannel('A').point(lambda v: 255 if v >= 128 else 0)
    im.putalpha(a)
    tmp = out + '.png'
    im.save(tmp)
    vtracer.convert_image_to_svg_py(tmp, out, colormode='color', hierarchical='stacked', mode='spline',
        filter_speckle=8, color_precision=5, layer_difference=20, corner_threshold=60,
        length_threshold=4.0, max_iterations=10, splice_threshold=45, path_precision=1)
    os.remove(tmp)
    svg = open(out).read().replace('width="320" height="320"', 'viewBox="0 0 320 320" width="320" height="320"', 1)
    open(out, 'w').write(svg)
`;

// --------------------------------------------------------------- manifest

export interface Manifest {
  openemoji: string;
  name: string;
  version: string;
  license: string;
  unicode: string;
  made_by: 'ai';
  disclosure: 'ai-generated';
  ai_model: string;
  ai_provider: string;
  ai_prompt_url: string;
  sizes: number[];
  webp_sizes: number[];
  formats: string[];
  fonts: Array<{ format: string; path: string }>;
  css: string;
  coverage: { total: number; drawn: number; missing: string[] };
  emoji: Array<{
    key: string;
    char: string;
    name: string;
    group: string;
    subgroup: string;
    unicode: string;
    keywords?: string[];
    /** The set's own names (rule 3): `oe_` and the CLDR name, tones as _t1…_t5. */
    shortcodes?: string[];
    base?: string;
    /** Present only when the glyph is drawn: an entry without files is listed, not drawn. */
    svg?: string;
    png?: string;
    webp?: string;
  }>;
}

export function manifestFor(
  all: readonly Entry[],
  drawn: readonly string[],
  options: {
    sizes: number[];
    webpSizes?: number[];
    svg: boolean;
    fonts: Manifest['fonts'];
    unicodeVersion: string;
    model: string;
    keywords?: Map<string, string[]>;
  },
): Manifest {
  const have = new Set(drawn);
  const known = new Set(all.map((e) => e.key));
  const standard = all.filter((e) => e.group !== 'Component');
  return {
    openemoji: SPEC_VERSION,
    name: FAMILY,
    version: new Date().toISOString().slice(0, 10),
    license: 'CC-BY-4.0',
    unicode: options.unicodeVersion,
    made_by: 'ai',
    disclosure: 'ai-generated',
    ai_model: options.model,
    ai_provider: 'OpenAI',
    ai_prompt_url: 'style.txt',
    sizes: options.sizes,
    webp_sizes: options.webpSizes ?? [],
    formats: [
      'png',
      ...(options.webpSizes?.length ? ['webp'] : []),
      ...(options.svg ? ['svg'] : []),
      ...options.fonts.map((f) => f.format),
    ],
    fonts: options.fonts,
    css: 'openemoji.css',
    coverage: {
      total: standard.length,
      drawn: standard.filter((e) => have.has(e.key)).length,
      missing: standard.filter((e) => !have.has(e.key)).map((e) => e.key),
    },
    // Every emoji Unicode lists, drawn or not, so a catalog can show the
    // whole set and what is still to come. Files mark the drawn ones.
    emoji: all.map((e) => {
      const keywords = options.keywords?.get(loose(e.char));
      const drawnHere = have.has(e.key);
      return {
        key: e.key,
        char: e.char,
        name: e.name,
        group: e.group,
        subgroup: e.subgroup,
        unicode: e.version,
        ...(keywords?.length ? { keywords } : {}),
        shortcodes: [shortcodeOf(e.name)],
        ...(baseKeyOf(e, known) ? { base: baseKeyOf(e, known)! } : {}),
        ...(drawnHere && options.svg ? { svg: `svg/${e.key}.svg` } : {}),
        ...(drawnHere ? { png: `png/{size}/${e.key}.png` } : {}),
        ...(drawnHere && options.webpSizes?.length ? { webp: `webp/{size}/${e.key}.webp` } : {}),
      };
    }),
  };
}

export function cssFor(manifest: Manifest): string {
  const src = manifest.fonts
    .map((f) => `url("${f.path}") format("truetype")`)
    .join(',\n       ');
  return `/* ${manifest.name} ${manifest.version}: OpenEmoji ${manifest.openemoji}, Unicode ${manifest.unicode}. */
@font-face {
  font-family: "${manifest.name}";
  src: ${src || 'local("Apple Color Emoji")'};
  font-display: swap;
}
.openemoji { font-family: "${manifest.name}", "Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", sans-serif; }
img.openemoji { width: 1.2em; height: 1.2em; vertical-align: -0.2em; margin: 0 0.05em; }
`;
}

const escapeHtml = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

export function previewFor(manifest: Manifest): string {
  const groups = new Map<string, Manifest['emoji']>();
  for (const e of manifest.emoji.filter((x) => x.png)) groups.set(e.group, [...(groups.get(e.group) ?? []), e]);
  const size = manifest.sizes.includes(128) ? 128 : manifest.sizes[manifest.sizes.length - 1]!;
  const sections = [...groups]
    .map(
      ([group, list]) =>
        `<h2>${escapeHtml(group)} <small>${list.length}</small></h2>\n<div class="grid">${list
          .map(
            (e) =>
              `<figure><img class="openemoji" src="png/${size}/${e.key}.png" alt="${escapeHtml(e.char)}" title="${escapeHtml(e.name)}" loading="lazy"><figcaption>${escapeHtml(e.name)}</figcaption></figure>`,
          )
          .join('')}</div>`,
    )
    .join('\n');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${manifest.name} preview</title>
<style>
:root{--bg:#f6f2ea;--ink:#1d1b18;--muted:#6b645a;--card:#fffdf8}
@media (prefers-color-scheme:dark){:root{--bg:#141311;--ink:#f2ede4;--muted:#a39b8f;--card:#1d1b18}}
body{margin:0;padding:24px 16px;background:var(--bg);color:var(--ink);font:15px/1.4 system-ui,sans-serif}
h1{font:600 28px/1.2 Georgia,serif;margin:0 0 4px}p{color:var(--muted);margin:0 0 24px}
h2{font:600 18px Georgia,serif;margin:32px 0 12px}small{color:var(--muted);font-weight:400}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(96px,1fr));gap:8px}
figure{margin:0;padding:10px 6px;background:var(--card);border-radius:12px;text-align:center}
figure img{width:64px;height:64px}figcaption{font-size:11px;color:var(--muted);margin-top:4px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
</style></head><body>
<h1>${manifest.name}</h1>
<p>${manifest.coverage.drawn} of ${manifest.coverage.total} emoji, Unicode ${manifest.unicode}. Drawn by ${escapeHtml(manifest.ai_model)}. OpenEmoji ${manifest.openemoji}.</p>
${sections}
</body></html>
`;
}

// --------------------------------------------------------------- helpers

type Sharp = typeof import('sharp').default;

async function loadSharp(): Promise<Sharp> {
  try {
    return (await import('sharp')).default;
  } catch {
    throw new Error('sharp is not installed; run `pnpm install` in the cli-tools checkout');
  }
}

export function runCommand(command: string, args: string[], cwd?: string): Promise<void> {
  return new Promise((resolve, reject) => {
    // nanoemoji and uv log every step to stderr. Keep it, and show it only
    // when the step fails, so a normal build prints one line per stage.
    const child = spawn(command, args, { cwd, stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-8000);
    });
    child.on('error', (error) =>
      reject(
        (error as NodeJS.ErrnoException).code === 'ENOENT'
          ? new Error(`${command} is not on PATH; install uv (https://docs.astral.sh/uv/) or pass --no-svg --no-font`)
          : error,
      ),
    );
    child.on('exit', (code) =>
      code === 0 ? resolve() : reject(new Error(`${command} ${args.slice(0, 4).join(' ')} exited ${code}\n${stderr}`)),
    );
  });
}
