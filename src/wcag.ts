/**
 * wcag — the automated half of a WCAG-EM evaluation, from the terminal.
 *
 * The W3C's WCAG-EM Report Tool (w3.org/WAI/eval/report-tool) is a web app
 * with no command line and no headless mode: it is a form for the five steps
 * of the Website Accessibility Conformance Evaluation Methodology, and the
 * reason it cannot be a CLI is that most success criteria need a person to
 * decide them. What a machine can do is the part that is machine-shaped:
 * choose the structured sample (step 3), load every page in a real browser,
 * run axe-core over it, and turn what axe found into assertions the tool
 * already understands (step 4) — so an evaluator opens the tool with the
 * sample and the automated failures filled in, and starts at the judgement
 * calls rather than at an empty form.
 *
 * Three decisions shape this file:
 *
 * - **The browser is driven over CDP by hand.** Puppeteer and Playwright each
 *   bring a download of Chrome and a few megabytes of driver to do what this
 *   needs: open a page, wait for load, evaluate two scripts. Node 22 has a
 *   WebSocket, Chrome prints its DevTools URL on stderr, and the six protocol
 *   methods used here are stable. The box's own Chrome is found rather than
 *   fetched; the finder says where it looked when there is none.
 * - **A pass is never asserted.** axe can prove a failure — an image with no
 *   alternative fails 1.1.1 wherever it is — but "no rule fired" proves
 *   nothing about the criterion as a whole, since its rules cover a part of
 *   each one. So a criterion with only passing checks lands in the tool as
 *   "cannot tell" with the checks listed, and "passed" is left for a person.
 *   The terminal summary shows the passes separately, because they are still
 *   useful to see.
 * - **The evaluation file mirrors the tool's own export**, read from its
 *   source (src/stores/evaluationStore.js, src/data/jsonld/appContext.js) —
 *   the JSON-LD context, the `Evaluation` type, `defineScope` through
 *   `reportFindings`, a `Webpage` subject per sampled page whose id is its
 *   URL, and an `Assertion` per page and criterion with `test` set to the
 *   tool's own criterion ids (`WCAG22:non-text-content`). A file of that
 *   shape goes through the tool's "Open evaluation" rather than the beta
 *   assertion import, which is the path that restores the sample as well.
 */

import { type ChildProcess, spawn } from 'node:child_process';
import { accessSync, constants, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

import { table } from './format.ts';

export class WcagError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WcagError';
  }
}

// ---------------------------------------------------------------------------
// Success criteria
// ---------------------------------------------------------------------------

export type Level = 'A' | 'AA' | 'AAA';
export type WcagVersion = '2.1' | '2.2';

export const LEVELS: readonly Level[] = ['A', 'AA', 'AAA'];
export const WCAG_VERSIONS: readonly WcagVersion[] = ['2.1', '2.2'];
export const DEFAULT_LEVEL: Level = 'AA';
export const DEFAULT_VERSION: WcagVersion = '2.2';

export interface Criterion {
  /** `1.4.3` */
  num: string;
  title: string;
  level: Level;
  /**
   * The id the report tool uses for the criterion, `contrast-minimum`. These
   * are the fragment ids of the WCAG 2.x specification, which is why they
   * differ between versions for 2.5.5 and why 2.0's are not carried at all.
   */
  id: string;
  /** Which versions carry the criterion. 4.1.1 was removed in 2.2. */
  versions: readonly WcagVersion[];
  /** The 2.1 id, where it is not the 2.2 one. */
  id21?: string;
}

const BOTH: readonly WcagVersion[] = ['2.1', '2.2'];
const ONLY_22: readonly WcagVersion[] = ['2.2'];
const ONLY_21: readonly WcagVersion[] = ['2.1'];

const c = (
  num: string,
  title: string,
  level: Level,
  id: string,
  versions: readonly WcagVersion[] = BOTH,
  id21?: string,
): Criterion => (id21 ? { num, title, level, id, versions, id21 } : { num, title, level, id, versions });

/**
 * WCAG 2.1 and 2.2, as the report tool numbers and names them
 * (src/data/wcag.json and src/locales/en/WCAG.json in its repository).
 */
export const CRITERIA: readonly Criterion[] = [
  c('1.1.1', 'Non-text Content', 'A', 'non-text-content'),
  c('1.2.1', 'Audio-only and Video-only (Prerecorded)', 'A', 'audio-only-and-video-only-prerecorded'),
  c('1.2.2', 'Captions (Prerecorded)', 'A', 'captions-prerecorded'),
  c('1.2.3', 'Audio Description or Media Alternative (Prerecorded)', 'A', 'audio-description-or-media-alternative-prerecorded'),
  c('1.2.4', 'Captions (Live)', 'AA', 'captions-live'),
  c('1.2.5', 'Audio Description (Prerecorded)', 'AA', 'audio-description-prerecorded'),
  c('1.2.6', 'Sign Language (Prerecorded)', 'AAA', 'sign-language-prerecorded'),
  c('1.2.7', 'Extended Audio Description (Prerecorded)', 'AAA', 'extended-audio-description-prerecorded'),
  c('1.2.8', 'Media Alternative (Prerecorded)', 'AAA', 'media-alternative-prerecorded'),
  c('1.2.9', 'Audio-only (Live)', 'AAA', 'audio-only-live'),
  c('1.3.1', 'Info and Relationships', 'A', 'info-and-relationships'),
  c('1.3.2', 'Meaningful Sequence', 'A', 'meaningful-sequence'),
  c('1.3.3', 'Sensory Characteristics', 'A', 'sensory-characteristics'),
  c('1.3.4', 'Orientation', 'AA', 'orientation'),
  c('1.3.5', 'Identify Input Purpose', 'AA', 'identify-input-purpose'),
  c('1.3.6', 'Identify Purpose', 'AAA', 'identify-purpose'),
  c('1.4.1', 'Use of Color', 'A', 'use-of-color'),
  c('1.4.2', 'Audio Control', 'A', 'audio-control'),
  c('1.4.3', 'Contrast (Minimum)', 'AA', 'contrast-minimum'),
  c('1.4.4', 'Resize text', 'AA', 'resize-text'),
  c('1.4.5', 'Images of Text', 'AA', 'images-of-text'),
  c('1.4.6', 'Contrast (Enhanced)', 'AAA', 'contrast-enhanced'),
  c('1.4.7', 'Low or No Background Audio', 'AAA', 'low-or-no-background-audio'),
  c('1.4.8', 'Visual Presentation', 'AAA', 'visual-presentation'),
  c('1.4.9', 'Images of Text (No Exception)', 'AAA', 'images-of-text-no-exception'),
  c('1.4.10', 'Reflow', 'AA', 'reflow'),
  c('1.4.11', 'Non-text Contrast', 'AA', 'non-text-contrast'),
  c('1.4.12', 'Text Spacing', 'AA', 'text-spacing'),
  c('1.4.13', 'Content on Hover or Focus', 'AA', 'content-on-hover-or-focus'),
  c('2.1.1', 'Keyboard', 'A', 'keyboard'),
  c('2.1.2', 'No Keyboard Trap', 'A', 'no-keyboard-trap'),
  c('2.1.3', 'Keyboard (No Exception)', 'AAA', 'keyboard-no-exception'),
  c('2.1.4', 'Character Key Shortcuts', 'A', 'character-key-shortcuts'),
  c('2.2.1', 'Timing Adjustable', 'A', 'timing-adjustable'),
  c('2.2.2', 'Pause, Stop, Hide', 'A', 'pause-stop-hide'),
  c('2.2.3', 'No Timing', 'AAA', 'no-timing'),
  c('2.2.4', 'Interruptions', 'AAA', 'interruptions'),
  c('2.2.5', 'Re-authenticating', 'AAA', 're-authenticating'),
  c('2.2.6', 'Timeouts', 'AAA', 'timeouts'),
  c('2.3.1', 'Three Flashes or Below Threshold', 'A', 'three-flashes-or-below-threshold'),
  c('2.3.2', 'Three Flashes', 'AAA', 'three-flashes'),
  c('2.3.3', 'Animation from Interactions', 'AAA', 'animation-from-interactions'),
  c('2.4.1', 'Bypass Blocks', 'A', 'bypass-blocks'),
  c('2.4.2', 'Page Titled', 'A', 'page-titled'),
  c('2.4.3', 'Focus Order', 'A', 'focus-order'),
  c('2.4.4', 'Link Purpose (In Context)', 'A', 'link-purpose-in-context'),
  c('2.4.5', 'Multiple Ways', 'AA', 'multiple-ways'),
  c('2.4.6', 'Headings and Labels', 'AA', 'headings-and-labels'),
  c('2.4.7', 'Focus Visible', 'AA', 'focus-visible'),
  c('2.4.8', 'Location', 'AAA', 'location'),
  c('2.4.9', 'Link Purpose (Link Only)', 'AAA', 'link-purpose-link-only'),
  c('2.4.10', 'Section Headings', 'AAA', 'section-headings'),
  c('2.4.11', 'Focus Not Obscured (Minimum)', 'AA', 'focus-not-obscured-minimum', ONLY_22),
  c('2.4.12', 'Focus Not Obscured (Enhanced)', 'AAA', 'focus-not-obscured-enhanced', ONLY_22),
  c('2.4.13', 'Focus Appearance', 'AAA', 'focus-appearance', ONLY_22),
  c('2.5.1', 'Pointer Gestures', 'A', 'pointer-gestures'),
  c('2.5.2', 'Pointer Cancellation', 'A', 'pointer-cancellation'),
  c('2.5.3', 'Label in Name', 'A', 'label-in-name'),
  c('2.5.4', 'Motion Actuation', 'A', 'motion-actuation'),
  c('2.5.5', 'Target Size (Enhanced)', 'AAA', 'target-size-enhanced', BOTH, 'target-size'),
  c('2.5.6', 'Concurrent Input Mechanisms', 'AAA', 'concurrent-input-mechanisms'),
  c('2.5.7', 'Dragging Movements', 'AA', 'dragging-movements', ONLY_22),
  c('2.5.8', 'Target Size (Minimum)', 'AA', 'target-size-minimum', ONLY_22),
  c('3.1.1', 'Language of Page', 'A', 'language-of-page'),
  c('3.1.2', 'Language of Parts', 'AA', 'language-of-parts'),
  c('3.1.3', 'Unusual Words', 'AAA', 'unusual-words'),
  c('3.1.4', 'Abbreviations', 'AAA', 'abbreviations'),
  c('3.1.5', 'Reading Level', 'AAA', 'reading-level'),
  c('3.1.6', 'Pronunciation', 'AAA', 'pronunciation'),
  c('3.2.1', 'On Focus', 'A', 'on-focus'),
  c('3.2.2', 'On Input', 'A', 'on-input'),
  c('3.2.3', 'Consistent Navigation', 'AA', 'consistent-navigation'),
  c('3.2.4', 'Consistent Identification', 'AA', 'consistent-identification'),
  c('3.2.5', 'Change on Request', 'AAA', 'change-on-request'),
  c('3.2.6', 'Consistent Help', 'A', 'consistent-help', ONLY_22),
  c('3.3.1', 'Error Identification', 'A', 'error-identification'),
  c('3.3.2', 'Labels or Instructions', 'A', 'labels-or-instructions'),
  c('3.3.3', 'Error Suggestion', 'AA', 'error-suggestion'),
  c('3.3.4', 'Error Prevention (Legal, Financial, Data)', 'AA', 'error-prevention-legal-financial-data'),
  c('3.3.5', 'Help', 'AAA', 'help'),
  c('3.3.6', 'Error Prevention (All)', 'AAA', 'error-prevention-all'),
  c('3.3.7', 'Redundant Entry', 'A', 'redundant-entry', ONLY_22),
  c('3.3.8', 'Accessible Authentication (Minimum)', 'AA', 'accessible-authentication-minimum', ONLY_22),
  c('3.3.9', 'Accessible Authentication (Enhanced)', 'AAA', 'accessible-authentication-enhanced', ONLY_22),
  c('4.1.1', 'Parsing', 'A', 'parsing', ONLY_21),
  c('4.1.2', 'Name, Role, Value', 'A', 'name-role-value'),
  c('4.1.3', 'Status Messages', 'AA', 'status-messages'),
];

const BY_NUM = new Map(CRITERIA.map((criterion) => [criterion.num, criterion]));

export function criterion(num: string): Criterion | undefined {
  return BY_NUM.get(num);
}

/** The criteria a version carries, in specification order. */
export function criteriaFor(version: WcagVersion): Criterion[] {
  return CRITERIA.filter((criterion) => criterion.versions.includes(version));
}

/** The report tool's id for a criterion under a version: `WCAG22:contrast-minimum`. */
export function criterionId(criterion: Criterion, version: WcagVersion): string {
  const id = version === '2.1' && criterion.id21 ? criterion.id21 : criterion.id;
  return `WCAG${version.replace('.', '')}:${id}`;
}

const LEVEL_RANK: Record<Level, number> = { A: 1, AA: 2, AAA: 3 };

/** Is a criterion of `level` inside a conformance target? AA includes A. */
export function withinTarget(level: Level, target: Level): boolean {
  return LEVEL_RANK[level] <= LEVEL_RANK[target];
}

export function isLevel(value: string): value is Level {
  return (LEVELS as readonly string[]).includes(value);
}

export function isWcagVersion(value: string): value is WcagVersion {
  return (WCAG_VERSIONS as readonly string[]).includes(value);
}

/** `1.4.3` sorts before `1.4.10`, which a string sort gets wrong. */
export function compareNums(a: string, b: string): number {
  const left = a.split('.').map(Number);
  const right = b.split('.').map(Number);
  for (let index = 0; index < 3; index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

// ---------------------------------------------------------------------------
// axe tags
// ---------------------------------------------------------------------------

/**
 * The success criterion an axe tag names, or null.
 *
 * axe tags a rule `wcag143` for 1.4.3 and `wcag1412` for 1.4.12: principle,
 * guideline, criterion, with no separators. The split is unambiguous because
 * WCAG has four principles and no guideline past 5, so the first two digits
 * are always one each and whatever follows is the criterion.
 */
export function criterionFromTag(tag: string): string | null {
  const match = /^wcag([1-4])([1-5])(\d{1,2})$/.exec(tag);
  if (!match) return null;
  const num = `${match[1]}.${match[2]}.${Number(match[3])}`;
  return BY_NUM.has(num) ? num : null;
}

/** The criteria a rule's tags name, in specification order. */
export function criteriaFromTags(tags: readonly string[]): string[] {
  const nums = new Set<string>();
  for (const tag of tags) {
    const num = criterionFromTag(tag);
    if (num) nums.add(num);
  }
  return [...nums].sort(compareNums);
}

/**
 * The axe tags that select the rules for a conformance target.
 *
 * axe files each rule under the version that introduced its criterion, so a
 * 2.2 AA run wants the 2.0, 2.1 and 2.2 tags at A and AA. Best practices are
 * left out on purpose: they are not success criteria and cannot fail one.
 */
export function axeTags(version: WcagVersion, level: Level): string[] {
  const versions = version === '2.1' ? ['2', '21'] : ['2', '21', '22'];
  const levels = LEVELS.filter((candidate) => withinTarget(candidate, level));
  const tags: string[] = [];
  for (const prefix of versions) {
    for (const suffix of levels) {
      tags.push(`wcag${prefix}${suffix.toLowerCase()}`);
    }
  }
  return tags;
}

// ---------------------------------------------------------------------------
// The sample (WCAG-EM step 3)
// ---------------------------------------------------------------------------

export type SampleMethod = 'auto' | 'sitemap' | 'links' | 'list';
export const SAMPLE_METHODS: readonly SampleMethod[] = ['auto', 'sitemap', 'links', 'list'];

export function isSampleMethod(value: string): value is SampleMethod {
  return (SAMPLE_METHODS as readonly string[]).includes(value);
}

const decodeXml = (value: string): string =>
  value
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .trim();

export interface Sitemap {
  /** Page URLs, from `<url><loc>`. */
  urls: string[];
  /** Child sitemaps, from `<sitemap><loc>` in an index. */
  sitemaps: string[];
}

/** Read a sitemap or a sitemap index. Anything else yields nothing, not an error. */
export function parseSitemap(xml: string): Sitemap {
  const urls: string[] = [];
  const sitemaps: string[] = [];
  const entries = /<(url|sitemap)\b[^>]*>([\s\S]*?)<\/\1>/g;
  let entry: RegExpExecArray | null;
  while ((entry = entries.exec(xml)) !== null) {
    const loc = /<loc\b[^>]*>([\s\S]*?)<\/loc>/.exec(entry[2] ?? '');
    if (!loc?.[1]) continue;
    (entry[1] === 'sitemap' ? sitemaps : urls).push(decodeXml(loc[1]));
  }
  return { urls, sitemaps };
}

/** The sitemaps a robots.txt declares. */
export function sitemapsFromRobots(robots: string): string[] {
  return robots
    .split(/\r?\n/)
    .map((line) => /^\s*sitemap\s*:\s*(\S+)/i.exec(line)?.[1])
    .filter((url): url is string => Boolean(url));
}

/** Files that are not pages, by extension. A PDF has its own evaluation. */
const NOT_A_PAGE =
  /\.(pdf|jpe?g|png|gif|svg|webp|avif|ico|zip|gz|tar|mp3|mp4|webm|ogg|wav|css|js|mjs|json|xml|rss|atom|txt|woff2?|ttf|eot|csv|docx?|xlsx?|pptx?)$/i;

/**
 * The page's own URL with what makes two spellings the same page removed:
 * the fragment, a default port, `index.html`, a trailing slash.
 */
export function normalizeUrl(value: string): string | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  url.hash = '';
  url.pathname = url.pathname.replace(/\/index\.html?$/i, '/');
  if (url.pathname.length > 1) url.pathname = url.pathname.replace(/\/+$/, '');
  return url.href;
}

/**
 * Same-origin links on a page, absolute, deduplicated, in document order.
 *
 * A regular expression rather than a parser: the input is untrusted HTML and
 * the question is only "which hrefs are here", which a DOM would answer with
 * the same list at the cost of a dependency.
 */
export function sameOriginLinks(html: string, base: string): string[] {
  const origin = new URL(base).origin;
  const seen = new Set<string>();
  const links: string[] = [];
  const hrefs = /<a\b[^>]*?\shref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi;
  let match: RegExpExecArray | null;
  while ((match = hrefs.exec(html)) !== null) {
    const raw = decodeXml(match[1] ?? match[2] ?? match[3] ?? '');
    if (!raw || raw.startsWith('#')) continue;
    let resolved: string | null;
    try {
      resolved = normalizeUrl(new URL(raw, base).href);
    } catch {
      continue;
    }
    if (!resolved || new URL(resolved).origin !== origin) continue;
    if (NOT_A_PAGE.test(new URL(resolved).pathname)) continue;
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    links.push(resolved);
  }
  return links;
}

/**
 * Pick the structured sample.
 *
 * WCAG-EM wants pages that differ — the home page, one of each template, the
 * forms, the odd one out — not the first N a crawler happened to list, which
 * on most sites is N posts from one archive. So after the start page and any
 * URLs named by hand, candidates are grouped by their first path segment and
 * taken one group at a time, round-robin, until the limit. A blog with
 * `/posts/…`, `/about`, `/pricing` and `/docs/…` yields one of each before a
 * second post.
 */
export function chooseSample(
  start: string,
  candidates: readonly string[],
  limit: number,
  extra: readonly string[] = [],
): string[] {
  const chosen: string[] = [];
  const seen = new Set<string>();
  const take = (url: string): boolean => {
    const key = normalizeUrl(url);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    chosen.push(key);
    return true;
  };

  take(start);
  for (const url of extra) {
    if (chosen.length >= limit) return chosen;
    take(url);
  }

  const groups = new Map<string, string[]>();
  for (const url of candidates) {
    const key = normalizeUrl(url);
    if (!key || seen.has(key)) continue;
    const segment = new URL(key).pathname.split('/')[1] ?? '';
    const group = groups.get(segment) ?? [];
    group.push(key);
    groups.set(segment, group);
  }

  const queues = [...groups.values()];
  while (chosen.length < limit && queues.some((queue) => queue.length > 0)) {
    for (const queue of queues) {
      if (chosen.length >= limit) break;
      const next = queue.shift();
      if (next !== undefined) take(next);
    }
  }
  return chosen;
}

export type FetchText = (url: string) => Promise<string | null>;

/** Fetch a text resource, or null on any failure: a missing sitemap is not an error. */
export async function fetchText(url: string, timeoutMs = 15_000): Promise<string | null> {
  try {
    const response = await fetch(url, {
      headers: { 'user-agent': USER_AGENT, accept: 'text/html,application/xml,text/xml,text/plain;q=0.9,*/*;q=0.5' },
      signal: AbortSignal.timeout(timeoutMs),
      redirect: 'follow',
    });
    if (!response.ok) return null;
    return await response.text();
  } catch {
    return null;
  }
}

export interface SampleResult {
  pages: string[];
  /** Where the candidates came from. */
  from: 'sitemap' | 'links' | 'list' | 'start';
  /** How many candidate pages the site offered before the limit. */
  candidates: number;
}

const MAX_SITEMAPS = 8;
const MAX_CANDIDATES = 5000;

/**
 * Find the pages to audit.
 *
 * `sitemap` reads /sitemap.xml (and the ones robots.txt names), following an
 * index into its first few children; `links` reads the start page's own
 * same-origin links; `auto` tries the sitemap and falls back to links when it
 * yields fewer pages than asked for; `list` audits only the start page and
 * the URLs given by hand.
 */
export async function discoverSample(
  start: string,
  options: { pages: number; method: SampleMethod; extra?: readonly string[]; fetch?: FetchText },
): Promise<SampleResult> {
  const { pages, method, extra = [], fetch: get = fetchText } = options;
  const origin = new URL(start).origin;

  if (method === 'list') {
    const chosen = chooseSample(start, [], pages, extra);
    return { pages: chosen, from: extra.length > 0 ? 'list' : 'start', candidates: chosen.length };
  }

  let candidates: string[] = [];
  let from: SampleResult['from'] = 'start';

  if (method === 'sitemap' || method === 'auto') {
    const roots = [`${origin}/sitemap.xml`];
    const robots = await get(`${origin}/robots.txt`);
    if (robots) {
      for (const url of sitemapsFromRobots(robots)) {
        if (!roots.includes(url)) roots.push(url);
      }
    }
    const queue = roots.slice(0, MAX_SITEMAPS);
    const visited = new Set<string>();
    while (queue.length > 0 && candidates.length < MAX_CANDIDATES && visited.size < MAX_SITEMAPS) {
      const url = queue.shift();
      if (url === undefined || visited.has(url)) continue;
      visited.add(url);
      const xml = await get(url);
      if (!xml) continue;
      const sitemap = parseSitemap(xml);
      candidates.push(...sitemap.urls.filter((page) => page.startsWith(origin) && !NOT_A_PAGE.test(page)));
      queue.push(...sitemap.sitemaps);
    }
    if (candidates.length > 0) from = 'sitemap';
  }

  if (method === 'links' || (method === 'auto' && candidates.length + 1 + extra.length < pages)) {
    const html = await get(start);
    if (html) {
      const links = sameOriginLinks(html, start);
      if (links.length > 0) {
        candidates = candidates.concat(links);
        if (from === 'start') from = 'links';
      }
    }
  }

  return { pages: chooseSample(start, candidates, pages, extra), from, candidates: candidates.length };
}

// ---------------------------------------------------------------------------
// The browser
// ---------------------------------------------------------------------------

export const USER_AGENT = 'Mozilla/5.0 (X11; Linux x86_64) cli-tools/wcag (+https://github.com/profullstack/cli-tools)';

/** Where the box keeps a Chrome that Chrome's own libraries are not installed for. */
const CHROME_DEPS = join(homedir(), '.local', 'share', 'chrome-deps');

const isExecutable = (path: string): boolean => {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

const listDir = (path: string): string[] => {
  try {
    return readdirSync(path);
  } catch {
    return [];
  }
};

/** `linux-152.0.7977.42` after `linux-131.0.6778.204`: newest first by version, not by string. */
const byVersionDesc = (a: string, b: string): number => {
  const parse = (name: string): number[] => (/(\d+(?:\.\d+)*)/.exec(name)?.[1] ?? '0').split('.').map(Number);
  const left = parse(a);
  const right = parse(b);
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const difference = (right[index] ?? 0) - (left[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
};

/**
 * Every place a Chrome might be, in the order they are tried.
 *
 * `CHROME_PATH` first, because it is the one the caller chose. Then the names
 * a package manager installs, then the caches Puppeteer and Playwright keep
 * (newest build first), then the macOS bundle. A headless shell is a real
 * Chrome for this purpose — it is what axe needs, a DOM and a renderer.
 */
export function chromeCandidates(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string[] {
  const candidates: string[] = [];
  if (env.CHROME_PATH) candidates.push(env.CHROME_PATH);

  for (const name of ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'chrome', 'chrome-headless-shell']) {
    for (const dir of (env.PATH ?? '').split(':').filter(Boolean)) {
      candidates.push(join(dir, name));
    }
  }
  candidates.push('/opt/google/chrome/chrome');

  const puppeteer = join(home, '.cache', 'puppeteer');
  for (const flavour of ['chrome', 'chrome-headless-shell']) {
    for (const build of listDir(join(puppeteer, flavour)).sort(byVersionDesc)) {
      const dir = join(puppeteer, flavour, build);
      const inner = listDir(dir).find((entry) => entry.startsWith(flavour));
      if (inner) candidates.push(join(dir, inner, flavour));
    }
  }

  const playwright = join(home, '.cache', 'ms-playwright');
  for (const build of listDir(playwright).sort(byVersionDesc)) {
    if (build.startsWith('chromium_headless_shell-')) candidates.push(join(playwright, build, 'chrome-linux', 'headless_shell'));
    else if (build.startsWith('chromium-')) candidates.push(join(playwright, build, 'chrome-linux', 'chrome'));
  }

  candidates.push('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
  candidates.push('/Applications/Chromium.app/Contents/MacOS/Chromium');
  return candidates;
}

export function findChrome(
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
  executable: (path: string) => boolean = isExecutable,
): string | null {
  return chromeCandidates(env, home).find(executable) ?? null;
}

/**
 * The environment Chrome runs with.
 *
 * A Puppeteer or Playwright build is a bare binary: it expects the distro's
 * GTK, ATK and X libraries and dies on `libatk-1.0.so.0` without them. On a
 * box with no root that cannot install them, they are staged under
 * `~/.local/share/chrome-deps` instead, and pointing `LD_LIBRARY_PATH` and
 * `FONTCONFIG_FILE` there is what makes the binary run. Done here rather than
 * in a wrapper so the command works the same whichever Chrome was found.
 */
export function browserEnv(env: NodeJS.ProcessEnv = process.env, deps: string = CHROME_DEPS): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = { ...env };
  const lib = join(deps, 'usr', 'lib', 'x86_64-linux-gnu');
  if (listDir(lib).length > 0 && !(env.LD_LIBRARY_PATH ?? '').split(':').includes(lib)) {
    result.LD_LIBRARY_PATH = env.LD_LIBRARY_PATH ? `${lib}:${env.LD_LIBRARY_PATH}` : lib;
  }
  const fonts = join(deps, 'etc', 'fonts', 'fonts.conf');
  if (!env.FONTCONFIG_FILE && isExecutable(join(deps, 'etc', 'fonts')) ) {
    result.FONTCONFIG_FILE = fonts;
  }
  return result;
}

export const NO_CHROME = `no Chrome found. Set CHROME_PATH to a Chrome or Chromium binary, install one
(apt install chromium, brew install --cask google-chrome), or let Puppeteer
or Playwright fetch one (npx puppeteer browsers install chrome).`;

interface CdpMessage {
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
  sessionId?: string;
  result?: Record<string, unknown>;
  error?: { message: string };
}

/**
 * The slice of the Chrome DevTools Protocol this needs: a request-response
 * channel with ids, and events by name. Flat session mode, so one socket
 * serves the browser and every page.
 */
export class Cdp {
  private nextId = 1;
  private readonly pending = new Map<number, { resolve: (value: Record<string, unknown>) => void; reject: (error: Error) => void }>();
  private readonly listeners = new Set<(message: CdpMessage) => void>();
  private readonly socket: WebSocket;

  constructor(socket: WebSocket) {
    this.socket = socket;
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data)) as CdpMessage;
      if (message.id !== undefined && this.pending.has(message.id)) {
        const { resolve, reject } = this.pending.get(message.id)!;
        this.pending.delete(message.id);
        if (message.error) reject(new WcagError(message.error.message));
        else resolve(message.result ?? {});
        return;
      }
      for (const listener of this.listeners) listener(message);
    });
    socket.addEventListener('close', () => {
      for (const { reject } of this.pending.values()) reject(new WcagError('browser closed'));
      this.pending.clear();
    });
  }

  static async connect(url: string): Promise<Cdp> {
    const socket = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener('open', () => resolve(), { once: true });
      socket.addEventListener('error', () => reject(new WcagError(`could not connect to ${url}`)), { once: true });
    });
    return new Cdp(socket);
  }

  send(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<Record<string, unknown>> {
    const id = this.nextId;
    this.nextId += 1;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify(sessionId ? { id, method, params, sessionId } : { id, method, params }));
    });
  }

  /** Resolve on the next event of `method` for a session, or reject after `timeoutMs`. */
  waitFor(method: string, sessionId: string, timeoutMs: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.listeners.delete(listener);
        reject(new WcagError(`timed out after ${Math.round(timeoutMs / 1000)}s waiting for the page to load`));
      }, timeoutMs);
      const listener = (message: CdpMessage): void => {
        if (message.method === method && message.sessionId === sessionId) {
          clearTimeout(timer);
          this.listeners.delete(listener);
          resolve();
        }
      };
      this.listeners.add(listener);
    });
  }

  close(): void {
    this.socket.close();
  }
}

export interface Browser {
  cdp: Cdp;
  path: string;
  close(): Promise<void>;
}

export interface LaunchOptions {
  chrome?: string;
  env?: NodeJS.ProcessEnv;
  /** Chrome's sandbox needs user namespaces; a container or root often lacks them. */
  sandbox?: boolean;
  timeoutMs?: number;
}

/** Start a headless Chrome and connect to it. */
export async function launchBrowser(options: LaunchOptions = {}): Promise<Browser> {
  const env = options.env ?? process.env;
  const path = options.chrome ?? findChrome(env);
  if (!path) throw new WcagError(NO_CHROME);
  if (!isExecutable(path)) throw new WcagError(`${path} is not an executable`);

  const profile = mkdtempSync(join(tmpdir(), 'wcag-chrome-'));
  const sandbox = options.sandbox ?? !(env.CHROME_NO_SANDBOX || process.getuid?.() === 0);
  const args = [
    '--headless=new',
    '--remote-debugging-port=0',
    `--user-data-dir=${profile}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    '--disable-extensions',
    '--disable-background-networking',
    '--hide-scrollbars',
    '--window-size=1280,800',
    ...(sandbox ? [] : ['--no-sandbox']),
    'about:blank',
  ];

  const child: ChildProcess = spawn(path, args, { env: browserEnv(env), stdio: ['ignore', 'ignore', 'pipe'] });
  const cleanup = (): void => {
    try {
      rmSync(profile, { recursive: true, force: true });
    } catch {
      // A profile Chrome is still holding open is removed on the next run's tmpdir sweep.
    }
  };

  const url = await new Promise<string>((resolve, reject) => {
    let stderr = '';
    const timer = setTimeout(() => reject(new WcagError(`${path} did not start within ${(options.timeoutMs ?? 20_000) / 1000}s\n${stderr}`)), options.timeoutMs ?? 20_000);
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
      const match = /DevTools listening on (ws:\/\/\S+)/.exec(stderr);
      if (match?.[1]) {
        clearTimeout(timer);
        resolve(match[1]);
      }
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      reject(new WcagError(`${path} exited with ${code ?? 'a signal'} before it was ready\n${stderr.trim()}`));
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(new WcagError(`${path}: ${error.message}`));
    });
  }).catch((error: Error) => {
    child.kill();
    cleanup();
    throw error;
  });

  const cdp = await Cdp.connect(url);
  return {
    cdp,
    path,
    async close() {
      try {
        await Promise.race([cdp.send('Browser.close'), new Promise((resolve) => setTimeout(resolve, 2000))]);
      } catch {
        // Already gone.
      }
      cdp.close();
      child.kill();
      cleanup();
    },
  };
}

// ---------------------------------------------------------------------------
// The audit (WCAG-EM step 4, the automated part)
// ---------------------------------------------------------------------------

const require = createRequire(import.meta.url);

/** axe-core's browser bundle, read from the installed package rather than fetched. */
export function axeSource(): string {
  return readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8');
}

export function axeVersion(): string {
  return (require('axe-core/package.json') as { version: string }).version;
}

export interface RuleFinding {
  rule: string;
  impact: string | null;
  help: string;
  helpUrl: string;
  /** Success criteria the rule is filed under, `1.4.3`. */
  criteria: string[];
  /** How many elements it applied to. */
  nodes: number;
  /** CSS selectors of the first few of them. */
  targets: string[];
}

export interface PageResult {
  url: string;
  /** Where the browser ended up after redirects. */
  finalUrl: string;
  title: string;
  ok: boolean;
  error?: string;
  violations: RuleFinding[];
  incomplete: RuleFinding[];
  passes: RuleFinding[];
  /** Rules that found nothing to check on the page. */
  inapplicable: string[];
  /** Milliseconds from navigation to axe finishing. */
  ms: number;
}

export interface Report {
  tool: 'cli-tools wcag';
  axeVersion: string;
  wcagVersion: WcagVersion;
  level: Level;
  /** The origin the sample was drawn from. */
  site: string;
  startedAt: string;
  finishedAt: string;
  sample: { from: SampleResult['from']; candidates: number };
  pages: PageResult[];
}

interface AxeNode {
  target: unknown[];
}

interface AxeResult {
  id: string;
  impact: string | null;
  help: string;
  helpUrl: string;
  tags: string[];
  nodes: AxeNode[];
}

interface AxeRun {
  url: string;
  violations: AxeResult[];
  incomplete: AxeResult[];
  passes: AxeResult[];
  inapplicable: AxeResult[];
}

const MAX_TARGETS = 3;

const toFinding = (result: AxeResult): RuleFinding => ({
  rule: result.id,
  impact: result.impact ?? null,
  help: result.help,
  helpUrl: result.helpUrl,
  criteria: criteriaFromTags(result.tags),
  nodes: result.nodes.length,
  targets: result.nodes.slice(0, MAX_TARGETS).map((node) => node.target.map(String).join(' ')),
});

/** The in-page half: run axe over the loaded document and hand back what it found. */
const RUN_AXE = (tags: string[]): string => `axe.run(document, {
  runOnly: { type: 'tag', values: ${JSON.stringify(tags)} },
  resultTypes: ['violations', 'incomplete', 'passes', 'inapplicable'],
}).then((results) => JSON.stringify({
  url: results.url,
  violations: results.violations,
  incomplete: results.incomplete,
  passes: results.passes,
  inapplicable: results.inapplicable.map((result) => ({ id: result.id, impact: null, help: '', helpUrl: '', tags: [], nodes: [] })),
}))`;

export interface AuditOptions {
  version: WcagVersion;
  level: Level;
  timeoutMs?: number;
  /** Milliseconds to let the page settle after load before running axe. */
  settleMs?: number;
  axe?: string;
}

/** Load one page in the browser and run axe over it. Never throws: a page that will not load is a result too. */
export async function auditPage(browser: Browser, url: string, options: AuditOptions): Promise<PageResult> {
  const { cdp } = browser;
  const timeoutMs = options.timeoutMs ?? 30_000;
  const started = Date.now();
  const failure = (error: string): PageResult => ({
    url,
    finalUrl: url,
    title: '',
    ok: false,
    error,
    violations: [],
    incomplete: [],
    passes: [],
    inapplicable: [],
    ms: Date.now() - started,
  });

  let targetId: string | undefined;
  try {
    ({ targetId } = (await cdp.send('Target.createTarget', { url: 'about:blank' })) as { targetId: string });
    const { sessionId } = (await cdp.send('Target.attachToTarget', { targetId, flatten: true })) as { sessionId: string };

    await cdp.send('Page.enable', {}, sessionId);
    await cdp.send('Network.setUserAgentOverride', { userAgent: USER_AGENT }, sessionId);
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false }, sessionId);

    const loaded = cdp.waitFor('Page.loadEventFired', sessionId, timeoutMs);
    const navigation = (await cdp.send('Page.navigate', { url }, sessionId)) as { errorText?: string };
    if (navigation.errorText) {
      loaded.catch(() => undefined);
      return failure(navigation.errorText);
    }
    await loaded;
    await new Promise((resolve) => setTimeout(resolve, options.settleMs ?? 500));

    const evaluate = async (expression: string, awaitPromise = false): Promise<unknown> => {
      const { result, exceptionDetails } = (await cdp.send(
        'Runtime.evaluate',
        { expression, awaitPromise, returnByValue: true },
        sessionId,
      )) as { result: { value?: unknown }; exceptionDetails?: { text: string; exception?: { description?: string } } };
      if (exceptionDetails) {
        throw new WcagError(exceptionDetails.exception?.description ?? exceptionDetails.text);
      }
      return result.value;
    };

    const page = (await evaluate('JSON.stringify({ title: document.title, href: location.href })')) as string;
    const { title, href } = JSON.parse(page) as { title: string; href: string };

    await evaluate(options.axe ?? axeSource());
    const raw = (await evaluate(RUN_AXE(axeTags(options.version, options.level)), true)) as string;
    const run = JSON.parse(raw) as AxeRun;

    return {
      url,
      finalUrl: href || run.url || url,
      title,
      ok: true,
      violations: run.violations.map(toFinding),
      incomplete: run.incomplete.map(toFinding),
      passes: run.passes.map(toFinding),
      inapplicable: run.inapplicable.map((result) => result.id),
      ms: Date.now() - started,
    };
  } catch (error) {
    return failure((error as Error).message);
  } finally {
    if (targetId) {
      await cdp.send('Target.closeTarget', { targetId }).catch(() => undefined);
    }
  }
}

export interface RunOptions extends AuditOptions {
  onPage?: (result: PageResult, index: number, total: number) => void;
}

/** Audit every page of a sample in one browser, in order. */
export async function audit(browser: Browser, sample: SampleResult, options: RunOptions): Promise<Report> {
  const startedAt = new Date().toISOString();
  const axe = options.axe ?? axeSource();
  const pages: PageResult[] = [];
  for (const [index, url] of sample.pages.entries()) {
    const result = await auditPage(browser, url, { ...options, axe });
    pages.push(result);
    options.onPage?.(result, index, sample.pages.length);
  }
  return {
    tool: 'cli-tools wcag',
    axeVersion: axeVersion(),
    wcagVersion: options.version,
    level: options.level,
    site: new URL(sample.pages[0] ?? 'https://invalid').origin,
    startedAt,
    finishedAt: new Date().toISOString(),
    sample: { from: sample.from, candidates: sample.candidates },
    pages,
  };
}

// ---------------------------------------------------------------------------
// Reading a report
// ---------------------------------------------------------------------------

export type Outcome = 'failed' | 'cantTell' | 'passed' | 'untested';

export interface CriterionOutcome {
  outcome: Outcome;
  violations: RuleFinding[];
  incomplete: RuleFinding[];
  passes: RuleFinding[];
}

/**
 * What a page's axe results say about each criterion.
 *
 * A violation fails the criterion. Anything short of that is "cannot tell":
 * an incomplete check needs a person, and so does a criterion axe only
 * checked part of — which is every criterion, so passing checks are recorded
 * but never promoted to a pass. A criterion no rule touched is untested.
 */
export function pageOutcomes(page: PageResult): Map<string, CriterionOutcome> {
  const outcomes = new Map<string, CriterionOutcome>();
  const entry = (num: string): CriterionOutcome => {
    let existing = outcomes.get(num);
    if (!existing) {
      existing = { outcome: 'untested', violations: [], incomplete: [], passes: [] };
      outcomes.set(num, existing);
    }
    return existing;
  };
  for (const finding of page.violations) for (const num of finding.criteria) entry(num).violations.push(finding);
  for (const finding of page.incomplete) for (const num of finding.criteria) entry(num).incomplete.push(finding);
  for (const finding of page.passes) for (const num of finding.criteria) entry(num).passes.push(finding);
  for (const value of outcomes.values()) {
    value.outcome = value.violations.length > 0 ? 'failed' : 'cantTell';
  }
  return outcomes;
}

export interface CriterionSummary {
  num: string;
  title: string;
  level: Level;
  /** Pages with a violation. */
  failing: number;
  /** Pages with an incomplete check and no violation. */
  review: number;
  /** Pages where every check passed. */
  passing: number;
  /** Elements in violation across the sample. */
  nodes: number;
  /** The rule with the most elements in violation. */
  worst: { rule: string; nodes: number; impact: string | null } | null;
}

/** One row per criterion that any rule touched, in specification order. */
export function summarize(report: Report): CriterionSummary[] {
  const rows = new Map<string, CriterionSummary & { byRule: Map<string, { nodes: number; impact: string | null }> }>();
  for (const page of report.pages) {
    if (!page.ok) continue;
    for (const [num, outcome] of pageOutcomes(page)) {
      const known = criterion(num);
      if (!known) continue;
      let row = rows.get(num);
      if (!row) {
        row = { num, title: known.title, level: known.level, failing: 0, review: 0, passing: 0, nodes: 0, worst: null, byRule: new Map() };
        rows.set(num, row);
      }
      if (outcome.violations.length > 0) {
        row.failing += 1;
        for (const finding of outcome.violations) {
          row.nodes += finding.nodes;
          const rule = row.byRule.get(finding.rule) ?? { nodes: 0, impact: finding.impact };
          rule.nodes += finding.nodes;
          row.byRule.set(finding.rule, rule);
        }
      } else if (outcome.incomplete.length > 0) {
        row.review += 1;
      } else {
        row.passing += 1;
      }
    }
  }
  return [...rows.values()]
    .sort((a, b) => compareNums(a.num, b.num))
    .map(({ byRule, ...row }) => {
      const worst = [...byRule.entries()].sort((a, b) => b[1].nodes - a[1].nodes)[0];
      return { ...row, worst: worst ? { rule: worst[0], nodes: worst[1].nodes, impact: worst[1].impact } : null };
    });
}

export interface Totals {
  pages: number;
  loaded: number;
  failingPages: number;
  /** Criteria within the target with at least one violation. */
  failingCriteria: number;
  /** Criteria within the target needing review and not failing. */
  reviewCriteria: number;
  nodes: number;
}

export function totals(report: Report, rows: CriterionSummary[] = summarize(report)): Totals {
  const inTarget = rows.filter((row) => withinTarget(row.level, report.level));
  return {
    pages: report.pages.length,
    loaded: report.pages.filter((page) => page.ok).length,
    failingPages: report.pages.filter((page) => page.ok && page.violations.some((finding) => finding.criteria.length > 0)).length,
    failingCriteria: inTarget.filter((row) => row.failing > 0).length,
    reviewCriteria: inTarget.filter((row) => row.failing === 0 && row.review > 0).length,
    nodes: inTarget.reduce((sum, row) => sum + row.nodes, 0),
  };
}

/** Did anything within the conformance target fail? The exit code. */
export function hasFailures(report: Report): boolean {
  return totals(report).failingCriteria > 0;
}

const plural = (count: number, noun: string): string => `${count} ${noun}${count === 1 ? '' : 's'}`;

/** The terminal summary: a table of criteria, then one line of totals. */
export function formatSummary(report: Report, rows: CriterionSummary[] = summarize(report)): string {
  const lines: string[] = [];
  const header = ['SC', 'Level', 'Criterion', 'Fail', 'Review', 'Pass', 'Worst rule'];
  const body = rows.map((row) => [
    row.num,
    row.level,
    row.title,
    row.failing > 0 ? String(row.failing) : '-',
    row.review > 0 ? String(row.review) : '-',
    row.passing > 0 ? String(row.passing) : '-',
    row.worst ? `${row.worst.rule} (${plural(row.worst.nodes, 'element')}${row.worst.impact ? `, ${row.worst.impact}` : ''})` : '',
  ]);
  if (body.length > 0) {
    lines.push(table([header, ...body]));
    lines.push('');
  }

  const sum = totals(report, rows);
  const broken = report.pages.filter((page) => !page.ok);
  lines.push(
    `WCAG ${report.wcagVersion} level ${report.level}: ${plural(sum.failingCriteria, 'criterion').replace('criterions', 'criteria')} failing on ${plural(sum.failingPages, 'page')} of ${sum.loaded}` +
      ` (${plural(sum.nodes, 'element')}), ${sum.reviewCriteria} to review by hand. axe-core ${report.axeVersion}.`,
  );
  for (const page of broken) {
    lines.push(`  could not load ${page.url}: ${page.error ?? 'unknown error'}`);
  }
  return lines.join('\n');
}

/** A Markdown version of the same, with the failing rules under each criterion. */
export function toMarkdown(report: Report, rows: CriterionSummary[] = summarize(report)): string {
  const sum = totals(report, rows);
  const lines: string[] = [];
  lines.push(`# Accessibility audit of ${report.site}`);
  lines.push('');
  lines.push(`WCAG ${report.wcagVersion} level ${report.level}, automated checks only (axe-core ${report.axeVersion}), ${report.startedAt.slice(0, 10)}.`);
  lines.push('');
  lines.push(`${sum.failingCriteria} criteria failing on ${sum.failingPages} of ${sum.loaded} pages; ${sum.reviewCriteria} more need a person. A criterion with no failure here is not passed: automated checks cover a part of each one.`);
  lines.push('');
  lines.push('## Sample');
  lines.push('');
  for (const page of report.pages) {
    lines.push(`- ${page.ok ? `[${page.title || page.url}](${page.finalUrl})` : `${page.url} — could not load (${page.error ?? 'unknown'})`}`);
  }
  lines.push('');
  lines.push('## Findings');
  lines.push('');
  if (rows.every((row) => row.failing === 0)) {
    lines.push('No automated check failed.');
    lines.push('');
  }
  for (const row of rows) {
    if (row.failing === 0) continue;
    lines.push(`### ${row.num} ${row.title} (${row.level}) — fails on ${plural(row.failing, 'page')}`);
    lines.push('');
    const rules = new Map<string, { finding: RuleFinding; pages: string[] }>();
    for (const page of report.pages) {
      for (const finding of page.violations) {
        if (!finding.criteria.includes(row.num)) continue;
        const rule = rules.get(finding.rule) ?? { finding, pages: [] };
        rule.pages.push(page.finalUrl);
        rules.set(finding.rule, rule);
      }
    }
    for (const { finding, pages } of rules.values()) {
      lines.push(`- **${finding.rule}**${finding.impact ? ` (${finding.impact})` : ''}: ${finding.help}. [How to fix](${finding.helpUrl}). ${plural(pages.length, 'page')}${finding.targets.length > 0 ? `, e.g. \`${finding.targets[0]}\`` : ''}.`);
    }
    lines.push('');
  }
  const review = rows.filter((row) => row.failing === 0 && row.review > 0);
  if (review.length > 0) {
    lines.push('## Needs a person');
    lines.push('');
    for (const row of review) lines.push(`- ${row.num} ${row.title} (${row.level}), ${plural(row.review, 'page')}`);
    lines.push('');
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// The report tool's evaluation file
// ---------------------------------------------------------------------------

/** The version of the report tool whose export this mirrors. */
export const REPORT_TOOL_VERSION = '4.1.0';
export const REPORT_TOOL_URL = 'https://www.w3.org/WAI/eval/report-tool/';

/**
 * The JSON-LD context the report tool writes and reads
 * (src/data/jsonld/appContext.js, `exportContext`), verbatim.
 */
export const EVALUATION_CONTEXT = {
  reporter: 'http://github.com/w3c/wai-wcag-em-report-tool/',
  wcagem: 'http://www.w3.org/TR/WCAG-EM/#',
  Evaluation: 'wcagem:procedure',
  defineScope: 'wcagem:step1',
  scope: 'wcagem:step1a',
  step1b: { '@id': 'wcagem:step1b', '@type': '@id' },
  conformanceTarget: 'step1b',
  accessibilitySupportBaseline: 'wcagem:step1c',
  additionalEvaluationRequirements: 'wcagem:step1d',
  exploreTarget: 'wcagem:step2',
  essentialFunctionality: 'wcagem:step2b',
  pageTypeVariety: 'wcagem:step2c',
  technologiesReliedUpon: 'wcagem:step2d',
  selectSample: 'wcagem:step3',
  structuredSample: 'wcagem:step3a',
  randomSample: 'wcagem:step3b',
  Website: 'wcagem:website',
  Webpage: 'wcagem:webpage',
  auditSample: 'wcagem:step4',
  reportFindings: 'wcagem:step5',
  documentSteps: 'wcagem:step5a',
  commissioner: 'wcagem:commissioner',
  evaluator: 'wcagem:evaluator',
  evaluationSpecifics: 'wcagem:step5b',
  WCAG: 'http://www.w3.org/TR/WCAG/#',
  WCAG20: 'http://www.w3.org/TR/WCAG20/#',
  WCAG21: 'http://www.w3.org/TR/WCAG21/#',
  WAI: 'http://www.w3.org/WAI/',
  A: 'WAI:WCAG2A-Conformance',
  AA: 'WAI:WCAG2AA-Conformance',
  AAA: 'WAI:WCAG2AAA-Conformance',
  wcagVersion: 'WAI:standards-guidelines/wcag/#versions',
  reportToolVersion: 'wcagem:reportToolVersion',
  earl: 'http://www.w3.org/ns/earl#',
  Assertion: 'earl:Assertion',
  TestMode: 'earl:TestMode',
  TestCriterion: 'earl:TestCriterion',
  TestCase: 'earl:TestCase',
  TestRequirement: 'earl:TestRequirement',
  TestSubject: 'earl:TestSubject',
  TestResult: 'earl:TestResult',
  OutcomeValue: 'earl:OutcomeValue',
  Pass: 'earl:Pass',
  Fail: 'earl:Fail',
  CannotTell: 'earl:CannotTell',
  NotApplicable: 'earl:NotApplicable',
  NotTested: 'earl:NotTested',
  assertedBy: 'earl:assertedBy',
  mode: 'earl:mode',
  result: 'earl:result',
  subject: 'earl:subject',
  test: 'earl:test',
  outcome: 'earl:outcome',
  dcterms: 'http://purl.org/dc/terms/',
  title: 'dcterms:title',
  description: 'dcterms:description',
  summary: 'dcterms:summary',
  date: 'dcterms:date',
  hasPart: 'dcterms:hasPart',
  isPartOf: 'dcterms:isPartOf',
  id: '@id',
  type: '@type',
  language: '@language',
} as const;

/*
 * No `WCAG22` prefix is added to the context, on purpose. The tool's own
 * context stops at WCAG21, so a 2.2 criterion id like `WCAG22:reflow` reaches
 * its JSON-LD processor as an IRI with an unknown scheme, which expansion and
 * compaction both leave untouched, and its importer then reads the id off the
 * last colon. Defining the prefix here would expand the id to the full
 * `http://www.w3.org/TR/WCAG22/#reflow`, which the tool's context cannot fold
 * back, and every 2.2 assertion would be dropped on open. Found by replaying
 * the tool's open() with its own jsonld version, not by reading the code.
 */

const OUTCOME_TYPES: Record<Outcome, string> = {
  passed: 'Pass',
  failed: 'Fail',
  cantTell: 'CannotTell',
  untested: 'NotTested',
};

export interface EvaluationOptions {
  /** The site's name, for the scope. Defaults to its host. */
  site?: string;
  title?: string;
  evaluator?: string;
  commissioner?: string;
}

/**
 * A page name the tool can tell apart from the others'.
 *
 * The tool finds a sampled page by its title, so two pages titled "Blog" would
 * collapse into one; the path is appended to the second. A page with no title
 * is named by its path, which is what a person would call it anyway.
 */
export function pageTitles(pages: readonly PageResult[]): string[] {
  const used = new Map<string, number>();
  return pages.map((page) => {
    const path = new URL(page.finalUrl).pathname;
    const base = page.title.trim() || path;
    const count = used.get(base) ?? 0;
    used.set(base, count + 1);
    return count === 0 ? base : `${base} (${path})`;
  });
}

const describe = (outcome: CriterionOutcome, page: PageResult, report: Report): string => {
  const lines: string[] = [];
  const list = (label: string, findings: RuleFinding[]): void => {
    if (findings.length === 0) return;
    lines.push(`${label} (axe-core ${report.axeVersion}, ${page.finalUrl}):`);
    for (const finding of findings) {
      const where = finding.targets.length > 0 ? ` e.g. ${finding.targets.join(' | ')}` : '';
      lines.push(`- ${finding.rule}${finding.impact ? ` [${finding.impact}]` : ''}: ${finding.help} — ${plural(finding.nodes, 'element')}.${where} ${finding.helpUrl}`);
    }
  };
  list('Automated failures', outcome.violations);
  list('Checks that need a person', outcome.incomplete);
  if (outcome.passes.length > 0) {
    lines.push(`Passing checks: ${outcome.passes.map((finding) => finding.rule).join(', ')}. Automated checks cover a part of this criterion; the rest is manual.`);
  }
  return lines.join('\n');
};

/**
 * The report tool's own evaluation file, with the sample and the automated
 * results filled in. Open it in the tool with "Open evaluation".
 */
export function toEvaluation(report: Report, options: EvaluationOptions = {}): Record<string, unknown> {
  const { wcagVersion: version } = report;
  const date = report.finishedAt;
  const host = new URL(report.site).host;
  const site = options.site ?? host;
  const loaded = report.pages.filter((page) => page.ok);
  const titles = pageTitles(loaded);

  const website = {
    id: '_:subject_0',
    type: ['TestSubject', 'Website'],
    date,
    title: site,
    description: report.site,
  };

  const subjects = loaded.map((page, index) => ({
    id: page.finalUrl,
    type: ['TestSubject', 'Webpage'],
    date,
    title: titles[index] ?? page.finalUrl,
    description: page.finalUrl,
  }));

  const assertor = {
    id: 'https://github.com/profullstack/cli-tools#wcag',
    title: `cli-tools wcag (axe-core ${report.axeVersion})`,
  };

  const assertions: Record<string, unknown>[] = [];
  loaded.forEach((page, index) => {
    const subject = subjects[index]!;
    for (const [num, outcome] of pageOutcomes(page)) {
      const known = criterion(num);
      if (!known || !known.versions.includes(version)) continue;
      assertions.push({
        type: ['Assertion'],
        date,
        assertedBy: assertor,
        mode: 'earl:automatic',
        subject: { id: subject.id, type: subject.type, title: subject.title, description: subject.description },
        test: {
          id: criterionId(known, version),
          type: ['TestCriterion', 'TestRequirement'],
          title: `${num} ${known.title}`,
          num,
        },
        result: {
          type: ['TestResult'],
          date,
          outcome: { id: `earl:${outcome.outcome}`, type: ['OutcomeValue', OUTCOME_TYPES[outcome.outcome]] },
          description: describe(outcome, page, report),
        },
      });
    }
  });

  const sum = totals(report);
  const summary =
    `Automated checks by cli-tools wcag (axe-core ${report.axeVersion}) on ${report.startedAt.slice(0, 10)}: ` +
    `${sum.failingCriteria} criteria failing on ${sum.failingPages} of ${sum.loaded} sampled pages. ` +
    'Every criterion still needs a person: an automated failure is a failure, an automated pass is not a pass.';

  return {
    '@context': EVALUATION_CONTEXT,
    '@type': 'Evaluation',
    '@language': 'en',
    reportToolVersion: REPORT_TOOL_VERSION,
    defineScope: {
      '@id': '_:defineScope',
      scope: website,
      wcagVersion: version,
      conformanceTarget: report.level,
      accessibilitySupportBaseline: '',
      additionalEvaluationRequirements: '',
    },
    exploreTarget: {
      '@id': '_:exploreTarget',
      technologiesReliedUpon: [],
      essentialFunctionality: '',
      pageTypeVariety: '',
    },
    selectSample: {
      '@id': '_:selectSample',
      randomSample: [],
      structuredSample: subjects,
    },
    auditSample: assertions,
    reportFindings: {
      documentSteps: [{ '@id': '_:about' }, { '@id': '_:defineScope' }, { '@id': '_:exploreTarget' }, { '@id': '_:selectSample' }],
      commissioner: options.commissioner ?? '',
      date,
      evaluator: options.evaluator ?? '',
      evaluationSpecifics: '',
      summary,
      title: options.title ?? `Accessibility evaluation of ${site}`,
    },
  };
}

/** Is this a report this command wrote? Enough of a check to say so in an error. */
export function isReport(value: unknown): value is Report {
  const candidate = value as Partial<Report> | null;
  return (
    typeof candidate === 'object' &&
    candidate !== null &&
    candidate.tool === 'cli-tools wcag' &&
    Array.isArray(candidate.pages) &&
    typeof candidate.wcagVersion === 'string' &&
    typeof candidate.level === 'string'
  );
}

export const OPEN_STEPS = `The WCAG-EM Report Tool is a web page with no command line, so the hand-off is:

  1. wcag audit https://example.org --pages 8           writes wcag-report.json
  2. wcag report wcag-report.json                       writes evaluation.json
  3. open ${REPORT_TOOL_URL}
  4. "Open evaluation" in the menu, choose evaluation.json

Steps 1 (scope) and 3 (sample) are then filled in, and step 4 (audit) holds
one assertion per page and criterion: "failed" where axe proved a failure,
"cannot tell" where it found something to look at or only checked a part.
Nothing is marked "passed" — that is the evaluator's call, made in the tool.
The tool keeps the evaluation in the browser and saves it back out as JSON
from step 5.`;
