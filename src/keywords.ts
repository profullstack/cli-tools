/**
 * keywords — the keywords and phrases a page repeats, ranked by count.
 *
 * A port of a bookmarklet that did this in the page and showed the result in
 * an overlay. Two decisions shape it:
 *
 * - **The page is read in a real browser.** The bookmarklet keeps only text a
 *   reader can see — `getComputedStyle` for display, visibility and opacity,
 *   `getBoundingClientRect` for a box with area — and skips nav, header,
 *   footer, forms and anything aria-hidden. A fetch and an HTML parser cannot
 *   answer "is this visible", and a client-rendered page has no text in its
 *   HTML at all. So the page loads in headless Chrome over the same hand-driven
 *   DevTools connection `wcag` uses, and `COLLECT` below is the bookmarklet's
 *   own collection code, unchanged, minus the overlay.
 * - **Only collection runs in the page.** Tokenizing, counting, ranking and the
 *   report are plain functions here, so they are tested without a browser and
 *   give the same answer for the same blocks. The report is the bookmarklet's
 *   plaintext, byte for byte, so a result from either can be compared.
 */

import { type Browser, USER_AGENT, WcagError } from './wcag.ts';

export class KeywordsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'KeywordsError';
  }
}

/**
 * The in-page half: every visible text block worth counting, deduplicated.
 * Evaluated as an expression, it yields a JSON string of `PageText`.
 */
export const COLLECT = `(() => {
  if (!document.body) return JSON.stringify({ title: document.title, href: location.href, blocks: [] });
  const clean = (v) => String(v || '').replace(/\\s+/g, ' ').trim();
  const visible = (e) => {
    const s = getComputedStyle(e), r = e.getBoundingClientRect();
    return s.display !== 'none' && s.visibility !== 'hidden' && Number(s.opacity) !== 0 && r.width > 0 && r.height > 0;
  };
  const excluded = (e) => !!e.closest('script,style,noscript,svg,canvas,nav,header,footer,form,dialog,[hidden],[aria-hidden="true"]');
  const texts = [];
  const add = (e, value) => {
    if (!e || excluded(e) || !visible(e)) return;
    const t = clean(value);
    if (t.length < 8 || t.length > 400) return;
    if (/^(home|menu|search|sign in|log in|subscribe|learn more|read more|shop now|see more|next|previous|close)$/i.test(t)) return;
    texts.push(t);
  };
  document.querySelectorAll('h1,h2,h3,h4,h5,h6,[role="heading"],main p,article p,main li,article li,main a[href],article a[href],td,th,figcaption,[itemprop="name"],[class*="title" i],[data-testid*="title" i]')
    .forEach((e) => add(e, e.innerText || e.textContent));
  document.querySelectorAll('img[alt]').forEach((e) => add(e, e.alt));
  if (texts.length < 10) document.querySelectorAll('body p,body li,body a[href]').forEach((e) => add(e, e.innerText || e.textContent));
  return JSON.stringify({ title: document.title, href: location.href, blocks: [...new Set(texts)] });
})()`;

export interface PageText {
  title: string;
  /** Where the browser ended up after redirects. */
  href: string;
  blocks: string[];
}

export const STOP_WORDS: ReadonlySet<string> = new Set(
  `a an and are as at be been being but by can could did do does doing done for from had has have having he her here hers herself him himself his how i if in into is it its itself just may me might more most my myself no nor not of off on once only or other our ours ourselves out over own same she should so some such than that the their theirs them themselves then there these they this those through to too under until up us very was we were what when where which while who whom why will with would you your yours yourself yourselves all any each few many much another every either page website site click open close menu search login log sign subscribe view read learn see show next previous back home share follow loading new now today free best top get use using used`
    .trim()
    .split(/\s+/),
);

export function tokenize(text: string): string[] {
  return text
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[’']/g, '')
    .replace(/&/g, ' and ')
    .replace(/[^\p{L}\p{N}+#-]+/gu, ' ')
    .split(/\s+/)
    .map((word) => word.replace(/^-+|-+$/g, ''))
    .filter((word) => word.length >= 2 && !STOP_WORDS.has(word) && !/^[\p{N}]+$/u.test(word));
}

export interface Keyword {
  keyword: string;
  /** 1, 2 or 3. */
  words: number;
  /** How many text blocks contain it — a block counts once however often it repeats. */
  count: number;
}

export const DEFAULT_LIMIT = 250;

/**
 * Every 1-, 2- and 3-word phrase, counted once per block, most frequent first.
 *
 * Single words need 3 blocks and phrases 2 to rank; when nothing clears that
 * bar (a short page), everything is ranked rather than nothing.
 */
export function rank(blocks: readonly string[], limit: number = DEFAULT_LIMIT): Keyword[] {
  const counts = new Map<string, Keyword>();
  for (const block of blocks) {
    const words = tokenize(block);
    for (const size of [1, 2, 3]) {
      const phrases = new Set<string>();
      for (let index = 0; index <= words.length - size; index += 1) phrases.add(words.slice(index, index + size).join(' '));
      for (const phrase of phrases) {
        const row = counts.get(phrase) ?? { keyword: phrase, words: size, count: 0 };
        row.count += 1;
        counts.set(phrase, row);
      }
    }
  }
  const all = [...counts.values()].sort((a, b) => b.count - a.count || b.words - a.words || a.keyword.localeCompare(b.keyword));
  const ranked = all.filter((row) => (row.words === 1 ? row.count >= 3 : row.count >= 2));
  return (ranked.length > 0 ? ranked : all).slice(0, limit);
}

export interface KeywordReport {
  title: string;
  url: string;
  blocks: number;
  keywords: Keyword[];
}

export function report(page: PageText, limit: number = DEFAULT_LIMIT): KeywordReport {
  return { title: page.title, url: page.href, blocks: page.blocks.length, keywords: rank(page.blocks, limit) };
}

/** The bookmarklet's plaintext: the bare list, the counts, then the subtotals. */
export function formatReport(result: KeywordReport): string {
  const rows = result.keywords;
  const raw = rows.map((row) => row.keyword).join('\n') || '(no keywords found)';
  const detailed = rows.map((row) => `${row.count}\t${row.keyword}`).join('\n') || '(no keywords found)';
  const subtotals = [1, 2, 3]
    .map((size) => {
      const group = rows.filter((row) => row.words === size);
      return `${size}-word keywords: ${group.length}\n${size}-word occurrences: ${group.reduce((sum, row) => sum + row.count, 0)}`;
    })
    .join('\n');
  return `KEYWORDS — SORTED BY COUNT\n\n${raw}\n\nCOUNTS\n\n${detailed}\n\nSUBTOTALS\n\nPage: ${result.title}\nURL: ${result.url}\nText blocks scanned: ${result.blocks}\nRanked keywords/phrases: ${rows.length}\n${subtotals}`;
}

export interface ReadOptions {
  timeoutMs?: number;
  /** Milliseconds to let the page render after load, for client-side apps. */
  settleMs?: number;
}

/** Load a page in the browser and collect its visible text blocks. */
export async function readPage(browser: Browser, url: string, options: ReadOptions = {}): Promise<PageText> {
  const { cdp } = browser;
  const timeoutMs = options.timeoutMs ?? 30_000;
  let targetId: string | undefined;
  try {
    ({ targetId } = (await cdp.send('Target.createTarget', { url: 'about:blank' })) as { targetId: string });
    const { sessionId } = (await cdp.send('Target.attachToTarget', { targetId, flatten: true })) as { sessionId: string };

    await cdp.send('Page.enable', {}, sessionId);
    await cdp.send('Network.setUserAgentOverride', { userAgent: USER_AGENT.replace('cli-tools/wcag', 'cli-tools/keywords') }, sessionId);
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false }, sessionId);

    const loaded = cdp.waitFor('Page.loadEventFired', sessionId, timeoutMs);
    const navigation = (await cdp.send('Page.navigate', { url }, sessionId)) as { errorText?: string };
    if (navigation.errorText) {
      loaded.catch(() => undefined);
      throw new KeywordsError(`could not load ${url}: ${navigation.errorText}`);
    }
    await loaded;
    await new Promise((resolve) => setTimeout(resolve, options.settleMs ?? 1000));

    const { result, exceptionDetails } = (await cdp.send(
      'Runtime.evaluate',
      { expression: COLLECT, returnByValue: true },
      sessionId,
    )) as { result: { value?: unknown }; exceptionDetails?: { text: string; exception?: { description?: string } } };
    if (exceptionDetails) throw new KeywordsError(exceptionDetails.exception?.description ?? exceptionDetails.text);
    return JSON.parse(String(result.value)) as PageText;
  } catch (error) {
    if (error instanceof KeywordsError) throw error;
    if (error instanceof WcagError) throw new KeywordsError(error.message);
    throw error;
  } finally {
    if (targetId) await cdp.send('Target.closeTarget', { targetId }).catch(() => undefined);
  }
}

/** The first clipboard command on PATH, as [command, ...args]. */
export const CLIPBOARD_COMMANDS: readonly (readonly string[])[] = [
  ['wl-copy'],
  ['xclip', '-selection', 'clipboard'],
  ['xsel', '--clipboard', '--input'],
  ['pbcopy'],
  ['clip.exe'],
];
